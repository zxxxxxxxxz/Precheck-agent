-- Explicit field-level provenance. Absence means historical provenance is unknown.
-- Never infer an account or model source for already stored values.
ALTER TABLE business.case_drafts ADD COLUMN field_sources jsonb NOT NULL DEFAULT '{}'
  CHECK(jsonb_typeof(field_sources)='object');
