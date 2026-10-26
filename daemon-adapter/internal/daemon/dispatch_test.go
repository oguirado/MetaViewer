package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

// Test-only authority; no claim of production durable replay or schema admission.
type lifecyclePolicy struct {
	mu   sync.Mutex
	seen map[string]bool
	seq  uint64
}

func (*lifecyclePolicy) ValidateEnvelope(raw []byte) (ipc.Envelope, error) {
	var e ipc.Envelope
	err := json.Unmarshal(raw, &e)
	return e, err
}
func (*lifecyclePolicy) Authenticate(context.Context, ipc.PeerCredentials, ipc.Envelope) error {
	return nil
}
func (p *lifecyclePolicy) Reserve(_ context.Context, k ipc.SenderKey, seq uint64, nonce string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	key := fmt.Sprintf("%q/%q/%q/%d/%q", k.SessionID, k.Component, k.Instance, seq, nonce)
	if p.seen == nil {
		p.seen = map[string]bool{}
	}
	if p.seen[key] {
		return errors.New("duplicate")
	}
	p.seen[key] = true
	return nil
}
func (p *lifecyclePolicy) Wrap(_ context.Context, e ipc.Envelope, body json.RawMessage) (ipc.Envelope, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.seq++
	e.Seq = p.seq
	e.Nonce = fmt.Sprint("reply-", p.seq)
	e.From, e.To = e.To, e.From
	e.Body = body
	return e, nil
}

// The same oracle runs against real and deliberately disconnected dispatch.
// Broken wiring must make this oracle fail, never manufacture an error event pass.
func lifecycleOracle(t *testing.T, broken bool) error {
	t.Helper()
	root, err := os.MkdirTemp("/dev/shm", "mv-dispatch-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(root)
	source := filepath.Join(root, "demo-run/frames/w1")
	if err = os.MkdirAll(source, 0700); err != nil {
		return err
	}
	img := image.NewNRGBA(image.Rect(0, 0, 2, 1))
	img.Set(0, 0, color.NRGBA{R: 255, A: 255})
	img.Set(1, 0, color.NRGBA{G: 255, A: 255})
	file, err := os.OpenFile(filepath.Join(source, "f.png"), os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	err = png.Encode(file, img)
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	bin, err := filepath.Abs("../capsule/testdata")
	if err != nil {
		return err
	}
	runner, err := capsule.NewProcessRunner(bin, []string{"PATH=/usr/bin:/bin", "SRF_IDENTITY_STORE_ROOT=" + root, "MV_SRF_STATE_DIR=" + filepath.Join(root, "state")}, 8192, time.Second)
	if err != nil {
		return err
	}
	manager, err := capsule.NewManager(capsule.Config{BinDir: bin, Profiles: map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1}}, MaxSurfaces: 1, MaxOutputBytes: 8192, Timeout: time.Second, OriginNS: 100}, runner, func() uint64 { return 200 })
	if err != nil {
		return err
	}
	pub, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 8192, MaxPixels: 2, MaxSurfaces: 1})
	if err != nil {
		return err
	}
	defer func() {
		if err := pub.Close(); err != nil {
			t.Error(err)
		}
	}()
	handler, err := NewHandler(manager, pub)
	if err != nil {
		return err
	}
	if broken {
		handler = func(context.Context, ipc.Envelope) ([]json.RawMessage, error) {
			return nil, errors.New("dispatch disconnected")
		}
	}
	socketDir := t.TempDir()
	if err := os.Chmod(socketDir, 0700); err != nil {
		return err
	}
	cfg := ipc.Config{SocketPath: filepath.Join(socketDir, "s.sock"), UID: uint32(os.Getuid()), MaxFrameBytes: 8192, MaxDepth: 32, MaxStringBytes: 4096, MaxKeys: 128, MaxArrayItems: 128, MaxReplayEntries: 32, MaxConnections: 1, HelloTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: time.Second, ProbeTimeout: time.Second, ShutdownTimeout: time.Second}
	listener, err := ipc.Listen(context.Background(), cfg)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- ipc.Serve(ctx, listener, cfg, &lifecyclePolicy{}, handler, io.Discard) }()
	defer func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(2 * time.Second):
			t.Error("daemon did not join")
		}
	}()
	conn, err := net.Dial("unix", cfg.SocketPath)
	if err != nil {
		return err
	}
	defer conn.Close()
	wire, err := ipc.NewFramer(conn, cfg)
	if err != nil {
		return err
	}
	var seq, replySeq uint64
	send := func(body any) error {
		seq++
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		envelope := ipc.Envelope{Schema: "envelope/v0.2", SessionID: "test-session", Seq: seq, Nonce: fmt.Sprint("request-", seq), From: ipc.Endpoint{Component: "core", Instance: "core-test"}, To: ipc.Endpoint{Component: "daemon", Instance: "daemon-test"}, Body: raw}
		raw, err = json.Marshal(envelope)
		if err != nil {
			return err
		}
		return wire.Write(ctx, raw)
	}
	events := []string{}
	read := func() (json.RawMessage, error) {
		wait, stop := context.WithTimeout(ctx, 2*time.Second)
		defer stop()
		raw, err := wire.Read(wait)
		if err != nil {
			return nil, fmt.Errorf("dispatch reply: %w", err)
		}
		var e ipc.Envelope
		if err = json.Unmarshal(raw, &e); err != nil {
			return nil, err
		}
		replySeq++
		if e.Seq != replySeq || e.From.Component != "daemon" || e.To.Component != "core" || e.Schema != "envelope/v0.2" {
			return nil, errors.New("outbound envelope mismatch")
		}
		var ev struct{ Schema, Event string }
		if err = json.Unmarshal(e.Body, &ev); err != nil {
			return nil, err
		}
		if ev.Schema != "surface_event/v0.2" {
			return nil, errors.New("event schema mismatch")
		}
		events = append(events, ev.Event)
		return e.Body, nil
	}
	if err = send(map[string]string{"schema": "hello/v0.2"}); err != nil {
		return fmt.Errorf("dispatch hello: %w", err)
	}
	request := func(op string, params any) error {
		return send(struct {
			Schema, Op string
			Params     any
		}{"surface_request/v0.2", op, params})
	}
	if err = request("create", map[string]any{"kind": "browser", "profile_id": "demo", "geometry": map[string]int{"w": 2, "h": 1}}); err != nil {
		return fmt.Errorf("dispatch create: %w", err)
	}
	raw, err := read()
	if err != nil {
		return err
	}
	var created struct {
		Data struct{ Surface capsule.Surface }
	}
	if err = json.Unmarshal(raw, &created); err != nil {
		return err
	}
	id := created.Data.Surface.SurfaceID
	if id == "" || created.Data.Surface.State != "active" {
		return errors.New("created identity/state missing")
	}
	raw, err = read()
	if err != nil {
		return err
	}
	var ready struct {
		Data struct {
			FrameRef frames.Ref `json:"frame_ref"`
		}
	}
	if err = json.Unmarshal(raw, &ready); err != nil {
		return err
	}
	ref := ready.Data.FrameRef
	pixels, err := os.ReadFile(ref.RAMWSPath)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(pixels)
	if !reflect.DeepEqual(pixels, []byte{255, 0, 0, 0, 255, 0}) || ref.SHA256 != hex.EncodeToString(sum[:]) || ref.SurfaceID != id || ref.Schema != "frame_ref/v0.2" || ref.Generation != 1 || ref.Tick != 1 || ref.TsNS != 100 {
		return errors.New("published frame identity/pixels mismatch")
	}
	if err = request("input", map[string]any{"surface_id": id, "proposal_id": "proposal-1", "action": map[string]any{"type": "click", "x": 1, "y": 0, "button": "left"}}); err != nil {
		return err
	}
	raw, err = read()
	if err != nil {
		return err
	}
	var applied struct {
		Data struct {
			SurfaceID  string `json:"surface_id"`
			ProposalID string `json:"proposal_id"`
		}
	}
	if err = json.Unmarshal(raw, &applied); err != nil {
		return err
	}
	if applied.Data.SurfaceID != id || applied.Data.ProposalID != "proposal-1" {
		return errors.New("input receipt correlation mismatch")
	}
	if err = request("destroy", map[string]string{"surface_id": id}); err != nil {
		return err
	}
	raw, err = read()
	if err != nil {
		return err
	}
	if err = json.Unmarshal(raw, &created); err != nil {
		return err
	}
	if created.Data.Surface.SurfaceID != id || created.Data.Surface.State != "destroyed" {
		return errors.New("destroy state mismatch")
	}
	if !reflect.DeepEqual(events, []string{"created", "frame_ready", "input_applied", "state_changed"}) {
		return fmt.Errorf("surface_event sequence: %v", events)
	}
	return nil
}
func TestConfiguredDaemonLifecycle(t *testing.T) {
	if err := lifecycleOracle(t, false); err != nil {
		t.Fatal(err)
	}
}
func TestConfiguredDaemonBrokenDispatchControl(t *testing.T) {
	if err := lifecycleOracle(t, true); err == nil || !strings.HasPrefix(err.Error(), "dispatch ") {
		t.Fatalf("expected dispatch failure from broken wiring, got %v", err)
	}
}
func TestNewHandlerRequiresConfiguration(t *testing.T) {
	if _, err := NewHandler(nil, nil); err == nil {
		t.Fatal("missing dependencies accepted")
	}
}
