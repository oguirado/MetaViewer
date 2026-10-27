package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

type evidenceRunner struct {
	cli.Runner
	mode  string
	input map[string]json.RawMessage
	root  string
}

func (r *evidenceRunner) Run(ctx context.Context, args []string, stdin []byte) ([]byte, error) {
	out, err := r.Runner.Run(ctx, args, stdin)
	if err != nil {
		return out, err
	}
	var native map[string]json.RawMessage
	if err = json.Unmarshal(out, &native); err != nil {
		return nil, err
	}
	if args[1] == "input" {
		switch r.mode {
		case "missing":
			delete(native, "input_mono_ns")
		case "unfocused":
			native["focus_verified"] = json.RawMessage(`false`)
		case "foreign":
			native["surface_id"] = json.RawMessage(`"other-window"`)
		}
		r.input = native
		if r.mode == "cross-valid" {
			img := image.NewNRGBA(image.Rect(0, 0, 2, 1))
			img.Set(0, 0, color.NRGBA{B: 255, A: 255})
			img.Set(1, 0, color.NRGBA{G: 255, A: 255})
			f, err := os.OpenFile(filepath.Join(r.root, "demo-run", "frames", "w1", "f.png"), os.O_WRONLY|os.O_TRUNC, 0600)
			if err != nil {
				return nil, err
			}
			err = png.Encode(f, img)
			closeErr := f.Close()
			if err != nil {
				return nil, err
			}
			if closeErr != nil {
				return nil, closeErr
			}
		}
	}
	if args[1] == "frame" && r.input != nil {
		switch r.mode {
		case "cross-valid":
			native["sha256_rgb24"], _ = json.Marshal(fmt.Sprintf("%x", sha256.Sum256([]byte{0, 0, 255, 0, 255, 0})))
		case "generation":
			native["generation"] = json.RawMessage(`"srf-id-old"`)
		case "old-capture":
			native["capture_mono_ns"] = json.RawMessage(`1`)
		case "before-input":
			var stamp uint64
			_ = json.Unmarshal(r.input["input_mono_ns"], &stamp)
			native["capture_mono_ns"], _ = json.Marshal(stamp - 1)
		}
	}
	return json.Marshal(native)
}

func TestWireReceiptNativeEvidence(t *testing.T) {
	for _, mode := range []string{"valid", "cross-valid", "missing", "unfocused", "foreign", "generation", "old-capture", "before-input"} {
		t.Run(mode, func(t *testing.T) {
			bin, root := fakeNative(t)
			origin := monotonic()
			process, err := capsule.NewProcessRunner(bin, []string{"PATH=/usr/bin:/bin", "SRF_IDENTITY_STORE_ROOT=" + root, "MV_SRF_STATE_DIR=" + filepath.Join(root, "state")}, 8192, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			runner := &evidenceRunner{Runner: process, mode: mode, root: root}
			profiles := map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1}}
			manager, err := capsule.NewManager(capsule.Config{BinDir: bin, Profiles: profiles, MaxSurfaces: 1, MaxOutputBytes: 8192, Timeout: time.Second, OriginNS: origin}, runner, monotonic)
			if err != nil {
				t.Fatal(err)
			}
			pub, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 8192, MaxPixels: 2, MaxSurfaces: 1})
			if err != nil {
				t.Fatal(err)
			}
			defer pub.Close()
			handler := wireHandler(manager, profiles, map[string]*frames.Publisher{root: pub}, origin)
			request := func(op string, params any) []json.RawMessage {
				t.Helper()
				raw, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": op, "params": params})
				out, err := handler(context.Background(), ipc.Envelope{Body: raw})
				if err != nil {
					t.Fatal(err)
				}
				return out
			}
			created := request("create", map[string]any{"kind": "browser", "profile_id": "demo", "geometry": map[string]int{"w": 2, "h": 1}})
			var event struct {
				Data struct {
					Surface capsule.Surface `json:"surface"`
				} `json:"data"`
			}
			if len(created) != 2 {
				t.Fatalf("create: %s", created)
			}
			_ = json.Unmarshal(created[0], &event)
			id := event.Data.Surface.SurfaceID
			defer request("destroy", map[string]string{"surface_id": id})
			out := request("input", map[string]any{"surface_id": id, "proposal_id": "receipt-proof", "action": map[string]any{"type": "key", "keys": []string{"Escape"}}})
			if mode != "valid" && mode != "cross-valid" {
				if len(out) != 1 {
					t.Fatalf("invalid evidence emitted success events: %s", out)
				}
				var refused struct {
					Schema   string          `json:"schema"`
					Verified bool            `json:"verified"`
					Error    string          `json:"error"`
					Evidence json.RawMessage `json:"native_evidence"`
					Frame    json.RawMessage `json:"after_frame"`
				}
				_ = json.Unmarshal(out[0], &refused)
				var initial struct {
					Data struct {
						Frame json.RawMessage `json:"frame_ref"`
					} `json:"data"`
				}
				_ = json.Unmarshal(created[1], &initial)
				// The input-settle contract requires a failed terminal receipt;
				// invalid native proof must never escape or become a post-input frame.
				if refused.Schema != "action_receipt/v0.2" || refused.Verified || refused.Error == "" || len(refused.Evidence) != 0 || string(refused.Frame) != string(initial.Data.Frame) {
					t.Fatalf("invalid evidence accepted or failed settlement lost: %s", out)
				}
				return
			}
			if len(out) != 3 {
				t.Fatalf("input: %s", out)
			}
			var receipt struct {
				Evidence map[string]json.RawMessage `json:"native_evidence"`
				Executed uint64                     `json:"executed_at_ns"`
				Frame    struct {
					SurfaceID string `json:"surface_id"`
					TS        uint64 `json:"ts_ns"`
				} `json:"after_frame"`
				Verified bool `json:"verified"`
			}
			if err = json.Unmarshal(out[2], &receipt); err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{"input_mono_ns", "focus_verified", "kind", "result"} {
				if string(receipt.Evidence[key]) != string(runner.input[key]) {
					t.Fatalf("native %s lost or synthesized: %s", key, out[2])
				}
			}
			if string(receipt.Evidence["native_surface_id"]) != string(runner.input["surface_id"]) {
				t.Fatal("native window identity lost")
			}
			var stamp, session uint64
			_ = json.Unmarshal(receipt.Evidence["input_mono_ns"], &stamp)
			_ = json.Unmarshal(receipt.Evidence["input_ts_ns"], &session)
			if session != stamp-origin || receipt.Executed < session || receipt.Frame.TS < receipt.Executed || receipt.Frame.SurfaceID != id || receipt.Verified {
				t.Fatalf("uncorrelated receipt: %s", out[2])
			}
			// [TARGET, unit decision] Optional test export is consumed by the
			// Rust cross-language test; it comes from the production wire handler.
			if mode == "cross-valid" && os.Getenv("MV_RCPT_TEST_EXPORT") != "" {
				var initial struct {
					Data struct {
						Frame json.RawMessage `json:"frame_ref"`
					} `json:"data"`
				}
				_ = json.Unmarshal(created[1], &initial)
				payload, err := json.Marshal(map[string]any{"before": initial.Data.Frame, "receipt": out[2]})
				if err != nil {
					t.Fatal(err)
				}
				if err = os.WriteFile(os.Getenv("MV_RCPT_TEST_EXPORT"), payload, 0600); err != nil {
					t.Fatal(err)
				}
			}
			// Validate the emitted receipt through the production closed schema decoder.
			policy, err := ipc.NewPolicy(ipc.Config{SocketPath: filepath.Join(t.TempDir(), "core.sock"), MaxReplayEntries: 100, MaxConnections: 1, HelloTimeout: time.Second, ReadTimeout: time.Second, WriteTimeout: time.Second, ProbeTimeout: time.Second, ShutdownTimeout: time.Second, MaxFrameBytes: 1 << 20, MaxDepth: 32, MaxStringBytes: 65536, MaxKeys: 256, MaxArrayItems: 4096}, os.DirFS(filepath.Join("..", "..", "..", "contracts", "v0.2")), &lifecyclePolicy{})
			if err != nil {
				t.Fatal(err)
			}
			envelope, _ := json.Marshal(ipc.Envelope{Schema: "envelope/v0.2", MsgID: "proof", From: ipc.Endpoint{Component: "daemon", Instance: "daemon"}, To: ipc.Endpoint{Component: "core", Instance: "core"}, SessionID: "proof", Seq: 1, Nonce: "proof", Body: out[2]})
			if _, err = policy.ValidateEnvelope(envelope); err != nil {
				t.Fatalf("receipt schema: %v", err)
			}
		})
	}
}
