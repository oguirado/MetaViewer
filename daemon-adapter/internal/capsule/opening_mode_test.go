package capsule

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type openingRunner struct {
	scriptRunner
	mode string
}

func (r *openingRunner) ConsumeOpeningMode(_ string, fallback string) (string, error) {
	if r.mode == "" {
		return fallback, nil
	}
	return r.mode, nil
}

func TestOpeningModeOverridesLegacyAndBindsPerCapsule(t *testing.T) {
	r := &openingRunner{mode: "agent", scriptRunner: scriptRunner{output: []byte(`{"container":"srf-id-demo","run_id":"run-one","windows":[{"id":"w1","x":0,"y":0,"w":1280,"h":900,"title":"","url":""}]}`)}}
	base := testManager(t, &r.scriptRunner)
	cfg := base.cfg
	p := cfg.Profiles["demo"]
	p.Role = "human"
	p.Width = 1280
	p.Height = 900
	cfg.Profiles["demo"] = p
	m, err := NewManager(cfg, r, base.clock)
	if err != nil {
		t.Fatal(err)
	}
	create := req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":1280,"h":900}}`)
	events, err := m.Handle(context.Background(), create)
	if err != nil {
		t.Fatal(err)
	}
	var ev struct {
		Data struct {
			Surface Surface `json:"surface"`
		} `json:"data"`
	}
	if err = json.Unmarshal(events[0], &ev); err != nil {
		t.Fatal(err)
	}
	first := ev.Data.Surface.SurfaceID
	if m.bindings[first].Role != "agent" || ev.Data.Surface.Control != "agent" {
		t.Fatal("opening mode did not override legacy default")
	}
	if _, err = m.Handle(context.Background(), create); err == nil {
		t.Fatal("same identity opened twice")
	}
	r.output = []byte(`{"stopped":"srf-id-demo","removed_verified":true}`)
	if _, err = m.Handle(context.Background(), req("destroy", `{"surface_id":"`+first+`"}`)); err != nil {
		t.Fatal(err)
	}
	r.mode = "human"
	r.output = []byte(`{"container":"srf-id-demo","run_id":"run-two","windows":[{"id":"w1","x":0,"y":0,"w":1280,"h":900,"title":"","url":""}]}`)
	events, err = m.Handle(context.Background(), create)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(events[0], &ev); err != nil {
		t.Fatal(err)
	}
	second := ev.Data.Surface.SurfaceID
	if first == second || m.bindings[second].Role != "human" || ev.Data.Surface.Control != "human" {
		t.Fatal("replacement lifetime or mode reused")
	}
	// Default remains unchanged; native admission follows the binding.
	params, _ := jsonParams(second, "proposal", "agent", map[string]any{"type": "key", "keys": []string{"Tab"}})
	before := len(r.calls)
	if _, err = m.Handle(context.Background(), req("input", params)); err == nil {
		t.Fatal("human opening accepted native input")
	}
	if len(r.calls) != before {
		t.Fatal("human opening invoked input runner")
	}
}

func TestPrivateOpeningModeConsumedOnceAndMalformedNeverDefaults(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	r := &ProcessRunner{stateDir: root, stat: stateDirInfo}
	if got, err := r.ConsumeOpeningMode("demo", "human"); err != nil || got != "human" {
		t.Fatalf("legacy default: %q %v", got, err)
	}
	dir := filepath.Join(root, "opening-modes")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "demo.json")
	if err := os.WriteFile(file, []byte(`{"schema":"metaviewer.opening_mode/v0.3","profile_id":"demo","mode":"agent"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if got, err := r.ConsumeOpeningMode("demo", "human"); err != nil || got != "agent" {
		t.Fatalf("explicit mode: %q %v", got, err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("opening request not consumed")
	}
	for _, raw := range []string{`{}`, `{"schema":"metaviewer.opening_mode/v0.3","profile_id":"other","mode":"human"}`, `{"schema":"metaviewer.opening_mode/v0.3","profile_id":"demo","mode":"shared"}`} {
		if err := os.WriteFile(file, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := r.ConsumeOpeningMode("demo", "agent"); err == nil {
			t.Fatal("malformed request defaulted")
		}
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "absent"), file); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ConsumeOpeningMode("demo", "agent"); err == nil {
		t.Fatal("symlink defaulted")
	}
}
