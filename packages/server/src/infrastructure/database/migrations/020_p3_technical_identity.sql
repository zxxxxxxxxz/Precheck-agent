-- Technical accounts retain explicit administration grants, never dormant
-- business authority. Preserve people, enabled status, historical authorship,
-- case assignments and grant_authorities (the scope of permission management).
DO $$
DECLARE target record;
BEGIN
  FOR target IN SELECT id FROM auth.people WHERE business_role IS NULL ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('p1-person:'||target.id::text,0));
    INSERT INTO auth.session_revocations(sid)
      SELECT sid FROM auth.sessions WHERE sess::jsonb->'p1'->'login'->>'personId'=target.id::text
      ON CONFLICT DO NOTHING;
    DELETE FROM auth.sessions WHERE sess::jsonb->'p1'->'login'->>'personId'=target.id::text;
    UPDATE auth.accounts SET session_epoch=session_epoch+1 WHERE person_id=target.id;
    UPDATE business.model_session_grants SET revoked=true WHERE person_id=target.id AND NOT revoked;
    UPDATE business.access_grants SET revoked=true WHERE person_id=target.id AND NOT revoked
      AND action NOT IN ('account:manage','permission:manage','audit:read','system:status');
    UPDATE business.document_tool_delegations SET revoked=true WHERE person_id=target.id AND NOT revoked;

    UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL,error_code='identity_revoked',updated_at=now()
      WHERE state IN ('pending','running') AND (
        (owner_type='UploadSession' AND owner_id IN (SELECT id FROM business.upload_sessions WHERE person_id=target.id)) OR
        (owner_type='DocumentJob' AND owner_id IN (SELECT id FROM business.document_jobs WHERE person_id=target.id)) OR
        (owner_type='MockValidationJob' AND owner_id IN (SELECT id FROM business.mock_validation_jobs WHERE person_id=target.id)) OR
        (owner_type='ModelCall' AND owner_id IN (SELECT c.id FROM business.model_calls c JOIN business.intake_turns t ON t.id=c.turn_id WHERE t.owner_person_id=target.id)));
    UPDATE business.upload_sessions SET state='rejected',error_code='identity_revoked',updated_at=now()
      WHERE person_id=target.id AND state IN ('issued','verifying');
    UPDATE business.document_jobs SET state='canceled',validity='stale',error_code='identity_revoked',updated_at=now()
      WHERE person_id=target.id AND state IN ('pending','running');
    UPDATE business.mock_validation_jobs SET state='canceled',error_code='identity_revoked',updated_at=now()
      WHERE person_id=target.id AND state IN ('pending','running');

    -- P3 cannot issue work to a technical principal. Fence any pre-existing
    -- execution record defensively without releasing an uncertain send's cost.
    UPDATE business.model_budgets b SET reserved_micros=b.reserved_micros-r.amount FROM (
      SELECT c.profile_id,c.budget_day,sum(c.reserved_micros) AS amount
      FROM business.model_calls c JOIN business.intake_turns t ON t.id=c.turn_id
      WHERE t.owner_person_id=target.id AND c.sent_at IS NULL AND c.state IN ('pending','running','canceled')
        AND c.reserved_micros>0 GROUP BY c.profile_id,c.budget_day
    ) r WHERE b.profile_id=r.profile_id AND b.budget_day=r.budget_day;
    UPDATE business.model_calls c SET state=CASE WHEN c.sent_at IS NULL THEN 'canceled' ELSE 'unknown' END,
      reserved_micros=CASE WHEN c.sent_at IS NULL THEN 0 ELSE c.reserved_micros END,
      error_code='identity_revoked',updated_at=now()
      FROM business.intake_turns t WHERE t.id=c.turn_id AND t.owner_person_id=target.id
        AND c.state IN ('pending','running','sent','canceled');
    UPDATE business.intake_turns SET status='stale',error_code='identity_revoked',updated_at=now()
      WHERE owner_person_id=target.id AND status IN ('pending','running','unknown');
    UPDATE business.model_fixture_grants SET expires_at=LEAST(expires_at,now()) WHERE owner_person_id=target.id;
    INSERT INTO business.audit_events(id,target_id,action,result,details)
      VALUES(gen_random_uuid(),target.id::text,'person.technical_business_authority_revoked','success',
        '{"migration":"020_p3_technical_identity","reason":"Technical identities retain explicit administration grants only"}'::jsonb);
  END LOOP;
END $$;
