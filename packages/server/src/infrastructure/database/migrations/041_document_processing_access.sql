-- Case approvals extend only a separately enabled, existing public/synthetic policy.
CREATE TABLE business.document_processing_access (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES business.cases(id),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  state text NOT NULL CHECK(state IN ('pending','approved','rejected','revoked')),
  policy_hash text NOT NULL CHECK(length(policy_hash)=64),
  configuration_release_id text NOT NULL,
  requester_account_id uuid NOT NULL,
  requester_person_id uuid NOT NULL,
  requester_auth_version integer NOT NULL,
  request_reason text NOT NULL CHECK(length(request_reason) BETWEEN 1 AND 500),
  include_future_materials boolean NOT NULL,
  documents jsonb NOT NULL CHECK(jsonb_typeof(documents)='array'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decider_account_id uuid,
  decider_person_id uuid,
  decider_auth_version integer,
  decision_reason text CHECK(length(decision_reason) BETWEEN 1 AND 500),
  decided_at timestamptz,
  revoked_at timestamptz,
  CHECK(state<>'approved' OR (decider_person_id IS NOT NULL AND decider_person_id<>requester_person_id AND decided_at IS NOT NULL)),
  CHECK(expires_at>created_at)
);
CREATE INDEX document_processing_access_case ON business.document_processing_access(case_id,created_at DESC);
CREATE UNIQUE INDEX document_processing_access_pending ON business.document_processing_access(case_id) WHERE state='pending';
CREATE UNIQUE INDEX document_processing_access_approved ON business.document_processing_access(case_id) WHERE state='approved';
REVOKE ALL ON business.document_processing_access FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT,UPDATE ON business.document_processing_access TO hsbc_p1_api;
GRANT SELECT ON business.document_processing_access TO hsbc_p1_worker;
