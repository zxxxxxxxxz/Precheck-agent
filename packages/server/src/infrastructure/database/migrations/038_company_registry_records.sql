-- Public supplier records contain no case, draft, role, query, or confirmation relationship.
-- Case-bound query cache/receipts remain in the independent 037 tables.
CREATE TABLE business.company_registry_records (
 lei text NOT NULL CHECK(lei ~ '^[A-Z0-9]{18}[0-9]{2}$'),
 record_hash text NOT NULL CHECK(record_hash ~ '^[a-f0-9]{64}$'),
 fetched_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 source_data_version text,client_version text NOT NULL,body jsonb NOT NULL,
 PRIMARY KEY(lei,record_hash,fetched_at)
);
CREATE INDEX company_registry_records_current ON business.company_registry_records(lei,expires_at DESC);
CREATE TRIGGER immutable_company_registry_record BEFORE UPDATE ON business.company_registry_records
 FOR EACH ROW EXECUTE FUNCTION business.protect_review_history();
REVOKE ALL ON business.company_registry_records FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT ON business.company_registry_records TO hsbc_p1_api;
