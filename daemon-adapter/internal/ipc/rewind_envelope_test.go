package ipc

import (
	"encoding/json"
	"os"
	"testing"
)

func TestRewindEnvelopeSeparateAndClosed(t *testing.T) {
	p, e := NewPolicy(ceilingConfig(), os.DirFS("../../../contracts/v0.2"), &dummyPolicy{})
	if e != nil {
		t.Fatal(e)
	}
	raw, e := os.ReadFile("../../../contracts/examples/v0.2/envelope.valid.json")
	if e != nil {
		t.Fatal(e)
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil {
		t.Fatal("fixture")
	}
	value["schema"] = "rewind_envelope/v0.2"
	value["body"] = map[string]any{"schema": "rewind_request/v0.2", "request_id": "request-test", "op": "pause", "params": map[string]any{"workload_id": "workload-test", "generation": 1, "authority_epoch": 1}}
	body, _ := json.Marshal(value["body"])
	if EnvelopeSchema(body) != "rewind_envelope/v0.2" {
		t.Fatal("selector")
	}
	encoded, _ := json.Marshal(value)
	if _, e = p.ValidateEnvelope(encoded); e != nil {
		t.Fatal(e)
	}
	for _, family := range []string{"envelope/v0.2", "capsule_envelope/v0.2"} {
		value["schema"] = family
		encoded, _ = json.Marshal(value)
		if _, e = p.ValidateEnvelope(encoded); e == nil {
			t.Fatal("cross-family body accepted")
		}
	}
}
