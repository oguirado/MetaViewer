package capsule

import (
	"context"
	"encoding/json"
	"metaviewer/daemon-adapter/internal/cli"
	"os"
	"testing"
	"time"
)

func TestV027FixK1CaptureFirstLostDelivery(t *testing.T) {
	for _, captureFirst := range []bool{true, false} {
		t.Run(map[bool]string{true: "capture-first", false: "display-first"}[captureFirst], func(t *testing.T) {
			root, err := os.MkdirTemp("/dev/shm", "v027-fix-k1-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.RemoveAll(root) })
			runner := &hostWindowFakeRunner{captureErr: &cli.Fault{Code: "host_window_unavailable", Detail: "host_window_unavailable: window closed"}}
			m, err := NewManager(Config{BinDir: t.TempDir(), MaxSurfaces: 1, MaxOutputBytes: 4096, Timeout: time.Second, OriginNS: 1, Profiles: map[string]Profile{"hw": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Width: 2, Height: 1, Display: ":100"}}}, runner, func() uint64 { return 100 })
			if err != nil {
				t.Fatal(err)
			}
			m.bindings["window"] = Binding{NativeKind: "host-window", HostXID: 42, HostWitness: "w", Container: "hw", RunID: "run-hw", Surface: Surface{SurfaceID: "window", ProfileID: "hw", State: "active", Geometry: Geometry{W: 2, H: 1}}}
			if captureFirst {
				_, _, _ = m.Capture(context.Background(), "window")
			}
			event, err := m.MarkHostWindowLost("window", "host_window_unavailable: window closed")
			if err != nil || len(event) == 0 {
				t.Fatalf("lost event discarded after capture=%v: %s %v", captureFirst, event, err)
			}
			var ev struct {
				Data struct {
					Surface Surface `json:"surface"`
				} `json:"data"`
			}
			_ = json.Unmarshal(event, &ev)
			if ev.Data.Surface.State != "lost" {
				t.Fatalf("not lost: %s", event)
			}
			if !captureFirst {
				_, _, _ = m.Capture(context.Background(), "window")
			}
			duplicate, err := m.MarkHostWindowLost("window", "closed")
			if err != nil || len(duplicate) != 0 {
				t.Fatalf("duplicate transition: %s %v", duplicate, err)
			}
		})
	}
}

func TestV027FixK1VerifiedClaimsCaptureLoss(t *testing.T) {
	m, r, profile := resizeFixture(t)
	id := resizeAttach(t, m, r, profile, 2, 1)
	r.captureErr = &cli.Fault{Code: "host_window_unavailable", Detail: "host_window_unavailable: witness changed"}
	_, _, err := m.Capture(context.Background(), id)
	if err == nil {
		t.Fatal("capture accepted changed witness")
	}
	ev, err := m.BeginMarkLost(id)
	if err != nil || len(ev) == 0 {
		t.Fatalf("VERIFIED lost event missing: %s %v", ev, err)
	}
	m.CompleteLost(id, true)
	ev, err = m.MarkHostWindowLost(id, "closed")
	if err != nil || len(ev) != 0 {
		t.Fatalf("DISPLAY duplicated event: %s %v", ev, err)
	}
}
func TestV027FixK1NativeGeometry(t *testing.T) {
	m, _, _ := resizeFixture(t)
	m.bindings["native"] = Binding{NativeKind: "browser", Window: "w1", Surface: Surface{SurfaceID: "native", ProfileID: "demo", State: "active", Geometry: Geometry{W: 2, H: 1}}}
	if !m.UpdateHostWindowGeometry("native", 4, 2) || m.bindings["native"].Surface.Geometry != (Geometry{W: 4, H: 2}) {
		t.Fatal("native DISPLAY resize did not reach the binding")
	}
	if p := m.cfg.Profiles["demo"]; p.Width != 2 || p.Height != 1 {
		t.Fatal("DISPLAY geometry changed the configured geometry for the next native create")
	}
	if m.UpdateHostWindowGeometry("native", 0, 2) {
		t.Fatal("invalid geometry accepted")
	}
	m.bindings["native"] = Binding{NativeKind: "holdings", Window: "w1", Surface: Surface{State: "active"}}
	if m.UpdateHostWindowGeometry("native", 4, 2) {
		t.Fatal("unsupported native kind accepted")
	}
}
