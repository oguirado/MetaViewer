package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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

// Mutation: remove record_start/record_stop from Manager's unsupported case or
// drop the unconfigured record_request refusal in wireHandler; unconfigured
// wire calls no longer refuse without side effects.
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
	rawRec, _ := json.Marshal(map[string]any{
		"schema":     "record_request/v0.2",
		"request_id": "req-unconf",
		"op":         "ram_start",
		"params":     map[string]any{"surface_id": "surface", "recording_id": "recording", "ring_bytes": 4096, "max_fps": 10},
	})
	recOut, err := h(context.Background(), ipc.Envelope{MsgID: "req-unconf", Body: rawRec})
	if err != nil || len(recOut) != 1 {
		t.Fatalf("unconfigured record_request refusal: %s %v", recOut, err)
	}
	var recEv record.Event
	if err := json.Unmarshal(recOut[0], &recEv); err != nil || recEv.Schema != "record_event/v0.2" || recEv.Event != "refused" || recEv.ReasonCode != "POLICY" || !strings.Contains(recEv.Detail, "unsupported") {
		t.Fatalf("unexpected unconfigured record_event: %+v (%v)", recEv, err)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("unconfigured recording executed: %v", runner.calls)
	}
	out, err := h(context.Background(), ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"list","params":{}}`)})
	if err != nil || len(out) != 0 {
		t.Fatalf("refusal damaged manager: %s %v", out, err)
	}
}

// Mutation 1: drop recorder wiring in RuntimeFromEnv/helloState/wireHandler;
// record_request/v0.2 and record_start/record_stop no longer reach record.Manager
// or return record_event/v0.2 events over the runtime handler.
// Mutation 2: bypass Destination capability/path validation in
// internal/record/record.go; disk_start without grant no longer refuses with
// typed POLICY and zero effects.
func TestRecordWireRuntimeBoundaryAndConfiguredBackend(t *testing.T) {
	nvEnvironment(t)
	bin := os.Getenv("MV_SRF_BIN_DIR")
	callLog := filepath.Join(t.TempDir(), "record-cli.log")
	seqFile := filepath.Join(t.TempDir(), "seq.txt")
	cliPath := filepath.Join(bin, "srf-identity-surface")
	orig, err := os.ReadFile(cliPath)
	if err != nil {
		t.Fatal(err)
	}
	// Advance seq and capture_mono_ns on each frame invocation so multi-capture
	// tests across ram_start, record_start, disk_start and screenshot succeed.
	instrumented := strings.Replace(
		string(orig),
		"op=sys.argv[1]\n",
		fmt.Sprintf("op=sys.argv[1]\nopen(%q,'a').write(' '.join(sys.argv[1:])+'\\n')\n", callLog),
		1,
	)
	instrumented = strings.Replace(
		instrumented,
		"'seq':1,",
		fmt.Sprintf("'seq':(lambda p:(open(p,'w').write(str(int(open(p).read() if os.path.exists(p) else '0')+1)),int(open(p).read()))[1])(%q),", seqFile),
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

	// Negative control on wired handler: uncontracted surface_request screenshot
	// refuses with unknown_op and zero CLI executions; disk_start without
	// MV_RECORDING_DESTINATION refuses with record_event/v0.2 POLICY, zero CLI
	// executions, and zero disk writes.
	unauthTar := filepath.Join(t.TempDir(), "unauth.tar")
	rawShotSurface, _ := json.Marshal(map[string]any{
		"schema": "surface_request/v0.2",
		"op":     "screenshot",
		"params": map[string]any{"surface_id": surfaceID, "capture_id": "shot-1"},
	})
	shotSurfOut, err := r.Handler(ctx, ipc.Envelope{MsgID: "req-shot-surf", Body: rawShotSurface})
	if err != nil || len(shotSurfOut) != 1 {
		t.Fatalf("surface screenshot refusal: %s %v", shotSurfOut, err)
	}
	var surfErrEv capsule.ErrorEvent
	if err := json.Unmarshal(shotSurfOut[0], &surfErrEv); err != nil || surfErrEv.Schema != "surface_event/v0.2" || surfErrEv.Event != "error" || !strings.Contains(surfErrEv.Data.Detail, "unknown_op") {
		t.Fatalf("unexpected surface screenshot error: %s %v", shotSurfOut[0], err)
	}

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
	denyOut, err := r.Handler(ctx, ipc.Envelope{MsgID: "req-deny", Body: diskDenyReq})
	if err != nil || len(denyOut) != 1 {
		t.Fatalf("wired disk_start without grant: %s %v", denyOut, err)
	}
	var denyEv record.Event
	if err := json.Unmarshal(denyOut[0], &denyEv); err != nil || denyEv.Schema != "record_event/v0.2" || denyEv.Event != "refused" || denyEv.ReasonCode != "POLICY" {
		t.Fatalf("disk_start without grant must refuse with POLICY: %+v (%v)", denyEv, err)
	}
	if got := countLines(); got != beforeCalls {
		t.Fatalf("negative record controls executed CLI: before=%d after=%d", beforeCalls, got)
	}
	if _, err := os.Stat(unauthTar); !os.IsNotExist(err) {
		t.Fatalf("disk_start without grant wrote destination: %v", err)
	}

	// Positive wired path 1: record_request/v0.2 ram_start + ram_stop through r.Handler.
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
	ramStartOut, err := r.Handler(ctx, ipc.Envelope{MsgID: "req-ram-start", Body: ramStartReq})
	if err != nil || len(ramStartOut) != 2 {
		t.Fatalf("wired ram_start: %s %v", ramStartOut, err)
	}
	var startedEv, capturedEv record.Event
	if err := json.Unmarshal(ramStartOut[0], &startedEv); err != nil || startedEv.Schema != "record_event/v0.2" || startedEv.Event != "started" || startedEv.Mode != "ram" {
		t.Fatalf("wired ram_start started event: %+v %v", startedEv, err)
	}
	if err := json.Unmarshal(ramStartOut[1], &capturedEv); err != nil || capturedEv.Schema != "record_event/v0.2" || capturedEv.Event != "frame_captured" || !strings.HasPrefix(capturedEv.RAMPath, "/dev/shm/") {
		t.Fatalf("wired ram_start frame_captured event: %+v %v", capturedEv, err)
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
	ramStopOut, err := r.Handler(ctx, ipc.Envelope{MsgID: "req-ram-stop", Body: ramStopReq})
	if err != nil || len(ramStopOut) != 1 {
		t.Fatalf("wired ram_stop: %s %v", ramStopOut, err)
	}
	var stoppedEv record.Event
	if err := json.Unmarshal(ramStopOut[0], &stoppedEv); err != nil || stoppedEv.Schema != "record_event/v0.2" || stoppedEv.Event != "stopped" || stoppedEv.FrameCount == nil || *stoppedEv.FrameCount != 1 {
		t.Fatalf("wired ram_stop event: %+v %v", stoppedEv, err)
	}

	// Positive wired path 2: surface_request/v0.2 record_start + record_stop through r.Handler.
	surfRecStart, _ := json.Marshal(map[string]any{
		"schema": "surface_request/v0.2",
		"op":     "record_start",
		"params": map[string]any{"surface_id": surfaceID, "recording_id": "rec-surf"},
	})
	surfStartOut, err := r.Handler(ctx, ipc.Envelope{MsgID: "msg-rec-start", Body: surfRecStart})
	if err != nil || len(surfStartOut) != 2 {
		t.Fatalf("wired surface record_start: %s %v", surfStartOut, err)
	}
	var surfStartedEv, surfCapturedEv record.Event
	if err := json.Unmarshal(surfStartOut[0], &surfStartedEv); err != nil || surfStartedEv.Event != "started" || surfStartedEv.Mode != "ram" {
		t.Fatalf("wired surface record_start event: %+v %v", surfStartedEv, err)
	}
	if err := json.Unmarshal(surfStartOut[1], &surfCapturedEv); err != nil || surfCapturedEv.Event != "frame_captured" || !strings.HasPrefix(surfCapturedEv.RAMPath, "/dev/shm/") {
		t.Fatalf("wired surface record_start capture: %+v %v", surfCapturedEv, err)
	}
	surfRecStop, _ := json.Marshal(map[string]any{
		"schema": "surface_request/v0.2",
		"op":     "record_stop",
		"params": map[string]any{"surface_id": surfaceID, "recording_id": "rec-surf"},
	})
	surfStopOut, err := r.Handler(ctx, ipc.Envelope{MsgID: "msg-rec-stop", Body: surfRecStop})
	if err != nil || len(surfStopOut) != 1 {
		t.Fatalf("wired surface record_stop: %s %v", surfStopOut, err)
	}
	var surfStoppedEv record.Event
	if err := json.Unmarshal(surfStopOut[0], &surfStoppedEv); err != nil || surfStoppedEv.Event != "stopped" || surfStoppedEv.FrameCount == nil || *surfStoppedEv.FrameCount != 1 {
		t.Fatalf("wired surface record_stop event: %+v %v", surfStoppedEv, err)
	}

	// Positive wired path 3: record_request/v0.2 screenshot through r.Handler.
	shotReq, _ := json.Marshal(map[string]any{
		"schema":     "record_request/v0.2",
		"request_id": "req-shot",
		"op":         "screenshot",
		"params": map[string]any{
			"surface_id": surfaceID,
			"capture_id": "shot-1",
		},
	})
	shotOut, err := r.Handler(ctx, ipc.Envelope{MsgID: "req-shot", Body: shotReq})
	if err != nil || len(shotOut) != 3 {
		t.Fatalf("wired screenshot: %s %v", shotOut, err)
	}
	var shotEv0, shotEv1, shotEv2 record.Event
	_ = json.Unmarshal(shotOut[0], &shotEv0)
	_ = json.Unmarshal(shotOut[1], &shotEv1)
	_ = json.Unmarshal(shotOut[2], &shotEv2)
	if shotEv0.Mode != "screenshot" || shotEv1.Event != "frame_captured" || !strings.HasPrefix(shotEv1.RAMPath, "/dev/shm/") || shotEv2.Event != "stopped" {
		t.Fatalf("wired screenshot events: %+v %+v %+v", shotEv0, shotEv1, shotEv2)
	}

	// Positive wired path 4: disk_start + disk_stop with MV_RECORDING_DESTINATION grant through RuntimeFromEnv().
	authTar := filepath.Join(t.TempDir(), "authorized.tar")
	t.Setenv("MV_SRF_STATE_DIR", filepath.Join(t.TempDir(), "state-disk"))
	t.Setenv("MV_RECORDING_DESTINATION", authTar)
	t.Setenv("MV_RECORDING_CAPABILITY_ID", "cap-grant")
	rDisk, err := RuntimeFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	defer rDisk.Close()
	if _, err := rDisk.Handler(ctx, ipc.Envelope{Body: json.RawMessage(`{"schema":"hello/v0.2"}`)}); err != nil {
		t.Fatal(err)
	}
	diskCreateOut, err := rDisk.Handler(ctx, ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"create","params":{"kind":"browser","profile_id":"demo","geometry":{"w":1280,"h":900}}}`)})
	if err != nil || len(diskCreateOut) != 2 {
		t.Fatalf("disk runtime create: %s %v", diskCreateOut, err)
	}
	var diskCreated struct {
		Data struct {
			Surface capsule.Surface `json:"surface"`
		} `json:"data"`
	}
	if err := json.Unmarshal(diskCreateOut[0], &diskCreated); err != nil {
		t.Fatal(err)
	}
	diskSurfaceID := diskCreated.Data.Surface.SurfaceID

	diskStartReq, _ := json.Marshal(map[string]any{
		"schema":     "record_request/v0.2",
		"request_id": "req-disk-start",
		"op":         "disk_start",
		"params": map[string]any{
			"surface_id":                diskSurfaceID,
			"recording_id":              "rec-disk",
			"destination_capability_id": "cap-grant",
			"destination_path":          authTar,
			"max_fps":                   10,
		},
	})
	diskStartOut, err := rDisk.Handler(ctx, ipc.Envelope{MsgID: "req-disk-start", Body: diskStartReq})
	if err != nil || len(diskStartOut) != 2 {
		t.Fatalf("wired disk_start: %s %v", diskStartOut, err)
	}
	diskStopReq, _ := json.Marshal(map[string]any{
		"schema":     "record_request/v0.2",
		"request_id": "req-disk-stop",
		"op":         "disk_stop",
		"params": map[string]any{
			"surface_id":   diskSurfaceID,
			"recording_id": "rec-disk",
		},
	})
	diskStopOut, err := rDisk.Handler(ctx, ipc.Envelope{MsgID: "req-disk-stop", Body: diskStopReq})
	if err != nil || len(diskStopOut) != 2 {
		t.Fatalf("wired disk_stop: %s %v", diskStopOut, err)
	}
	var diskStopEv, diskExportEv record.Event
	_ = json.Unmarshal(diskStopOut[0], &diskStopEv)
	_ = json.Unmarshal(diskStopOut[1], &diskExportEv)
	if diskStopEv.Event != "stopped" || diskExportEv.Event != "exported" || diskExportEv.DestinationPath != authTar {
		t.Fatalf("wired disk_stop events: %+v %+v", diskStopEv, diskExportEv)
	}
	tarBytes, err := os.ReadFile(authTar)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(tarBytes)
	if diskExportEv.ByteCount == nil || *diskExportEv.ByteCount != uint64(len(tarBytes)) || diskExportEv.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("exported tar digest/size mismatch: %+v", diskExportEv)
	}
}
