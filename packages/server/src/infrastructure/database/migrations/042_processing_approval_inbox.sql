-- Existing approvals keep their original case-read authority. Inbox decisions
-- explicitly record their narrower request-level basis; no case grants are added.
ALTER TABLE business.document_processing_access
  ADD COLUMN approval_access_basis text NOT NULL DEFAULT 'case'
  CHECK (approval_access_basis IN ('case','request'));
ALTER TABLE business.document_processing_access
  DROP CONSTRAINT document_processing_access_state_check;
ALTER TABLE business.document_processing_access
  ADD CONSTRAINT document_processing_access_state_check
  CHECK (state IN ('pending','approved','rejected','revoked','withdrawn'));
CREATE INDEX document_processing_access_inbox
  ON business.document_processing_access(state,created_at,id)
  WHERE state IN ('pending','approved');
