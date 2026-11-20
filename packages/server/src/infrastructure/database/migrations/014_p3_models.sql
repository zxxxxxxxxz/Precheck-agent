CREATE TABLE business.intake_turns (
 id uuid PRIMARY KEY, draft_id uuid NOT NULL REFERENCES business.case_drafts(id),
 owner_person_id uuid NOT NULL, account_id uuid NOT NULL, auth_version integer NOT NULL,
 draft_revision integer NOT NULL CHECK(draft_revision>0), client_turn_id uuid NOT NULL,
 input_hash text NOT NULL, text text NOT NULL CHECK(length(text)<=5000),
 fields_snapshot jsonb NOT NULL, questions jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','ready','failed','canceled','unknown','stale')),
 error_code text, expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(draft_id,owner_person_id,client_turn_id)
);
CREATE INDEX intake_turns_draft ON business.intake_turns(draft_id,created_at);
CREATE TABLE business.intake_candidates (
 id uuid PRIMARY KEY,turn_id uuid NOT NULL REFERENCES business.intake_turns(id) ON DELETE CASCADE,
 field text NOT NULL CHECK(field IN ('scenario','title','reference','background')),value text NOT NULL CHECK(length(value)<=5000),
 UNIQUE(turn_id,field)
);
CREATE TABLE business.intake_events (
 turn_id uuid NOT NULL REFERENCES business.intake_turns(id) ON DELETE CASCADE,seq integer NOT NULL CHECK(seq>0),
 type text NOT NULL CHECK(type IN ('stage','suggestion','completed','failed','canceled')),body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(turn_id,seq)
);
CREATE TABLE business.model_calls (
 id uuid PRIMARY KEY,turn_id uuid NOT NULL REFERENCES business.intake_turns(id) ON DELETE CASCADE,
 profile_id text NOT NULL CHECK(profile_id IN ('local_intake','cloud_assistant')),profile_version text NOT NULL,
 task_type text NOT NULL CHECK(task_type='draft_intake'),policy_version text,projection jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','sent','completed','failed','canceled','unknown')),
 reserved_micros bigint NOT NULL DEFAULT 0 CHECK(reserved_micros>=0),charged_micros bigint CHECK(charged_micros>=0),
 payload_hash text,provider_request_id text,actual_model text,actual_provider text,usage jsonb,error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),sent_at timestamptz,
 UNIQUE(turn_id,profile_id)
);
CREATE TABLE business.model_egress_receipts (
 id uuid PRIMARY KEY,call_id uuid NOT NULL REFERENCES business.model_calls(id),payload_hash text NOT NULL,
 policy_version text NOT NULL,provider text NOT NULL,endpoint text NOT NULL,data_classes jsonb NOT NULL,
 decision text NOT NULL CHECK(decision IN ('approved','denied')),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE business.model_budgets (
 profile_id text NOT NULL,budget_day date NOT NULL,reserved_micros bigint NOT NULL DEFAULT 0 CHECK(reserved_micros>=0),
 charged_micros bigint NOT NULL DEFAULT 0 CHECK(charged_micros>=0),PRIMARY KEY(profile_id,budget_day)
);
-- Only the migration/operator identity may authorize fixed synthetic fixtures.
-- Runtime users cannot self-label arbitrary input as synthetic.
CREATE TABLE business.model_fixture_grants (
 draft_id uuid NOT NULL REFERENCES business.case_drafts(id),owner_person_id uuid NOT NULL,input_fingerprint text NOT NULL,
 policy_version text NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(draft_id,input_fingerprint,policy_version)
);
REVOKE ALL ON business.intake_turns,business.intake_candidates,business.intake_events,business.model_calls,business.model_egress_receipts,business.model_budgets,business.model_fixture_grants FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT,UPDATE ON business.intake_turns,business.intake_candidates,business.intake_events,business.model_calls,business.model_egress_receipts,business.model_budgets TO hsbc_p1_api,hsbc_p1_worker;
GRANT SELECT ON business.model_fixture_grants TO hsbc_p1_api,hsbc_p1_worker;
GRANT DELETE ON business.intake_turns,business.intake_candidates,business.intake_events TO hsbc_p1_worker;
GRANT SELECT ON business.case_drafts TO hsbc_p1_worker;
-- FOR UPDATE is required for the same draft/person lock order as every business command.
GRANT UPDATE(revision) ON business.case_drafts TO hsbc_p1_worker;
