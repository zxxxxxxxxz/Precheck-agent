-- Completion of the pre-review workflow only; never a Checker/business approval.
ALTER TABLE business.cases ADD COLUMN closed_at timestamptz;
ALTER TABLE business.cases ADD COLUMN closed_by uuid;
ALTER TABLE business.cases ADD COLUMN closure_reason text;
ALTER TABLE business.cases ADD COLUMN closed_round_id uuid;
ALTER TABLE business.cases ADD COLUMN closed_run_id uuid REFERENCES business.review_runs(id);
ALTER TABLE business.cases ADD COLUMN closure_receipt jsonb;
ALTER TABLE business.cases ADD CONSTRAINT closure_round_case FOREIGN KEY(id,closed_round_id) REFERENCES business.review_rounds(case_id,id);
ALTER TABLE business.cases ADD CONSTRAINT complete_closure_receipt CHECK(
 (closed_at IS NULL AND closed_by IS NULL AND closure_reason IS NULL AND closed_round_id IS NULL AND closed_run_id IS NULL AND closure_receipt IS NULL)
 OR (closed_at IS NOT NULL AND closed_by IS NOT NULL AND length(trim(closure_reason))>0 AND closed_run_id IS NOT NULL AND closure_receipt IS NOT NULL));
CREATE FUNCTION business.protect_closed_case() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.closed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'case_closed'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_closed_case BEFORE UPDATE ON business.cases FOR EACH ROW EXECUTE FUNCTION business.protect_closed_case();
REVOKE ALL ON FUNCTION business.protect_closed_case() FROM PUBLIC;

-- Extend only the delegation ceiling of existing technical permission managers.
-- No person receives the business action case:close implicitly.
WITH added AS (
 INSERT INTO business.grant_authorities(person_id,action,case_id)
 SELECT g.person_id,'case:close',g.case_id FROM business.grant_authorities g JOIN auth.people p ON p.id=g.person_id
 WHERE g.action='case:start' AND p.enabled AND p.business_role IS NULL
   AND EXISTS(SELECT 1 FROM auth.accounts a WHERE a.person_id=p.id AND a.enabled)
   AND EXISTS(SELECT 1 FROM business.access_grants a WHERE a.person_id=p.id AND a.action='permission:manage' AND a.case_id IS NULL AND NOT a.revoked)
 ON CONFLICT DO NOTHING RETURNING person_id,case_id
)
INSERT INTO business.audit_events(id,target_id,action,result,details)
 SELECT gen_random_uuid(),person_id::text,'permission.authority_catalog_extended','success',
 jsonb_build_object('migration','043_case_pre_review_closure','action','case:close','scopes',jsonb_agg(case_id)) FROM added GROUP BY person_id;
