package system.authz_test

import rego.v1

runtime := {"env": {
    "OPA_QUERY_TOKEN": "query-token-synthetic-0000000000000000",
    "OPA_PROBE_TOKEN": "probe-token-synthetic-0000000000000000",
}}
registry := [{"decision_path": "v1/data/hsbc/releases/demo_v1/decision"}]
request := {"identity": runtime.env.OPA_QUERY_TOKEN, "method": "POST",
    "path": ["v1", "data", "hsbc", "releases", "demo_v1", "decision"], "params": {}}

allowed(req) if {
    data.system.authz.allow with input as req
        with opa.runtime as runtime
        with data.hsbc.deployment.releases as registry
}

test_registered_query if allowed(request)
test_health if allowed(object.union(request, {"method": "GET", "path": ["health"]}))
test_no_token if not allowed(object.remove(request, {"identity"}))
test_wrong_token if not allowed(object.union(request, {"identity": "wrong"}))
test_no_explain if not allowed(object.union(request, {"params": {"explain": ["full"]}}))
test_no_arbitrary_query if not allowed(object.union(request, {"path": ["v1", "query"]}))
test_no_root_data if not allowed(object.union(request, {"path": ["v1", "data"]}))
test_no_policy_management if not allowed(object.union(request, {"method": "PUT", "path": ["v1", "policies", "evil"]}))
test_no_data_management if not allowed(object.union(request, {"method": "PUT"}))
test_no_unknown_release if not allowed(object.union(request, {"path": ["v1", "data", "hsbc", "releases", "unknown", "decision"]}))
test_no_query_introspection if not allowed(object.union(request, {"path": ["v1", "data", "hsbc", "health", "loaded"]}))
test_probe_introspection if allowed(object.union(request, {"identity": runtime.env.OPA_PROBE_TOKEN,
    "path": ["v1", "data", "hsbc", "health", "loaded"]}))
