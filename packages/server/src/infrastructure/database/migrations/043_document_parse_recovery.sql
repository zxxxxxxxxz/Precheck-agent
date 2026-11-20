-- Append-only recovery requests retain the original failure and model receipts.
CREATE TABLE business.document_parse_recoveries (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES business.document_jobs(id),
  work_item_id uuid NOT NULL REFERENCES business.work_items(id),
  requested_by uuid NOT NULL REFERENCES auth.accounts(id),
  previous_error_code text,
  mode text NOT NULL CHECK(mode IN ('prepare','cached')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_parse_recoveries_job ON business.document_parse_recoveries(job_id,created_at);
CREATE TRIGGER immutable_document_parse_recovery BEFORE UPDATE OR DELETE ON business.document_parse_recoveries
  FOR EACH ROW EXECUTE FUNCTION business.reject_document_configuration_change();
REVOKE ALL ON business.document_parse_recoveries FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT ON business.document_parse_recoveries TO hsbc_p1_api;
GRANT SELECT ON business.document_parse_recoveries TO hsbc_p1_worker;
-- API receives eligibility only, never private projection/response bodies.
CREATE FUNCTION business.document_recovery_status(target uuid)
RETURNS TABLE(unknown_calls boolean,failed_cloud boolean,completed_first boolean,privacy_version text,recovery_count bigint)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM business.document_model_calls WHERE job_id=target AND state='unknown'),
 EXISTS(SELECT 1 FROM business.document_model_calls WHERE job_id=target AND channel='cloud' AND state='failed'),
 EXISTS(SELECT 1 FROM business.document_model_calls WHERE job_id=target AND channel='cloud' AND step_key IN ('extract','extract:v2') AND state='completed'),
 (SELECT projection->>'redactionVersion' FROM business.document_model_snapshots WHERE job_id=target),
 (SELECT count(*) FROM business.document_parse_recoveries WHERE job_id=target)
$$;
REVOKE ALL ON FUNCTION business.document_recovery_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION business.document_recovery_status(uuid) TO hsbc_p1_api,hsbc_p1_worker;
