-- RM remains a historical/external role. Existing people, authorship and case
-- assignments are preserved; no business qualification is inferred or granted.
DO $$
DECLARE target record;
BEGIN
  FOR target IN SELECT id FROM auth.people WHERE business_role='RM' ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('p1-person:'||target.id::text,0));
    INSERT INTO auth.session_revocations(sid)
      SELECT sid FROM auth.sessions WHERE sess::jsonb->'p1'->'login'->>'personId'=target.id::text
      ON CONFLICT DO NOTHING;
    DELETE FROM auth.sessions WHERE sess::jsonb->'p1'->'login'->>'personId'=target.id::text;
    UPDATE auth.accounts SET enabled=false,session_epoch=session_epoch+1 WHERE person_id=target.id;
    UPDATE business.access_grants SET revoked=true WHERE person_id=target.id AND NOT revoked;
    DELETE FROM business.grant_authorities WHERE person_id=target.id;
    UPDATE business.document_tool_delegations SET revoked=true WHERE person_id=target.id AND NOT revoked;
    UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL,error_code='identity_revoked',updated_at=now()
      WHERE state IN ('pending','running') AND owner_id IN (
        SELECT id FROM business.upload_sessions WHERE person_id=target.id
        UNION SELECT id FROM business.document_jobs WHERE person_id=target.id);
    UPDATE business.upload_sessions SET state='rejected',error_code='identity_revoked',updated_at=now()
      WHERE person_id=target.id AND state IN ('issued','verifying');
    UPDATE business.document_jobs SET state='canceled',validity='stale',error_code='identity_revoked',updated_at=now()
      WHERE person_id=target.id AND state IN ('pending','running');
    INSERT INTO business.audit_events(id,target_id,action,result,details)
      VALUES(gen_random_uuid(),target.id::text,'person.external_role_migrated','success',
        '{"migration":"012_p3_maker_identity","reason":"RM is an external collaborator; historical records preserved"}'::jsonb);
  END LOOP;
END $$;

-- Source attribution is separate from the authenticated uploader. Existing
-- material provenance is unknown unless evidence explicitly records it.
ALTER TABLE business.upload_sessions ADD COLUMN source_kind text NOT NULL DEFAULT 'unknown'
  CHECK(source_kind IN ('maker','external_rm','unknown'));
ALTER TABLE business.upload_sessions ADD COLUMN source_label text CHECK(char_length(source_label)<=200);
ALTER TABLE business.document_versions ADD COLUMN source_kind text NOT NULL DEFAULT 'unknown'
  CHECK(source_kind IN ('maker','external_rm','unknown'));
ALTER TABLE business.document_versions ADD COLUMN source_label text CHECK(char_length(source_label)<=200);
