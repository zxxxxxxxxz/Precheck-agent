-- Business review uses immutable fact versions and snapshots. Work queues carry identifiers only.
ALTER TABLE business.cases ADD COLUMN configuration_release_id text REFERENCES business.review_config_releases(release_id);
ALTER TABLE business.cases ADD COLUMN review_business_date text CHECK(review_business_date IS NULL OR review_business_date ~ '^\d{4}-\d{2}-\d{2}$');
CREATE TABLE business.review_object_versions (
 id uuid PRIMARY KEY, object_id uuid NOT NULL, case_id uuid NOT NULL REFERENCES business.cases(id), version integer NOT NULL CHECK(version>0),
 case_revision integer NOT NULL, body jsonb NOT NULL, validity text NOT NULL DEFAULT 'current' CHECK(validity IN ('current','stale')),
 confirmed_by uuid NOT NULL, account_id uuid NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(case_id,object_id,version)
);
CREATE INDEX review_objects_case ON business.review_object_versions(case_id,object_id,version DESC);
CREATE TABLE business.review_fact_versions (
 id uuid PRIMARY KEY, fact_id uuid NOT NULL, case_id uuid NOT NULL REFERENCES business.cases(id), object_id uuid NOT NULL,
 field_id text NOT NULL, version integer NOT NULL CHECK(version>0), case_revision integer NOT NULL, body jsonb NOT NULL,
 validity text NOT NULL DEFAULT 'current' CHECK(validity IN ('current','stale')), confirmed_by uuid NOT NULL, account_id uuid NOT NULL,
 reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(case_id,fact_id,version)
);
CREATE INDEX review_facts_case ON business.review_fact_versions(case_id,fact_id,version DESC);
CREATE TABLE business.review_material_events (
 id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES business.cases(id), document_version_id uuid NOT NULL REFERENCES business.document_versions(id),
 case_revision integer NOT NULL, body jsonb NOT NULL, actor_person_id uuid NOT NULL, account_id uuid NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_materials_case ON business.review_material_events(case_id,document_version_id,case_revision DESC,created_at DESC);
CREATE TABLE business.review_runs (
 id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES business.cases(id), case_revision integer NOT NULL,
 configuration_release_id text NOT NULL REFERENCES business.review_config_releases(release_id), snapshot jsonb NOT NULL, snapshot_hash text NOT NULL,
 account_id uuid NOT NULL, person_id uuid NOT NULL, auth_version integer NOT NULL, session_key text,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','ready','failed','canceled','stale')),
 validity text NOT NULL DEFAULT 'current' CHECK(validity IN ('current','stale')), error_code text, results jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(case_id,case_revision,snapshot_hash)
);
CREATE TABLE business.review_findings (
 id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES business.review_runs(id), case_id uuid NOT NULL REFERENCES business.cases(id),
 case_revision integer NOT NULL, rule_id text NOT NULL, scope_id text NOT NULL, input_hash text NOT NULL, receipt jsonb NOT NULL,
 reused_from uuid REFERENCES business.review_findings(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id,rule_id,scope_id)
);
CREATE INDEX review_findings_dependency ON business.review_findings(case_id,rule_id,scope_id,input_hash);
CREATE TABLE business.review_issues (
 id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES business.cases(id), rule_id text NOT NULL, scope_id text NOT NULL,version integer NOT NULL DEFAULT 1,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','acknowledged')), validity text NOT NULL DEFAULT 'current' CHECK(validity IN ('current','stale')),
 latest_finding_id uuid NOT NULL REFERENCES business.review_findings(id), case_revision integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(case_id,rule_id,scope_id)
);
CREATE TABLE business.review_events (
 id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES business.cases(id), case_revision integer NOT NULL, kind text NOT NULL,
 issue_id uuid REFERENCES business.review_issues(id), actor_person_id uuid NOT NULL, account_id uuid NOT NULL, details jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_events_case ON business.review_events(case_id,created_at DESC);
CREATE FUNCTION business.reject_review_snapshot_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(OLD.case_id,OLD.case_revision,OLD.configuration_release_id,OLD.snapshot,OLD.snapshot_hash)
 IS DISTINCT FROM ROW(NEW.case_id,NEW.case_revision,NEW.configuration_release_id,NEW.snapshot,NEW.snapshot_hash)
 THEN RAISE EXCEPTION 'immutable_review_snapshot'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_review_snapshot BEFORE UPDATE ON business.review_runs FOR EACH ROW EXECUTE FUNCTION business.reject_review_snapshot_change();
REVOKE ALL ON FUNCTION business.reject_review_snapshot_change() FROM PUBLIC;
