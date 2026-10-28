package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func nvEnvironment(t *testing.T) string {
	t.Helper()
	bin, root := fakeNative(t)
	for key, value := range map[string]string{"MV_SRF_BIN_DIR": bin, "MV_SRF_STATE_DIR": filepath.Join(t.TempDir(), "state"), "SRF_IDENTITY_STORE_ROOT": root, "SRF_PROXY_REGISTRY": filepath.Join(root, "proxies.json"), "XDG_RUNTIME_DIR": t.TempDir(), "MV_SESSION_ID": "nv", "MV_CORE_INSTANCE": "core", "MV_DAEMON_INSTANCE": "daemon", "MV_COMPONENT_COMMIT": "f8f9294fc70a423164d63f2cf6e5de65ec6f6516", "MV_CONTRACT_DIR": filepath.Join("..", "..", "..", "contracts", "v0.2"), "MV_SRF_PROFILES": "", "MV_SRF_LIVE_PROFILE": "demo", "MV_SRF_LIVE_RAM_ROOT": root} {
		t.Setenv(key, value)
	}
	return os.Getenv("MV_SRF_STATE_DIR")
}
func TestNVEnvironmentStatePaths(t *testing.T) {
	for _, kind := range []string{"symlink", "leaf-symlink", "slash", "dot", "clean"} {
		t.Run(kind, func(t *testing.T) {
			state := nvEnvironment(t)
			switch kind {
			case "symlink":
				real := t.TempDir()
				link := filepath.Join(t.TempDir(), "link")
				if err := os.Symlink(real, link); err != nil {
					t.Fatal(err)
				}
				state = link + "/state"
				defer func() {
					if _, err := os.Stat(filepath.Join(real, "state")); !os.IsNotExist(err) {
						t.Error("created state through symlink")
					}
				}()
			case "leaf-symlink":
				real := t.TempDir()
				if err := os.Chmod(real, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(real, state); err != nil {
					t.Fatal(err)
				}
			case "slash":
				state += "/"
			case "dot":
				state = filepath.Dir(state) + "/./state"
			}
			t.Setenv("MV_SRF_STATE_DIR", state)
			r, err := RuntimeFromEnv()
			if err == nil {
				defer r.Close()
			}
			if kind == "clean" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil {
				t.Fatal("unsafe path accepted")
			}
		})
	}
}
func TestNVSecondHelloPreservesSurface(t *testing.T) {
	nvEnvironment(t)
	r, err := RuntimeFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	emitted := make(chan json.RawMessage, 16)
	ctx = context.WithValue(ctx, streamKey{}, streamSession{ctx: ctx, work: &sync.Mutex{}, emit: func(c context.Context, b json.RawMessage) error {
		select {
		case emitted <- b:
			return nil
		case <-c.Done():
			return c.Err()
		}
	}})
	hello := ipc.Envelope{Body: json.RawMessage(`{"schema":"hello/v0.2"}`)}
	if _, err = r.Handler(ctx, hello); err != nil {
		t.Fatal(err)
	}
	create := ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"create","params":{"kind":"browser","profile_id":"demo","geometry":{"w":1280,"h":900}}}`)}
	out, err := r.Handler(ctx, create)
	if err != nil || len(out) < 1 {
		t.Fatalf("create: %s %v", out, err)
	}
	var created struct {
		Data struct {
			Surface struct {
				SurfaceID string `json:"surface_id"`
			} `json:"surface"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out[0], &created); err != nil || created.Data.Surface.SurfaceID == "" {
		t.Fatalf("create failed: %s %v", out, err)
	}
	id := created.Data.Surface.SurfaceID
	subscribe := ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"frame_subscribe","params":{"surface_id":"` + id + `"}}`)}
	if events, e := r.Handler(ctx, subscribe); e != nil || len(events) != 0 {
		t.Fatalf("subscribe: %s %v", events, e)
	}
	select {
	case msg := <-emitted:
		if !strings.Contains(string(msg), `"frame_ready"`) {
			t.Fatalf("subscription failed: %s", msg)
		}
	case <-time.After(time.Second):
		t.Fatal("no subscribed frame")
	}
	if _, err = r.Handler(ctx, hello); err == nil {
		t.Error("second hello accepted")
	}
	// The same task must remain registered: a second subscribe must still fail.
	if events, e := r.Handler(ctx, subscribe); e != nil || len(events) != 1 || !strings.Contains(string(events[0]), "already subscribed") {
		t.Errorf("subscription replaced: %s %v", events, e)
	}
	unsubscribe := ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"frame_unsubscribe","params":{"surface_id":"` + id + `"}}`)}
	if events, e := r.Handler(ctx, unsubscribe); e != nil || len(events) != 0 {
		t.Fatalf("unsubscribe: %s %v", events, e)
	}
	listed, err := r.Handler(ctx, ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"list","params":{}}`)})
	if err != nil || len(listed) != 1 {
		t.Fatalf("surface lost: %s %v", listed, err)
	}
}

func TestNVLiveRuntimeDeduplicatesReencodedUnchangedFramesAndEmitsOnPixelChange(t *testing.T) {
	nvEnvironment(t)
	bin := os.Getenv("MV_SRF_BIN_DIR")
	root := os.Getenv("MV_SRF_LIVE_RAM_ROOT")
	sourceDir := filepath.Join(root, "demo-run", "frames", "w1")
	countPath := filepath.Join(t.TempDir(), "frame-count.txt")
	modePath := filepath.Join(t.TempDir(), "frame-mode.txt")
	if err := os.WriteFile(modePath, []byte("static"), 0600); err != nil {
		t.Fatal(err)
	}

	// Producer rewrites a PNG on every poll with a new mtime, new seq, new
	// capture_mono_ns, and different PNG bytes (varying zlib compression level
	// and a poll-specific ancillary tEXt chunk) while keeping RGB24 pixels
	// identical in "static" mode, and mutates RGB24 pixels in "changed" mode.
	producer := fmt.Sprintf(`#!/usr/bin/python3
import hashlib, json, os, struct, sys, time, zlib

op = sys.argv[1]
source = %q
count_file = %q
mode_file = %q

def chunk(tag, data):
    crc = zlib.crc32(tag + data) & 0xffffffff
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

def write_png(path, rgb_rows, width, height, level, comment):
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    raw = b"".join(b"\x00" + row for row in rgb_rows)
    idat = zlib.compress(raw, level)
    text = b"Comment\x00" + comment.encode("ascii")
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"tEXt", text) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(fd, png)
    os.close(fd)
    os.replace(tmp, path)
    now_ns = time.time_ns() + int(comment.split("-")[-1]) * 1_000_000
    os.utime(path, ns=(now_ns, now_ns))

if op == "start":
    print(json.dumps({"container": "srf-id-demo", "run_id": "demo-run", "windows": [{"id": "w1", "x": 0, "y": 0, "w": 2, "h": 1, "title": "fake", "url": ""}]}))
elif op == "frame":
    n = int(open(count_file).read()) + 1 if os.path.exists(count_file) else 1
    open(count_file, "w").write(str(n))
    mode = open(mode_file).read().strip()
    if mode == "changed":
        rgb = b"\x0b\x16\x21\x2c\x37\x42"
    else:
        rgb = b"\xff\x00\x00\x00\xff\x00"
    png_path = os.path.join(source, "f.png")
    write_png(png_path, [rgb], 2, 1, (n %% 9) + 1, f"poll-{n}")
    sha = hashlib.sha256(rgb).hexdigest()
    print(json.dumps({
        "path": png_path,
        "seq": n,
        "sha256_rgb24": sha,
        "width": 2,
        "height": 1,
        "capture_mono_ns": time.monotonic_ns(),
        "generation": "srf-id-demo",
        "window": {"id": "w1", "x": 0, "y": 0, "w": 2, "h": 1, "title": "fake", "url": ""},
    }))
elif op == "input":
    print(json.dumps({"surface_id": "w1", "kind": "key", "input_mono_ns": time.monotonic_ns(), "focus_verified": True, "result": "ok"}))
elif op == "stop":
    print(json.dumps({"stopped": "srf-id-demo", "removed_verified": True}))
else:
    sys.exit(2)
`, sourceDir, countPath, modePath)
	if err := os.WriteFile(filepath.Join(bin, "srf-identity-surface"), []byte(producer), 0700); err != nil {
		t.Fatal(err)
	}

	r, err := RuntimeFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	emitted := make(chan json.RawMessage, 32)
	ctx = context.WithValue(ctx, streamKey{}, streamSession{ctx: ctx, work: &sync.Mutex{}, emit: func(c context.Context, b json.RawMessage) error {
		select {
		case emitted <- b:
			return nil
		case <-c.Done():
			return c.Err()
		}
	}})

	if _, err = r.Handler(ctx, ipc.Envelope{Body: json.RawMessage(`{"schema":"hello/v0.2"}`)}); err != nil {
		t.Fatal(err)
	}
	createOut, err := r.Handler(ctx, ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"create","params":{"kind":"browser","profile_id":"demo","geometry":{"w":1280,"h":900}}}`)})
	if err != nil || len(createOut) != 2 {
		t.Fatalf("create: %s %v", createOut, err)
	}
	var created struct {
		Data struct {
			Surface struct {
				SurfaceID string `json:"surface_id"`
			} `json:"surface"`
		} `json:"data"`
	}
	var initialReady struct {
		Data struct {
			FrameRef frames.Ref `json:"frame_ref"`
		} `json:"data"`
	}
	if err := json.Unmarshal(createOut[0], &created); err != nil || created.Data.Surface.SurfaceID == "" {
		t.Fatalf("created event: %s %v", createOut[0], err)
	}
	if err := json.Unmarshal(createOut[1], &initialReady); err != nil || initialReady.Data.FrameRef.Generation != 1 {
		t.Fatalf("initial frame_ready: %s %v", createOut[1], err)
	}
	id := created.Data.Surface.SurfaceID
	initialDigest := initialReady.Data.FrameRef.SHA256
	outputDir := filepath.Dir(initialReady.Data.FrameRef.RAMWSPath)

	subscribe := ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"frame_subscribe","params":{"surface_id":"` + id + `"}}`)}
	if events, e := r.Handler(ctx, subscribe); e != nil || len(events) != 0 {
		t.Fatalf("subscribe: %s %v", events, e)
	}

	// Initial 2 confirmation polls deliver generations 2 and 3.
	for wantGen := uint64(2); wantGen <= 3; wantGen++ {
		select {
		case msg := <-emitted:
			var ev struct {
				Event string `json:"event"`
				Data  struct {
					FrameRef frames.Ref `json:"frame_ref"`
				} `json:"data"`
			}
			if err := json.Unmarshal(msg, &ev); err != nil || ev.Event != "frame_ready" || ev.Data.FrameRef.Generation != wantGen || ev.Data.FrameRef.SHA256 != initialDigest {
				t.Fatalf("confirmation poll %d: got %+v err=%v", wantGen, ev, err)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for confirmation generation %d", wantGen)
		}
	}

	// Wait until the producer has executed at least 8 capture polls (1 create + 2 initial + >=5 deduplicated polls).
	deadline := time.After(3 * time.Second)
	for {
		rawCount, _ := os.ReadFile(countPath)
		n, _ := strconv.Atoi(strings.TrimSpace(string(rawCount)))
		if n >= 8 {
			break
		}
		select {
		case msg := <-emitted:
			t.Fatalf("unchanged re-encoded PNG poll emitted unexpected frame_ready: %s", msg)
		case <-deadline:
			t.Fatalf("producer only reached %d polls", n)
		case <-time.After(15 * time.Millisecond):
		}
	}

	select {
	case msg := <-emitted:
		t.Fatalf("expected zero frame_ready events after confirmation polls, got %s", msg)
	default:
	}

	entries, err := os.ReadDir(outputDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 3 {
		t.Fatalf("expected exactly 3 .rgb files retained (g1..g3), got %d", len(entries))
	}

	// Negative control: mutating RGB24 pixels must mint generation 4 on the next poll.
	if err := os.WriteFile(modePath, []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case msg := <-emitted:
		var ev struct {
			Event string `json:"event"`
			Data  struct {
				FrameRef frames.Ref `json:"frame_ref"`
			} `json:"data"`
		}
		if err := json.Unmarshal(msg, &ev); err != nil || ev.Event != "frame_ready" || ev.Data.FrameRef.Generation != 4 || ev.Data.FrameRef.SHA256 == initialDigest {
			t.Fatalf("negative control failed: expected generation 4 with new SHA256, got %+v err=%v", ev, err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for mutated pixel frame_ready")
	}

	unsubscribe := ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"frame_unsubscribe","params":{"surface_id":"` + id + `"}}`)}
	if events, e := r.Handler(ctx, unsubscribe); e != nil || len(events) != 0 {
		t.Fatalf("unsubscribe: %s %v", events, e)
	}
}
