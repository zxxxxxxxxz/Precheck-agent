-- An explicit, unconfirmed termination can happen before the first review run.
-- Normal completion still requires a run and keeps the original receipt invariant.
ALTER TABLE business.cases DROP CONSTRAINT complete_closure_receipt;
ALTER TABLE business.cases ADD CONSTRAINT complete_closure_receipt CHECK (
 (closed_at IS NULL AND closed_by IS NULL AND closure_reason IS NULL
  AND closed_round_id IS NULL AND closed_run_id IS NULL AND closure_receipt IS NULL)
 OR
 (closed_at IS NOT NULL AND closed_by IS NOT NULL
  AND closure_reason IS NOT NULL AND length(trim(closure_reason)) > 0
  AND closure_receipt IS NOT NULL
  AND (closed_run_id IS NOT NULL OR
   (checker_required AND closed_round_id IS NOT NULL
    AND COALESCE(closure_receipt->>'kind' = 'checker_terminated', false)
    AND COALESCE(closure_receipt->'confirmed' = 'false'::jsonb, false))))
);
