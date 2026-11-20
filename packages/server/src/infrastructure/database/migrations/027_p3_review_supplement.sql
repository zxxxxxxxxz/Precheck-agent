-- One extraction attempt for each exact evidence gap, independent of case revision/retries/agents.
CREATE TABLE business.review_supplements (
 id uuid PRIMARY KEY,case_id uuid NOT NULL REFERENCES business.cases(id),issue_id uuid NOT NULL REFERENCES business.review_issues(id),
 document_version_id uuid NOT NULL REFERENCES business.document_versions(id),parse_revision uuid NOT NULL REFERENCES business.document_jobs(id),
 field_ids text[] NOT NULL CHECK(cardinality(field_ids)>0),expected_revision integer NOT NULL,account_id uuid NOT NULL,person_id uuid NOT NULL,auth_version integer NOT NULL,session_key text,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','requested','failed','canceled')),job_id uuid REFERENCES business.document_jobs(id),error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE business.review_supplement_gaps (
 gap_key text PRIMARY KEY,request_id uuid NOT NULL REFERENCES business.review_supplements(id),created_at timestamptz NOT NULL DEFAULT now()
);
