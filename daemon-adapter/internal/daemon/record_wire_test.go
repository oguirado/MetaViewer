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
	"metaviewer/daemon-adapter/internal/frames"
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

	// Positive wired path 4: disk_start + disk_stop and sealed-RAM export with MV_RECORDING_DESTINATION directory grant through RuntimeFromEnv().
	authDir := t.TempDir()
	t.Setenv("MV_SRF_STATE_DIR", filepath.Join(t.TempDir(), "state-disk"))
	t.Setenv("MV_RECORDING_DESTINATION", authDir)
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
			"destination_path":          authDir,
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
	wantDiskTar := filepath.Join(authDir, fmt.Sprintf("rec-disk-%s.tar", diskExportEv.SHA256))
	if diskStopEv.Event != "stopped" || diskExportEv.Event != "exported" || diskExportEv.DestinationPath != wantDiskTar {
		t.Fatalf("wired disk_stop events: %+v %+v (want %s)", diskStopEv, diskExportEv, wantDiskTar)
	}
	tarBytes, err := os.ReadFile(wantDiskTar)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(tarBytes)
	if diskExportEv.ByteCount == nil || *diskExportEv.ByteCount != uint64(len(tarBytes)) || diskExportEv.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("exported tar digest/size mismatch: %+v", diskExportEv)
	}

	// Sealed-RAM export over wire: ram_start -> ram_stop -> disk_start naming sealed RAM recording ID.
	sealedRAMStart, _ := json.Marshal(map[string]any{
		"schema":     "record_request/v0.2",
		"request_id": "req-sealed-ram-start",
		"op":         "ram_start",
		"params": map[string]any{
			"surface_id":   diskSurfaceID,
			"recording_id": "rec-sealed-ram",
			"ring_bytes":   8192,
			"max_fps":      10,
		},
	})
	if out, err := rDisk.Handler(ctx, ipc.Envelope{MsgID: "req-sealed-ram-start", Body: sealedRAMStart}); err != nil || len(out) != 2 {
		t.Fatalf("sealed RAM start: %s %v", out, err)
	}
	sealedRAMStop, _ := json.Marshal(map[string]any{
		"schema":     "record_request/v0.2",
		"request_id": "req-sealed-ram-stop",
		"op":         "ram_stop",
		"params": map[string]any{
			"surface_id":   diskSurfaceID,
			"recording_id": "rec-sealed-ram",
		},
	})
	if out, err := rDisk.Handler(ctx, ipc.Envelope{MsgID: "req-sealed-ram-stop", Body: sealedRAMStop}); err != nil || len(out) != 1 {
		t.Fatalf("sealed RAM stop: %s %v", out, err)
	}
	sealedExportReq, _ := json.Marshal(map[string]any{
		"schema":     "record_request/v0.2",
		"request_id": "req-sealed-ram-export",
		"op":         "disk_start",
		"params": map[string]any{
			"surface_id":                diskSurfaceID,
			"recording_id":              "rec-sealed-ram",
			"destination_capability_id": "cap-grant",
			"destination_path":          authDir,
			"max_fps":                   10,
		},
	})
	sealedExportOut, err := rDisk.Handler(ctx, ipc.Envelope{MsgID: "req-sealed-ram-export", Body: sealedExportReq})
	if err != nil || len(sealedExportOut) != 1 {
		t.Fatalf("wired sealed-RAM export: %s %v", sealedExportOut, err)
	}
	var sealedExportEv record.Event
	if err := json.Unmarshal(sealedExportOut[0], &sealedExportEv); err != nil || sealedExportEv.Event != "exported" {
		t.Fatalf("wired sealed-RAM export event: %+v %v", sealedExportEv, err)
	}
	wantSealedTar := filepath.Join(authDir, fmt.Sprintf("rec-sealed-ram-%s.tar", sealedExportEv.SHA256))
	if sealedExportEv.DestinationPath != wantSealedTar {
		t.Fatalf("wired sealed-RAM export path = %q, want %q", sealedExportEv.DestinationPath, wantSealedTar)
	}
	// Second export of the same sealed RAM recording over wire refuses with POLICY and DESTINATION_EXISTS prefix.
	dupExportOut, err := rDisk.Handler(ctx, ipc.Envelope{MsgID: "req-sealed-ram-dup", Body: sealedExportReq})
	if err != nil || len(dupExportOut) != 1 {
		t.Fatalf("wired duplicate sealed-RAM export: %s %v", dupExportOut, err)
	}
	var dupExportEv record.Event
	if err := json.Unmarshal(dupExportOut[0], &dupExportEv); err != nil || dupExportEv.Schema != "record_event/v0.2" || dupExportEv.Event != "refused" || dupExportEv.ReasonCode != "POLICY" || !strings.HasPrefix(dupExportEv.Detail, "DESTINATION_EXISTS: ") || strings.Contains(dupExportEv.Detail, "/") {
		t.Fatalf("expected POLICY refusal with DESTINATION_EXISTS prefix on duplicate export, got %+v %v", dupExportEv, err)
	}
	var dupMap map[string]any
	if err := json.Unmarshal(dupExportOut[0], &dupMap); err != nil {
		t.Fatal(err)
	}
	if err := validateBody(dupMap); err != nil {
		t.Fatalf("duplicate export refusal failed contract envelope validation: %v", err)
	}
}

type recordWireTestRunner struct {
	mu          sync.Mutex
	root        string
	pngBytes    []byte
	sha         string
	seq         uint64
	nowNS       uint64
	runByCtr    map[string]string
	surfCounter uint64
	failFrame   bool
}

func (r *recordWireTestRunner) clock() uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.nowNS
}

func (r *recordWireTestRunner) Run(_ context.Context, a []string, _ []byte) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch a[1] {
	case "start":
		r.surfCounter++
		r.nowNS += 1_000_000
		ctr := fmt.Sprintf("srf-id-%d", r.surfCounter)
		runID := fmt.Sprintf("run-%d", r.surfCounter)
		if r.runByCtr == nil {
			r.runByCtr = map[string]string{}
		}
		r.runByCtr[ctr] = runID
		frameDir := filepath.Join(r.root, runID, "frames", "w1")
		if err := os.MkdirAll(frameDir, 0700); err != nil {
			return nil, err
		}
		if err := os.WriteFile(filepath.Join(frameDir, "frame.png"), r.pngBytes, 0600); err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{
			"container": ctr,
			"run_id":    runID,
			"windows":   []map[string]any{{"id": "w1", "x": 0, "y": 0, "w": 2, "h": 1}},
		})
	case "stop":
		r.nowNS += 1_000_000
		return json.Marshal(map[string]any{"stopped": a[3], "removed_verified": true})
	case "frame":
		if r.failFrame {
			return nil, fmt.Errorf("injected frame failure")
		}
		r.seq++
		r.nowNS += 1_000_000_000
		seq := r.seq
		ctr := a[3]
		runID := r.runByCtr[ctr]
		pngPath := filepath.Join(r.root, runID, "frames", "w1", "frame.png")
		return json.Marshal(capsule.NativeFrame{
			Path:          pngPath,
			Seq:           seq,
			SHA256RGB24:   r.sha,
			Width:         2,
			Height:        1,
			CaptureMonoNS: r.nowNS,
			Generation:    ctr,
			Window:        &capsule.Window{ID: "w1", W: 2, H: 1},
		})
	}
	return nil, fmt.Errorf("unexpected op %v", a)
}

func TestRecordWirePeriodicPollLifecycleAndSurfaceDestroy(t *testing.T) {
	root, err := os.MkdirTemp("/dev/shm", "mv-record-wire-sched-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })

	pngPath, sha := writeTestPNG(t, root)
	pngBytes, err := os.ReadFile(pngPath)
	if err != nil {
		t.Fatal(err)
	}
	frameSize := uint64(len(pngBytes))

	runner := &recordWireTestRunner{root: root, pngBytes: pngBytes, sha: sha, nowNS: 10_000}
	profiles := map[string]capsule.Profile{
		"demo":  {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1},
		"demo2": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":101", Width: 2, Height: 1},
	}
	binDir := t.TempDir()
	capMgr, err := capsule.NewManager(capsule.Config{
		BinDir:         binDir,
		Profiles:       profiles,
		MaxSurfaces:    4,
		MaxOutputBytes: 8192,
		Timeout:        5 * time.Second,
		OriginNS:       100,
	}, runner, runner.clock)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := frames.NewPublisher(frames.PublishConfig{
		RAMRoot:         root,
		MaxFrameBytes:   4096,
		MaxPixels:       16,
		MaxSurfaces:     4,
		MaxRetained:     8,
		MinRetention:    2 * time.Second,
		MaxSurfaceBytes: 8192,
		MaxTotalBytes:   32768,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pub.Close() })

	// Configure recorder with MemoryBytes = 2*ringBytes so at most one surface recording fits at a time.
	ringBytes := frameSize * 2
	recMgr, err := record.NewManager(record.Config{
		Runner:      runner,
		Clock:       func() uint64 { return 500 },
		OriginNS:    100,
		BinDir:      binDir,
		MemoryBytes: ringBytes,
		RingBytes:   ringBytes,
		MaxFPS:      30,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = recMgr.Close() })

	h := wireHandler(capMgr, profiles, map[string]*frames.Publisher{root: pub}, 100, recMgr)

	type tickerControl struct {
		ch      chan time.Time
		ack     chan struct{}
		stopped chan struct{}
		once    sync.Once
	}
	var tickerMu sync.Mutex
	tickers := map[string]*tickerControl{}

	emittedCh := make(chan record.Event, 16)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ctx = context.WithValue(ctx, streamKey{}, streamSession{
		ctx:   ctx,
		work:  &sync.Mutex{},
		locks: &surfaceLocks{},
		emit: func(_ context.Context, raw json.RawMessage) error {
			var ev record.Event
			if json.Unmarshal(raw, &ev) == nil && ev.Schema == "record_event/v0.2" {
				emittedCh <- ev
			}
			return nil
		},
	})
	ctx = context.WithValue(ctx, recordTickerKey{}, func(recID string, _ time.Duration) recordTicker {
		ctrl := &tickerControl{
			ch:      make(chan time.Time),
			ack:     make(chan struct{}, 1),
			stopped: make(chan struct{}),
		}
		tickerMu.Lock()
		tickers[recID] = ctrl
		tickerMu.Unlock()
		return recordTicker{
			C: ctrl.ch,
			Done: func() {
				ctrl.ack <- struct{}{}
			},
			Stop: func() {
				ctrl.once.Do(func() { close(ctrl.stopped) })
			},
		}
	})

	createSurface := func(profileID string) string {
		out, cErr := h(ctx, ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"create","params":{"kind":"browser","profile_id":"` + profileID + `","geometry":{"w":2,"h":1}}}`)})
		if cErr != nil || len(out) != 2 {
			t.Fatalf("create surface: %s %v", out, cErr)
		}
		var created struct {
			Data struct {
				Surface capsule.Surface `json:"surface"`
			} `json:"data"`
		}
		if err := json.Unmarshal(out[0], &created); err != nil || created.Data.Surface.SurfaceID == "" {
			t.Fatalf("unmarshal created: %s %v", out[0], err)
		}
		return created.Data.Surface.SurfaceID
	}

	s1 := createSurface("demo")
	s2 := createSurface("demo2")

	// 1. Start wired recording on s1 and drive 2 scheduled Poll ticks deterministically.
	startReq, _ := json.Marshal(map[string]any{
		"schema":     "record_request/v0.2",
		"request_id": "req-sched-1",
		"op":         "ram_start",
		"params": map[string]any{
			"surface_id":   s1,
			"recording_id": "rec-sched-1",
			"ring_bytes":   ringBytes,
			"max_fps":      10,
		},
	})
	startOut, err := h(ctx, ipc.Envelope{MsgID: "req-sched-1", Body: startReq})
	if err != nil || len(startOut) != 2 {
		t.Fatalf("ram_start: %s %v", startOut, err)
	}

	tickerMu.Lock()
	ctrl1 := tickers["rec-sched-1"]
	tickerMu.Unlock()
	if ctrl1 == nil {
		t.Fatal("periodic ticker was not registered for rec-sched-1")
	}

	for tick := 1; tick <= 2; tick++ {
		select {
		case ctrl1.ch <- time.Now():
		case <-ctx.Done():
			t.Fatal("timed out sending tick")
		}
		select {
		case <-ctrl1.ack:
		case <-ctx.Done():
			t.Fatal("timed out waiting for scheduled Poll completion")
		}
	}

	// Verify 2 additional frames (plus 1 ring drop when the 3rd frame enters the 2-frame ring) were emitted on the stream.
	var streamCaptured int
	var streamDropped int
	for len(emittedCh) > 0 {
		ev := <-emittedCh
		switch ev.Event {
		case "frame_captured":
			streamCaptured++
		case "dropped":
			streamDropped++
		}
	}
	if streamCaptured != 2 || streamDropped != 1 {
		t.Fatalf("expected 2 scheduled frame_captured and 1 dropped event on stream, got captured=%d dropped=%d", streamCaptured, streamDropped)
	}

	stopReq, _ := json.Marshal(map[string]any{
		"schema":     "record_request/v0.2",
		"request_id": "req-sched-stop",
		"op":         "ram_stop",
		"params": map[string]any{
			"surface_id":   s1,
			"recording_id": "rec-sched-1",
		},
	})
	stopOut, err := h(ctx, ipc.Envelope{MsgID: "req-sched-stop", Body: stopReq})
	if err != nil || len(stopOut) != 1 {
		t.Fatalf("ram_stop: %s %v", stopOut, err)
	}
	var stoppedEv record.Event
	if err := json.Unmarshal(stopOut[0], &stoppedEv); err != nil || stoppedEv.Event != "stopped" || stoppedEv.FrameCount == nil || *stoppedEv.FrameCount != 2 {
		t.Fatalf("expected stopped FrameCount=2 (retained in 2-frame ring after 3 captures), got %+v %v", stoppedEv, err)
	}
	select {
	case <-ctrl1.stopped:
	case <-ctx.Done():
		t.Fatal("periodic ticker was not stopped on ram_stop")
	}
	if err := recMgr.Release("rec-sched-1"); err != nil {
		t.Fatal(err)
	}

	// 2. Start active recording on s1 (occupying the entire ringBytes session budget), then destroy s1 over the wire.
	startDestroyReq, _ := json.Marshal(map[string]any{
		"schema":     "record_request/v0.2",
		"request_id": "req-destroy-rec",
		"op":         "ram_start",
		"params": map[string]any{
			"surface_id":   s1,
			"recording_id": "rec-on-destroyed",
			"ring_bytes":   ringBytes,
			"max_fps":      10,
		},
	})
	if out, err := h(ctx, ipc.Envelope{MsgID: "req-destroy-rec", Body: startDestroyReq}); err != nil || len(out) != 2 {
		t.Fatalf("ram_start before destroy: %s %v", out, err)
	}
	tickerMu.Lock()
	ctrlDestroy := tickers["rec-on-destroyed"]
	tickerMu.Unlock()

	destroyReq, _ := json.Marshal(map[string]any{
		"schema": "surface_request/v0.2",
		"op":     "destroy",
		"params": map[string]any{"surface_id": s1},
	})
	if out, err := h(ctx, ipc.Envelope{MsgID: "msg-destroy-s1", Body: destroyReq}); err != nil || len(out) != 1 {
		t.Fatalf("destroy s1: %s %v", out, err)
	}
	select {
	case <-ctrlDestroy.stopped:
	case <-ctx.Done():
		t.Fatal("periodic ticker was not stopped on surface destroy")
	}

	// Starting a new recording on s2 requiring the full ringBytes budget now succeeds without BUDGET_EXCEEDED.
	startS2Req, _ := json.Marshal(map[string]any{
		"schema":     "record_request/v0.2",
		"request_id": "req-s2-after-destroy",
		"op":         "ram_start",
		"params": map[string]any{
			"surface_id":   s2,
			"recording_id": "rec-s2-after",
			"ring_bytes":   ringBytes,
			"max_fps":      10,
		},
	})
	s2Out, err := h(ctx, ipc.Envelope{MsgID: "req-s2-after-destroy", Body: startS2Req})
	if err != nil || len(s2Out) != 2 {
		t.Fatalf("new recording on s2 after s1 destroy failed: %s %v", s2Out, err)
	}
}

func TestRecordSchedulerConcurrentStartIdempotentAndFailedInitialPollReleasesReservation(t *testing.T) {
	root, err := os.MkdirTemp("/dev/shm", "mv-record-wire-idem-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })

	pngPath, sha := writeTestPNG(t, root)
	pngBytes, err := os.ReadFile(pngPath)
	if err != nil {
		t.Fatal(err)
	}
	frameSize := uint64(len(pngBytes))
	ringBytes := frameSize * 2

	runner := &recordWireTestRunner{root: root, pngBytes: pngBytes, sha: sha, nowNS: 10_000}
	profiles := map[string]capsule.Profile{
		"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1},
	}
	binDir := t.TempDir()
	capMgr, err := capsule.NewManager(capsule.Config{
		BinDir:         binDir,
		Profiles:       profiles,
		MaxSurfaces:    4,
		MaxOutputBytes: 8192,
		Timeout:        5 * time.Second,
		OriginNS:       100,
	}, runner, runner.clock)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := frames.NewPublisher(frames.PublishConfig{
		RAMRoot:         root,
		MaxFrameBytes:   4096,
		MaxPixels:       16,
		MaxSurfaces:     4,
		MaxRetained:     8,
		MinRetention:    2 * time.Second,
		MaxSurfaceBytes: 8192,
		MaxTotalBytes:   32768,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pub.Close() })

	// MemoryBytes fits only 1 recording of ringBytes at a time.
	recMgr, err := record.NewManager(record.Config{
		Runner:      runner,
		Clock:       func() uint64 { return 500 },
		OriginNS:    100,
		BinDir:      binDir,
		MemoryBytes: ringBytes,
		RingBytes:   ringBytes,
		MaxFPS:      30,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = recMgr.Close() })

	// 1. Concurrent sched.start for the same recording ID must be idempotent:
	// ticker registrations equal map entries (1), and stopping leaves no orphaned task.
	sched := &recordScheduler{
		recorder: recMgr,
		tasks:    map[string]*recordTask{},
	}
	var tickerMu sync.Mutex
	var tickerCount int
	schedCtx := context.WithValue(context.Background(), recordTickerKey{}, func(_ string, _ time.Duration) recordTicker {
		tickerMu.Lock()
		tickerCount++
		tickerMu.Unlock()
		return recordTicker{
			C:    make(chan time.Time),
			Stop: func() {},
		}
	})
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sched.start(schedCtx, "s-idem", "rec-idem", "req-idem", 10*time.Millisecond)
		}()
	}
	wg.Wait()
	sched.mu.Lock()
	taskEntries := len(sched.tasks)
	sched.mu.Unlock()
	tickerMu.Lock()
	gotTickers := tickerCount
	tickerMu.Unlock()
	if gotTickers != 1 || taskEntries != 1 {
		t.Fatalf("concurrent sched.start not idempotent: tickerCount=%d taskEntries=%d (want 1, 1)", gotTickers, taskEntries)
	}
	sched.stopRecording("rec-idem")
	sched.mu.Lock()
	afterStopEntries := len(sched.tasks)
	sched.mu.Unlock()
	if afterStopEntries != 0 {
		t.Fatalf("expected 0 tasks after stopRecording, got %d", afterStopEntries)
	}

	// 2. Failed initial Poll during ram_start must release the recording reservation
	// so repeated failed ram_start calls do not exhaust the session memory budget.
	h := wireHandler(capMgr, profiles, map[string]*frames.Publisher{root: pub}, 100, recMgr)
	ctx := context.Background()
	createOut, err := h(ctx, ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"create","params":{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}}`)})
	if err != nil || len(createOut) != 2 {
		t.Fatalf("create surface: %s %v", createOut, err)
	}
	var created struct {
		Data struct {
			Surface capsule.Surface `json:"surface"`
		} `json:"data"`
	}
	if err := json.Unmarshal(createOut[0], &created); err != nil {
		t.Fatal(err)
	}
	sID := created.Data.Surface.SurfaceID

	runner.mu.Lock()
	runner.failFrame = true
	runner.mu.Unlock()

	for i := 0; i < 5; i++ {
		failReq, _ := json.Marshal(map[string]any{
			"schema":     "record_request/v0.2",
			"request_id": fmt.Sprintf("req-fail-%d", i),
			"op":         "ram_start",
			"params": map[string]any{
				"surface_id":   sID,
				"recording_id": fmt.Sprintf("rec-fail-%d", i),
				"ring_bytes":   ringBytes,
				"max_fps":      10,
			},
		})
		failOut, fErr := h(ctx, ipc.Envelope{MsgID: fmt.Sprintf("req-fail-%d", i), Body: failReq})
		if fErr != nil || len(failOut) != 1 {
			t.Fatalf("failed initial Poll iteration %d: %s %v", i, failOut, fErr)
		}
		var errEv capsule.ErrorEvent
		if err := json.Unmarshal(failOut[0], &errEv); err != nil || errEv.Event != "error" {
			t.Fatalf("expected error event on failed initial Poll, got %s (%v)", failOut[0], err)
		}
	}

	runner.mu.Lock()
	runner.failFrame = false
	runner.mu.Unlock()

	healthyReq, _ := json.Marshal(map[string]any{
		"schema":     "record_request/v0.2",
		"request_id": "req-healthy",
		"op":         "ram_start",
		"params": map[string]any{
			"surface_id":   sID,
			"recording_id": "rec-healthy",
			"ring_bytes":   ringBytes,
			"max_fps":      10,
		},
	})
	healthyOut, err := h(ctx, ipc.Envelope{MsgID: "req-healthy", Body: healthyReq})
	if err != nil || len(healthyOut) != 2 {
		t.Fatalf("healthy ram_start after failed initial Polls failed: %s %v", healthyOut, err)
	}
	var healthyStarted record.Event
	if err := json.Unmarshal(healthyOut[0], &healthyStarted); err != nil || healthyStarted.Event != "started" {
		t.Fatalf("expected started event on healthy ram_start, got %+v (%v)", healthyStarted, err)
	}
}
