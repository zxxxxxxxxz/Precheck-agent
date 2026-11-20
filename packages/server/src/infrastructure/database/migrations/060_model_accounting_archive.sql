-- Minimal accounting evidence for calls removed by an approved historical cleanup.
-- No material, projection, credentials, executable work or case relationships are restored.
CREATE TABLE business.model_call_accounting_archives (
 call_id uuid PRIMARY KEY,
 profile_id text NOT NULL CHECK(profile_id IN ('local_intake','cloud_assistant')),
 budget_day date NOT NULL,
 reserved_micros bigint NOT NULL CHECK(reserved_micros>=0),
 charged_micros bigint NOT NULL CHECK(charged_micros>=0),
 original_state text NOT NULL CHECK(original_state IN ('pending','running','sent','completed','failed','canceled','unknown')),
 was_sent boolean NOT NULL,
 source_backup text NOT NULL CHECK(source_backup ~ '^[A-Za-z0-9_.-]+$'),
 source_dump_sha256 text NOT NULL CHECK(source_dump_sha256 ~ '^[a-f0-9]{64}$'),
 source_row_sha256 text NOT NULL CHECK(source_row_sha256 ~ '^[a-f0-9]{64}$'),
 recovered_at timestamptz NOT NULL DEFAULT now(),
 CHECK(reserved_micros+charged_micros>0),
 FOREIGN KEY(profile_id,budget_day) REFERENCES business.model_budgets(profile_id,budget_day)
);
REVOKE ALL ON business.model_call_accounting_archives FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
CREATE FUNCTION business.preserve_model_accounting_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'model_accounting_archive_immutable'; END;
$$;
CREATE TRIGGER preserve_model_accounting_archive BEFORE UPDATE OR DELETE ON business.model_call_accounting_archives
 FOR EACH ROW EXECUTE FUNCTION business.preserve_model_accounting_archive();
