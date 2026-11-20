CREATE FUNCTION business.protect_formal_review_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(OLD)-ARRAY['state','cancel_requested','error_code','updated_at']) IS DISTINCT FROM
    (to_jsonb(NEW)-ARRAY['state','cancel_requested','error_code','updated_at'])
 OR OLD.cancel_requested AND NOT NEW.cancel_requested
 OR OLD.state IN ('completed','canceled','stale') AND NEW.state<>OLD.state
 THEN RAISE EXCEPTION 'immutable_formal_review_identity'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER formal_job_identity BEFORE UPDATE ON business.formal_review_jobs FOR EACH ROW EXECUTE FUNCTION business.protect_formal_review_job();
REVOKE ALL ON FUNCTION business.protect_formal_review_job() FROM PUBLIC;
