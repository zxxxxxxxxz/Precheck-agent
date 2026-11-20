-- 033 remains reserved by unrelated unfinished work. Additive signature reviews.
ALTER TABLE business.document_jobs DROP CONSTRAINT document_jobs_kind_check;
ALTER TABLE business.document_jobs ADD CONSTRAINT document_jobs_kind_check CHECK(kind IN ('parse_document','extract_fields','compare_document_versions','review_signatures'));
CREATE TABLE business.signature_review_snapshots (
 job_id uuid PRIMARY KEY REFERENCES business.document_jobs(id), input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE business.signature_page_receipts (
 job_id uuid NOT NULL REFERENCES business.document_jobs(id),page_number integer NOT NULL CHECK(page_number>0),body jsonb NOT NULL,body_hash text NOT NULL CHECK(body_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(job_id,page_number)
);
CREATE TABLE business.signature_model_calls (
 id uuid PRIMARY KEY,job_id uuid NOT NULL REFERENCES business.document_jobs(id),request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),state text NOT NULL CHECK(state IN ('unknown','completed','failed')),response jsonb,error_code text,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 UNIQUE(job_id,request_hash),CHECK((state='completed')=(response IS NOT NULL))
);
CREATE TABLE business.signature_confirmations (
 id uuid PRIMARY KEY,job_id uuid NOT NULL REFERENCES business.document_jobs(id),case_id uuid NOT NULL REFERENCES business.cases(id),case_revision integer NOT NULL,input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signature_confirmations_review ON business.signature_confirmations(job_id,created_at,id);
CREATE TABLE business.private_inference_queue (
 id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN ('text','vision')),queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL
);
CREATE INDEX private_inference_queue_priority_idx ON business.private_inference_queue(kind,queued_at);
CREATE TRIGGER immutable_signature_snapshot BEFORE UPDATE ON business.signature_review_snapshots FOR EACH ROW EXECUTE FUNCTION business.protect_review_history();
CREATE TRIGGER immutable_signature_page BEFORE UPDATE ON business.signature_page_receipts FOR EACH ROW EXECUTE FUNCTION business.protect_review_history();
CREATE TRIGGER immutable_signature_confirmation BEFORE UPDATE ON business.signature_confirmations FOR EACH ROW EXECUTE FUNCTION business.protect_review_history();
CREATE FUNCTION business.protect_signature_model_call() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state<>'unknown' OR (to_jsonb(OLD)-ARRAY['state','response','error_code','completed_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','response','error_code','completed_at']) THEN RAISE EXCEPTION 'immutable_signature_model_call';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_signature_model_call BEFORE UPDATE ON business.signature_model_calls FOR EACH ROW EXECUTE FUNCTION business.protect_signature_model_call();
REVOKE ALL ON business.signature_review_snapshots,business.signature_page_receipts,business.signature_model_calls,business.signature_confirmations,business.private_inference_queue FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT ON business.signature_review_snapshots,business.signature_confirmations TO hsbc_p1_api;
GRANT SELECT ON business.signature_page_receipts TO hsbc_p1_api;
GRANT SELECT ON business.signature_review_snapshots,business.signature_confirmations TO hsbc_p1_worker;
GRANT SELECT,INSERT ON business.signature_page_receipts TO hsbc_p1_worker;
GRANT SELECT,INSERT,UPDATE ON business.signature_model_calls TO hsbc_p1_worker;
GRANT SELECT,INSERT,DELETE ON business.private_inference_queue TO hsbc_p1_api,hsbc_p1_worker;
REVOKE ALL ON FUNCTION business.protect_signature_model_call() FROM PUBLIC;
