-- Classification and extraction have independent immutable privacy inputs.
-- Existing extraction snapshots/receipts are deliberately not rewritten.
CREATE TABLE business.document_classification_inputs (
  job_id uuid PRIMARY KEY REFERENCES business.document_jobs(id),
  input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  projection_hash text NOT NULL CHECK(projection_hash ~ '^[a-f0-9]{64}$'),
  projection jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_document_classification_input BEFORE UPDATE OR DELETE ON business.document_classification_inputs
  FOR EACH ROW EXECUTE FUNCTION business.reject_document_configuration_change();
REVOKE ALL ON business.document_classification_inputs FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT ON business.document_classification_inputs TO hsbc_p1_worker;
