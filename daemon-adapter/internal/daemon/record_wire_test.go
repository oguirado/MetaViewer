package daemon

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/ipc"
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
