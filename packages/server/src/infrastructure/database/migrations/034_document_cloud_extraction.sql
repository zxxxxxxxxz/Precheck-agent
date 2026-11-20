-- 033 is reserved by an unrelated, unfinished branch. Do not rewrite its work.
-- Private snapshots and per-dispatch receipts for the explicit document purpose.
CREATE TABLE business.document_model_snapshots (
  job_id uuid PRIMARY KEY REFERENCES business.document_jobs(id),
  input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  projection_hash text NOT NULL CHECK(projection_hash ~ '^[a-f0-9]{64}$'),
  projection jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE business.document_model_calls (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES business.document_jobs(id),
  step_key text NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  channel text NOT NULL CHECK(channel IN ('private','cloud')),
  model text NOT NULL,
  policy_version text,
  policy_hash text,
  approved_by uuid NOT NULL REFERENCES auth.accounts(id),
  reserved_micros bigint NOT NULL CHECK(reserved_micros > 0),
  state text NOT NULL CHECK(state IN ('unknown','completed','failed')),
  response jsonb,
  error_code text,
  error_diagnostic text,
  usage jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(job_id,step_key,request_hash),
  CHECK((state='completed')=(response IS NOT NULL)),
  CHECK(channel<>'cloud' OR (policy_version IS NOT NULL AND policy_hash ~ '^[a-f0-9]{64}$'))
);
CREATE INDEX document_model_calls_budget ON business.document_model_calls(channel,created_at);
CREATE FUNCTION business.protect_document_model_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state<>'unknown' OR
    (to_jsonb(OLD)-ARRAY['state','response','error_code','error_diagnostic','usage','completed_at']) IS DISTINCT FROM
    (to_jsonb(NEW)-ARRAY['state','response','error_code','error_diagnostic','usage','completed_at']) THEN
    RAISE EXCEPTION 'immutable_document_model_receipt';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_document_model_receipt BEFORE UPDATE ON business.document_model_calls
  FOR EACH ROW EXECUTE FUNCTION business.protect_document_model_receipt();
CREATE TRIGGER immutable_document_model_snapshot BEFORE UPDATE OR DELETE ON business.document_model_snapshots
  FOR EACH ROW EXECUTE FUNCTION business.reject_document_configuration_change();
REVOKE ALL ON business.document_model_snapshots,business.document_model_calls FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT ON business.document_model_snapshots TO hsbc_p1_worker;
GRANT SELECT,INSERT,UPDATE ON business.document_model_calls TO hsbc_p1_worker;
REVOKE ALL ON FUNCTION business.protect_document_model_receipt() FROM PUBLIC;
