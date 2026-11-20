-- Opt-in for existing cases. Enabling is an authorized business command; no historical approval is inferred.
ALTER TABLE business.cases ADD COLUMN checker_required boolean NOT NULL DEFAULT false;
ALTER TABLE business.cases ADD COLUMN checker_person_id uuid REFERENCES auth.people(id);
ALTER TABLE business.cases ADD COLUMN checker_assignment_version integer NOT NULL DEFAULT 0;
CREATE TABLE business.checker_submissions(
 id uuid PRIMARY KEY,case_id uuid NOT NULL REFERENCES business.cases(id),round_id uuid NOT NULL,
 run_id uuid NOT NULL REFERENCES business.review_runs(id),number integer NOT NULL,version integer NOT NULL DEFAULT 1,
 maker_person_id uuid NOT NULL REFERENCES auth.people(id),checker_person_id uuid NOT NULL REFERENCES auth.people(id),assignment_version integer NOT NULL,
 snapshot jsonb NOT NULL,snapshot_hash text NOT NULL CHECK(length(snapshot_hash)=64),reason text NOT NULL,
 state text NOT NULL CHECK(state IN ('submitted','returned','withdrawn','confirmed','terminated')),validity text NOT NULL DEFAULT 'current' CHECK(validity IN ('current','stale')),
 created_at timestamptz NOT NULL DEFAULT now(),decided_at timestamptz,decision_reason text,
 FOREIGN KEY(case_id,round_id) REFERENCES business.review_rounds(case_id,id),UNIQUE(case_id,number),CHECK(maker_person_id<>checker_person_id)
);
CREATE UNIQUE INDEX checker_one_pending ON business.checker_submissions(case_id) WHERE state='submitted' AND validity='current';
CREATE TABLE business.checker_items(
 id uuid PRIMARY KEY,case_id uuid NOT NULL REFERENCES business.cases(id),submission_id uuid NOT NULL REFERENCES business.checker_submissions(id),round_id uuid NOT NULL,
 target jsonb NOT NULL,text text NOT NULL,version integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','responded','accepted')),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE business.checker_item_events(
 id uuid PRIMARY KEY,item_id uuid NOT NULL REFERENCES business.checker_items(id),case_id uuid NOT NULL REFERENCES business.cases(id),
 kind text NOT NULL CHECK(kind IN ('response','accepted','reopened')),text text NOT NULL,evidence jsonb NOT NULL DEFAULT '[]',actor_person_id uuid NOT NULL,account_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE business.checker_notes(
 id uuid PRIMARY KEY,case_id uuid NOT NULL REFERENCES business.cases(id),submission_id uuid NOT NULL REFERENCES business.checker_submissions(id),target jsonb NOT NULL,text text NOT NULL,actor_person_id uuid NOT NULL,account_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE business.checker_dispositions(
 id uuid PRIMARY KEY,case_id uuid NOT NULL REFERENCES business.cases(id),round_id uuid NOT NULL,run_id uuid NOT NULL REFERENCES business.review_runs(id),finding_id uuid NOT NULL REFERENCES business.review_findings(id),rule_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('manual_satisfied','professional_opinion','exception')),reason text NOT NULL,evidence jsonb NOT NULL,actor_person_id uuid NOT NULL,account_id uuid NOT NULL,
 external_author text,source text,received_at timestamptz,verified boolean NOT NULL DEFAULT false,valid_until timestamptz,conditions text,opinion_ids jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(case_id,round_id) REFERENCES business.review_rounds(case_id,id)
);
CREATE TABLE business.checker_events(id uuid PRIMARY KEY,case_id uuid NOT NULL REFERENCES business.cases(id),submission_id uuid REFERENCES business.checker_submissions(id),kind text NOT NULL,actor_person_id uuid NOT NULL,account_id uuid NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX checker_items_case ON business.checker_items(case_id,created_at);
CREATE INDEX checker_dispositions_run ON business.checker_dispositions(run_id,created_at);
CREATE FUNCTION business.checker_submission_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(OLD.case_id,OLD.round_id,OLD.run_id,OLD.number,OLD.maker_person_id,OLD.checker_person_id,OLD.assignment_version,OLD.snapshot,OLD.snapshot_hash,OLD.reason,OLD.created_at)
 IS DISTINCT FROM ROW(NEW.case_id,NEW.round_id,NEW.run_id,NEW.number,NEW.maker_person_id,NEW.checker_person_id,NEW.assignment_version,NEW.snapshot,NEW.snapshot_hash,NEW.reason,NEW.created_at) THEN RAISE EXCEPTION 'checker_snapshot_immutable'; END IF;
 IF OLD.state IN ('returned','withdrawn','confirmed','terminated') AND ROW(OLD.state,OLD.decided_at,OLD.decision_reason) IS DISTINCT FROM ROW(NEW.state,NEW.decided_at,NEW.decision_reason) THEN RAISE EXCEPTION 'checker_decision_immutable'; END IF;
 IF OLD.validity='stale' AND NEW.validity<>'stale' THEN RAISE EXCEPTION 'checker_submission_stale'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER checker_submission_guard BEFORE UPDATE ON business.checker_submissions FOR EACH ROW EXECUTE FUNCTION business.checker_submission_immutable();
CREATE FUNCTION business.invalidate_checker_assignment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(OLD.maker_person_id,OLD.current_round_id,OLD.configuration_release_id,OLD.checker_person_id,OLD.checker_assignment_version) IS DISTINCT FROM ROW(NEW.maker_person_id,NEW.current_round_id,NEW.configuration_release_id,NEW.checker_person_id,NEW.checker_assignment_version) THEN
  UPDATE business.checker_submissions SET validity='stale',version=version+1 WHERE case_id=NEW.id AND validity='current' AND state IN ('submitted','confirmed');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER checker_assignment_invalidated AFTER UPDATE ON business.cases FOR EACH ROW EXECUTE FUNCTION business.invalidate_checker_assignment();
REVOKE ALL ON FUNCTION business.checker_submission_immutable(),business.invalidate_checker_assignment() FROM PUBLIC;
REVOKE ALL ON business.checker_submissions,business.checker_items,business.checker_item_events,business.checker_notes,business.checker_dispositions,business.checker_events FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT,UPDATE ON business.checker_submissions,business.checker_items TO hsbc_p1_api;
GRANT SELECT,INSERT ON business.checker_item_events,business.checker_notes,business.checker_dispositions,business.checker_events TO hsbc_p1_api;
GRANT SELECT ON business.checker_submissions TO hsbc_p1_worker;
-- Extend delegation ceilings only. No new business permission is assigned to any person.
WITH added AS (
 INSERT INTO business.grant_authorities(person_id,action,case_id)
 SELECT DISTINCT g.person_id,a.action,g.case_id FROM business.grant_authorities g JOIN auth.people p ON p.id=g.person_id
 CROSS JOIN unnest(ARRAY['checker','checker:read','checker:comment','checker:return','checker:confirm','checker:correct','maker:submit','consultation:record','exception:decide']) a(action)
 WHERE g.action='case:start' AND p.enabled AND p.business_role IS NULL
 AND EXISTS(SELECT 1 FROM business.access_grants x WHERE x.person_id=p.id AND x.action='permission:manage' AND x.case_id IS NULL AND NOT x.revoked)
 ON CONFLICT DO NOTHING RETURNING person_id,action,case_id
) INSERT INTO business.audit_events(id,target_id,action,result,details)
 SELECT gen_random_uuid(),person_id::text,'permission.authority_catalog_extended','success',jsonb_build_object('migration','048_checker_review','actions',jsonb_agg(action)) FROM added GROUP BY person_id;
