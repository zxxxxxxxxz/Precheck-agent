package system.authz

import rego.v1

default allow := false

# Only the infrastructure authorization policy may read process credentials.
# Business bundles are compiled against a narrower capabilities allowlist.
query_identity if {
    token := opa.runtime().env.OPA_QUERY_TOKEN
    count(token) >= 32
    input.identity == token
}

probe_identity if {
    token := opa.runtime().env.OPA_PROBE_TOKEN
    count(token) >= 32
    input.identity == token
}

known_identity if query_identity
known_identity if probe_identity

# Reject explain/metrics/query parameters; no trace or arbitrary-query endpoint.
plain_request if count(object.get(input, "params", {})) == 0

allow if {
    known_identity
    plain_request
    input.method == "GET"
    input.path == ["health"]
}

allow if {
    known_identity
    plain_request
    input.method == "POST"
    some release in data.hsbc.deployment.releases
    input.path == split(release.decision_path, "/")
}

allow if {
    probe_identity
    plain_request
    input.method == "POST"
    input.path == ["v1", "data", "hsbc", "health", "loaded"]
}
