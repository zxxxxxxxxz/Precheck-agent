CREATE FUNCTION business.protect_review_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(OLD)-'validity') IS DISTINCT FROM (to_jsonb(NEW)-'validity') THEN
    RAISE EXCEPTION 'immutable_review_version';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_review_object_body BEFORE UPDATE ON business.review_object_versions FOR EACH ROW EXECUTE FUNCTION business.protect_review_version();
CREATE TRIGGER immutable_review_fact_body BEFORE UPDATE ON business.review_fact_versions FOR EACH ROW EXECUTE FUNCTION business.protect_review_version();
CREATE FUNCTION business.protect_review_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable_review_history'; END $$;
CREATE TRIGGER immutable_review_material_event BEFORE UPDATE ON business.review_material_events FOR EACH ROW EXECUTE FUNCTION business.protect_review_history();
CREATE TRIGGER immutable_review_finding BEFORE UPDATE ON business.review_findings FOR EACH ROW EXECUTE FUNCTION business.protect_review_history();
CREATE TRIGGER immutable_review_event BEFORE UPDATE ON business.review_events FOR EACH ROW EXECUTE FUNCTION business.protect_review_history();
CREATE TRIGGER immutable_review_doc_receipt BEFORE UPDATE ON business.review_document_receipts FOR EACH ROW EXECUTE FUNCTION business.protect_review_history();
CREATE TRIGGER immutable_review_supplement_gap BEFORE UPDATE ON business.review_supplement_gaps FOR EACH ROW EXECUTE FUNCTION business.protect_review_history();
CREATE FUNCTION business.protect_field_filter_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state<>'unknown' OR ROW(OLD.id,OLD.job_id,OLD.request_hash,OLD.payload_hash,OLD.created_at)
    IS DISTINCT FROM ROW(NEW.id,NEW.job_id,NEW.request_hash,NEW.payload_hash,NEW.created_at) THEN
    RAISE EXCEPTION 'immutable_field_filter_receipt';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_field_filter_receipt BEFORE UPDATE ON business.field_filter_calls FOR EACH ROW EXECUTE FUNCTION business.protect_field_filter_receipt();
REVOKE ALL ON FUNCTION business.protect_review_version(),business.protect_review_history(),business.protect_field_filter_receipt() FROM PUBLIC;
