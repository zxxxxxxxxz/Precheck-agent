-- Worker sees only an execution fence, never session contents, identifiers or cookies.
CREATE TABLE business.model_session_grants (
  session_key text PRIMARY KEY CHECK(session_key ~ '^[a-f0-9]{64}$'),
  account_id uuid NOT NULL,
  person_id uuid NOT NULL,
  auth_version integer NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false
);

CREATE FUNCTION auth.sync_model_session_grant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE login jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('p3-session:'||encode(sha256(convert_to(
    CASE WHEN TG_OP='DELETE' THEN OLD.sid ELSE NEW.sid END,'UTF8')),'hex'),0));
  IF TG_OP = 'DELETE' THEN
    UPDATE business.model_session_grants SET revoked=true
      WHERE session_key=encode(sha256(convert_to(OLD.sid,'UTF8')),'hex');
    RETURN OLD;
  END IF;
  login := NEW.sess::jsonb->'p1'->'login';
  IF login IS NOT NULL AND login <> 'null'::jsonb THEN
    INSERT INTO business.model_session_grants(session_key,account_id,person_id,auth_version,expires_at)
      VALUES(encode(sha256(convert_to(NEW.sid,'UTF8')),'hex'),(login->>'accountId')::uuid,
        (login->>'personId')::uuid,(login->>'authVersion')::integer,NEW.expire)
      ON CONFLICT(session_key) DO UPDATE SET expires_at=EXCLUDED.expires_at;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION auth.sync_model_session_grant() FROM PUBLIC;
CREATE TRIGGER model_session_grant_sync AFTER INSERT OR UPDATE OR DELETE ON auth.sessions
  FOR EACH ROW EXECUTE FUNCTION auth.sync_model_session_grant();

INSERT INTO business.model_session_grants(session_key,account_id,person_id,auth_version,expires_at)
SELECT encode(sha256(convert_to(sid,'UTF8')),'hex'),(sess::jsonb->'p1'->'login'->>'accountId')::uuid,
  (sess::jsonb->'p1'->'login'->>'personId')::uuid,(sess::jsonb->'p1'->'login'->>'authVersion')::integer,expire
FROM auth.sessions WHERE expire>now() AND sess::jsonb->'p1'->'login' IS NOT NULL AND sess::jsonb->'p1'->'login' <> 'null'::jsonb
  AND NOT EXISTS(SELECT 1 FROM auth.session_revocations r WHERE r.sid=auth.sessions.sid);

ALTER TABLE business.intake_turns ADD COLUMN session_key text REFERENCES business.model_session_grants(session_key);
-- Existing rows without a durable session fence are historical only.
UPDATE business.intake_turns SET status='stale',error_code='session_fence_required',updated_at=now()
  WHERE status IN ('pending','running');
UPDATE business.model_calls SET state=CASE WHEN sent_at IS NULL THEN 'canceled' ELSE 'unknown' END,
  error_code='session_fence_required',updated_at=now() WHERE state IN ('pending','running','sent');
