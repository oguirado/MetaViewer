package daemon

// [TARGET, unit decision] MV_SRF_PROFILES is a JSON object mapping profile IDs
// to capsule.Profile fields. The single browser profile uses :100, 1280x900.
// MV_CONTRACT_DIR optionally locates the deployed v0.2 schemas (default:
// contracts/v0.2). MV_COMPONENT_COMMIT can supply the build's revision when
// Go VCS build metadata is unavailable; no synthetic commit is used.
// MV_SESSION_ID, MV_CORE_INSTANCE and MV_DAEMON_INSTANCE supply trusted core
// registration, required by the existing client-first core handshake.
import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

func monotonic() uint64 {
	var ts syscall.Timespec
	_, _, errno := syscall.Syscall(syscall.SYS_CLOCK_GETTIME, 1, uintptr(unsafe.Pointer(&ts)), 0)
	if errno != 0 {
		return 0
	}
	return uint64(ts.Sec)*1000000000 + uint64(ts.Nsec)
}
func configuration(detail string) error { return &cli.Fault{Code: "configuration", Detail: detail} }

func RuntimeFromEnv() (Runtime, error) {
	var zero Runtime
	for _, key := range []string{"MV_SRF_BIN_DIR", "MV_SRF_STATE_DIR", "SRF_IDENTITY_STORE_ROOT", "SRF_PROXY_REGISTRY", "XDG_RUNTIME_DIR"} {
		if !filepath.IsAbs(os.Getenv(key)) {
			return zero, configuration(key + " must be absolute")
		}
	}
	for _, key := range []string{"MV_SESSION_ID", "MV_CORE_INSTANCE", "MV_DAEMON_INSTANCE"} {
		if os.Getenv(key) == "" {
			return zero, configuration(key + " is required for core registration")
		}
	}
	state := os.Getenv("MV_SRF_STATE_DIR")
	if err := os.Mkdir(state, 0700); err != nil && !os.IsExist(err) {
		return zero, configuration(err.Error())
	}
	st, err := os.Lstat(state)
	if err != nil || st.Mode() != os.ModeDir|0700 {
		return zero, configuration("private state directory required")
	}
	owner, ok := st.Sys().(*syscall.Stat_t)
	if !ok || owner.Uid != uint32(os.Getuid()) {
		return zero, configuration("state directory owner refused")
	}
	profiles := map[string]capsule.Profile{}
	if raw := os.Getenv("MV_SRF_PROFILES"); raw != "" {
		if err := decodeProfiles(raw, &profiles); err != nil {
			return zero, configuration("invalid MV_SRF_PROFILES")
		}
	} else {
		id, root := os.Getenv("MV_SRF_LIVE_PROFILE"), os.Getenv("MV_SRF_LIVE_RAM_ROOT")
		if id == "" || root == "" {
			return zero, configuration("profile map or live profile/root required")
		}
		profiles[id] = capsule.Profile{Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 1280, Height: 900}
	}
	origin := monotonic()
	if origin == 0 {
		return zero, configuration("CLOCK_MONOTONIC unavailable")
	}
	manager, err := capsule.NewRuntime(capsule.Config{Profiles: profiles, OriginNS: origin, MaxSurfaces: 16, MaxOutputBytes: 1 << 20, Timeout: 90 * time.Second}, monotonic)
	if err != nil {
		return zero, err
	}
	// One publisher per allocation supports disjoint profile RAM roots.
	pubs := map[string]*frames.Publisher{}
	closePubs := func() {
		for _, p := range pubs {
			_ = p.Close()
		}
	}
	for _, profile := range profiles {
		if pubs[profile.RAMRoot] != nil {
			continue
		}
		p, e := frames.NewPublisher(frames.PublishConfig{RAMRoot: profile.RAMRoot, MaxFrameBytes: 64 << 20, MaxPixels: 64 << 20, MaxSurfaces: 16})
		if e != nil {
			closePubs()
			return zero, configuration(fmt.Sprintf("frame root: %v", e))
		}
		pubs[profile.RAMRoot] = p
	}
	var subscriptions []*frames.Subscriptions

	handler := wireHandler(manager, profiles, pubs, origin)
	cfg := ipc.Config{SocketPath: filepath.Join(os.Getenv("XDG_RUNTIME_DIR"), "metaviewer", "core.sock"), UID: uint32(os.Getuid()), MaxFrameBytes: 1 << 20, MaxDepth: 32, MaxStringBytes: 65536, MaxKeys: 256, MaxArrayItems: 4096, MaxReplayEntries: 100000, MaxConnections: 1, HelloTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, ProbeTimeout: time.Second, ShutdownTimeout: 5 * time.Second}
	authority, err := newClientAuthority(filepath.Join(state, "wire-replay.jsonl"), origin)
	if err != nil {
		closePubs()
		return zero, configuration(err.Error())
	}
	cleanup := func() {
		for _, s := range subscriptions {
			_ = s.Close(context.Background())
		}
		closePubs()
		_ = authority.file.Close()
	}
	dir := os.Getenv("MV_CONTRACT_DIR")
	if dir == "" {
		dir = "contracts/v0.2"
	}
	policy, err := ipc.NewPolicy(cfg, os.DirFS(dir), authority)
	if err != nil {
		cleanup()
		return zero, configuration(err.Error())
	}
	commit := os.Getenv("MV_COMPONENT_COMMIT")
	if commit == "" {
		if info, ok := debug.ReadBuildInfo(); ok {
			for _, s := range info.Settings {
				if s.Key == "vcs.revision" {
					commit = s.Value
				}
			}
		}
	}
	hello, _ := json.Marshal(map[string]any{"schema": "hello/v0.2", "contract_version": "v0.2", "component": "daemon", "component_version": "0.1.1", "component_commit": commit, "dependencies": []any{}})
	// Validate the hello through the same full contract before opening the socket.
	probe := ipc.Envelope{Schema: "envelope/v0.2", MsgID: "startup", From: ipc.Endpoint{Component: "daemon", Instance: os.Getenv("MV_DAEMON_INSTANCE")}, To: ipc.Endpoint{Component: "core", Instance: os.Getenv("MV_CORE_INSTANCE")}, SessionID: os.Getenv("MV_SESSION_ID"), Seq: 1, Nonce: "startup", Body: hello}
	raw, _ := json.Marshal(probe)
	if _, err = policy.ValidateEnvelope(raw); err != nil {
		cleanup()
		return zero, configuration("valid build revision required: " + err.Error())
	}
	probe.From, probe.To = probe.To, probe.From
	authority.bound = &probe
	return Runtime{Config: cfg, Policy: policy, Handler: func(ctx context.Context, e ipc.Envelope) ([]json.RawMessage, error) {
		var header struct{ Schema string }
		_ = json.Unmarshal(e.Body, &header)
		if header.Schema == "hello/v0.2" {
			authority.origin = monotonic()
			fresh, err := capsule.NewRuntime(capsule.Config{Profiles: profiles, OriginNS: authority.origin, MaxSurfaces: 16, MaxOutputBytes: 1 << 20, Timeout: 90 * time.Second}, monotonic)
			if err != nil {
				return nil, err
			}
			session, ok := ctx.Value(streamKey{}).(streamSession)
			if !ok {
				return nil, configuration("session emission required")
			}
			byRoot := map[string]*frames.Subscriptions{}
			for root, pub := range pubs {
				sub, err := frames.NewSubscriptions(session.ctx, frames.SubscriptionConfig{MaxSubscriptions: 16, PollInterval: 100 * time.Millisecond, CaptureTimeout: 90 * time.Second, ShutdownTimeout: 5 * time.Second, CaptureLock: session.work}, fresh, pub, session.emit)
				if err != nil {
					return nil, err
				}
				subscriptions = append(subscriptions, sub)
				byRoot[root] = sub
			}
			handler = subscriptionHandler(fresh, profiles, byRoot, wireHandler(fresh, profiles, pubs, authority.origin))
			return nil, nil
		}
		return handler(ctx, e)
	}, Client: true, Streaming: true, Registration: probe, Close: cleanup}, nil
}

func wireHandler(m *capsule.Manager, profiles map[string]capsule.Profile, pubs map[string]*frames.Publisher, origin uint64) ipc.Handler {
	owned := map[string]*frames.Publisher{}
	return func(ctx context.Context, e ipc.Envelope) ([]json.RawMessage, error) {
		var q capsule.Request
		if err := json.Unmarshal(e.Body, &q); err != nil {
			return nil, err
		}
		if q.Op == "create" {
			var p struct {
				ProfileID string `json:"profile_id"`
			}
			_ = json.Unmarshal(q.Params, &p)
			if profile, ok := profiles[p.ProfileID]; ok {
				h, err := NewHandler(m, pubs[profile.RAMRoot])
				if err != nil {
					return nil, err
				}
				events, err := h(ctx, e)
				if err == nil {
					var created struct {
						Data struct {
							Surface capsule.Surface `json:"surface"`
						} `json:"data"`
					}
					_ = json.Unmarshal(events[0], &created)
					owned[created.Data.Surface.SurfaceID] = pubs[profile.RAMRoot]
					return events, nil
				}
				return wireFailure(e, q, err)
			}
		}
		events, err := m.Handle(ctx, q)
		failure := func(err error) ([]json.RawMessage, error) { return wireFailure(e, q, err) }
		if err != nil {
			return failure(err)
		}
		if q.Op == "destroy" {
			var params struct {
				SurfaceID string `json:"surface_id"`
			}
			_ = json.Unmarshal(q.Params, &params)
			if p := owned[params.SurfaceID]; p != nil {
				if err := p.Release(params.SurfaceID); err != nil {
					return failure(err)
				}
				delete(owned, params.SurfaceID)
			}
		}
		if q.Op != "input" {
			return events, nil
		}
		// [TARGET, unit decision] Execution time is adapter-observed native
		// completion, before capture; expectation verification remains false.
		completed := monotonic()
		if completed < origin {
			return failure(configuration("monotonic completion refused"))
		}
		var params struct {
			SurfaceID  string `json:"surface_id"`
			ProposalID string `json:"proposal_id"`
		}
		_ = json.Unmarshal(q.Params, &params)
		id, proposal := params.SurfaceID, params.ProposalID
		binding, native, err := m.Capture(ctx, id)
		if err != nil {
			return failure(err)
		}
		ref, err := pubs[profiles[binding.Surface.ProfileID].RAMRoot].Publish(id, binding, native)
		if err != nil {
			return failure(err)
		}
		ready, _ := json.Marshal(map[string]any{"schema": "surface_event/v0.2", "event": "frame_ready", "data": map[string]any{"frame_ref": ref}})
		events = append(events, ready)
		receipt, _ := json.Marshal(map[string]any{"schema": "action_receipt/v0.2", "proposal_id": proposal, "executed_at_ns": completed - origin, "after_frame": ref, "verified": false, "verification": map[string]string{"method": "pixel", "detail": "post-input capture only; expectation verification belongs to core"}, "error": ""})
		events = append(events, receipt)
		return events, nil
	}
}

func wireFailure(e ipc.Envelope, q capsule.Request, err error) ([]json.RawMessage, error) {
	var params struct {
		SurfaceID string `json:"surface_id"`
	}
	_ = json.Unmarshal(q.Params, &params)
	if params.SurfaceID == "" {
		params.SurfaceID = e.MsgID
	}
	b, _ := json.Marshal(map[string]any{"schema": "surface_event/v0.2", "event": "error", "data": map[string]string{"surface_id": params.SurfaceID, "code": "adapter", "detail": err.Error()}})
	return []json.RawMessage{b}, nil
}

func decodeProfiles(raw string, dst *map[string]capsule.Profile) error {
	if len(raw) > 1<<20 {
		return configuration("profile map byte capacity refused")
	}
	if err := ipc.ValidateJSON([]byte(raw), ipc.Config{MaxDepth: 32, MaxStringBytes: 65536, MaxKeys: 256, MaxArrayItems: 4096}); err != nil {
		return err
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	return decoder.Decode(dst)
}
