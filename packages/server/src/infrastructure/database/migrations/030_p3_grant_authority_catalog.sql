-- Extend delegable actions only for existing, enabled technical permission
-- administrators. This never grants business access or changes a person's role.
-- Case authority follows the exact prior scope; rule administration is global
-- and requires the existing global permission-management delegation ceiling.
WITH eligible AS MATERIALIZED (
 SELECT p.id FROM auth.people p
 WHERE p.enabled AND p.business_role IS NULL
   AND EXISTS (SELECT 1 FROM auth.accounts a WHERE a.person_id=p.id AND a.enabled)
   AND EXISTS (SELECT 1 FROM business.access_grants a WHERE a.person_id=p.id
     AND a.action='permission:manage' AND a.case_id IS NULL AND NOT a.revoked)
), candidates AS (
 SELECT g.person_id,m.new_action AS action,g.case_id
 FROM business.grant_authorities g JOIN eligible e ON e.id=g.person_id
 JOIN (VALUES
   ('case:confirm-scenario','case:configure'),
   ('maker','case:start'),
   ('material:upload','material:adopt'),
   ('document:classify','field:correct'),
   ('maker','finding:decide')
 ) AS m(old_action,new_action) ON m.old_action=g.action
 UNION
 SELECT g.person_id,m.action,NULL::uuid
 FROM business.grant_authorities g JOIN eligible e ON e.id=g.person_id
 CROSS JOIN (VALUES ('rule:read'),('rule:propose'),('rule:trial'),('rule:approve'),('rule:publish')) AS m(action)
 WHERE g.action='permission:manage' AND g.case_id IS NULL
), added AS (
 INSERT INTO business.grant_authorities(person_id,action,case_id)
 SELECT person_id,action,case_id FROM candidates ON CONFLICT DO NOTHING
 RETURNING person_id,action,case_id
)
INSERT INTO business.audit_events(id,target_id,action,result,details)
 SELECT gen_random_uuid(),person_id::text,'permission.authority_catalog_extended','success',
   jsonb_build_object('migration','030_p3_grant_authority_catalog',
     'authorities',jsonb_agg(jsonb_build_object('action',action,'caseId',case_id) ORDER BY action,case_id))
 FROM added GROUP BY person_id;
