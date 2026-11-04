package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"sync"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
	"metaviewer/daemon-adapter/internal/ipc"
	"metaviewer/daemon-adapter/internal/record"
)

type headlessOwner interface {
	Handle(context.Context, json.RawMessage, func(json.RawMessage) error) ([]json.RawMessage, error)
	Close() error
	StateRoot() string
}

// This explicit bootstrap never constructs a graphical manager or native driver.
// The same transport, schema policy, durable authority and core hello pin apply.
func headlessOnlyRuntimeFromEnv(load func() (headlessOwner, error)) (Runtime, error) {
	var zero Runtime
	for _, key := range []string{"MV_SESSION_ID", "MV_CORE_INSTANCE", "MV_DAEMON_INSTANCE"} {
		if os.Getenv(key) == "" {
			return zero, configuration(key + " is required for core registration")
		}
	}
	if !filepath.IsAbs(os.Getenv("XDG_RUNTIME_DIR")) {
		return zero, configuration("XDG_RUNTIME_DIR must be absolute")
	}
	pin := os.Getenv("MV_EXPECTED_CORE_COMMIT")
	if pin != "" && !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(pin) {
		return zero, configuration("valid expected core revision required")
	}
	owner, e := load()
	if e != nil {
		return zero, e
	}
	if owner == nil || owner.StateRoot() == "" {
		return zero, configuration("headless-only requires a valid host profile")
	}
	state, e := openStateDir(owner.StateRoot())
	if e != nil {
		return zero, e
	}
	defer state.Close()
	origin := monotonic()
	if origin == 0 {
		return zero, configuration("CLOCK_MONOTONIC unavailable")
	}
	authority, e := newClientAuthority(fmt.Sprintf("/proc/self/fd/%d/headless-wire-replay.jsonl", state.Fd()), origin)
	if e != nil {
		return zero, e
	}
	authority.expectedCoreCommit = pin
	var once sync.Once
	cleanup := func() {
		once.Do(func() {
			if owner.Close() != nil {
				fmt.Fprintln(os.Stderr, "adapter: headless cleanup remains uncertain")
			}
			_ = authority.file.Close()
		})
	}
	cfg := ipc.Config{SocketPath: filepath.Join(os.Getenv("XDG_RUNTIME_DIR"), "metaviewer", "core.sock"), UID: uint32(os.Getuid()), MaxFrameBytes: 1 << 20, MaxDepth: 32, MaxStringBytes: 65536, MaxKeys: 256, MaxArrayItems: 4096, MaxReplayEntries: 100000, MaxConnections: 1, HelloTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, ProbeTimeout: time.Second, ShutdownTimeout: 5 * time.Second}
	dir := os.Getenv("MV_CONTRACT_DIR")
	if dir == "" {
		dir = "contracts/v0.2"
	}
	policy, e := ipc.NewPolicy(cfg, os.DirFS(dir), authority)
	if e != nil {
		cleanup()
		return zero, e
	}
	commit := os.Getenv("MV_COMPONENT_COMMIT")
	if commit == "" {
		if info, ok := debug.ReadBuildInfo(); ok {
			for _, setting := range info.Settings {
				if setting.Key == "vcs.revision" {
					commit = setting.Value
				}
			}
		}
	}
	hello, _ := json.Marshal(map[string]any{"schema": "hello/v0.2", "contract_version": "v0.2", "component": "daemon", "component_version": "0.1.1", "component_commit": commit, "dependencies": []any{}})
	registration := ipc.Envelope{Schema: "envelope/v0.2", MsgID: "startup", From: ipc.Endpoint{Component: "daemon", Instance: os.Getenv("MV_DAEMON_INSTANCE")}, To: ipc.Endpoint{Component: "core", Instance: os.Getenv("MV_CORE_INSTANCE")}, SessionID: os.Getenv("MV_SESSION_ID"), Seq: 1, Nonce: "startup", Body: hello}
	raw, _ := json.Marshal(registration)
	if _, e = policy.ValidateEnvelope(raw); e != nil {
		cleanup()
		return zero, configuration("valid build revision required: " + e.Error())
	}
	registration.From, registration.To = registration.To, registration.From
	authority.bound = &registration
	welcomed := false
	handler := func(ctx context.Context, in ipc.Envelope) ([]json.RawMessage, error) {
		var request struct {
			Schema    string          `json:"schema"`
			Op        string          `json:"op"`
			RequestID string          `json:"request_id"`
			Params    json.RawMessage `json:"params"`
		}
		if e := json.Unmarshal(in.Body, &request); e != nil {
			return nil, e
		}
		if request.Schema == "hello/v0.2" {
			if welcomed {
				return nil, errors.New("hello already accepted")
			}
			welcomed = true
			return nil, nil
		}
		if !welcomed {
			return nil, errors.New("headless hello required")
		}
		if request.Schema == "headless_request/v0.2" {
			return owner.Handle(ctx, in.Body, func(body json.RawMessage) error {
				out := in
				out.From, out.To = out.To, out.From
				out.Body = body
				out.Schema = ipc.EnvelopeSchema(body)
				b, e := json.Marshal(out)
				if e != nil {
					return e
				}
				_, e = policy.ValidateEnvelope(b)
				return e
			})
		}
		if request.Schema == "surface_request/v0.2" && request.Op == "list" {
			return []json.RawMessage{}, nil
		}
		if request.Schema == "record_request/v0.2" {
			var params struct {
				SurfaceID   string `json:"surface_id"`
				RecordingID string `json:"recording_id"`
				CaptureID   string `json:"capture_id"`
			}
			_ = json.Unmarshal(request.Params, &params)
			id := params.RecordingID
			if id == "" {
				id = params.CaptureID
			}
			if request.RequestID != "" && params.SurfaceID != "" && id != "" {
				b, _ := json.Marshal(record.Event{Schema: "record_event/v0.2", RequestID: request.RequestID, SurfaceID: params.SurfaceID, RecordingID: id, Event: "refused", MonoNS: monotonic(), ReasonCode: "POLICY", Detail: "headless-only runtime has no recording authority"})
				return []json.RawMessage{b}, nil
			}
		}
		return wireFailure(in, capsule.Request{Schema: request.Schema, Op: request.Op, Params: request.Params}, &cli.Fault{Code: "POLICY", Detail: "graphical authority is disabled in headless-only runtime"})
	}
	return Runtime{Config: cfg, Policy: policy, Handler: handler, Client: true, Streaming: true, Registration: registration, Close: cleanup}, nil
}
