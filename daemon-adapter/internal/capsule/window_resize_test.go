package capsule

import (
	"context"
	"encoding/json"
	"metaviewer/daemon-adapter/internal/cli"
	"os"
	"testing"
	"time"
)

func resizeFixture(t *testing.T) (*Manager, *hostWindowFakeRunner, string) {
	t.Helper()
	ram, err := os.MkdirTemp("/dev/shm", "mv-resize-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(ram) })
	r := &hostWindowFakeRunner{windows: map[string]*HostWindowSpec{}}
	m, err := NewManager(Config{BinDir: t.TempDir(), OriginNS: 100, MaxSurfaces: 2, MaxOutputBytes: 4096, Timeout: time.Second, Profiles: map[string]Profile{"demo": {Kind: "browser", NativeKind: "browser", Width: 2, Height: 1, Display: ":100", RAMRoot: ram}}}, r, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	return m, r, "hw-4a00003"
}
func resizeAttach(t *testing.T, m *Manager, r *hostWindowFakeRunner, profile string, w, h int) string {
	t.Helper()
	r.windows[profile] = &HostWindowSpec{XID: 77594627, Witness: "0x04a00003:1730541000", Title: "Resize fixture", Program: "chromium", Width: 2, Height: 1}
	params, _ := json.Marshal(map[string]any{"kind": "desktop_capsule", "profile_id": profile, "geometry": Geometry{W: w, H: h}})
	evs, err := m.Handle(context.Background(), Request{Schema: "surface_request/v0.2", Op: "create", Params: params})
	if err != nil {
		t.Fatalf("attach at %dx%d: %v", w, h, err)
	}
	var ev struct{ Data struct{ Surface Surface } }
	if err = json.Unmarshal(evs[0], &ev); err != nil {
		t.Fatal(err)
	}
	return ev.Data.Surface.SurfaceID
}
func TestHostWindowResizeCaptureSurvivesContinuousDrag(t *testing.T) {
	m, r, profile := resizeFixture(t)
	id := resizeAttach(t, m, r, profile, 2, 1)
	for i := 0; i < 8; i++ {
		r.captureErr = &cli.Fault{Code: "host_window_unavailable", Detail: "host_window_unavailable: host_window_unavailable: resized: 2x1 -> 3x2"}
		before := len(r.calls)
		b, _, err := m.Capture(context.Background(), id)
		if err == nil || b.Surface.State != "active" || b.Surface.Geometry != (Geometry{W: 3, H: 2}) {
			t.Fatalf("resize must update geometry and remain active: %+v %v", b, err)
		}
		if len(r.calls) != before+1 {
			t.Fatal("resize must yield after one bounded capture attempt")
		}
	}
	r.captureErr = nil
	r.captureOut = makeTestXWD(3, 2, 42)
	b, f, err := m.Capture(context.Background(), id)
	if err != nil || b.Surface.State != "active" || f.Width != 3 || f.Height != 2 {
		t.Fatalf("capture did not recover after drag paused: %+v %v", f, err)
	}
	r.captureOut = nil
	r.captureErr = &cli.Fault{Code: "host_window_unavailable", Detail: "host_window_unavailable: witness changed"}
	b, _, err = m.Capture(context.Background(), id)
	if err == nil || b.Surface.State != "lost" {
		t.Fatalf("real loss must still be immediate: %+v %v", b, err)
	}
}
func TestHostWindowReattachAfterResizeUsesOpeningGeometry(t *testing.T) {
	m, r, profile := resizeFixture(t)
	id := resizeAttach(t, m, r, profile, 2, 1)
	m.UpdateHostWindowGeometry(id, 3, 2)
	p, ok := m.hostWindowProfileFor(profile, &HostWindowSpec{Width: 2, Height: 1}, 4, 3)
	if !ok || p.Width != 4 || p.Height != 3 {
		t.Errorf("retained resize geometry leaked into next opening: %+v", p)
	}
	if _, err := m.MarkHostWindowLost(id, "host_window_unavailable: window closed"); err != nil {
		t.Fatal(err)
	}
	params, _ := json.Marshal(map[string]string{"surface_id": id})
	if _, err := m.Handle(context.Background(), Request{Schema: "surface_request/v0.2", Op: "destroy", Params: params}); err != nil {
		t.Fatal(err)
	}
	next := resizeAttach(t, m, r, profile, 4, 3)
	if next == id {
		t.Fatal("reattach must have a fresh surface identity")
	}
	for _, bad := range []Geometry{{W: 0, H: 1}, {W: 4097, H: 1}, {W: 1, H: 4097}} {
		if _, ok := m.hostWindowProfileFor(profile, &HostWindowSpec{}, bad.W, bad.H); ok {
			t.Errorf("out-of-bounds opening admitted: %+v", bad)
		}
	}
}
