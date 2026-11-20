-- Immutable output versions; no changes to review decisions or business rounds.
CREATE TABLE business.review_mail_drafts (
 id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES business.cases(id),
 run_id uuid NOT NULL REFERENCES business.review_runs(id), round_id uuid REFERENCES business.review_rounds(id),
 version integer NOT NULL CHECK(version>0), format text NOT NULL CHECK(format IN ('rounds','documents')),
 source_hash text NOT NULL, body jsonb NOT NULL, body_hash text NOT NULL,
 included_reply_ids uuid[] NOT NULL DEFAULT '{}', created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(case_id,version)
);
CREATE TRIGGER immutable_review_mail_draft BEFORE UPDATE ON business.review_mail_drafts
 FOR EACH ROW EXECUTE FUNCTION business.protect_review_history();
REVOKE ALL ON business.review_mail_drafts FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT ON business.review_mail_drafts TO hsbc_p1_api;
GRANT SELECT ON business.review_mail_drafts TO hsbc_p1_worker;
-- Administrators may explicitly assign these new output rights. No business rights are auto-granted.
WITH added AS (
 INSERT INTO business.grant_authorities(person_id,action,case_id)
 SELECT DISTINCT g.person_id,a.action,g.case_id FROM business.grant_authorities g JOIN auth.people p ON p.id=g.person_id
 CROSS JOIN (VALUES('report:read'),('report:generate'),('report:export')) a(action)
 WHERE g.action='finding:decide' AND p.enabled AND p.business_role IS NULL
 AND EXISTS(SELECT 1 FROM auth.accounts a WHERE a.person_id=p.id AND a.enabled)
 AND EXISTS(SELECT 1 FROM business.access_grants a WHERE a.person_id=p.id AND a.action='permission:manage' AND a.case_id IS NULL AND NOT a.revoked)
 AND NOT EXISTS(SELECT 1 FROM business.grant_authorities x
 WHERE x.person_id=g.person_id AND x.action=a.action AND x.case_id IS NOT DISTINCT FROM g.case_id)
 RETURNING person_id,action,case_id
)
INSERT INTO business.audit_events(id,target_id,action,result,details)
 SELECT gen_random_uuid(),person_id::text,'permission.authority_catalog_extended','success',
 jsonb_build_object('migration','045_review_delivery','scopes',jsonb_agg(jsonb_build_object('action',action,'caseId',case_id))) FROM added GROUP BY person_id;
