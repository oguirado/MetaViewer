package ipc

import (
	"encoding/json"
	"os"
	"testing"
)

func TestRoleSwitchEnvelopeClosedAndCoreOnly(t *testing.T) {
	p, err := NewPolicy(ceilingConfig(), os.DirFS("../../../contracts/v0.2"), &dummyPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("../../../contracts/examples/v0.2/envelope.valid.json")
	if err != nil {
		t.Fatal(err)
	}
	makeEnvelope := func(body map[string]any, from, to, schema string) []byte {
		var e map[string]any
		_ = json.Unmarshal(raw, &e)
		e["schema"] = schema
		e["body"] = body
		e["from"] = map[string]string{"component": from, "instance": "source"}
		e["to"] = map[string]string{"component": to, "instance": "target"}
		b, _ := json.Marshal(e)
		return b
	}
	request := func() map[string]any {
		return map[string]any{"schema": "metaviewer.role_switch/v0.3", "request_id": "switch-1", "surface_id": "surface-1", "role": "agent"}
	}
	if _, err = p.ValidateEnvelope(makeEnvelope(request(), "core", "daemon", "role_switch_envelope/v0.3")); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []struct {
		from, to, schema string
		mutate           func(map[string]any)
	}{
		{"agent", "daemon", "role_switch_envelope/v0.3", func(map[string]any) {}},
		{"core", "ui", "role_switch_envelope/v0.3", func(map[string]any) {}},
		{"core", "daemon", "envelope/v0.2", func(map[string]any) {}},
		{"core", "daemon", "role_switch_envelope/v0.3", func(b map[string]any) { b["extra"] = true }},
		{"core", "daemon", "role_switch_envelope/v0.3", func(b map[string]any) { b["role"] = "shared" }},
		{"core", "daemon", "role_switch_envelope/v0.3", func(b map[string]any) { delete(b, "request_id") }},
	} {
		b := request()
		bad.mutate(b)
		if _, err = p.ValidateEnvelope(makeEnvelope(b, bad.from, bad.to, bad.schema)); err == nil {
			t.Fatal("invalid role request admitted")
		}
	}
	for _, ok := range []bool{true, false} {
		b := request()
		b["schema"] = "metaviewer.role_switch_result/v0.3"
		b["ok"] = ok
		if !ok {
			b["code"] = "POLICY"
		}
		if _, err = p.ValidateEnvelope(makeEnvelope(b, "daemon", "core", "role_switch_envelope/v0.3")); err != nil {
			t.Fatal(err)
		}
	}
}
