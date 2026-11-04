package ipc

import (
	"encoding/json"
	"os"
	"testing"
)

func TestCommandObservationSeparateReadOnly(t *testing.T) {
	p, e := NewPolicy(ceilingConfig(), os.DirFS("../../../contracts/v0.2"), &dummyPolicy{})
	if e != nil {
		t.Fatal(e)
	}
	raw, e := os.ReadFile("../../../contracts/examples/v0.2/guest_command_observation_envelope.valid.json")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = p.ValidateEnvelope(raw); e != nil {
		t.Fatal(e)
	}
	var base map[string]any
	if json.Unmarshal(raw, &base) != nil {
		t.Fatal("fixture")
	}
	for _, family := range []string{"envelope/v0.2", "capsule_envelope/v0.2", "rewind_envelope/v0.2"} {
		base["schema"] = family
		b, _ := json.Marshal(base)
		if _, e = p.ValidateEnvelope(b); e == nil {
			t.Fatal("cross family accepted", family)
		}
	}
	for _, field := range []string{"from", "to"} {
		json.Unmarshal(raw, &base)
		base[field].(map[string]any)["component"] = "agent"
		b, _ := json.Marshal(base)
		if _, e = p.ValidateEnvelope(b); e == nil {
			t.Fatal("foreign direction accepted", field)
		}
	}
	for _, key := range []string{"accepted_event_id", "owner_id", "request_id", "job_id", "generation"} {
		json.Unmarshal(raw, &base)
		delete(base["body"].(map[string]any), key)
		b, _ := json.Marshal(base)
		if _, e = p.ValidateEnvelope(b); e == nil {
			t.Fatal("missing join accepted", key)
		}
	}
	for _, key := range []string{"stdin_b64", "authority_epoch", "env"} {
		json.Unmarshal(raw, &base)
		base["body"].(map[string]any)[key] = "forbidden"
		b, _ := json.Marshal(base)
		if _, e = p.ValidateEnvelope(b); e == nil {
			t.Fatal("extra authority accepted", key)
		}
	}
}
