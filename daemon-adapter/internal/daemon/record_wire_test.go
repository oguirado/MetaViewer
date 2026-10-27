package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	"metaviewer/daemon-adapter/internal/ipc"
	"metaviewer/daemon-adapter/internal/record"
)

// Mutation: remove record_start/record_stop from Manager's unsupported case;
// the unknown_op result no longer satisfies the configured refusal assertion.
// Only the unconfigured negative control is covered: no recording authority is
// injected into the current wireHandler, so this does not claim a positive route.
func TestUnconfiguredRecordWireRefusesWithoutEffects(t *testing.T) {
	runner := &initialRunner{}
	profiles := map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: "/dev/shm", Display: ":100", Width: 2, Height: 1}}
	m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: profiles, MaxSurfaces: 1, MaxOutputBytes: 4096, Timeout: time.Second, OriginNS: 100}, runner, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	h := wireHandler(m, profiles, nil, 100)
	for _, op := range []string{"record_start", "record_stop"} {
		raw, err := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": op, "params": map[string]string{"surface_id": "surface", "recording_id": "recording"}})
		if err != nil {
			t.Fatal(err)
		}
		out, err := h(context.Background(), ipc.Envelope{MsgID: "request", Body: raw})
		if err != nil || len(out) != 1 {
			t.Fatalf("refusal: %s %v", out, err)
		}
		var ev capsule.ErrorEvent
		if err := json.Unmarshal(out[0], &ev); err != nil || ev.Schema != "surface_event/v0.2" || ev.Event != "error" || ev.Data.SurfaceID != "surface" || !strings.Contains(ev.Data.Detail, "unsupported: "+op) {
			t.Fatalf("missing correlated unsupported refusal: %s %v", out, err)
		}
	}
	if len(runner.calls) != 0 {
		t.Fatalf("unconfigured recording executed: %v", runner.calls)
	}
	out, err := h(context.Background(), ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"list","params":{}}`)})
	if err != nil || len(out) != 0 {
		t.Fatalf("refusal damaged manager: %s %v", out, err)
	}
}

// Mutation 1: drop the r.Schema != "surface_request/v0.2" guard in
// internal/capsule/manager.go; record_request/v0.2 envelopes no longer return
// a correlated schema error event at the runtime handler.
// Mutation 2: bypass Destination capability/path validation in
// internal/record/record.go; disk_start without grant no longer refuses with
// typed POLICY and zero effects.
func TestRecordWireRuntimeBoundaryAndConfiguredBackend(t *testing.T) {
	nvEnvironment(t)
	bin := os.Getenv("MV_SRF_BIN_DIR")
	ramRoot := os.Getenv("MV_SRF_LIVE_RAM_ROOT")
	callLog := filepath.Join(t.TempDir(), "record-cli.log")
	cliPath := filepath.Join(bin, "srf-identity-surface")
	orig, err := os.ReadFile(cliPath)
	if err != nil {
		t.Fatal(err)
	}
	instrumented := strings.Replace(
		string(orig),
		"op=sys.argv[1]\n",
		fmt.Sprintf("op=sys.argv[1]\nopen(%q,'a').write(' '.join(sys.argv[1:])+'\\n')\n", callLog),
		1,
	)
	if err := os.WriteFile(cliPath, []byte(instrumented), 0700); err != nil {
		t.Fatal(err)
	}

	r, err := RuntimeFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()

	e := r.Registration
	e.From, e.To = e.To, e.From
	validateBody := func(body map[string]any) error {
		rawBody, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		e.Body = rawBody
		raw, err := json.Marshal(e)
		if err != nil {
			t.Fatal(err)
		}
		_, err = r.Policy.ValidateEnvelope(raw)
		return err
	}
	sampleDest := filepath.Join(t.TempDir(), "out.tar")
	for _, validBody := range []map[string]any{
		{"schema": "surface_request/v0.2", "op": "record_start", "params": map[string]any{"surface_id": "srf-1", "recording_id": "rec-1"}},
		{"schema": "surface_request/v0.2", "op": "record_stop", "params": map[string]any{"surface_id": "srf-1", "recording_id": "rec-1"}},
		{"schema": "record_request/v0.2", "request_id": "req-1", "op": "ram_start", "params": map[string]any{"surface_id": "srf-1", "recording_id": "rec-1", "ring_bytes": 4096, "max_fps": 10}},
		{"schema": "record_request/v0.2", "request_id": "req-2", "op": "ram_stop", "params": map[string]any{"surface_id": "srf-1", "recording_id": "rec-1"}},
		{"schema": "record_request/v0.2", "request_id": "req-3", "op": "disk_start", "params": map[string]any{"surface_id": "srf-1", "recording_id": "rec-2", "destination_capability_id": "cap-1", "destination_path": sampleDest, "max_fps": 10}},
		{"schema": "record_request/v0.2", "request_id": "req-4", "op": "disk_stop", "params": map[string]any{"surface_id": "srf-1", "recording_id": "rec-2"}},
		{"schema": "record_request/v0.2", "request_id": "req-5", "op": "screenshot", "params": map[string]any{"surface_id": "srf-1", "capture_id": "cap-shot"}},
	} {
		if err := validateBody(validBody); err != nil {
			t.Fatalf("contracted record envelope refused: %v (%v)", err, validBody)
		}
	}
	if err := validateBody(map[string]any{"schema": "surface_request/v0.2", "op": "screenshot", "params": map[string]any{"surface_id": "srf-1", "capture_id": "cap-shot"}}); err == nil {
		t.Fatal("uncontracted surface_request screenshot admitted by ValidateEnvelope")
	}

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

	for _, tc := range []struct {
		body       map[string]any
		wantDetail string
	}{
		{
			body:       map[string]any{"schema": "surface_request/v0.2", "op": "record_start", "params": map[string]any{"surface_id": surfaceID, "recording_id": "rec-1"}},
			wantDetail: "unsupported: record_start",
		},
		{
			body:       map[string]any{"schema": "surface_request/v0.2", "op": "record_stop", "params": map[string]any{"surface_id": surfaceID, "recording_id": "rec-1"}},
			wantDetail: "unsupported: record_stop",
		},
		{
			body:       map[string]any{"schema": "surface_request/v0.2", "op": "screenshot", "params": map[string]any{"surface_id": surfaceID, "capture_id": "shot-1"}},
			wantDetail: "unknown_op",
		},
		{
			body:       map[string]any{"schema": "record_request/v0.2", "request_id": "req-ram", "op": "ram_start", "params": map[string]any{"surface_id": surfaceID, "recording_id": "rec-1", "ring_bytes": 4096, "max_fps": 10}},
			wantDetail: "schema: unsupported request schema",
		},
	} {
		raw, err := json.Marshal(tc.body)
		if err != nil {
			t.Fatal(err)
		}
		out, err := r.Handler(ctx, ipc.Envelope{MsgID: "req-wire", Body: raw})
		if err != nil || len(out) != 1 {
			t.Fatalf("wire record op: %s %v", out, err)
		}
		var ev capsule.ErrorEvent
		if err := json.Unmarshal(out[0], &ev); err != nil || ev.Schema != "surface_event/v0.2" || ev.Event != "error" || ev.Data.SurfaceID != surfaceID || !strings.Contains(ev.Data.Detail, tc.wantDetail) {
			t.Fatalf("unexpected wire error event: got %s, want %q (%v)", out[0], tc.wantDetail, err)
		}
	}
	if got := countLines(); got != beforeCalls {
		t.Fatalf("unwired record ops executed CLI: before=%d after=%d", beforeCalls, got)
	}

	// Verify the record.Manager authority on the same tmpfs surface allocation:
	// disk without grant -> typed POLICY, 0 exec, 0 writes; ram_start ->
	// frame_captured under /dev/shm; disk_start with grant -> exact-path export;
	// screenshot -> frame_captured + stopped.
	procRunner, err := capsule.NewProcessRunner(bin, []string{
		"PATH=/usr/bin:/bin",
		"SRF_IDENTITY_STORE_ROOT=" + ramRoot,
		"MV_SRF_STATE_DIR=" + os.Getenv("MV_SRF_STATE_DIR"),
	}, 65536, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	framesRoot := filepath.Join(ramRoot, "demo-run", "frames", "w1")
	unauthTar := filepath.Join(t.TempDir(), "unauth.tar")
	authTar := filepath.Join(t.TempDir(), "authorized.tar")

	ungrantedMgr, err := record.NewManager(record.Config{
		Runner:      procRunner,
		Clock:       monotonic,
		OriginNS:    100,
		BinDir:      bin,
		Surfaces:    map[string]record.Surface{surfaceID: {Family: "srf-identity-surface", Container: "srf-id-demo", Window: "w1", FramesRoot: framesRoot}},
		Destination: nil,
		MemoryBytes: 65536,
		RingBytes:   16384,
		MaxFPS:      30,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ungrantedMgr.Close() }()

	diskDenyReq, _ := json.Marshal(map[string]any{
		"schema":     "record_request/v0.2",
		"request_id": "req-deny",
		"op":         "disk_start",
		"params": map[string]any{
			"surface_id":                surfaceID,
			"recording_id":              "rec-deny",
			"destination_capability_id": "cap-grant",
			"destination_path":          unauthTar,
			"max_fps":                   10,
		},
	})
	denyEvents, err := ungrantedMgr.Handle(ctx, diskDenyReq)
	var refusal *record.Refusal
	if !errors.As(err, &refusal) || refusal.ReasonCode != "POLICY" || len(denyEvents) != 1 || denyEvents[0].Event != "refused" || denyEvents[0].ReasonCode != "POLICY" {
		t.Fatalf("disk_start without grant must refuse with POLICY: events=%+v err=%v", denyEvents, err)
	}
	if got := countLines(); got != beforeCalls {
		t.Fatalf("disk_start without grant executed CLI: before=%d after=%d", beforeCalls, got)
	}
	if _, err := os.Stat(unauthTar); !os.IsNotExist(err) {
		t.Fatalf("disk_start without grant wrote destination: %v", err)
	}

	grantedMgr, err := record.NewManager(record.Config{
		Runner:      procRunner,
		Clock:       monotonic,
		OriginNS:    100,
		BinDir:      bin,
		Surfaces:    map[string]record.Surface{surfaceID: {Family: "srf-identity-surface", Container: "srf-id-demo", Window: "w1", FramesRoot: framesRoot}},
		Destination: &record.Destination{CapabilityID: "cap-grant", Path: authTar},
		MemoryBytes: 65536,
		RingBytes:   16384,
		MaxFPS:      30,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = grantedMgr.Close() }()

	ramStartReq, _ := json.Marshal(map[string]any{
		"schema":     "record_request/v0.2",
		"request_id": "req-ram-start",
		"op":         "ram_start",
		"params": map[string]any{
			"surface_id":   surfaceID,
			"recording_id": "rec-ram",
			"ring_bytes":   8192,
			"max_fps":      10,
		},
	})
	if evs, err := grantedMgr.Handle(ctx, ramStartReq); err != nil || len(evs) != 1 || evs[0].Event != "started" || evs[0].Mode != "ram" {
		t.Fatalf("ram_start: %+v %v", evs, err)
	}
	pollEvs, err := grantedMgr.Poll(ctx, "req-ram-poll", "rec-ram")
	if err != nil || len(pollEvs) != 1 || pollEvs[0].Event != "frame_captured" || !strings.HasPrefix(pollEvs[0].RAMPath, "/dev/shm/") {
		t.Fatalf("ram Poll: %+v %v", pollEvs, err)
	}
	ramStopReq, _ := json.Marshal(map[string]any{
		"schema":     "record_request/v0.2",
		"request_id": "req-ram-stop",
		"op":         "ram_stop",
		"params": map[string]any{
			"surface_id":   surfaceID,
			"recording_id": "rec-ram",
		},
	})
	if evs, err := grantedMgr.Handle(ctx, ramStopReq); err != nil || len(evs) != 1 || evs[0].Event != "stopped" || evs[0].FrameCount == nil || *evs[0].FrameCount != 1 {
		t.Fatalf("ram_stop: %+v %v", evs, err)
	}

	diskStartReq, _ := json.Marshal(map[string]any{
		"schema":     "record_request/v0.2",
		"request_id": "req-disk-start",
		"op":         "disk_start",
		"params": map[string]any{
			"surface_id":                surfaceID,
			"recording_id":              "rec-disk",
			"destination_capability_id": "cap-grant",
			"destination_path":          authTar,
			"max_fps":                   10,
		},
	})
	if evs, err := grantedMgr.Handle(ctx, diskStartReq); err != nil || len(evs) != 1 || evs[0].Event != "started" || evs[0].Mode != "disk" {
		t.Fatalf("disk_start: %+v %v", evs, err)
	}
	if _, err := grantedMgr.Poll(ctx, "req-disk-poll", "rec-disk"); err != nil {
		t.Fatalf("disk Poll: %v", err)
	}
	diskStopReq, _ := json.Marshal(map[string]any{
		"schema":     "record_request/v0.2",
		"request_id": "req-disk-stop",
		"op":         "disk_stop",
		"params": map[string]any{
			"surface_id":   surfaceID,
			"recording_id": "rec-disk",
		},
	})
	stopEvs, err := grantedMgr.Handle(ctx, diskStopReq)
	if err != nil || len(stopEvs) != 2 || stopEvs[0].Event != "stopped" || stopEvs[1].Event != "exported" || stopEvs[1].DestinationPath != authTar {
		t.Fatalf("disk_stop: %+v %v", stopEvs, err)
	}
	tarBytes, err := os.ReadFile(authTar)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(tarBytes)
	if stopEvs[1].ByteCount == nil || *stopEvs[1].ByteCount != uint64(len(tarBytes)) || stopEvs[1].SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("exported tar digest/size mismatch: %+v", stopEvs[1])
	}

	shotReq, _ := json.Marshal(map[string]any{
		"schema":     "record_request/v0.2",
		"request_id": "req-shot",
		"op":         "screenshot",
		"params": map[string]any{
			"surface_id": surfaceID,
			"capture_id": "shot-1",
		},
	})
	if evs, err := grantedMgr.Handle(ctx, shotReq); err != nil || len(evs) != 3 || evs[0].Mode != "screenshot" || evs[1].Event != "frame_captured" || !strings.HasPrefix(evs[1].RAMPath, "/dev/shm/") || evs[2].Event != "stopped" {
		t.Fatalf("screenshot: %+v %v", evs, err)
	}
}
