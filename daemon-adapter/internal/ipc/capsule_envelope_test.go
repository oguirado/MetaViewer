package ipc

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func TestCapsuleEnvelopeContractIsSeparateFromLegacy(t *testing.T) {
	p, err := NewPolicy(ceilingConfig(), os.DirFS("../../../contracts/v0.2"), &dummyPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	files, err := filepath.Glob("../../../contracts/examples/v0.2/capsule_envelope.valid.*.json")
	if err != nil || len(files) == 0 {
		t.Fatal("capsule corpus absent", err)
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
		if e.Schema != EnvelopeSchema(e.Body) {
			t.Fatal("selector disagrees with canonical capsule fixture")
		}
		var v map[string]any
		if json.Unmarshal(raw, &v) != nil {
			t.Fatal("fixture JSON")
		}
		v["schema"] = "envelope/v0.2"
		wrong, _ := json.Marshal(v)
		if _, err = p.ValidateEnvelope(wrong); err == nil {
			t.Fatal("extension accepted as unchanged legacy contract")
		}
	}
	legacy, err := os.ReadFile("../../../contracts/examples/v0.2/envelope.valid.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.ValidateEnvelope(legacy); err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	_ = json.Unmarshal(legacy, &v)
	v["schema"] = "capsule_envelope/v0.2"
	wrong, _ := json.Marshal(v)
	if _, err = p.ValidateEnvelope(wrong); err == nil {
		t.Fatal("legacy accepted in capsule envelope")
	}
	v["schema"] = "capsule_envelope/v0.3"
	wrong, _ = json.Marshal(v)
	if _, err = p.ValidateEnvelope(wrong); err == nil {
		t.Fatal("unknown tag accepted")
	}
}

func TestCapsuleEnvelopeCannotBeMalformedOrReplaceLegacyRoot(t *testing.T) {
	entries, err := os.ReadDir("../../../contracts/v0.2")
	if err != nil {
		t.Fatal(err)
	}
	source := fstest.MapFS{}
	for _, e := range entries {
		if !e.IsDir() {
			b, err := os.ReadFile("../../../contracts/v0.2/" + e.Name())
			if err != nil {
				t.Fatal(err)
			}
			source[e.Name()] = &fstest.MapFile{Data: b}
		}
	}
	good := source["capsule_envelope.schema.json"].Data
	for _, bad := range []string{`{}`, `{"type":"object","additionalProperties":true}`, `{"$ref":"envelope.schema.json"}`} {
		source["capsule_envelope.schema.json"] = &fstest.MapFile{Data: []byte(bad)}
		if _, err := NewPolicy(ceilingConfig(), source, &dummyPolicy{}); err == nil {
			t.Fatal("malformed capsule root accepted")
		}
	}
	source["capsule_envelope.schema.json"] = &fstest.MapFile{Data: good}
	delete(source, "capsule_envelope.schema.json")
	p, err := NewPolicy(ceilingConfig(), source, &dummyPolicy{})
	if err != nil {
		t.Fatal("legacy-only deployment failed", err)
	}
	files, _ := filepath.Glob("../../../contracts/examples/v0.2/capsule_envelope.valid.*.json")
	raw, _ := os.ReadFile(files[0])
	if _, err = p.ValidateEnvelope(raw); err == nil {
		t.Fatal("missing capsule contract silently admitted")
	}
}
