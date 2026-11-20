-- Migration 010 is immutable. PostgreSQL CHECK accepts UNKNOWN, so each member
-- of a present image identity must be explicitly non-NULL before value checks.
-- Validation is immediate: existing incomplete identities stop the migration
-- for operator review; no retained object reference is silently rewritten.
ALTER TABLE business.mock_validation_jobs
  ADD CONSTRAINT mock_validation_jobs_image_identity_complete CHECK (
    (image_key IS NULL AND image_version_id IS NULL AND image_sha256 IS NULL)
    OR
    (image_key IS NOT NULL AND image_version_id IS NOT NULL AND image_sha256 IS NOT NULL
      AND image_version_id NOT IN ('', 'null') AND image_sha256 ~ '^[a-f0-9]{64}$')
  );
