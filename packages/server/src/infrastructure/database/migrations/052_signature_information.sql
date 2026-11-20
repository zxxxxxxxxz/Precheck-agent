-- Human signature information is independent of private vision jobs and receipts.
CREATE TABLE business.signature_information_records (
 id uuid PRIMARY KEY,case_id uuid NOT NULL REFERENCES business.cases(id),
 document_version_id uuid NOT NULL REFERENCES business.document_versions(id),
 round_id uuid REFERENCES business.review_rounds(id),parse_revision uuid NOT NULL REFERENCES business.document_jobs(id),
 directory_revision integer NOT NULL CHECK(directory_revision>0),version integer NOT NULL CHECK(version>0),
 input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),input jsonb NOT NULL,
 body jsonb NOT NULL,body_hash text NOT NULL CHECK(body_hash ~ '^[a-f0-9]{64}$'),
 evaluation jsonb NOT NULL,actor_id uuid NOT NULL,reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(document_version_id,version)
);
CREATE INDEX signature_information_case ON business.signature_information_records(case_id,round_id,document_version_id,version DESC);
CREATE TRIGGER immutable_signature_information BEFORE UPDATE OR DELETE ON business.signature_information_records
 FOR EACH ROW EXECUTE FUNCTION business.protect_review_history();
REVOKE ALL ON business.signature_information_records FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT ON business.signature_information_records TO hsbc_p1_api;
GRANT SELECT ON business.signature_information_records TO hsbc_p1_worker;
