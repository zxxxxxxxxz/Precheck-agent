-- Explicit opt-in. NULL round IDs remain legacy; no historical snapshot is rewritten.
ALTER TABLE business.cases ADD COLUMN review_rounds_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE business.cases ADD COLUMN current_round_id uuid;
ALTER TABLE business.cases ADD COLUMN legacy_review_context jsonb;
CREATE TABLE business.review_rounds (
 id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES business.cases(id), number integer NOT NULL CHECK(number>0),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','locked','discarded')),
 configuration_release_id text REFERENCES business.review_config_releases(release_id), business_date text,
 run_id uuid REFERENCES business.review_runs(id), locked_revision integer, submitted_at timestamptz,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), reason text NOT NULL,
 discarded_at timestamptz, discarded_by uuid, discard_reason text,
 UNIQUE(case_id,number), UNIQUE(case_id,id),
 CHECK(business_date IS NULL OR business_date ~ '^\d{4}-\d{2}-\d{2}$'),
 CHECK((state='draft' AND run_id IS NULL AND submitted_at IS NULL AND locked_revision IS NULL AND discarded_at IS NULL)
   OR (state='locked' AND run_id IS NOT NULL AND submitted_at IS NOT NULL AND locked_revision IS NOT NULL AND configuration_release_id IS NOT NULL AND business_date IS NOT NULL AND discarded_at IS NULL)
   OR (state='discarded' AND run_id IS NULL AND submitted_at IS NULL AND locked_revision IS NULL AND discarded_at IS NOT NULL AND discarded_by IS NOT NULL AND discard_reason IS NOT NULL))
);
CREATE UNIQUE INDEX one_draft_review_round ON business.review_rounds(case_id) WHERE state='draft';
ALTER TABLE business.cases ADD CONSTRAINT current_review_round_case FOREIGN KEY(id,current_round_id) REFERENCES business.review_rounds(case_id,id);
ALTER TABLE business.cases ADD CONSTRAINT review_rounds_opt_in CHECK(review_rounds_enabled OR current_round_id IS NULL);

DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['upload_sessions','document_versions','document_jobs','review_object_versions','review_fact_versions','review_material_events','review_runs','review_issues','review_events','review_supplements'] LOOP
  EXECUTE format('ALTER TABLE business.%I ADD COLUMN round_id uuid',name);
  EXECUTE format('ALTER TABLE business.%I ADD CONSTRAINT %I FOREIGN KEY(case_id,round_id) REFERENCES business.review_rounds(case_id,id)',name,name||'_round_case');
  EXECUTE format('CREATE INDEX %I ON business.%I(case_id,round_id)',name||'_round',name);
 END LOOP;
END $$;
ALTER TABLE business.review_issues DROP CONSTRAINT review_issues_case_id_rule_id_scope_id_key;
ALTER TABLE business.review_issues ADD CONSTRAINT review_issue_round_scope UNIQUE NULLS NOT DISTINCT(case_id,round_id,rule_id,scope_id);

CREATE FUNCTION business.protect_review_round() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state<>'draft' OR ROW(OLD.id,OLD.case_id,OLD.number,OLD.created_by,OLD.created_at,OLD.reason)
   IS DISTINCT FROM ROW(NEW.id,NEW.case_id,NEW.number,NEW.created_by,NEW.created_at,NEW.reason)
 THEN RAISE EXCEPTION 'immutable_review_round'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_submitted_review_round BEFORE UPDATE ON business.review_rounds FOR EACH ROW EXECUTE FUNCTION business.protect_review_round();
CREATE FUNCTION business.protect_round_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.round_id IS DISTINCT FROM NEW.round_id THEN
  -- A draft attachment is assigned exactly once, in the case-creation transaction.
  IF TG_TABLE_NAME='upload_sessions' AND OLD.case_id IS NULL AND OLD.round_id IS NULL AND NEW.case_id IS NOT NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'immutable_round_membership';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['upload_sessions','document_versions','document_jobs','review_runs','review_issues','review_supplements'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_round_membership BEFORE UPDATE ON business.%I FOR EACH ROW EXECUTE FUNCTION business.protect_round_membership()',name);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION business.protect_review_round(),business.protect_round_membership() FROM PUBLIC;
