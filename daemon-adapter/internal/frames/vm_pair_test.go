package frames

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"metaviewer/daemon-adapter/internal/capsule"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type vmPairRunner struct {
	kind, container string
	calls           [][]string
	frame           capsule.NativeFrame
	frameErr        error
	frameOutput     []byte
	host            *capsule.HostWindowSpec
}

func (r *vmPairRunner) ConsumeOpeningWindow(string) (*capsule.HostWindowSpec, error) {
	s := r.host
	r.host = nil
	return s, nil
}
func (r *vmPairRunner) Run(_ context.Context, args []string, _ []byte) ([]byte, error) {
	r.calls = append(r.calls, append([]string(nil), args...))
	switch args[1] {
	case "start":
		return []byte(fmt.Sprintf(`{"kind":%q,"container":%q,"run_id":"vm-fixture-run","windows":[{"id":"w1","x":0,"y":0,"w":2,"h":1,"title":"","url":""}]}`, r.kind, r.container)), nil
	case "frame":
		if r.frameErr != nil {
			return nil, r.frameErr
		}
		if r.frameOutput != nil {
			return r.frameOutput, nil
		}
		return json.Marshal(r.frame)
	case "capture":
		return nil, r.frameErr
	case "stop":
		return []byte(fmt.Sprintf(`{"stopped":%q,"removed_verified":true}`, r.container)), nil
	default:
		return nil, fmt.Errorf("unexpected native operation: %v", args)
	}
}

func vmPairFixture(t *testing.T, native string) (*RingSource, *vmPairRunner, capsule.Binding) {
	t.Helper()
	ram, err := os.MkdirTemp("/dev/shm", "mv-vm-pair-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(ram) })
	kind, program, prefix := "browser", "", "srf-id-"
	switch native {
	case "vm":
		kind, program, prefix = "vm", "notepad-vm", "srf-vm-"
	case "program":
		kind, program, prefix = "desktop_capsule", "notepad", "srf-pg-"
	}
	runner := &vmPairRunner{kind: native, container: prefix + "demo"}
	profile := capsule.Profile{Kind: kind, NativeKind: native, Program: program, Width: 2, Height: 1, Display: ":100", RAMRoot: ram}
	if native == "host-window" {
		t.Setenv("DISPLAY", ":0")
		runner.host = &capsule.HostWindowSpec{XID: 77594627, Witness: "0x04a00003:1730541000", Title: "Synthetic editor", Program: "editor", Width: 2, Height: 1}
		profile.Kind, profile.NativeKind = "browser", "browser"
	}
	m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), OriginNS: 100, MaxSurfaces: 2, MaxOutputBytes: 4096, Timeout: time.Second, Profiles: map[string]capsule.Profile{"demo": profile}}, runner, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	profileID := "demo"
	if native == "host-window" {
		profileID = "hw-4a00003"
		kind = "desktop_capsule"
	}
	params := json.RawMessage(fmt.Sprintf(`{"kind":%q,"profile_id":%q,"geometry":{"w":2,"h":1}}`, kind, profileID))
	events, err := m.Handle(context.Background(), capsule.Request{Schema: "surface_request/v0.2", Op: "create", Params: params})
	if err != nil {
		t.Fatal(err)
	}
	var event struct {
		Data struct{ Surface capsule.Surface }
	}
	if err = json.Unmarshal(events[0], &event); err != nil {
		t.Fatal(err)
	}
	b, err := m.SubscriptionBinding(event.Data.Surface.SurfaceID)
	if err != nil {
		t.Fatal(err)
	}
	runner.calls = nil
	runner.frame = capsule.NativeFrame{Path: filepath.Join(b.FramesRoot, "pair.png"), Seq: 1, SHA256RGB24: strings.Repeat("a", 64), Width: 2, Height: 1, CaptureMonoNS: 200, Generation: b.Container, Window: &capsule.Window{ID: "w1", W: 2, H: 1}}
	// A deliberately absent ring root proves that pair kinds do not consult it.
	return &RingSource{Manager: m, root: filepath.Join(ram, "absent-ring"), clock: func() uint64 { return 200 }, origin: 100}, runner, b
}

func TestVMPairSelectionWithResidentSource(t *testing.T) {
	for _, native := range []string{"vm", "browser", "program", "host-window"} {
		t.Run(native, func(t *testing.T) {
			s, r, b := vmPairFixture(t, native)
			if native == "host-window" {
				r.frameErr = errors.New("synthetic host capture refusal")
			}
			got, f, err := s.Capture(context.Background(), b.Surface.SurfaceID)
			switch native {
			case "vm":
				if err != nil || got.NativeKind != "vm" || f.Generation != b.Container {
					t.Fatalf("pair capture: %+v %v", f, err)
				}
				if len(r.calls) != 1 {
					t.Fatalf("native calls %v", r.calls)
				}
				want := []string{r.calls[0][0], "frame", "--container", b.Container, "--window", "w1"}
				if !reflect.DeepEqual(r.calls[0], want) {
					t.Fatalf("native pair argv %v", r.calls)
				}
			case "host-window":
				if err == nil || len(r.calls) != 1 || r.calls[0][1] != "capture" {
					t.Fatalf("host capture changed: %v %v", r.calls, err)
				}
			default:
				if err == nil || len(r.calls) != 1 || r.calls[0][1] != "stop" {
					t.Fatalf("resident refusal/stop changed or downgraded to pair: %v %v", r.calls, err)
				}
				requireRingCode(t, err, "ring_root")
			}
		})
	}
}

func TestVMPairNativeRefusalsRemainClosed(t *testing.T) {
	for _, mode := range []string{"native-error", "wrong-container", "foreign-allocation", "wrong-window", "future-time", "stale-time", "malformed", "zero-sequence", "missing-window", "cancelled", "unknown-surface"} {
		t.Run(mode, func(t *testing.T) {
			s, r, b := vmPairFixture(t, "vm")
			ctx := context.Background()
			id := b.Surface.SurfaceID
			switch mode {
			case "native-error":
				r.frameErr = errors.New("guest relay unavailable")
			case "wrong-container":
				r.frame.Generation = "srf-vm-foreign"
			case "foreign-allocation":
				r.frame.Path = filepath.Join(filepath.Dir(b.FramesRoot), "foreign", "pair.png")
			case "wrong-window":
				r.frame.Window.ID = "w2"
			case "future-time":
				r.frame.CaptureMonoNS = 201
			case "stale-time":
				r.frame.CaptureMonoNS = 199
			case "malformed":
				r.frameOutput = []byte(`{"path":`)
			case "zero-sequence":
				r.frame.Seq = 0
			case "missing-window":
				r.frame.Window = nil
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			case "unknown-surface":
				id = "surface-unknown"
			}
			if _, _, err := s.Capture(ctx, id); err == nil {
				t.Fatal("invalid capture accepted")
			}
			wantCalls := 1
			if mode == "cancelled" || mode == "unknown-surface" {
				wantCalls = 0
			}
			if len(r.calls) != wantCalls {
				t.Fatalf("unexpected retry/downgrade: %v", r.calls)
			}
			for _, call := range r.calls {
				if call[1] != "frame" {
					t.Fatalf("unexpected operation %v", call)
				}
			}
		})
	}
}

func TestVMPairVerifiedPublicationWithResidentPublisher(t *testing.T) {
	s, r, b := vmPairFixture(t, "vm")
	_, _, original := ramFixture(t)
	png, err := os.ReadFile(original.Path)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(b.FramesRoot, 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(r.frame.Path, png, 0600); err != nil {
		t.Fatal(err)
	}
	r.frame.SHA256RGB24 = original.SHA256RGB24
	got, f, err := s.Capture(context.Background(), b.Surface.SurfaceID)
	if err != nil {
		t.Fatal(err)
	}
	ram := filepath.Dir(filepath.Dir(filepath.Dir(b.FramesRoot)))
	p := publisher(t, ram)
	p.UseRingSource(s)
	// VM pair PNG must go through the checked legacy reader, not ring.take.
	ref, err := p.Publish(b.Surface.SurfaceID, got, f)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(ref.RAMWSPath)
	if err != nil || string(raw) != string([]byte{255, 0, 0, 0, 255, 0}) || ref.SHA256 != original.SHA256RGB24 {
		t.Fatalf("wrong verified pixels %v %v", ref, err)
	}
	f.Seq++
	f.SHA256RGB24 = strings.Repeat("a", 64)
	if _, err = p.Publish(b.Surface.SurfaceID, got, f); err == nil {
		t.Fatal("corrupt VM pair digest accepted")
	}
}

func TestNativePairCaptureKinds(t *testing.T) {
	for _, kind := range []string{"host-window", "host-xpra", "vm"} {
		if !usesNativePairCapture(kind) {
			t.Errorf("native pair kind %q rejected", kind)
		}
	}
	for _, kind := range []string{"browser", "program", "holdings", "", "VM", "vm ", "unknown"} {
		if usesNativePairCapture(kind) {
			t.Errorf("non-pair kind %q accepted", kind)
		}
	}
}
