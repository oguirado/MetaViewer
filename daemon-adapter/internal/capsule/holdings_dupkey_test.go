package capsule

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// MUT-DUP-LASTWINS removes the pre-decode ValidateJSON pass in
// ParseHoldingsObserve, allowing encoding/json to overwrite repeated keys.
func TestHoldingsObserveRejectsDuplicateKeys(t *testing.T) {
	digest := strings.Repeat("ab", 32)
	prefix := `{"state_sha256":"` + digest + `","tick":1`
	cases := map[string]string{
		"tick":                 prefix + `,"tick":2}`,
		"same_value":           prefix + `,"tick":1}`,
		"digest":               prefix + `,"state_sha256":"` + digest + `"}`,
		"escaped_key":          prefix + `,"ti\u0063k":2}`,
		"outer_state":          prefix + `,"state":{"a":1},"state":{"b":2}}`,
		"wrapper_state":        prefix + `,"observation":{"state":{"a":1},"state":{"b":2}}}`,
		"nested_state":         prefix + `,"state":{"items":[{"a":1,"a":2}]}}`,
		"nested_wrapper_state": prefix + `,"observation":{"state":{"a":{"b":1,"b":2}}}}`,
		"elements":             prefix + `,"elements":[{"a":{"b":1,"b":2}}]}`,
		"escaped_nested_key":   prefix + `,"elements":[{"a":1,"\u0061":2}]}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			gt, err := ParseHoldingsObserve([]byte(raw), 0)
			if gt != nil || err == nil {
				t.Fatalf("duplicate key accepted: gt=%+v err=%v", gt, err)
			}
			requireFault(t, err, "malformed_cli")
		})
	}
}

// MUT-DEPTH-UNBOUNDED sets the pre-decode MaxDepth back to len(trimmedLine).
// The complete, otherwise valid elements values then pass instead of refusing.
func TestHoldingsObserveDepthBound(t *testing.T) {
	// Keep the oracle independent of the production limit. Core's Holdings
	// canonical verifier allows depth 64; the CLI pass allows two envelope
	// levels plus one for ValidateJSON's exclusive container bound.
	const cap = 64 + 2 + 1
	prefix := `{"state_sha256":"` + strings.Repeat("ab", 32) + `","tick":1,"elements":`
	for name, value := range map[string]string{
		"arrays":      strings.Repeat("[", cap) + `0` + strings.Repeat("]", cap),
		"objects":     `[` + strings.Repeat(`{"a":`, cap-1) + `0` + strings.Repeat("}", cap-1) + `]`,
		"native_line": strings.Repeat("[", MaxHoldingsStateBytes),
	} {
		t.Run(name, func(t *testing.T) {
			started := time.Now()
			gt, err := ParseHoldingsObserve([]byte(prefix+value+`}`), 0)
			if elapsed := time.Since(started); elapsed > 2*time.Second {
				t.Fatalf("depth refusal took %s (limit 2s)", elapsed)
			}
			if gt != nil || err == nil {
				t.Fatalf("MUT-DEPTH-UNBOUNDED: excessive nesting accepted: gt=%+v err=%v", gt, err)
			}
			requireFault(t, err, "malformed_cli")
		})
	}
	// The observation object counts as one container; allow exactly cap total.
	value := strings.Repeat("[", cap-1) + `0` + strings.Repeat("]", cap-1)
	if gt, err := ParseHoldingsObserve([]byte(prefix+value+`}`), 0); err != nil || gt == nil {
		t.Fatalf("at-cap nesting refused: gt=%+v err=%v", gt, err)
	}
}

// MUT-DEPTH-WRAPPER restores MaxDepth to 64 and rejects valid core states.
func TestHoldingsObserveStateDepthBoundary(t *testing.T) {
	prefix := `{"state_sha256":"` + strings.Repeat("ab", 32) + `","tick":1,`
	for _, depth := range []int{64, 65} {
		// Match core's ok_64 / too_deep_65 chains, including their scalar leaf.
		// Also exercise an empty container at the maximum allowed depth.
		for _, leaf := range []string{"1", "{}", "[]"} {
			if depth == 65 && leaf != "1" {
				continue
			}
			state := `{"a":` + strings.Repeat("[", depth-1) + leaf + strings.Repeat("]", depth-1) + `}`
			for envelope, suffix := range map[string]string{
				"direct":  `"state":` + state + `}`,
				"wrapper": `"observation":{"state":` + state + `}}`,
			} {
				t.Run(fmt.Sprintf("%s/depth_%d/leaf_%s", envelope, depth, leaf), func(t *testing.T) {
					gt, err := ParseHoldingsObserve([]byte(prefix+suffix), 0)
					if depth == 64 {
						if err != nil || gt == nil || gt.State != state {
							t.Fatalf("core-valid state refused or changed: gt=%+v err=%v", gt, err)
						}
						return
					}
					if gt != nil || err == nil {
						t.Fatalf("over-depth state accepted: gt=%+v err=%v", gt, err)
					}
					requireFault(t, err, "malformed_cli")
					if !strings.Contains(err.Error(), "holdings state exceeds max depth") {
						t.Fatalf("expected state validator depth refusal, got %v", err)
					}
				})
			}
		}
	}
}

func TestHoldingsObserveWideState(t *testing.T) {
	var state strings.Builder
	state.WriteString(`{"items":[`)
	state.WriteString(strings.Repeat("0,", 4096))
	state.WriteString("0]")
	for i := 0; i < 257; i++ {
		fmt.Fprintf(&state, `,"key%d":0`, i)
	}
	state.WriteByte('}')
	prefix := `{"state_sha256":"` + strings.Repeat("ab", 32) + `","tick":1,`
	for envelope, suffix := range map[string]string{
		"direct":  `"state":` + state.String() + `}`,
		"wrapper": `"observation":{"state":` + state.String() + `}}`,
	} {
		t.Run(envelope, func(t *testing.T) {
			gt, err := ParseHoldingsObserve([]byte(prefix+suffix), 0)
			if err != nil || gt == nil || gt.State != state.String() {
				t.Fatalf("wide valid state refused or changed: gt=%+v err=%v", gt, err)
			}
		})
	}
}

func TestHoldingsObserveNestedFixtureState(t *testing.T) {
	// The Wender vector in core/src/serve/canonical.rs nests state -> nodes ->
	// node -> states (and box); exercise that shape through both CLI envelopes.
	state := `{"schema":"wender.state/v1","nodes":[{"id":"0123456789abcdef","box":[10,20,100,40],"states":{"pressed":"false"}}]}`
	prefix := `{"state_sha256":"` + strings.Repeat("ab", 32) + `","tick":1,`
	for name, suffix := range map[string]string{
		"direct":  `"state":` + state + `}`,
		"wrapper": `"observation":{"state":` + state + `}}`,
	} {
		t.Run(name, func(t *testing.T) {
			gt, err := ParseHoldingsObserve([]byte(prefix+suffix), 0)
			if err != nil || gt == nil || gt.State != state {
				t.Fatalf("nested fixture state refused or changed: gt=%+v err=%v", gt, err)
			}
		})
	}
}

func TestHoldingsObserveDuplicateKeyValidControls(t *testing.T) {
	digest := strings.Repeat("ab", 32)
	prefix := `{"state_sha256":"` + digest + `","tick":1`
	// Reach the existing state cap with one string, exceeding IPC defaults.
	state := `{"payload":"` + strings.Repeat("x", MaxHoldingsStateBytes-len(`{"payload":""}`)) + `"}`
	for name, suffix := range map[string]string{
		"minimal":          `}`,
		"separate_objects": `,"elements":[{"a":1.5},{"a":2e1}]}`,
		"large_direct":     `,"state":` + state + `}`,
		"large_wrapper":    `,"observation":{"state":` + state + `}}`,
	} {
		t.Run(name, func(t *testing.T) {
			gt, err := ParseHoldingsObserve([]byte(prefix+suffix), 0)
			if err != nil || gt == nil || gt.Tick != 1 || gt.StateSHA256 != digest {
				t.Fatalf("valid observation refused: gt=%+v err=%v", gt, err)
			}
			if strings.HasPrefix(name, "large_") && gt.State != state {
				t.Fatal("large state changed")
			}
		})
	}
}
