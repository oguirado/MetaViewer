package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

func TestV027CreationFailureKeepsCommittedIdentity(t *testing.T) {
	root, err := os.MkdirTemp("/dev/shm", "mv-v027-failure-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	r := &initialRunner{refuseStop: true}
	m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1}}, MaxSurfaces: 1, MaxOutputBytes: 8192, Timeout: time.Second, OriginNS: 100}, r, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	p, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 8192, MaxPixels: 2, MaxSurfaces: 1})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.Close() })
	h, err := NewHandler(m, p)
	if err != nil {
		t.Fatal(err)
	}
	q := capsule.Request{Schema: "surface_request/v0.2", Op: "create", Params: json.RawMessage(`{"profile_id":"demo"}`)}
	body := json.RawMessage(`{"schema":"surface_request/v0.2","op":"create","params":{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}}`)
	_, failure := h(context.Background(), ipc.Envelope{Body: body})
	var creation *CreationError
	if !errors.As(failure, &creation) || creation.Rollback == nil {
		t.Fatalf("expected failed rollback: %v", failure)
	}
	out, err := wireFailure(ipc.Envelope{MsgID: "create-message"}, q, failure)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out[0]), `"surface_id":"`+creation.SurfaceID+`"`) {
		t.Fatalf("committed identity lost: %s", out)
	}
}

type v027BlockedReplyPolicy struct {
	lifecyclePolicy
	entered chan struct{}
	release chan struct{}
}

func (p *v027BlockedReplyPolicy) Wrap(ctx context.Context, e ipc.Envelope, body json.RawMessage) (ipc.Envelope, error) {
	if strings.Contains(string(body), `"event":"blocked_reply"`) {
		close(p.entered)
		select {
		case <-p.release:
		case <-ctx.Done():
		}
	}
	return p.lifecyclePolicy.Wrap(ctx, e, body)
}

func TestV027ReplyBackpressureReleasesSurfaceCaptureLock(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(dir, "core.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	cfg := ipc.Config{SocketPath: sock, UID: uint32(os.Getuid()), MaxFrameBytes: 8192, MaxDepth: 32, MaxStringBytes: 4096, MaxKeys: 128, MaxArrayItems: 128, MaxReplayEntries: 128, MaxConnections: 1, HelloTimeout: time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: time.Second, ProbeTimeout: time.Second, ShutdownTimeout: time.Second}
	reg := ipc.Envelope{Schema: "envelope/v0.2", MsgID: "reg", From: ipc.Endpoint{Component: "core", Instance: "core-1"}, To: ipc.Endpoint{Component: "daemon", Instance: "daemon-1"}, SessionID: "s-1", Seq: 1, Nonce: "n-1", Body: json.RawMessage(`{"schema":"hello/v0.2","component":"daemon"}`)}
	policy := &v027BlockedReplyPolicy{entered: make(chan struct{}), release: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	locks := make(chan *sync.Mutex, 1)
	go func() {
		done <- connectStreaming(ctx, cfg, policy, reg, func(c context.Context, e ipc.Envelope) ([]json.RawMessage, error) {
			if e.MsgID == "reg" {
				return nil, nil
			}
			lock := c.Value(streamKey{}).(streamSession).surfaceLock("surface-a")
			if lock.TryLock() {
				lock.Unlock()
				return nil, errors.New("handler was not protected by surface lock")
			}
			locks <- lock
			return []json.RawMessage{json.RawMessage(`{"schema":"surface_event/v0.2","event":"blocked_reply","data":{}}`)}, nil
		})
	}()
	defer func() { close(policy.release); cancel(); <-done }()
	conn, err := listener.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	framer, err := ipc.NewFramer(conn, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = framer.Read(ctx); err != nil {
		t.Fatal(err)
	}
	in := reg
	in.MsgID = "input-a"
	in.Seq = 2
	in.Nonce = "n-2"
	in.Body = json.RawMessage(`{"schema":"surface_request/v0.2","op":"input","params":{"surface_id":"surface-a"}}`)
	raw, _ := json.Marshal(in)
	if err = framer.Write(ctx, raw); err != nil {
		t.Fatal(err)
	}
	select {
	case <-policy.entered:
	case <-time.After(time.Second):
		t.Fatal("reply serialization never started")
	}
	lock := <-locks
	if !lock.TryLock() {
		t.Fatal("completed handler retains capture lock during blocked reply")
	}
	lock.Unlock()
}

func TestV027HoldingsObservationsSurviveBaselineEviction(t *testing.T) {
	_, runner, m, pub, h, id := setupHoldingsWireFixture(t)
	runner.observeRaw = []byte(`{"state_sha256":"` + strings.Repeat("3c", 32) + `","tick":19,"revision":4,"frame_state_sha256":"` + strings.Repeat("7f", 32) + `","elements":[{"id":"turn"}]}`)
	input := func(proposal string) []json.RawMessage {
		body, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": "input", "params": map[string]any{"surface_id": id, "proposal_id": proposal, "origin": "agent", "action": map[string]any{"type": "click", "x": 1, "y": 0, "button": "left"}}})
		out, err := h(context.Background(), ipc.Envelope{Body: body})
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	first := input("holdings-first")
	if len(first) != 5 {
		t.Fatalf("initial semantic input failed: %s", first)
	}
	var old struct {
		Data struct {
			Ref frames.Ref `json:"frame_ref"`
		}
	}
	if err := json.Unmarshal(first[2], &old); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		b, f, err := m.Capture(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = pub.PublishForced(id, b, f); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(old.Data.Ref.RAMWSPath); !os.IsNotExist(err) {
		t.Fatal("old handler baseline was not evicted")
	}
	second := input("holdings-second")
	if len(second) != 5 {
		t.Fatalf("fresh semantic observations lost after baseline eviction: %s", second)
	}
	var observation struct {
		Ref frames.Ref `json:"frame_ref"`
	}
	if err := json.Unmarshal(second[1], &observation); err != nil {
		t.Fatal(err)
	}
	if observation.Ref.Generation <= old.Data.Ref.Generation {
		t.Fatal("observation reused the evicted baseline")
	}
	if _, err := os.Stat(observation.Ref.RAMWSPath); err != nil {
		t.Fatal(err)
	}
}
