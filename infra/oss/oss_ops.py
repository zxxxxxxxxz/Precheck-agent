#!/usr/bin/env python3
"""Explicit OSS infrastructure checks and encrypted backup transfer; no daemon."""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import secrets
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from uuid import uuid4

BUCKET = "hsbc-poc"
REGION = "cn-wulanchabu"
BACKUP_ROOT = Path("/data/hsbc/backups")
KEY_PATH = Path("/data/hsbc/secrets/backup.key")
ITERATIONS = 600000
FORMAT = "hsbc-openssl-aes256cbc-pbkdf2-sha256-hmac-v1"


def sha256_file(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def canonical(value: dict) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def secret_key(path: Path) -> bytes:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise ValueError("Backup key must be a regular file with mode 600")
    value = path.read_bytes().strip()
    if len(value) != 64 or any(c not in b"0123456789abcdef" for c in value):
        raise ValueError("Backup key must contain 32 random bytes encoded as 64 hex characters")
    return value


def init_key(path: Path) -> None:
    # Exclusive creation: never overwrite the key needed by previous backups.
    with open(path, "x", opener=lambda p, f: os.open(p, f, 0o600)) as stream:
        stream.write(secrets.token_hex(32) + "\n")


def encrypt(source: Path, target: Path, key: Path) -> dict:
    key_bytes = secret_key(key)
    before = source.stat()
    plain_hash = sha256_file(source)
    subprocess.run([
        "openssl", "enc", "-aes-256-cbc", "-salt", "-pbkdf2", "-iter", str(ITERATIONS),
        "-md", "sha256", "-in", str(source), "-out", str(target), "-pass", f"file:{key}",
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    after = source.stat()
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (
        after.st_size, after.st_mtime_ns, after.st_ino
    ):
        raise ValueError("Source changed during encryption; only upload completed artifacts")
    manifest = {
        "format": FORMAT, "iterations": ITERATIONS,
        "plaintext_sha256": plain_hash, "plaintext_bytes": before.st_size,
        "ciphertext_sha256": sha256_file(target), "ciphertext_bytes": target.stat().st_size,
        "key_id": hashlib.sha256(key_bytes).hexdigest()[:16],
    }
    # Authenticate the ciphertext digest and all restore parameters. Verify before decrypting.
    mac_key = hmac.digest(key_bytes, b"hsbc-backup-manifest-v1", "sha256")
    manifest["hmac_sha256"] = hmac.digest(mac_key, canonical(manifest), "sha256").hex()
    return manifest


def decrypt(source: Path, target: Path, key: Path, manifest: dict) -> None:
    key_bytes = secret_key(key)
    unsigned = dict(manifest)
    supplied_mac = unsigned.pop("hmac_sha256", "")
    mac_key = hmac.digest(key_bytes, b"hsbc-backup-manifest-v1", "sha256")
    expected_mac = hmac.digest(mac_key, canonical(unsigned), "sha256").hex()
    if not hmac.compare_digest(supplied_mac, expected_mac):
        raise ValueError("Backup manifest authentication failed")
    if manifest.get("format") != FORMAT or manifest.get("iterations") != ITERATIONS:
        raise ValueError("Unsupported backup format")
    if sha256_file(source) != manifest["ciphertext_sha256"]:
        raise ValueError("Backup ciphertext hash mismatch")
    if target.exists() or target.is_symlink():
        raise ValueError("Restore target already exists")
    created = False
    try:
        with target.open("xb") as destination:
            created = True
            subprocess.run([
                "openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", str(ITERATIONS),
                "-md", "sha256", "-in", str(source), "-pass", f"file:{key}",
            ], check=True, stdout=destination, stderr=subprocess.DEVNULL)
        if sha256_file(target) != manifest["plaintext_sha256"]:
            raise ValueError("Restored plaintext hash mismatch")
    except BaseException:
        if created:
            target.unlink(missing_ok=True)
        raise


def make_client():
    # Never select developer AK files or environment credentials via a default chain.
    import alibabacloud_oss_v2 as oss
    from alibabacloud_credentials.client import Client as CredentialsClient
    from alibabacloud_credentials.models import Config as CredentialsConfig

    credentials = CredentialsClient(CredentialsConfig(
        type="ecs_ram_role", disable_imds_v1=True, connect_timeout=3000, timeout=5000,
    ))

    def refreshed():
        value = credentials.get_credential()
        return oss.credentials.Credentials(
            access_key_id=value.access_key_id, access_key_secret=value.access_key_secret,
            security_token=value.security_token,
        )

    config = oss.config.load_default()
    config.region = REGION
    config.endpoint = f"https://oss-{REGION}-internal.aliyuncs.com"
    config.credentials_provider = oss.credentials.CredentialsProviderFunc(refreshed)
    config.retry_max_attempts = 3
    config.connect_timeout = 5
    config.readwrite_timeout = 60
    return oss, oss.Client(config)


def bucket_check(oss, client) -> dict:
    result = client.get_bucket_info(oss.GetBucketInfoRequest(bucket=BUCKET)).bucket_info
    if result.acl != "private":
        raise ValueError("Bucket ACL is not private; no object will be written")
    if result.location not in (REGION, f"oss-{REGION}"):
        raise ValueError("Bucket region differs from the APP region")
    return {"bucket": BUCKET, "region": REGION, "acl": result.acl,
            "endpoint": "internal-https", "auth": "ecs-ram-role-imdsv2"}


def downloaded_hash(oss, client, key: str) -> str:
    response = client.get_object(oss.GetObjectRequest(bucket=BUCKET, key=key))
    digest = hashlib.sha256()
    try:
        # OSS SDK V2 StreamBody.read() takes no size and buffers the entire body.
        # iter_bytes() is its bounded streaming interface (unlike file.read(n)).
        for chunk in response.body.iter_bytes():
            digest.update(chunk)
    finally:
        response.body.close()
    return digest.hexdigest()


def smoke(oss, client) -> dict:
    status = bucket_check(oss, client)
    key = f"infra-smoke/{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{uuid4().hex}/probe.bin"
    payload = secrets.token_bytes(4096)
    uploaded = False
    try:
        client.put_object(oss.PutObjectRequest(
            bucket=BUCKET, key=key, body=payload, forbid_overwrite=True,
            content_type="application/octet-stream",
        ))
        uploaded = True
        if downloaded_hash(oss, client, key) != hashlib.sha256(payload).hexdigest():
            raise ValueError("OSS round-trip checksum mismatch")
    finally:
        if uploaded:
            # The only delete operation is this invocation's generated smoke object.
            client.delete_object(oss.DeleteObjectRequest(bucket=BUCKET, key=key))
    return status | {"operation": "smoke", "bytes": len(payload), "sha256_match": True,
                     "generated_object_deleted": True}


def completed_backup(path: Path) -> Path:
    # No directory traversal, symlinked parents, or arbitrary secret-file uploads.
    absolute = path.absolute()
    resolved = path.resolve(strict=True)
    if absolute != resolved or not resolved.is_relative_to(BACKUP_ROOT):
        raise ValueError("Backup must be a non-symlink file under /data/hsbc/backups")
    if not resolved.is_file() or resolved.name.endswith((".tmp", ".partial", ".part")):
        raise ValueError("Only completed regular backup artifacts are accepted")
    return resolved


def upload_backup(oss, client, source: Path, key: Path) -> dict:
    source = completed_backup(source)
    secret_key(key)
    bucket_check(oss, client)
    object_key = f"backups/{datetime.now(timezone.utc):%Y/%m/%d}/{uuid4().hex}/artifact.enc"
    with tempfile.TemporaryDirectory(prefix=".backup-", dir=Path(__file__).parent) as work:
        encrypted = Path(work) / "artifact.enc"
        manifest = encrypt(source, encrypted, key)
        # Multipart uploader supports large completed database/release archives.
        client.uploader().upload_file(oss.PutObjectRequest(
            bucket=BUCKET, key=object_key, forbid_overwrite=True,
            content_type="application/octet-stream",
            metadata={"sha256": manifest["ciphertext_sha256"]},
        ), str(encrypted))
        if downloaded_hash(oss, client, object_key) != manifest["ciphertext_sha256"]:
            raise ValueError("Uploaded encrypted backup failed full download verification")
        client.put_object(oss.PutObjectRequest(
            bucket=BUCKET, key=object_key + ".manifest.json", body=canonical(manifest),
            forbid_overwrite=True, content_type="application/json",
        ))
    return {"operation": "backup-upload", "bucket": BUCKET, "object_key": object_key,
            "manifest_key": object_key + ".manifest.json", "sha256_match": True,
            "ciphertext_sha256": manifest["ciphertext_sha256"], "key_id": manifest["key_id"]}


def main() -> None:
    os.umask(0o077)
    # SDK diagnostic bodies and metadata responses must never reach service logs.
    logging.disable(logging.CRITICAL)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check", help="Read-only RAM-role, private ACL and region check")
    sub.add_parser("smoke", help="Upload, hash-download and delete a unique synthetic object")
    sub.add_parser("init-key", help="Create backup.key once; never print or upload it")
    upload = sub.add_parser("backup-upload", help="Encrypt and upload one completed backup")
    upload.add_argument("file", type=Path)
    restore = sub.add_parser("decrypt", help="Authenticate/decrypt downloaded files locally")
    restore.add_argument("encrypted", type=Path)
    restore.add_argument("manifest", type=Path)
    restore.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.command == "init-key":
        init_key(KEY_PATH)
        result = {"operation": "init-key", "created": True, "path": str(KEY_PATH)}
    elif args.command == "decrypt":
        decrypt(args.encrypted, args.output, KEY_PATH, json.loads(args.manifest.read_text()))
        result = {"operation": "decrypt", "sha256_match": True}
    else:
        oss, client = make_client()
        if args.command == "check":
            result = bucket_check(oss, client)
        elif args.command == "smoke":
            result = smoke(oss, client)
        else:
            result = upload_backup(oss, client, args.file, KEY_PATH)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Do not print str(error): SDK exceptions may embed credentials or response bodies.
        detail = str(error) if isinstance(error, (ValueError, FileNotFoundError)) else type(error).__name__
        print(json.dumps({"ok": False, "error": detail}), file=sys.stderr)
        raise SystemExit(1)
