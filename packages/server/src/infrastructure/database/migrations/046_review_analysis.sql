-- Auxiliary tasks use the existing Workflow work items. No second business-round model.
CREATE TABLE business.review_analysis_jobs (
 id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES business.cases(id),kind text NOT NULL CHECK(kind IN ('semantic','comparison')),
 account_id uuid NOT NULL,person_id uuid NOT NULL,auth_version integer NOT NULL,session_key text,
 expected_revision integer NOT NULL,input_hash text NOT NULL,source_hash text NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','running','ready','partial','failed','canceled')),error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_analysis_case ON business.review_analysis_jobs(case_id,created_at DESC);
CREATE INDEX review_analysis_identity ON business.review_analysis_jobs(case_id,input_hash);
CREATE TABLE business.review_analysis_snapshots (
 job_id uuid PRIMARY KEY REFERENCES business.review_analysis_jobs(id),body jsonb NOT NULL,body_hash text NOT NULL
);
CREATE TABLE business.review_analysis_items (
 job_id uuid NOT NULL REFERENCES business.review_analysis_jobs(id),item_id text NOT NULL,body jsonb NOT NULL,body_hash text NOT NULL,PRIMARY KEY(job_id,item_id)
);
CREATE TABLE business.review_analysis_calls (
 id uuid PRIMARY KEY,job_id uuid NOT NULL REFERENCES business.review_analysis_jobs(id),item_id text NOT NULL,request_hash text NOT NULL,
 state text NOT NULL CHECK(state IN ('unknown','completed','failed')),response jsonb,error_code text,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 UNIQUE(job_id,item_id),CHECK((state='completed')=(response IS NOT NULL))
);
CREATE TRIGGER immutable_review_analysis_snapshot BEFORE UPDATE ON business.review_analysis_snapshots FOR EACH ROW EXECUTE FUNCTION business.protect_review_history();
CREATE TRIGGER immutable_review_analysis_item BEFORE UPDATE ON business.review_analysis_items FOR EACH ROW EXECUTE FUNCTION business.protect_review_history();
CREATE TRIGGER immutable_review_analysis_call BEFORE UPDATE ON business.review_analysis_calls FOR EACH ROW EXECUTE FUNCTION business.protect_document_translation_call();
REVOKE ALL ON business.review_analysis_jobs,business.review_analysis_snapshots,business.review_analysis_items,business.review_analysis_calls FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT,UPDATE ON business.review_analysis_jobs TO hsbc_p1_api;
GRANT SELECT,INSERT ON business.review_analysis_snapshots TO hsbc_p1_api;
GRANT SELECT ON business.review_analysis_items TO hsbc_p1_api;
GRANT SELECT(job_id,state) ON business.review_analysis_calls TO hsbc_p1_api;
GRANT SELECT,UPDATE ON business.review_analysis_jobs TO hsbc_p1_worker;
GRANT SELECT ON business.review_analysis_snapshots TO hsbc_p1_worker;
GRANT SELECT,INSERT ON business.review_analysis_items TO hsbc_p1_worker;
GRANT SELECT,INSERT,UPDATE ON business.review_analysis_calls TO hsbc_p1_worker;
WITH added AS (
 INSERT INTO business.grant_authorities(person_id,action,case_id)
 SELECT DISTINCT g.person_id,'review:analyze',g.case_id FROM business.grant_authorities g JOIN auth.people p ON p.id=g.person_id
 WHERE g.action='finding:decide' AND p.enabled AND p.business_role IS NULL
 AND EXISTS(SELECT 1 FROM auth.accounts a WHERE a.person_id=p.id AND a.enabled)
 AND EXISTS(SELECT 1 FROM business.access_grants a WHERE a.person_id=p.id AND a.action='permission:manage' AND a.case_id IS NULL AND NOT a.revoked)
 AND NOT EXISTS(SELECT 1 FROM business.grant_authorities x WHERE x.person_id=g.person_id AND x.action='review:analyze' AND x.case_id IS NOT DISTINCT FROM g.case_id)
 RETURNING person_id,case_id
)
INSERT INTO business.audit_events(id,target_id,action,result,details)
 SELECT gen_random_uuid(),person_id::text,'permission.authority_catalog_extended','success',jsonb_build_object('migration','046_review_analysis','action','review:analyze','scopes',jsonb_agg(case_id)) FROM added GROUP BY person_id;
