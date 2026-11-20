-- Review snapshots use strings for business decimals and integer revisions.
-- This canonical encoding permits hash checks inside an isolated restore
-- without exporting any source text or confirmed facts to a report.
CREATE FUNCTION business.review_canonical_json(value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE result text;
BEGIN
  IF jsonb_typeof(value)='object' THEN
    SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||business.review_canonical_json(v),',' ORDER BY key COLLATE "C"),'')||'}'
      INTO result FROM jsonb_each(value) AS items(key,v);
  ELSIF jsonb_typeof(value)='array' THEN
    SELECT '['||coalesce(string_agg(business.review_canonical_json(v),',' ORDER BY ordinal),'')||']'
      INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS items(v,ordinal);
  ELSE result:=value::text;
  END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION business.review_canonical_json(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION business.review_canonical_json(jsonb) TO hsbc_p1_api,hsbc_p1_worker;
