//go:build live

package frames

// [TARGET, unit decision] Live configuration uses MV_SRF_BIN_DIR and MV_SRF_STATE_DIR plus
// MV_SRF_LIVE_RAM_ROOT and MV_SRF_LIVE_PROFILE. Holdings additionally requires
// MV_SRF_LIVE_APP_DIR and its own binary; run TestLiveHoldingsCapsule explicitly.
// Missing prerequisites fail the tagged gate; the default suite is fully fake.
import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"metaviewer/daemon-adapter/internal/capsule"
)

func hostMonotonic(t *testing.T) uint64 {
	t.Helper()
	var ts syscall.Timespec
	_, _, errno := syscall.Syscall(syscall.SYS_CLOCK_GETTIME, 1, uintptr(unsafe.Pointer(&ts)), 0)
	if errno != 0 {
		t.Fatalf("monotonic clock unavailable: %v", errno)
	}
	return uint64(ts.Sec)*1000000000 + uint64(ts.Nsec)
}
func TestLiveCapsule(t *testing.T) {
	testLiveCapsule(t, "browser", "srf-identity-surface")
}

// TestLiveHoldingsCapsule requires a built srf-holdings-capsule binary.
// It deliberately fails on missing prerequisites and never silently skips.
func TestLiveHoldingsCapsule(t *testing.T) {
	testLiveCapsule(t, "game_capsule", "srf-holdings-capsule")
}

func testLiveCapsule(t *testing.T, kind, binary string) {
	t.Helper()
	bin := os.Getenv("MV_SRF_BIN_DIR")
	if !filepath.IsAbs(bin) {
		t.Fatal("MV_SRF_BIN_DIR must name an admitted binary directory")
	}
	native := filepath.Join(bin, binary)
	if st, e := os.Stat(native); e != nil || st.IsDir() || st.Mode()&0111 == 0 {
		t.Fatalf("required live binary %s is absent or not executable (build it before running this variant): %v", native, e)
	}
	app, root, profile := os.Getenv("MV_SRF_LIVE_APP_DIR"), os.Getenv("MV_SRF_LIVE_RAM_ROOT"), os.Getenv("MV_SRF_LIVE_PROFILE")
	if !filepath.IsAbs(root) || profile == "" {
		t.Fatal("explicit admitted MV_SRF_LIVE_RAM_ROOT and MV_SRF_LIVE_PROFILE required")
	}
	if kind == "game_capsule" && !filepath.IsAbs(app) {
		t.Fatal("Holdings requires an explicit admitted MV_SRF_LIVE_APP_DIR")
	}
	nativeKind := "browser"
	if kind == "game_capsule" {
		nativeKind = "holdings"
	}
	env := []string{"PATH=" + os.Getenv("PATH")}
	for _, key := range []string{"MV_SRF_STATE_DIR", "HOME", "XDG_RUNTIME_DIR", "SRF_IDENTITY_STORE_ROOT", "SRF_PROXY_REGISTRY", "SRF_EGRESS_PROXY"} {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	runner, e := capsule.NewProcessRunner(bin, env, 1<<20, 90*time.Second)
	if e != nil {
		t.Fatal(e)
	}
	clock := func() uint64 { return hostMonotonic(t) }
	manager, e := capsule.NewManager(capsule.Config{BinDir: bin, MaxSurfaces: 1, MaxOutputBytes: 1 << 20, Timeout: 90 * time.Second, OriginNS: clock(), Profiles: map[string]capsule.Profile{profile: {Kind: kind, NativeKind: nativeKind, AppDir: app, RAMRoot: root, Display: ":100", Width: 1280, Height: 900}}}, runner, clock)
	if e != nil {
		t.Fatal(e)
	}
	params, e := json.Marshal(map[string]any{"kind": kind, "profile_id": profile, "geometry": map[string]int{"w": 1280, "h": 900}})
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	replies, e := manager.Handle(ctx, capsule.Request{Schema: "surface_request/v0.2", Op: "create", Params: params})
	if e != nil {
		t.Fatal(e)
	}
	var created struct {
		Data struct {
			Surface capsule.Surface `json:"surface"`
		} `json:"data"`
	}
	if len(replies) != 1 {
		t.Fatal("missing live surface")
	}
	if e = json.Unmarshal(replies[0], &created); e != nil {
		t.Fatal(e)
	}
	id := created.Data.Surface.SurfaceID
	if id == "" || created.Data.Surface.Kind != kind || created.Data.Surface.State != "active" {
		t.Fatal("live start did not return an active surface of the requested kind")
	}
	t.Cleanup(func() {
		body, e := json.Marshal(map[string]string{"surface_id": id})
		if e != nil {
			t.Error(e)
			return
		}
		if _, e = manager.Handle(context.Background(), capsule.Request{Schema: "surface_request/v0.2", Op: "destroy", Params: body}); e != nil {
			t.Errorf("live removal verification failed: %v", e)
		}
	})
	pub, e := NewPublisher(PublishConfig{RAMRoot: root, MaxFrameBytes: 16 << 20, MaxPixels: 1280 * 900, MaxSurfaces: 1})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		if e := pub.Close(); e != nil {
			t.Error(e)
		}
	})
	binding, frame, e := manager.Capture(ctx, id)
	if e != nil {
		t.Fatal(e)
	}
	ref, e := pub.Publish(id, binding, frame)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = os.Stat(ref.RAMWSPath); e != nil {
		t.Fatal(e)
	}
	if _, e = pub.Publish(id, binding, frame); e == nil {
		t.Fatal("stale live frame accepted")
	}
	if _, e = pub.Publish("foreign", binding, frame); e == nil {
		t.Fatal("cross-surface live frame accepted")
	}
	input, e := json.Marshal(map[string]any{
		"surface_id": id, "proposal_id": "live-input",
		"action": map[string]any{"type": "key", "keys": []string{"Escape"}},
	})
	if e != nil {
		t.Fatal(e)
	}
	receipts, e := manager.Handle(ctx, capsule.Request{Schema: "surface_request/v0.2", Op: "input", Params: input})
	if e != nil {
		t.Fatal(e)
	}
	var applied struct {
		Event string `json:"event"`
		Data  struct {
			SurfaceID  string `json:"surface_id"`
			ProposalID string `json:"proposal_id"`
		} `json:"data"`
	}
	if len(receipts) != 1 {
		t.Fatal("live input did not return one receipt")
	}
	if e = json.Unmarshal(receipts[0], &applied); e != nil {
		t.Fatal(e)
	}
	if applied.Event != "input_applied" || applied.Data.SurfaceID != id || applied.Data.ProposalID != "live-input" {
		t.Fatal("live input receipt does not match the dispatched action")
	}

}
