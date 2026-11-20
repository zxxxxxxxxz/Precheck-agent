package hsbc.releases.demo_v1_test

import rego.v1

test_positive if {
    result := data.hsbc.releases.demo_v1.decision with input as {"schema":"hsbc-demo-v1","amount":1}
    result.outcome == "satisfied"
    result.release_id == "demo_v1"
    result.demo_only == true
}
test_zero_boundary if {
    result := data.hsbc.releases.demo_v1.decision with input as {"schema":"hsbc-demo-v1","amount":0}
    result.outcome == "not_satisfied"
}
test_negative if {
    result := data.hsbc.releases.demo_v1.decision with input as {"schema":"hsbc-demo-v1","amount":-1}
    result.outcome == "not_satisfied"
}
test_missing if {
    result := data.hsbc.releases.demo_v1.decision with input as {"schema":"hsbc-demo-v1"}
    result.outcome == "insufficient_evidence"
}
test_wrong_type if {
    result := data.hsbc.releases.demo_v1.decision with input as {"schema":"hsbc-demo-v1","amount":"100"}
    result.outcome == "insufficient_evidence"
}
test_unknown_schema_undefined if {
    not data.hsbc.releases.demo_v1.decision with input as {"schema":"unknown","amount":1}
}
test_version_input_cannot_select_code if {
    result := data.hsbc.releases.demo_v1.decision with input as {"schema":"hsbc-demo-v1","amount":1,"release_id":"forged_v2"}
    result.release_id == "demo_v1"
}
