-- Explicit reuse of a pinned original. Each round gets independent parsing state.
ALTER TABLE business.upload_sessions ADD COLUMN source_document_version_id uuid REFERENCES business.document_versions(id);
ALTER TABLE business.document_versions ADD COLUMN source_document_version_id uuid REFERENCES business.document_versions(id);
ALTER TABLE business.upload_sessions DROP CONSTRAINT upload_sessions_object_key_key;
CREATE UNIQUE INDEX original_upload_object_key ON business.upload_sessions(object_key) WHERE source_document_version_id IS NULL;
ALTER TABLE business.document_versions DROP CONSTRAINT document_versions_object_key_oss_version_id_key;
CREATE UNIQUE INDEX original_document_object_version ON business.document_versions(object_key,oss_version_id) WHERE source_document_version_id IS NULL;
CREATE INDEX historical_document_source ON business.document_versions(case_id,round_id,source_document_version_id);

CREATE FUNCTION business.protect_historical_material() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source business.document_versions; source_number integer; target_number integer;
BEGIN
 IF TG_OP='UPDATE' AND OLD.source_document_version_id IS DISTINCT FROM NEW.source_document_version_id THEN
  RAISE EXCEPTION 'immutable_material_origin';
 END IF;
 IF NEW.source_document_version_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO source FROM business.document_versions WHERE id=NEW.source_document_version_id;
 SELECT number INTO source_number FROM business.review_rounds WHERE id=source.round_id AND state='locked';
 SELECT number INTO target_number FROM business.review_rounds WHERE id=NEW.round_id AND case_id=NEW.case_id;
 IF source.id IS NULL OR source.source_document_version_id IS NOT NULL OR source.case_id<>NEW.case_id
   OR source_number IS NULL OR target_number IS NULL OR source_number>=target_number
   OR ROW(source.object_key,source.oss_version_id,source.filename) IS DISTINCT FROM ROW(NEW.object_key,NEW.oss_version_id,NEW.filename) THEN
  RAISE EXCEPTION 'invalid_historical_material';
 END IF;
 IF TG_TABLE_NAME='upload_sessions' THEN
  IF NEW.state<>'registered' OR NEW.document_version_id IS NULL OR NEW.expected_size<>source.size THEN RAISE EXCEPTION 'invalid_historical_registration'; END IF;
 ELSE
  IF ROW(NEW.size,NEW.sha256,NEW.page_count,NEW.source_format,NEW.source_kind,NEW.source_label)
    IS DISTINCT FROM ROW(source.size,source.sha256,source.page_count,source.source_format,source.source_kind,source.source_label)
    OR NOT EXISTS(SELECT 1 FROM business.upload_sessions u WHERE u.id=NEW.upload_session_id AND u.source_document_version_id=source.id AND u.document_version_id=NEW.id AND u.state='registered')
  THEN RAISE EXCEPTION 'invalid_historical_original'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER historical_material_origin BEFORE INSERT OR UPDATE ON business.upload_sessions FOR EACH ROW EXECUTE FUNCTION business.protect_historical_material();
CREATE TRIGGER historical_material_origin BEFORE INSERT OR UPDATE ON business.document_versions FOR EACH ROW EXECUTE FUNCTION business.protect_historical_material();
REVOKE ALL ON FUNCTION business.protect_historical_material() FROM PUBLIC;
