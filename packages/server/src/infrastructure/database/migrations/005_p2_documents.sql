-- Additive document processing schema. Historical parked intents remain parked.
ALTER TABLE business.document_versions DROP CONSTRAINT document_versions_parse_status_check;
ALTER TABLE business.document_versions ADD CONSTRAINT document_versions_parse_status_check
  CHECK (parse_status IN ('capability_disabled','pending','running','ready','partial','failed','canceled','stale'));
ALTER TABLE business.parse_intents DROP CONSTRAINT parse_intents_state_check;
ALTER TABLE business.parse_intents ADD CONSTRAINT parse_intents_state_check
  CHECK (state IN ('capability_disabled','pending','running','ready','partial','failed','canceled','stale'));
ALTER TABLE business.work_items DROP CONSTRAINT work_items_owner_type_check;
ALTER TABLE business.work_items ADD CONSTRAINT work_items_owner_type_check
  CHECK (owner_type IN ('UploadSession','ModelCall','Workflow','DocumentJob'));

CREATE TABLE business.document_configurations (
  id text PRIMARY KEY, sha256 text NOT NULL, manifest jsonb NOT NULL,
  synthetic boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE business.document_jobs (
  id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES business.cases(id),
  document_version_id uuid NOT NULL REFERENCES business.document_versions(id),
  kind text NOT NULL CHECK(kind IN ('parse_document','extract_fields','compare_document_versions')),
  account_id uuid NOT NULL, person_id uuid NOT NULL, auth_version integer NOT NULL,
  expected_revision integer NOT NULL, required_action text NOT NULL,
  configuration_release_id text NOT NULL REFERENCES business.document_configurations(id),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','ready','partial','failed','canceled','stale')),
  validity text NOT NULL DEFAULT 'current' CHECK(validity IN ('current','superseded','stale')),
  input jsonb NOT NULL DEFAULT '{}', result jsonb, error_code text,
  completed_pages integer NOT NULL DEFAULT 0, total_pages integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_jobs_case ON business.document_jobs(case_id,created_at);
ALTER TABLE business.document_versions ADD COLUMN current_parse_job_id uuid REFERENCES business.document_jobs(id);
CREATE TABLE business.document_pages (
  job_id uuid NOT NULL REFERENCES business.document_jobs(id), page_number integer NOT NULL CHECK(page_number>0),
  page_asset_id text NOT NULL UNIQUE, body jsonb NOT NULL,
  image_key text NOT NULL, image_version_id text NOT NULL CHECK(image_version_id NOT IN ('','null')),
  image_sha256 text NOT NULL, json_key text NOT NULL, json_version_id text NOT NULL CHECK(json_version_id NOT IN ('','null')),
  json_sha256 text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,page_number)
);
CREATE TABLE business.document_artifacts (
  id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES business.document_jobs(id),
  directory_revision integer NOT NULL CHECK(directory_revision>0),
  body jsonb NOT NULL, object_key text NOT NULL, oss_version_id text NOT NULL CHECK(oss_version_id NOT IN ('','null')),
  sha256 text NOT NULL, created_by uuid NOT NULL, reason text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(job_id,directory_revision)
);
CREATE TABLE business.document_tool_delegations (
  id uuid PRIMARY KEY, service_id text NOT NULL, account_id uuid NOT NULL, person_id uuid NOT NULL,
  auth_version integer NOT NULL, case_id uuid NOT NULL REFERENCES business.cases(id),
  case_revision integer NOT NULL, actions text[] NOT NULL, document_ids uuid[] NOT NULL,
  revoked boolean NOT NULL DEFAULT false, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Configuration content is immutable; a different manifest needs a new ID.
CREATE FUNCTION business.reject_document_configuration_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable_document_configuration'; END $$;
CREATE TRIGGER immutable_document_configuration BEFORE UPDATE OR DELETE ON business.document_configurations
  FOR EACH ROW EXECUTE FUNCTION business.reject_document_configuration_change();
REVOKE ALL ON FUNCTION business.reject_document_configuration_change() FROM PUBLIC;
