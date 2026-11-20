-- Draft content is private business data; no automatic expiry or deletion.
CREATE TABLE business.case_drafts (
  id uuid PRIMARY KEY,
  owner_person_id uuid NOT NULL REFERENCES auth.people(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  fields jsonb NOT NULL,
  field_states jsonb NOT NULL,
  source jsonb NOT NULL DEFAULT '{"kind":"maker"}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','created','discarded')),
  created_case_id uuid UNIQUE REFERENCES business.cases(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'created') = (created_case_id IS NOT NULL)),
  CHECK (jsonb_typeof(fields)='object' AND jsonb_typeof(field_states)='object' AND jsonb_typeof(source)='object')
);
CREATE INDEX case_drafts_owner ON business.case_drafts(owner_person_id,updated_at DESC,id);
ALTER TABLE business.cases ADD COLUMN source jsonb NOT NULL DEFAULT '{"kind":"unknown"}';

-- Preserve verified prior participation, without guessing missing assignees.
INSERT INTO business.contributions(id,case_id,person_id,kind)
 SELECT gen_random_uuid(),c.id,c.created_by,'case_creation'
 FROM business.cases c WHERE NOT EXISTS (
  SELECT 1 FROM business.contributions h WHERE h.case_id=c.id AND h.person_id=c.created_by AND h.kind='case_creation');
INSERT INTO business.contributions(id,case_id,person_id,kind)
 SELECT gen_random_uuid(),c.id,c.maker_person_id,'maker_assignment'
 FROM business.cases c WHERE c.maker_person_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM business.contributions h WHERE h.case_id=c.id AND h.person_id=c.maker_person_id AND h.kind='maker_assignment');
INSERT INTO business.contributions(id,case_id,person_id,kind,created_at)
 SELECT gen_random_uuid(),c.id,history.person_id::uuid,'maker_assignment',min(a.created_at)
 FROM business.audit_events a JOIN business.cases c ON c.id::text=a.target_id
 CROSS JOIN LATERAL (VALUES (a.details->>'makerPersonId'),(a.details->>'previousMakerPersonId')) AS history(person_id)
 WHERE a.action IN ('case.assigned','case.assignment_preserved') AND a.result='success'
 AND history.person_id ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
 AND NOT EXISTS (SELECT 1 FROM business.contributions h WHERE h.case_id=c.id AND h.person_id=history.person_id::uuid AND h.kind='maker_assignment')
 GROUP BY c.id,history.person_id;
