-- Independent review is required for every active case, irrespective of assignment.
-- Preserve historical closures and their original receipts; never infer a confirmation.
ALTER TABLE business.cases ALTER COLUMN checker_required SET DEFAULT true;
UPDATE business.cases SET checker_required=true,revision=revision+1,updated_at=now()
WHERE closed_at IS NULL AND NOT checker_required;

-- An explicit unreviewed termination may also precede the first material round.
-- Ordinary closure still requires a run; termination never supplies a confirmation.
ALTER TABLE business.cases DROP CONSTRAINT complete_closure_receipt;
ALTER TABLE business.cases ADD CONSTRAINT complete_closure_receipt CHECK (
 (closed_at IS NULL AND closed_by IS NULL AND closure_reason IS NULL
  AND closed_round_id IS NULL AND closed_run_id IS NULL AND closure_receipt IS NULL)
 OR
 (closed_at IS NOT NULL AND closed_by IS NOT NULL
  AND closure_reason IS NOT NULL AND length(trim(closure_reason)) > 0
  AND closure_receipt IS NOT NULL
  AND (closed_run_id IS NOT NULL OR
   (checker_required
    AND COALESCE(closure_receipt->>'kind' = 'checker_terminated', false)
    AND COALESCE(closure_receipt->'confirmed' = 'false'::jsonb, false))))
);
