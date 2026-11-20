-- Case-level judgement rules confirmed by reviewers, and their digests for the rule centre.
-- A rule informs semantic comparison only; published OPA rules and facts are unchanged.
CREATE TABLE business.case_review_guidance (
 id uuid PRIMARY KEY,case_id uuid NOT NULL REFERENCES business.cases(id),number integer NOT NULL CHECK(number>0),
 kind text NOT NULL CHECK(kind IN ('name_equivalence','wording_tolerance','legal_baseline','focus_note')),
 body jsonb NOT NULL,body_hash text NOT NULL,origin jsonb NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
 supersedes uuid REFERENCES business.case_review_guidance(id),round_id uuid REFERENCES business.review_rounds(id),case_revision integer NOT NULL,
 created_by uuid NOT NULL,account_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 retired_by uuid,retired_account_id uuid,retired_at timestamptz,retire_reason text,
 UNIQUE(case_id,number),
 CHECK((status='retired')=(retired_at IS NOT NULL AND retired_by IS NOT NULL AND retire_reason IS NOT NULL))
);
CREATE INDEX case_review_guidance_case ON business.case_review_guidance(case_id,status,number);
CREATE FUNCTION business.protect_case_review_guidance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'case_review_guidance_immutable'; END IF;
 IF OLD.status='retired' OR ROW(OLD.id,OLD.case_id,OLD.number,OLD.kind,OLD.body,OLD.body_hash,OLD.origin,OLD.supersedes,OLD.round_id,OLD.case_revision,OLD.created_by,OLD.account_id,OLD.created_at)
  IS DISTINCT FROM ROW(NEW.id,NEW.case_id,NEW.number,NEW.kind,NEW.body,NEW.body_hash,NEW.origin,NEW.supersedes,NEW.round_id,NEW.case_revision,NEW.created_by,NEW.account_id,NEW.created_at)
 THEN RAISE EXCEPTION 'case_review_guidance_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_case_review_guidance BEFORE UPDATE OR DELETE ON business.case_review_guidance FOR EACH ROW EXECUTE FUNCTION business.protect_case_review_guidance();

CREATE TABLE business.review_guidance_digests (
 id uuid PRIMARY KEY,case_id uuid NOT NULL REFERENCES business.cases(id),round_id uuid REFERENCES business.review_rounds(id),run_id uuid REFERENCES business.review_runs(id),
 base_release_id text NOT NULL,trigger text NOT NULL CHECK(trigger IN ('round_confirmed','manual')),input_hash text NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','running','ready','adopted','declined','failed')),
 body jsonb,body_hash text,adoption jsonb,error_code text,
 account_id uuid NOT NULL,person_id uuid NOT NULL,auth_version integer NOT NULL,session_key text,
 decided_by uuid,decided_at timestamptz,decision_reason text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(case_id,input_hash),CHECK((body IS NULL)=(body_hash IS NULL))
);
CREATE INDEX review_guidance_digests_state ON business.review_guidance_digests(state,created_at DESC);

-- Rule-centre drafts generated from a digest keep their origin; manual drafts are unchanged.
ALTER TABLE business.review_config_drafts
 ADD COLUMN origin text NOT NULL DEFAULT 'manual' CHECK(origin IN ('manual','guidance_digest')),
 ADD COLUMN origin_ref uuid REFERENCES business.review_guidance_digests(id),
 ADD COLUMN based_on_release_id text,
 ADD CONSTRAINT review_config_draft_origin CHECK((origin='manual')=(origin_ref IS NULL));

REVOKE ALL ON business.case_review_guidance,business.review_guidance_digests FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT ON business.case_review_guidance TO hsbc_p1_api;
GRANT UPDATE(status,retired_by,retired_account_id,retired_at,retire_reason) ON business.case_review_guidance TO hsbc_p1_api;
GRANT SELECT ON business.case_review_guidance TO hsbc_p1_worker;
GRANT SELECT,INSERT,UPDATE ON business.review_guidance_digests TO hsbc_p1_api;
GRANT SELECT,UPDATE ON business.review_guidance_digests TO hsbc_p1_worker;
