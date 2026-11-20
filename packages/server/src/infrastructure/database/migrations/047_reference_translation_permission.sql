-- Separate capability for immutable submitted-round reference translations.
-- Extend administrative delegation ceilings only; no business grant is automatic.
WITH added AS (
 INSERT INTO business.grant_authorities(person_id,action,case_id)
 SELECT DISTINCT g.person_id,'document:translate',g.case_id FROM business.grant_authorities g JOIN auth.people p ON p.id=g.person_id
 WHERE g.action='document:parse' AND p.enabled AND p.business_role IS NULL
 AND EXISTS(SELECT 1 FROM auth.accounts a WHERE a.person_id=p.id AND a.enabled)
 AND EXISTS(SELECT 1 FROM business.access_grants a WHERE a.person_id=p.id AND a.action='permission:manage' AND a.case_id IS NULL AND NOT a.revoked)
 AND NOT EXISTS(SELECT 1 FROM business.grant_authorities x WHERE x.person_id=g.person_id AND x.action='document:translate' AND x.case_id IS NOT DISTINCT FROM g.case_id)
 RETURNING person_id,case_id
)
INSERT INTO business.audit_events(id,target_id,action,result,details)
 SELECT gen_random_uuid(),person_id::text,'permission.authority_catalog_extended','success',jsonb_build_object('migration','047_reference_translation_permission','action','document:translate','scopes',jsonb_agg(case_id)) FROM added GROUP BY person_id;
