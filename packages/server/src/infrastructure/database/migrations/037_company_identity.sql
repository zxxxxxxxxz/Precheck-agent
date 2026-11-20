-- Independent company_lookup purpose. No document, model or field history is rewritten.
CREATE TABLE business.company_lookup_requests (
 id uuid PRIMARY KEY,case_id uuid NOT NULL REFERENCES business.cases(id),case_revision integer NOT NULL,
 account_id uuid NOT NULL,person_id uuid NOT NULL,auth_version integer NOT NULL,
 idempotency_key text NOT NULL,input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
 query_hash text NOT NULL CHECK(query_hash ~ '^[a-f0-9]{64}$'),policy_hash text NOT NULL,
 query jsonb NOT NULL,reason text NOT NULL,dispatched boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(case_id,account_id,idempotency_key)
);
CREATE INDEX company_lookup_request_budget ON business.company_lookup_requests(created_at) WHERE dispatched;
CREATE TABLE business.company_lookup_receipts (
 lookup_id uuid PRIMARY KEY REFERENCES business.company_lookup_requests(id),
 case_id uuid NOT NULL REFERENCES business.cases(id),body jsonb NOT NULL,
 body_hash text NOT NULL CHECK(body_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT now()
);
-- Query cache is case-isolated, including misses. It cannot reveal another case's queried subjects.
CREATE TABLE business.company_lookup_cache (
 case_id uuid NOT NULL REFERENCES business.cases(id),query_hash text NOT NULL,
 body jsonb NOT NULL,expires_at timestamptz NOT NULL,PRIMARY KEY(case_id,query_hash)
);
CREATE TRIGGER immutable_company_lookup_request BEFORE UPDATE ON business.company_lookup_requests
 FOR EACH ROW EXECUTE FUNCTION business.protect_review_history();
CREATE TRIGGER immutable_company_lookup_receipt BEFORE UPDATE ON business.company_lookup_receipts
 FOR EACH ROW EXECUTE FUNCTION business.protect_review_history();
REVOKE ALL ON business.company_lookup_requests,business.company_lookup_receipts,business.company_lookup_cache FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT ON business.company_lookup_requests,business.company_lookup_receipts TO hsbc_p1_api;
GRANT SELECT,INSERT,UPDATE ON business.company_lookup_cache TO hsbc_p1_api;
-- Worker may read immutable selected receipts for fixed review snapshots, never initiate a lookup.
GRANT SELECT ON business.company_lookup_receipts TO hsbc_p1_worker;
