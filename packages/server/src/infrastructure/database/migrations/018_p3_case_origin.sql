-- The draft receipt and the case origin independently enforce one case per draft.
ALTER TABLE business.cases ADD COLUMN created_from_draft_id uuid UNIQUE
  REFERENCES business.case_drafts(id) DEFERRABLE INITIALLY DEFERRED;
UPDATE business.cases c SET created_from_draft_id=d.id FROM business.case_drafts d
  WHERE d.created_case_id=c.id;
