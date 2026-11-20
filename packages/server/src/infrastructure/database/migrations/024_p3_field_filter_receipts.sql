-- Field filtering remains a DocumentJob. Persist the private-model call budget
-- and successful batches so a Worker restart cannot reset or silently resend it.
CREATE TABLE business.field_filter_calls (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES business.document_jobs(id) ON DELETE CASCADE,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN ('unknown','completed','failed')),
  response jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((state='completed') = (response IS NOT NULL))
);
CREATE INDEX field_filter_calls_job ON business.field_filter_calls(job_id,request_hash,created_at);
REVOKE ALL ON business.field_filter_calls FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT ON business.field_filter_calls TO hsbc_p1_api;
GRANT SELECT,INSERT,UPDATE ON business.field_filter_calls TO hsbc_p1_worker;
ALTER TABLE business.document_versions DROP CONSTRAINT document_versions_parse_status_check;
ALTER TABLE business.document_versions ADD CONSTRAINT document_versions_parse_status_check
  CHECK(parse_status IN ('capability_disabled','configuration_required','pending','running','ready','partial','failed','canceled','stale'));
ALTER TABLE business.parse_intents DROP CONSTRAINT parse_intents_state_check;
ALTER TABLE business.parse_intents ADD CONSTRAINT parse_intents_state_check
  CHECK(state IN ('capability_disabled','configuration_required','pending','running','ready','partial','failed','canceled','stale'));
