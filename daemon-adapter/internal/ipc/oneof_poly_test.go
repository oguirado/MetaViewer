package ipc

import (
	"testing"
	"testing/fstest"
)

func TestOneOfOverlappingBranchesParity(t *testing.T) {
	overlapping := fstest.MapFS{
		"envelope.schema.json": &fstest.MapFile{Data: []byte(`{
			"type": "object",
			"additionalProperties": false,
			"required": ["schema", "body"],
			"properties": {
				"schema": {"type": "string", "const": "envelope/v0.2"},
				"body": {
					"oneOf": [
						{
							"type": "object",
							"additionalProperties": false,
							"required": ["kind"],
							"properties": {
								"kind": {"type": "string", "enum": ["shared", "only_a"]},
								"extra": {"type": "integer", "minimum": 1, "maximum": 10}
							}
						},
						{
							"type": "object",
							"additionalProperties": false,
							"required": ["kind"],
							"properties": {
								"kind": {"type": "string", "enum": ["shared", "only_b"]},
								"extra": {"type": "integer", "minimum": 5, "maximum": 20}
							}
						}
					]
				}
			}
		}`)},
	}
	sp, err := NewPolicy(ceilingConfig(), overlapping, &dummyPolicy{})
	if err != nil {
		t.Fatalf("NewPolicy failed on synthetic overlapping schema: %v", err)
	}

	if _, err := sp.ValidateEnvelope([]byte(`{"schema":"envelope/v0.2","body":{"kind":"only_a","extra":3}}`)); err != nil {
		t.Fatalf("single-match branch A refused: %v", err)
	}
	if _, err := sp.ValidateEnvelope([]byte(`{"schema":"envelope/v0.2","body":{"kind":"shared","extra":15}}`)); err != nil {
		t.Fatalf("single-match branch B refused: %v", err)
	}
	if _, err := sp.ValidateEnvelope([]byte(`{"schema":"envelope/v0.2","body":{"kind":"shared","extra":7}}`)); err == nil {
		t.Fatal("double-match value admitted by oneOf")
	}
	if _, err := sp.ValidateEnvelope([]byte(`{"schema":"envelope/v0.2","body":{"kind":"neither","extra":7}}`)); err == nil {
		t.Fatal("zero-match value admitted by oneOf")
	}
}
