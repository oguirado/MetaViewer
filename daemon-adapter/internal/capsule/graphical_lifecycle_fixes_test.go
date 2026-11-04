package capsule

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func addGraphicalTestSurface(t *testing.T, m *Manager) string {
	t.Helper()
	profile := m.cfg.Profiles["demo"]
	profile.Display = ":101"
	profile.RAMRoot = "/dev/shm/graphical-test-profile-b"
	m.cfg.Profiles["demo2"] = profile
	if r, ok := m.runner.(*scriptRunner); ok {
		r.output = []byte(`{"container":"srf-id-demo2","run_id":"demo2-run","windows":[{"id":"w1","x":0,"y":0,"w":2,"h":1,"title":"","url":""}]}`)
	} else {
		t.Fatalf("unexpected runner before second surface: %T", m.runner)
	}
	out, err := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo2","geometry":{"w":2,"h":1}}`))
	if err != nil {
		t.Fatal(err)
	}
	var created struct {
		Data struct {
			Surface Surface `json:"surface"`
		} `json:"data"`
	}
	if err = json.Unmarshal(out[0], &created); err != nil {
		t.Fatal(err)
	}
	id := created.Data.Surface.SurfaceID
	b := m.bindings[id]
	b.NativeKind = "vm"
	b.Program = "notepad-rw-vm"
	m.bindings[id] = b
	return id
}

func TestGraphicalAttachProvenRefusalReleasesSingletonButUnknownRetainsIt(t *testing.T) {
	t.Run("proven-refusal-allows-other-surface", func(t *testing.T) {
		m, first := graphicalTestManager(t)
		second := addGraphicalTestSurface(t, m)
		m.runner = graphicalTestRunner(func(context.Context, []string, []byte) ([]byte, error) {
			return graphicalTestNative("attach", "", "refused", 1), nil
		})
		refused := graphicalTestEvent(t, m, graphicalTestRequest(first, "attach", "refused", ""), nil)
		if refused.Event != "refused" || m.graphical != nil {
			t.Fatalf("proven refusal retained singleton: event=%+v state=%+v", refused, m.graphical)
		}
		m.runner = graphicalTestRunner(func(context.Context, []string, []byte) ([]byte, error) {
			return graphicalTestNative("attach", "", "ready", 1), nil
		})
		attached := graphicalTestEvent(t, m, graphicalTestRequest(second, "attach", "second", ""), nil)
		if attached.Event != "completed" || m.graphical == nil || m.graphical.surface != second {
			t.Fatalf("second surface could not attach after proven refusal: %+v", attached)
		}
	})

	t.Run("unknown-retains-singleton", func(t *testing.T) {
		m, first := graphicalTestManager(t)
		second := addGraphicalTestSurface(t, m)
		m.runner = graphicalTestRunner(func(context.Context, []string, []byte) ([]byte, error) {
			return nil, errors.New("unproven transport failure")
		})
		unknown := graphicalTestEvent(t, m, graphicalTestRequest(first, "attach", "unknown", ""), nil)
		if unknown.Event != "outcome_unknown" || m.graphical == nil || !m.graphical.unknown {
			t.Fatalf("unknown attach did not retain custody: %+v state=%+v", unknown, m.graphical)
		}
		calls := 0
		m.runner = graphicalTestRunner(func(context.Context, []string, []byte) ([]byte, error) {
			calls++
			return graphicalTestNative("attach", "", "ready", 1), nil
		})
		blocked := graphicalTestEvent(t, m, graphicalTestRequest(second, "attach", "blocked", ""), nil)
		if blocked.Event != "refused" || blocked.ReasonCode == nil || *blocked.ReasonCode != "BUSY" || calls != 0 {
			t.Fatalf("unknown first attach did not retain singleton: %+v calls=%d", blocked, calls)
		}
	})
}

func TestGraphicalNonLiveExitClearsBusyAndEmitsUnknown(t *testing.T) {
	m, id := graphicalTestManager(t)
	graphicalTestAttach(t, m, id)
	m.runner = graphicalTestRunner(func(context.Context, []string, []byte) ([]byte, error) {
		m.mu.Lock()
		b := m.bindings[id]
		b.Surface.State = "lost"
		m.bindings[id] = b
		m.mu.Unlock()
		return nil, errors.New("transport failed as surface became lost")
	})
	e := graphicalTestEvent(t, m, graphicalTestRequest(id, "mark", "lost", ""), nil)
	if e.Event != "outcome_unknown" || m.graphical == nil || m.graphical.busy || !m.graphical.unknown {
		t.Fatalf("non-live exit did not settle into unknown: event=%+v state=%+v", e, m.graphical)
	}
}

func TestGraphicalMarkWithoutSessionDoesNotClaimSingleton(t *testing.T) {
	m, first := graphicalTestManager(t)
	second := addGraphicalTestSurface(t, m)
	mark := graphicalTestEvent(t, m, graphicalTestRequest(first, "mark", "before-attach", ""), nil)
	if mark.Event != "refused" || m.graphical != nil {
		t.Fatalf("sessionless mark claimed singleton: event=%+v state=%+v", mark, m.graphical)
	}
	m.runner = graphicalTestRunner(func(context.Context, []string, []byte) ([]byte, error) {
		return graphicalTestNative("attach", "", "ready", 1), nil
	})
	attached := graphicalTestEvent(t, m, graphicalTestRequest(second, "attach", "second-after-mark", ""), nil)
	if attached.Event != "completed" || m.graphical == nil || m.graphical.surface != second {
		t.Fatalf("sessionless mark blocked second surface: event=%+v state=%+v", attached, m.graphical)
	}
}

func TestGraphicalAttachDrainTimeoutReleasesSessionlessSingleton(t *testing.T) {
	m, first := graphicalTestManager(t)
	second := addGraphicalTestSurface(t, m)
	m.graphicalCaptures = map[string]int{first: 1}
	m.runner = graphicalTestRunner(func(context.Context, []string, []byte) ([]byte, error) {
		t.Fatal("attach reached native before drain completed")
		return nil, nil
	})
	refused := graphicalTestEvent(t, m, graphicalTestRequest(first, "attach", "drain-timeout", ""), nil)
	if refused.Event != "refused" || refused.ReasonCode == nil || *refused.ReasonCode != "BUSY" || m.graphical != nil {
		t.Fatalf("drain-timeout refusal retained singleton: event=%+v state=%+v", refused, m.graphical)
	}
	m.graphicalCaptures[first] = 0
	m.runner = graphicalTestRunner(func(context.Context, []string, []byte) ([]byte, error) {
		return graphicalTestNative("attach", "", "ready", 1), nil
	})
	attached := graphicalTestEvent(t, m, graphicalTestRequest(second, "attach", "second-after-drain", ""), nil)
	if attached.Event != "completed" || m.graphical == nil || m.graphical.surface != second {
		t.Fatalf("drain-timeout refusal blocked second surface: event=%+v state=%+v", attached, m.graphical)
	}
}

func TestGraphicalRestoreLivenessLossAfterFreshCaptureEmitsUnknown(t *testing.T) {
	m, id := graphicalTestManager(t)
	graphicalTestAttach(t, m, id)
	m.runner = graphicalTestRunner(func(_ context.Context, args []string, _ []byte) ([]byte, error) {
		return graphicalTestNative("mark", args[len(args)-1], "ready", 1), nil
	})
	mark := graphicalTestEvent(t, m, graphicalTestRequest(id, "mark", "before-restore", ""), nil)
	if mark.Event != "completed" || mark.PointID == nil {
		t.Fatalf("mark %+v", mark)
	}
	m.CompleteGraphicalEmission(id, mark.RequestID, true)
	b := m.bindings[id]
	m.runner = graphicalTestRunner(func(_ context.Context, args []string, _ []byte) ([]byte, error) {
		if args[1] == "frame" {
			return json.Marshal(NativeFrame{Path: filepath.Join(b.FramesRoot, "fresh.png"), Seq: 1, Generation: b.Container, Width: 2, Height: 1, SHA256RGB24: strings.Repeat("c", 64), CaptureMonoNS: 200, Window: &Window{ID: b.Window, W: 2, H: 1}})
		}
		return graphicalTestNative("restore", *mark.PointID, "ready", 2), nil
	})
	e := graphicalTestEvent(t, m, graphicalTestRequest(id, "restore", "lost-after-capture", *mark.PointID), func(_ Binding, _ NativeFrame) (string, uint64, error) {
		m.mu.Lock()
		lost := m.bindings[id]
		lost.Surface.State = "lost"
		m.bindings[id] = lost
		m.mu.Unlock()
		return strings.Repeat("d", 64), 3, nil
	})
	if e.Event != "outcome_unknown" || e.ReasonCode == nil || *e.ReasonCode != "OUTCOME_UNKNOWN" || m.graphical == nil || m.graphical.busy || !m.graphical.unknown || m.graphical.session.Phase != "outcome_unknown" || m.graphical.session.PendingRequestID == nil || *m.graphical.session.PendingRequestID != e.RequestID {
		t.Fatalf("lost restore did not settle unknown: event=%+v state=%+v", e, m.graphical)
	}
}

func TestGraphicalAttachResetsRequestBudgetForLifetime(t *testing.T) {
	m, id := graphicalTestManager(t)
	b := m.bindings[id]
	m.graphical = &graphicalSessionState{surface: id, run: b.RunID, requests: make(map[string]bool)}
	for i := 0; i < 127; i++ {
		m.graphical.requests["request-old-"+string(rune('a'+i%26))+string(rune('A'+i/26))] = true
	}
	m.runner = graphicalTestRunner(func(context.Context, []string, []byte) ([]byte, error) {
		return graphicalTestNative("attach", "", "ready", 1), nil
	})
	e := graphicalTestEvent(t, m, graphicalTestRequest(id, "attach", "lifetime", ""), nil)
	if e.Event != "completed" || len(m.graphical.requests) != 1 || !m.graphical.requests["request-lifetime"] {
		t.Fatalf("attach did not start a fresh request lifetime: event=%+v requests=%d", e, len(m.graphical.requests))
	}
	m.CompleteGraphicalEmission(id, e.RequestID, true)
	m.runner = graphicalTestRunner(func(_ context.Context, argv []string, _ []byte) ([]byte, error) {
		return graphicalTestNative("mark", argv[len(argv)-1], "ready", 1), nil
	})
	mark := graphicalTestEvent(t, m, graphicalTestRequest(id, "mark", "after-reset", ""), nil)
	if mark.Event != "completed" {
		t.Fatalf("fresh session lifetime was capacity-locked: %+v", mark)
	}
}

func TestFailedBeforeDestroyDrainReopensStoppingWithoutErasingState(t *testing.T) {
	m, id := graphicalTestManager(t)
	graphicalTestAttach(t, m, id)
	m.graphical.busy = true
	m.graphical.unknown = true
	m.cfg.BeforeDestroy = func(context.Context, string) error { return fault("drain", "controlled failure") }
	_, err := m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`))
	if err == nil {
		t.Fatal("expected pre-destroy drain error")
	}
	if m.bindings[id].Surface.State != "active" || m.graphical == nil || m.graphical.stopping || !m.graphical.busy || !m.graphical.unknown {
		t.Fatalf("failed drain did not reopen retry safely: surface=%+v graphical=%+v", m.bindings[id].Surface, m.graphical)
	}
}

func TestNewRuntimeIgnoresGraphicalEnvironmentUnlessAdmitted(t *testing.T) {
	for _, tc := range []struct {
		arch, flag string
		want       bool
	}{
		{"amd64", "", false}, {"amd64", "0", false}, {"amd64", "false", false}, {"amd64", "1", false},
		{"arm64", "", false}, {"arm64", "0", false}, {"arm64", "false", false}, {"arm64", "1", true},
	} {
		if got := graphicalRuntimeAdmitted(tc.arch, tc.flag); got != tc.want {
			t.Errorf("graphicalRuntimeAdmitted(%q,%q)=%v want %v", tc.arch, tc.flag, got, tc.want)
		}
	}
	cfg := testManager(t, &scriptRunner{}).cfg
	bin, err := filepath.Abs("testdata")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("MV_SRF_BIN_DIR", bin)
	t.Setenv("PATH", os.Getenv("PATH"))
	for _, key := range graphicalEnvironmentKeys[1:] {
		t.Setenv(key, "/invalid/unadmitted/pin")
	}
	t.Setenv("SRF_GRAPHICAL_VM_ENTRY_SHA256", "invalid")
	t.Setenv("SRF_GRAPHICAL_QEMU_IMG_SHA256", "invalid")

	for _, flag := range []string{"0", "false", "1"} {
		t.Run(flag, func(t *testing.T) {
			t.Setenv("MV_GRAPHICAL_SESSION_ENABLED", flag)
			m, e := NewRuntime(cfg, func() uint64 { return 1 })
			if runtime.GOARCH == "arm64" && flag == "1" {
				if e == nil {
					t.Fatal("enabled arm64 accepted invalid graphical pins")
				}
				return
			}
			if e != nil {
				t.Fatalf("stray disabled/unsupported graphical env aborted startup: %v", e)
			}
			if m.cfg.GraphicalSessions {
				t.Fatal("unsupported graphical runtime was enabled")
			}
			runner, ok := m.runner.(*ProcessRunner)
			if !ok {
				t.Fatalf("unexpected runtime runner %T", m.runner)
			}
			for _, value := range runner.env {
				for _, key := range graphicalEnvironmentKeys {
					if strings.HasPrefix(value, key+"=") {
						t.Fatalf("unadmitted graphical value reached child env: %s", key)
					}
				}
			}
		})
	}
}
