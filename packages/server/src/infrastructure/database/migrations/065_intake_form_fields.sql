-- Additive assistant metadata; ordinary /api/cases creation remains authoritative.
ALTER TABLE business.case_drafts ADD COLUMN guarantee_types jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(guarantee_types) = 'array');
ALTER TABLE business.intake_candidates DROP CONSTRAINT intake_candidates_field_check;
ALTER TABLE business.intake_candidates ADD CONSTRAINT intake_candidates_field_check
  CHECK (field IN ('scenario','title','reference','background','customerNumber','jurisdiction','guaranteeCurrency','guaranteeAmount','guaranteeTypes'));
ALTER TABLE business.intake_autofill_receipts
  ADD COLUMN before_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN before_guarantee_types jsonb NOT NULL DEFAULT '[]'::jsonb;
GRANT UPDATE(details,guarantee_types) ON business.case_drafts TO hsbc_p1_worker;
