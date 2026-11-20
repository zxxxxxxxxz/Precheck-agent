-- Existing PDF originals and P0 contracts remain untouched. DOCX has no intrinsic pages.
ALTER TABLE business.upload_sessions ADD COLUMN mime_type text NOT NULL DEFAULT 'application/pdf'
 CHECK(mime_type IN ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
ALTER TABLE business.document_versions ADD COLUMN source_format text NOT NULL DEFAULT 'pdf' CHECK(source_format IN ('pdf','docx'));
ALTER TABLE business.document_versions ALTER COLUMN page_count DROP NOT NULL;
ALTER TABLE business.document_versions ADD CONSTRAINT document_original_pages CHECK(
 (source_format='pdf' AND page_count>0 AND page_count IS NOT NULL) OR (source_format='docx' AND page_count IS NULL));
ALTER TABLE business.document_jobs ALTER COLUMN total_pages DROP NOT NULL;
ALTER TABLE business.document_pages ADD COLUMN stored_bytes bigint NOT NULL DEFAULT 0 CHECK(stored_bytes>=0);
CREATE TABLE business.document_sources (
 job_id uuid PRIMARY KEY REFERENCES business.document_jobs(id), body jsonb NOT NULL,
 object_key text NOT NULL, oss_version_id text NOT NULL CHECK(oss_version_id NOT IN ('','null')),
 sha256 text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE business.document_previews (
 job_id uuid PRIMARY KEY REFERENCES business.document_jobs(id), id uuid UNIQUE NOT NULL,
 state text NOT NULL CHECK(state IN ('ready','partial','failed','unavailable')),
 manifest jsonb, coverage_gaps jsonb NOT NULL DEFAULT '[]', error_code text,
 pdf_key text, pdf_version_id text, pdf_sha256 text, page_count integer,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((state IN ('ready','partial') AND pdf_key IS NOT NULL AND pdf_version_id IS NOT NULL AND pdf_version_id NOT IN ('','null') AND pdf_sha256 IS NOT NULL AND page_count IS NOT NULL AND page_count>0 AND manifest IS NOT NULL)
  OR (state IN ('failed','unavailable') AND pdf_key IS NULL AND pdf_version_id IS NULL AND pdf_sha256 IS NULL AND page_count IS NULL))
);
CREATE TABLE business.document_source_mappings (
 job_id uuid PRIMARY KEY REFERENCES business.document_jobs(id), preview_id uuid REFERENCES business.document_previews(id),
 body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
