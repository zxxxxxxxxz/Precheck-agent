-- Generating a result leaves the round open; explicit confirmation freezes it.
-- Existing locked rounds and their snapshots remain unchanged.
DO $$ DECLARE constraint_name text; BEGIN
 SELECT conname INTO STRICT constraint_name FROM pg_constraint
 WHERE conrelid='business.review_rounds'::regclass AND contype='c'
   AND pg_get_constraintdef(oid) LIKE '%locked_revision%';
 EXECUTE format('ALTER TABLE business.review_rounds DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE business.review_rounds DROP CONSTRAINT review_rounds_state_check;
ALTER TABLE business.review_rounds ADD CONSTRAINT review_rounds_state_check CHECK(state IN ('draft','submitted','locked','discarded'));
ALTER TABLE business.review_rounds ADD CONSTRAINT review_round_execution_shape CHECK (
 (state='draft' AND discarded_at IS NULL AND
   ((run_id IS NULL AND submitted_at IS NULL AND locked_revision IS NULL) OR
    (run_id IS NOT NULL AND submitted_at IS NOT NULL AND locked_revision IS NOT NULL AND configuration_release_id IS NOT NULL AND business_date IS NOT NULL)))
 OR (state IN ('submitted','locked') AND run_id IS NOT NULL AND submitted_at IS NOT NULL AND locked_revision IS NOT NULL AND configuration_release_id IS NOT NULL AND business_date IS NOT NULL AND discarded_at IS NULL)
 OR (state='discarded' AND run_id IS NULL AND submitted_at IS NULL AND locked_revision IS NULL AND discarded_at IS NOT NULL AND discarded_by IS NOT NULL AND discard_reason IS NOT NULL)
);

-- Only new, unconfirmed submissions may return for correction. Locked history
-- retains the original immutability rule, including pre-migration rounds.
CREATE OR REPLACE FUNCTION business.protect_review_round() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state NOT IN ('draft','submitted') OR ROW(OLD.id,OLD.case_id,OLD.number,OLD.created_by,OLD.created_at,OLD.reason)
   IS DISTINCT FROM ROW(NEW.id,NEW.case_id,NEW.number,NEW.created_by,NEW.created_at,NEW.reason)
 THEN RAISE EXCEPTION 'immutable_review_round'; END IF;
 IF OLD.state='submitted' AND (NEW.state NOT IN ('draft','locked') OR
   (to_jsonb(OLD)-'state') IS DISTINCT FROM (to_jsonb(NEW)-'state'))
 THEN RAISE EXCEPTION 'immutable_review_round'; END IF;
 RETURN NEW;
END $$;
