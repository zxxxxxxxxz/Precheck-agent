-- Every open case requires independent review. Preserve closed historical receipts.
ALTER TABLE business.cases ALTER COLUMN checker_required SET DEFAULT true;
UPDATE business.cases SET checker_required=true WHERE closed_at IS NULL AND NOT checker_required;
ALTER TABLE business.cases ADD CONSTRAINT open_case_requires_checker CHECK(checker_required OR closed_at IS NOT NULL);
