-- Existing people remain unconfirmed: a historical grant is not evidence of a bank role.
ALTER TABLE auth.people ADD COLUMN business_role text CHECK (business_role IN ('RM','BCO'));
ALTER TABLE business.principals ADD COLUMN business_role text CHECK (business_role IN ('RM','BCO'));
ALTER TABLE business.cases ALTER COLUMN scenario SET DEFAULT 'overseas_loan';
ALTER TABLE business.cases ADD CONSTRAINT cases_supported_scenario CHECK (scenario IN ('pending','overseas_loan'));

CREATE OR REPLACE FUNCTION auth.account_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(OLD.password_hash,OLD.enabled,OLD.person_id,OLD.must_change) IS DISTINCT FROM ROW(NEW.password_hash,NEW.enabled,NEW.person_id,NEW.must_change) THEN NEW.session_epoch:=OLD.session_epoch+1; END IF;
  NEW.version:=OLD.version+1;
 END IF;
 INSERT INTO business.principals(account_id,person_id,enabled,must_change,auth_version,business_role)
 SELECT NEW.id,NEW.person_id,NEW.enabled AND p.enabled,NEW.must_change,NEW.session_epoch,p.business_role FROM auth.people p WHERE p.id=NEW.person_id
 ON CONFLICT(account_id) DO UPDATE SET person_id=EXCLUDED.person_id,enabled=EXCLUDED.enabled,must_change=EXCLUDED.must_change,
   auth_version=EXCLUDED.auth_version,business_role=EXCLUDED.business_role;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION auth.account_changed() FROM PUBLIC;

CREATE FUNCTION auth.person_version_changed() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF ROW(OLD.enabled,OLD.business_role,OLD.display_name) IS DISTINCT FROM ROW(NEW.enabled,NEW.business_role,NEW.display_name) THEN NEW.version:=OLD.version+1; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER person_version_changed BEFORE UPDATE ON auth.people FOR EACH ROW EXECUTE FUNCTION auth.person_version_changed();
REVOKE ALL ON FUNCTION auth.person_version_changed() FROM PUBLIC;
CREATE OR REPLACE FUNCTION auth.person_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF ROW(OLD.enabled,OLD.business_role) IS DISTINCT FROM ROW(NEW.enabled,NEW.business_role) THEN
  UPDATE auth.accounts SET session_epoch=session_epoch+1 WHERE person_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION auth.person_changed() FROM PUBLIC;

-- Preserve the pre-P2 assignment as historical fact, without granting the assignee a role.
INSERT INTO business.audit_events(id,target_id,action,result,details)
 SELECT gen_random_uuid(),id::text,'case.assignment_preserved','success',
   jsonb_build_object('makerPersonId',maker_person_id,'caseRevision',revision,'source','p1_baseline')
 FROM business.cases WHERE maker_person_id IS NOT NULL;

-- Extend only the delegable action catalogue, keeping every existing scope.
-- Actual business grants and the required person role remain explicit admin decisions.
INSERT INTO business.grant_authorities(person_id,action,case_id)
 SELECT g.person_id,m.new_action,g.case_id FROM business.grant_authorities g
 JOIN (VALUES ('case:assign','case:confirm-scenario'),('material:upload','document:parse'),('maker','document:classify')) AS m(old_action,new_action)
 ON g.action=m.old_action ON CONFLICT DO NOTHING;
