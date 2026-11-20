CREATE TABLE business.upload_sessions (
  id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES business.cases(id),
  account_id uuid NOT NULL, person_id uuid NOT NULL, auth_version integer NOT NULL,
  expected_revision integer NOT NULL, filename text NOT NULL, expected_size bigint NOT NULL CHECK(expected_size > 0),
  object_key text NOT NULL UNIQUE, oss_version_id text,
  state text NOT NULL CHECK(state IN ('issued','verifying','registered','rejected','expired','canceled')),
  idempotency_key text NOT NULL, request_hash text NOT NULL, error_code text, document_version_id uuid,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  cleanup_checked_at timestamptz,
  UNIQUE(account_id, idempotency_key)
);
CREATE INDEX upload_reconcile ON business.upload_sessions(state, expires_at);
CREATE TABLE business.document_versions (
  id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES business.cases(id),
  upload_session_id uuid NOT NULL UNIQUE REFERENCES business.upload_sessions(id),
  filename text NOT NULL, size bigint NOT NULL, sha256 text NOT NULL, page_count integer NOT NULL,
  object_key text NOT NULL, oss_version_id text NOT NULL CHECK(oss_version_id <> 'null' AND oss_version_id <> ''),
  uploaded_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  parse_status text NOT NULL DEFAULT 'capability_disabled' CHECK(parse_status = 'capability_disabled'),
  UNIQUE(object_key, oss_version_id)
);
CREATE INDEX document_versions_case ON business.document_versions(case_id,created_at);
CREATE TABLE business.parse_intents (
  document_version_id uuid PRIMARY KEY REFERENCES business.document_versions(id),
  state text NOT NULL DEFAULT 'capability_disabled' CHECK(state = 'capability_disabled'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE business.work_items (
  id uuid PRIMARY KEY, owner_type text NOT NULL CHECK(owner_type IN ('UploadSession','ModelCall','Workflow')),
  owner_id uuid NOT NULL, kind text NOT NULL, queue text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','succeeded','rejected','canceled')),
  epoch integer NOT NULL DEFAULT 0, attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5,
  available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
  error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_type,owner_id,kind)
);
CREATE INDEX work_items_pending ON business.work_items(queue,state,available_at);
CREATE TABLE business.outbox (
  id uuid PRIMARY KEY, work_item_id uuid REFERENCES business.work_items(id),
  event_type text NOT NULL, owner_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz,
  UNIQUE(work_item_id,event_type)
);
CREATE TABLE business.inbox (
  work_item_id uuid PRIMARY KEY REFERENCES business.work_items(id),
  epoch integer NOT NULL, completed_at timestamptz NOT NULL DEFAULT now()
);
