-- Case assistant: one private conversation per case and person, polled turns,
-- server-held rule proposals and a purpose-bound cloud call ledger.
CREATE TABLE business.case_assistant_conversations (
 id uuid PRIMARY KEY,case_id uuid NOT NULL REFERENCES business.cases(id),person_id uuid NOT NULL,account_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(case_id,person_id)
);
CREATE TABLE business.case_assistant_turns (
 id uuid PRIMARY KEY,conversation_id uuid NOT NULL REFERENCES business.case_assistant_conversations(id),case_id uuid NOT NULL REFERENCES business.cases(id),
 client_turn_id uuid NOT NULL,mode text NOT NULL CHECK(mode IN ('chat','legal_opinion')),text text NOT NULL,page jsonb NOT NULL,
 -- Authorized case context frozen when the message was sent; the worker never widens it.
 context jsonb NOT NULL,context_hash text NOT NULL,
 account_id uuid NOT NULL,person_id uuid NOT NULL,auth_version integer NOT NULL,session_key text,
 case_revision integer NOT NULL,round_id uuid REFERENCES business.review_rounds(id),
 state text NOT NULL CHECK(state IN ('pending','running','ready','failed','unknown','canceled')),
 reply jsonb,reply_hash text,error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(conversation_id,client_turn_id),CHECK((reply IS NULL)=(reply_hash IS NULL))
);
CREATE INDEX case_assistant_turns_conversation ON business.case_assistant_turns(conversation_id,created_at DESC);
CREATE TABLE business.case_assistant_proposals (
 id uuid PRIMARY KEY,conversation_id uuid NOT NULL REFERENCES business.case_assistant_conversations(id),turn_id uuid NOT NULL REFERENCES business.case_assistant_turns(id),
 case_id uuid NOT NULL REFERENCES business.cases(id),kind text NOT NULL CHECK(kind IN ('guidance')),
 body jsonb NOT NULL,content_hash text NOT NULL,notes jsonb NOT NULL DEFAULT '[]',
 case_revision integer NOT NULL,round_id uuid REFERENCES business.review_rounds(id),configuration_release_id text NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','applied','canceled','expired','stale','superseded')),
 guidance_id uuid REFERENCES business.case_review_guidance(id),expires_at timestamptz NOT NULL,
 decided_by uuid,decided_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((state='applied')=(guidance_id IS NOT NULL))
);
CREATE INDEX case_assistant_proposals_conversation ON business.case_assistant_proposals(conversation_id,state);
CREATE TABLE business.case_assistant_calls (
 id uuid PRIMARY KEY,turn_id uuid NOT NULL REFERENCES business.case_assistant_turns(id),payload_hash text NOT NULL,
 policy_hash text NOT NULL,profile_hash text NOT NULL,reserved_micros bigint NOT NULL CHECK(reserved_micros>=0),
 state text NOT NULL CHECK(state IN ('unknown','completed','failed')),response jsonb,error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,UNIQUE(turn_id)
);
-- Proposal content and turn questions are fixed once written.
CREATE FUNCTION business.protect_case_assistant_turn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'case_assistant_record_immutable'; END IF;
 IF ROW(OLD.id,OLD.conversation_id,OLD.case_id,OLD.client_turn_id,OLD.mode,OLD.text,OLD.page,OLD.context,OLD.context_hash,OLD.account_id,OLD.person_id,OLD.auth_version,OLD.case_revision,OLD.round_id)
  IS DISTINCT FROM ROW(NEW.id,NEW.conversation_id,NEW.case_id,NEW.client_turn_id,NEW.mode,NEW.text,NEW.page,NEW.context,NEW.context_hash,NEW.account_id,NEW.person_id,NEW.auth_version,NEW.case_revision,NEW.round_id)
  OR OLD.reply IS NOT NULL AND NEW.reply IS DISTINCT FROM OLD.reply THEN RAISE EXCEPTION 'case_assistant_record_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION business.protect_case_assistant_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'case_assistant_record_immutable'; END IF;
 IF OLD.state<>'pending' OR ROW(OLD.id,OLD.conversation_id,OLD.turn_id,OLD.case_id,OLD.kind,OLD.body,OLD.content_hash,OLD.case_revision,OLD.round_id,OLD.configuration_release_id,OLD.expires_at)
  IS DISTINCT FROM ROW(NEW.id,NEW.conversation_id,NEW.turn_id,NEW.case_id,NEW.kind,NEW.body,NEW.content_hash,NEW.case_revision,NEW.round_id,NEW.configuration_release_id,NEW.expires_at)
 THEN RAISE EXCEPTION 'case_assistant_record_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_case_assistant_turn BEFORE UPDATE OR DELETE ON business.case_assistant_turns FOR EACH ROW EXECUTE FUNCTION business.protect_case_assistant_turn();
CREATE TRIGGER immutable_case_assistant_proposal BEFORE UPDATE OR DELETE ON business.case_assistant_proposals FOR EACH ROW EXECUTE FUNCTION business.protect_case_assistant_proposal();
CREATE TRIGGER immutable_case_assistant_call BEFORE UPDATE ON business.case_assistant_calls FOR EACH ROW EXECUTE FUNCTION business.protect_document_translation_call();

REVOKE ALL ON business.case_assistant_conversations,business.case_assistant_turns,business.case_assistant_proposals,business.case_assistant_calls FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT,UPDATE ON business.case_assistant_conversations,business.case_assistant_turns,business.case_assistant_proposals TO hsbc_p1_api;
GRANT SELECT ON business.case_assistant_calls TO hsbc_p1_api;
GRANT SELECT,UPDATE ON business.case_assistant_conversations TO hsbc_p1_worker;
GRANT SELECT,UPDATE ON business.case_assistant_turns TO hsbc_p1_worker;
GRANT SELECT,INSERT,UPDATE ON business.case_assistant_proposals,business.case_assistant_calls TO hsbc_p1_worker;
