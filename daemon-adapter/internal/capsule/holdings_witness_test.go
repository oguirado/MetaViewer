package capsule

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/cli"
)

type witnessRunner struct {
	calls      [][]string
	inputOut   []byte
	inputErr   error
	observeOut []byte
	observeErr error
}

func (r *witnessRunner) Run(_ context.Context, args []string, _ []byte) ([]byte, error) {
	cp := append([]string(nil), args...)
	r.calls = append(r.calls, cp)
	if len(args) < 2 {
		return nil, fault("usage", "missing verb")
	}
	switch filepath.Base(args[0]) + ":" + args[1] {
	case "srf-holdings-capsule:input":
		return r.inputOut, r.inputErr
	case "srf-holdings-capsule:observe":
		return r.observeOut, r.observeErr
	default:
		return nil, fault("unexpected", "unexpected command: "+strings.Join(args, " "))
	}
}

func TestHoldingsAgentOriginWitnessFetch(t *testing.T) {
	stateDigest := strings.Repeat("ab", 32)
	frameDigest := strings.Repeat("cd", 32)

	for _, tc := range []struct {
		name       string
		observeRaw string
		wantTick   uint64
	}{
		{
			name:       "full_observe_payload",
			observeRaw: `{"state_sha256":"` + stateDigest + `","tick":42,"revision":7,"frame_state_sha256":"` + frameDigest + `","elements":[{"id":"end_turn"}]}`,
			wantTick:   42,
		},
		{
			name:       "minimal_zero_tick",
			observeRaw: `{"state_sha256":"` + stateDigest + `","tick":0}`,
			wantTick:   0,
		},
		{
			name:       "max_safe_integer_tick",
			observeRaw: `{"state_sha256":"` + stateDigest + `","tick":9007199254740991,"revision":9007199254740991,"elements":[]}`,
			wantTick:   MaxHoldingsTick,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &witnessRunner{
				inputOut:   []byte(`{"input_mono_ns":200}`),
				observeOut: []byte(tc.observeRaw),
			}
			m := testManager(t, &scriptRunner{})
			m.runner = r
			id := holdingsBinding(m)
			verified := 0
			m.cfg.VerifyHoldingsInput = func(_ context.Context, b Binding, proposal string, _ json.RawMessage, stamp uint64) error {
				verified++
				if b.Container != "srf-ng-hcap-hc-0123456789ab-1" || proposal != "prop-"+tc.name || stamp != 200 {
					return fault("input", "verification mismatch")
				}
				return nil
			}

			events, evidence, err := m.HandleInputWithEvidence(
				context.Background(),
				req("input", `{"surface_id":"`+id+`","proposal_id":"prop-`+tc.name+`","origin":"agent","action":{"type":"key","keys":["Return"]}}`),
			)
			if err != nil {
				t.Fatalf("HandleInputWithEvidence failed: %v", err)
			}
			if len(events) != 1 || verified != 1 {
				t.Fatalf("expected 1 event and 1 verification call, got events=%d verified=%d", len(events), verified)
			}
			if len(r.calls) != 2 {
				t.Fatalf("expected input + observe calls, got %d (%v)", len(r.calls), r.calls)
			}
			if filepath.Base(r.calls[1][0]) != "srf-holdings-capsule" || len(r.calls[1]) != 4 || r.calls[1][1] != "observe" || r.calls[1][2] != "--container" || r.calls[1][3] != "srf-ng-hcap-hc-0123456789ab-1" {
				t.Fatalf("unexpected observe argv: %v", r.calls[1])
			}
			if evidence.GroundTruth == nil {
				t.Fatal("expected GroundTruth on InputEvidence, got nil")
			}
			want := GroundTruth{
				Source:      "holdings_lane",
				StateSHA256: stateDigest,
				Tick:        tc.wantTick,
			}
			if *evidence.GroundTruth != want {
				t.Fatalf("ground truth mismatch: got %+v, want %+v", *evidence.GroundTruth, want)
			}
		})
	}
}

func TestHoldingsHumanOriginOmitsWitnessFetch(t *testing.T) {
	stateDigest := strings.Repeat("ef", 32)
	r := &witnessRunner{
		inputOut:   []byte(`{"input_mono_ns":200}`),
		observeOut: []byte(`{"state_sha256":"` + stateDigest + `","tick":9}`),
	}
	m := testManager(t, &scriptRunner{})
	m.runner = r
	id := holdingsBinding(m)
	ctx := context.Background()

	if _, err := m.Handle(ctx, req("take_control", `{"surface_id":"`+id+`","owner":"human"}`)); err != nil {
		t.Fatal(err)
	}

	// 1. Human-origin Holdings input without VerifyHoldingsInput is refused.
	_, _, err := m.HandleInputWithEvidence(ctx, req("input", `{"surface_id":"`+id+`","proposal_id":"h-no-verifier","origin":"human","action":{"type":"key","keys":["a"]}}`))
	requireFault(t, err, "input")

	verifiedCalls := 0
	m.cfg.VerifyHoldingsInput = func(_ context.Context, _ Binding, _ string, _ json.RawMessage, stamp uint64) error {
		verifiedCalls++
		if stamp != 200 {
			return fault("input", "unexpected stamp")
		}
		return nil
	}

	// 2. Extra fields on the native input receipt are refused for human-origin input.
	for i, badReceipt := range []string{
		`{"input_mono_ns":200,"result":"ok"}`,
		`{"input_mono_ns":200,"surface_id":"w1"}`,
		`{"input_mono_ns":200,"kind":"key"}`,
		`{"input_mono_ns":200,"focus_verified":true}`,
		`{"input_mono_ns":200,"state_sha256":"` + stateDigest + `","tick":9}`,
	} {
		r.inputOut = []byte(badReceipt)
		prop := "h-extra-" + string(rune('a'+i))
		if _, _, err := m.HandleInputWithEvidence(ctx, req("input", `{"surface_id":"`+id+`","proposal_id":"`+prop+`","origin":"human","action":{"type":"key","keys":["a"]}}`)); err == nil {
			t.Fatalf("human-origin input accepted extra receipt fields: %s", badReceipt)
		}
	}
	if verifiedCalls != 0 {
		t.Fatalf("extra receipt fields reached VerifyHoldingsInput (%d calls)", verifiedCalls)
	}

	// 3. Valid human-origin Holdings input invokes VerifyHoldingsInput, does NOT call observe, and attaches no GroundTruth.
	r.inputOut = []byte(`{"input_mono_ns":200}`)
	r.calls = nil
	events, evidence, err := m.HandleInputWithEvidence(ctx, req("input", `{"surface_id":"`+id+`","proposal_id":"h-valid","origin":"human","action":{"type":"key","keys":["a"]}}`))
	if err != nil || len(events) != 1 || verifiedCalls != 1 {
		t.Fatalf("expected verified human-origin input, got err=%v events=%d verifiedCalls=%d", err, len(events), verifiedCalls)
	}
	if len(r.calls) != 1 || r.calls[0][1] != "input" {
		t.Fatalf("human-origin input must not call observe, calls=%v", r.calls)
	}
	if evidence.GroundTruth != nil {
		t.Fatalf("human-origin input attached GroundTruth: %+v", evidence.GroundTruth)
	}
}

func TestHoldingsWitnessOmittedOnFailedOrMalformedObserve(t *testing.T) {
	validDigest := strings.Repeat("1a", 32)
	upperDigest := strings.Repeat("1A", 32)
	shortDigest := strings.Repeat("1a", 31) + "1"
	longDigest := validDigest + "0"
	nonHexDigest := strings.Repeat("1a", 31) + "1g"

	cases := []struct {
		name       string
		observeOut []byte
		observeErr error
	}{
		{
			name:       "observe_refused_exit5",
			observeErr: cli.ExitFault("srf-holdings-capsule", 5, ""),
		},
		{
			name:       "tick_window_exhausted_exit6",
			observeErr: cli.ExitFault("srf-holdings-capsule", 6, ""),
		},
		{
			name:       "observe_timeout",
			observeErr: fault("uncertain", "native command deadline or cancellation"),
		},
		{
			name:       "empty_output",
			observeOut: []byte(``),
		},
		{
			name:       "oversize_output",
			observeOut: []byte(`{"state_sha256":"` + validDigest + `","tick":1,"elements":["` + strings.Repeat("x", 9000) + `"]}`),
		},
		{
			name:       "unknown_field",
			observeOut: []byte(`{"state_sha256":"` + validDigest + `","tick":1,"extra":true}`),
		},
		{
			name:       "missing_state_sha256",
			observeOut: []byte(`{"tick":1}`),
		},
		{
			name:       "short_state_sha256",
			observeOut: []byte(`{"state_sha256":"` + shortDigest + `","tick":1}`),
		},
		{
			name:       "long_state_sha256",
			observeOut: []byte(`{"state_sha256":"` + longDigest + `","tick":1}`),
		},
		{
			name:       "uppercase_state_sha256",
			observeOut: []byte(`{"state_sha256":"` + upperDigest + `","tick":1}`),
		},
		{
			name:       "non_hex_state_sha256",
			observeOut: []byte(`{"state_sha256":"` + nonHexDigest + `","tick":1}`),
		},
		{
			name:       "missing_tick",
			observeOut: []byte(`{"state_sha256":"` + validDigest + `"}`),
		},
		{
			name:       "negative_tick",
			observeOut: []byte(`{"state_sha256":"` + validDigest + `","tick":-1}`),
		},
		{
			name:       "overflow_tick_uint53_plus_one",
			observeOut: []byte(`{"state_sha256":"` + validDigest + `","tick":9007199254740992}`),
		},
		{
			name:       "overflow_tick_uint64_plus_one",
			observeOut: []byte(`{"state_sha256":"` + validDigest + `","tick":18446744073709551616}`),
		},
		{
			name:       "float_tick",
			observeOut: []byte(`{"state_sha256":"` + validDigest + `","tick":1.5}`),
		},
		{
			name:       "string_tick",
			observeOut: []byte(`{"state_sha256":"` + validDigest + `","tick":"1"}`),
		},
		{
			name:       "negative_revision",
			observeOut: []byte(`{"state_sha256":"` + validDigest + `","tick":1,"revision":-1}`),
		},
		{
			name:       "overflow_revision",
			observeOut: []byte(`{"state_sha256":"` + validDigest + `","tick":1,"revision":9007199254740992}`),
		},
		{
			name:       "invalid_frame_state_sha256",
			observeOut: []byte(`{"state_sha256":"` + validDigest + `","tick":1,"frame_state_sha256":"bad"}`),
		},
		{
			name:       "non_array_elements",
			observeOut: []byte(`{"state_sha256":"` + validDigest + `","tick":1,"elements":{"bad":1}}`),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := &witnessRunner{
				inputOut:   []byte(`{"input_mono_ns":200}`),
				observeOut: tc.observeOut,
				observeErr: tc.observeErr,
			}
			m := testManager(t, &scriptRunner{})
			m.runner = r
			id := holdingsBinding(m)
			m.cfg.VerifyHoldingsInput = func(context.Context, Binding, string, json.RawMessage, uint64) error {
				return nil
			}

			events, evidence, err := m.HandleInputWithEvidence(
				context.Background(),
				req("input", `{"surface_id":"`+id+`","proposal_id":"neg-`+tc.name+`","origin":"agent","action":{"type":"click","x":1,"y":0,"button":"left"}}`),
			)
			if err != nil || len(events) != 1 {
				t.Fatalf("input failed on observe negative control %s: err=%v events=%d", tc.name, err, len(events))
			}
			if len(r.calls) != 2 || r.calls[1][1] != "observe" {
				t.Fatalf("expected input + observe call on %s, got %v", tc.name, r.calls)
			}
			if evidence.GroundTruth != nil {
				t.Fatalf("negative control %s attached GroundTruth: %+v", tc.name, evidence.GroundTruth)
			}
		})
	}
}

func TestHoldingsWitnessProcessRunnerScript(t *testing.T) {
	binDir, stateDir := t.TempDir(), t.TempDir()
	if err := os.Chmod(stateDir, 0700); err != nil {
		t.Fatal(err)
	}
	stateDigest := strings.Repeat("b4", 32)
	script := "#!/bin/sh\n" +
		"case \"$1\" in\n" +
		"  input) echo '{\"input_mono_ns\":200}' ;;\n" +
		"  observe) echo '{\"state_sha256\":\"" + stateDigest + "\",\"tick\":15,\"revision\":2,\"elements\":[]}' ;;\n" +
		"  *) exit 2 ;;\n" +
		"esac\n"
	binPath := filepath.Join(binDir, "srf-holdings-capsule")
	if err := os.WriteFile(binPath, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	pr, err := NewProcessRunner(binDir, []string{"PATH=/usr/bin:/bin", "MV_SRF_STATE_DIR=" + stateDir}, 8192, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	m := testManager(t, &scriptRunner{})
	m.runner = pr
	m.cfg.BinDir = binDir
	id := holdingsBinding(m)
	m.cfg.VerifyHoldingsInput = func(context.Context, Binding, string, json.RawMessage, uint64) error {
		return nil
	}

	events, evidence, err := m.HandleInputWithEvidence(
		context.Background(),
		req("input", `{"surface_id":"`+id+`","proposal_id":"proc-ok","origin":"agent","action":{"type":"key","keys":["space"]}}`),
	)
	if err != nil || len(events) != 1 {
		t.Fatalf("ProcessRunner holdings input failed: err=%v events=%d", err, len(events))
	}
	if evidence.GroundTruth == nil || evidence.GroundTruth.Source != "holdings_lane" || evidence.GroundTruth.StateSHA256 != stateDigest || evidence.GroundTruth.Tick != 15 {
		t.Fatalf("unexpected GroundTruth from ProcessRunner: %+v", evidence.GroundTruth)
	}
}

type blockingObserveRunner struct {
	calls     [][]string
	cancelCtx context.CancelFunc
}

func (r *blockingObserveRunner) Run(ctx context.Context, args []string, _ []byte) ([]byte, error) {
	cp := append([]string(nil), args...)
	r.calls = append(r.calls, cp)
	if len(args) >= 2 && filepath.Base(args[0]) == "srf-holdings-capsule" && args[1] == "input" {
		return []byte(`{"input_mono_ns":200}`), nil
	}
	if len(args) >= 2 && filepath.Base(args[0]) == "srf-holdings-capsule" && args[1] == "observe" {
		if r.cancelCtx != nil {
			r.cancelCtx()
		}
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return nil, fault("unexpected", "unexpected command")
}

func TestHoldingsObserveParentContextCancellationPropagates(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := &blockingObserveRunner{cancelCtx: cancel}
	m := testManager(t, &scriptRunner{})
	m.runner = r
	id := holdingsBinding(m)
	m.cfg.VerifyHoldingsInput = func(context.Context, Binding, string, json.RawMessage, uint64) error {
		return nil
	}

	events, evidence, err := m.HandleInputWithEvidence(
		ctx,
		req("input", `{"surface_id":"`+id+`","proposal_id":"prop-ctx-cancel","origin":"agent","action":{"type":"key","keys":["space"]}}`),
	)
	if err == nil || !strings.Contains(err.Error(), context.Canceled.Error()) {
		t.Fatalf("expected context.Canceled from cancelled observe, got err=%v events=%v", err, events)
	}
	if len(events) != 0 {
		t.Fatalf("expected no events on cancelled observe, got %v", events)
	}
	if evidence.GroundTruth != nil {
		t.Fatalf("expected nil GroundTruth on cancelled observe, got %+v", evidence.GroundTruth)
	}
}

func TestHoldingsDirectHandleSkipsObserve(t *testing.T) {
	stateDigest := strings.Repeat("ab", 32)
	r := &witnessRunner{
		inputOut:   []byte(`{"input_mono_ns":200}`),
		observeOut: []byte(`{"state_sha256":"` + stateDigest + `","tick":7}`),
	}
	m := testManager(t, &scriptRunner{})
	m.runner = r
	id := holdingsBinding(m)
	m.cfg.VerifyHoldingsInput = func(context.Context, Binding, string, json.RawMessage, uint64) error {
		return nil
	}

	events, err := m.Handle(
		context.Background(),
		req("input", `{"surface_id":"`+id+`","proposal_id":"prop-direct-handle","origin":"agent","action":{"type":"key","keys":["Return"]}}`),
	)
	if err != nil || len(events) != 1 {
		t.Fatalf("Handle failed: err=%v events=%d", err, len(events))
	}
	if len(r.calls) != 1 || r.calls[0][1] != "input" {
		t.Fatalf("direct Handle must not invoke observe; calls=%v", r.calls)
	}
}

func TestHoldingsObserveNullOptionalFieldsConsistentRejection(t *testing.T) {
	validDigest := strings.Repeat("1a", 32)
	for _, tc := range []struct {
		name string
		raw  string
	}{
		{
			name: "revision_null",
			raw:  `{"state_sha256":"` + validDigest + `","tick":1,"revision":null}`,
		},
		{
			name: "frame_state_sha256_null",
			raw:  `{"state_sha256":"` + validDigest + `","tick":1,"frame_state_sha256":null}`,
		},
		{
			name: "frame_state_sha256_empty",
			raw:  `{"state_sha256":"` + validDigest + `","tick":1,"frame_state_sha256":""}`,
		},
		{
			name: "elements_null",
			raw:  `{"state_sha256":"` + validDigest + `","tick":1,"elements":null}`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gt, err := ParseHoldingsObserve([]byte(tc.raw), 8192)
			if err == nil || gt != nil {
				t.Fatalf("expected %s to be rejected as malformed, got gt=%+v err=%v", tc.name, gt, err)
			}
		})
	}
}
