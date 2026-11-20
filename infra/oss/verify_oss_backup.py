#!/usr/bin/env python3
"""One explicit OSS backup round trip, followed by isolated PG/OPA restoration."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import subprocess
import tarfile
from uuid import uuid4

import oss_ops as ops

BASE = Path('/data/hsbc')
BACKUP_FILES = {
    'database.dump', 'roles.sql', 'policies-and-deployment.tar.gz',
    'sha256.json', 'complete.json', 'restore-verification.json',
}
DEPLOY_FILES = {
    'deploy/versions.lock.json', 'deploy/compose.yaml', 'deploy/compose.opa-loads.json',
    'deploy/models.autodl3090.lock.json', 'deploy/models.autodl5090.lock.json',
}


def now():
    return datetime.now(timezone.utc).isoformat()


def verify_source(source: Path) -> dict:
    if source.absolute() != source.resolve(strict=True) or source.parent != ops.BACKUP_ROOT:
        raise ValueError('Source must be a direct, non-symlink backup directory')
    if source.name.startswith('.') or set(p.name for p in source.iterdir()) != BACKUP_FILES:
        raise ValueError('Source must contain only the six completed backup files')
    if any(not p.is_file() or p.is_symlink() for p in source.iterdir()):
        raise ValueError('Backup links and non-regular files are prohibited')
    completion = json.loads((source / 'complete.json').read_text())
    restored = json.loads((source / 'restore-verification.json').read_text())
    if completion.get('format') != 'hsbc-backup-v1' or not completion.get('completed_at'):
        raise ValueError('Incomplete backup')
    if not restored.get('ok') or not restored.get('postgres_roles_and_database_restored'):
        raise ValueError('Source has not passed local restoration')
    if ops.sha256_file(source / 'sha256.json') != completion['manifest_sha256']:
        raise ValueError('Backup manifest hash mismatch')
    manifest = json.loads((source / 'sha256.json').read_text())
    if set(manifest) != {'database.dump', 'roles.sql', 'policies-and-deployment.tar.gz'}:
        raise ValueError('Unexpected backup manifest')
    if any(ops.sha256_file(source / name) != digest for name, digest in manifest.items()):
        raise ValueError('Backup artifact hash mismatch')
    with tarfile.open(source / 'policies-and-deployment.tar.gz') as archive:
        for member in archive.getmembers():
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
                raise ValueError('Unsafe configuration archive member')
            if member.isdir():
                continue
            if not (member.name.startswith(('policies/releases/', 'config/opa/'))
                    or member.name in DEPLOY_FILES):
                raise ValueError('Unexpected configuration archive scope')
            if any(part == 'secrets' or part == '.env' or part.endswith(('.env', '.key', '.pem'))
                   or part in ('id_rsa', 'id_ed25519') for part in path.parts):
                raise ValueError('Secret files are prohibited in configuration backup')
    # roles.sql is intentionally preserved: its password hashes are part of the
    # authorized, encrypted database recovery data. No live secret files are added.
    return {name: ops.sha256_file(source / name) for name in sorted(BACKUP_FILES)}


def download(oss, client, key: str, target: Path):
    response = client.get_object(oss.GetObjectRequest(bucket=ops.BUCKET, key=key))
    try:
        with target.open('xb') as output:
            for chunk in response.body.iter_bytes():
                output.write(chunk)
    finally:
        response.body.close()


def execute(source: Path, evidence_path: Path):
    os.umask(0o077)
    logging.disable(logging.CRITICAL)
    record = {'started_at': now(), 'ok': False, 'source_backup': source.name,
              'business_data_tested': False, 'key_external_escrow_verified': False}

    def stage(name):
        record['stage'] = name
        evidence_path.write_text(json.dumps(record, indent=2) + '\n')

    try:
        stage('validate_source')
        hashes = verify_source(source)
        run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid4().hex[:12]
        work = BASE / 'run' / ('oss-restore-' + run_id)
        work.mkdir(mode=0o700)
        archive_path = ops.BACKUP_ROOT / ('oss-completed-' + run_id + '.tar.gz')
        partial = archive_path.with_suffix(archive_path.suffix + '.partial')
        with tarfile.open(partial, 'w:gz') as archive:
            for name in sorted(BACKUP_FILES):
                archive.add(source / name, arcname=name, recursive=False)
        if verify_source(source) != hashes:
            raise ValueError('Completed source changed during packaging')
        partial.rename(archive_path)
        record.update({'source_file_hashes': hashes, 'archive_path': str(archive_path),
                       'archive_sha256': ops.sha256_file(archive_path),
                       'archive_bytes': archive_path.stat().st_size,
                       'source_unchanged': True, 'extra_live_secret_files_included': False,
                       'database_role_hashes_preserved': True})
        stage('role_and_smoke')
        oss, client = ops.make_client()
        record['check'] = ops.bucket_check(oss, client)
        record['smoke'] = ops.smoke(oss, client)
        stage('encrypted_upload')
        created_key = False
        if not ops.KEY_PATH.exists():
            ops.init_key(ops.KEY_PATH)
            created_key = True
        ops.secret_key(ops.KEY_PATH)
        record['key_created'] = created_key
        record['key_path'] = str(ops.KEY_PATH)
        record['key_mode'] = oct(ops.KEY_PATH.stat().st_mode & 0o777)
        record['upload'] = ops.upload_backup(oss, client, archive_path, ops.KEY_PATH)
        stage('download_and_decrypt')
        cipher = work / 'artifact.enc'
        manifest_path = work / 'artifact.enc.manifest.json'
        download(oss, client, record['upload']['object_key'], cipher)
        download(oss, client, record['upload']['manifest_key'], manifest_path)
        manifest = json.loads(manifest_path.read_text())
        restored_tar = work / 'restored.tar.gz'
        ops.decrypt(cipher, restored_tar, ops.KEY_PATH, manifest)
        if ops.sha256_file(restored_tar) != record['archive_sha256']:
            raise ValueError('Downloaded archive differs from completed source')
        restore_dir = ops.BACKUP_ROOT / ('oss-restored-' + run_id)
        restore_dir.mkdir(mode=0o700)
        with tarfile.open(restored_tar) as archive:
            members = archive.getmembers()
            if len(members) != len(BACKUP_FILES) or {m.name for m in members} != BACKUP_FILES:
                raise ValueError('Unexpected restored archive members')
            if any(not m.isfile() for m in members):
                raise ValueError('Restored archive must contain only regular files')
            archive.extractall(restore_dir, filter='data')
        if verify_source(restore_dir) != hashes:
            raise ValueError('Restored backup files differ from completed source')
        record.update({'download_ciphertext_sha256_match': True,
                       'manifest_authentication_verified': True,
                       'decrypted_archive_sha256_match': True,
                       'restored_files_match_source': True,
                       'restored_backup_path': str(restore_dir)})
        stage('isolated_database_and_rules_restore')
        result = subprocess.run([str(BASE / 'envs/ops/bin/python'),
            str(BASE / 'scripts/verify-backup.py'), str(restore_dir)],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=300)
        if result.returncode:
            raise RuntimeError('Isolated backup restoration failed')
        restored = json.loads((restore_dir / 'restore-verification.json').read_text())
        if not restored.get('ok') or not restored.get('postgres_roles_and_database_restored'):
            raise ValueError('Isolated restore did not pass')
        record['restore'] = restored
        record.update({'ok': True, 'oss_restore_verified': True, 'completed_at': now()})
        stage('completed')
    except Exception as error:
        # No SDK exception text, subprocess output or response bodies in evidence.
        record.update({'error_type': type(error).__name__, 'failed_at': now()})
        evidence_path.write_text(json.dumps(record, indent=2) + '\n')
        print(json.dumps({'ok': False, 'stage': record['stage'],
                          'error_type': type(error).__name__, 'evidence': str(evidence_path)}))
        return 1
    print(json.dumps(record))
    return 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--evidence', type=Path, default=BASE / 'deploy/oss-acceptance.json')
    args = parser.parse_args()
    raise SystemExit(execute(args.source, args.evidence))
