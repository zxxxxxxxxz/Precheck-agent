-- Upload ownership is explicit; original case-upload semantics remain unchanged.
ALTER TABLE business.upload_sessions ALTER COLUMN case_id DROP NOT NULL;
ALTER TABLE business.upload_sessions ADD COLUMN draft_id uuid REFERENCES business.case_drafts(id);
ALTER TABLE business.upload_sessions ADD CONSTRAINT upload_single_owner CHECK(num_nonnulls(case_id,draft_id)=1);
CREATE INDEX upload_sessions_draft ON business.upload_sessions(draft_id,created_at);
ALTER TABLE business.upload_sessions DROP CONSTRAINT upload_sessions_mime_type_check;
ALTER TABLE business.upload_sessions ADD CONSTRAINT upload_sessions_mime_type_check CHECK(mime_type IN ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/jpeg','image/png'));
ALTER TABLE business.document_versions DROP CONSTRAINT document_versions_source_format_check;
ALTER TABLE business.document_versions ADD CONSTRAINT document_versions_source_format_check CHECK(source_format IN ('pdf','docx','jpg','png'));
ALTER TABLE business.document_versions DROP CONSTRAINT document_original_pages;
ALTER TABLE business.document_versions ADD CONSTRAINT document_original_pages CHECK(
 (source_format='pdf' AND page_count>0 AND page_count IS NOT NULL) OR (source_format='docx' AND page_count IS NULL) OR (source_format IN ('jpg','png') AND page_count=1));
CREATE TABLE business.draft_attachments (
 id uuid PRIMARY KEY REFERENCES business.upload_sessions(id),
 draft_id uuid NOT NULL REFERENCES business.case_drafts(id),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 page_count integer CHECK(page_count>0),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','removed','adopted')),
 parse_state text NOT NULL DEFAULT 'idle' CHECK(parse_state IN ('idle','running','ready','failed')),
 parse_epoch integer NOT NULL DEFAULT 0,
 parse_lease_until timestamptz,
 parser_version text,
 parse_error_code text,
 extraction_result jsonb,
 created_case_material_id uuid UNIQUE REFERENCES business.document_versions(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((state='adopted')=(created_case_material_id IS NOT NULL))
);
CREATE INDEX draft_attachments_draft ON business.draft_attachments(draft_id,created_at);
REVOKE ALL ON business.draft_attachments FROM PUBLIC,hsbc_p1_checkpoint;
GRANT SELECT,INSERT,UPDATE ON business.draft_attachments TO hsbc_p1_api,hsbc_p1_worker;
