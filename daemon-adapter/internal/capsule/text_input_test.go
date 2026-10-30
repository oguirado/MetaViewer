package capsule

import (
	"context"
	"reflect"
	"testing"
)

type textInputRunner struct {
	scriptRunner
	stdin []byte
}

func (r *textInputRunner) Run(ctx context.Context, argv []string, stdin []byte) ([]byte, error) {
	r.stdin = append([]byte(nil), stdin...)
	return r.scriptRunner.Run(ctx, argv, stdin)
}
func TestTextInputModes(t *testing.T) {
	for _, mode := range []string{"", "type", "paste"} {
		t.Run(mode, func(t *testing.T) {
			r := &textInputRunner{scriptRunner: scriptRunner{output: []byte(startOK)}}
			m := testManager(t, &r.scriptRunner)
			m.runner = r
			p := m.cfg.Profiles["demo"]
			p.TextInput = mode
			m.cfg.Profiles["demo"] = p
			id := createID(t, m)
			r.output = []byte(`{"surface_id":"w1","kind":"text","input_mono_ns":200,"focus_verified":true,"result":"ok"}`)
			_, err := m.Handle(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"p1","action":{"type":"type","text":"hello Ω"}}`))
			if err != nil {
				t.Fatal(err)
			}
			want := []string{"input", "--container", "srf-id-demo", "--window", "w1", "--type-stdin"}
			if mode == "paste" {
				want = append(want, "--paste")
			}
			got := r.calls[len(r.calls)-1][1:]
			if !reflect.DeepEqual(got, want) || string(r.stdin) != "hello Ω" {
				t.Fatalf("argv=%q stdin=%q want=%q", got, r.stdin, want)
			}
		})
	}
}
func TestInvalidTextInputProfile(t *testing.T) {
	r := &scriptRunner{}
	m := testManager(t, r)
	for _, mode := range []string{"Paste", "invalid", " type"} {
		cfg := m.cfg
		p := cfg.Profiles["demo"]
		p.TextInput = mode
		cfg.Profiles["demo"] = p
		if _, err := NewManager(cfg, r, func() uint64 { return 200 }); err == nil {
			t.Fatalf("accepted %q", mode)
		}
	}
}
func TestHoldingsTextStillRefusedInPasteMode(t *testing.T) {
	r := &scriptRunner{}
	m := testManager(t, r)
	id := holdingsBinding(m)
	p := m.cfg.Profiles["demo"]
	p.TextInput = "paste"
	m.cfg.Profiles["demo"] = p
	if _, err := m.Handle(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"p1","action":{"type":"type","text":"hello"}}`)); err == nil {
		t.Fatal("holdings accepted text")
	}
	if len(r.calls) != 0 {
		t.Fatal("holdings dispatched text")
	}
}

func TestHumanTextRetainsTypeMode(t *testing.T) {
	r := &textInputRunner{scriptRunner: scriptRunner{output: []byte(startOK)}}
	m := testManager(t, &r.scriptRunner)
	m.runner = r
	p := m.cfg.Profiles["demo"]
	p.TextInput = "paste"
	m.cfg.Profiles["demo"] = p
	id := createID(t, m)
	b := m.bindings[id]
	b.Surface.Control = "human"
	m.bindings[id] = b
	r.output = []byte(`{"surface_id":"w1","kind":"text","input_mono_ns":200,"focus_verified":true,"result":"ok"}`)
	_, err := m.Handle(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"human1","origin":"human","action":{"type":"type","text":"hello"}}`))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"input", "--container", "srf-id-demo", "--window", "w1", "--type-stdin"}
	if got := r.calls[len(r.calls)-1][1:]; !reflect.DeepEqual(got, want) {
		t.Fatalf("human argv changed: %q", got)
	}
}
