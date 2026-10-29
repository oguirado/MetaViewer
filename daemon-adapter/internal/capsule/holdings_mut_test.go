package capsule

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// Direct admission controls bypass ParseHoldingsObserve's fixed source assignment.
func TestHoldingsMutValidateGroundTruth(t *testing.T) {
	for _, tc := range []struct {
		name, source, digest string
		tick                 uint64
		nilGT, wantErr       bool
	}{
		{name: "nil", nilGT: true, wantErr: true},
		{name: "empty_source", digest: strings.Repeat("a", 64), wantErr: true},
		{name: "vision_source", source: "vision_lane", digest: strings.Repeat("a", 64), wantErr: true},
		{name: "zero_tick", source: "holdings_lane", digest: strings.Repeat("a", 64)},
		{name: "max_tick", source: "holdings_lane", digest: strings.Repeat("a", 64), tick: MaxHoldingsTick},
		{name: "unsafe_tick", source: "holdings_lane", digest: strings.Repeat("a", 64), tick: MaxHoldingsTick + 1, wantErr: true},
		{name: "bad_digest", source: "holdings_lane", digest: "invalid", wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var gt *GroundTruth
			if !tc.nilGT {
				gt = &GroundTruth{Source: tc.source, StateSHA256: tc.digest, Tick: tc.tick}
			}
			if err := ValidateGroundTruth(gt); (err != nil) != tc.wantErr {
				t.Fatalf("ValidateGroundTruth(%+v)=%v, wantErr=%v", gt, err, tc.wantErr)
			}
		})
	}
}

type holdingsMutHookRunner struct {
	base     witnessRunner
	observes int
	hook     func()
}

func (r *holdingsMutHookRunner) Run(ctx context.Context, args []string, input []byte) ([]byte, error) {
	if len(args) > 1 && args[1] == "observe" {
		r.observes++
		if r.observes == 2 {
			r.hook()
		}
	}
	return r.base.Run(ctx, args, input)
}

func TestHoldingsMutLostDuringPostObserve(t *testing.T) {
	for _, state := range []string{"lost", "destroying"} {
		t.Run(state, func(t *testing.T) {
			m := testManager(t, &scriptRunner{})
			id := holdingsBinding(m)
			r := &holdingsMutHookRunner{base: witnessRunner{inputOut: []byte(`{"input_mono_ns":200}`), observeOut: []byte(`{"state_sha256":"` + strings.Repeat("a", 64) + `","tick":5}`)}}
			r.hook = func() {
				m.mu.Lock()
				defer m.mu.Unlock()
				if state == "destroying" {
					m.destroying[id] = true
				} else {
					b := m.bindings[id]
					b.Surface.State = "lost"
					m.bindings[id] = b
				}
			}
			m.runner = r
			m.cfg.VerifyHoldingsInput = func(context.Context, Binding, string, json.RawMessage, uint64) error { return nil }
			events, evidence, err := m.HandleInputWithEvidence(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"mut-lost","origin":"agent","action":{"type":"key","keys":["Return"]}}`))
			if r.observes != 2 {
				t.Fatalf("expected post-input observe hook, got %d observes", r.observes)
			}
			if err == nil || !strings.Contains(err.Error(), "surface lost during input verification") {
				t.Fatalf("want surface-lost fault, got %v", err)
			}
			if len(events) != 0 || evidence.GroundTruth != nil || evidence.BeforeGroundTruth != nil {
				t.Fatalf("lost surface emitted evidence/events: %+v %+v", events, evidence)
			}
		})
	}
}
