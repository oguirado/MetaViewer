package ipc

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestGraphicalEnvelopeSeparationAndAuthority(t *testing.T) {
	p, err := NewPolicy(ceilingConfig(), os.DirFS("../../../contracts/v0.2"), &dummyPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	files, err := filepath.Glob("../../../contracts/examples/v0.2/graphical_session_envelope.valid.*.json")
	if err != nil || len(files) == 0 {
		t.Fatal("graphical fixtures absent", err)
	}
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		e, err := p.ValidateEnvelope(raw)
		if err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		if EnvelopeSchema(e.Body) != "graphical_session_envelope/v0.2" {
			t.Fatal("wrong selector")
		}
		var x map[string]any
		json.Unmarshal(raw, &x)
		for _, schema := range []string{"envelope/v0.2", "capsule_envelope/v0.2", "rewind_envelope/v0.2"} {
			x["schema"] = schema
			bad, _ := json.Marshal(x)
			if _, err := p.ValidateEnvelope(bad); err == nil {
				t.Fatalf("graphical body crossed into %s", schema)
			}
		}
	}
	raw, err := os.ReadFile("../../../contracts/examples/v0.2/graphical_session_envelope.invalid.agent.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.ValidateEnvelope(raw); err == nil {
		t.Fatal("agent authority admitted")
	}
	raw, err = os.ReadFile("../../../contracts/examples/v0.2/envelope.valid.json")
	if err != nil {
		t.Fatal(err)
	}
	var x map[string]any
	json.Unmarshal(raw, &x)
	x["schema"] = "graphical_session_envelope/v0.2"
	bad, _ := json.Marshal(x)
	if _, err := p.ValidateEnvelope(bad); err == nil {
		t.Fatal("legacy body entered graphical envelope")
	}
}
