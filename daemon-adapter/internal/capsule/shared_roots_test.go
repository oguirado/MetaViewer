package capsule

import (
	"context"
	"encoding/json"
	"errors"
	"metaviewer/daemon-adapter/internal/cli"
	"strings"
	"testing"
)

func TestSharedRootDistinctDisplays(t *testing.T) {
	m := testManager(t, &scriptRunner{})
	cfg := m.cfg
	cfg.Profiles["other"] = cfg.Profiles["demo"]
	if _, err := NewManager(cfg, &scriptRunner{}, m.clock); err == nil {
		t.Fatal("duplicate display admitted")
	}
	p := cfg.Profiles["other"]
	p.Display = ":101"
	cfg.Profiles["other"] = p
	if _, err := NewManager(cfg, &scriptRunner{}, m.clock); err != nil {
		t.Fatal(err)
	}
}
func TestSharedRootRunIsolation(t *testing.T) {
	for _, reused := range []bool{false, true} {
		t.Run(map[bool]string{false: "distinct", true: "reused"}[reused], func(t *testing.T) {
			r := &scriptRunner{output: []byte(startOK)}
			m := testManager(t, r)
			p := m.cfg.Profiles["demo"]
			p.Display = ":101"
			m.cfg.Profiles["other"] = p
			create := func(id string) error {
				_, err := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"`+id+`","geometry":{"w":2,"h":1}}`))
				return err
			}
			if err := create("demo"); err != nil {
				t.Fatal(err)
			}
			run := "other-run"
			if reused {
				run = "demo-run"
			}
			r.output = []byte(strings.ReplaceAll(strings.ReplaceAll(startOK, "srf-id-demo", "srf-id-other"), "demo-run", run))
			err := create("other")
			if reused {
				var f *cli.Fault
				if !errors.As(err, &f) || f.Code != "binding" {
					t.Fatalf("reused run not refused with binding: %v", err)
				}
				if len(m.bindings) != 1 || len(r.calls) != 2 {
					t.Fatal("collision retained binding or stopped incumbent")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var a, b Binding
			for _, v := range m.bindings {
				if v.Surface.ProfileID == "demo" {
					a = v
				} else {
					b = v
				}
			}
			for _, pair := range [][2]Binding{{a, b}, {b, a}} {
				own, foreign := pair[0], pair[1]
				f := NativeFrame{Path: own.FramesRoot + "/f.png", Seq: 1, Generation: own.Container, Width: 2, Height: 1, SHA256RGB24: strings.Repeat("a", 64), CaptureMonoNS: 200, Window: &Window{ID: "w1", W: 2, H: 1}}
				r.output, _ = json.Marshal(f)
				if _, _, err := m.Capture(context.Background(), own.Surface.SurfaceID); err != nil {
					t.Fatal(err)
				}
				f.Path = foreign.FramesRoot + "/f.png"
				r.output, _ = json.Marshal(f)
				if _, _, err := m.Capture(context.Background(), own.Surface.SurfaceID); err == nil {
					t.Fatal("cross-run frame read admitted")
				}
			}
		})
	}
}
func TestSharedRootForeignFramesDir(t *testing.T) {
	for _, dir := range []string{"/dev/shm/demo-run/frames/w1", "/dev/shm/demo-run/frames/w1/child", "/dev/shm/demo-run/frames"} {
		t.Run(dir, func(t *testing.T) {
			r := &scriptRunner{output: []byte(startOK)}
			m := testManager(t, r)
			if _, err := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`)); err != nil {
				t.Fatal(err)
			}
			p := m.cfg.Profiles["demo"]
			p.Kind = "game_capsule"
			p.NativeKind = "holdings"
			p.AppDir = t.TempDir()
			p.Display = ":101"
			m.cfg.Profiles["game"] = p
			r.output = []byte(`[{"slot":1,"container":"srf-ng-hcap-hc-0123456789ab-1","run_id":"hc-0123456789ab","display":":101","width":2,"height":1,"ready_line":"READY","ready_ms":0,"frames_dir":"` + dir + `"}]`)
			_, err := m.Handle(context.Background(), req("create", `{"kind":"game_capsule","profile_id":"game","geometry":{"w":2,"h":1}}`))
			var f *cli.Fault
			if !errors.As(err, &f) || f.Code != "binding" {
				t.Fatalf("foreign FramesDir admitted: %v", err)
			}
			if len(r.calls) != 2 {
				t.Fatal("colliding allocation authorized native cleanup")
			}
		})
	}
}

// Holdings supplies its allocation independently of run_id. Keep this separate
// from the allocation collision test so the run-id guard has a live mutant.
func TestSharedRootReusedRunDifferentAllocation(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	if _, err := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`)); err != nil {
		t.Fatal(err)
	}
	p := m.cfg.Profiles["demo"]
	p.Kind = "game_capsule"
	p.NativeKind = "holdings"
	p.AppDir = t.TempDir()
	p.Display = ":101"
	m.cfg.Profiles["game"] = p
	r.output = []byte(`[{"slot":1,"container":"srf-ng-hcap-hc-0123456789ab-1","run_id":"demo-run","display":":101","width":2,"height":1,"ready_line":"READY","ready_ms":0,"frames_dir":"/dev/shm/demo-run/game"}]`)
	_, err := m.Handle(context.Background(), req("create", `{"kind":"game_capsule","profile_id":"game","geometry":{"w":2,"h":1}}`))
	var f *cli.Fault
	if !errors.As(err, &f) || f.Code != "binding" {
		t.Fatalf("reused run with distinct allocation admitted: %v", err)
	}
	if len(m.bindings) != 1 || len(r.calls) != 2 {
		t.Fatal("collision retained binding or stopped incumbent")
	}
}
