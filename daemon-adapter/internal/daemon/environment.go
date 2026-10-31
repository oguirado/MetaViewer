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
// wire-published frame as diagnostic context, never as post-input proof. When
// human-origin input executes without a prior wire-published baseline frame in
// lastFrames, input_applied is retained and paired with a verified=false error
// action_receipt/v0.2 carrying a diagnostic frame_ref. No new capture is
// required to release a dispatched lease, including after takeover.
// [TARGET, unit decision] When an agent-origin Holdings input returns a
// validated GroundTruth on InputEvidence, wireHandler binds it to the
// post-input frame_ref and emits observation/v0.2 ({schema, frame_ref,
// ground_truth}) before action_receipt/v0.2 while keeping verified=false and
// action_receipt.native_evidence closed under contracts/v0.2.
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strconv"
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

// [TARGET, unit decision] MV_SRF_NET_MODES is a trusted JSON array copied from
// the deployed binary's capabilities.net_modes; absent knowledge means legacy.
func networkModesFromEnv() ([]string, error) {
	raw, present := os.LookupEnv("MV_SRF_NET_MODES")
	if !present {
		return nil, nil
	}
	var modes []string
	if err := json.Unmarshal([]byte(raw), &modes); err != nil || modes == nil {
		return nil, configuration("MV_SRF_NET_MODES must be a JSON array of network modes")
	}
	seen := map[string]bool{}
	for _, mode := range modes {
		if (mode != "legacy" && mode != "open" && mode != "proxied") || seen[mode] {
			return nil, configuration("invalid MV_SRF_NET_MODES mode")
		}
		seen[mode] = true
	}
	return modes, nil
}

func RuntimeFromEnv() (Runtime, error) {
	var zero Runtime
	netModes, err := networkModesFromEnv()
	if err != nil {
		return zero, err
	}
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
		mode := os.Getenv("MV_SRF_LIVE_TEXT_INPUT")
		if !capsule.ValidTextInput(mode) {
			return zero, configuration("invalid MV_SRF_LIVE_TEXT_INPUT")
		}
		profiles[id] = capsule.Profile{TextInput: mode, Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 1280, Height: 900}
	}
	if err := validateProfileRoots(profiles); err != nil {
		return zero, err
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
	manager, err := capsule.NewRuntime(capsule.Config{NetModes: netModes, Profiles: profiles, OriginNS: origin, MaxSurfaces: 16, MaxOutputBytes: 1 << 20, Timeout: 90 * time.Second, View: viewMgr}, monotonic)
	if err != nil {
		_ = recorder.Close()
		viewMgr.Close()
		return zero, err
	}
	sharedBudget, err := frames.NewBudget(512 << 20)
	if err != nil {
		_ = recorder.Close()
		viewMgr.Close()
		return zero, configuration(fmt.Sprintf("frame budget: %v", err))
	}
	// One publisher per allocation supports disjoint profile RAM roots while
	// enforcing a single 512 MiB global frame budget across all roots.
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
		// global across all profile RAM roots, and at most 64 generations per surface.
		p, e := frames.NewPublisher(frames.PublishConfig{RAMRoot: profile.RAMRoot, MaxFrameBytes: 64 << 20, MaxPixels: 64 << 20, MaxSurfaces: 16, MaxRetained: 64, MinRetention: 4 * time.Second, MaxSurfaceBytes: 128 << 20, MaxTotalBytes: 512 << 20, Budget: sharedBudget, Deduplicate: false})
		if e != nil {
			_ = recorder.Close()
			viewMgr.Close()
			closePubs()
			return zero, configuration(fmt.Sprintf("frame root: %v", e))
		}
		pubs[profile.RAMRoot] = p
	}
	helloSession := helloState{netModes: netModes, manager: manager, view: viewMgr, recorder: recorder, newRecorder: record.NewFromEnvironment}

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

type recordTicker struct {
	C    <-chan time.Time
	Done func()
	Stop func()
}

type recordTickerKey struct{}

type recordTask struct {
	surfaceID string
	cancel    context.CancelFunc
	done      chan struct{}
}

type recordScheduler struct {
	mu       sync.Mutex
	recorder *record.Manager
	tasks    map[string]*recordTask
}

func (s *recordScheduler) start(ctx context.Context, surfaceID, recordingID, requestID string, interval time.Duration) {
	if s == nil || s.recorder == nil || interval <= 0 {
		return
	}
	session, hasSession := ctx.Value(streamKey{}).(streamSession)
	baseCtx := context.Background()
	if hasSession && session.ctx != nil {
		baseCtx = session.ctx
	}
	var makeTicker func(string, time.Duration) recordTicker
	if fn, ok := ctx.Value(recordTickerKey{}).(func(string, time.Duration) recordTicker); ok && fn != nil {
		makeTicker = fn
	} else {
		makeTicker = func(_ string, d time.Duration) recordTicker {
			t := time.NewTicker(d)
			return recordTicker{C: t.C, Stop: t.Stop}
		}
	}
	s.mu.Lock()
	if existing, ok := s.tasks[recordingID]; ok {
		select {
		case <-existing.done:
			delete(s.tasks, recordingID)
		default:
			s.mu.Unlock()
			return
		}
	}
	taskCtx, cancel := context.WithCancel(baseCtx)
	done := make(chan struct{})
	ticker := makeTicker(recordingID, interval)
	s.tasks[recordingID] = &recordTask{surfaceID: surfaceID, cancel: cancel, done: done}
	s.mu.Unlock()
	go func() {
		defer close(done)
		if ticker.Stop != nil {
			defer ticker.Stop()
		}
		for {
			select {
			case <-taskCtx.Done():
				return
			case <-ticker.C:
				if taskCtx.Err() != nil {
					return
				}
				var lock *sync.Mutex
				if hasSession {
					lock = session.surfaceLock(surfaceID)
				}
				if lock != nil {
					acquired := false
					for !acquired {
						if lock.TryLock() {
							acquired = true
							break
						}
						select {
						case <-taskCtx.Done():
							return
						case <-time.After(time.Millisecond):
						}
					}
				}
				polled, pollErr := s.recorder.Poll(taskCtx, requestID, recordingID)
				if pollErr == nil && hasSession && session.emit != nil {
					for _, ev := range polled {
						if taskCtx.Err() != nil {
							break
						}
						if rawEv, mErr := json.Marshal(ev); mErr == nil {
							_ = session.emit(taskCtx, rawEv)
						}
					}
				}
				if lock != nil {
					lock.Unlock()
				}
				if ticker.Done != nil {
					ticker.Done()
				}
				var refusal *record.Refusal
				if errors.As(pollErr, &refusal) || (pollErr != nil && strings.Contains(pollErr.Error(), "recorder is closed")) {
					return
				}
			}
		}
	}()
}

func (s *recordScheduler) stopRecording(recordingID string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	task, ok := s.tasks[recordingID]
	if ok {
		delete(s.tasks, recordingID)
	}
	s.mu.Unlock()
	if ok {
		task.cancel()
		<-task.done
	}
}

func (s *recordScheduler) stopSurface(surfaceID string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	var toStop []*recordTask
	for id, task := range s.tasks {
		if task.surfaceID == surfaceID {
			toStop = append(toStop, task)
			delete(s.tasks, id)
		}
	}
	s.mu.Unlock()
	for _, task := range toStop {
		task.cancel()
		<-task.done
	}
}

func (s *recordScheduler) stopAll() {
	if s == nil {
		return
	}
	s.mu.Lock()
	toStop := make([]*recordTask, 0, len(s.tasks))
	for id, task := range s.tasks {
		toStop = append(toStop, task)
		delete(s.tasks, id)
	}
	s.mu.Unlock()
	for _, task := range toStop {
		task.cancel()
		<-task.done
	}
}

func wireHandlerWithoutAdmission(m *capsule.Manager, profiles map[string]capsule.Profile, pubs map[string]*frames.Publisher, origin uint64, recorders ...*record.Manager) ipc.Handler {
	var recorder *record.Manager
	if len(recorders) > 0 {
		recorder = recorders[0]
	}
	var sched *recordScheduler
	if recorder != nil {
		sched = &recordScheduler{
			recorder: recorder,
			tasks:    map[string]*recordTask{},
		}
		recorder.AddUnregisterHook(func(surfaceID string) {
			sched.stopSurface(surfaceID)
		})
		recorder.AddCloseHook(func() {
			sched.stopAll()
		})
	}
	owned := map[string]*frames.Publisher{}
	pendingRelease := map[string][]json.RawMessage{}
	var frameMu sync.Mutex
	lastFrames := map[string]json.RawMessage{}
	stateSidecars := map[string][]string{}
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
		var reqMeta struct {
			RequestID string `json:"request_id"`
			Params    struct {
				SurfaceID   string `json:"surface_id"`
				RecordingID string `json:"recording_id"`
			} `json:"params"`
		}
		_ = json.Unmarshal(raw, &reqMeta)
		syncSurface(reqMeta.Params.SurfaceID)
		if (op == "ram_stop" || op == "disk_stop") && recorder.CanStop(reqMeta.Params.SurfaceID, reqMeta.Params.RecordingID, op) {
			sched.stopRecording(reqMeta.Params.RecordingID)
		}
		evs, err := recorder.Handle(ctx, raw)
		if err != nil {
			if op == "disk_stop" {
				if interval, ok := recorder.PollInterval(reqMeta.Params.RecordingID); ok {
					sched.start(ctx, reqMeta.Params.SurfaceID, reqMeta.Params.RecordingID, reqMeta.RequestID, interval)
				}
			}
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
				recorder.Abort(evs[0].RecordingID)
				return wireFailure(e, q, pollErr)
			}
			evs = append(evs, polled...)
			if interval, ok := recorder.PollInterval(evs[0].RecordingID); ok {
				sched.start(ctx, evs[0].SurfaceID, evs[0].RecordingID, evs[0].RequestID, interval)
			}
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
				if err := recorder.UnregisterSurface(params.SurfaceID); err != nil {
					frameMu.Lock()
					pendingRelease[params.SurfaceID] = events
					frameMu.Unlock()
					return failure(err)
				}
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
				for _, pth := range stateSidecars[params.SurfaceID] {
					_ = os.Remove(pth)
				}
				delete(stateSidecars, params.SurfaceID)
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
			Action     struct {
				Type string `json:"type"`
			} `json:"action"`
		}
		_ = json.Unmarshal(q.Params, &params)
		id, proposal, reqOrigin := params.SurfaceID, params.ProposalID, params.Origin
		if reqOrigin == "" {
			reqOrigin = "agent"
		}
		if reqOrigin == "human" {
			// [TARGET, unit decision] Human-origin input settles immediately after
			// native input execution without waiting for post-input pixel capture.
			wireEvidence := evidence
			wireEvidence.BeforeGroundTruth = nil
			wireEvidence.GroundTruth = nil
			frameMu.Lock()
			latestFrame := lastFrames[id]
			frameMu.Unlock()
			if len(latestFrame) == 0 {
				latestFrame = before
			}
			if len(latestFrame) == 0 {
				w, h := uint32(1), uint32(1)
				if b, bErr := m.SubscriptionBinding(id); bErr == nil && b.Surface.Geometry.W >= 1 && b.Surface.Geometry.H >= 1 {
					w, h = uint32(b.Surface.Geometry.W), uint32(b.Surface.Geometry.H)
				}
				diagFrame := frames.Ref{
					Schema:     "frame_ref/v0.2",
					SurfaceID:  id,
					Generation: 1,
					Tick:       0,
					TsNS:       completed - origin,
					Width:      w,
					Height:     h,
					Format:     "rgb24",
					RAMWSPath:  "/dev/shm/unverified",
					SHA256:     strings.Repeat("0", 64),
					CaptureUS:  0,
				}
				errMsg := "input failed: " + configuration("post-input frame baseline required").Error()
				receipt, err := json.Marshal(map[string]any{
					"schema":          "action_receipt/v0.2",
					"proposal_id":     proposal,
					"executed_at_ns":  completed - origin,
					"after_frame":     diagFrame,
					"native_evidence": wireEvidence,
					"verified":        false,
					"verification":    map[string]string{"method": "pixel", "detail": "input failed; no wire-published frame baseline available; no post-input proof"},
					"error":           errMsg,
				})
				if err != nil {
					return nil, err
				}
				events = append(events, receipt)
				return events, nil
			}
			receipt, err := json.Marshal(map[string]any{"schema": "action_receipt/v0.2", "proposal_id": proposal, "executed_at_ns": completed - origin, "after_frame": latestFrame, "native_evidence": wireEvidence, "verified": false, "verification": map[string]string{"method": "pixel", "detail": "human-origin input; post-input pixel capture skipped"}, "error": ""})
			if err != nil {
				return failure(err)
			}
			events = append(events, receipt)
			return events, nil
		}
		capture := func(c context.Context) (capsule.Binding, capsule.NativeFrame, error) { return m.Capture(c, id) }
		var baseline frames.Ref
		_ = json.Unmarshal(before, &baseline)
		var binding capsule.Binding
		var native capsule.NativeFrame
		if params.Action.Type == "type" || params.Action.Type == "key" {
			binding, native, err = settleInput(ctx, baseline.SHA256, capture, time.Now, waitInputCapture)
		} else {
			binding, native, err = capture(ctx)
		}
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
		canObserve := capsule.ValidateGroundTruth(evidence.BeforeGroundTruth) == nil &&
			capsule.ValidateGroundTruth(evidence.GroundTruth) == nil &&
			(evidence.BeforeGroundTruth.State == "") == (evidence.GroundTruth.State == "") &&
			ctx.Err() == nil &&
			ref.SurfaceID == id &&
			ref.Generation > 0 &&
			ref.Width >= 1 &&
			ref.Height >= 1 &&
			ref.RAMWSPath != ""
		if canObserve {
			if current, bErr := m.SubscriptionBinding(id); bErr != nil ||
				current.Container != binding.Container ||
				current.RunID != binding.RunID ||
				current.Surface.Control != "agent" {
				canObserve = false
			}
		}
		if canObserve {
			if info, statErr := os.Stat(ref.RAMWSPath); statErr != nil || !info.Mode().IsRegular() || uint64(info.Size()) != uint64(ref.Width)*uint64(ref.Height)*3 {
				canObserve = false
			}
		}
		var beforeRef frames.Ref
		if canObserve {
			if len(before) == 0 ||
				json.Unmarshal(before, &beforeRef) != nil ||
				beforeRef.SurfaceID != id ||
				beforeRef.Generation == 0 ||
				beforeRef.Generation >= ref.Generation ||
				beforeRef.Width < 1 ||
				beforeRef.Height < 1 ||
				beforeRef.RAMWSPath == "" {
				canObserve = false
			} else if info, statErr := os.Stat(beforeRef.RAMWSPath); statErr != nil || !info.Mode().IsRegular() || uint64(info.Size()) != uint64(beforeRef.Width)*uint64(beforeRef.Height)*3 {
				canObserve = false
			}
		}
		var beforeSidecar, afterSidecar string
		if canObserve && evidence.GroundTruth.State != "" {
			var sErr error
			beforeSidecar, sErr = writeHoldingsStateSidecar(profile.RAMRoot, beforeRef.RAMWSPath, evidence.BeforeGroundTruth.State)
			if sErr != nil {
				canObserve = false
			} else {
				afterSidecar, sErr = writeHoldingsStateSidecar(profile.RAMRoot, ref.RAMWSPath, evidence.GroundTruth.State)
				if sErr != nil {
					_ = os.Remove(beforeSidecar)
					beforeSidecar = ""
					canObserve = false
				}
			}
		}
		if canObserve {
			beforeRef.Tick = evidence.BeforeGroundTruth.Tick
			ref.Tick = evidence.GroundTruth.Tick
		}
		rawRef, _ := json.Marshal(ref)
		frameMu.Lock()
		if owned[id] == nil {
			canObserve = false
		}
		if canObserve && beforeSidecar != "" {
			recordStateSidecar(stateSidecars, id, beforeSidecar)
			recordStateSidecar(stateSidecars, id, afterSidecar)
		}
		lastFrames[id] = rawRef
		frameMu.Unlock()
		if !canObserve {
			if beforeSidecar != "" {
				_ = os.Remove(beforeSidecar)
			}
			if afterSidecar != "" {
				_ = os.Remove(afterSidecar)
			}
		}
		if canObserve {
			obsBefore, _ := json.Marshal(map[string]any{"schema": "observation/v0.2", "frame_ref": beforeRef, "ground_truth": evidence.BeforeGroundTruth})
			events = append(events, obsBefore)
		}
		ready, _ := json.Marshal(map[string]any{"schema": "surface_event/v0.2", "event": "frame_ready", "data": map[string]any{"frame_ref": ref}})
		events = append(events, ready)
		if canObserve {
			obs, _ := json.Marshal(map[string]any{"schema": "observation/v0.2", "frame_ref": ref, "ground_truth": evidence.GroundTruth})
			events = append(events, obs)
		}
		wireEvidence := evidence
		wireEvidence.BeforeGroundTruth = nil
		wireEvidence.GroundTruth = nil
		receipt, _ := json.Marshal(map[string]any{"schema": "action_receipt/v0.2", "proposal_id": proposal, "executed_at_ns": completed - origin, "after_frame": ref, "native_evidence": wireEvidence, "verified": false, "verification": map[string]string{"method": "pixel", "detail": "post-input capture only; expectation verification belongs to core"}, "error": ""})
		events = append(events, receipt)
		return events, nil
	}
}

const maxRetainedStateSidecars = 16

func recordStateSidecar(stateSidecars map[string][]string, surfaceID, path string) {
	if path == "" {
		return
	}
	list := stateSidecars[surfaceID]
	filtered := list[:0]
	for _, existing := range list {
		if existing != path {
			filtered = append(filtered, existing)
		}
	}
	filtered = append(filtered, path)
	for len(filtered) > maxRetainedStateSidecars {
		evicted := filtered[0]
		filtered = filtered[1:]
		_ = os.Remove(evicted)
	}
	stateSidecars[surfaceID] = filtered
}

func HoldingsStateSidecarPath(ramRoot, ramwsPath string) string {
	return filepath.Join(ramRoot, ".state-"+filepath.Base(ramwsPath))
}

func writeHoldingsStateSidecar(ramRoot, ramwsPath, stateJSON string) (string, error) {
	if len(stateJSON) == 0 || len(stateJSON) > capsule.MaxHoldingsStateBytes {
		return "", errors.New("invalid holdings state sidecar size")
	}
	base := filepath.Base(ramwsPath)
	if base == "" || base == "." || base == ".." || strings.Contains(base, "/") {
		return "", syscall.EINVAL
	}
	dirFile, err := openStateDir(ramRoot)
	if err != nil {
		return "", err
	}
	defer dirFile.Close()
	name := ".state-" + base
	_ = syscall.Unlinkat(int(dirFile.Fd()), name)
	fd, err := syscall.Openat(int(dirFile.Fd()), name, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return "", err
	}
	fullPath := filepath.Join(ramRoot, name)
	f := os.NewFile(uintptr(fd), fullPath)
	n, wErr := f.WriteString(stateJSON)
	cErr := f.Close()
	if wErr != nil || cErr != nil || n != len(stateJSON) {
		_ = syscall.Unlinkat(int(dirFile.Fd()), name)
		return "", errors.New("holdings state sidecar write failed")
	}
	return fullPath, nil
}

func wireFailure(e ipc.Envelope, q capsule.Request, err error) ([]json.RawMessage, error) {
	var params struct {
		SurfaceID string `json:"surface_id"`
	}
	_ = json.Unmarshal(q.Params, &params)
	if params.SurfaceID == "" {
		params.SurfaceID = e.MsgID
	}
	// [TARGET, unit decision] close-F2: the wire code is stable and uppercase so
	// the UI authority wire passes the real refusal through instead of masking it.
	code := capsule.WireCode(err)
	b, _ := json.Marshal(map[string]any{"schema": "surface_event/v0.2", "event": "error", "data": map[string]string{"surface_id": params.SurfaceID, "code": code, "detail": err.Error()}})
	return []json.RawMessage{b}, nil
}

// [TARGET, unit decision] Settle only drained agent text/key input. Clicks and
// human-origin input retain their existing capture policy. Never invent a change.
const postInputSettleBound = 1500 * time.Millisecond
const postInputCaptureInterval = 50 * time.Millisecond

func waitInputCapture(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func settleInput(ctx context.Context, before string,
	capture func(context.Context) (capsule.Binding, capsule.NativeFrame, error),
	now func() time.Time, wait func(context.Context, time.Duration) error,
) (capsule.Binding, capsule.NativeFrame, error) {
	deadline := now().Add(postInputSettleBound)
	bounded, cancel := context.WithTimeout(ctx, postInputSettleBound)
	defer cancel()
	var binding capsule.Binding
	var last capsule.NativeFrame
	for {
		b, frame, err := capture(bounded)
		if err != nil {
			if last.Seq != 0 && bounded.Err() != nil && ctx.Err() == nil {
				return binding, last, nil
			}
			return b, frame, err
		}
		binding, last = b, frame
		// Without a published baseline no pixel change can be established.
		if before == "" || frame.SHA256RGB24 != before {
			return binding, last, nil
		}
		if deadline.Sub(now()) < postInputCaptureInterval {
			return binding, last, nil
		}
		if err := wait(bounded, postInputCaptureInterval); err != nil {
			if bounded.Err() != nil && ctx.Err() == nil {
				return binding, last, nil
			}
			return binding, last, err
		}
		if !now().Before(deadline) {
			return binding, last, nil
		}
	}
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
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	for _, profile := range *dst {
		if !capsule.ValidTextInput(profile.TextInput) {
			return configuration("invalid profile text_input")
		}
	}
	return nil
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
	netModes      []string
	manager       *capsule.Manager
	handler       ipc.Handler
	subscriptions []*frames.Subscriptions
	view          capsule.ViewBackend
	recorder      *record.Manager
	newRecorder   func(uint64, cli.Clock) (*record.Manager, error)
	welcomed      bool
	closeBudget   time.Duration // zero selects closeManagerBudget; tests inject a short one
	minStopSlice  time.Duration // zero selects minStopSlice; tests inject a short one
}

// [TARGET, unit decision] QC-03 shutdown budgets. The host sends SIGTERM and
// SIGKILLs the adapter after its grace period (45 s [TARGET], owned by the
// packaging unit). The adapter's own worst case must finish strictly inside it:
// createQuitGrace (an in-flight create may finish after cancellation) plus
// closeManagerBudget (list plus every verified destroy) is capped by
// shutdownBudgetCeiling, leaving >= 5 s [TARGET] for subscription, recorder,
// view and publisher teardown. A native stop killed mid-destroy leaves a lost
// binding and a kept reservation, so no stop may be cut by the host's SIGKILL.
const (
	closeManagerBudget    = 30 * time.Second // [CITED] unchanged value
	createQuitGrace       = 10 * time.Second
	shutdownBudgetCeiling = 40 * time.Second
	// minStopSlice is the least share a destroy gets while budget remains, so
	// one hung stop cannot starve the capsules queued behind it.
	minStopSlice = 10 * time.Second
)

// stopSlice returns the context budget of the next destroy: an equal share of
// the remaining budget over the destroys still queued, never below
// min(remaining, minStopSlice). A lone destroy gets everything that remains.
func stopSlice(remaining time.Duration, queued int, minSlice time.Duration) time.Duration {
	if remaining <= 0 || queued < 1 {
		return 0
	}
	slice := remaining / time.Duration(queued)
	if floor := min(remaining, minSlice); slice < floor {
		slice = floor
	}
	return slice
}

func (s *helloState) closeManager(ctx context.Context) error {
	if s.manager == nil {
		return nil
	}
	budget := s.closeBudget
	if budget <= 0 {
		budget = closeManagerBudget
	}
	minSlice := s.minStopSlice
	if minSlice <= 0 {
		minSlice = minStopSlice
	}
	deadline := time.Now().Add(budget)
	listCtx, cancelList := context.WithDeadline(ctx, deadline)
	events, err := s.manager.Handle(listCtx, capsule.Request{Schema: "surface_request/v0.2", Op: "list", Params: json.RawMessage(`{}`)})
	cancelList()
	if err != nil {
		return err
	}
	var errs []error
	for i, raw := range events {
		var ev struct {
			Data struct {
				Surface capsule.Surface `json:"surface"`
			} `json:"data"`
		}
		if e := json.Unmarshal(raw, &ev); e != nil {
			errs = append(errs, e)
			continue
		}
		slice := stopSlice(time.Until(deadline), len(events)-i, minSlice)
		if slice <= 0 {
			// Budget spent: never start a native stop that is already cancelled.
			errs = append(errs, fmt.Errorf("shutdown budget exhausted before stopping %s", ev.Data.Surface.SurfaceID))
			continue
		}
		stopCtx, cancelStop := context.WithTimeout(ctx, slice)
		params, _ := json.Marshal(map[string]string{"surface_id": ev.Data.Surface.SurfaceID})
		request := capsule.Request{Schema: "surface_request/v0.2", Op: "destroy", Params: params}
		var stopErr error
		if s.handler == nil {
			_, stopErr = s.manager.Handle(stopCtx, request)
		} else {
			// Keep verified shutdown on the same host-admission lifecycle path.
			body, _ := json.Marshal(request)
			events, err := s.handler(stopCtx, ipc.Envelope{Body: body})
			stopErr = err
			for _, raw := range events {
				var ev struct {
					Event string
					Data  struct{ Detail string }
				}
				if json.Unmarshal(raw, &ev) == nil && ev.Event == "error" {
					stopErr = errors.New(ev.Data.Detail)
				}
			}
		}
		cancelStop()
		if stopErr != nil {
			errs = append(errs, stopErr)
		}
	}
	// Every failed or skipped stop is reported, not only the first.
	return errors.Join(errs...)
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
	var ring *frames.RingSource
	beforeDestroy := func(ctx context.Context, id string) error {
		if err := unsubscribeSurface(byRoot)(ctx, id); err != nil {
			return err
		}
		if ring != nil {
			ring.Forget(id)
		}
		return nil
	}
	fresh, err := newRuntime(capsule.Config{NetModes: s.netModes, Profiles: profiles, OriginNS: origin, MaxSurfaces: 16, MaxOutputBytes: 1 << 20, Timeout: 90 * time.Second, View: s.view, BeforeDestroy: beforeDestroy}, clock)
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
	// [TARGET, unit decision] Requested FPS defaults to the ring contract's
	// default; MV_RING_FPS supplies cadence without changing the compiled root.
	fps := 60
	if requested, e := strconv.Atoi(os.Getenv("MV_RING_FPS")); e == nil {
		fps = requested
	}
	source, pollInterval := frames.SelectRingSource(fresh, os.Getenv("MV_CAPTURE_RING") == "1", fps, os.Stderr, func() (*frames.RingSource, error) { return frames.NewRingSource(fresh, clock, origin) })
	ring, _ = source.(*frames.RingSource)
	var pending []*frames.Subscriptions
	for root, pub := range pubs {
		if ring != nil {
			pub.UseRingSource(ring)
		}
		sub, err := newSubscriptions(session.ctx, frames.SubscriptionConfig{MaxSubscriptions: 16, PollInterval: pollInterval, CaptureTimeout: 90 * time.Second, ShutdownTimeout: 5 * time.Second, SurfaceLock: session.surfaceLock, Diagnostics: os.Stderr, DeduplicateUnchanged: true, InitialUnchangedPolls: 2}, source, pub, session.emit)
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
					Surface   struct {
						SurfaceID string `json:"surface_id"`
					} `json:"surface"`
				} `json:"data"`
			}
			_ = json.Unmarshal(body, &ev)
			id := ev.Data.Surface.SurfaceID
			if id == "" {
				id = ev.Data.SurfaceID
			}
			lock := session.surfaceLock(id)
			if lock != nil {
				lock.Lock()
				defer lock.Unlock()
			}
			return session.emit(ctx, body)
		})
	}()
	return nil
}
