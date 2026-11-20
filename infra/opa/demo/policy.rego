package hsbc.releases.demo_v1

import rego.v1

# Synthetic infrastructure probe only; not a bank policy or approval decision.
# Unrecognized schema is deliberately undefined: adapters must reject no result.
decision := {
    "release_id": data.hsbc.releases.demo_v1.metadata.release_id,
    "schema": data.hsbc.releases.demo_v1.metadata.schema,
    "demo_only": true,
    "outcome": outcome,
} if {
    input.schema == data.hsbc.releases.demo_v1.metadata.schema
}

outcome := "insufficient_evidence" if {
    not is_number(object.get(input, "amount", null))
} else := "not_satisfied" if {
    input.amount <= 0
} else := "satisfied"
