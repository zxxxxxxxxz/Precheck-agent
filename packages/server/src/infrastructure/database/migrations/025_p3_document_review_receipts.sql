-- DOC A2A emits only references to the fixed review input. PG remains the owner
-- of workflow recovery; no raw material is copied into protocol messages.
CREATE TABLE business.review_document_receipts (
  run_id uuid PRIMARY KEY REFERENCES business.review_runs(id),
  snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON business.review_document_receipts FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT ON business.review_document_receipts TO hsbc_p1_api;
GRANT SELECT,INSERT ON business.review_document_receipts TO hsbc_p1_worker;
