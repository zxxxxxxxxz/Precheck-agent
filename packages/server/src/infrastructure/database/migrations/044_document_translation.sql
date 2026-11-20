-- Chinese reference translations are independent derived evidence, not review decisions.
ALTER TABLE business.document_jobs DROP CONSTRAINT document_jobs_kind_check;
ALTER TABLE business.document_jobs ADD CONSTRAINT document_jobs_kind_check
  CHECK(kind IN ('parse_document','extract_fields','compare_document_versions','review_signatures','translate_document'));

CREATE TABLE business.document_translation_snapshots (
  job_id uuid PRIMARY KEY REFERENCES business.document_jobs(id) ON DELETE CASCADE,
  input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'), body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_translation_snapshot_input ON business.document_translation_snapshots(input_hash);
CREATE TABLE business.document_translation_segments (
  job_id uuid NOT NULL REFERENCES business.document_jobs(id) ON DELETE CASCADE, chunk_id text NOT NULL,
  body jsonb NOT NULL, body_hash text NOT NULL CHECK(body_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(job_id,chunk_id)
);
CREATE TABLE business.document_translation_calls (
  id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES business.document_jobs(id) ON DELETE CASCADE,
  chunk_id text NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN ('unknown','completed','failed')), response jsonb, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE(job_id,chunk_id), CHECK((state='completed')=(response IS NOT NULL))
);
CREATE TRIGGER immutable_document_translation_snapshot BEFORE UPDATE ON business.document_translation_snapshots
  FOR EACH ROW EXECUTE FUNCTION business.protect_review_history();
CREATE TRIGGER immutable_document_translation_segment BEFORE UPDATE ON business.document_translation_segments
  FOR EACH ROW EXECUTE FUNCTION business.protect_review_history();
CREATE FUNCTION business.protect_document_translation_call() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state<>'unknown' OR
     (to_jsonb(OLD)-ARRAY['state','response','error_code','completed_at']) IS DISTINCT FROM
     (to_jsonb(NEW)-ARRAY['state','response','error_code','completed_at']) THEN
    RAISE EXCEPTION 'immutable_document_translation_call';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_document_translation_call BEFORE UPDATE ON business.document_translation_calls
  FOR EACH ROW EXECUTE FUNCTION business.protect_document_translation_call();
REVOKE ALL ON business.document_translation_snapshots,business.document_translation_segments,business.document_translation_calls
  FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT ON business.document_translation_snapshots TO hsbc_p1_api;
GRANT SELECT ON business.document_translation_segments TO hsbc_p1_api;
GRANT SELECT(job_id,state) ON business.document_translation_calls TO hsbc_p1_api;
GRANT SELECT ON business.document_translation_snapshots TO hsbc_p1_worker;
GRANT SELECT,INSERT ON business.document_translation_segments TO hsbc_p1_worker;
GRANT SELECT,INSERT,UPDATE ON business.document_translation_calls TO hsbc_p1_worker;
REVOKE ALL ON FUNCTION business.protect_document_translation_call() FROM PUBLIC;
