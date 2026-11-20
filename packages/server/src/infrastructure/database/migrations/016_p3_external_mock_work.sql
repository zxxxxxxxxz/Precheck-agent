-- Complete the external-RM transition for the independent P2 validation queue.
-- Append to 012; never rewrite an applied migration or historical results.
DO $$
DECLARE target record;
BEGIN
  FOR target IN SELECT id FROM auth.people WHERE business_role='RM' ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('p1-person:'||target.id::text,0));
    UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL,error_code='identity_revoked',updated_at=now()
      WHERE owner_type='MockValidationJob' AND state IN ('pending','running')
        AND owner_id IN (SELECT id FROM business.mock_validation_jobs WHERE person_id=target.id);
    UPDATE business.mock_validation_jobs SET state='canceled',error_code='identity_revoked',updated_at=now()
      WHERE person_id=target.id AND state IN ('pending','running');
    IF FOUND THEN
      INSERT INTO business.audit_events(id,target_id,action,result,details)
        VALUES(gen_random_uuid(),target.id::text,'person.external_mock_work_revoked','success','{"migration":"016_p3_external_mock_work"}'::jsonb);
    END IF;
  END LOOP;
END $$;
