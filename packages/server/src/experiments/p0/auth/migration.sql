CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS business;
CREATE TABLE IF NOT EXISTS auth.accounts (
  id text PRIMARY KEY, person_id text NOT NULL, username text NOT NULL UNIQUE,
  password_hash text NOT NULL, enabled boolean NOT NULL DEFAULT true,
  synthetic boolean NOT NULL DEFAULT true CHECK (synthetic), session_epoch integer NOT NULL DEFAULT 1
);
ALTER TABLE auth.accounts ADD COLUMN IF NOT EXISTS session_epoch integer NOT NULL DEFAULT 1;
CREATE OR REPLACE FUNCTION auth.bump_session_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.enabled IS DISTINCT FROM NEW.enabled OR OLD.person_id IS DISTINCT FROM NEW.person_id OR OLD.password_hash IS DISTINCT FROM NEW.password_hash THEN
    NEW.session_epoch := OLD.session_epoch + 1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER accounts_session_epoch BEFORE UPDATE ON auth.accounts
  FOR EACH ROW EXECUTE FUNCTION auth.bump_session_epoch();
CREATE TABLE IF NOT EXISTS auth.sessions (
  sid varchar PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expire_idx ON auth.sessions(expire);
-- Tombstones prevent an in-flight save from resurrecting a logged-out session.
CREATE TABLE IF NOT EXISTS auth.session_revocations (
  sid varchar PRIMARY KEY, revoked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS business.service_principals (
  id text PRIMARY KEY, enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS business.delegations (
  id text PRIMARY KEY, service_id text NOT NULL REFERENCES business.service_principals(id),
  case_id text NOT NULL, revision integer NOT NULL CHECK (revision > 0),
  task_id text, actions text[] NOT NULL, authorization_version integer NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false
);
CREATE OR REPLACE FUNCTION business.bump_delegation_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.service_id,OLD.case_id,OLD.revision,OLD.task_id,OLD.actions,OLD.expires_at,OLD.revoked)
      IS DISTINCT FROM ROW(NEW.service_id,NEW.case_id,NEW.revision,NEW.task_id,NEW.actions,NEW.expires_at,NEW.revoked) THEN
    NEW.authorization_version := OLD.authorization_version + 1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER delegations_auth_version BEFORE UPDATE ON business.delegations
  FOR EACH ROW EXECUTE FUNCTION business.bump_delegation_version();
