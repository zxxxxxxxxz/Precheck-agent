-- A request is recorded before private OCR dispatch. Absence of an immutable
-- receipt means unknown execution and never authorizes another dispatch.
CREATE TABLE business.document_region_ocr_requests (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES business.document_jobs(id),
  page_number integer NOT NULL CHECK(page_number>0),
  crop_id text NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id,crop_id)
);
CREATE TABLE business.document_region_ocr_receipts (
  request_id uuid PRIMARY KEY REFERENCES business.document_region_ocr_requests(id),
  body_hash text NOT NULL CHECK(body_hash ~ '^[a-f0-9]{64}$'),
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_region_ocr_budget ON business.document_region_ocr_requests(job_id,page_number);
CREATE TRIGGER immutable_document_region_ocr_request BEFORE UPDATE OR DELETE ON business.document_region_ocr_requests
  FOR EACH ROW EXECUTE FUNCTION business.reject_document_configuration_change();
CREATE TRIGGER immutable_document_region_ocr_receipt BEFORE UPDATE OR DELETE ON business.document_region_ocr_receipts
  FOR EACH ROW EXECUTE FUNCTION business.reject_document_configuration_change();
REVOKE ALL ON business.document_region_ocr_requests,business.document_region_ocr_receipts
  FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT ON business.document_region_ocr_requests,business.document_region_ocr_receipts TO hsbc_p1_worker;
