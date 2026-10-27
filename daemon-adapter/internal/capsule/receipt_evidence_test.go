package capsule

import (
	"context"
	"encoding/json"
	"testing"
)

func TestInputEvidenceIsRequestLocal(t *testing.T) {
	runner := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, runner)
	id := createID(t, m)
	runner.output = []byte(`{"surface_id":"w1","kind":"key","input_mono_ns":200,"focus_verified":true,"result":"ok"}`)
	r := req("input", `{"surface_id":"`+id+`","proposal_id":"proof","action":{"type":"key","keys":["Escape"]}}`)
	_, evidence, err := m.HandleInputWithEvidence(context.Background(), r)
	if err != nil || evidence.SurfaceID != id || evidence.InputMonoNS != 200 || evidence.InputTSNS != 100 || evidence.FocusVerified == nil || !*evidence.FocusVerified {
		t.Fatalf("native evidence missing: %+v %v", evidence, err)
	}
	// Replay, invalid proof and a non-input request must never inherit evidence.
	for _, request := range []Request{r, req("list", `{}`), req("input", `{"surface_id":"`+id+`","proposal_id":"unfocused","action":{"type":"key","keys":["Escape"]}}`)} {
		runner.output = []byte(`{"surface_id":"w1","kind":"key","input_mono_ns":200,"focus_verified":false,"result":"ok"}`)
		_, got, err := m.HandleInputWithEvidence(context.Background(), request)
		if err == nil || got != (InputEvidence{}) {
			t.Fatalf("failed request retained proof: %+v %v", got, err)
		}
	}
}

func TestHoldingsEvidenceNeverSynthesizesFocus(t *testing.T) {
	m := testManager(t, &scriptRunner{output: []byte(`{"input_mono_ns":200}`)})
	id := holdingsBinding(m)
	m.cfg.VerifyHoldingsInput = func(context.Context, Binding, string, json.RawMessage, uint64) error { return nil }
	_, evidence, err := m.HandleInputWithEvidence(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"holdings-proof","action":{"type":"key","keys":["Escape"]}}`))
	if err != nil || evidence.SurfaceID != id || evidence.InputMonoNS != 200 || evidence.InputTSNS != 100 {
		t.Fatalf("Holdings timestamp missing: %+v %v", evidence, err)
	}
	if evidence.FocusVerified != nil || evidence.NativeSurfaceID != "" || evidence.Kind != "" || evidence.Result != "" {
		t.Fatalf("Holdings evidence synthesized: %+v", evidence)
	}
}
