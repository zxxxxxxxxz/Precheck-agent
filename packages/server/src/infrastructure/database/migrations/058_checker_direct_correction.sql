-- A correction remains owned by the assigned Checker, never handed back to Maker.
ALTER TABLE business.cases ADD COLUMN checker_correction_round_id uuid REFERENCES business.review_rounds(id);
ALTER TABLE business.cases ADD COLUMN checker_correction_person_id uuid;
ALTER TABLE business.cases ADD COLUMN checker_correction_assignment_version integer;
ALTER TABLE business.cases ADD CONSTRAINT complete_checker_correction_owner CHECK (
 (checker_correction_round_id IS NULL AND checker_correction_person_id IS NULL AND checker_correction_assignment_version IS NULL)
 OR (checker_correction_round_id IS NOT NULL AND checker_correction_person_id IS NOT NULL AND checker_correction_assignment_version IS NOT NULL)
);

CREATE OR REPLACE FUNCTION business.protect_review_round() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='locked' AND NEW.state='draft'
   AND (to_jsonb(OLD)-'state') IS NOT DISTINCT FROM (to_jsonb(NEW)-'state')
   AND EXISTS(SELECT 1 FROM business.cases c WHERE c.id=OLD.case_id AND c.current_round_id=OLD.id AND c.closed_at IS NULL
     AND c.checker_correction_round_id=OLD.id AND c.checker_correction_person_id=c.checker_person_id
     AND c.checker_correction_assignment_version=c.checker_assignment_version)
   AND NOT EXISTS(SELECT 1 FROM business.checker_submissions s WHERE s.round_id=OLD.id AND s.validity='current' AND s.state IN ('submitted','confirmed'))
 THEN RETURN NEW; END IF;
 IF OLD.state='locked' AND NEW.state='draft'
   AND (to_jsonb(OLD)-'state') IS NOT DISTINCT FROM (to_jsonb(NEW)-'state')
   AND EXISTS(SELECT 1 FROM business.cases c WHERE c.id=OLD.case_id AND c.current_round_id=OLD.id AND c.closed_at IS NULL)
   AND (NOT EXISTS(SELECT 1 FROM business.review_events e WHERE e.round_id=OLD.id AND e.kind='round_result_confirmed')
     OR EXISTS(SELECT 1 FROM business.checker_submissions s WHERE s.case_id=OLD.case_id AND s.round_id=OLD.id AND s.run_id=OLD.run_id AND s.validity='current' AND s.state IN ('returned','withdrawn')
       AND s.number=(SELECT max(latest.number) FROM business.checker_submissions latest WHERE latest.case_id=OLD.case_id AND latest.round_id=OLD.id)))
   AND NOT EXISTS(SELECT 1 FROM business.checker_submissions s WHERE s.case_id=OLD.case_id AND s.round_id=OLD.id AND s.validity='current' AND s.state IN ('submitted','confirmed'))
 THEN RETURN NEW; END IF;
 IF OLD.state NOT IN ('draft','submitted') OR ROW(OLD.id,OLD.case_id,OLD.number,OLD.created_by,OLD.created_at,OLD.reason)
   IS DISTINCT FROM ROW(NEW.id,NEW.case_id,NEW.number,NEW.created_by,NEW.created_at,NEW.reason)
 THEN RAISE EXCEPTION 'immutable_review_round'; END IF;
 IF OLD.state='submitted' AND (NEW.state NOT IN ('draft','locked') OR
   (to_jsonb(OLD)-'state') IS DISTINCT FROM (to_jsonb(NEW)-'state'))
 THEN RAISE EXCEPTION 'immutable_review_round'; END IF;
 RETURN NEW;
END $$;
