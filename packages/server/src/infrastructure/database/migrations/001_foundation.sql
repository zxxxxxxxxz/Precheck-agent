CREATE TABLE business.app_instance(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),instance_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE auth.people(id uuid PRIMARY KEY,display_name text NOT NULL,enabled boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1);
CREATE TABLE auth.accounts(id uuid PRIMARY KEY,person_id uuid NOT NULL REFERENCES auth.people(id),username text NOT NULL UNIQUE,
 password_hash text NOT NULL,enabled boolean NOT NULL DEFAULT true,must_change boolean NOT NULL DEFAULT true,
 password_expires_at timestamptz,session_epoch integer NOT NULL DEFAULT 1,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE auth.sessions(sid varchar PRIMARY KEY,sess json NOT NULL,expire timestamptz NOT NULL);
CREATE INDEX sessions_expire_idx ON auth.sessions(expire);
CREATE TABLE auth.session_revocations(sid varchar PRIMARY KEY,revoked_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE auth.login_limits(limit_key text PRIMARY KEY,attempts integer NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE business.principals(account_id uuid PRIMARY KEY,person_id uuid NOT NULL,enabled boolean NOT NULL,must_change boolean NOT NULL,auth_version integer NOT NULL);
CREATE INDEX principals_person_idx ON business.principals(person_id);
CREATE TABLE business.cases(id uuid PRIMARY KEY,title text NOT NULL,reference text NOT NULL DEFAULT '',background text NOT NULL DEFAULT '',scenario text NOT NULL DEFAULT 'pending',
 status text NOT NULL CHECK(status IN ('assignment_required','collecting_materials')),revision integer NOT NULL DEFAULT 1,maker_person_id uuid,created_by uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE business.access_grants(id uuid PRIMARY KEY,person_id uuid NOT NULL,action text NOT NULL,case_id uuid REFERENCES business.cases(id),
 revoked boolean NOT NULL DEFAULT false,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX access_grants_active ON business.access_grants(person_id,action,coalesce(case_id,'00000000-0000-0000-0000-000000000000'::uuid)) WHERE NOT revoked;
CREATE TABLE business.contributions(id uuid PRIMARY KEY,case_id uuid NOT NULL REFERENCES business.cases(id),person_id uuid NOT NULL,kind text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE business.audit_events(id uuid PRIMARY KEY,actor_id uuid,target_id text,action text NOT NULL,result text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE business.command_receipts(receipt_key text PRIMARY KEY,input_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE business.runtime_heartbeats(name text PRIMARY KEY,updated_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION auth.account_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(OLD.password_hash,OLD.enabled,OLD.person_id,OLD.must_change) IS DISTINCT FROM ROW(NEW.password_hash,NEW.enabled,NEW.person_id,NEW.must_change) THEN NEW.session_epoch:=OLD.session_epoch+1; END IF;
  NEW.version:=OLD.version+1;
 END IF;
 INSERT INTO business.principals(account_id,person_id,enabled,must_change,auth_version)
 SELECT NEW.id,NEW.person_id,NEW.enabled AND p.enabled,NEW.must_change,NEW.session_epoch FROM auth.people p WHERE p.id=NEW.person_id
 ON CONFLICT(account_id) DO UPDATE SET person_id=EXCLUDED.person_id,enabled=EXCLUDED.enabled,must_change=EXCLUDED.must_change,auth_version=EXCLUDED.auth_version;
 RETURN NEW;
END $$;
CREATE TRIGGER account_changed BEFORE INSERT OR UPDATE ON auth.accounts FOR EACH ROW EXECUTE FUNCTION auth.account_changed();
REVOKE ALL ON FUNCTION auth.account_changed() FROM PUBLIC;
CREATE FUNCTION auth.person_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF OLD.enabled IS DISTINCT FROM NEW.enabled THEN
  UPDATE auth.accounts SET session_epoch=session_epoch+1 WHERE person_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER person_changed AFTER UPDATE ON auth.people FOR EACH ROW EXECUTE FUNCTION auth.person_changed();
REVOKE ALL ON FUNCTION auth.person_changed() FROM PUBLIC;
