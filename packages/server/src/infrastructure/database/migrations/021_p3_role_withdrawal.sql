-- Keep the technical-identity invariant after explicit role administration as
-- well as migration. The existing trigger is privileged so runtime identities
-- retain read-only access to tool delegations; no new callable capability exists.
CREATE OR REPLACE FUNCTION auth.person_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF OLD.business_role='BCO' AND NEW.business_role IS NULL THEN
  UPDATE business.access_grants SET revoked=true WHERE person_id=NEW.id AND NOT revoked
   AND action NOT IN ('account:manage','permission:manage','audit:read','system:status');
  UPDATE business.document_tool_delegations SET revoked=true WHERE person_id=NEW.id AND NOT revoked;
 END IF;
 IF ROW(OLD.enabled,OLD.business_role) IS DISTINCT FROM ROW(NEW.enabled,NEW.business_role) THEN
  UPDATE auth.accounts SET session_epoch=session_epoch+1 WHERE person_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION auth.person_changed() FROM PUBLIC;
