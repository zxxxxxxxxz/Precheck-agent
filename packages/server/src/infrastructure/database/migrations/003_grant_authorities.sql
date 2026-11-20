CREATE TABLE business.grant_authorities(
 person_id uuid NOT NULL,action text NOT NULL,case_id uuid REFERENCES business.cases(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX grant_authorities_unique ON business.grant_authorities(person_id,action,coalesce(case_id,'00000000-0000-0000-0000-000000000000'::uuid));
