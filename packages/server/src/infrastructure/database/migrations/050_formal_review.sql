-- Formal review is purpose-bound; extraction, translation and assistant grants do not authorize it.
CREATE TABLE business.formal_review_jobs (
 id uuid PRIMARY KEY,case_id uuid NOT NULL REFERENCES business.cases(id),round_id uuid NOT NULL REFERENCES business.review_rounds(id),run_id uuid NOT NULL REFERENCES business.review_runs(id),
 account_id uuid NOT NULL,person_id uuid NOT NULL,auth_version integer NOT NULL,session_key text,
 snapshot_hash text NOT NULL,configuration_release_id text NOT NULL,profile_hash text NOT NULL,input_hash text NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','running','completed','failed','unknown','canceled','stale')),
 cancel_requested boolean NOT NULL DEFAULT false,error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX formal_review_run_identity ON business.formal_review_jobs(run_id,input_hash);
CREATE TABLE business.formal_review_snapshots(job_id uuid PRIMARY KEY REFERENCES business.formal_review_jobs(id),body jsonb NOT NULL,body_hash text NOT NULL);
CREATE TABLE business.formal_review_results(job_id uuid NOT NULL REFERENCES business.formal_review_jobs(id),check_id text NOT NULL,body jsonb NOT NULL,body_hash text NOT NULL,PRIMARY KEY(job_id,check_id));
CREATE TABLE business.formal_review_calls (
 id uuid PRIMARY KEY,job_id uuid NOT NULL REFERENCES business.formal_review_jobs(id),batch_key text NOT NULL,attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 2),
 payload_hash text NOT NULL,policy_hash text NOT NULL,profile_hash text NOT NULL,reserved_micros bigint NOT NULL CHECK(reserved_micros>=0),
 state text NOT NULL CHECK(state IN ('unknown','completed','failed')),response jsonb,error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,UNIQUE(job_id,batch_key,attempt)
);
CREATE TRIGGER formal_snapshot_immutable BEFORE UPDATE OR DELETE ON business.formal_review_snapshots FOR EACH ROW EXECUTE FUNCTION business.protect_review_history();
CREATE TRIGGER formal_result_immutable BEFORE UPDATE OR DELETE ON business.formal_review_results FOR EACH ROW EXECUTE FUNCTION business.protect_review_history();
CREATE TRIGGER formal_call_immutable BEFORE UPDATE ON business.formal_review_calls FOR EACH ROW EXECUTE FUNCTION business.protect_document_translation_call();
REVOKE ALL ON business.formal_review_jobs,business.formal_review_snapshots,business.formal_review_results,business.formal_review_calls FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT,UPDATE ON business.formal_review_jobs TO hsbc_p1_api;
GRANT SELECT,INSERT ON business.formal_review_snapshots TO hsbc_p1_api;
GRANT SELECT ON business.formal_review_results,business.formal_review_calls TO hsbc_p1_api;
GRANT SELECT,UPDATE ON business.formal_review_jobs TO hsbc_p1_worker;
GRANT SELECT ON business.formal_review_snapshots TO hsbc_p1_worker;
GRANT SELECT,INSERT ON business.formal_review_results TO hsbc_p1_worker;
GRANT SELECT,INSERT,UPDATE ON business.formal_review_calls TO hsbc_p1_worker;
WITH added AS (
 INSERT INTO business.grant_authorities(person_id,action,case_id)
 SELECT DISTINCT g.person_id,'review:formal',g.case_id FROM business.grant_authorities g JOIN auth.people p ON p.id=g.person_id
 WHERE g.action='case:start' AND p.enabled AND p.business_role IS NULL
 AND EXISTS(SELECT 1 FROM business.access_grants a WHERE a.person_id=p.id AND a.action='permission:manage' AND a.case_id IS NULL AND NOT a.revoked)
 AND NOT EXISTS(SELECT 1 FROM business.grant_authorities x WHERE x.person_id=g.person_id AND x.action='review:formal' AND x.case_id IS NOT DISTINCT FROM g.case_id) RETURNING person_id
)
INSERT INTO business.audit_events(id,target_id,action,result,details) SELECT gen_random_uuid(),person_id::text,'permission.authority_catalog_extended','success','{"migration":"050_formal_review","action":"review:formal"}' FROM added;

GRANT UPDATE(validity,version) ON business.checker_submissions TO hsbc_p1_worker;
