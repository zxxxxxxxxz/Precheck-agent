-- SELECT FOR SHARE ordinarily requires UPDATE privilege. Keep API/Worker
-- delegations read-only while permitting their authorization transaction to
-- fence concurrent revocation. This function cannot change delegation data.
CREATE FUNCTION business.lock_document_delegation(target_id uuid)
RETURNS SETOF business.document_tool_delegations
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT d.* FROM business.document_tool_delegations d
  WHERE d.id=target_id FOR SHARE
$$;
REVOKE ALL ON FUNCTION business.lock_document_delegation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION business.lock_document_delegation(uuid) TO hsbc_p1_api,hsbc_p1_worker;
