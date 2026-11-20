-- P0 synthetic ledger. Run explicitly as the migration role, never on API startup.
CREATE TABLE IF NOT EXISTS business.p0_cases (
  id text PRIMARY KEY, revision integer NOT NULL CHECK (revision > 0)
);
CREATE TABLE IF NOT EXISTS business.agent_tasks (
  id uuid PRIMARY KEY, message_id text NOT NULL, context_id uuid NOT NULL,
  case_id text NOT NULL REFERENCES business.p0_cases(id), revision integer NOT NULL,
  scope jsonb NOT NULL, input text NOT NULL, input_hash text NOT NULL,
  state text NOT NULL DEFAULT 'submitted', cancel_requested boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), artifact_refs jsonb NOT NULL DEFAULT '[]',
  UNIQUE (case_id, revision, message_id)
);
CREATE TABLE IF NOT EXISTS business.thread_owners (
  task_id uuid PRIMARY KEY REFERENCES business.agent_tasks(id), owner uuid,
  epoch bigint NOT NULL DEFAULT 0, lease_until timestamptz
);
CREATE TABLE IF NOT EXISTS business.work_items (
  id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES business.agent_tasks(id),
  kind text NOT NULL CHECK (kind IN ('workflow','document')), state text NOT NULL DEFAULT 'pending',
  dedup_key text NOT NULL UNIQUE, attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS business.outbox (
  work_id uuid PRIMARY KEY REFERENCES business.work_items(id), deliveries integer NOT NULL DEFAULT 0,
  last_dispatched_at timestamptz
);
CREATE TABLE IF NOT EXISTS business.workflow_waits (
  task_id uuid PRIMARY KEY REFERENCES business.agent_tasks(id), id uuid NOT NULL UNIQUE,
  phase text NOT NULL DEFAULT 'preparing' CHECK (phase IN ('preparing','armed','closed')),
  interrupt_id text, assigned_person text NOT NULL DEFAULT 'checker-person'
);
CREATE TABLE IF NOT EXISTS business.human_decisions (
  id uuid PRIMARY KEY, wait_id uuid NOT NULL REFERENCES business.workflow_waits(id),
  actor_person text NOT NULL, idempotency_key text NOT NULL, value text NOT NULL CHECK (value IN ('confirm','reject')),
  reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(wait_id, idempotency_key), UNIQUE(wait_id)
);
CREATE TABLE IF NOT EXISTS business.inbox (
  id uuid PRIMARY KEY REFERENCES business.human_decisions(id), task_id uuid NOT NULL,
  accepted boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS business.p0_effects (
  task_id uuid PRIMARY KEY REFERENCES business.agent_tasks(id), decision_id uuid NOT NULL,
  value text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS business.tool_jobs (
  id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES business.agent_tasks(id),
  case_id text NOT NULL, revision integer NOT NULL, document_version_id text NOT NULL,
  idempotency_key text NOT NULL, state text NOT NULL DEFAULT 'submitted', result jsonb,
  UNIQUE(task_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS business.recovery_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, task_id uuid,
  code text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS a2a.task_projection (
  task_id uuid PRIMARY KEY REFERENCES business.agent_tasks(id), state text NOT NULL,
  revision bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Saver connects with a separate checkpoint-only identity. This narrow function
-- serializes the ownership test with handover and validates authoritative scope.
CREATE OR REPLACE FUNCTION checkpoint.assert_owner(p_task uuid, p_owner uuid, p_epoch bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_task::text, 0));
  PERFORM 1 FROM (
    SELECT 1 FROM business.thread_owners o
    JOIN business.agent_tasks t ON t.id=o.task_id
    JOIN business.p0_cases c ON c.id=t.case_id AND c.revision=t.revision
    JOIN business.delegations d ON d.id=t.scope->>'delegationId'
    JOIN business.service_principals s ON s.id=d.service_id
    WHERE o.task_id=p_task AND o.owner=p_owner AND o.epoch=p_epoch
      AND o.lease_until > clock_timestamp() AND NOT t.cancel_requested
      AND t.state NOT IN ('completed','failed','canceled')
      AND NOT d.revoked AND d.expires_at>clock_timestamp() AND s.enabled
      AND d.authorization_version=(t.scope->>'authorizationVersion')::integer
      AND d.case_id=t.case_id AND d.revision=t.revision
      AND (d.task_id IS NULL OR d.task_id=t.id::text)
    FOR SHARE OF c,d,s
  ) AS verified;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale_execution' USING ERRCODE='P0001'; END IF;
END $$;
REVOKE ALL ON FUNCTION checkpoint.assert_owner(uuid,uuid,bigint) FROM PUBLIC;
GRANT USAGE ON SCHEMA checkpoint TO hsbc_p0_worker,hsbc_p0_api;
GRANT EXECUTE ON FUNCTION checkpoint.assert_owner(uuid,uuid,bigint) TO hsbc_p0_checkpoint,hsbc_p0_worker,hsbc_p0_api;
