-- Synthetic overlays have a separate owner and persistence namespace. No FK points
-- from a canonical parse, field, artifact or index to these validation results.
ALTER TABLE business.work_items DROP CONSTRAINT work_items_owner_type_check;
ALTER TABLE business.work_items ADD CONSTRAINT work_items_owner_type_check
  CHECK(owner_type IN ('UploadSession','ModelCall','Workflow','DocumentJob','MockValidationJob'));
CREATE TABLE business.mock_validation_jobs (
  id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES business.cases(id),
  document_version_id uuid NOT NULL REFERENCES business.document_versions(id),
  source_parse_revision uuid NOT NULL, page_number integer NOT NULL CHECK(page_number>0),
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
  source_page_sha256 text NOT NULL CHECK(source_page_sha256 ~ '^[a-f0-9]{64}$'),
  source_page_key text NOT NULL, source_page_version_id text NOT NULL CHECK(source_page_version_id NOT IN ('','null')),
  width integer NOT NULL CHECK(width>0), height integer NOT NULL CHECK(height>0),
  account_id uuid NOT NULL, person_id uuid NOT NULL, auth_version integer NOT NULL,
  expected_revision integer NOT NULL CHECK(expected_revision>0), input jsonb NOT NULL,
  font_sha256 text NOT NULL CHECK(font_sha256 ~ '^[a-f0-9]{64}$'), font_family text NOT NULL,
  input_fingerprint text NOT NULL CHECK(input_fingerprint ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','ready','partial','failed','stale','canceled')),
  image_key text, image_version_id text, image_sha256 text,
  result jsonb, error_code text, created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(source_parse_revision,page_number) REFERENCES business.document_pages(job_id,page_number),
  CHECK((image_key IS NULL AND image_version_id IS NULL AND image_sha256 IS NULL) OR
    (image_key IS NOT NULL AND image_version_id NOT IN ('','null') AND image_sha256 ~ '^[a-f0-9]{64}$'))
);
CREATE INDEX mock_validation_jobs_document ON business.mock_validation_jobs(case_id,document_version_id,created_at);
CREATE FUNCTION business.reject_mock_input_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(OLD)-ARRAY['state','image_key','image_version_id','image_sha256','result','error_code','updated_at'])
     IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','image_key','image_version_id','image_sha256','result','error_code','updated_at'])
  THEN RAISE EXCEPTION 'immutable_mock_input'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_mock_input BEFORE UPDATE ON business.mock_validation_jobs
  FOR EACH ROW EXECUTE FUNCTION business.reject_mock_input_change();
REVOKE ALL ON FUNCTION business.reject_mock_input_change() FROM PUBLIC;
REVOKE ALL ON business.mock_validation_jobs FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT,UPDATE ON business.mock_validation_jobs TO hsbc_p1_api;
GRANT SELECT,UPDATE ON business.mock_validation_jobs TO hsbc_p1_worker;
