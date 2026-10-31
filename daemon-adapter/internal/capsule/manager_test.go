package capsule

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// [TARGET, unit decision] Input-control U1: human text routing (paste only for
// non-ASCII batches) and human wheel lowering. Mutants these tests kill:
// MU1-always-paste, MU2-never-paste, MU3-agent-scroll-admitted, MU7-ascii-bound,
// MU4-wheel-step-or-min-or-cap, MU5-direction-swap, MU8-centre-default.

func humanManager(t *testing.T, textInput string) (*Manager, *textInputRunner, string) {
	t.Helper()
	r := &textInputRunner{scriptRunner: scriptRunner{output: []byte(startOK)}}
	m := testManager(t, &r.scriptRunner)
	m.runner = r
	p := m.cfg.Profiles["demo"]
	p.TextInput = textInput
	m.cfg.Profiles["demo"] = p
	id := createID(t, m)
	b := m.bindings[id]
	b.Surface.Control = "human"
	m.bindings[id] = b
	return m, r, id
}

func TestHumanTextPasteOnlyForNonASCII(t *testing.T) {
	cases := []struct {
		name, text string
		paste      bool
	}{
		{"ascii", "abc", false},
		{"ascii-space-tilde", "a ~z", false},
		{"accents", "ñé漢", true},
		{"mixed", "a ñ", true},
		{"emoji", "ok 😀", true},
		{"sharp-s", "straße", true},
	}
	for _, mode := range []string{"", "type", "paste"} {
		for _, c := range cases {
			t.Run(mode+"/"+c.name, func(t *testing.T) {
				m, r, id := humanManager(t, mode)
				r.output = []byte(`{"surface_id":"w1","kind":"text","input_mono_ns":200,"focus_verified":true,"result":"ok"}`)
				params, _ := jsonParams(id, "h1", "human", map[string]any{"type": "type", "text": c.text})
				if _, err := m.Handle(context.Background(), req("input", params)); err != nil {
					t.Fatal(err)
				}
				got := r.calls[len(r.calls)-1][1:]
				want := []string{"input", "--container", "srf-id-demo", "--window", "w1", "--type-stdin"}
				if c.paste {
					want = append(want, "--paste")
				}
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("argv=%q want=%q", got, want)
				}
				if string(r.stdin) != c.text {
					t.Fatalf("stdin=%q want %q", r.stdin, c.text)
				}
				for _, a := range got {
					if strings.Contains(a, c.text) {
						t.Fatalf("text leaked into argv: %q", got)
					}
				}
			})
		}
	}
}

// A long mixed batch pastes every chunk; the decision is per batch, not per chunk.
func TestHumanLongMixedBatchPastesEveryChunk(t *testing.T) {
	m, r, id := humanManager(t, "")
	r.output = []byte(`{"surface_id":"w1","kind":"text","input_mono_ns":200,"focus_verified":true,"result":"ok"}`)
	text := strings.Repeat("a", NativeTextMaxRunes+10) + "ñ"
	params, _ := jsonParams(id, "h1", "human", map[string]any{"type": "type", "text": text})
	if _, err := m.Handle(context.Background(), req("input", params)); err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, c := range r.calls {
		if len(c) > 0 && c[0] == "input" || (len(c) > 1 && c[1] == "input") {
			n++
			if !contains(c, "--paste") {
				t.Fatalf("chunk without --paste: %q", c)
			}
		}
	}
	if n != 2 {
		t.Fatalf("input calls=%d want 2", n)
	}
}

func TestAgentTextRuleUnchangedByHumanPaste(t *testing.T) {
	for _, mode := range []string{"", "type", "paste"} {
		for _, text := range []string{"abc", "ñé"} {
			r := &textInputRunner{scriptRunner: scriptRunner{output: []byte(startOK)}}
			m := testManager(t, &r.scriptRunner)
			m.runner = r
			p := m.cfg.Profiles["demo"]
			p.TextInput = mode
			m.cfg.Profiles["demo"] = p
			id := createID(t, m)
			r.output = []byte(`{"surface_id":"w1","kind":"text","input_mono_ns":200,"focus_verified":true,"result":"ok"}`)
			params, _ := jsonParams(id, "a1", "agent", map[string]any{"type": "type", "text": text})
			if _, err := m.Handle(context.Background(), req("input", params)); err != nil {
				t.Fatal(err)
			}
			if got, want := contains(r.calls[len(r.calls)-1], "--paste"), mode == "paste"; got != want {
				t.Fatalf("agent mode=%q text=%q paste=%v want %v", mode, text, got, want)
			}
		}
	}
}

func TestNeedsPasteBoundaries(t *testing.T) {
	for _, c := range []struct {
		text string
		want bool
	}{{"", false}, {" ", false}, {"~", false}, {"\x1f", true}, {"\x7f", true}, {"\u0080", true}, {"é", true}, {"abc", false}} {
		if got := needsPaste(c.text); got != c.want {
			t.Fatalf("needsPaste(%q)=%v want %v", c.text, got, c.want)
		}
	}
}

func TestHumanScrollArgv(t *testing.T) {
	cases := []struct {
		name   string
		action map[string]any
		want   []string
	}{
		{"up-120", map[string]any{"type": "scroll", "dx": 0, "dy": -120}, []string{"--scroll", "1,0", "--dir", "up", "--count", "2"}},
		{"down-50", map[string]any{"type": "scroll", "dx": 0, "dy": 50}, []string{"--scroll", "1,0", "--dir", "down", "--count", "1"}},
		{"down-small-still-one-step", map[string]any{"type": "scroll", "dx": 0, "dy": 3}, []string{"--scroll", "1,0", "--dir", "down", "--count", "1"}},
		{"left", map[string]any{"type": "scroll", "dx": -100, "dy": 0}, []string{"--scroll", "1,0", "--dir", "left", "--count", "2"}},
		{"right", map[string]any{"type": "scroll", "dx": 250, "dy": 0}, []string{"--scroll", "1,0", "--dir", "right", "--count", "5"}},
		{"dominant-x", map[string]any{"type": "scroll", "dx": 200, "dy": -50}, []string{"--scroll", "1,0", "--dir", "right", "--count", "4"}},
		{"dominant-y", map[string]any{"type": "scroll", "dx": 50, "dy": 200}, []string{"--scroll", "1,0", "--dir", "down", "--count", "4"}},
		{"tie-is-vertical", map[string]any{"type": "scroll", "dx": 100, "dy": 100}, []string{"--scroll", "1,0", "--dir", "down", "--count", "2"}},
		{"clamped-to-20", map[string]any{"type": "scroll", "dx": 0, "dy": 100000}, []string{"--scroll", "1,0", "--dir", "down", "--count", "20"}},
		{"explicit-point", map[string]any{"type": "scroll", "dx": 0, "dy": -60, "x": 0, "y": 0}, []string{"--scroll", "0,0", "--dir", "up", "--count", "1"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, r, id := humanManager(t, "")
			r.output = []byte(`{"surface_id":"w1","kind":"scroll","input_mono_ns":200,"focus_verified":true,"result":"ok"}`)
			params, _ := jsonParams(id, "s1", "human", c.action)
			if _, err := m.Handle(context.Background(), req("input", params)); err != nil {
				t.Fatal(err)
			}
			want := append([]string{"input", "--container", "srf-id-demo", "--window", "w1"}, c.want...)
			if got := r.calls[len(r.calls)-1][1:]; !reflect.DeepEqual(got, want) {
				t.Fatalf("argv=%q want=%q", got, want)
			}
			if len(r.stdin) != 0 {
				t.Fatalf("scroll sent stdin %q", r.stdin)
			}
		})
	}
}

func TestScrollRefusals(t *testing.T) {
	bad := map[string]map[string]any{
		"zero":         {"type": "scroll", "dx": 0, "dy": 0},
		"missing-dy":   {"type": "scroll", "dx": 5},
		"x-only":       {"type": "scroll", "dx": 0, "dy": 10, "x": 0},
		"out-of-frame": {"type": "scroll", "dx": 0, "dy": 10, "x": 2, "y": 0},
		"negative-pt":  {"type": "scroll", "dx": 0, "dy": 10, "x": -1, "y": 0},
		"over-i32":     {"type": "scroll", "dx": 0, "dy": 2147483648},
		"with-text":    {"type": "scroll", "dx": 0, "dy": 10, "text": "a"},
		"with-button":  {"type": "scroll", "dx": 0, "dy": 10, "button": "left"},
		"with-keys":    {"type": "scroll", "dx": 0, "dy": 10, "keys": []string{"a"}},
	}
	for name, action := range bad {
		t.Run(name, func(t *testing.T) {
			m, r, id := humanManager(t, "")
			before := len(r.calls)
			params, _ := jsonParams(id, "s1", "human", action)
			_, err := m.Handle(context.Background(), req("input", params))
			requireFault(t, err, "input")
			if len(r.calls) != before {
				t.Fatalf("dispatched %q", r.calls[before:])
			}
		})
	}
}

func TestAgentAndHoldingsScrollStayUnsupported(t *testing.T) {
	r := &textInputRunner{scriptRunner: scriptRunner{output: []byte(startOK)}}
	m := testManager(t, &r.scriptRunner)
	m.runner = r
	id := createID(t, m) // agent-controlled
	before := len(r.calls)
	params, _ := jsonParams(id, "a1", "agent", map[string]any{"type": "scroll", "dx": 0, "dy": 100})
	_, e := m.Handle(context.Background(), req("input", params))
	requireFault(t, e, "unsupported")
	if len(r.calls) != before {
		t.Fatalf("agent scroll dispatched %q", r.calls[before:])
	}

	hm := testManager(t, &scriptRunner{})
	hid := holdingsBinding(hm)
	b := hm.bindings[hid]
	b.Surface.Control = "human"
	hm.bindings[hid] = b
	hparams, _ := jsonParams(hid, "h1", "human", map[string]any{"type": "scroll", "dx": 0, "dy": 100})
	_, e = hm.Handle(context.Background(), req("input", hparams))
	requireFault(t, e, "unsupported")
}

func TestHumanScrollWithoutHumanControlRefused(t *testing.T) {
	m, r, id := humanManager(t, "")
	b := m.bindings[id]
	b.Surface.Control = "agent"
	m.bindings[id] = b
	before := len(r.calls)
	params, _ := jsonParams(id, "s1", "human", map[string]any{"type": "scroll", "dx": 0, "dy": 100})
	_, e := m.Handle(context.Background(), req("input", params))
	requireFault(t, e, "SURFACE_NOT_HUMAN_CONTROLLED")
	if len(r.calls) != before {
		t.Fatal("dispatched without human control")
	}
}

func TestScrollStepsBoundaries(t *testing.T) {
	for _, c := range []struct {
		delta int64
		want  int
	}{{1, 1}, {49, 1}, {50, 1}, {99, 1}, {100, 2}, {-100, 2}, {1000, 20}, {1001, 20}, {-2147483648, 20}} {
		if got := scrollSteps(c.delta); got != c.want {
			t.Fatalf("scrollSteps(%d)=%d want %d", c.delta, got, c.want)
		}
	}
}

func contains(a []string, s string) bool {
	for _, v := range a {
		if v == s {
			return true
		}
	}
	return false
}

func jsonParams(surface, proposal, origin string, action map[string]any) (string, error) {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf(`{"surface_id":%q,"proposal_id":%q,"origin":%q,"action":`, surface, proposal, origin))
	b, err := json.Marshal(action)
	sb.Write(b)
	sb.WriteString("}")
	return sb.String(), err
}

// Kills MU9: scroll evidence kind forwarded (the frozen receipt contract admits click|key|text only).
func TestHumanScrollEvidenceOmitsKindOthersKeepIt(t *testing.T) {
	for _, c := range []struct {
		name     string
		action   map[string]any
		receipt  string
		wantKind string
	}{
		{"scroll", map[string]any{"type": "scroll", "dx": 0, "dy": 60}, "scroll", ""},
		{"text", map[string]any{"type": "type", "text": "ñ"}, "text", "text"},
		{"key", map[string]any{"type": "key", "keys": []string{"Return"}}, "key", "key"},
	} {
		t.Run(c.name, func(t *testing.T) {
			m, r, id := humanManager(t, "")
			r.output = []byte(`{"surface_id":"w1","kind":"` + c.receipt + `","input_mono_ns":200,"focus_verified":true,"result":"ok"}`)
			params, _ := jsonParams(id, "e1", "human", c.action)
			_, ev, err := m.HandleInputWithEvidence(context.Background(), req("input", params))
			if err != nil {
				t.Fatal(err)
			}
			if ev.Kind != c.wantKind || ev.NativeSurfaceID != "w1" || ev.Result != "ok" {
				t.Fatalf("evidence=%+v", ev)
			}
		})
	}
}
