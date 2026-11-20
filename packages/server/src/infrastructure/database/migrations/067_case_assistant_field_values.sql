-- An assistant proposal may also carry a value for an empty field, awaiting the reviewer's confirmation.
-- Rule proposals keep their link to the saved rule; a field value is recorded by the review command instead.
ALTER TABLE business.case_assistant_proposals DROP CONSTRAINT case_assistant_proposals_kind_check;
ALTER TABLE business.case_assistant_proposals ADD CONSTRAINT case_assistant_proposals_kind_check CHECK(kind IN ('guidance','field_value'));
ALTER TABLE business.case_assistant_proposals DROP CONSTRAINT case_assistant_proposals_check;
ALTER TABLE business.case_assistant_proposals ADD CONSTRAINT case_assistant_proposals_applied_check
  CHECK(CASE WHEN kind='guidance' THEN (state='applied')=(guidance_id IS NOT NULL) ELSE guidance_id IS NULL END);
