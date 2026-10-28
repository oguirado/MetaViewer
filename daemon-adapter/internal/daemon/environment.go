package daemon

// [TARGET, unit decision] MV_SRF_PROFILES is a JSON object mapping profile IDs
// to capsule.Profile fields. The single browser profile uses :100, 1280x900.
// MV_CONTRACT_DIR optionally locates the deployed v0.2 schemas (default:
// contracts/v0.2). MV_COMPONENT_COMMIT can supply the build's revision when
// Go VCS build metadata is unavailable; no synthetic commit is used.
// MV_SESSION_ID, MV_CORE_INSTANCE and MV_DAEMON_INSTANCE supply trusted core
// registration, required by the existing client-first core handshake.
// [TARGET, unit decision] The wire owner drains cancelled input on native return;
// direct Manager callers keep the explicit DrainInput contract. Replay creation
// is anchored to a descriptor obtained by a canonical no-symlink directory walk.
// [TARGET, unit decision] MV_EXPECTED_CORE_COMMIT optionally pins the core hello
// to a lowercase full revision; a configured invalid pin fails startup closed.
// [TARGET, unit decision] Failed inputs settle with verified=false and the last
// wire-published frame as diagnostic context, never as post-input proof. No new
// capture is required to release a dispatched lease, including after takeover.
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
	"metaviewer/daemon-adapter/internal/record"
	"metaviewer/daemon-adapter/internal/view"
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
	expectedCoreCommit := os.Getenv("MV_EXPECTED_CORE_COMMIT")
	if expectedCoreCommit != "" && !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(expectedCoreCommit) {
		return zero, configuration("valid expected core revision required")
	}
	state := os.Getenv("MV_SRF_STATE_DIR")
	stateFile, err := openStateDir(state)
	if err != nil {
		return zero, configuration("private canonical state directory required: " + err.Error())
	}
	defer stateFile.Close()
	st, err := stateFile.Stat()
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
	viewMgr, err := view.NewFromEnvironment()
	if err != nil {
		return zero, err
	}
	recorder, err := record.NewFromEnvironment(origin, monotonic)
	if err != nil {
		viewMgr.Close()
		return zero, err
	}
	manager, err := capsule.NewRuntime(capsule.Config{Profiles: profiles, OriginNS: origin, MaxSurfaces: 16, MaxOutputBytes: 1 << 20, Timeout: 90 * time.Second, View: viewMgr}, monotonic)
	if err != nil {
		_ = recorder.Close()
		viewMgr.Close()
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
		// [TARGET, unit decision] Retain each published frame >= 4 s (>= 2 s floor),
		// bounded by 128 MiB per surface (~38 full 1280x900 RGB24 frames), 512 MiB
		// global across surfaces, and at most 64 generations per surface.
		p, e := frames.NewPublisher(frames.PublishConfig{RAMRoot: profile.RAMRoot, MaxFrameBytes: 64 << 20, MaxPixels: 64 << 20, MaxSurfaces: 16, MaxRetained: 64, MinRetention: 4 * time.Second, MaxSurfaceBytes: 128 << 20, MaxTotalBytes: 512 << 20, Deduplicate: false})
		if e != nil {
			_ = recorder.Close()
			viewMgr.Close()
			closePubs()
			return zero, configuration(fmt.Sprintf("frame root: %v", e))
		}
		pubs[profile.RAMRoot] = p
	}
	helloSession := helloState{manager: manager, view: viewMgr, recorder: recorder, newRecorder: record.NewFromEnvironment}

	helloSession.handler = wireHandler(manager, profiles, pubs, origin, recorder)
	cfg := ipc.Config{SocketPath: filepath.Join(os.Getenv("XDG_RUNTIME_DIR"), "metaviewer", "core.sock"), UID: uint32(os.Getuid()), MaxFrameBytes: 1 << 20, MaxDepth: 32, MaxStringBytes: 65536, MaxKeys: 256, MaxArrayItems: 4096, MaxReplayEntries: 100000, MaxConnections: 1, HelloTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, ProbeTimeout: time.Second, ShutdownTimeout: 5 * time.Second}
	authority, err := newClientAuthority(fmt.Sprintf("/proc/self/fd/%d/wire-replay.jsonl", stateFile.Fd()), origin)
	if err != nil {
		_ = recorder.Close()
		viewMgr.Close()
		closePubs()
		return zero, configuration(err.Error())
	}
	authority.expectedCoreCommit = expectedCoreCommit
	cleanup := func() {
		for _, s := range helloSession.subscriptions {
			_ = s.Close(context.Background())
			if skipped := s.SkippedPolls(); skipped > 0 {
				_, _ = fmt.Fprintf(os.Stderr, "adapter: session closed with total_skipped_polls=%d\n", skipped)
			}
		}
		if err := helloSession.closeManager(context.Background()); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
		}
		if helloSession.recorder != nil {
			_ = helloSession.recorder.Close()
		}
		viewMgr.Close()
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
			return nil, helloSession.accept(ctx, profiles, pubs, authority, monotonic, capsule.NewRuntime, frames.NewSubscriptions)
		}
		return helloSession.handler(ctx, e)
	}, Client: true, Streaming: true, Registration: probe, Close: cleanup}, nil
}

func wireHandler(m *capsule.Manager, profiles map[string]capsule.Profile, pubs map[string]*frames.Publisher, origin uint64, recorders ...*record.Manager) ipc.Handler {
	var recorder *record.Manager
	if len(recorders) > 0 {
		recorder = recorders[0]
	}
	owned := map[string]*frames.Publisher{}
	pendingRelease := map[string][]json.RawMessage{}
	var frameMu sync.Mutex
	lastFrames := map[string]json.RawMessage{}
	syncSurface := func(surfaceID string) {
		if recorder == nil || m == nil || surfaceID == "" {
			return
		}
		b, err := m.SubscriptionBinding(surfaceID)
		if err != nil {
			return
		}
		family := "srf-identity-surface"
		if b.NativeKind == "holdings" {
			family = "srf-holdings-capsule"
		}
		_ = recorder.RegisterSurface(surfaceID, record.Surface{
			Family:     family,
			Container:  b.Container,
			Window:     b.Window,
			FramesRoot: b.FramesRoot,
		})
	}
	dispatchRecord := func(ctx context.Context, e ipc.Envelope, q capsule.Request, raw []byte, op string) ([]json.RawMessage, error) {
		var p struct {
			SurfaceID string `json:"surface_id"`
		}
		_ = json.Unmarshal(q.Params, &p)
		syncSurface(p.SurfaceID)
		evs, err := recorder.Handle(ctx, raw)
		if err != nil {
			var refusal *record.Refusal
			if errors.As(err, &refusal) && len(evs) > 0 {
				out := make([]json.RawMessage, 0, len(evs))
				for _, ev := range evs {
					b, mErr := json.Marshal(ev)
					if mErr != nil {
						return nil, mErr
					}
					out = append(out, b)
				}
				return out, nil
			}
			return wireFailure(e, q, err)
		}
		if (op == "ram_start" || op == "disk_start") && len(evs) > 0 && evs[0].Event == "started" {
			polled, pollErr := recorder.Poll(ctx, evs[0].RequestID, evs[0].RecordingID)
			if pollErr != nil {
				return wireFailure(e, q, pollErr)
			}
			evs = append(evs, polled...)
		}
		out := make([]json.RawMessage, 0, len(evs))
		for _, ev := range evs {
			b, mErr := json.Marshal(ev)
			if mErr != nil {
				return nil, mErr
			}
			out = append(out, b)
		}
		return out, nil
	}
	return func(ctx context.Context, e ipc.Envelope) ([]json.RawMessage, error) {
		var q capsule.Request
		if err := json.Unmarshal(e.Body, &q); err != nil {
			return nil, err
		}
		if q.Schema == "record_request/v0.2" {
			if recorder == nil {
				var req struct {
					RequestID string `json:"request_id"`
					Params    struct {
						SurfaceID   string `json:"surface_id"`
						RecordingID string `json:"recording_id"`
						CaptureID   string `json:"capture_id"`
					} `json:"params"`
				}
				_ = json.Unmarshal(e.Body, &req)
				recID := req.Params.RecordingID
				if recID == "" {
					recID = req.Params.CaptureID
				}
				if req.RequestID != "" && req.Params.SurfaceID != "" && recID != "" {
					b, _ := json.Marshal(record.Event{
						Schema:      "record_event/v0.2",
						RequestID:   req.RequestID,
						SurfaceID:   req.Params.SurfaceID,
						RecordingID: recID,
						Event:       "refused",
						MonoNS:      0,
						ReasonCode:  "POLICY",
						Detail:      "unsupported: recording authority is not configured",
					})
					return []json.RawMessage{b}, nil
				}
				return wireFailure(e, q, cli.Unsupported("recording authority"))
			}
			return dispatchRecord(ctx, e, q, e.Body, q.Op)
		}
		if q.Schema == "surface_request/v0.2" && (q.Op == "record_start" || q.Op == "record_stop") && recorder != nil {
			var p struct {
				SurfaceID   string `json:"surface_id"`
				RecordingID string `json:"recording_id"`
			}
			if err := cli.ParseLine(q.Params, 1<<20, &p); err != nil || p.SurfaceID == "" || p.RecordingID == "" {
				return wireFailure(e, q, &cli.Fault{Code: "usage", Detail: "surface_id and recording_id required"})
			}
			reqID := e.MsgID
			if reqID == "" {
				reqID = "req-" + p.RecordingID
			}
			op := "ram_stop"
			params := map[string]any{
				"surface_id":   p.SurfaceID,
				"recording_id": p.RecordingID,
			}
			if q.Op == "record_start" {
				op = "ram_start"
				params["ring_bytes"] = recorder.DefaultRingBytes()
				params["max_fps"] = recorder.DefaultMaxFPS()
			}
			raw, err := json.Marshal(map[string]any{
				"schema":     "record_request/v0.2",
				"request_id": reqID,
				"op":         op,
				"params":     params,
			})
			if err != nil {
				return nil, err
			}
			return dispatchRecord(ctx, e, q, raw, op)
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
					syncSurface(created.Data.Surface.SurfaceID)
					frameMu.Lock()
					owned[created.Data.Surface.SurfaceID] = pubs[profile.RAMRoot]
					delete(pendingRelease, created.Data.Surface.SurfaceID)
					frameMu.Unlock()
					for _, raw := range events {
						var ready struct {
							Event string
							Data  struct {
								FrameRef json.RawMessage `json:"frame_ref"`
							}
						}
						if json.Unmarshal(raw, &ready) == nil && ready.Event == "frame_ready" {
							frameMu.Lock()
							lastFrames[created.Data.Surface.SurfaceID] = ready.Data.FrameRef
							frameMu.Unlock()
						}
					}
					return events, nil
				}
				return wireFailure(e, q, err)
			}
		}
		var input struct {
			SurfaceID  string `json:"surface_id"`
			ProposalID string `json:"proposal_id"`
		}
		_ = json.Unmarshal(q.Params, &input)
		frameMu.Lock()
		before := lastFrames[input.SurfaceID]
		frameMu.Unlock()
		failure := func(err error) ([]json.RawMessage, error) {
			if q.Op == "input" && input.ProposalID != "" && len(before) != 0 {
				completed := monotonic()
				if completed < origin {
					return nil, configuration("monotonic completion refused")
				}
				receipt, e := json.Marshal(map[string]any{
					"schema": "action_receipt/v0.2", "proposal_id": input.ProposalID,
					"executed_at_ns": completed - origin, "after_frame": before, "verified": false,
					"verification": map[string]string{"method": "pixel", "detail": "input failed; last wire-published frame is diagnostic context only; no post-input proof"},
					"error":        "input failed: " + err.Error(),
				})
				if e != nil {
					return nil, e
				}
				return []json.RawMessage{receipt}, nil
			}
			return wireFailure(e, q, err)
		}
		// [TARGET, unit decision] Carry the checked native result directly from
		// this input call; never recover proof from another request or a cache.
		var events []json.RawMessage
		var evidence capsule.InputEvidence
		var err error
		if q.Op == "input" {
			events, evidence, err = m.HandleInputWithEvidence(ctx, q)
		} else {
			events, err = m.Handle(ctx, q)
		}
		if q.Op == "destroy" && err != nil {
			var f *cli.Fault
			if errors.As(err, &f) && f.Code == "surface" && input.SurfaceID != "" {
				frameMu.Lock()
				if pending, ok := pendingRelease[input.SurfaceID]; ok {
					events, err = pending, nil
				}
				frameMu.Unlock()
			}
		}
		// [TARGET, unit decision] The wire owner acknowledges cancelled native
		// completion here; direct Manager callers retain explicit DrainInput.
		if q.Op == "input" && err != nil {
			var f *cli.Fault
			if errors.As(err, &f) && f.Code == "SURFACE_NOT_AGENT_CONTROLLED" {
				var input struct {
					SurfaceID  string `json:"surface_id"`
					ProposalID string `json:"proposal_id"`
				}
				_ = json.Unmarshal(q.Params, &input)
				// A refusal before dispatch has no pending entry to drain.
				_ = m.DrainInput(input.SurfaceID, input.ProposalID)
			}
		}
		if err != nil {
			return failure(err)
		}
		if q.Op == "destroy" {
			var params struct {
				SurfaceID string `json:"surface_id"`
			}
			_ = json.Unmarshal(q.Params, &params)
			if recorder != nil {
				recorder.UnregisterSurface(params.SurfaceID)
			}
			frameMu.Lock()
			p := owned[params.SurfaceID]
			frameMu.Unlock()
			if p != nil {
				if err := p.Release(params.SurfaceID); err != nil {
					frameMu.Lock()
					pendingRelease[params.SurfaceID] = events
					frameMu.Unlock()
					return failure(err)
				}
				frameMu.Lock()
				delete(owned, params.SurfaceID)
				delete(pendingRelease, params.SurfaceID)
				delete(lastFrames, params.SurfaceID)
				frameMu.Unlock()
			}
		}
		if strings.TrimSpace(q.Op) == "list" {
			return listSnapshots(events)
		}
		if q.Op != "input" {
			return events, nil
		}
		// [TARGET, unit decision] Execution time is adapter-observed native
		// completion, before capture; expectation verification remains false.
		completed := monotonic()
		if completed < origin || evidence.InputTSNS > completed-origin {
			return failure(configuration("monotonic completion refused"))
		}
		var params struct {
			SurfaceID  string `json:"surface_id"`
			ProposalID string `json:"proposal_id"`
			Origin     string `json:"origin,omitempty"`
		}
		_ = json.Unmarshal(q.Params, &params)
		id, proposal, reqOrigin := params.SurfaceID, params.ProposalID, params.Origin
		if reqOrigin == "" {
			reqOrigin = "agent"
		}
		if reqOrigin == "human" {
			// [TARGET, unit decision] Human-origin input settles immediately after
			// native input execution without waiting for post-input pixel capture.
			frameMu.Lock()
			latestFrame := lastFrames[id]
			frameMu.Unlock()
			if len(latestFrame) == 0 {
				latestFrame = before
			}
			if len(latestFrame) == 0 {
				return failure(configuration("post-input frame baseline required"))
			}
			receipt, err := json.Marshal(map[string]any{"schema": "action_receipt/v0.2", "proposal_id": proposal, "executed_at_ns": completed - origin, "after_frame": latestFrame, "native_evidence": evidence, "verified": false, "verification": map[string]string{"method": "pixel", "detail": "human-origin input; post-input pixel capture skipped"}, "error": ""})
			if err != nil {
				return failure(err)
			}
			events = append(events, receipt)
			return events, nil
		}
		binding, native, err := m.Capture(ctx, id)
		if err != nil {
			return failure(err)
		}
		if evidence.SurfaceID != id || native.CaptureMonoNS < evidence.InputMonoNS {
			return failure(configuration("post-input capture evidence refused"))
		}
		profile, ok := profiles[binding.Surface.ProfileID]
		pub := pubs[profile.RAMRoot]
		if !ok || pub == nil {
			return failure(configuration("post-input frame publisher required"))
		}
		ref, err := pub.PublishForced(id, binding, native)
		if err != nil {
			return failure(err)
		}
		rawRef, _ := json.Marshal(ref)
		frameMu.Lock()
		lastFrames[id] = rawRef
		frameMu.Unlock()
		ready, _ := json.Marshal(map[string]any{"schema": "surface_event/v0.2", "event": "frame_ready", "data": map[string]any{"frame_ref": ref}})
		events = append(events, ready)
		receipt, _ := json.Marshal(map[string]any{"schema": "action_receipt/v0.2", "proposal_id": proposal, "executed_at_ns": completed - origin, "after_frame": ref, "native_evidence": evidence, "verified": false, "verification": map[string]string{"method": "pixel", "detail": "post-input capture only; expectation verification belongs to core"}, "error": ""})
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

// [TARGET, unit decision] Hold each directory descriptor while opening the next
// component; anchor replay creation to the verified final descriptor.
func openStateDir(path string) (*os.File, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, syscall.EINVAL
	}
	flags := syscall.O_RDONLY | syscall.O_DIRECTORY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC
	fd, err := syscall.Open("/", flags, 0)
	if err != nil {
		return nil, err
	}
	defer func() {
		if fd >= 0 {
			syscall.Close(fd)
		}
	}()
	if path != "/" {
		parts := strings.Split(path[1:], "/")
		for i, part := range parts {
			next, e := syscall.Openat(fd, part, flags, 0)
			if e == syscall.ENOENT && i == len(parts)-1 {
				if e = syscall.Mkdirat(fd, part, 0700); e != nil && e != syscall.EEXIST {
					return nil, e
				}
				next, e = syscall.Openat(fd, part, flags, 0)
			}
			if e != nil {
				return nil, e
			}
			syscall.Close(fd)
			fd = next
		}
	}
	file := os.NewFile(uintptr(fd), path)
	fd = -1
	return file, nil
}

// helloState owns the state published by an accepted session handshake.
// Constructor arguments permit deterministic failure testing without global hooks.
type helloState struct {
	manager       *capsule.Manager
	handler       ipc.Handler
	subscriptions []*frames.Subscriptions
	view          capsule.ViewBackend
	recorder      *record.Manager
	newRecorder   func(uint64, cli.Clock) (*record.Manager, error)
	welcomed      bool
}

func (s *helloState) closeManager(ctx context.Context) error {
	if s.manager == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	events, err := s.manager.Handle(ctx, capsule.Request{Schema: "surface_request/v0.2", Op: "list", Params: json.RawMessage(`{}`)})
	if err != nil {
		return err
	}
	var firstErr error
	for _, raw := range events {
		var ev struct {
			Data struct {
				Surface capsule.Surface `json:"surface"`
			} `json:"data"`
		}
		if e := json.Unmarshal(raw, &ev); e != nil {
			if firstErr == nil {
				firstErr = e
			}
			continue
		}
		params, _ := json.Marshal(map[string]string{"surface_id": ev.Data.Surface.SurfaceID})
		if _, e := s.manager.Handle(ctx, capsule.Request{Schema: "surface_request/v0.2", Op: "destroy", Params: params}); e != nil && firstErr == nil {
			firstErr = e
		}
	}
	return firstErr
}

func (s *helloState) accept(ctx context.Context, profiles map[string]capsule.Profile, pubs map[string]*frames.Publisher, authority *clientAuthority, clock cli.Clock,
	newRuntime func(capsule.Config, cli.Clock) (*capsule.Manager, error),
	newSubscriptions func(context.Context, frames.SubscriptionConfig, frames.Source, *frames.Publisher, frames.Emit) (*frames.Subscriptions, error),
) error {
	if s.welcomed {
		return &cli.Fault{Code: "handshake", Detail: "hello already accepted"}
	}
	origin := clock()
	if origin == 0 {
		return configuration("CLOCK_MONOTONIC unavailable")
	}
	byRoot := map[string]*frames.Subscriptions{}
	fresh, err := newRuntime(capsule.Config{Profiles: profiles, OriginNS: origin, MaxSurfaces: 16, MaxOutputBytes: 1 << 20, Timeout: 90 * time.Second, View: s.view, BeforeDestroy: unsubscribeSurface(byRoot)}, clock)
	if err != nil {
		return err
	}
	session, ok := ctx.Value(streamKey{}).(streamSession)
	if !ok {
		return configuration("session emission required")
	}
	if session.locks == nil {
		session.locks = &surfaceLocks{}
	}
	var pending []*frames.Subscriptions
	for root, pub := range pubs {
		sub, err := newSubscriptions(session.ctx, frames.SubscriptionConfig{MaxSubscriptions: 16, PollInterval: 100 * time.Millisecond, CaptureTimeout: 90 * time.Second, ShutdownTimeout: 5 * time.Second, SurfaceLock: session.surfaceLock, Diagnostics: os.Stderr, DeduplicateUnchanged: true, InitialUnchangedPolls: 2}, fresh, pub, session.emit)
		if err != nil {
			for _, staged := range pending {
				_ = staged.Close(context.Background())
			}
			return err
		}
		pending = append(pending, sub)
		byRoot[root] = sub
	}
	var freshRecorder *record.Manager
	if s.newRecorder != nil {
		freshRecorder, err = s.newRecorder(origin, clock)
		if err != nil {
			for _, staged := range pending {
				_ = staged.Close(context.Background())
			}
			return err
		}
	}
	// Publish only after all fallible setup succeeds. Pending subscriptions have
	// no capture tasks yet, so rollback closes them without touching live state.
	authority.origin = origin
	s.manager = fresh
	if s.recorder != nil {
		_ = s.recorder.Close()
	}
	s.recorder = freshRecorder
	s.subscriptions = append(s.subscriptions, pending...)
	s.handler = subscriptionHandler(fresh, profiles, byRoot, wireHandler(fresh, profiles, pubs, origin, s.recorder))
	s.welcomed = true
	go func() {
		_ = fresh.MonitorLiveness(session.ctx, func(ctx context.Context, body json.RawMessage) error {
			var ev struct {
				Data struct {
					SurfaceID string `json:"surface_id"`
				} `json:"data"`
			}
			_ = json.Unmarshal(body, &ev)
			lock := session.surfaceLock(ev.Data.SurfaceID)
			if lock != nil {
				lock.Lock()
				defer lock.Unlock()
			}
			return session.emit(ctx, body)
		})
	}()
	return nil
}
