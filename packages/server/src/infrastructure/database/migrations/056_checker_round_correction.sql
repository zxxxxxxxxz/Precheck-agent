-- A later independent Checker return/withdrawal may reopen the current round.
-- Previously completed rounds stay immutable unless that explicit decision exists.
CREATE OR REPLACE FUNCTION business.protect_review_round() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
