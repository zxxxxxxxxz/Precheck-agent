-- Standing authorization applies only to future cases; no historical grants or assignments change.
CREATE TABLE business.case_review_teams (
 maker_person_id uuid PRIMARY KEY REFERENCES auth.people(id),
 checker_person_id uuid NOT NULL REFERENCES auth.people(id),
 enabled boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 authorized_by uuid NOT NULL REFERENCES auth.accounts(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(maker_person_id <> checker_person_id)
);
