#!/usr/bin/env python3
"""Restore a completed local backup into an isolated, disposable PG container."""
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

BASE = Path('/data/hsbc')
P3_TABLES = ['case_drafts', 'intake_turns', 'intake_candidates', 'intake_events',
             'model_calls', 'model_egress_receipts', 'model_budgets',
             'model_fixture_grants', 'model_session_grants']
ASSISTANT_TABLES = ['intake_private_projections', 'intake_autofill_receipts']
SIGNATURE_TABLES = ['signature_review_snapshots', 'signature_page_receipts', 'signature_model_calls', 'signature_confirmations', 'private_inference_queue']
COMPANY_TABLES = ['company_lookup_requests', 'company_lookup_receipts', 'company_lookup_cache']
REGION_OCR_TABLES = ['document_region_ocr_requests', 'document_region_ocr_receipts']


def run(args, **kwargs):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=kwargs.pop('timeout', 120), **kwargs)
    if result.returncode:
        raise RuntimeError('Restore verification command failed; credentials omitted')
    return result.stdout


def restore_sql(container, sql):
    # Each statement retains the original 120-second limit. A scalar batch must
    # not share a single statement's transport deadline across all its checks.
    statements = max(1, sql.count(';\n'))
    return run(['docker', 'exec', '-i', container, 'psql', '-X', '-qAt',
                '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'hsbc'],
               input=("SET statement_timeout='120s';\n" + sql).encode(),
               timeout=120 * statements + 10)


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


V2_REVIEW_TABLES = ['review_rounds', 'review_mail_drafts', 'review_analysis_jobs',
                    'review_analysis_snapshots', 'review_analysis_items', 'review_analysis_calls']
CHECKER_TABLES = ['checker_submissions', 'checker_items', 'checker_item_events', 'checker_notes', 'checker_dispositions', 'checker_events']
FORMAL_TABLES = ['formal_review_jobs', 'formal_review_snapshots', 'formal_review_results', 'formal_review_calls']


def checker_formal_reference_checks():
    return {
        'checker_run_scope': "SELECT count(*) FROM business.checker_submissions s LEFT JOIN business.review_runs r ON r.id=s.run_id WHERE r.id IS NULL OR s.case_id<>r.case_id OR s.round_id IS DISTINCT FROM r.round_id OR s.maker_person_id=s.checker_person_id OR encode(sha256(convert_to(business.review_canonical_json(s.snapshot),'UTF8')),'hex')<>s.snapshot_hash",
        'checker_item_scope': "SELECT count(*) FROM business.checker_items i LEFT JOIN business.checker_submissions s ON s.id=i.submission_id WHERE s.id IS NULL OR i.case_id<>s.case_id OR i.round_id<>s.round_id",
        'formal_run_scope': "SELECT count(*) FROM business.formal_review_jobs j LEFT JOIN business.review_runs r ON r.id=j.run_id WHERE r.id IS NULL OR j.case_id<>r.case_id OR j.round_id IS DISTINCT FROM r.round_id OR j.snapshot_hash<>r.snapshot_hash OR j.configuration_release_id<>r.configuration_release_id",
        'formal_snapshot_hash': "SELECT count(*) FROM business.formal_review_jobs j LEFT JOIN business.formal_review_snapshots s ON s.job_id=j.id WHERE s.job_id IS NULL OR encode(sha256(convert_to(business.review_canonical_json(s.body),'UTF8')),'hex')<>s.body_hash OR s.body_hash<>j.input_hash OR s.body->>'runHash' IS DISTINCT FROM j.snapshot_hash OR s.body->>'profileHash' IS DISTINCT FROM j.profile_hash",
        'formal_result_hash': "SELECT count(*) FROM business.formal_review_results r JOIN business.formal_review_snapshots s ON s.job_id=r.job_id WHERE encode(sha256(convert_to(business.review_canonical_json(r.body),'UTF8')),'hex')<>r.body_hash OR r.body->>'checkId' IS DISTINCT FROM r.check_id OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.body->'checks') c WHERE c->>'id'=r.check_id)",
    }


def v2_review_reference_checks():
    return {
        'round_document_job_scope': "SELECT count(*) FROM business.document_jobs j JOIN business.document_versions d ON d.id=j.document_version_id WHERE j.round_id IS DISTINCT FROM d.round_id",
        'mail_frozen_run_scope': "SELECT count(*) FROM business.review_mail_drafts d LEFT JOIN business.review_runs r ON r.id=d.run_id WHERE r.id IS NULL OR d.case_id<>r.case_id OR d.round_id IS DISTINCT FROM r.round_id",
        'round_current_case_scope': "SELECT count(*) FROM business.cases c LEFT JOIN business.review_rounds r ON r.id=c.current_round_id WHERE c.current_round_id IS NOT NULL AND (NOT c.review_rounds_enabled OR r.case_id IS DISTINCT FROM c.id)",
    }


def isolation_sql(p2, mock=False, p3=False, review=False, attachments=False, signatures=False, processing_access=False, review_analysis=False, checker_formal=False):
    """Invalidate restored execution authority without discarding historical evidence.

    This runs only in verify()'s disposable, network-less database. Recovery of a
    real installation must apply the same fences before any runtime is started.
    """
    statements = [
        'BEGIN', 'DELETE FROM auth.sessions', 'DELETE FROM auth.session_revocations',
        'UPDATE auth.accounts SET session_epoch=session_epoch+1',
        'UPDATE business.principals p SET enabled=false,auth_version=auth_version+1 WHERE NOT EXISTS (SELECT 1 FROM auth.accounts a WHERE a.id=p.account_id)',
        "UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL,error_code='restore_reauthorization_required',updated_at=now() WHERE state IN ('pending','running')",
        "UPDATE business.upload_sessions SET state='canceled',error_code='restore_reauthorization_required',updated_at=now() WHERE state IN ('issued','verifying')",
        "UPDATE business.outbox SET dispatched_at=now() WHERE dispatched_at IS NULL AND work_item_id IN (SELECT id FROM business.work_items WHERE state='canceled')",
    ]
    if p2:
        statements.extend([
            'UPDATE business.document_tool_delegations SET revoked=true WHERE NOT revoked',
            "UPDATE business.document_jobs SET state='stale',validity='stale',error_code='restore_reauthorization_required',updated_at=now() WHERE state IN ('pending','running')",
            "UPDATE business.document_versions SET parse_status='stale' WHERE parse_status IN ('pending','running')",
            "UPDATE business.parse_intents SET state='stale' WHERE state IN ('pending','running')",
        ])
    if mock:
        statements.append("UPDATE business.mock_validation_jobs SET state='stale',error_code='restore_reauthorization_required',updated_at=now() WHERE state IN ('pending','running')")
    if p3:
        statements.extend([
            # A provider may have accepted a sent request. Its reservation remains
            # held until a separate, explicit reconciliation resolves the outcome.
            "UPDATE business.model_calls SET state='unknown',error_code='restore_reauthorization_required',updated_at=now() WHERE state IN ('sent','unknown') OR (state IN ('pending','running') AND sent_at IS NOT NULL)",
            "WITH released AS (SELECT profile_id,budget_day,sum(reserved_micros) AS amount FROM business.model_calls WHERE sent_at IS NULL AND state IN ('pending','running','canceled') AND reserved_micros>0 GROUP BY profile_id,budget_day) UPDATE business.model_budgets b SET reserved_micros=b.reserved_micros-r.amount FROM released r WHERE b.profile_id=r.profile_id AND b.budget_day=r.budget_day",
            "UPDATE business.model_calls SET state='canceled',reserved_micros=0,error_code='restore_reauthorization_required',updated_at=now() WHERE sent_at IS NULL AND state IN ('pending','running','canceled')",
            "UPDATE business.intake_turns SET status='stale',error_code='restore_reauthorization_required',updated_at=now() WHERE status IN ('pending','running','unknown')",
            'UPDATE business.model_session_grants SET revoked=true WHERE NOT revoked',
            'UPDATE business.model_fixture_grants SET expires_at=LEAST(expires_at,now())',
        ])
    if attachments:
        statements.append("UPDATE business.draft_attachments SET parse_state='failed',parse_epoch=parse_epoch+1,parse_lease_until=NULL,parse_error_code='restore_reauthorization_required' WHERE parse_state='running' OR parse_lease_until IS NOT NULL")
    if review:
        statements.append("UPDATE business.review_supplements SET state='canceled',error_code='restore_reauthorization_required',updated_at=now() WHERE state IN ('pending','running')")
        statements.append("UPDATE business.review_runs SET state='stale',validity='stale',error_code='restore_reauthorization_required',updated_at=now() WHERE state IN ('pending','running')")
    if review_analysis:
        # Cancel unfinished local execution, preserve immutable results and unknown calls.
        statements.append("UPDATE business.review_analysis_jobs SET state='canceled',error_code='restore_reauthorization_required',updated_at=now() WHERE state IN ('pending','running')")
    if checker_formal:
        # Preserve all frozen evidence and provider receipts. No unknown call is
        # settled, refunded or retried merely because a database was restored.
        statements.append("UPDATE business.formal_review_jobs SET state='stale',cancel_requested=true,error_code='restore_reauthorization_required',updated_at=now() WHERE state IN ('pending','running','unknown','failed')")
        statements.append("UPDATE business.checker_submissions SET validity='stale',version=version+1 WHERE state='submitted' AND validity='current'")
    if processing_access:
        statements.append("UPDATE business.document_processing_access SET state='revoked',version=version+1,revoked_at=now() WHERE state IN ('pending','approved')")
    if signatures:
        # Queue entries are admission leases, not provider receipts. Active jobs
        # were fenced above; unknown calls retain their immutable dispatch record.
        statements.append('DELETE FROM business.private_inference_queue')
    return ';\n'.join(statements + ['COMMIT']) + ';\n'


def processing_access_reference_checks():
    return {
        'processing_access_scope': "SELECT count(*) FROM business.document_processing_access a LEFT JOIN business.cases c ON c.id=a.case_id WHERE c.id IS NULL OR (a.state='approved' AND (a.decider_person_id IS NULL OR a.decider_person_id=a.requester_person_id)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.documents) s LEFT JOIN business.document_versions d ON d.id::text=s->>'id' WHERE d.id IS NULL OR d.case_id<>a.case_id OR d.sha256 IS DISTINCT FROM s->>'sha256')",
        'demo_processing_policy_job_scope': "SELECT count(*) FROM business.document_jobs j LEFT JOIN business.review_config_releases r ON r.release_id=j.input->'processingPermit'->>'configurationReleaseId' LEFT JOIN business.document_versions d ON d.id=j.document_version_id WHERE j.input->'processingPermit'->>'kind'='demo_policy' AND (r.release_id IS NULL OR r.manifest->>'scope' IS DISTINCT FROM 'synthetic' OR r.document_configuration_id IS DISTINCT FROM j.configuration_release_id OR d.case_id IS DISTINCT FROM j.case_id OR (d.source_format IS NULL OR d.source_format NOT IN ('pdf','docx','jpg','png')) OR NOT EXISTS (SELECT 1 FROM business.audit_events a WHERE a.target_id=j.id::text AND a.actor_id IS NULL AND a.action='document:demo_policy_applied' AND a.details->>'caseId'=j.case_id::text AND a.details->>'documentId'=j.document_version_id::text AND a.details->>'dataClass'='public_synthetic' AND a.details->>'policyId'=j.input->'processingPermit'->>'policyId' AND a.details->>'policyVersion'=j.input->'processingPermit'->>'policyVersion' AND a.details->>'policyHash'=j.input->'processingPermit'->>'policyHash' AND a.details->>'configurationReleaseId'=r.release_id))",
        'processing_policy_job_scope': "SELECT count(*) FROM business.document_jobs j LEFT JOIN business.review_events e ON e.id::text=j.input->'processingPermit'->>'id' WHERE j.input->'processingPermit'->>'kind'='policy' AND (e.id IS NULL OR e.kind<>'processing_policy_declared' OR e.case_id<>j.case_id OR e.details->>'policyHash' IS DISTINCT FROM j.input->'processingPermit'->>'policyHash' OR e.details->>'configurationReleaseId' IS DISTINCT FROM j.configuration_release_id OR e.details->>'configurationReleaseId' IS DISTINCT FROM j.input->'processingPermit'->>'configurationReleaseId' OR e.details->>'dataClass' IS DISTINCT FROM 'public_synthetic')",
        'processing_access_job_scope': "SELECT count(*) FROM business.document_jobs j LEFT JOIN business.document_processing_access a ON a.id::text=j.input->'processingPermit'->>'id' WHERE j.input->'processingPermit'->>'kind'='case' AND (a.id IS NULL OR a.case_id<>j.case_id OR a.policy_hash IS DISTINCT FROM j.input->'processingPermit'->>'policyHash' OR a.version<(j.input->'processingPermit'->>'version')::int)",
    }


def signature_reference_checks():
    return {
        'signature_snapshot_scope': "SELECT count(*) FROM business.signature_review_snapshots s LEFT JOIN business.document_jobs j ON j.id=s.job_id LEFT JOIN business.document_jobs p ON p.id::text=s.body->>'parseRevision' LEFT JOIN business.document_versions d ON d.id=j.document_version_id WHERE j.id IS NULL OR j.kind<>'review_signatures' OR p.id IS NULL OR p.kind<>'parse_document' OR p.case_id<>j.case_id OR p.document_version_id<>j.document_version_id OR s.body->>'sourceSha256' IS DISTINCT FROM d.sha256 OR s.body->>'caseRevision' IS DISTINCT FROM j.expected_revision::text OR encode(sha256(convert_to(business.review_canonical_json(s.body),'UTF8')),'hex') IS DISTINCT FROM s.input_hash OR s.input_hash IS DISTINCT FROM j.input->>'inputSha256' OR s.body->>'directoryRevision' IS DISTINCT FROM j.input->>'directoryRevision' OR s.body->>'configurationReleaseId' IS DISTINCT FROM j.input->>'reviewReleaseId' OR NOT EXISTS(SELECT 1 FROM business.document_artifacts a WHERE a.job_id=p.id AND a.directory_revision::text=s.body->>'directoryRevision')",
        'signature_snapshot_pages': "SELECT count(*) FROM business.signature_review_snapshots s CROSS JOIN LATERAL jsonb_array_elements(s.body->'pageHashes') h LEFT JOIN business.document_pages p ON p.job_id::text=s.body->>'parseRevision' AND p.page_number::text=h->>'pageNumber' WHERE p.job_id IS NULL OR h->>'imageSha256' IS DISTINCT FROM p.image_sha256",
        'signature_page_receipt_scope': "SELECT count(*) FROM business.signature_page_receipts r LEFT JOIN business.signature_review_snapshots s ON s.job_id=r.job_id WHERE s.job_id IS NULL OR encode(sha256(convert_to(business.review_canonical_json(r.body),'UTF8')),'hex') IS DISTINCT FROM r.body_hash OR r.body->>'pageNumber' IS DISTINCT FROM r.page_number::text OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.body->'pageHashes') h WHERE h->>'pageNumber'=r.page_number::text AND h->>'imageSha256'=r.body->>'imageSha256') OR jsonb_typeof(r.body->'observations') IS DISTINCT FROM 'array' OR r.body->>'coverage' IS NULL OR r.body->>'coverage' NOT IN ('complete','partial','unreadable')",
        'signature_observation_binding': "SELECT count(*) FROM business.signature_page_receipts r JOIN business.signature_review_snapshots s ON s.job_id=r.job_id CROSS JOIN LATERAL jsonb_array_elements(r.body->'observations') o WHERE o->>'pageNumber' IS DISTINCT FROM r.page_number::text OR o->>'imageSha256' IS DISTINCT FROM r.body->>'imageSha256' OR o->>'sourceSha256' IS DISTINCT FROM s.body->>'sourceSha256' OR o->>'parseRevision' IS DISTINCT FROM s.body->>'parseRevision' OR o->>'modelVersion' IS DISTINCT FROM s.body->>'modelRevision' OR o->>'cropSha256' IS NULL OR o->>'cropSha256' !~ '^[a-f0-9]{64}$'",
        'signature_model_call_scope': "SELECT count(*) FROM business.signature_model_calls c LEFT JOIN business.signature_review_snapshots s ON s.job_id=c.job_id WHERE s.job_id IS NULL OR (c.state='completed') IS DISTINCT FROM (c.response IS NOT NULL) OR c.request_hash !~ '^[a-f0-9]{64}$'",
        'signature_confirmation_scope': "SELECT count(*) FROM business.signature_confirmations c LEFT JOIN business.signature_review_snapshots s ON s.job_id=c.job_id LEFT JOIN business.document_jobs j ON j.id=c.job_id WHERE s.job_id IS NULL OR j.id IS NULL OR c.case_id<>j.case_id OR c.case_revision<>j.expected_revision OR c.input_hash<>s.input_hash OR c.body->>'id' IS DISTINCT FROM c.id::text",
        'signature_job_snapshot': "SELECT count(*) FROM business.document_jobs j LEFT JOIN business.signature_review_snapshots s ON s.job_id=j.id WHERE j.kind='review_signatures' AND s.job_id IS NULL",
    }


def signature_information_reference_checks():
    return {
        'signature_information_source_scope': "SELECT count(*) FROM business.signature_information_records r LEFT JOIN business.document_versions d ON d.id=r.document_version_id LEFT JOIN business.document_jobs p ON p.id=r.parse_revision WHERE d.id IS NULL OR d.case_id<>r.case_id OR d.round_id IS DISTINCT FROM r.round_id OR p.id IS NULL OR p.kind<>'parse_document' OR p.document_version_id<>d.id OR r.input->>'documentId' IS DISTINCT FROM d.id::text OR r.input->>'sourceSha256' IS DISTINCT FROM d.sha256 OR r.input->>'parseRevision' IS DISTINCT FROM p.id::text OR r.input->>'directoryRevision' IS DISTINCT FROM r.directory_revision::text OR NOT EXISTS(SELECT 1 FROM business.document_artifacts a WHERE a.job_id=p.id AND a.directory_revision=r.directory_revision)",
        'signature_information_integrity': "SELECT count(*) FROM business.signature_information_records r WHERE encode(sha256(convert_to(business.review_canonical_json(r.body),'UTF8')),'hex') IS DISTINCT FROM r.body_hash OR encode(sha256(convert_to(business.review_canonical_json(r.input),'UTF8')),'hex') IS DISTINCT FROM r.input_hash",
    }


def ocr_mark_reference_checks(docx=False):
    """Check retained clue identities, not OCR text, detection quality or signature facts.

    Optional fields are absent in old artifacts. Present null/malformed layers fail;
    DOCX may downgrade bundle geometry without changing the original page receipt.
    The application remains responsible for the complete DTO/geometry validation.
    """
    def array(value):
        return f"(CASE WHEN jsonb_typeof({value})='array' THEN {value} ELSE '[]'::jsonb END)"

    items = array("m.layer->'items'")
    layers = array("a.body->'ocrMarkPages'")
    invalid_layer = f"""jsonb_typeof(m.layer) IS DISTINCT FROM 'object'
      OR m.layer->>'schemaVersion' IS DISTINCT FROM 'ocr-marks.v1'
      OR COALESCE(m.layer->>'status','') NOT IN ('reported','partial','unavailable')
      OR m.layer->'absenceProven' IS DISTINCT FROM 'false'::jsonb
      OR jsonb_typeof(m.layer->'items') IS DISTINCT FROM 'array' OR jsonb_array_length({items})>1000
      OR jsonb_typeof(m.layer->'coverageGaps') IS DISTINCT FROM 'array'
      OR COALESCE(m.layer->>'configurationSha256','') !~ '^[a-f0-9]{{64}}$'
      OR NOT(m.layer ? 'responseSha256')
      OR (m.layer->'responseSha256'<>'null'::jsonb AND COALESCE(m.layer->>'responseSha256','') !~ '^[a-f0-9]{{64}}$')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements({items}) item WHERE
        jsonb_typeof(item) IS DISTINCT FROM 'object' OR COALESCE(item->>'id','')=''
        OR (SELECT count(*) FROM jsonb_array_elements({items}) other WHERE other->>'id'=item->>'id')<>1
        OR COALESCE(item->>'kind','') NOT IN ('stamp','signature')
        OR COALESCE(item->>'mappingStatus','') NOT IN ('verified','unavailable')
        OR jsonb_typeof(item->'sourceRefs') IS DISTINCT FROM 'array' OR jsonb_array_length({array("item->'sourceRefs'")}) NOT BETWEEN 1 AND 16
        OR (item->>'mappingStatus'='unavailable' AND (item->'regionId' IS DISTINCT FROM 'null'::jsonb OR item->'bbox' IS DISTINCT FROM 'null'::jsonb OR item->'polygon' IS DISTINCT FROM 'null'::jsonb))
        OR (item->>'mappingStatus'='verified' AND (COALESCE(item->>'regionId','')='' OR jsonb_typeof(item->'bbox') IS DISTINCT FROM 'array' OR jsonb_typeof(item->'polygon') IS DISTINCT FROM 'array')))"""
    scope = """j.id IS NULL OR d.id IS NULL
      OR body->'scope'->>'caseId' IS DISTINCT FROM j.case_id::text
      OR body->'scope'->>'documentVersionId' IS DISTINCT FROM d.id::text
      OR body->'scope'->>'parseRevision' IS DISTINCT FROM j.id::text
      OR body->'scope'->>'sourceSha256' IS DISTINCT FROM d.sha256"""
    identity = """m.layer->>'documentVersionId' IS DISTINCT FROM d.id::text
      OR m.layer->>'parseRevision' IS DISTINCT FROM j.id::text
      OR m.layer->>'sourceSha256' IS DISTINCT FROM d.sha256
      OR m.layer->'pageNumber' IS DISTINCT FROM to_jsonb(p.page_number)
      OR m.layer->>'pageAssetId' IS DISTINCT FROM p.page_asset_id
      OR m.layer->>'imageSha256' IS DISTINCT FROM p.image_sha256"""
    checks = {
        'ocr_page_layer_identity': f"""SELECT count(*) FROM business.document_pages p
          LEFT JOIN business.document_jobs j ON j.id=p.job_id LEFT JOIN business.document_versions d ON d.id=j.document_version_id
          CROSS JOIN LATERAL (SELECT p.body->'ocrMarks' AS layer) m WHERE p.body ? 'ocrMarks' AND (
          {invalid_layer} OR {scope.replace('body->', 'p.body->')} OR {identity}
          OR p.body->'page'->'page_number' IS DISTINCT FROM to_jsonb(p.page_number)
          OR p.body->'page'->>'page_asset_id' IS DISTINCT FROM p.page_asset_id
          OR p.body->'page'->>'document_version_id' IS DISTINCT FROM d.id::text
          OR p.body->'page'->>'parse_revision' IS DISTINCT FROM j.id::text
          OR p.body->>'imageSha256' IS DISTINCT FROM p.image_sha256)""",
        'ocr_bundle_layer_identity': f"""SELECT count(*) FROM business.document_artifacts a
          LEFT JOIN business.document_jobs j ON j.id=a.job_id LEFT JOIN business.document_versions d ON d.id=j.document_version_id
          WHERE a.body ? 'ocrMarkPages' AND (jsonb_typeof(a.body->'ocrMarkPages') IS DISTINCT FROM 'array'
          OR {scope.replace('body->', 'a.body->')} OR EXISTS(
            SELECT 1 FROM jsonb_array_elements({layers}) m(layer)
            LEFT JOIN business.document_pages p ON p.job_id=a.job_id AND to_jsonb(p.page_number)=m.layer->'pageNumber'
            WHERE p.job_id IS NULL OR {invalid_layer} OR {identity}
              OR NOT(p.body ? 'ocrMarks')
              OR m.layer->'responseSha256' IS DISTINCT FROM p.body->'ocrMarks'->'responseSha256'
              OR m.layer->'configurationSha256' IS DISTINCT FROM p.body->'ocrMarks'->'configurationSha256'
              OR (SELECT count(*) FROM jsonb_array_elements({layers}) other WHERE other->'pageNumber'=m.layer->'pageNumber')<>1))""",
    }
    # PDF and image PageAssets bind original bytes; a DOCX PageAsset binds the
    # retained rendered PDF while the scope and OCR layer bind the DOCX bytes.
    page_pdf = "p.body->'page'->>'source_sha256' IS DISTINCT FROM d.sha256 OR p.body->'scope' ? 'sourceFormat'"
    raster_scope = "body->'scope'->>'sourceFormat' IS DISTINCT FROM CASE WHEN d.source_format IN ('jpg','png') THEN d.source_format ELSE NULL END OR body->'scope' ? 'previewRevision' OR body->'scope' ? 'previewSha256'"
    page_original = "p.body->'page'->>'source_sha256' IS DISTINCT FROM d.sha256 OR " + raster_scope.replace('body->', 'p.body->')
    if not docx:
        checks['ocr_page_source_binding'] = "SELECT count(*) FROM business.document_pages p JOIN business.document_jobs j ON j.id=p.job_id JOIN business.document_versions d ON d.id=j.document_version_id WHERE p.body ? 'ocrMarks' AND (" + page_pdf + ")"
    else:
        preview = """v.id IS NULL OR v.state NOT IN ('ready','partial') OR v.pdf_sha256 IS NULL
          OR body->'scope'->>'sourceFormat' IS DISTINCT FROM 'docx'
          OR body->'scope'->>'previewRevision' IS DISTINCT FROM v.id::text
          OR body->'scope'->>'previewSha256' IS DISTINCT FROM v.pdf_sha256"""
        checks['ocr_page_source_binding'] = f"""SELECT count(*) FROM business.document_pages p JOIN business.document_jobs j ON j.id=p.job_id
          JOIN business.document_versions d ON d.id=j.document_version_id LEFT JOIN business.document_previews v ON v.job_id=p.job_id
          WHERE p.body ? 'ocrMarks' AND ((d.source_format<>'docx' AND ({page_original})) OR (d.source_format='docx' AND (
          {preview.replace('body->', 'p.body->')} OR p.body->'page'->>'source_sha256' IS DISTINCT FROM v.pdf_sha256)))"""
        checks['ocr_bundle_preview_binding'] = f"""SELECT count(*) FROM business.document_artifacts a JOIN business.document_jobs j ON j.id=a.job_id
          JOIN business.document_versions d ON d.id=j.document_version_id LEFT JOIN business.document_previews v ON v.job_id=a.job_id
          WHERE a.body ? 'ocrMarkPages' AND jsonb_array_length({layers})>0 AND (
          (d.source_format='docx' AND ({preview.replace('body->', 'a.body->')}))
          OR (d.source_format<>'docx' AND ({raster_scope.replace('body->', 'a.body->')})))"""
    return checks


def reference_checks(p2, indexed=False, docx=False, mock=False, p3=False, attachments=False, assistant=False):
    checks = {
        'document_upload_versions': "SELECT count(*) FROM business.document_versions d LEFT JOIN business.upload_sessions u ON u.id=d.upload_session_id WHERE u.id IS NULL OR u.state <> 'registered' OR d.oss_version_id IN ('','null') OR d.object_key <> u.object_key OR d.oss_version_id <> u.oss_version_id OR d.case_id <> u.case_id",
        'parse_intents': "SELECT count(*) FROM business.parse_intents p LEFT JOIN business.document_versions d ON d.id=p.document_version_id WHERE d.id IS NULL OR " + ("(p.state NOT IN ('capability_disabled','configuration_required') AND d.current_parse_job_id IS NULL)" if p2 else "p.state <> 'capability_disabled'"),
        'upload_work_owners': "SELECT count(*) FROM business.work_items w LEFT JOIN business.upload_sessions u ON w.owner_type='UploadSession' AND u.id=w.owner_id WHERE w.owner_type='UploadSession' AND u.id IS NULL",
    }
    if p2:
        checks.update(ocr_mark_reference_checks(docx))
        page_count_mismatch = ("(d.source_format IN ('pdf','jpg','png') AND (j.total_pages IS NULL OR j.total_pages<1 OR j.total_pages IS DISTINCT FROM d.page_count))" if docx
                               else "(j.total_pages IS NULL OR j.total_pages<1 OR j.total_pages IS DISTINCT FROM d.page_count)")
        checks.update({
            'current_parse_pointer': "SELECT count(*) FROM business.document_versions d LEFT JOIN business.document_jobs j ON j.id=d.current_parse_job_id WHERE d.current_parse_job_id IS NOT NULL AND (j.id IS NULL OR j.kind <> 'parse_document' OR j.document_version_id <> d.id OR j.case_id <> d.case_id)",
            'document_job_scope': "SELECT count(*) FROM business.document_jobs j LEFT JOIN business.document_versions d ON d.id=j.document_version_id LEFT JOIN business.document_configurations c ON c.id=j.configuration_release_id WHERE d.id IS NULL OR c.id IS NULL OR j.case_id <> d.case_id OR " + page_count_mismatch + " OR j.completed_pages < 0 OR j.completed_pages > j.total_pages OR (j.total_pages IS NULL AND j.completed_pages<>0)",
            'document_work_owners': "SELECT count(*) FROM business.work_items w LEFT JOIN business.document_jobs j ON w.owner_type='DocumentJob' AND j.id=w.owner_id WHERE w.owner_type='DocumentJob' AND (j.id IS NULL OR w.kind <> j.kind)",
            'page_scope_and_versions': "SELECT count(*) FROM business.document_pages p LEFT JOIN business.document_jobs j ON j.id=p.job_id WHERE j.id IS NULL OR j.total_pages IS NULL OR p.page_number > j.total_pages OR p.image_key='' OR p.json_key='' OR p.image_version_id IN ('','null') OR p.json_version_id IN ('','null') OR p.image_sha256 !~ '^[a-f0-9]{64}$' OR p.json_sha256 !~ '^[a-f0-9]{64}$' OR (p.body->'scope'->>'parseRevision') IS DISTINCT FROM p.job_id::text OR (p.body->'scope'->>'documentVersionId') IS DISTINCT FROM j.document_version_id::text OR (p.body->'page'->>'page_asset_id') IS DISTINCT FROM p.page_asset_id",
            'artifact_scope_and_versions': "SELECT count(*) FROM business.document_artifacts a LEFT JOIN business.document_jobs j ON j.id=a.job_id WHERE j.id IS NULL OR a.object_key='' OR a.oss_version_id IN ('','null') OR a.sha256 !~ '^[a-f0-9]{64}$' OR (a.body->'scope'->>'parseRevision') IS DISTINCT FROM a.job_id::text OR (a.body->'scope'->>'documentVersionId') IS DISTINCT FROM j.document_version_id::text",
            'delegation_document_scope': "SELECT count(*) FROM business.document_tool_delegations g CROSS JOIN LATERAL unnest(g.document_ids) selected(id) LEFT JOIN business.document_versions d ON d.id=selected.id WHERE d.id IS NULL OR d.case_id <> g.case_id",
        })
    if indexed:
        checks.update({
            'index_scope_and_artifact': "SELECT count(*) FROM business.document_chunks c LEFT JOIN business.document_jobs j ON j.id=c.job_id LEFT JOIN business.document_artifacts a ON a.job_id=c.job_id AND a.directory_revision=c.directory_revision WHERE j.id IS NULL OR a.id IS NULL OR c.case_id<>j.case_id OR c.document_version_id<>j.document_version_id OR c.configuration_release_id<>j.configuration_release_id OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.body->'chunks') chunk WHERE chunk->>'id'=c.chunk_id AND chunk->>'textSha256'=c.text_sha256 AND chunk->>'text'=c.content)",
            'index_completeness': "SELECT count(*) FROM business.document_artifacts a WHERE (SELECT count(*) FROM business.document_chunks c WHERE c.job_id=a.job_id AND c.directory_revision=a.directory_revision) <> jsonb_array_length(a.body->'chunks')",
        })
    if docx:
        checks.update({
            'docx_source_scope_and_version': "SELECT count(*) FROM business.document_sources s LEFT JOIN business.document_jobs j ON j.id=s.job_id LEFT JOIN business.document_versions d ON d.id=j.document_version_id WHERE j.id IS NULL OR d.source_format IS DISTINCT FROM 'docx' OR s.object_key='' OR s.oss_version_id IN ('','null') OR s.sha256 !~ '^[a-f0-9]{64}$' OR (s.body->>'sourceSha256') IS DISTINCT FROM d.sha256 OR (s.body->>'schemaVersion') IS DISTINCT FROM 'docx.v1'",
            'docx_preview_scope_and_version': "SELECT count(*) FROM business.document_previews p LEFT JOIN business.document_jobs j ON j.id=p.job_id LEFT JOIN business.document_sources s ON s.job_id=p.job_id LEFT JOIN business.document_versions d ON d.id=j.document_version_id WHERE j.id IS NULL OR s.job_id IS NULL OR d.source_format IS DISTINCT FROM 'docx' OR (p.state IN ('ready','partial') AND (p.pdf_key IS NULL OR p.pdf_key='' OR p.pdf_version_id IS NULL OR p.pdf_version_id IN ('','null') OR p.pdf_sha256 IS NULL OR p.pdf_sha256 !~ '^[a-f0-9]{64}$' OR p.page_count IS NULL OR p.page_count<1 OR j.total_pages IS DISTINCT FROM p.page_count OR (p.manifest->>'sourceSha256') IS DISTINCT FROM d.sha256 OR (p.manifest->>'pdfSha256') IS DISTINCT FROM p.pdf_sha256 OR (p.manifest->>'pageCount') IS DISTINCT FROM p.page_count::text)) OR (p.state IN ('failed','unavailable') AND (p.pdf_key IS NOT NULL OR p.pdf_version_id IS NOT NULL OR p.pdf_sha256 IS NOT NULL OR p.page_count IS NOT NULL OR j.total_pages IS NOT NULL OR j.completed_pages<>0))",
            'docx_job_preview_total': "SELECT count(*) FROM business.document_jobs j JOIN business.document_versions d ON d.id=j.document_version_id LEFT JOIN business.document_previews p ON p.job_id=j.id WHERE d.source_format='docx' AND j.kind='parse_document' AND j.total_pages IS NOT NULL AND (p.id IS NULL OR p.state NOT IN ('ready','partial') OR j.total_pages<1 OR j.total_pages IS DISTINCT FROM p.page_count)",
            'docx_page_preview_binding': "SELECT count(*) FROM business.document_pages p JOIN business.document_jobs j ON j.id=p.job_id JOIN business.document_versions d ON d.id=j.document_version_id LEFT JOIN business.document_previews v ON v.job_id=p.job_id WHERE d.source_format='docx' AND (v.id IS NULL OR v.state NOT IN ('ready','partial') OR (p.body->'scope'->>'sourceSha256') IS DISTINCT FROM d.sha256 OR (p.body->'scope'->>'previewRevision') IS DISTINCT FROM v.id::text OR (p.body->'scope'->>'previewSha256') IS DISTINCT FROM v.pdf_sha256)",
            'docx_mapping_scope': "SELECT count(*) FROM business.document_source_mappings m LEFT JOIN business.document_sources s ON s.job_id=m.job_id LEFT JOIN business.document_previews p ON p.id=m.preview_id WHERE s.job_id IS NULL OR p.id IS NULL OR p.job_id<>m.job_id OR jsonb_typeof(m.body) IS DISTINCT FROM 'array'",
            'docx_mapping_nodes_and_anchors': "SELECT count(*) FROM business.document_source_mappings m JOIN business.document_sources s ON s.job_id=m.job_id CROSS JOIN LATERAL jsonb_array_elements(m.body) item WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.body->'nodes') node WHERE node->>'id'=item->>'sourceNodeId') OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(item->'anchorIds') selected(id) WHERE NOT EXISTS(SELECT 1 FROM business.document_pages p CROSS JOIN LATERAL jsonb_array_elements(p.body->'anchors') anchor WHERE p.job_id=m.job_id AND anchor->>'anchor_id'=selected.id))",
        })
    if mock:
        checks.update({
            'mock_source_scope_and_hash': "SELECT count(*) FROM business.mock_validation_jobs m LEFT JOIN business.document_versions d ON d.id=m.document_version_id LEFT JOIN business.document_jobs j ON j.id=m.source_parse_revision LEFT JOIN business.document_pages p ON p.job_id=m.source_parse_revision AND p.page_number=m.page_number WHERE d.id IS NULL OR j.id IS NULL OR p.job_id IS NULL OR m.case_id<>d.case_id OR j.case_id<>m.case_id OR j.document_version_id<>m.document_version_id OR m.source_sha256<>d.sha256 OR m.source_page_sha256<>p.image_sha256 OR m.source_page_key<>p.image_key OR m.source_page_version_id<>p.image_version_id OR (m.input->>'sourceSha256') IS DISTINCT FROM m.source_sha256 OR (m.input->>'sourcePageSha256') IS DISTINCT FROM m.source_page_sha256 OR (m.input->>'sourceParseRevision') IS DISTINCT FROM m.source_parse_revision::text OR (m.input->>'confirmedRedactionBoxes') IS DISTINCT FROM 'true' OR (m.input->>'syntheticValuesConfirmed') IS DISTINCT FROM 'true'",
            'mock_work_owner': "SELECT count(*) FROM business.work_items w LEFT JOIN business.mock_validation_jobs m ON m.id=w.owner_id WHERE w.owner_type='MockValidationJob' AND (m.id IS NULL OR w.kind<>'mock_ocr_validation' OR w.queue<>'document')",
            'mock_result_and_image_identity': "SELECT count(*) FROM business.mock_validation_jobs m WHERE (m.image_key IS NOT NULL AND (m.image_key NOT LIKE '%/derived/mock-validation/'||m.id::text||'/%' OR m.image_version_id IS NULL OR m.image_version_id IN ('','null') OR m.image_sha256 IS NULL OR m.image_sha256 !~ '^[a-f0-9]{64}$')) OR (m.state IN ('ready','partial') AND (m.result IS NULL OR m.image_key IS NULL OR (m.result->>'synthetic') IS DISTINCT FROM 'true' OR (m.result->>'purpose') IS DISTINCT FROM 'mock_ocr_validation' OR (m.result->>'ocrInputSha256') IS DISTINCT FROM m.image_sha256 OR (m.result->>'fontSha256') IS DISTINCT FROM m.font_sha256 OR (m.result->>'outsidePixelsUnchanged') IS DISTINCT FROM 'true' OR (m.result->>'originalFileUnchanged') IS DISTINCT FROM 'true' OR (m.result->>'originalPageUnchanged') IS DISTINCT FROM 'true'))",
            'mock_not_formal_parse': "SELECT count(*) FROM business.mock_validation_jobs m JOIN business.document_versions d ON d.current_parse_job_id=m.id",
            'mock_not_formal_page_or_artifact': "SELECT count(*) FROM business.mock_validation_jobs m WHERE EXISTS(SELECT 1 FROM business.document_pages p WHERE p.job_id=m.id OR p.image_key=m.image_key) OR EXISTS(SELECT 1 FROM business.document_artifacts a WHERE a.job_id=m.id)",
        })
        if indexed:
            checks['mock_not_formal_index'] = "SELECT count(*) FROM business.mock_validation_jobs m JOIN business.document_chunks c ON c.job_id=m.id"
    if p3:
        checks.update(p3_reference_checks(assistant))
    if attachments:
        checks.update(attachment_reference_checks())
    return checks


def archived_model_accounting_checks():
    """Count both live and recovered historical accounting without restoring execution."""
    amounts = "SELECT profile_id,budget_day,reserved_micros,COALESCE(charged_micros,0) charged_micros FROM business.model_calls UNION ALL SELECT profile_id,budget_day,reserved_micros,charged_micros FROM business.model_call_accounting_archives"
    checks = {
        'archived_call_overlap': "SELECT count(*) FROM business.model_call_accounting_archives a JOIN business.model_calls c ON c.id=a.call_id",
        'archived_call_budget_reference': "SELECT count(*) FROM business.model_call_accounting_archives a LEFT JOIN business.model_budgets b USING(profile_id,budget_day) WHERE b.profile_id IS NULL",
        'archived_call_permissions': "SELECT count(*) FROM (VALUES ('hsbc_p1_api'),('hsbc_p1_worker'),('hsbc_p1_checkpoint')) r(role) WHERE has_table_privilege(r.role,'business.model_call_accounting_archives','SELECT,INSERT,UPDATE,DELETE')",
    }
    for name, column in [('budget_reservations','reserved_micros'),('budget_charges','charged_micros')]:
        checks[name] = "SELECT count(*) FROM business.model_budgets b WHERE b." + column + " IS DISTINCT FROM (SELECT COALESCE(sum(c." + column + "),0) FROM (" + amounts + ") c WHERE c.profile_id=b.profile_id AND c.budget_day=b.budget_day)"
    return checks


def p3_reference_checks(assistant=False):
    checks = {
        'draft_creation_receipt': "SELECT count(*) FROM business.case_drafts d LEFT JOIN business.cases c ON c.id=d.created_case_id WHERE (d.status='created') IS DISTINCT FROM (d.created_case_id IS NOT NULL) OR (d.created_case_id IS NOT NULL AND (c.id IS NULL OR c.created_by<>d.owner_person_id OR c.created_from_draft_id IS DISTINCT FROM d.id))",
        'case_origin': "SELECT count(*) FROM business.cases c LEFT JOIN business.case_drafts d ON d.id=c.created_from_draft_id WHERE c.created_from_draft_id IS NOT NULL AND (d.id IS NULL OR d.status<>'created' OR d.created_case_id IS DISTINCT FROM c.id OR c.created_by<>d.owner_person_id)",
        'draft_field_provenance': "SELECT count(*) FROM business.case_drafts d CROSS JOIN LATERAL jsonb_each(d.field_sources) f LEFT JOIN auth.accounts a ON a.id::text=f.value->>'accountId' LEFT JOIN business.intake_turns t ON t.id::text=f.value->>'turnId' LEFT JOIN business.intake_candidates c ON c.id::text=f.value->>'candidateId' WHERE f.key NOT IN ('scenario','title','reference','background') OR f.value->>'kind' IS NULL OR f.value->>'kind' NOT IN ('system_default','manual','suggestion') OR (f.value->>'kind' IN ('manual','suggestion') AND (a.id IS NULL OR a.person_id<>d.owner_person_id OR f.value->>'personId' IS DISTINCT FROM d.owner_person_id::text)) OR (f.value->>'kind'='suggestion' AND (t.id IS NULL OR t.draft_id<>d.id OR t.owner_person_id<>d.owner_person_id OR c.id IS NULL OR c.turn_id<>t.id OR c.field<>f.key OR d.fields->>f.key IS DISTINCT FROM c.value))",
        'turn_draft_owner': "SELECT count(*) FROM business.intake_turns t LEFT JOIN business.case_drafts d ON d.id=t.draft_id LEFT JOIN auth.accounts a ON a.id=t.account_id WHERE d.id IS NULL OR a.id IS NULL OR t.owner_person_id<>d.owner_person_id OR a.person_id<>t.owner_person_id OR t.draft_revision>d.revision",
        'turn_session_scope': "SELECT count(*) FROM business.intake_turns t LEFT JOIN business.model_session_grants s ON s.session_key=t.session_key WHERE (t.session_key IS NOT NULL AND (s.session_key IS NULL OR s.account_id<>t.account_id OR s.person_id<>t.owner_person_id OR s.auth_version<>t.auth_version)) OR (t.status IN ('pending','running') AND t.session_key IS NULL)",
        'candidate_turn_scope': "SELECT count(*) FROM business.intake_candidates c LEFT JOIN business.intake_turns t ON t.id=c.turn_id WHERE t.id IS NULL",
        'selected_candidate_scope': "SELECT count(*) FROM business.intake_turns t CROSS JOIN LATERAL unnest(t.selected_candidate_ids) selected(id) LEFT JOIN business.intake_candidates c ON c.id=selected.id WHERE c.id IS NULL OR c.turn_id<>t.id",
        'event_turn_scope': "SELECT count(*) FROM business.intake_events e LEFT JOIN business.intake_turns t ON t.id=e.turn_id WHERE t.id IS NULL",
        'call_turn_scope': "SELECT count(*) FROM business.model_calls c LEFT JOIN business.intake_turns t ON t.id=c.turn_id WHERE t.id IS NULL OR c.task_type<>'draft_intake' OR jsonb_typeof(c.projection) IS DISTINCT FROM 'object' OR jsonb_typeof(c.projection->'candidates') IS DISTINCT FROM 'array'",
        'projection_candidate_scope': "SELECT count(*) FROM business.model_calls m CROSS JOIN LATERAL jsonb_array_elements(m.projection->'candidates') selected LEFT JOIN business.intake_candidates c ON c.id::text=selected->>'candidateId' WHERE c.id IS NULL OR c.turn_id<>m.turn_id OR c.field IS DISTINCT FROM selected->>'field'",
        'model_work_owner': "SELECT count(*) FROM business.work_items w LEFT JOIN business.model_calls c ON c.id=w.owner_id WHERE w.owner_type='ModelCall' AND (c.id IS NULL OR w.kind<>'draft_intake' OR w.queue<>CASE c.profile_id WHEN 'cloud_assistant' THEN 'model-cloud' ELSE 'model-local' END)",
        'call_work_reference': "SELECT count(*) FROM business.model_calls c WHERE NOT EXISTS(SELECT 1 FROM business.work_items w WHERE w.owner_type='ModelCall' AND w.owner_id=c.id)",
        'egress_call_scope': "SELECT count(*) FROM business.model_egress_receipts e LEFT JOIN business.model_calls c ON c.id=e.call_id WHERE c.id IS NULL OR c.profile_id<>'cloud_assistant' OR e.payload_hash !~ '^[a-f0-9]{64}$' OR (e.decision='approved' AND e.payload_hash IS DISTINCT FROM c.payload_hash) OR e.policy_version IS DISTINCT FROM c.policy_version OR e.provider<>'azure-openai' OR e.endpoint='' OR jsonb_typeof(e.data_classes) IS DISTINCT FROM 'array'",
        'sent_cloud_egress_receipt': "SELECT count(*) FROM business.model_calls c WHERE c.profile_id='cloud_assistant' AND c.sent_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM business.model_egress_receipts e WHERE e.call_id=c.id AND e.decision='approved' AND e.payload_hash=c.payload_hash AND e.policy_version=c.policy_version AND e.created_at<=c.sent_at)",
        'call_budget_reference': "SELECT count(*) FROM business.model_calls c LEFT JOIN business.model_budgets b ON b.profile_id=c.profile_id AND b.budget_day=c.budget_day WHERE (c.reserved_micros>0 OR COALESCE(c.charged_micros,0)>0) AND (c.budget_day IS NULL OR b.profile_id IS NULL)",
        'budget_reservations': "SELECT count(*) FROM business.model_budgets b WHERE b.reserved_micros IS DISTINCT FROM (SELECT COALESCE(sum(c.reserved_micros),0) FROM business.model_calls c WHERE c.profile_id=b.profile_id AND c.budget_day=b.budget_day)",
        'budget_charges': "SELECT count(*) FROM business.model_budgets b WHERE b.charged_micros IS DISTINCT FROM (SELECT COALESCE(sum(c.charged_micros),0) FROM business.model_calls c WHERE c.profile_id=b.profile_id AND c.budget_day=b.budget_day)",
        'uncertain_call_reservation': "SELECT count(*) FROM business.model_calls WHERE state IN ('sent','unknown') AND (sent_at IS NULL OR reserved_micros<=0)",
        'fixture_owner': "SELECT count(*) FROM business.model_fixture_grants g LEFT JOIN business.case_drafts d ON d.id=g.draft_id WHERE d.id IS NULL OR g.owner_person_id<>d.owner_person_id",
    }

    if assistant:
        checks.update(assistant_reference_checks(checks))
    return checks


def attachment_reference_checks():
    return {
        'draft_upload_owner': "SELECT count(*) FROM business.upload_sessions u LEFT JOIN business.case_drafts d ON d.id=u.draft_id LEFT JOIN auth.accounts a ON a.id=u.account_id WHERE u.draft_id IS NOT NULL AND (d.id IS NULL OR u.case_id IS NOT NULL OR a.id IS NULL OR a.person_id<>u.person_id OR d.owner_person_id<>u.person_id OR (u.state='registered' AND NOT EXISTS(SELECT 1 FROM business.draft_attachments f WHERE f.id=u.id AND f.draft_id=d.id)))",
        'draft_attachment_registration': "SELECT count(*) FROM business.draft_attachments a LEFT JOIN business.upload_sessions u ON u.id=a.id LEFT JOIN business.case_drafts d ON d.id=a.draft_id LEFT JOIN business.document_versions v ON v.id=a.created_case_material_id WHERE u.id IS NULL OR d.id IS NULL OR u.person_id<>d.owner_person_id OR u.state<>'registered' OR u.oss_version_id IS NULL OR u.oss_version_id IN ('','null') OR (a.state<>'adopted' AND (u.draft_id IS DISTINCT FROM a.draft_id OR u.case_id IS NOT NULL)) OR (a.state='adopted' AND (v.id IS NULL OR d.status<>'created' OR d.created_case_id IS DISTINCT FROM v.case_id OR u.case_id IS DISTINCT FROM v.case_id OR u.draft_id IS NOT NULL OR u.document_version_id IS DISTINCT FROM v.id OR v.upload_session_id<>a.id OR v.sha256<>a.sha256))",
        'draft_attachment_parse_state': "SELECT count(*) FROM business.draft_attachments WHERE parse_epoch<0 OR (parse_state='running' AND (state<>'active' OR parse_lease_until IS NULL)) OR (parse_state<>'running' AND parse_lease_until IS NOT NULL) OR (parse_state='ready' AND (parser_version IS NULL OR jsonb_typeof(extraction_result) IS DISTINCT FROM 'object' OR jsonb_typeof(extraction_result->'blocks') IS DISTINCT FROM 'array' OR jsonb_typeof(extraction_result->'coverageGaps') IS DISTINCT FROM 'array'))",
        'draft_attachment_extraction_sources': "SELECT count(*) FROM business.draft_attachments a CROSS JOIN LATERAL jsonb_array_elements(a.extraction_result->'blocks') b WHERE b->'source'->>'attachmentId' IS DISTINCT FROM a.id::text OR b->'source'->>'sha256' IS DISTINCT FROM a.sha256 OR jsonb_typeof(b->'text') IS DISTINCT FROM 'string' OR b->>'id' IS NULL OR b->>'id' NOT LIKE a.id::text||':%'",
    }


def assistant_privacy_coverage_valid(context_ids):
    """A correlated SQL predicate: no source text or private IDs leave PostgreSQL."""
    withheld = "(CASE WHEN jsonb_typeof(p.projection->'withheldSources')='array' THEN p.projection->'withheldSources' ELSE '[]'::jsonb END)"
    selected = f"{context_ids} ? a.id::text AND a.draft_id=t.draft_id"
    # Match ECMAScript trim(), including its Unicode whitespace and BOM, rather
    # than accepting an attachment whose only retained characters are whitespace.
    whitespace = r"U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'"
    return f"""(CASE WHEN NOT(p.projection ? 'withheldSources') THEN
      NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.projection->'blocks') marker WHERE marker->>'id'='privacy:withheld')
    ELSE jsonb_typeof(p.projection->'withheldSources') IS NOT DISTINCT FROM 'array'
      AND jsonb_array_length({withheld}) BETWEEN 1 AND 256
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements({withheld}) w WHERE
        jsonb_typeof(w->'sourceRef') IS DISTINCT FROM 'string' OR length(w->>'sourceRef') NOT BETWEEN 1 AND 160
        OR w->>'sourceRef' !~ '^[a-zA-Z0-9_.:-]+$'
        OR jsonb_typeof(w->'reason') IS DISTINCT FROM 'string'
        OR COALESCE(w->>'reason','') NOT IN ('source_validation_failed','output_truncated','ner_source_validation_failed')
        OR w IS DISTINCT FROM jsonb_build_object('sourceRef',w->'sourceRef','reason',w->'reason')
        OR (SELECT count(*) FROM jsonb_array_elements({withheld}) other WHERE other->>'sourceRef'=w->>'sourceRef')<>1
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(p.projection->'blocks') kept WHERE kept->>'id'=w->>'sourceRef')
        OR NOT EXISTS(SELECT 1 FROM business.draft_attachments a CROSS JOIN LATERAL jsonb_array_elements(a.extraction_result->'blocks') source
          WHERE {selected} AND source->>'id'=w->>'sourceRef'))
      AND (SELECT count(*) FROM jsonb_array_elements(p.projection->'blocks') marker WHERE marker->>'id'='privacy:withheld')=1
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.projection->'blocks') marker WHERE marker=jsonb_build_object(
        'id','privacy:withheld','text','有 '||jsonb_array_length({withheld})::text||' 段附件内容未通过隐私处理，原文未提供，不得推断其内容或用于填表。'))
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(t.input_snapshot->'blocks') source WHERE source->>'id'='privacy:withheld')
      AND NOT EXISTS(SELECT 1 FROM business.draft_attachments a CROSS JOIN LATERAL jsonb_array_elements(a.extraction_result->'blocks') source
        WHERE {selected} AND source->>'id'='privacy:withheld')
      AND EXISTS(SELECT 1 FROM business.draft_attachments a CROSS JOIN LATERAL jsonb_array_elements(a.extraction_result->'blocks') source
        WHERE {selected} AND btrim(source->>'text',{whitespace})<>''
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.projection->'blocks') kept WHERE kept->>'id'=source->>'id'))
    END)"""


def assistant_reference_checks(legacy):
    """Migration 032 is additive: v1 calls keep their original graph and receipts."""
    provenance = legacy['draft_field_provenance'].replace("'manual','suggestion'", "'manual','suggestion','assistant'").replace("f.value->>'kind'='suggestion'", "f.value->>'kind' IN ('suggestion','assistant')")
    # Older v2 snapshots predate cumulative attachment context. Their explicitly
    # selected IDs remain the complete source set; a new snapshot binds its own set.
    context_ids = "COALESCE(t.input_snapshot->'contextAttachmentIds',to_jsonb(t.attachment_ids))"
    privacy_coverage = assistant_privacy_coverage_valid(context_ids)
    checks = {
        'draft_field_provenance': provenance,
        'assistant_field_provenance': "SELECT count(*) FROM business.case_drafts d CROSS JOIN LATERAL jsonb_each(d.field_sources) f LEFT JOIN business.intake_turns t ON t.id::text=f.value->>'turnId' LEFT JOIN business.intake_candidates c ON c.id::text=f.value->>'candidateId' LEFT JOIN business.intake_autofill_receipts r ON r.turn_id=t.id WHERE f.value->>'kind'='assistant' AND (t.protocol_version IS DISTINCT FROM 2 OR r.turn_id IS NULL OR r.undone_at IS NOT NULL OR NOT(f.key=ANY(r.applied_fields)) OR f.value->'sourceRefs' IS DISTINCT FROM c.source_refs)",
        'call_turn_scope': "SELECT count(*) FROM business.model_calls c LEFT JOIN business.intake_turns t ON t.id=c.turn_id WHERE t.id IS NULL OR c.task_type<>'draft_intake' OR jsonb_typeof(c.projection) IS DISTINCT FROM 'object' OR (t.protocol_version=1 AND (c.step_key<>'legacy' OR c.parent_call_id IS NOT NULL OR jsonb_typeof(c.projection->'candidates') IS DISTINCT FROM 'array')) OR (t.protocol_version=2 AND (c.step_key NOT IN ('prepare','redact','assistant') OR (c.step_key IN ('prepare','redact') AND c.profile_id<>'local_intake') OR (c.step_key='assistant' AND c.profile_id<>'cloud_assistant')))",
        'projection_candidate_scope': "SELECT count(*) FROM business.model_calls m JOIN business.intake_turns t ON t.id=m.turn_id CROSS JOIN LATERAL jsonb_array_elements(m.projection->'candidates') selected LEFT JOIN business.intake_candidates c ON c.id::text=selected->>'candidateId' WHERE t.protocol_version=1 AND (c.id IS NULL OR c.turn_id<>m.turn_id OR c.field IS DISTINCT FROM selected->>'field')",
        'call_work_reference': "SELECT count(*) FROM business.model_calls c WHERE (c.parent_call_id IS NULL AND NOT EXISTS(SELECT 1 FROM business.work_items w WHERE w.owner_type='ModelCall' AND w.owner_id=c.id)) OR (c.parent_call_id IS NOT NULL AND EXISTS(SELECT 1 FROM business.work_items w WHERE w.owner_type='ModelCall' AND w.owner_id=c.id))",
        'assistant_call_parent': "SELECT count(*) FROM business.model_calls c LEFT JOIN business.model_calls p ON p.id=c.parent_call_id JOIN business.intake_turns t ON t.id=c.turn_id WHERE t.protocol_version=2 AND ((c.step_key='redact' AND (p.id IS NULL OR p.turn_id<>c.turn_id OR p.step_key<>'prepare' OR p.profile_id<>'local_intake' OR p.parent_call_id IS NOT NULL)) OR (c.step_key<>'redact' AND (c.parent_call_id IS NOT NULL OR c.call_index<>0)))",
        'assistant_call_projection': "SELECT count(*) FROM business.model_calls c JOIN business.intake_turns t ON t.id=c.turn_id LEFT JOIN business.intake_private_projections p ON p.turn_id=c.turn_id WHERE t.protocol_version=2 AND ((c.step_key='assistant' AND (p.turn_id IS NULL OR c.projection->>'version' IS DISTINCT FROM 'draft_intake_v2' OR c.projection->>'projectionRef' IS DISTINCT FROM t.id::text)) OR (c.step_key='prepare' AND c.state='completed' AND (p.turn_id IS NULL OR c.result->>'projectionRef' IS DISTINCT FROM t.id::text)))",
        'assistant_private_projection': "SELECT count(*) FROM business.intake_private_projections p LEFT JOIN business.intake_turns t ON t.id=p.turn_id WHERE t.id IS NULL OR t.protocol_version<>2 OR p.draft_id<>t.draft_id OR p.projection->>'scopeId' IS DISTINCT FROM p.draft_id::text OR p.projection->>'version' IS DISTINCT FROM 'draft_intake_v2' OR COALESCE(p.projection->>'redactionVersion','') NOT IN ('intake-redaction-v1','intake-redaction-v2') OR COALESCE(p.projection->>'sourceManifestHash','') !~ '^[a-f0-9]{64}$' OR jsonb_typeof(p.projection->'blocks') IS DISTINCT FROM 'array' OR jsonb_typeof(p.projection->'replacements') IS DISTINCT FROM 'array'",
        'assistant_projection_blocks': "SELECT count(*) FROM business.intake_private_projections p CROSS JOIN LATERAL jsonb_array_elements(p.projection->'blocks') b WHERE jsonb_typeof(b->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(b->'text') IS DISTINCT FROM 'string' OR (SELECT count(*) FROM jsonb_array_elements(p.projection->'blocks') other WHERE other->>'id'=b->>'id')<>1",
        'assistant_projection_withheld': f"SELECT count(*) FROM business.intake_private_projections p JOIN business.intake_turns t ON t.id=p.turn_id WHERE NOT {privacy_coverage}",
        'assistant_projection_source_scope': f"SELECT count(*) FROM business.intake_private_projections p JOIN business.intake_turns t ON t.id=p.turn_id CROSS JOIN LATERAL jsonb_array_elements(p.projection->'blocks') b WHERE (b->>'id'='privacy:withheld' AND NOT {privacy_coverage}) OR (b->>'id' NOT IN ('coverage:attachments','privacy:withheld') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(t.input_snapshot->'blocks') source WHERE source->>'id'=b->>'id') AND NOT EXISTS(SELECT 1 FROM business.draft_attachments a CROSS JOIN LATERAL jsonb_array_elements(a.extraction_result->'blocks') source WHERE {context_ids} ? a.id::text AND a.draft_id=t.draft_id AND source->>'id'=b->>'id'))",
        'assistant_projection_replacements': "SELECT count(*) FROM business.intake_private_projections p CROSS JOIN LATERAL jsonb_array_elements(p.projection->'replacements') r WHERE jsonb_typeof(r->'original') IS DISTINCT FROM 'string' OR COALESCE(r->>'original','')='' OR COALESCE(r->>'kind','') NOT IN ('person','organization','account','identity','contact','address','reference','asset','secret','link') OR COALESCE(r->>'placeholder','') !~ '^\\[\\[P_[A-Z]+_[a-f0-9]{20}\\]\\]$' OR (SELECT count(*) FROM jsonb_array_elements(p.projection->'replacements') other WHERE other->>'placeholder'=r->>'placeholder')<>1",
        'assistant_turn_attachments': "SELECT count(*) FROM business.intake_turns t CROSS JOIN LATERAL unnest(t.attachment_ids) selected(id) LEFT JOIN business.draft_attachments a ON a.id=selected.id WHERE t.protocol_version<>2 OR a.id IS NULL OR a.draft_id<>t.draft_id",
        'assistant_context_attachments': f"SELECT count(*) FROM business.intake_turns t CROSS JOIN LATERAL jsonb_array_elements({context_ids}) selected(value) LEFT JOIN business.draft_attachments a ON a.id::text=(selected.value #>> '{{}}') WHERE t.protocol_version<>2 OR jsonb_typeof(selected.value)<>'string' OR a.id IS NULL OR a.draft_id<>t.draft_id OR NOT EXISTS(SELECT 1 FROM business.intake_turns prior WHERE prior.draft_id=t.draft_id AND a.id=ANY(prior.attachment_ids) AND (prior.id=t.id OR (prior.status='ready' AND prior.created_at<=t.created_at)))",
        'assistant_context_selection': f"SELECT count(*) FROM business.intake_turns t WHERE t.protocol_version=2 AND (jsonb_array_length({context_ids})<>(SELECT count(DISTINCT value) FROM jsonb_array_elements({context_ids})) OR EXISTS(SELECT 1 FROM unnest(t.attachment_ids) selected(id) WHERE NOT({context_ids} ? selected.id::text)))",
        'assistant_turn_shape': "SELECT count(*) FROM business.intake_turns t JOIN business.case_drafts d ON d.id=t.draft_id WHERE t.protocol_version=2 AND (jsonb_typeof(t.input_snapshot->'blocks') IS DISTINCT FROM 'array' OR (t.input_snapshot ? 'contextAttachmentIds' AND jsonb_typeof(t.input_snapshot->'contextAttachmentIds') IS DISTINCT FROM 'array') OR jsonb_typeof(t.reply_blocks) IS DISTINCT FROM 'array' OR jsonb_typeof(t.assistant_questions) IS DISTINCT FROM 'array' OR t.result_revision>d.revision OR (t.status='ready' AND t.result_revision IS NULL))",
        'assistant_candidate_sources': "SELECT count(*) FROM business.intake_candidates c JOIN business.intake_turns t ON t.id=c.turn_id LEFT JOIN business.intake_private_projections p ON p.turn_id=t.id WHERE t.protocol_version=2 AND (p.turn_id IS NULL OR jsonb_typeof(c.source_refs) IS DISTINCT FROM 'array' OR c.source_refs='[]'::jsonb OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(c.source_refs) ref WHERE ref='privacy:withheld' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.projection->'blocks') b WHERE b->>'id'=ref)))",
        'assistant_reply_sources': "SELECT count(*) FROM business.intake_turns t LEFT JOIN business.intake_private_projections p ON p.turn_id=t.id CROSS JOIN LATERAL jsonb_array_elements(t.reply_blocks) b WHERE t.protocol_version=2 AND (jsonb_typeof(b->'sourceRefs') IS DISTINCT FROM 'array' OR jsonb_typeof(b->'text') IS DISTINCT FROM 'string' OR jsonb_typeof(b->'id') IS DISTINCT FROM 'string' OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(b->'sourceRefs') ref WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.projection->'blocks') source WHERE source->>'id'=ref)))",
        'assistant_autofill_receipt': "SELECT count(*) FROM business.intake_autofill_receipts r LEFT JOIN business.intake_turns t ON t.id=r.turn_id LEFT JOIN business.case_drafts d ON d.id=r.draft_id WHERE t.id IS NULL OR d.id IS NULL OR t.protocol_version<>2 OR t.draft_id<>r.draft_id OR t.status<>'ready' OR r.result_revision IS DISTINCT FROM t.result_revision OR r.result_revision>d.revision OR r.result_revision<t.draft_revision OR r.applied_fields IS DISTINCT FROM t.applied_fields OR jsonb_typeof(r.before_fields) IS DISTINCT FROM 'object' OR jsonb_typeof(r.before_states) IS DISTINCT FROM 'object' OR jsonb_typeof(r.before_sources) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM unnest(r.applied_fields) field WHERE NOT EXISTS(SELECT 1 FROM business.intake_candidates c WHERE c.turn_id=r.turn_id AND c.field=field))",
    }
    return checks


REVIEW_TABLES = ['review_config_drafts', 'review_config_revisions', 'review_config_trials', 'review_config_approvals', 'review_config_releases', 'review_object_versions', 'review_fact_versions', 'review_material_events', 'review_runs', 'review_findings', 'review_issues', 'review_events', 'review_document_receipts', 'field_filter_calls', 'review_supplements', 'review_supplement_gaps']
DOCUMENT_MODEL_TABLES = ['document_model_snapshots', 'document_model_calls']
DOCUMENT_ACCOUNTING_TABLES = ['document_model_prices', 'document_model_charges']


def document_privacy_reference_checks(table='business.document_model_snapshots', prefix='document_private'):
    """Check private receipt integrity, not a substitute for the outbound gate.

    Public, digest-pinned blocks may have no sourceCoverage entry. Reconstructing
    original text and checking every source interval remains the runtime's job.
    """
    def array(value):
        return f"(CASE WHEN jsonb_typeof({value})='array' THEN {value} ELSE '[]'::jsonb END)"
    def object_value(value):
        return f"(CASE WHEN jsonb_typeof({value})='object' THEN {value} ELSE '{{}}'::jsonb END)"
    def exact_object(value, required, optional=()):
        keys = ','.join(f"'{key}',{value}->'{key}'" for key in required)
        stripped = object_value(value)
        if optional:
            stripped += " - ARRAY[" + ','.join(f"'{key}'" for key in optional) + "]"
        return f"(jsonb_typeof({value})='object' AND ({stripped})=jsonb_build_object({keys}))"
    def utf16_length(value):
        # Zod lengths and persisted source ranges use JavaScript UTF-16 units.
        # PostgreSQL length counts code points, so supplementary points add one.
        return f"(length({value})+length(regexp_replace({value},U&'[^\\+010000-\\+10FFFF]','','g')))"
    def string_valid(value, minimum, maximum, pattern=None):
        text_value = f"({value} #>> '{{}}')"
        condition = f"{utf16_length(text_value)} BETWEEN {minimum} AND {maximum}"
        if pattern:
            condition += f" AND ({value} #>> '{{}}') ~ '{pattern}'"
        return f"(CASE WHEN jsonb_typeof({value})='string' THEN {condition} ELSE false END)"
    def hash_valid(value):
        return string_valid(value, 64, 64, '^[a-f0-9]{64}$')
    def ref_valid(value):
        return string_valid(value, 1, 160, '^[a-zA-Z0-9_.:-]+$')
    def utf16_slice(value, start, end):
        # Include only complete code points. A half-surrogate interval cannot
        # manufacture a matching substring from the persisted proof.
        return f"""(SELECT coalesce(string_agg(piece,'' ORDER BY ordinal),'')
          FROM (SELECT piece,ordinal,CASE WHEN ascii(piece)>65535 THEN 2 ELSE 1 END width,
            sum(CASE WHEN ascii(piece)>65535 THEN 2 ELSE 1 END) OVER(ORDER BY ordinal) stop
            FROM regexp_split_to_table({value},'') WITH ORDINALITY chars(piece,ordinal)) points
          WHERE stop-width>=({start}) AND stop<=({end}))"""
    blocks = array("s.projection->'blocks'")
    replacements = array("s.projection->'replacements'")
    coverage = array("s.projection->'sourceCoverage'")
    masks = array("c->'masks'")
    # Numeric casts use CASE so malformed backup values cannot turn an unknown
    # range into a valid NULL comparison.
    def range_valid(value):
        return f"""(CASE WHEN jsonb_typeof({value}->'start')='number'
          AND jsonb_typeof({value}->'end')='number' THEN
          ({value}->>'start')::numeric>=0
          AND ({value}->>'end')::numeric>({value}->>'start')::numeric
          AND ({value}->>'end')::numeric<=9007199254740991
          AND trunc(({value}->>'start')::numeric)=({value}->>'start')::numeric
          AND trunc(({value}->>'end')::numeric)=({value}->>'end')::numeric
          ELSE false END)"""
    def number(value, key):
        return f"({value}->>'{key}')::numeric"
    proof, source, prior_mask = "(r->'fragmentOf')", "(r->'source')", "(r->'fragmentOf'->'priorMask')"
    placeholder_pattern = r'^\[\[P_[A-Z]+_[a-f0-9]{20}\]\]$'
    word_start, word_end = number(proof, 'start'), number(proof, 'end')
    source_start, source_end = number(source, 'start'), number(source, 'end')
    prior_start, prior_end = number(prior_mask, 'start'), number(prior_mask, 'end')
    overlap_start, overlap_end = f"greatest({word_start},{prior_start})", f"least({word_end},{prior_end})"
    # Alias hashing follows the writer's explicit JSON.stringify field order;
    # canonical JSON sorts keys differently and must not be substituted here.
    source_json = f"""('{{"sourceRef":'||({source}->'sourceRef')::text||
      ',"sourceSha256":'||({source}->'sourceSha256')::text||
      ',"start":'||({source_start})::bigint::text||',"end":'||({source_end})::bigint::text||'}}')"""
    fragment_json = f"""('{{"text":'||({proof}->'text')::text||
      ',"start":'||({word_start})::bigint::text||',"end":'||({word_end})::bigint::text||
      ',"priorMask":{{"start":'||({prior_start})::bigint::text||',"end":'||({prior_end})::bigint::text||
      ',"placeholder":'||({prior_mask}->'placeholder')::text||'}}}}')"""
    alias_json = f"""('['||(s.projection->'scopeId')::text||','||(r->'kind')::text||','||
      {source_json}||','||(r->'original')::text||
      CASE WHEN r ? 'fragmentOf' THEN ','||{fragment_json} ELSE '' END||']')"""
    alias_valid = f"""CASE WHEN {range_valid(source)}
      AND (NOT(r ? 'fragmentOf') OR ({range_valid(proof)} AND {range_valid(prior_mask)}))
      THEN r->>'placeholder' IS NOT DISTINCT FROM
        ('[[P_'||upper(r->>'kind')||'_'||substr(encode(sha256(convert_to({alias_json},'UTF8')),'hex'),1,20)||']]')
      ELSE false END"""
    return {
        f'{prefix}_projection_shape': f"""SELECT count(*) FROM {table} s
          WHERE NOT {exact_object('s.projection', ['version', 'scopeId', 'sourceManifestHash', 'redactionVersion', 'blocks', 'replacements'], ['sourceCoverage'])}
          OR s.projection->>'version' IS DISTINCT FROM 'draft_intake_v2'
          OR NOT {string_valid("s.projection->'scopeId'", 1, 200)}
          OR coalesce(s.projection->>'redactionVersion','') NOT IN
            ('intake-redaction-v1','intake-redaction-v2','intake-redaction-v3','intake-redaction-v4','intake-redaction-v5','intake-redaction-v6','intake-redaction-v7','intake-redaction-v8')
          OR NOT {hash_valid("s.projection->'sourceManifestHash'")}
          OR jsonb_typeof(s.projection->'blocks') IS DISTINCT FROM 'array'
          OR jsonb_array_length({blocks}) NOT BETWEEN 1 AND 256
          OR jsonb_typeof(s.projection->'replacements') IS DISTINCT FROM 'array'
          OR jsonb_array_length({replacements})>4096
          OR EXISTS(SELECT 1 FROM jsonb_array_elements({blocks}) b
            WHERE NOT {exact_object('b', ['id', 'text'])}
              OR NOT {ref_valid("b->'id'")} OR NOT {string_valid("b->'text'", 0, 200000)}
              OR (SELECT count(*) FROM jsonb_array_elements({blocks}) other WHERE other->>'id'=b->>'id')<>1)
          OR EXISTS(SELECT 1 FROM jsonb_array_elements({replacements}) r
            WHERE NOT {exact_object('r', ['placeholder', 'original', 'kind'], ['source', 'fragmentOf'])}
              OR NOT {string_valid("r->'original'", 1, 2000)}
              OR coalesce(r->>'kind','') NOT IN ('person','organization','account','identity','contact','address','reference','asset','secret','link')
              OR coalesce(r->>'placeholder','') !~ '^\\[\\[P_[A-Z]+_[a-f0-9]{{20}}\\]\\]$'
              OR (SELECT count(*) FROM jsonb_array_elements({replacements}) other WHERE other->>'placeholder'=r->>'placeholder')<>1)
          OR (s.projection->>'redactionVersion' NOT IN ('intake-redaction-v3','intake-redaction-v4','intake-redaction-v5','intake-redaction-v6','intake-redaction-v7','intake-redaction-v8')
            AND (s.projection ? 'sourceCoverage' OR EXISTS(SELECT 1 FROM jsonb_array_elements({replacements}) r WHERE r ? 'source' OR r ? 'fragmentOf')))
          OR EXISTS(SELECT 1 FROM jsonb_array_elements({replacements}) r WHERE r ? 'fragmentOf' AND NOT(r ? 'source'))""",
        f'{prefix}_source_coverage': f"""SELECT count(*) FROM {table} s
          WHERE s.projection->>'redactionVersion' IN ('intake-redaction-v3','intake-redaction-v4','intake-redaction-v5','intake-redaction-v6','intake-redaction-v7','intake-redaction-v8') AND (
            jsonb_typeof(s.projection->'sourceCoverage') IS DISTINCT FROM 'array'
            OR jsonb_array_length({coverage})>256
            OR EXISTS(SELECT 1 FROM jsonb_array_elements({coverage}) c
              WHERE NOT {exact_object('c', ['sourceRef', 'sourceSha256', 'redactedSha256', 'masks'])}
                OR NOT {ref_valid("c->'sourceRef'")}
                OR NOT {hash_valid("c->'sourceSha256'")}
                OR NOT {hash_valid("c->'redactedSha256'")}
                OR (SELECT count(*) FROM jsonb_array_elements({coverage}) other WHERE other->>'sourceRef'=c->>'sourceRef')<>1
                OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements({blocks}) b WHERE b->>'id'=c->>'sourceRef'
                  AND encode(sha256(convert_to(b->>'text','UTF8')),'hex')=c->>'redactedSha256')
                OR jsonb_typeof(c->'masks') IS DISTINCT FROM 'array'
                OR jsonb_array_length({masks})>100000
                OR EXISTS(SELECT 1 FROM jsonb_array_elements({masks}) m
                  WHERE NOT {exact_object('m', ['start', 'end'])}
                    OR NOT {range_valid('m')})))""",
        f'{prefix}_scoped_replacements': f"""SELECT count(*) FROM {table} s
          CROSS JOIN LATERAL jsonb_array_elements({replacements}) r
          WHERE r ? 'source' AND (
            coalesce(s.projection->>'redactionVersion','') NOT IN ('intake-redaction-v3','intake-redaction-v4','intake-redaction-v5','intake-redaction-v6','intake-redaction-v7','intake-redaction-v8')
            OR NOT {exact_object("(r->'source')", ['sourceRef', 'sourceSha256', 'start', 'end'])}
            OR NOT {ref_valid("r->'source'->'sourceRef'")}
            OR NOT {hash_valid("r->'source'->'sourceSha256'")}
            OR NOT {range_valid("(r->'source')")}
            OR NOT ({alias_valid})
            OR CASE WHEN {range_valid("(r->'source')")}
              THEN (r->'source'->>'end')::numeric-(r->'source'->>'start')::numeric
                IS DISTINCT FROM {utf16_length("r->>'original'")} ELSE true END
            OR EXISTS(SELECT 1 FROM jsonb_array_elements({blocks}) b
              WHERE b->>'id' IS DISTINCT FROM r->'source'->>'sourceRef'
                AND strpos(b->>'text',r->>'placeholder')>0)
            OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements({coverage}) c
              WHERE c->>'sourceRef'=r->'source'->>'sourceRef'
                AND c->>'sourceSha256'=r->'source'->>'sourceSha256'
                AND EXISTS(SELECT 1 FROM jsonb_array_elements({masks}) m
                  WHERE CASE WHEN {range_valid('m')} AND {range_valid("(r->'source')")}
                    THEN (m->>'start')::numeric<=(r->'source'->>'start')::numeric
                      AND (m->>'end')::numeric>=(r->'source'->>'end')::numeric ELSE false END))
            OR (r ? 'fragmentOf' AND (
              NOT {exact_object(proof, ['text', 'start', 'end', 'priorMask'])}
              OR NOT {string_valid(f"{proof}->'text'", 1, 2000)}
              OR NOT {exact_object(prior_mask, ['start', 'end', 'placeholder'])}
              OR NOT {string_valid(f"{prior_mask}->'placeholder'", 1, 100, placeholder_pattern)}
              OR CASE WHEN {range_valid(source)} AND {range_valid(proof)} AND {range_valid(prior_mask)}
                THEN {word_end}-{word_start} IS DISTINCT FROM {utf16_length(f"{proof}->>'text'")}
                  OR {source_start}<{word_start} OR {source_end}>{word_end}
                  OR ({source_start}={word_start} AND {source_end}={word_end})
                  OR {utf16_slice(f"{proof}->>'text'", f"{source_start}-{word_start}", f"{source_end}-{word_start}")} IS DISTINCT FROM r->>'original'
                  OR {prior_start}>={word_end} OR {prior_end}<={word_start}
                  OR ({prior_start}<{source_end} AND {prior_end}>{source_start})
                  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements({replacements}) previous
                    WHERE previous->>'placeholder'={prior_mask}->>'placeholder'
                      AND previous->>'placeholder'<>r->>'placeholder' AND NOT(previous ? 'fragmentOf')
                      AND {prior_end}-{prior_start}={utf16_length("previous->>'original'")}
                      AND (NOT(previous ? 'source') OR
                        (previous->'source'->>'sourceRef'={source}->>'sourceRef'
                          AND previous->'source'->>'sourceSha256'={source}->>'sourceSha256'
                          AND previous->'source'->'start'={prior_mask}->'start'
                          AND previous->'source'->'end'={prior_mask}->'end'))
                      AND {utf16_slice(f"{proof}->>'text'", f"{overlap_start}-{word_start}", f"{overlap_end}-{word_start}")}
                        ={utf16_slice("previous->>'original'", f"{overlap_start}-{prior_start}", f"{overlap_end}-{prior_start}")})
                  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements({coverage}) c
                    WHERE c->>'sourceRef'={source}->>'sourceRef'
                      AND EXISTS(SELECT 1 FROM jsonb_array_elements({masks}) m
                        WHERE CASE WHEN {range_valid('m')}
                          THEN (m->>'start')::numeric<={prior_start} AND (m->>'end')::numeric>={prior_end}
                          ELSE false END))
                ELSE true END)))""",
    }


def document_classification_reference_checks():
    return {
        **document_privacy_reference_checks('business.document_classification_inputs', 'document_classification_private'),
        'document_classification_input_scope': "SELECT count(*) FROM business.document_classification_inputs s LEFT JOIN business.document_jobs j ON j.id=s.job_id WHERE j.id IS NULL OR j.kind<>'parse_document' OR s.input_hash!~'^[a-f0-9]{64}$' OR s.projection->>'scopeId' IS DISTINCT FROM (j.document_version_id::text||':'||j.id::text) OR s.projection->>'version' IS DISTINCT FROM 'draft_intake_v2' OR encode(sha256(convert_to(business.review_canonical_json(s.projection),'UTF8')),'hex') IS DISTINCT FROM s.projection_hash OR s.projection ? 'withheldSources'",
        'document_classification_immutable': "SELECT CASE WHEN EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='business.document_classification_inputs'::regclass AND tgname='immutable_document_classification_input' AND tgenabled='O') THEN 0 ELSE 1 END AS count",
    }


def document_model_reference_checks(classification_inputs=False):
    checks = {
        **document_privacy_reference_checks(),
        'document_model_snapshot_scope': "SELECT count(*) FROM business.document_model_snapshots s LEFT JOIN business.document_jobs j ON j.id=s.job_id WHERE j.id IS NULL OR j.kind NOT IN ('parse_document','extract_fields') OR s.projection->>'scopeId' IS DISTINCT FROM (j.document_version_id::text||':'||CASE WHEN j.kind='parse_document' THEN j.id::text ELSE j.input->>'parseRevision' END) OR s.projection->>'version' IS DISTINCT FROM 'draft_intake_v2' OR encode(sha256(convert_to(business.review_canonical_json(s.projection),'UTF8')),'hex') IS DISTINCT FROM s.projection_hash OR s.projection ? 'withheldSources'",
        'document_model_call_scope': "SELECT count(*) FROM business.document_model_calls c LEFT JOIN business.document_jobs j ON j.id=c.job_id WHERE j.id IS NULL OR j.kind NOT IN ('parse_document','extract_fields') OR c.approved_by IS DISTINCT FROM j.account_id OR (c.state='completed') IS DISTINCT FROM (c.response IS NOT NULL) OR (c.channel='cloud' AND (c.policy_version IS NULL OR c.policy_hash IS NULL OR NOT (EXISTS(SELECT 1 FROM business.document_model_snapshots s WHERE s.job_id=j.id)" + (" OR (c.step_key='classify:content:v1' AND EXISTS(SELECT 1 FROM business.document_classification_inputs i WHERE i.job_id=j.id))" if classification_inputs else "") + ")))",
    }
    if classification_inputs:
        checks.update(document_classification_reference_checks())
    return checks

def document_recovery_reference_checks():
    return {
        'document_recovery_scope': "SELECT count(*) FROM business.document_parse_recoveries r LEFT JOIN business.document_jobs j ON j.id=r.job_id LEFT JOIN business.work_items w ON w.id=r.work_item_id WHERE j.id IS NULL OR j.kind<>'parse_document' OR w.id IS NULL OR w.owner_type<>'DocumentJob' OR w.owner_id<>r.job_id OR w.kind<>'parse_document' OR r.requested_by<>j.account_id OR r.mode NOT IN ('prepare','cached')",
        'document_recovery_immutable': "SELECT CASE WHEN EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='business.document_parse_recoveries'::regclass AND tgname='immutable_document_parse_recovery' AND tgenabled='O') THEN 0 ELSE 1 END AS count",
    }

def document_accounting_reference_checks():
    return {
        'document_price_scope': """SELECT count(*) FROM business.document_model_prices p
          LEFT JOIN business.document_model_calls c ON c.id=p.call_id
          WHERE c.id IS NULL OR c.channel<>'cloud' OR p.pricing->>'deployment' IS DISTINCT FROM c.model
          OR p.pricing->>'version' IS DISTINCT FROM 'azure-astra-2026-09-03.v1'
          OR p.pricing->>'provider' IS DISTINCT FROM 'azure-openai'
          OR p.pricing->>'basis' IS DISTINCT FROM 'usage_upper_bound'
          OR coalesce(p.pricing->>'sku','') NOT IN ('GlobalStandard','DataZoneStandard')
          OR (p.provenance='verified_legacy' AND (c.state='unknown' OR c.usage IS NULL))""",
        'document_charge_calculation': """SELECT count(*) FROM business.document_model_charges s
          LEFT JOIN business.document_model_prices p ON p.call_id=s.call_id
          LEFT JOIN business.document_model_calls c ON c.id=s.call_id
          WHERE p.call_id IS NULL OR c.id IS NULL OR s.usage IS DISTINCT FROM c.usage
          OR NOT business.document_model_charge_valid(p.pricing,s.usage,s.calculation,s.charged_micros)""",
    }

def region_ocr_reference_checks():
    return {
        'region_ocr_request_scope_hash': """SELECT count(*) FROM business.document_region_ocr_requests q
          LEFT JOIN business.document_jobs j ON j.id=q.job_id
          LEFT JOIN business.document_pages p ON p.job_id=q.job_id AND p.page_number=q.page_number
          WHERE j.id IS NULL OR j.kind<>'parse_document' OR q.page_number>j.total_pages
          OR q.body->>'version' IS DISTINCT FROM 'bounded-region-ocr-v1'
          OR q.body->'crop'->>'crop_id' IS DISTINCT FROM q.crop_id
          OR q.body->'crop'->>'parse_revision' IS DISTINCT FROM j.id::text
          OR q.body->'crop'->>'document_version_id' IS DISTINCT FROM j.document_version_id::text
          OR q.body->>'sourcePageHash' IS DISTINCT FROM q.body->'crop'->>'page_image_sha256'
          OR coalesce(q.body->>'sourceArtifactHash','') !~ '^[a-f0-9]{64}$'
          OR (p.job_id IS NOT NULL AND (p.image_sha256 IS DISTINCT FROM q.body->>'sourcePageHash'
             OR p.page_asset_id IS DISTINCT FROM q.body->'crop'->>'page_asset_id'))
          OR encode(sha256(convert_to(business.review_canonical_json(q.body),'UTF8')),'hex') IS DISTINCT FROM q.request_hash""",
        'region_ocr_receipt_scope_hash': """SELECT count(*) FROM business.document_region_ocr_receipts r
          LEFT JOIN business.document_region_ocr_requests q ON q.id=r.request_id
          WHERE q.id IS NULL OR r.body->>'requestHash' IS DISTINCT FROM q.request_hash
          OR r.body->>'version' IS DISTINCT FROM q.body->>'version'
          OR r.body->'crop' IS DISTINCT FROM q.body->'crop'
          OR coalesce(r.body->>'status','') NOT IN ('ready','partial','failed')
          OR encode(sha256(convert_to(business.review_canonical_json(r.body),'UTF8')),'hex') IS DISTINCT FROM r.body_hash
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.body->'regions') item
             WHERE item->>'page_asset_id' IS DISTINCT FROM q.body->'crop'->>'page_asset_id')""",
        'region_ocr_request_budgets': """SELECT count(*) FROM (
          SELECT job_id FROM business.document_region_ocr_requests GROUP BY job_id HAVING count(*)>6
          UNION ALL SELECT job_id FROM business.document_region_ocr_requests GROUP BY job_id,page_number HAVING count(*)>2
          ) excess""",
    }


def company_reference_checks(public_records=False):
    checks = {
        'company_request_scope': """SELECT count(*) FROM business.company_lookup_requests r
          LEFT JOIN business.cases c ON c.id=r.case_id
          WHERE c.id IS NULL OR r.case_revision>c.revision OR r.case_revision<1
          OR r.input_hash !~ '^[a-f0-9]{64}$' OR r.query_hash !~ '^[a-f0-9]{64}$'
          OR jsonb_typeof(r.query) IS DISTINCT FROM 'object'""",
        'company_receipt_scope_hash': """SELECT count(*) FROM business.company_lookup_receipts v
          LEFT JOIN business.company_lookup_requests r ON r.id=v.lookup_id
          WHERE r.id IS NULL OR v.case_id<>r.case_id OR v.body->>'id' IS DISTINCT FROM r.id::text
          OR v.body->>'caseId' IS DISTINCT FROM r.case_id::text
          OR v.body->>'caseRevision' IS DISTINCT FROM r.case_revision::text
          OR v.body->'query' IS DISTINCT FROM r.query OR v.body->>'source' IS DISTINCT FROM 'GLEIF'
          OR encode(sha256(convert_to(business.review_canonical_json(v.body),'UTF8')),'hex') IS DISTINCT FROM v.body_hash""",
        'company_cache_scope': """SELECT count(*) FROM business.company_lookup_cache c
          LEFT JOIN business.company_lookup_receipts v ON v.lookup_id::text=c.body->>'id'
          LEFT JOIN business.company_lookup_requests r ON r.id=v.lookup_id
          WHERE v.lookup_id IS NULL OR c.case_id<>v.case_id OR c.query_hash<>r.query_hash
          OR c.body IS DISTINCT FROM v.body OR c.expires_at IS DISTINCT FROM (v.body->>'expiresAt')::timestamptz""",
        'company_adopted_name_source': """SELECT count(*) FROM business.review_object_versions o
          LEFT JOIN business.company_lookup_receipts v ON v.lookup_id::text=o.body->'companyNameSelection'->>'lookupId'
          WHERE o.body ? 'companyNameSelection' AND
          (v.lookup_id IS NULL OR v.case_id<>o.case_id OR NOT EXISTS(
            SELECT 1 FROM jsonb_array_elements(v.body->'records') r
            WHERE r->>'lei'=o.body->'companyNameSelection'->>'lei' AND r->>'legalName'=o.body->>'label'
              AND r->'conflicts'='[]'::jsonb))""",
    }
    if public_records:
        checks['company_public_record_separation'] = """SELECT count(*) FROM business.company_registry_records r
          WHERE r.body->>'lei' IS DISTINCT FROM r.lei OR r.expires_at<=r.fetched_at
          OR r.body ?| ARRAY['caseId','query','role','matchBasis','conflicts','draftId']
          OR encode(sha256(convert_to(business.review_canonical_json(r.body),'UTF8')),'hex') IS DISTINCT FROM r.record_hash"""
    return checks


def field_derived_source_reference_checks():
    """Check optional private derivations without changing old field history.

    Restore validates references/hashes only. Maker adoption still reconstructs
    the supported source grammar from private pages before accepting a fact.
    """
    # Expand each immutable JSON source once. Re-expanding the entire artifact
    # for every quoted anchor becomes quadratic as real parse history grows.
    prefix = """WITH derived AS MATERIALIZED (
      SELECT j.id,j.document_version_id,j.case_id,j.configuration_release_id,
        CASE WHEN j.kind='parse_document' THEN j.id::text ELSE j.input->>'parseRevision' END AS parse_revision,
        CASE WHEN j.kind='parse_document' THEN j.result->'fieldFilter'->>'directoryRevision'
          ELSE j.input->>'directoryRevision' END AS directory_revision,
        j.result AS result,f,c,kind.proof_key,kind.receipt_key,c->kind.proof_key AS proof
      FROM business.document_jobs j
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(j.result->'items',j.result->'fieldFilter'->'items','[]')) f
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(f->'semanticFilter'->'originalCandidates','[]')
        ||coalesce(f->'candidates','[]')) c
      CROSS JOIN (VALUES ('authorizationEvidence','authorizationSource'),
        ('sourceCorrectionEvidence','sourceCorrection'),
        ('tablePartyEvidence','tablePartySource')) kind(proof_key,receipt_key)
      WHERE c ? kind.proof_key
    ) """
    return {
        'field_derived_source_binding': prefix + """SELECT count(*) FROM derived x
          LEFT JOIN business.document_versions d ON d.id=x.document_version_id
          WHERE d.id IS NULL OR d.case_id<>x.case_id
          OR jsonb_typeof(x.proof) IS DISTINCT FROM 'object'
          OR x.f->'semanticFilter'->>'version' IS DISTINCT FROM 'azure-grounded-fields-v2'
          OR x.proof->>'association' IS DISTINCT FROM 'candidate'
          OR x.proof->>'targetFieldId' IS DISTINCT FROM x.f->>'fieldId'
          OR x.proof->'binding' IS DISTINCT FROM x.result->'cloudExtraction'->x.receipt_key
          OR x.proof->'binding'->>'documentVersionId' IS DISTINCT FROM x.document_version_id::text
          OR x.proof->'binding'->>'parseRevision' IS DISTINCT FROM x.parse_revision
          OR x.proof->'binding'->>'sourceSha256' IS DISTINCT FROM d.sha256
          OR coalesce(x.proof->'binding'->>'inputSha256','') !~ '^[a-f0-9]{64}$'
          OR NOT EXISTS(SELECT 1 FROM business.review_config_releases cfg
            WHERE cfg.document_configuration_id=x.configuration_release_id
            AND cfg.manifest_hash=x.proof->'binding'->>'configurationSha256')
          OR jsonb_typeof(x.proof->'binding'->'responseSha256s') IS DISTINCT FROM 'array'
          OR jsonb_array_length(CASE WHEN jsonb_typeof(x.proof->'binding'->'responseSha256s')='array'
             THEN x.proof->'binding'->'responseSha256s' ELSE '[]'::jsonb END) NOT BETWEEN 1 AND 2
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.proof->'binding'->'responseSha256s')='array'
             THEN x.proof->'binding'->'responseSha256s' ELSE '[]'::jsonb END) h
             WHERE jsonb_typeof(h) IS DISTINCT FROM 'string' OR h#>>'{}' !~ '^[a-f0-9]{64}$')
          OR (x.proof_key='authorizationEvidence' AND
            (x.proof->>'version' IS DISTINCT FROM 'authorization-source-v1'
             OR coalesce(x.proof->>'method','') NOT IN ('classified_clause','referenced_definition')
             OR jsonb_typeof(x.proof->'sources') IS DISTINCT FROM 'array'
             OR jsonb_array_length(CASE WHEN jsonb_typeof(x.proof->'sources')='array'
               THEN x.proof->'sources' ELSE '[]'::jsonb END) NOT BETWEEN 1 AND 8
             OR x.f->>'fieldId' NOT IN (x.proof->'binding'->>'scopeFieldId',x.proof->'binding'->>'signingConditionsFieldId')))
          OR (x.proof_key='sourceCorrectionEvidence' AND
            (x.proof->>'version' IS DISTINCT FROM 'independent-line-source-v1'
             OR x.proof->>'method' IS DISTINCT FROM 'independent_line_agreement'
             OR jsonb_typeof(x.proof->'segmentIndex') IS DISTINCT FROM 'number'
             OR NOT '[0,1,2,3,4,5]'::jsonb @> jsonb_build_array(x.proof->'segmentIndex')))
          OR (x.proof_key='tablePartyEvidence' AND
            (x.proof->>'version' IS DISTINCT FROM 'table-party-role-v1'
             OR x.proof->>'method' IS DISTINCT FROM 'classified_formal_name_row'
             OR jsonb_typeof(x.proof->'table') IS DISTINCT FROM 'object'
             OR coalesce(x.proof->'table'->>'regionId','')=''
             OR coalesce(x.proof->'table'->>'rawTextSha256','') !~ '^[a-f0-9]{64}$'
             OR EXISTS(SELECT 1 FROM unnest(ARRAY['rowIndex','roleCellIndex','formalNameCellIndex','nameCellIndex']) cell_key
               WHERE jsonb_typeof(x.proof->'table'->cell_key) IS DISTINCT FROM 'number'
               OR coalesce(x.proof->'table'->>cell_key,'') !~ '^(0|[1-9][0-9]{0,2}|1[0-9]{3})$')))""",
        'field_derived_source_origins': prefix + """SELECT count(*) FROM derived x
          WHERE jsonb_typeof(x.proof->'sourceCandidateIds') IS DISTINCT FROM 'array'
          OR jsonb_array_length(CASE WHEN jsonb_typeof(x.proof->'sourceCandidateIds')='array'
             THEN x.proof->'sourceCandidateIds' ELSE '[]'::jsonb END) NOT BETWEEN 1 AND 50
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.proof->'sourceCandidateIds')='array'
             THEN x.proof->'sourceCandidateIds' ELSE '[]'::jsonb END) candidate_id(value)
             WHERE jsonb_typeof(candidate_id.value) IS DISTINCT FROM 'string')
          OR NOT EXISTS(SELECT 1 FROM business.document_artifacts a
            CROSS JOIN LATERAL jsonb_array_elements(coalesce(a.body->'logicalDocuments','[]')) l
            WHERE a.job_id::text=x.parse_revision AND a.directory_revision::text=x.directory_revision
            AND l->>'id'=x.proof->>'logicalDocumentId')
          OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(x.proof->'sourceCandidateIds')='array'
              THEN x.proof->'sourceCandidateIds' ELSE '[]'::jsonb END) origin(value)
            WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(x.result->'items',x.result->'fieldFilter'->'items','[]')) source_field(value)
              CROSS JOIN LATERAL jsonb_array_elements(coalesce(source_field.value->'semanticFilter'->'originalCandidates','[]')) source_candidate(value)
              WHERE source_candidate.value->>'candidateId'=origin.value
                AND NOT source_candidate.value ?| ARRAY['authorizationEvidence','sourceCorrectionEvidence','roleEvidence','tablePartyEvidence']
                AND source_field.value->>'fieldId'=CASE WHEN x.proof_key='authorizationEvidence' THEN x.proof->'binding'->>'scopeFieldId' ELSE x.f->>'fieldId' END
                AND (x.proof_key<>'tablePartyEvidence' OR (
                  origin.value LIKE 'cloud-party-seed-%'
                  AND source_candidate.value->>'rawValue'=x.c->>'rawValue'
                  AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(source_field.value->'semanticFilter'->'decisions','[]')) decision
                    WHERE decision->>'candidateId'=origin.value AND decision->>'decision'='rejected')))))""",
        'field_derived_source_quotes': prefix + """, job_anchors AS MATERIALIZED (
          SELECT j.id,anchor FROM business.document_jobs j
          CROSS JOIN LATERAL jsonb_array_elements(coalesce(j.result->'anchors','[]')) anchor
          WHERE EXISTS(SELECT 1 FROM derived x WHERE x.id=j.id)
        ), artifact_anchors AS MATERIALIZED (
          SELECT a.job_id::text AS parse_revision,a.directory_revision::text AS directory_revision,anchor
          FROM business.document_artifacts a
          CROSS JOIN LATERAL jsonb_array_elements(coalesce(a.body->'anchors','[]')) anchor
          WHERE EXISTS(SELECT 1 FROM derived x
            WHERE x.parse_revision=a.job_id::text AND x.directory_revision=a.directory_revision::text)
        ), sources AS (
          SELECT x.id,x.proof_key,x.parse_revision,x.directory_revision,x.document_version_id,s FROM derived x
          CROSS JOIN LATERAL jsonb_array_elements(CASE
            WHEN x.proof_key='authorizationEvidence' AND jsonb_typeof(x.proof->'sources')='array' THEN x.proof->'sources'
            WHEN x.proof_key='sourceCorrectionEvidence' THEN jsonb_build_array(x.proof->'originalSegment',x.proof->'nativeLine',x.proof->'ocrLine')
            WHEN x.proof_key='tablePartyEvidence' THEN jsonb_build_array(x.proof->'role',x.proof->'formalName',x.proof->'name')
            ELSE '[null]'::jsonb END) s
        ) SELECT count(*) FROM sources x
          WHERE jsonb_typeof(x.s) IS DISTINCT FROM 'object'
          OR jsonb_typeof(x.s->'quote') IS DISTINCT FROM 'string'
          OR jsonb_typeof(x.s->'textSha256') IS DISTINCT FROM 'string'
          OR coalesce(x.s->>'quote','')=''
          OR (x.proof_key='authorizationEvidence' AND coalesce(x.s->>'kind','') NOT IN ('operative_clause','definition'))
          OR encode(sha256(convert_to(x.s->>'quote','UTF8')),'hex') IS DISTINCT FROM x.s->>'textSha256'
          OR jsonb_typeof(x.s->'anchorIds') IS DISTINCT FROM 'array' OR x.s->'anchorIds'='[]'::jsonb
          OR jsonb_typeof(x.s->'pageNumbers') IS DISTINCT FROM 'array' OR x.s->'pageNumbers'='[]'::jsonb
          OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(x.s->'anchorIds')='array'
              THEN x.s->'anchorIds' ELSE '[]'::jsonb END) source_anchor
            WHERE NOT EXISTS(
              SELECT 1 FROM (
                SELECT anchor FROM job_anchors a WHERE a.id=x.id
                UNION ALL SELECT anchor FROM artifact_anchors a
                  WHERE a.parse_revision=x.parse_revision AND a.directory_revision=x.directory_revision
              ) anchors
              WHERE anchor->>'anchor_id'=source_anchor AND anchor->>'document_version_id'=x.document_version_id::text
                AND anchor->>'parse_revision'=x.parse_revision
                AND x.s->'pageNumbers' @> jsonb_build_array(anchor->'page_number')))""",
        'field_table_party_source': prefix + """, page_regions AS MATERIALIZED (
          SELECT p.job_id::text AS parse_revision,p.page_number,p.page_asset_id,
            p.body->'canonicalRegionIds' AS canonical_region_ids,r
          FROM business.document_pages p
          CROSS JOIN LATERAL jsonb_array_elements(coalesce(p.body->'regions','[]')) r
          WHERE EXISTS(SELECT 1 FROM derived x
            WHERE x.proof_key='tablePartyEvidence' AND x.parse_revision=p.job_id::text)
        ) SELECT count(*) FROM derived x
          WHERE x.proof_key='tablePartyEvidence' AND NOT EXISTS(
            SELECT 1 FROM page_regions p
            WHERE p.parse_revision=x.parse_revision
              AND r->>'region_id'=x.proof->'table'->>'regionId'
              AND r->>'document_version_id'=x.document_version_id::text
              AND r->>'parse_revision'=x.parse_revision
              AND r->>'page_asset_id'=p.page_asset_id
              AND coalesce(p.canonical_region_ids,'[]') @> jsonb_build_array(r->'region_id')
              AND r->>'raw_text_sha256'=x.proof->'table'->>'rawTextSha256'
              AND encode(sha256(convert_to(r->>'raw_text','UTF8')),'hex')=r->>'raw_text_sha256'
              AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['role','formalName','name']) source_key
                WHERE jsonb_typeof(x.proof->source_key->'quote') IS DISTINCT FROM 'string'
                  OR coalesce(x.proof->source_key->>'quote','')=''
                  OR position(x.proof->source_key->>'quote' IN r->>'raw_text')=0
                  OR x.proof->source_key->'pageNumbers' IS DISTINCT FROM jsonb_build_array(p.page_number)))""",
    }


def review_reference_checks():
    checks = {
        'review_config_revision_hashes': "SELECT count(*) FROM business.review_config_revisions r WHERE encode(sha256(convert_to(business.review_canonical_json(r.manifest),'UTF8')),'hex') IS DISTINCT FROM r.manifest_hash",
        'review_config_draft_revision': "SELECT count(*) FROM business.review_config_drafts d LEFT JOIN business.review_config_revisions r ON r.draft_id=d.id AND r.revision=d.revision WHERE r.draft_id IS NULL OR r.manifest IS DISTINCT FROM d.manifest OR r.manifest_hash IS DISTINCT FROM d.manifest_hash",
        'review_config_trial_receipts': "SELECT count(*) FROM business.review_config_trials t LEFT JOIN business.review_config_revisions r ON r.draft_id=t.draft_id AND r.revision=t.draft_revision WHERE r.draft_id IS NULL OR r.manifest_hash IS DISTINCT FROM t.manifest_hash OR t.receipt->>'manifestHash' IS DISTINCT FROM t.manifest_hash OR t.receipt->>'packageHash' IS DISTINCT FROM t.package_hash OR t.receipt->>'policySha256' IS DISTINCT FROM t.policy_sha256 OR encode(sha256(convert_to(business.review_canonical_json(t.receipt),'UTF8')),'hex') IS DISTINCT FROM t.receipt_hash",
        'review_config_approval_identity': "SELECT count(*) FROM business.review_config_approvals a LEFT JOIN business.review_config_trials t ON t.id=a.trial_id WHERE t.id IS NULL OR NOT t.passed OR t.draft_id<>a.draft_id OR t.draft_revision<>a.draft_revision OR t.manifest_hash IS DISTINCT FROM a.manifest_hash OR EXISTS(SELECT 1 FROM business.review_config_revisions r WHERE r.draft_id=a.draft_id AND r.revision<=a.draft_revision AND r.editor_person_id=a.person_id) OR encode(sha256(convert_to(business.review_canonical_json(jsonb_build_object('draftId',a.draft_id,'revision',a.draft_revision,'manifestHash',a.manifest_hash,'trialHash',t.receipt_hash,'personId',a.person_id)),'UTF8')),'hex') IS DISTINCT FROM a.approval_hash",
        'review_config_release_chain': "SELECT count(*) FROM business.review_config_releases c LEFT JOIN business.review_config_revisions r ON r.draft_id=c.draft_id AND r.revision=c.draft_revision LEFT JOIN business.review_config_approvals a ON a.draft_id=c.draft_id AND a.draft_revision=c.draft_revision AND a.approval_hash=c.approval_hash LEFT JOIN business.review_config_trials t ON t.id=a.trial_id WHERE r.draft_id IS NULL OR a.id IS NULL OR t.id IS NULL OR r.manifest IS DISTINCT FROM c.manifest OR r.manifest_hash IS DISTINCT FROM c.manifest_hash OR c.manifest->>'releaseId' IS DISTINCT FROM c.release_id OR t.receipt_hash IS DISTINCT FROM c.trial_hash OR t.package_hash IS DISTINCT FROM c.package_hash OR t.policy_sha256 IS DISTINCT FROM c.policy_sha256 OR encode(sha256(convert_to(c.policy_source,'UTF8')),'hex') IS DISTINCT FROM c.policy_sha256 OR encode(sha256(convert_to(business.review_canonical_json(c.publication_receipt),'UTF8')),'hex') IS DISTINCT FROM c.publication_hash OR c.publication_receipt->>'releaseId' IS DISTINCT FROM c.release_id OR c.publication_receipt->>'packageHash' IS DISTINCT FROM c.package_hash",
        'review_snapshot_identity': "SELECT count(*) FROM business.review_runs r LEFT JOIN business.cases c ON c.id=r.case_id LEFT JOIN business.review_config_releases cfg ON cfg.release_id=r.configuration_release_id WHERE c.id IS NULL OR cfg.release_id IS NULL OR r.snapshot->>'caseId' IS DISTINCT FROM r.case_id::text OR r.snapshot->>'configurationReleaseId' IS DISTINCT FROM cfg.release_id OR r.snapshot->>'manifestHash' IS DISTINCT FROM cfg.manifest_hash OR r.snapshot->>'packageHash' IS DISTINCT FROM cfg.package_hash OR encode(sha256(convert_to(business.review_canonical_json(r.snapshot),'UTF8')),'hex') IS DISTINCT FROM r.snapshot_hash",
        'review_material_references': "SELECT count(*) FROM business.review_runs r CROSS JOIN LATERAL jsonb_array_elements(r.snapshot->'materials') m LEFT JOIN business.document_versions d ON d.id::text=m->>'documentVersionId' LEFT JOIN business.document_jobs j ON j.id::text=m->>'parseRevision' LEFT JOIN business.document_artifacts a ON a.job_id=j.id AND a.directory_revision::text=m->>'directoryRevision' WHERE d.id IS NULL OR d.case_id<>r.case_id OR d.sha256 IS DISTINCT FROM m->>'sourceSha256' OR j.document_version_id IS DISTINCT FROM d.id OR j.case_id IS DISTINCT FROM r.case_id OR (m->>'directoryRevision' IS NOT NULL AND (a.id IS NULL OR a.sha256 IS DISTINCT FROM m->>'artifactHash')) OR (m->>'sourceStructureHash' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM business.document_sources s WHERE s.job_id=j.id AND s.sha256=m->>'sourceStructureHash'))",
        'review_fixed_projection': "SELECT count(*) FROM business.review_runs r CROSS JOIN LATERAL jsonb_array_elements(r.snapshot->'materials') m LEFT JOIN business.document_jobs j ON j.id::text=m->>'projectionJobId' WHERE m->>'projectionJobId' IS NOT NULL AND (j.id IS NULL OR j.case_id<>r.case_id OR j.document_version_id::text IS DISTINCT FROM m->>'documentVersionId' OR (j.kind='extract_fields' AND (j.input->>'parseRevision' IS DISTINCT FROM m->>'parseRevision' OR j.input->>'directoryRevision' IS DISTINCT FROM m->>'directoryRevision')) OR (j.kind='parse_document' AND (j.id::text IS DISTINCT FROM m->>'parseRevision' OR j.result->'fieldFilter'->>'directoryRevision' IS DISTINCT FROM m->>'directoryRevision')) OR j.kind NOT IN ('parse_document','extract_fields'))",
        'review_projection_hash': "SELECT count(*) FROM business.review_runs r CROSS JOIN LATERAL jsonb_array_elements(r.snapshot->'materials') m JOIN business.document_jobs j ON j.id::text=m->>'projectionJobId' WHERE m->>'projectionHash' IS NOT NULL AND encode(sha256(convert_to(business.review_canonical_json(jsonb_build_object('items',CASE WHEN j.kind='parse_document' THEN j.result->'fieldFilter'->'items' ELSE j.result->'items' END,'anchors',CASE WHEN j.kind='parse_document' THEN '[]'::jsonb ELSE coalesce(j.result->'anchors','[]') END,'sourceAnchors',CASE WHEN j.kind='parse_document' THEN '[]'::jsonb ELSE coalesce(j.result->'sourceAnchors','[]') END)),'UTF8')),'hex') IS DISTINCT FROM m->>'projectionHash'",
        'review_fact_objects': "SELECT count(*) FROM business.review_runs r CROSS JOIN LATERAL jsonb_array_elements(r.snapshot->'facts') f WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.snapshot->'objects') o WHERE o->>'objectId'=f->>'objectId') OR NOT EXISTS(SELECT 1 FROM business.review_fact_versions v WHERE v.case_id=r.case_id AND v.fact_id::text=f->>'factId' AND v.version::text=f->>'version')",
        'review_fact_evidence': "SELECT count(*) FROM business.review_runs r CROSS JOIN LATERAL jsonb_array_elements(r.snapshot->'facts') f CROSS JOIN LATERAL jsonb_array_elements(f->'evidence') e WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.snapshot->'materials') m WHERE m->>'documentVersionId'=e->>'documentVersionId' AND m->>'parseRevision'=e->>'parseRevision' AND m->>'directoryRevision' IS NOT DISTINCT FROM e->>'directoryRevision') OR (e->>'sourceNodeId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM business.document_sources s CROSS JOIN LATERAL jsonb_array_elements(s.body->'nodes') n WHERE s.job_id::text=e->>'parseRevision' AND n->>'id'=e->>'sourceNodeId')) OR (e->>'anchorId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM business.document_artifacts a CROSS JOIN LATERAL jsonb_array_elements(a.body->'anchors') n WHERE a.job_id::text=e->>'parseRevision' AND a.directory_revision::text=e->>'directoryRevision' AND n->>'anchor_id'=e->>'anchorId') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.snapshot->'materials') m JOIN business.document_jobs j ON j.id::text=m->>'projectionJobId' CROSS JOIN LATERAL jsonb_array_elements(coalesce(j.result->'anchors','[]')) n WHERE m->>'parseRevision'=e->>'parseRevision' AND n->>'anchor_id'=e->>'anchorId'))",
        'review_findings_receipts': "SELECT count(*) FROM business.review_findings f LEFT JOIN business.review_runs r ON r.id=f.run_id WHERE r.id IS NULL OR f.case_id<>r.case_id OR f.case_revision<>r.case_revision OR f.receipt->'engine'->>'releaseId' IS DISTINCT FROM r.configuration_release_id OR f.receipt->'engine'->>'packageHash' IS DISTINCT FROM r.snapshot->>'packageHash' OR f.receipt->'result'->>'ruleId' IS DISTINCT FROM f.rule_id",
        'review_issue_scope': "SELECT count(*) FROM business.review_issues i LEFT JOIN business.review_findings f ON f.id=i.latest_finding_id WHERE f.id IS NULL OR f.case_id<>i.case_id OR f.rule_id<>i.rule_id OR f.scope_id<>i.scope_id",
        'review_work_owners': "SELECT count(*) FROM business.work_items w LEFT JOIN business.review_runs r ON r.id=w.owner_id WHERE w.owner_type='Workflow' AND w.kind='p3_review' AND (r.id IS NULL OR w.queue<>'workflow')",
        'review_supplement_scope': "SELECT count(*) FROM business.review_supplements s LEFT JOIN business.review_issues i ON i.id=s.issue_id LEFT JOIN business.document_jobs p ON p.id=s.parse_revision LEFT JOIN business.document_jobs j ON j.id=s.job_id WHERE i.id IS NULL OR i.case_id<>s.case_id OR p.id IS NULL OR p.document_version_id<>s.document_version_id OR p.case_id<>s.case_id OR (s.job_id IS NOT NULL AND (j.id IS NULL OR j.kind<>'extract_fields' OR j.document_version_id<>s.document_version_id OR j.input->>'parseRevision' IS DISTINCT FROM s.parse_revision::text)) OR NOT EXISTS(SELECT 1 FROM business.review_supplement_gaps g WHERE g.request_id=s.id)",
        'review_supplement_work': "SELECT count(*) FROM business.work_items w LEFT JOIN business.review_supplements s ON s.id=w.owner_id WHERE w.owner_type='Workflow' AND w.kind='p3_supplement' AND (s.id IS NULL OR w.queue<>'workflow')",
        'review_document_receipt': "SELECT count(*) FROM business.review_document_receipts d LEFT JOIN business.review_runs r ON r.id=d.run_id WHERE r.id IS NULL OR d.snapshot_hash IS DISTINCT FROM r.snapshot_hash OR d.body->>'snapshotHash' IS DISTINCT FROM r.snapshot_hash",
        'field_filter_call_scope': "SELECT count(*) FROM business.field_filter_calls c LEFT JOIN business.document_jobs j ON j.id=c.job_id WHERE j.id IS NULL OR j.kind NOT IN ('parse_document','extract_fields') OR (c.state='completed') IS DISTINCT FROM (c.response IS NOT NULL)",
        'field_projection_references': "SELECT count(*) FROM business.document_jobs j WHERE j.kind='extract_fields' AND j.result->'items' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM business.document_jobs p JOIN business.document_artifacts a ON a.job_id=p.id WHERE p.id::text=j.input->>'parseRevision' AND p.document_version_id=j.document_version_id AND p.case_id=j.case_id AND a.directory_revision::text=j.input->>'directoryRevision')",
        'field_projection_decisions': "SELECT count(*) FROM business.document_jobs j CROSS JOIN LATERAL jsonb_array_elements(coalesce(j.result->'items',j.result->'fieldFilter'->'items','[]')) f CROSS JOIN LATERAL jsonb_array_elements(coalesce(f->'semanticFilter'->'decisions','[]')) d WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(f->'semanticFilter'->'originalCandidates') c WHERE c->>'candidateId'=d->>'candidateId')",
    }
    checks.update(field_derived_source_reference_checks())
    # Both generations remain valid after restore. Compare each actual engine
    # receipt with its immutable manifest, never with the current app default.
    versions = {
        'review_config_trial_executor_versions': "SELECT count(*) FROM business.review_config_trials t JOIN business.review_config_revisions r ON r.draft_id=t.draft_id AND r.revision=t.draft_revision WHERE jsonb_typeof(t.receipt->'receipts') IS DISTINCT FROM 'array' OR t.receipt->'receipts'='[]'::jsonb OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.receipt->'receipts')='array' THEN t.receipt->'receipts' ELSE '[]'::jsonb END) e WHERE e->>'executorVersion' IS DISTINCT FROM r.manifest->'compatibility'->>'executorVersion')",
        'review_config_publication_executor_version': "SELECT count(*) FROM business.review_config_releases c WHERE c.publication_receipt->>'executorVersion' IS DISTINCT FROM c.manifest->'compatibility'->>'executorVersion'",
        'review_findings_executor_version': "SELECT count(*) FROM business.review_findings f JOIN business.review_runs r ON r.id=f.run_id JOIN business.review_config_releases c ON c.release_id=r.configuration_release_id WHERE f.receipt->'engine'->>'executorVersion' IS DISTINCT FROM c.manifest->'compatibility'->>'executorVersion'",
    }
    # Check a trial's inner receipts before downstream approval hashes: otherwise
    # the first diagnostic could hide the engine mismatch behind its dependents.
    ordered = {}
    after = {'review_config_trial_receipts': 'review_config_trial_executor_versions',
             'review_config_release_chain': 'review_config_publication_executor_version',
             'review_findings_receipts': 'review_findings_executor_version'}
    for name, sql in checks.items():
        ordered[name] = sql
        if name in after:
            ordered[after[name]] = versions[after[name]]
    return ordered


def scalar_values(query, statements):
    """Batch trusted scalar SELECTs without starting one psql process per check.

    Preserve statement/result order and fail closed on truncated or extra output.
    No authority fencing or business mutation belongs in this batch.
    """
    if not statements:
        return []
    lines = query(';\n'.join(statements) + ';\n').decode().strip().splitlines()
    if len(lines) != len(statements) or any(not re.fullmatch(r'(?:[0-9]+|t|f)', line) for line in lines):
        raise RuntimeError('Restored database query returned an invalid result')
    return lines


def verify_reference_checks(query, checks, category='reference'):
    results = scalar_values(query, list(checks.values()))
    for name, value in zip(checks, results):
        if value != '0':
            raise RuntimeError('Restored ' + category + ' check failed: ' + name)


def verify_application(query):
    """Validate SQL-level references and fence restored authority; never fetch text."""
    def scalar(sql):
        return scalar_values(query, [sql])[0]

    def table_presence(names):
        statements = ["SELECT to_regclass('business." + name + "') IS NOT NULL" for name in names]
        return dict(zip(names, [value == 't' for value in scalar_values(query, statements)]))

    def verify_columns(columns, message):
        statements = ["SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='business' AND table_name='" + table + "' AND column_name='" + column + "')" for table, column in columns]
        for (table, column), value in zip(columns, scalar_values(query, statements)):
            if value != 't':
                raise RuntimeError(message + table + '.' + column)

    if scalar("SELECT to_regclass('auth.sessions') IS NOT NULL") != 't':
        return {}
    p2 = scalar("SELECT to_regclass('business.document_jobs') IS NOT NULL") == 't'
    indexed = p2 and scalar("SELECT to_regclass('business.document_chunks') IS NOT NULL") == 't'
    docx = p2 and scalar("SELECT to_regclass('business.document_sources') IS NOT NULL") == 't'
    mock = p2 and scalar("SELECT to_regclass('business.mock_validation_jobs') IS NOT NULL") == 't'
    p3_tables = {name: scalar("SELECT to_regclass('business." + name + "') IS NOT NULL") == 't' for name in P3_TABLES}
    p3 = any(p3_tables.values())
    if p3:
        if not all(p3_tables.values()):
            raise RuntimeError('Restored P3 schema is incomplete')
        verify_columns([('model_calls', 'budget_day'), ('intake_turns', 'selected_candidate_ids'),
                        ('intake_turns', 'session_key'), ('cases', 'created_from_draft_id'), ('case_drafts', 'field_sources')],
                       'Restored P3 schema is incomplete: ')
    attachments = scalar("SELECT to_regclass('business.draft_attachments') IS NOT NULL") == 't'
    assistant_tables = table_presence(ASSISTANT_TABLES)
    assistant = any(assistant_tables.values())
    attachment_column = p3 and scalar("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='business' AND table_name='upload_sessions' AND column_name='draft_id')") == 't'
    assistant_column = p3 and scalar("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='business' AND table_name='intake_turns' AND column_name='protocol_version')") == 't'
    if attachments != attachment_column or assistant != assistant_column:
        raise RuntimeError('Restored P3 assistant schema is incomplete')
    if (attachments and not p3) or (assistant and (not attachments or not all(assistant_tables.values()))):
        raise RuntimeError('Restored P3 assistant schema is incomplete')
    optional_columns = []
    if attachments:
        optional_columns += [('upload_sessions', 'draft_id'), ('draft_attachments', 'parse_epoch'), ('draft_attachments', 'parse_lease_until')]
    if assistant:
        optional_columns += [('intake_turns', name) for name in ['protocol_version', 'attachment_ids', 'input_snapshot', 'reply_blocks', 'assistant_questions', 'result_revision', 'applied_fields', 'conflict_fields']]
        optional_columns += [('model_calls', name) for name in ['step_key', 'call_index', 'parent_call_id', 'result']]
        optional_columns += [('intake_candidates', 'source_refs')]
    verify_columns(optional_columns, 'Restored P3 assistant schema is incomplete: ')
    private_tables = P3_TABLES + (['draft_attachments'] if attachments else []) + (ASSISTANT_TABLES if assistant else [])
    review_tables = table_presence(REVIEW_TABLES)
    review = any(review_tables.values())
    if review and not all(review_tables.values()):
        raise RuntimeError('Restored review schema is incomplete')
    processing_access = scalar("SELECT to_regclass('business.document_processing_access') IS NOT NULL") == 't'
    if processing_access:
        for name, sql in processing_access_reference_checks().items():
            if scalar(sql) != '0':
                raise RuntimeError('Restored processing authorization check failed: ' + name)
    document_model_tables = table_presence(DOCUMENT_MODEL_TABLES)
    document_models = any(document_model_tables.values())
    if document_models and (not review or not all(document_model_tables.values())):
        raise RuntimeError('Restored document model schema is incomplete')
    classification_inputs = scalar("SELECT to_regclass('business.document_classification_inputs') IS NOT NULL") == 't'
    if classification_inputs and not document_models:
        raise RuntimeError('Restored document classification schema is incomplete')
    document_recovery = scalar("SELECT to_regclass('business.document_parse_recoveries') IS NOT NULL") == 't'
    if document_recovery:
        if not document_models:
            raise RuntimeError('Restored document recovery schema is incomplete')
        for name, sql in document_recovery_reference_checks().items():
            if scalar(sql) != '0':
                raise RuntimeError('Restored document recovery check failed: ' + name)
    accounting_tables = table_presence(DOCUMENT_ACCOUNTING_TABLES)
    accounting = any(accounting_tables.values())
    if accounting and (not document_models or not all(accounting_tables.values())):
        raise RuntimeError('Restored document accounting schema is incomplete')
    signature_tables = table_presence(SIGNATURE_TABLES)
    signatures = any(signature_tables.values())
    if signatures and (not review or not p2 or not all(signature_tables.values())):
        raise RuntimeError('Restored signature schema is incomplete')
    signature_information = scalar("SELECT to_regclass('business.signature_information_records') IS NOT NULL") == 't'
    if scalar("SELECT EXISTS(SELECT 1 FROM business.schema_migrations WHERE version='052_signature_information.sql')") == 't' and not signature_information:
        raise RuntimeError('Restored manual signature schema is incomplete')
    company_tables = table_presence(COMPANY_TABLES)
    company = any(company_tables.values())
    company_public = scalar("SELECT to_regclass('business.company_registry_records') IS NOT NULL") == 't'
    if (company and (not review or not all(company_tables.values()))) or (company_public and not company):
        raise RuntimeError('Restored company identity schema is incomplete')
    region_ocr_tables = table_presence(REGION_OCR_TABLES)
    region_ocr = any(region_ocr_tables.values())
    if region_ocr and (not p2 or not review or not all(region_ocr_tables.values())):
        raise RuntimeError('Restored region OCR schema is incomplete')
    mock_identity_migration = mock and scalar("SELECT EXISTS(SELECT 1 FROM business.schema_migrations WHERE version='011_p2_mock_image_identity.sql')") == 't'
    if mock_identity_migration and scalar("SELECT count(*) FROM pg_constraint WHERE conrelid='business.mock_validation_jobs'::regclass AND conname='mock_validation_jobs_image_identity_complete' AND convalidated") != '1':
        raise RuntimeError('Restored mock image identity constraint is missing or unvalidated')
    if docx and (scalar("SELECT to_regclass('business.document_previews') IS NOT NULL") != 't' or
                 scalar("SELECT to_regclass('business.document_source_mappings') IS NOT NULL") != 't'):
        raise RuntimeError('Restored DOCX schema is incomplete')
    # References are checked before normalization so a fence cannot hide damage.
    accounting_archives = p3 and scalar("SELECT to_regclass('business.model_call_accounting_archives') IS NOT NULL") == 't'
    references = reference_checks(p2, indexed, docx, mock, p3, attachments, assistant)
    budget_checks = archived_model_accounting_checks() if accounting_archives else p3_reference_checks()
    if accounting_archives:
        references.update(budget_checks)
    verify_reference_checks(query, references)
    if review:
        verify_reference_checks(query, review_reference_checks())
    if document_models:
        verify_reference_checks(query, document_model_reference_checks(classification_inputs))
    if accounting:
        verify_reference_checks(query, document_accounting_reference_checks(), 'document accounting')
    if signatures:
        verify_reference_checks(query, signature_reference_checks())
    if signature_information:
        verify_reference_checks(query, signature_information_reference_checks())
    if company:
        verify_reference_checks(query, company_reference_checks(company_public))
    if region_ocr:
        verify_reference_checks(query, region_ocr_reference_checks())
    v2_tables = {name: scalar("SELECT to_regclass('business." + name + "') IS NOT NULL") == 't' for name in V2_REVIEW_TABLES}
    v2_review = any(v2_tables.values())
    if v2_review:
        if not review or not all(v2_tables.values()):
            raise RuntimeError('Restored V2 review schema is incomplete')
        for name, sql in v2_review_reference_checks().items():
            if scalar(sql) != '0':
                raise RuntimeError('Restored V2 review scope check failed: ' + name)
    checker_tables = {name: scalar("SELECT to_regclass('business." + name + "') IS NOT NULL") == 't' for name in CHECKER_TABLES + FORMAL_TABLES}
    checker_formal = any(checker_tables.values())
    if checker_formal:
        if not v2_review or not all(checker_tables.values()):
            raise RuntimeError('Restored Checker/formal schema is incomplete')
        for name, sql in checker_formal_reference_checks().items():
            if scalar(sql) != '0':
                raise RuntimeError('Restored Checker/formal reference check failed: ' + name)
    fixed_teams = scalar("SELECT to_regclass('business.case_review_teams') IS NOT NULL") == 't'
    if fixed_teams:
        if scalar("SELECT count(*) FROM business.case_review_teams t LEFT JOIN auth.people m ON m.id=t.maker_person_id LEFT JOIN auth.people c ON c.id=t.checker_person_id LEFT JOIN auth.accounts a ON a.id=t.authorized_by WHERE m.id IS NULL OR c.id IS NULL OR a.id IS NULL OR m.id=c.id OR t.version<1") != '0':
            raise RuntimeError('Restored fixed review team references are invalid')
    query(isolation_sql(p2, mock, p3, review, attachments, signatures, processing_access, v2_review, checker_formal))
    checks = {
        'sessions': ('SELECT count(*) FROM auth.sessions', '0'),
        'worker_auth': ("SELECT has_schema_privilege('hsbc_p1_worker','auth','USAGE')", 'f'),
        'runtime_superuser': ("SELECT count(*) FROM pg_roles WHERE rolname IN ('hsbc_p1_api','hsbc_p1_worker','hsbc_p1_checkpoint') AND (rolsuper OR rolcreatedb OR rolcreaterole)", '0'),
        'runtime_ddl': ("SELECT count(*) FROM (VALUES ('auth'),('business'),('a2a'),('checkpoint')) s(name) CROSS JOIN (VALUES ('hsbc_p1_api'),('hsbc_p1_worker'),('hsbc_p1_checkpoint')) r(name) WHERE has_schema_privilege(r.name,s.name,'CREATE')", '0'),
        'instance_marker': ('SELECT count(*) FROM business.app_instance', '1'),
        'active_work': ("SELECT count(*) FROM business.work_items WHERE state IN ('pending','running')", '0'),
        'active_upload': ("SELECT count(*) FROM business.upload_sessions WHERE state IN ('issued','verifying')", '0'),
        'principal_epoch': ('SELECT count(*) FROM auth.accounts a LEFT JOIN business.principals p ON p.account_id=a.id WHERE p.account_id IS NULL OR p.auth_version <> a.session_epoch', '0'),
    }
    if v2_review:
        checks.update({
            'active_review_analysis': ("SELECT count(*) FROM business.review_analysis_jobs WHERE state IN ('pending','running')", '0'),
            'analysis_raw_call_api_access': ("SELECT has_table_privilege('hsbc_p1_api','business.review_analysis_calls','SELECT')", 'f'),
            'mail_runtime_mutation': ("SELECT count(*) FROM (VALUES ('hsbc_p1_api'),('hsbc_p1_worker')) r(name) WHERE has_table_privilege(r.name,'business.review_mail_drafts','UPDATE,DELETE')", '0'),
        })
    if checker_formal:
        checks.update({
            'active_formal_review': ("SELECT count(*) FROM business.formal_review_jobs WHERE state IN ('pending','running','unknown','failed')", '0'),
            'pending_checker_authority': ("SELECT count(*) FROM business.checker_submissions WHERE state='submitted' AND validity='current'", '0'),
            'formal_call_api_write': ("SELECT has_table_privilege('hsbc_p1_api','business.formal_review_calls','INSERT,UPDATE,DELETE')", 'f'),
            'formal_result_api_write': ("SELECT has_table_privilege('hsbc_p1_api','business.formal_review_results','INSERT,UPDATE,DELETE')", 'f'),
        })
    if p2:
        checks.update({
            'active_delegation': ('SELECT count(*) FROM business.document_tool_delegations WHERE NOT revoked', '0'),
            'active_document_job': ("SELECT count(*) FROM business.document_jobs WHERE state IN ('pending','running')", '0'),
            'principal_role': ('SELECT count(*) FROM auth.accounts a JOIN auth.people person ON person.id=a.person_id LEFT JOIN business.principals p ON p.account_id=a.id WHERE p.account_id IS NULL OR p.business_role IS DISTINCT FROM person.business_role', '0'),
        })
    if mock:
        checks.update({
            'active_mock_job': ("SELECT count(*) FROM business.mock_validation_jobs WHERE state IN ('pending','running')", '0'),
            'checkpoint_mock_access': ("SELECT has_table_privilege('hsbc_p1_checkpoint','business.mock_validation_jobs','SELECT,INSERT,UPDATE,DELETE')", 'f'),
        })
    if p3:
        checks.update({
            'active_model_call': ("SELECT count(*) FROM business.model_calls WHERE state IN ('pending','running','sent')", '0'),
            'active_intake_turn': ("SELECT count(*) FROM business.intake_turns WHERE status IN ('pending','running','unknown')", '0'),
            'active_model_session': ('SELECT count(*) FROM business.model_session_grants WHERE NOT revoked', '0'),
            'active_fixture_grant': ('SELECT count(*) FROM business.model_fixture_grants WHERE expires_at>now()', '0'),
            'uncertain_model_budget': (p3_reference_checks()['uncertain_call_reservation'], '0'),
            'restored_model_budget': (budget_checks['budget_reservations'], '0'),
            'restored_model_charges': (budget_checks['budget_charges'], '0'),
            'checkpoint_p3_access': ("SELECT count(*) FROM (VALUES " + ','.join("('business." + name + "')" for name in private_tables) + ") tables(name) WHERE has_table_privilege('hsbc_p1_checkpoint',name,'SELECT,INSERT,UPDATE,DELETE')", '0'),
        })
    if attachments:
        checks['active_draft_attachment_parse'] = ("SELECT count(*) FROM business.draft_attachments WHERE parse_state='running' OR parse_lease_until IS NOT NULL", '0')
    if review:
        checks['active_review_supplement'] = ("SELECT count(*) FROM business.review_supplements WHERE state IN ('pending','running')", '0')
        checks['active_review_work'] = ("SELECT count(*) FROM business.review_runs WHERE state IN ('pending','running')", '0')
        checks['checkpoint_review_access'] = ("SELECT count(*) FROM (VALUES " + ','.join("('business." + name + "')" for name in REVIEW_TABLES) + ") tables(name) WHERE has_table_privilege('hsbc_p1_checkpoint',name,'SELECT,INSERT,UPDATE,DELETE')", '0')
    if processing_access:
        checks['active_processing_access'] = ("SELECT count(*) FROM business.document_processing_access WHERE state IN ('pending','approved')", '0')
        checks['processing_access_worker_read_only'] = ("SELECT has_table_privilege('hsbc_p1_worker','business.document_processing_access','INSERT,UPDATE,DELETE')::int", '0')
    if document_models:
        checks['document_model_private_access'] = ("SELECT count(*) FROM (VALUES ('hsbc_p1_api'),('hsbc_p1_checkpoint')) roles(name) CROSS JOIN (VALUES ('business.document_model_snapshots'),('business.document_model_calls')) tables(name) WHERE has_table_privilege(roles.name,tables.name,'SELECT,INSERT,UPDATE,DELETE')", '0')
    if accounting:
        checks['document_accounting_private_access'] = ("SELECT count(*) FROM (VALUES ('hsbc_p1_api'),('hsbc_p1_checkpoint')) roles(name) CROSS JOIN (VALUES ('business.document_model_prices'),('business.document_model_charges')) tables(name) WHERE has_table_privilege(roles.name,tables.name,'SELECT,INSERT,UPDATE,DELETE')", '0')
        checks['document_accounting_worker_append_only'] = ("SELECT count(*) FROM (VALUES ('business.document_model_prices'),('business.document_model_charges')) tables(name) WHERE has_table_privilege('hsbc_p1_worker',name,'UPDATE,DELETE') OR NOT has_table_privilege('hsbc_p1_worker',name,'SELECT') OR NOT has_table_privilege('hsbc_p1_worker',name,'INSERT')", '0')
    if signatures:
        checks['signature_queue_empty'] = ('SELECT count(*) FROM business.private_inference_queue', '0')
        checks['signature_raw_calls_private'] = ("SELECT count(*) FROM (VALUES ('hsbc_p1_api'),('hsbc_p1_checkpoint')) roles(name) WHERE has_table_privilege(roles.name,'business.signature_model_calls','SELECT,INSERT,UPDATE,DELETE')", '0')
        checks['signature_raw_call_columns_private'] = ("SELECT count(*) FROM (VALUES ('hsbc_p1_api'),('hsbc_p1_checkpoint')) roles(name) CROSS JOIN pg_attribute a WHERE a.attrelid='business.signature_model_calls'::regclass AND a.attnum>0 AND NOT a.attisdropped AND (roles.name='hsbc_p1_checkpoint' OR a.attname NOT IN ('job_id','state')) AND has_column_privilege(roles.name,a.attrelid,a.attnum,'SELECT,INSERT,UPDATE,REFERENCES')", '0')
        checks['signature_api_call_metadata_readonly'] = ("SELECT count(*) FROM pg_attribute a WHERE a.attrelid='business.signature_model_calls'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege('hsbc_p1_api',a.attrelid,a.attnum,'INSERT,UPDATE,REFERENCES')", '0')
        if scalar("SELECT EXISTS(SELECT 1 FROM business.schema_migrations WHERE version='036_signature_call_state.sql')") == 't':
            checks['signature_api_call_metadata_readable'] = ("SELECT count(*) FROM (VALUES ('job_id'),('state')) columns(name) WHERE has_column_privilege('hsbc_p1_api','business.signature_model_calls',columns.name,'SELECT')", '2')
        checks['signature_checkpoint_access'] = ("SELECT count(*) FROM (VALUES " + ','.join("('business." + name + "')" for name in SIGNATURE_TABLES) + ") tables(name) WHERE has_table_privilege('hsbc_p1_checkpoint',name,'SELECT,INSERT,UPDATE,DELETE')", '0')
        checks['signature_worker_history_write'] = ("SELECT count(*) FROM (VALUES ('business.signature_review_snapshots'),('business.signature_confirmations')) tables(name) WHERE has_table_privilege('hsbc_p1_worker',name,'INSERT,UPDATE,DELETE')", '0')
    if signature_information:
        checks['signature_information_readonly_history'] = ("SELECT count(*) FROM (VALUES ('hsbc_p1_api','UPDATE,DELETE'),('hsbc_p1_worker','INSERT,UPDATE,DELETE'),('hsbc_p1_checkpoint','SELECT,INSERT,UPDATE,DELETE')) roles(name,actions) WHERE has_table_privilege(name,'business.signature_information_records',actions)", '0')
    if company:
        tables = COMPANY_TABLES + (['company_registry_records'] if company_public else [])
        values = ','.join("('business." + name + "')" for name in tables)
        checks['company_checkpoint_access'] = ("SELECT count(*) FROM (VALUES " + values + ") t(name) WHERE has_table_privilege('hsbc_p1_checkpoint',name,'SELECT,INSERT,UPDATE,DELETE')", '0')
        checks['company_worker_write'] = ("SELECT count(*) FROM (VALUES " + values + ") t(name) WHERE has_table_privilege('hsbc_p1_worker',name,'INSERT,UPDATE,DELETE')", '0')
        checks['company_immutable_api_write'] = ("SELECT count(*) FROM (VALUES ('business.company_lookup_requests'),('business.company_lookup_receipts')" + (",('business.company_registry_records')" if company_public else "") + ") t(name) WHERE has_table_privilege('hsbc_p1_api',name,'UPDATE,DELETE')", '0')
    if region_ocr:
        values = ','.join("('business." + name + "')" for name in REGION_OCR_TABLES)
        checks['region_ocr_private_receipts'] = ("SELECT count(*) FROM (VALUES " + values + ") t(name) CROSS JOIN (VALUES ('hsbc_p1_api'),('hsbc_p1_checkpoint')) r(name) WHERE has_table_privilege(r.name,t.name,'SELECT,INSERT,UPDATE,DELETE')", '0')
        checks['region_ocr_worker_immutable'] = ("SELECT count(*) FROM (VALUES " + values + ") t(name) WHERE has_table_privilege('hsbc_p1_worker',name,'UPDATE,DELETE')", '0')
        checks['region_ocr_worker_receipts'] = ("SELECT count(*) FROM (VALUES " + values + ") t(name) WHERE has_table_privilege('hsbc_p1_worker',name,'SELECT') AND has_table_privilege('hsbc_p1_worker',name,'INSERT')", '2')
    values = scalar_values(query, [sql for sql, expected in checks.values()])
    for (name, (sql, expected)), value in zip(checks.items(), values):
        if value != expected:
            raise RuntimeError('Restored isolation check failed: ' + name)
    counts = {name: int(scalar('SELECT count(*) FROM business.' + name)) for name in ['document_versions', 'work_items']}
    evidence = {'p1': {**counts, 'object_version_and_task_references_consistent': True,
        'schemas': ['auth', 'business', 'a2a', 'checkpoint'], 'runtime_ddl': False, 'worker_auth': False,
        'sessions_cleared': True, 'session_epochs_incremented': True,
        'pending_execution_canceled': True, 'work_epochs_incremented': True,
        'restored_instance_marker_count': 1}}
    if v2_review:
        evidence['v2_review'] = {'reference_checks': list(v2_review_reference_checks()), 'unfinished_analysis_canceled': True, 'unknown_calls_preserved': True, 'historical_rounds_and_mail_preserved': True}
    if p2:
        counts = {name: int(scalar('SELECT count(*) FROM business.' + name)) for name in
                  ['document_jobs', 'document_pages', 'document_artifacts', 'document_configurations']}
        evidence['p2'] = {**counts, 'reference_checks': list(reference_checks(True, indexed, docx, mock)),
            'tool_delegations_revoked': True, 'unfinished_jobs_stale': True,
            'historical_evidence_preserved': True, 'principal_roles_consistent': True,
            'oss_object_bytes_verified': False, 'can_resume_without_reauthorization': False}
        if docx:
            evidence['p2']['docx'] = {name:int(scalar('SELECT count(*) FROM business.' + name)) for name in
                                    ['document_sources', 'document_previews', 'document_source_mappings']}
            evidence['p2']['docx']['fixed_source_preview_and_mapping_references_consistent'] = True
        if mock:
            evidence['p2']['mock_validation'] = {'runs':int(scalar('SELECT count(*) FROM business.mock_validation_jobs')),
                'unfinished_runs_stale':True, 'isolated_from_formal_artifacts':True,
                'retained_samples_expired':False, 'historical_results_preserved':True,
                'image_identity_constraint':'011_validated' if mock_identity_migration else 'legacy_data_references_checked'}
    if p3:
        evidence['p3'] = {name: int(scalar('SELECT count(*) FROM business.' + name)) for name in private_tables}
        evidence['p3']['accounting_archives'] = int(scalar('SELECT count(*) FROM business.model_call_accounting_archives')) if accounting_archives else 0
        evidence['p3'].update({'reference_checks': list(p3_reference_checks(assistant)),
            'unsubmitted_calls_canceled': True, 'uncertain_calls_not_retried': True,
            'uncertain_reservations_preserved': True, 'unfinished_turns_stale': True,
            'session_grants_revoked': True, 'fixture_grants_expired': True,
            'historical_text_and_mappings_preserved': True, 'can_resume_without_reauthorization': False})
    if attachments:
        evidence['p3']['attachment_reference_checks'] = list(attachment_reference_checks())
        evidence['p3']['attachment_parse_epochs_fenced'] = True
    if assistant:
        evidence['p3']['assistant_private_history_preserved'] = True
    if review:
        evidence['review'] = {'reference_checks': list(review_reference_checks()), 'unfinished_runs_stale': True, 'fixed_snapshots_preserved': True, 'field_filter_unknown_not_retried': True, 'can_resume_without_reauthorization': False}
    if checker_formal:
        evidence['checker_formal'] = {
            'reference_checks': list(checker_formal_reference_checks()),
            'counts': {name: int(scalar('SELECT count(*) FROM business.' + name)) for name in CHECKER_TABLES + FORMAL_TABLES},
            'unfinished_jobs_fenced': True, 'pending_submissions_stale': True,
            'unknown_calls_not_retried': True, 'can_resume_without_reauthorization': False,
        }
    if fixed_teams:
        evidence['fixed_review_teams'] = {'references_valid': True, 'count': int(scalar('SELECT count(*) FROM business.case_review_teams')), 'standing_authorization_preserved': True}
    if document_models:
        evidence['document_models'] = {'reference_checks': list(document_model_reference_checks(classification_inputs)), 'classification_inputs': classification_inputs, 'private_snapshots_preserved': True, 'unknown_calls_not_retried': True, 'can_resume_without_reauthorization': False}
    if document_recovery:
        evidence['document_recovery'] = {'reference_checks': list(document_recovery_reference_checks()), 'failure_history_preserved': True, 'automatic_retry_on_restore': False}
    if accounting:
        evidence['document_accounting'] = {'reference_checks': list(document_accounting_reference_checks()), 'immutable_prices_and_charges': True, 'original_reservations_preserved': True, 'unknown_reservations_retained': True, 'basis': 'usage_upper_bound_not_invoice'}
    if signatures:
        evidence['signatures'] = {'reference_checks': list(signature_reference_checks()), 'private_receipts_preserved': True, 'unknown_calls_not_retried': True, 'admission_queue_cleared': True, 'unfinished_jobs_stale': True, 'can_resume_without_reauthorization': False}
    if signature_information:
        evidence['signature_information'] = {'reference_checks': list(signature_information_reference_checks()), 'append_only_history_preserved': True, 'model_independent': True}
    if company:
        evidence['company_identity'] = {'reference_checks': list(company_reference_checks(company_public)), 'receipts_preserved': True, 'unknown_calls_not_retried': True, 'public_records_separate': company_public, 'automatic_lookup_on_restore': False}
    if region_ocr:
        evidence['region_ocr'] = {'reference_checks': list(region_ocr_reference_checks()), 'receipts_preserved': True, 'unknown_calls_not_retried': True, 'can_resume_without_reauthorization': False}
    return evidence


def verify(backup):
    run(['mountpoint', '-q', '/data'])
    backup = Path(backup).resolve(strict=True)
    if backup.parent != BASE / 'backups' or not (backup / 'complete.json').is_file():
        raise RuntimeError('A completed direct child of /data/hsbc/backups is required')
    os.umask(0o077)
    completion = json.loads((backup / 'complete.json').read_text())
    assert sha(backup / 'sha256.json') == completion['manifest_sha256']
    for name, digest in json.loads((backup / 'sha256.json').read_text()).items():
        assert Path(name).name == name and sha(backup / name) == digest
    container = 'hsbc-restore-' + uuid.uuid4().hex
    temporary = Path(tempfile.mkdtemp(prefix='restore-', dir=BASE / 'tmp'))
    try:
        with tarfile.open(backup / 'policies-and-deployment.tar.gz') as archive:
            for member in archive.getmembers():
                p = Path(member.name)
                if p.is_absolute() or '..' in p.parts or not (member.isfile() or member.isdir()):
                    raise RuntimeError('Unsafe backup archive member')
            archive.extractall(temporary, filter='data')
        # Restore with the versions captured by this backup, including after upgrades.
        lock = json.loads((temporary / 'deploy/versions.lock.json').read_text())
        # Independent network namespace, no host ports, no host PostgreSQL data mount.
        run(['docker', 'run', '-d', '--name', container, '--network', 'none',
            '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-v', str(temporary / 'pg') + ':/var/lib/postgresql',
            lock['images']['POSTGRES_IMAGE']['reference']])
        for attempt in range(60):
            # The image's temporary initialization server accepts Unix sockets
            # before it shuts down. TCP becomes available only on the final server.
            ready = subprocess.run(['docker', 'exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
            if ready.returncode == 0:
                break
            time.sleep(0.5)
        else:
            raise RuntimeError('Isolated PostgreSQL not ready')
        with (backup / 'roles.sql').open('rb') as source:
            run(['docker', 'exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], stdin=source)
        with (backup / 'database.dump').open('rb') as source:
            run(['docker', 'exec', '-i', container, 'pg_restore', '--exit-on-error', '--create',
                '-U', 'postgres', '-d', 'postgres'], stdin=source)
        query = "SELECT has_schema_privilege('hsbc_app','business','USAGE'), " \
            "has_schema_privilege('hsbc_app','checkpoint','USAGE'), " \
            "has_schema_privilege('hsbc_checkpoint','checkpoint','USAGE'), " \
            "has_schema_privilege('hsbc_checkpoint','business','USAGE');"
        restored = run(['docker', 'exec', container, 'psql', '-X', '-At', '-U', 'postgres', '-d', 'hsbc', '-c', query])
        assert restored.strip() == b't|f|t|f'
        def query(sql):
            return restore_sql(container, sql)

        application_evidence = verify_application(query)
        spec = importlib.util.spec_from_file_location('opa_manage', BASE / 'scripts/opa/manage.py')
        opa = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(opa)
        releases = json.loads((temporary / 'config/opa/approved.json').read_text())['releases']
        probes = 0
        for release in releases:
            directory = temporary / 'policies/releases' / release['release_id']
            metadata = opa.verify_artifact(directory)
            assert metadata['bundle_sha256'] == release['bundle_sha256']
            for probe in json.loads((directory / 'probes.json').read_text()):
                result = json.loads(run(['docker', 'run', '--rm', '-i', '--network', 'none', '--read-only',
                    '-v', str(directory / 'bundle.tar.gz') + ':/bundle.tar.gz:ro',
                    lock['images']['OPA_IMAGE']['reference'], 'eval', '--format=json', '--stdin-input',
                    '--bundle', '/bundle.tar.gz', 'data.hsbc.releases.' + release['release_id'] + '.decision'],
                    input=json.dumps(probe['input']).encode()))
                expressions = result.get('result', [])
                if probe.get('undefined'):
                    assert not expressions
                else:
                    assert expressions[0]['expressions'][0]['value'] == probe['result']
                probes += 1
        evidence = {'ok': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'backup': backup.name, 'postgres_roles_and_database_restored': True,
            'rules_releases': [r['release_id'] for r in releases], 'restored_rule_probes': probes,
            'oss_restore_verified': False, 'business_data_tested': False,
            'p1': application_evidence.get('p1'), 'p2': application_evidence.get('p2'), 'p3': application_evidence.get('p3'),
            'review': application_evidence.get('review'), 'document_models': application_evidence.get('document_models'),
            'checker_formal': application_evidence.get('checker_formal'),
            'fixed_review_teams': application_evidence.get('fixed_review_teams'),
            'signatures': application_evidence.get('signatures'), 'company_identity': application_evidence.get('company_identity'),
            'region_ocr': application_evidence.get('region_ocr'),
            'document_accounting': application_evidence.get('document_accounting')}
        (backup / 'restore-verification.json').write_text(json.dumps(evidence, indent=2) + '\n')
        print(json.dumps(evidence))
    finally:
        subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        # Immutable release copies can be read-only: only change this disposable tree.
        for path in temporary.rglob('*'):
            if path.is_dir():
                path.chmod(0o700)
        shutil.rmtree(temporary)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: verify-backup.py /data/hsbc/backups/COMPLETED_BACKUP')
    verify(sys.argv[1])
