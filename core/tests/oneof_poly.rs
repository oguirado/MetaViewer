use metaviewer_core::wire::valid;
use serde_json::json;

#[test]
fn oneof_overlapping_branches_refuses_double_and_zero_matches() {
    let schema = json!({
        "oneOf": [
            {
                "type": "object",
                "additionalProperties": false,
                "required": ["kind"],
                "maxProperties": 256,
                "properties": {
                    "kind": { "type": "string", "enum": ["shared", "only_a"] },
                    "extra": { "type": "integer", "minimum": 1, "maximum": 10 }
                }
            },
            {
                "type": "object",
                "additionalProperties": false,
                "required": ["kind"],
                "maxProperties": 256,
                "properties": {
                    "kind": { "type": "string", "enum": ["shared", "only_b"] },
                    "extra": { "type": "integer", "minimum": 5, "maximum": 20 }
                }
            }
        ]
    });

    assert!(valid(
        &json!({ "kind": "only_a", "extra": 3 }),
        &schema,
        &schema
    ));
    assert!(valid(
        &json!({ "kind": "shared", "extra": 15 }),
        &schema,
        &schema
    ));
    assert!(!valid(
        &json!({ "kind": "shared", "extra": 7 }),
        &schema,
        &schema
    ));
    assert!(!valid(
        &json!({ "kind": "neither", "extra": 7 }),
        &schema,
        &schema
    ));
}
