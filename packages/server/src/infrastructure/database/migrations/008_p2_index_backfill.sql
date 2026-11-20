-- Upgrade existing P2 checkpoints from before the durable lexical index.
-- Uses only immutable, already-derived chunks; never schedules old materials.
INSERT INTO business.document_chunks
  (job_id,directory_revision,chunk_id,case_id,document_version_id,configuration_release_id,logical_document_id,page_numbers,content,text_sha256)
SELECT a.job_id,a.directory_revision,c.id,j.case_id,j.document_version_id,j.configuration_release_id,
       c."logicalDocumentId",c."pageNumbers",c.text,c."textSha256"
FROM business.document_artifacts a JOIN business.document_jobs j ON j.id=a.job_id
CROSS JOIN LATERAL jsonb_to_recordset(a.body->'chunks') AS c
  (id text,"logicalDocumentId" text,"pageNumbers" integer[],text text,"textSha256" text)
WHERE a.body->'scope'->>'parseRevision'=a.job_id::text
  AND a.body->'scope'->>'documentVersionId'=j.document_version_id::text
ON CONFLICT (job_id,directory_revision,chunk_id) DO NOTHING;
