-- Optional manually entered metadata; existing drafts and cases remain empty.
ALTER TABLE business.case_drafts ADD COLUMN details jsonb NOT NULL
  DEFAULT '{"customerNumber":"","jurisdiction":null,"guaranteeAmount":null}'::jsonb
  CHECK (jsonb_typeof(details) = 'object');
ALTER TABLE business.cases ADD COLUMN details jsonb NOT NULL
  DEFAULT '{"customerNumber":"","jurisdiction":null,"guaranteeAmount":null}'::jsonb
  CHECK (jsonb_typeof(details) = 'object');
