-- Case-local requests and results are deliberately separate from review inputs.
CREATE TABLE business.case_supplement_jobs (
  id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES business.cases(id),
  round_id uuid REFERENCES business.review_rounds(id),
  account_id uuid NOT NULL, person_id uuid NOT NULL, auth_version integer NOT NULL,
  session_key text, expected_revision integer NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','running','ready','failed','unknown')),
  input jsonb NOT NULL, input_hash text NOT NULL, result jsonb, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_supplement_history ON business.case_supplement_jobs(case_id,person_id,created_at DESC);
CREATE TABLE business.case_supplement_calls (
  job_id uuid PRIMARY KEY REFERENCES business.case_supplement_jobs(id),
  request_hash text NOT NULL, state text NOT NULL CHECK(state IN ('unknown','completed','failed')),
  response jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON business.case_supplement_jobs,business.case_supplement_calls FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT ON business.case_supplement_jobs TO hsbc_p1_api;
GRANT SELECT,UPDATE ON business.case_supplement_jobs TO hsbc_p1_worker;
GRANT SELECT,INSERT,UPDATE ON business.case_supplement_calls TO hsbc_p1_worker;
