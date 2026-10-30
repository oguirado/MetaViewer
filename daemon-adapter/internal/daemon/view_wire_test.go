package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
	"metaviewer/daemon-adapter/internal/ipc"
	"metaviewer/daemon-adapter/internal/view"
)

// The frozen surface_request union does not admit operator-view operations.
// Mutation: let policy.ValidateEnvelope accept unknown op values; refusals fail.
// This is an admission-boundary test, not proof of a configured view route.
func TestViewWireContractBoundary(t *testing.T) {
	nvEnvironment(t)
	r, err := RuntimeFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	e := r.Registration
	e.From, e.To = e.To, e.From
	validate := func(op string, params any) error {
		body, err := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": op, "params": params})
		if err != nil {
			t.Fatal(err)
		}
		e.Body = body
		raw, err := json.Marshal(e)
		if err != nil {
			t.Fatal(err)
		}
		_, err = r.Policy.ValidateEnvelope(raw)
		return err
	}
	if err := validate("list", map[string]any{}); err != nil {
		t.Fatalf("admitted list refused: %v", err)
	}
	for _, op := range []string{"view", "view-stop", "login", "screenshot"} {
		if err := validate(op, map[string]string{"surface_id": "srf-id-demo"}); err == nil {
			t.Fatalf("uncontracted %s reached wire authority", op)
		}
	}
}

// Mutation 1: drop View backend wiring in RuntimeFromEnv/helloState or remove
// the view/login/view-stop branch in internal/capsule/manager.go; wired view
// operations no longer execute the native CLI and return state_changed events.
// Mutation 2: skip parseInfo validation in internal/view/view.go Open; a
// malformed native view announcement is published instead of closed.
func TestViewWireRuntimeHandlerAndEnvironmentBridge(t *testing.T) {
	nvEnvironment(t)
	bin := os.Getenv("MV_SRF_BIN_DIR")
	callLog := filepath.Join(t.TempDir(), "cli.log")
	sockPath := filepath.Join(t.TempDir(), "view.sock")
	cliPath := filepath.Join(bin, "srf-identity-surface")
	orig, err := os.ReadFile(cliPath)
	if err != nil {
		t.Fatal(err)
	}
	viewScript := fmt.Sprintf(`elif op in ('view','login'):
 import signal
 open(%q,'a').write(' '.join(sys.argv[1:])+'\n')
 container=sys.argv[sys.argv.index('--container')+1]
 if container=='srf-id-malformed':
  print(json.dumps({'url':'http://example.test/','native':'xpra','socket':%q}),flush=True)
 else:
  print(json.dumps({'url':'http://127.0.0.1:4100/','native':'xpra','socket':%q}),flush=True)
 signal.pause()
elif op=='view-stop':
 open(%q,'a').write(' '.join(sys.argv[1:])+'\n')
 container=sys.argv[sys.argv.index('--container')+1]
 print(json.dumps({'stopped_view':container,'pid':42,'seconds':0.1}))
else: sys.exit(2)
`, callLog, sockPath, sockPath, callLog)
	instrumented := strings.Replace(
		string(orig),
		"op=sys.argv[1]\n",
		fmt.Sprintf("op=sys.argv[1]\nif op not in ('view','login','view-stop'):\n open(%q,'a').write(' '.join(sys.argv[1:])+'\\n')\n", callLog),
		1,
	)
	instrumented = strings.Replace(instrumented, "else: sys.exit(2)\n", viewScript, 1)
	if err := os.WriteFile(cliPath, []byte(instrumented), 0700); err != nil {
		t.Fatal(err)
	}

	// Negative control: unconfigured Manager (View == nil) refuses view/login/view-stop
	// with typed unsupported code and zero native CLI executions.
	unconfRunner := &initialRunner{}
	unconfProfiles := map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: "/dev/shm", Display: ":100", Width: 2, Height: 1}}
	unconfMgr, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: unconfProfiles, MaxSurfaces: 1, MaxOutputBytes: 4096, Timeout: time.Second, OriginNS: 100}, unconfRunner, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	unconfHandler := isolatedWireHandler(t, unconfMgr, unconfProfiles, nil, 100)
	for _, op := range []string{"view", "login", "view-stop"} {
		raw, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": op, "params": map[string]string{"surface_id": "srf-id-demo"}})
		out, err := unconfHandler(context.Background(), ipc.Envelope{MsgID: "msg-unconf-" + op, Body: raw})
		if err != nil || len(out) != 1 {
			t.Fatalf("unconfigured %s: out=%s err=%v", op, out, err)
		}
		var ev capsule.ErrorEvent
		if err := json.Unmarshal(out[0], &ev); err != nil || ev.Schema != "surface_event/v0.2" || ev.Event != "error" || ev.Data.SurfaceID != "srf-id-demo" || !strings.Contains(ev.Data.Detail, "unsupported: "+op) {
			t.Fatalf("unconfigured %s missing unsupported refusal: %s %v", op, out[0], err)
		}
	}
	if len(unconfRunner.calls) != 0 {
		t.Fatalf("unconfigured view executed runner: %v", unconfRunner.calls)
	}

	r, err := RuntimeFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx = context.WithValue(ctx, streamKey{}, streamSession{
		ctx:  ctx,
		work: &sync.Mutex{},
		emit: func(context.Context, json.RawMessage) error { return nil },
	})
	if _, err := r.Handler(ctx, ipc.Envelope{Body: json.RawMessage(`{"schema":"hello/v0.2"}`)}); err != nil {
		t.Fatal(err)
	}
	createOut, err := r.Handler(ctx, ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"create","params":{"kind":"browser","profile_id":"demo","geometry":{"w":1280,"h":900}}}`)})
	if err != nil || len(createOut) != 2 {
		t.Fatalf("create: %s %v", createOut, err)
	}
	var created struct {
		Data struct {
			Surface capsule.Surface `json:"surface"`
		} `json:"data"`
	}
	if err := json.Unmarshal(createOut[0], &created); err != nil || created.Data.Surface.SurfaceID == "" {
		t.Fatalf("unmarshal created: %s %v", createOut[0], err)
	}
	surfaceID := created.Data.Surface.SurfaceID

	countLines := func() int {
		data, err := os.ReadFile(callLog)
		if os.IsNotExist(err) {
			return 0
		}
		if err != nil {
			t.Fatal(err)
		}
		trimmed := strings.TrimSpace(string(data))
		if trimmed == "" {
			return 0
		}
		return len(strings.Split(trimmed, "\n"))
	}
	beforeCalls := countLines()
	if beforeCalls != 2 {
		t.Fatalf("expected start+frame calls (2), got %d", beforeCalls)
	}

	// Positive wired path: view -> view-stop via container ID, and login -> view-stop via surfaceID.
	for _, step := range []struct {
		op string
		id string
	}{
		{op: "view", id: "srf-id-demo"},
		{op: "view-stop", id: "srf-id-demo"},
		{op: "login", id: surfaceID},
		{op: "view-stop", id: surfaceID},
	} {
		raw, err := json.Marshal(map[string]any{
			"schema": "surface_request/v0.2",
			"op":     step.op,
			"params": map[string]string{"surface_id": step.id},
		})
		if err != nil {
			t.Fatal(err)
		}
		out, err := r.Handler(ctx, ipc.Envelope{MsgID: "msg-" + step.op, Body: raw})
		if err != nil || len(out) != 1 {
			t.Fatalf("wired op=%s id=%s: out=%s err=%v", step.op, step.id, out, err)
		}
		var ev struct {
			Schema string `json:"schema"`
			Event  string `json:"event"`
			Data   struct {
				Surface capsule.Surface `json:"surface"`
			} `json:"data"`
		}
		if err := json.Unmarshal(out[0], &ev); err != nil || ev.Schema != "surface_event/v0.2" || ev.Event != "state_changed" || ev.Data.Surface.SurfaceID != surfaceID {
			t.Fatalf("wired op=%s id=%s unexpected event: %s %v", step.op, step.id, out[0], err)
		}
	}
	afterWiredCalls := countLines()
	if afterWiredCalls != beforeCalls+4 {
		t.Fatalf("expected 4 wired view CLI calls, got %d (total %d)", afterWiredCalls-beforeCalls, afterWiredCalls)
	}

	// Negative wired controls: invalid identity "../foreign", unadmitted container, and unknown_op "screenshot"
	// must refuse without executing the native CLI.
	for _, tc := range []struct {
		id         string
		op         string
		wantDetail string
	}{
		{id: "../foreign", op: "view", wantDetail: "usage: invalid identity capsule"},
		{id: "../foreign", op: "view-stop", wantDetail: "usage: invalid identity capsule"},
		{id: "../foreign", op: "login", wantDetail: "usage: invalid identity capsule"},
		{id: "srf-id-unadmitted", op: "view", wantDetail: "surface: active surface required"},
		{id: "srf-id-demo", op: "screenshot", wantDetail: "unknown_op"},
	} {
		raw, _ := json.Marshal(map[string]any{
			"schema": "surface_request/v0.2",
			"op":     tc.op,
			"params": map[string]string{"surface_id": tc.id},
		})
		out, err := r.Handler(ctx, ipc.Envelope{MsgID: "msg-neg-" + tc.op, Body: raw})
		if err != nil || len(out) != 1 {
			t.Fatalf("op=%s id=%s: out=%s err=%v", tc.op, tc.id, out, err)
		}
		var ev capsule.ErrorEvent
		if err := json.Unmarshal(out[0], &ev); err != nil || ev.Schema != "surface_event/v0.2" || ev.Event != "error" || ev.Data.SurfaceID != tc.id || !strings.Contains(ev.Data.Detail, tc.wantDetail) {
			t.Fatalf("op=%s id=%s missing %q error: %s %v", tc.op, tc.id, tc.wantDetail, out[0], err)
		}
	}
	if got := countLines(); got != afterWiredCalls {
		t.Fatalf("negative view/screenshot refusals executed native CLI: before=%d after=%d", afterWiredCalls, got)
	}

	listed, err := r.Handler(ctx, ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"list","params":{}}`)})
	if err != nil || len(listed) != 1 {
		t.Fatalf("active surface disturbed after view operations: %s %v", listed, err)
	}

	vm, err := view.NewFromEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	defer vm.Close()
	for _, badID := range []string{"", "../foreign", "srf-holdings-demo"} {
		var fault *cli.Fault
		if err := vm.Open(ctx, badID, false); !errors.As(err, &fault) || fault.Code != "usage" {
			t.Fatalf("invalid identity %q open: %v", badID, err)
		}
		if err := vm.Stop(ctx, badID); !errors.As(err, &fault) || fault.Code != "usage" {
			t.Fatalf("invalid identity %q stop: %v", badID, err)
		}
	}
	if got := countLines(); got != afterWiredCalls {
		t.Fatalf("invalid identity executed native CLI: before=%d after=%d", afterWiredCalls, got)
	}

	var fault *cli.Fault
	if err := vm.Open(ctx, "srf-id-malformed", false); !errors.As(err, &fault) || fault.Code != "malformed_cli" {
		t.Fatalf("malformed view announcement accepted: %v", err)
	}
	if _, ok := vm.Info("srf-id-malformed"); ok {
		t.Fatal("malformed view reply published Info")
	}

	if err := vm.Open(ctx, "srf-id-demo", false); err != nil {
		t.Fatal(err)
	}
	info, ok := vm.Info("srf-id-demo")
	if !ok || info.URL != "http://127.0.0.1:4100/" || info.Socket != sockPath {
		t.Fatalf("unexpected view info: %+v ok=%v", info, ok)
	}
	if err := vm.Stop(ctx, "srf-id-demo"); err != nil {
		t.Fatal(err)
	}
	if _, ok := vm.Info("srf-id-demo"); ok {
		t.Fatal("stopped view still published")
	}
}
