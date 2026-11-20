-- V2 is additive: historical v1 turns and candidate-only cloud permissions remain valid.
ALTER TABLE business.intake_turns
 ADD COLUMN protocol_version integer NOT NULL DEFAULT 1 CHECK(protocol_version IN (1,2)),
 ADD COLUMN attachment_ids uuid[] NOT NULL DEFAULT '{}',
 ADD COLUMN input_snapshot jsonb NOT NULL DEFAULT '{}',
 ADD COLUMN reply_blocks jsonb NOT NULL DEFAULT '[]',
 ADD COLUMN assistant_questions jsonb NOT NULL DEFAULT '[]',
 ADD COLUMN result_revision integer,
 ADD COLUMN applied_fields text[] NOT NULL DEFAULT '{}',
 ADD COLUMN conflict_fields text[] NOT NULL DEFAULT '{}';
ALTER TABLE business.intake_events DROP CONSTRAINT intake_events_type_check;
ALTER TABLE business.intake_events ADD CONSTRAINT intake_events_type_check CHECK(type IN ('stage','suggestion','step','assistant_delta','draft_updated','completed','failed','canceled'));
ALTER TABLE business.intake_candidates ADD COLUMN source_refs jsonb NOT NULL DEFAULT '[]';
ALTER TABLE business.model_calls DROP CONSTRAINT model_calls_turn_id_profile_id_key;
ALTER TABLE business.model_calls
 ADD COLUMN step_key text NOT NULL DEFAULT 'legacy',
 ADD COLUMN call_index integer NOT NULL DEFAULT 0 CHECK(call_index>=0),
 ADD COLUMN parent_call_id uuid REFERENCES business.model_calls(id),
 ADD COLUMN result jsonb,
 ADD CONSTRAINT model_calls_step_unique UNIQUE(turn_id,profile_id,step_key,call_index);
CREATE TABLE business.intake_private_projections (
 turn_id uuid PRIMARY KEY REFERENCES business.intake_turns(id),
 draft_id uuid NOT NULL REFERENCES business.case_drafts(id),
 projection jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX intake_private_projections_draft ON business.intake_private_projections(draft_id,created_at DESC);
CREATE TABLE business.intake_autofill_receipts (
 turn_id uuid PRIMARY KEY REFERENCES business.intake_turns(id),
 draft_id uuid NOT NULL REFERENCES business.case_drafts(id),
 before_fields jsonb NOT NULL,before_states jsonb NOT NULL,before_sources jsonb NOT NULL,
 applied_fields text[] NOT NULL,result_revision integer NOT NULL,
 undone_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON business.intake_private_projections,business.intake_autofill_receipts FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT,UPDATE ON business.intake_private_projections,business.intake_autofill_receipts TO hsbc_p1_api,hsbc_p1_worker;
GRANT UPDATE(fields,field_states,field_sources,updated_at) ON business.case_drafts TO hsbc_p1_worker;
