package daemon

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

func TestEnvironmentFailsClosed(t *testing.T) {
	t.Setenv("MV_SRF_BIN_DIR", "")
	_, err := RuntimeFromEnv()
	var fault *cli.Fault
	if !errors.As(err, &fault) || fault.Code != "configuration" {
		t.Fatalf("missing configuration: %v", err)
	}
}
func TestClientReplayPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "replay")
	a, err := newClientAuthority(path, monotonic())
	if err != nil {
		t.Fatal(err)
	}
	key := ipc.SenderKey{SessionID: "session", Component: "core", Instance: "core"}
	if err = a.Reserve(context.Background(), key, 1, "nonce"); err != nil {
		t.Fatal(err)
	}
	if _, err = newClientAuthority(path, monotonic()); err == nil {
		t.Fatal("concurrent writer accepted")
	}
	_ = a.file.Close()
	a, err = newClientAuthority(path, monotonic())
	if err != nil {
		t.Fatal(err)
	}
	if err = a.Reserve(context.Background(), key, 1, "nonce"); err == nil {
		t.Fatal("restart replay accepted")
	}
	if err = a.Reserve(context.Background(), key, 2, "nonce"); err == nil {
		t.Fatal("nonce replay accepted")
	}
	_ = a.file.Close()
	if err = os.WriteFile(path, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = newClientAuthority(path, monotonic()); err == nil {
		t.Fatal("corrupt ledger accepted")
	}
}

func fakeNative(t *testing.T) (string, string) {
	t.Helper()
	root, err := os.MkdirTemp("/dev/shm", "mv-wire-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	source := filepath.Join(root, "demo-run", "frames", "w1")
	if err = os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	img := image.NewNRGBA(image.Rect(0, 0, 2, 1))
	img.Set(0, 0, color.NRGBA{R: 255, A: 255})
	img.Set(1, 0, color.NRGBA{G: 255, A: 255})
	f, err := os.OpenFile(filepath.Join(source, "f.png"), os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if err = png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	digest := sha256.Sum256([]byte{255, 0, 0, 0, 255, 0})
	bin := t.TempDir()
	script := fmt.Sprintf(`#!/usr/bin/python3
import json,sys,time
op=sys.argv[1]
if op=='start':
 print(json.dumps({'container':'srf-id-demo','run_id':'demo-run','windows':[{'id':'w1','x':0,'y':0,'w':2,'h':1,'title':'fake','url':''}]}))
elif op=='frame':
 print(json.dumps({'path':%q,'seq':time.monotonic_ns(),'sha256_rgb24':%q,'width':2,'height':1,'capture_mono_ns':time.monotonic_ns(),'generation':'srf-id-demo','window':{'id':'w1','x':0,'y':0,'w':2,'h':1,'title':'fake','url':''}}))
elif op=='input':
 print(json.dumps({'surface_id':'w1','kind':'key','input_mono_ns':time.monotonic_ns(),'focus_verified':True,'result':'ok'}))
elif op=='stop':
 print(json.dumps({'stopped':'srf-id-demo','removed_verified':True}))
else: sys.exit(2)
`, filepath.Join(source, "f.png"), hex.EncodeToString(digest[:]))
	if err = os.WriteFile(filepath.Join(bin, "srf-identity-surface"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	return bin, root
}

// The live-tag test shares this exact compiled-binary oracle, replacing only
// the fake CLI/profile allocation with the operator's admitted live capsule.
func binaryOracle(t *testing.T, live bool, negative string) {
	t.Helper()
	repo, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(t.TempDir(), "mv-daemon-adapter")
	build := exec.Command("/usr/local/go/bin/go", "build", "-o", binary, "./cmd/mv-daemon-adapter")
	build.Dir = filepath.Join(repo, "daemon-adapter")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	bin, root, profile := os.Getenv("MV_SRF_BIN_DIR"), os.Getenv("MV_SRF_LIVE_RAM_ROOT"), os.Getenv("MV_SRF_LIVE_PROFILE")
	width, height := 1280, 900
	if !live {
		bin, root = fakeNative(t)
		profile = "demo"
		width, height = 2, 1
	} else if profile != "mv-live-1" {
		t.Fatal("MV_SRF_LIVE_PROFILE must explicitly select mv-live-1")
	}
	runtimeDir := t.TempDir()
	if err = os.Mkdir(filepath.Join(runtimeDir, "metaviewer"), 0700); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(runtimeDir, "metaviewer", "core.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	_ = listener.SetDeadline(time.Now().Add(10 * time.Second))
	state := t.TempDir()
	if err = os.Chmod(state, 0700); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	cmd := exec.Command(binary)
	cmd.Dir = repo
	cmd.Stdout = &output
	cmd.Stderr = &output
	env := map[string]string{}
	for _, v := range os.Environ() {
		k, val, _ := strings.Cut(v, "=")
		env[k] = val
	}
	for k, v := range map[string]string{"MV_SESSION_ID": "wire-test", "MV_CORE_INSTANCE": "core-test", "MV_DAEMON_INSTANCE": "daemon-test", "MV_SRF_BIN_DIR": bin, "MV_SRF_STATE_DIR": state, "MV_SRF_PROFILES": "", "MV_SRF_LIVE_RAM_ROOT": root, "MV_SRF_LIVE_PROFILE": profile, "XDG_RUNTIME_DIR": runtimeDir, "MV_CONTRACT_DIR": filepath.Join(repo, "contracts/v0.2"), "MV_COMPONENT_COMMIT": "f8f9294fc70a423164d63f2cf6e5de65ec6f6516"} {
		env[k] = v
	}
	if !live {
		profiles, _ := json.Marshal(map[string]any{profile: map[string]any{"Kind": "browser", "NativeKind": "browser", "RAMRoot": root, "Display": ":100", "Width": width, "Height": height}})
		env["MV_SRF_PROFILES"] = string(profiles)
		env["SRF_IDENTITY_STORE_ROOT"] = root
		env["SRF_PROXY_REGISTRY"] = filepath.Join(root, "proxies.json")
	}
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	waited := false
	defer func() {
		if !waited {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	}()
	conn, err := listener.AcceptUnix()
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		waited = true
		t.Fatalf("accept: %v; binary: %s", err, output.String())
	}
	defer conn.Close()
	cfg := ipc.Config{SocketPath: socket, UID: uint32(os.Getuid()), MaxFrameBytes: 1 << 20, MaxDepth: 32, MaxStringBytes: 65536, MaxKeys: 256, MaxArrayItems: 4096, MaxReplayEntries: 100000, MaxConnections: 1, HelloTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, ProbeTimeout: time.Second, ShutdownTimeout: time.Second}
	f, err := ipc.NewFramer(conn, cfg)
	if err != nil {
		t.Fatal(err)
	}
	validator, err := ipc.NewPolicy(cfg, os.DirFS(filepath.Join(repo, "contracts/v0.2")), &lifecyclePolicy{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	seq := uint64(0)
	outSeq := uint64(0)
	send := func(body any) {
		t.Helper()
		seq++
		raw, _ := json.Marshal(body)
		e := ipc.Envelope{Schema: "envelope/v0.2", MsgID: fmt.Sprintf("core-%d", seq), From: ipc.Endpoint{Component: "core", Instance: "core-test"}, To: ipc.Endpoint{Component: "daemon", Instance: "daemon-test"}, SessionID: "wire-test", Seq: seq, Nonce: fmt.Sprintf("core-%d", seq), Body: raw}
		if negative == "sender" && seq > 1 {
			e.From.Instance = "foreign"
		}
		data, _ := json.Marshal(e)
		if err = f.Write(ctx, data); err != nil {
			t.Fatal(err)
		}
	}
	read := func() json.RawMessage {
		t.Helper()
		raw, err := f.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		e, err := validator.ValidateEnvelope(raw)
		if err != nil {
			t.Fatalf("outbound contract: %v", err)
		}
		outSeq++
		if e.Seq != outSeq || e.From.Component != "daemon" || e.To.Component != "core" {
			t.Fatal("wrong outbound authority")
		}
		return e.Body
	}
	hello := map[string]any{"schema": "hello/v0.2", "contract_version": "v0.2", "component": "core", "component_version": "0.1.1", "component_commit": "f8f9294fc70a423164d63f2cf6e5de65ec6f6516", "dependencies": []any{}}
	if negative == "hello" {
		hello["component"] = "ui"
	}
	var handshake struct{ Component string }
	_ = json.Unmarshal(read(), &handshake)
	if handshake.Component != "daemon" {
		t.Fatal("daemon hello missing")
	}
	if negative != "no-hello" {
		send(hello)
	}
	if negative == "hello" {
		if _, err = f.Read(ctx); err == nil {
			t.Fatal("wrong hello component accepted")
		}
		return
	}
	request := func(op string, params any) {
		send(map[string]any{"schema": "surface_request/v0.2", "op": op, "params": params})
	}
	if negative == "sender" {
		request("list", map[string]any{})
		if _, err = f.Read(ctx); err == nil {
			t.Fatal("foreign sender accepted")
		}
		return
	}
	request("create", map[string]any{"kind": "browser", "profile_id": "unadmitted", "geometry": map[string]int{"w": width, "h": height}})
	var event struct {
		Event string
		Data  struct {
			Surface struct {
				SurfaceID string `json:"surface_id"`
				State     string `json:"state"`
			}
			FrameRef frames.Ref `json:"frame_ref"`
		}
	}
	_ = json.Unmarshal(read(), &event)
	if event.Event != "error" {
		t.Fatal("unadmitted profile accepted")
	}
	request("create", map[string]any{"kind": "browser", "profile_id": profile, "geometry": map[string]int{"w": width, "h": height}})
	_ = json.Unmarshal(read(), &event)
	if event.Event != "created" {
		t.Fatalf("create returned %+v", event)
	}
	id := event.Data.Surface.SurfaceID
	// Ensure even a failed assertion after creation requests verified native stop.
	destroyed := false
	defer func() {
		if !destroyed {
			request("destroy", map[string]string{"surface_id": id})
			_ = read()
		}
	}()
	_ = json.Unmarshal(read(), &event)
	if event.Event != "frame_ready" {
		t.Fatalf("initial frame: %s", event.Event)
	}
	pixels, err := os.ReadFile(event.Data.FrameRef.RAMWSPath)
	if err != nil || len(pixels) == 0 {
		t.Fatalf("published pixels absent: %v", err)
	}
	request("input", map[string]any{"surface_id": id, "proposal_id": "wire-input", "action": map[string]any{"type": "key", "keys": []string{"Escape"}}})
	_ = json.Unmarshal(read(), &event)
	if event.Event != "input_applied" {
		t.Fatalf("input: %s", event.Event)
	}
	_ = json.Unmarshal(read(), &event)
	if event.Event != "frame_ready" {
		t.Fatalf("post-input frame: %s", event.Event)
	}
	var receipt struct {
		Schema     string
		ProposalID string `json:"proposal_id"`
		Verified   bool
	}
	_ = json.Unmarshal(read(), &receipt)
	if receipt.Schema != "action_receipt/v0.2" || receipt.ProposalID != "wire-input" || receipt.Verified {
		t.Fatal("receipt correlation or verification claim invalid")
	}
	request("destroy", map[string]string{"surface_id": id})
	_ = json.Unmarshal(read(), &event)
	if event.Event != "state_changed" || event.Data.Surface.State != "destroyed" {
		t.Fatalf("destroy: %s", event.Event)
	}
	destroyed = true
	_ = cmd.Process.Signal(syscall.SIGTERM)
	err = cmd.Wait()
	waited = true
	if err != nil {
		t.Fatalf("shutdown: %v %s", err, output.String())
	}
}
func TestBinaryCoreLifecycle(t *testing.T)            { binaryOracle(t, false, "") }
func TestBinaryCoreRefusesForeignHello(t *testing.T)  { binaryOracle(t, false, "hello") }
func TestBinaryCoreRefusesChangedSender(t *testing.T) { binaryOracle(t, false, "sender") }

func TestBinaryCoreWithoutHelloReply(t *testing.T) { binaryOracle(t, false, "no-hello") }
func TestProfileJSONClosed(t *testing.T) {
	var profiles map[string]capsule.Profile
	if err := decodeProfiles("{\n  \"demo\":{\"Kind\":\"browser\"}\n}", &profiles); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{`{"demo":{"Unknown":true}}`, `{"demo":{},"demo":{}}`, `{} {}`} {
		if err := decodeProfiles(raw, &profiles); err == nil {
			t.Fatalf("unclosed profile JSON accepted: %s", raw)
		}
	}
}
