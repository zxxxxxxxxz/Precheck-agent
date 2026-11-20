-- Existing cases retain their historical identifiers; numbers belong to new creations only.
ALTER TABLE business.cases ADD COLUMN case_number text
  CHECK (case_number IS NULL OR case_number ~ '^CGT-[0-9]{8}-[0-9]{4,}$');
CREATE UNIQUE INDEX cases_case_number_unique ON business.cases(case_number) WHERE case_number IS NOT NULL;

-- Transactional counters: failed creations roll back the allocation with the case.
CREATE TABLE business.case_number_counters (
  business_date date PRIMARY KEY,
  last_number bigint NOT NULL CHECK (last_number > 0)
);
REVOKE ALL ON business.case_number_counters FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT,UPDATE ON business.case_number_counters TO hsbc_p1_api;

CREATE FUNCTION business.protect_case_number() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.case_number IS DISTINCT FROM OLD.case_number THEN
    RAISE EXCEPTION 'case_number_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_case_number BEFORE UPDATE OF case_number ON business.cases
  FOR EACH ROW EXECUTE FUNCTION business.protect_case_number();
REVOKE ALL ON FUNCTION business.protect_case_number() FROM PUBLIC;
