-- Persisted lexical index; candidates are always selected within an authorized
-- immutable parse/directory scope. No independent vector service is required.
CREATE TABLE business.document_chunks (
  job_id uuid NOT NULL, directory_revision integer NOT NULL,
  chunk_id text NOT NULL, case_id uuid NOT NULL REFERENCES business.cases(id),
  document_version_id uuid NOT NULL REFERENCES business.document_versions(id),
  configuration_release_id text NOT NULL REFERENCES business.document_configurations(id),
  logical_document_id text NOT NULL, page_numbers integer[] NOT NULL,
  content text NOT NULL, text_sha256 text NOT NULL,
  terms tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED,
  PRIMARY KEY(job_id,directory_revision,chunk_id),
  FOREIGN KEY(job_id,directory_revision) REFERENCES business.document_artifacts(job_id,directory_revision)
);
CREATE INDEX document_chunks_terms ON business.document_chunks USING gin(terms);
CREATE INDEX document_chunks_scope ON business.document_chunks(case_id,document_version_id,job_id,directory_revision);
CREATE INDEX document_chunks_pages ON business.document_chunks USING gin(page_numbers);
