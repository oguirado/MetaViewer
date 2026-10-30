package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

type holdingsWireWitnessRunner struct {
	framePath, frameSHA string
	root                string
	seq                 uint64
	calls               [][]string
	inputRaw            []byte
	observeRaw          []byte
	observeErr          error
	observeQueue        [][]byte
}

func (r *holdingsWireWitnessRunner) Run(_ context.Context, args []string, _ []byte) ([]byte, error) {
	cp := append([]string(nil), args...)
	r.calls = append(r.calls, cp)
	if len(args) < 2 {
		return nil, errors.New("missing verb")
	}
	switch filepath.Base(args[0]) + ":" + args[1] {
	case "srf-holdings-capsule:start":
		framesDir := filepath.Join(r.root, "hc-0123456789ab/frames")
		return json.Marshal([]map[string]any{{
			"slot":        1,
			"container":   "srf-ng-hcap-hc-0123456789ab-1",
			"run_id":      "hc-0123456789ab",
			"display":     ":100",
			"width":       2,
			"height":      1,
			"lane_socket": "/tmp/lane.sock",
			"ready_line":  "HOLDINGS_READY 1 0",
			"ready_ms":    0,
			"frames_dir":  framesDir,
		}})
	case "srf-holdings-capsule:frame":
		r.seq++
		path := filepath.Join(r.root, "hc-0123456789ab/frames/f.png")
		digest := fmt.Sprintf("%x", sha256.Sum256(make([]byte, 6)))
		if r.framePath != "" {
			path, digest = r.framePath, r.frameSHA
		}
		return json.Marshal(map[string]any{
			"sha256_rgb24":    digest,
			"path":            path,
			"seq":             r.seq,
			"width":           2,
			"height":          1,
			"capture_mono_ns": 200,
			"generation":      "srf-ng-hcap-hc-0123456789ab-1",
		})
	case "srf-holdings-capsule:input":
		if r.inputRaw != nil {
			return r.inputRaw, nil
		}
		return []byte(`{"input_mono_ns":200}`), nil
	case "srf-holdings-capsule:observe":
		if len(r.observeQueue) > 0 {
			out := r.observeQueue[0]
			r.observeQueue = r.observeQueue[1:]
			return out, r.observeErr
		}
		return r.observeRaw, r.observeErr
	default:
		return nil, errors.New("unexpected native command: " + strings.Join(args, " "))
	}
}

func newWireTestPolicy(t *testing.T) ipc.Policy {
	t.Helper()
	policy, err := ipc.NewPolicy(
		ipc.Config{
			SocketPath:       filepath.Join(t.TempDir(), "core.sock"),
			MaxReplayEntries: 1000,
			MaxConnections:   1,
			HelloTimeout:     time.Second,
			ReadTimeout:      time.Second,
			WriteTimeout:     time.Second,
			ProbeTimeout:     time.Second,
			ShutdownTimeout:  time.Second,
			MaxFrameBytes:    1 << 20,
			MaxDepth:         32,
			MaxStringBytes:   65536,
			MaxKeys:          256,
			MaxArrayItems:    4096,
		},
		os.DirFS(filepath.Join("..", "..", "..", "contracts", "v0.2")),
		&lifecyclePolicy{},
	)
	if err != nil {
		t.Fatal(err)
	}
	return policy
}

func validateWireBodies(t *testing.T, policy ipc.Policy, bodies []json.RawMessage, baseSeq *uint64) {
	t.Helper()
	for i, body := range bodies {
		*baseSeq++
		seq := *baseSeq
		env, err := json.Marshal(ipc.Envelope{
			Schema:    "envelope/v0.2",
			MsgID:     "msg-" + strconv.FormatUint(seq, 10),
			From:      ipc.Endpoint{Component: "daemon", Instance: "daemon"},
			To:        ipc.Endpoint{Component: "core", Instance: "core"},
			SessionID: "session-witness",
			Seq:       seq,
			Nonce:     "nonce-" + strconv.FormatUint(seq, 10),
			Body:      body,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := policy.ValidateEnvelope(env); err != nil {
			t.Fatalf("wire body[%d] failed contracts/v0.2 envelope validation: %v (%s)", i, err, body)
		}
	}
}

func setupHoldingsWireFixture(t *testing.T) (string, *holdingsWireWitnessRunner, *capsule.Manager, *frames.Publisher, ipc.Handler, string) {
	t.Helper()
	root, err := os.MkdirTemp("/dev/shm", "mv-holdings-witness-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })

	source := filepath.Join(root, "hc-0123456789ab/frames")
	if err = os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	framePath := filepath.Join(source, "f.png")
	f, err := os.OpenFile(framePath, os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	img := image.NewNRGBA(image.Rect(0, 0, 2, 1))
	img.Set(0, 0, color.NRGBA{A: 255})
	img.Set(1, 0, color.NRGBA{A: 255})
	if err = png.Encode(f, img); err != nil {
		f.Close()
		t.Fatal(err)
	}
	f.Close()

	profiles := map[string]capsule.Profile{
		"game": {
			Kind:       "game_capsule",
			NativeKind: "holdings",
			AppDir:     "/opt/game",
			RAMRoot:    root,
			Display:    ":100",
			Width:      2,
			Height:     1,
		},
	}
	runner := &holdingsWireWitnessRunner{root: root}
	m, err := capsule.NewManager(
		capsule.Config{
			BinDir:         t.TempDir(),
			Profiles:       profiles,
			MaxSurfaces:    1,
			MaxOutputBytes: 8192,
			Timeout:        time.Second,
			OriginNS:       100,
			VerifyHoldingsInput: func(_ context.Context, _ capsule.Binding, proposal string, _ json.RawMessage, stamp uint64) error {
				if proposal == "" || stamp != 200 {
					return errors.New("invalid holdings verification args")
				}
				return nil
			},
		},
		runner,
		func() uint64 { return 200 },
	)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := frames.NewPublisher(frames.PublishConfig{
		RAMRoot:       root,
		MaxFrameBytes: 8192,
		MaxPixels:     2,
		MaxSurfaces:   1,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pub.Close() })

	h := isolatedWireHandler(t, m, profiles, map[string]*frames.Publisher{root: pub}, 100)
	createBody, _ := json.Marshal(map[string]any{
		"schema": "surface_request/v0.2",
		"op":     "create",
		"params": map[string]any{
			"kind":       "game_capsule",
			"profile_id": "game",
			"geometry":   map[string]int{"w": 2, "h": 1},
		},
	})
	created, err := h(context.Background(), ipc.Envelope{Body: createBody})
	if err != nil || len(created) != 2 {
		t.Fatalf("create failed: %s (%v)", created, err)
	}
	var createEv struct {
		Data struct {
			Surface capsule.Surface `json:"surface"`
		} `json:"data"`
	}
	if err := json.Unmarshal(created[0], &createEv); err != nil {
		t.Fatal(err)
	}
	return root, runner, m, pub, h, createEv.Data.Surface.SurfaceID
}

func TestHoldingsAgentInputWireForwardsGroundTruthAndFrameBinding(t *testing.T) {
	_, runner, _, _, h, sid := setupHoldingsWireFixture(t)
	policy := newWireTestPolicy(t)
	var seq uint64

	stateDigest := strings.Repeat("3c", 32)
	frameDigest := strings.Repeat("7f", 32)
	runner.observeRaw = []byte(`{"state_sha256":"` + stateDigest + `","tick":19,"revision":4,"frame_state_sha256":"` + frameDigest + `","elements":[{"id":"turn"}]}`)
	runner.calls = nil

	reqBody, _ := json.Marshal(map[string]any{
		"schema": "surface_request/v0.2",
		"op":     "input",
		"params": map[string]any{
			"surface_id":  sid,
			"proposal_id": "prop-agent-witness",
			"origin":      "agent",
			"action":      map[string]any{"type": "click", "x": 1, "y": 0, "button": "left"},
		},
	})
	events, err := h(context.Background(), ipc.Envelope{Body: reqBody})
	if err != nil {
		t.Fatalf("wire input failed: %v", err)
	}
	validateWireBodies(t, policy, events, &seq)

	if len(runner.calls) != 4 || runner.calls[0][1] != "observe" || runner.calls[1][1] != "input" || runner.calls[2][1] != "observe" || runner.calls[3][1] != "frame" {
		t.Fatalf("expected native call order [observe, input, observe, frame], got %v", runner.calls)
	}
	if len(events) != 5 {
		t.Fatalf("expected 5 wire events [input_applied, observation(before), frame_ready, observation(after), action_receipt], got %d: %s", len(events), events)
	}

	var beforeObs struct {
		Schema      string               `json:"schema"`
		FrameRef    frames.Ref           `json:"frame_ref"`
		GroundTruth *capsule.GroundTruth `json:"ground_truth"`
	}
	if err := json.Unmarshal(events[1], &beforeObs); err != nil || beforeObs.Schema != "observation/v0.2" || beforeObs.GroundTruth == nil {
		t.Fatalf("unexpected before observation event: %s (%v)", events[1], err)
	}
	if beforeObs.FrameRef.Tick != beforeObs.GroundTruth.Tick {
		t.Fatalf("before observation frame_ref.tick %d != ground_truth.tick %d", beforeObs.FrameRef.Tick, beforeObs.GroundTruth.Tick)
	}

	var readyEv struct {
		Schema string `json:"schema"`
		Event  string `json:"event"`
		Data   struct {
			FrameRef frames.Ref `json:"frame_ref"`
		} `json:"data"`
	}
	if err := json.Unmarshal(events[2], &readyEv); err != nil || readyEv.Schema != "surface_event/v0.2" || readyEv.Event != "frame_ready" {
		t.Fatalf("unexpected frame_ready event: %s (%v)", events[2], err)
	}

	var obs struct {
		Schema      string               `json:"schema"`
		FrameRef    frames.Ref           `json:"frame_ref"`
		GroundTruth *capsule.GroundTruth `json:"ground_truth"`
	}
	if err := json.Unmarshal(events[3], &obs); err != nil {
		t.Fatalf("unmarshal observation: %s (%v)", events[3], err)
	}
	if obs.Schema != "observation/v0.2" || obs.GroundTruth == nil {
		t.Fatalf("expected observation/v0.2 with ground_truth, got %s", events[3])
	}
	wantGT := capsule.GroundTruth{
		Source:      "holdings_lane",
		StateSHA256: stateDigest,
		Tick:        19,
	}
	if *obs.GroundTruth != wantGT {
		t.Fatalf("ground_truth mismatch: got %+v, want %+v", *obs.GroundTruth, wantGT)
	}
	if obs.FrameRef.Tick != 19 || readyEv.Data.FrameRef.Tick != 19 {
		t.Fatalf("expected after frame_ref.tick bound to 19, got obs=%d ready=%d", obs.FrameRef.Tick, readyEv.Data.FrameRef.Tick)
	}
	if !reflect.DeepEqual(obs.FrameRef, readyEv.Data.FrameRef) {
		t.Fatalf("observation frame_ref %+v does not match post-input frame_ready %+v", obs.FrameRef, readyEv.Data.FrameRef)
	}

	var receipt struct {
		Schema     string     `json:"schema"`
		ProposalID string     `json:"proposal_id"`
		AfterFrame frames.Ref `json:"after_frame"`
		Verified   bool       `json:"verified"`
		Error      string     `json:"error"`
	}
	if err := json.Unmarshal(events[4], &receipt); err != nil {
		t.Fatalf("unmarshal action_receipt: %s (%v)", events[4], err)
	}
	if receipt.Schema != "action_receipt/v0.2" || receipt.ProposalID != "prop-agent-witness" || receipt.Verified || receipt.Error != "" {
		t.Fatalf("unexpected action_receipt: %s", events[4])
	}
	if !reflect.DeepEqual(receipt.AfterFrame, readyEv.Data.FrameRef) {
		t.Fatalf("action_receipt after_frame %+v does not match post-input frame_ready %+v", receipt.AfterFrame, readyEv.Data.FrameRef)
	}
}

func TestHoldingsWireOmitsGroundTruthOnFailedOrMalformedObserve(t *testing.T) {
	_, runner, m, _, h, sid := setupHoldingsWireFixture(t)
	policy := newWireTestPolicy(t)
	var seq uint64
	validDigest := strings.Repeat("5e", 32)

	cases := []struct {
		name       string
		observeRaw []byte
		observeErr error
	}{
		{
			name:       "observe_refusal_exit5",
			observeErr: cli.ExitFault("srf-holdings-capsule", 5, ""),
		},
		{
			name:       "tick_window_exhausted_exit6",
			observeErr: cli.ExitFault("srf-holdings-capsule", 6, ""),
		},
		{
			name:       "observe_timeout",
			observeErr: &cli.Fault{Code: "uncertain", Detail: "native command deadline or cancellation"},
		},
		{
			name:       "malformed_non_hex64_state_sha256",
			observeRaw: []byte(`{"state_sha256":"not-a-hex64-digest","tick":3}`),
		},
		{
			name:       "negative_tick",
			observeRaw: []byte(`{"state_sha256":"` + validDigest + `","tick":-1}`),
		},
		{
			name:       "overflow_tick",
			observeRaw: []byte(`{"state_sha256":"` + validDigest + `","tick":9007199254740992}`),
		},
	}

	for index, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := m.Capture(context.Background(), sid); err != nil {
				t.Fatal(err)
			}
			runner.observeRaw = tc.observeRaw
			runner.observeErr = tc.observeErr
			runner.calls = nil
			// Keep this witness-refusal test's single-capture oracle: pixels
			// repaint immediately, independently of unavailable ground truth.
			runner.framePath, runner.frameSHA = writeTestPNGNamed(t,
				filepath.Join(runner.root, "hc-0123456789ab/frames"),
				fmt.Sprintf("paint-%d.png", index), color.NRGBA{R: uint8(index + 1), A: 255})

			reqBody, _ := json.Marshal(map[string]any{
				"schema": "surface_request/v0.2",
				"op":     "input",
				"params": map[string]any{
					"surface_id":  sid,
					"proposal_id": "prop-" + tc.name,
					"origin":      "agent",
					"action":      map[string]any{"type": "key", "keys": []string{"a"}},
				},
			})
			events, err := h(context.Background(), ipc.Envelope{Body: reqBody})
			if err != nil {
				t.Fatalf("wire input failed on %s: %v", tc.name, err)
			}
			validateWireBodies(t, policy, events, &seq)

			if len(runner.calls) != 4 || runner.calls[0][1] != "observe" || runner.calls[1][1] != "input" || runner.calls[2][1] != "observe" || runner.calls[3][1] != "frame" {
				t.Fatalf("expected [observe, input, observe, frame] on %s, got %v", tc.name, runner.calls)
			}
			if len(events) != 3 {
				t.Fatalf("expected 3 events [input_applied, frame_ready, action_receipt] without observation on %s, got %d: %s", tc.name, len(events), events)
			}
			for _, raw := range events {
				if strings.Contains(string(raw), "ground_truth") || strings.Contains(string(raw), "observation/v0.2") {
					t.Fatalf("unexpected ground_truth or observation emitted on %s: %s", tc.name, raw)
				}
			}
			var receipt struct {
				Schema   string `json:"schema"`
				Verified bool   `json:"verified"`
				Error    string `json:"error"`
			}
			if err := json.Unmarshal(events[2], &receipt); err != nil || receipt.Schema != "action_receipt/v0.2" || receipt.Verified || receipt.Error != "" {
				t.Fatalf("unexpected receipt on %s: %s (%v)", tc.name, events[2], err)
			}
		})
	}
}

func TestHoldingsHumanOriginWireRefusesExtraReceiptFieldsAndOmitsGroundTruth(t *testing.T) {
	_, runner, _, _, h, sid := setupHoldingsWireFixture(t)
	policy := newWireTestPolicy(t)
	var seq uint64
	stateDigest := strings.Repeat("9a", 32)
	runner.observeRaw = []byte(`{"state_sha256":"` + stateDigest + `","tick":11}`)

	takeBody, _ := json.Marshal(map[string]any{
		"schema": "surface_request/v0.2",
		"op":     "take_control",
		"params": map[string]any{"surface_id": sid, "owner": "human"},
	})
	if _, err := h(context.Background(), ipc.Envelope{Body: takeBody}); err != nil {
		t.Fatal(err)
	}

	// Extra receipt fields on human-origin Holdings input must settle as an unverified error receipt.
	runner.inputRaw = []byte(`{"input_mono_ns":200,"result":"ok"}`)
	runner.calls = nil
	badBody, _ := json.Marshal(map[string]any{
		"schema": "surface_request/v0.2",
		"op":     "input",
		"params": map[string]any{
			"surface_id":  sid,
			"proposal_id": "human-extra-field",
			"origin":      "human",
			"action":      map[string]any{"type": "key", "keys": []string{"a"}},
		},
	})
	failedEvents, err := h(context.Background(), ipc.Envelope{Body: badBody})
	if err != nil || len(failedEvents) != 1 {
		t.Fatalf("expected 1 error receipt for human extra field, got %s (%v)", failedEvents, err)
	}
	validateWireBodies(t, policy, failedEvents, &seq)
	var errReceipt map[string]any
	if err := json.Unmarshal(failedEvents[0], &errReceipt); err != nil || errReceipt["verified"] != false || errReceipt["error"] == "" {
		t.Fatalf("expected unverified error receipt, got %s", failedEvents[0])
	}

	// Valid human-origin Holdings input must not call observe or emit ground_truth.
	runner.inputRaw = []byte(`{"input_mono_ns":200}`)
	runner.calls = nil
	okBody, _ := json.Marshal(map[string]any{
		"schema": "surface_request/v0.2",
		"op":     "input",
		"params": map[string]any{
			"surface_id":  sid,
			"proposal_id": "human-valid",
			"origin":      "human",
			"action":      map[string]any{"type": "key", "keys": []string{"a"}},
		},
	})
	okEvents, err := h(context.Background(), ipc.Envelope{Body: okBody})
	if err != nil || len(okEvents) != 2 {
		t.Fatalf("expected [input_applied, action_receipt] for human input, got %s (%v)", okEvents, err)
	}
	validateWireBodies(t, policy, okEvents, &seq)
	if len(runner.calls) != 1 || runner.calls[0][1] != "input" {
		t.Fatalf("human-origin wire input must not invoke observe, calls=%v", runner.calls)
	}
	for _, raw := range okEvents {
		if strings.Contains(string(raw), "ground_truth") || strings.Contains(string(raw), "observation/v0.2") {
			t.Fatalf("human-origin wire input emitted ground_truth: %s", raw)
		}
	}
}

type hookHoldingsWireRunner struct {
	*holdingsWireWitnessRunner
	onFrame func()
}

func (r *hookHoldingsWireRunner) Run(ctx context.Context, args []string, in []byte) ([]byte, error) {
	out, err := r.holdingsWireWitnessRunner.Run(ctx, args, in)
	if len(args) >= 2 && filepath.Base(args[0]) == "srf-holdings-capsule" && args[1] == "frame" && r.onFrame != nil {
		r.onFrame()
	}
	return out, err
}

func TestHoldingsWireSuppressesObservationWhenPublishFailsOrSurfaceInactive(t *testing.T) {
	t.Run("publish_failed_missing_png", func(t *testing.T) {
		root, runner, m, _, h, sid := setupHoldingsWireFixture(t)
		policy := newWireTestPolicy(t)
		var seq uint64
		if _, _, err := m.Capture(context.Background(), sid); err != nil {
			t.Fatal(err)
		}
		stateDigest := strings.Repeat("4b", 32)
		runner.observeRaw = []byte(`{"state_sha256":"` + stateDigest + `","tick":8}`)
		// Remove the frame PNG so post-input PublishForced fails.
		_ = os.Remove(filepath.Join(root, "hc-0123456789ab/frames/f.png"))

		reqBody, _ := json.Marshal(map[string]any{
			"schema": "surface_request/v0.2",
			"op":     "input",
			"params": map[string]any{
				"surface_id":  sid,
				"proposal_id": "prop-pub-fail",
				"origin":      "agent",
				"action":      map[string]any{"type": "key", "keys": []string{"a"}},
			},
		})
		events, err := h(context.Background(), ipc.Envelope{Body: reqBody})
		if err != nil {
			t.Fatalf("wire input returned unexpected error: %v", err)
		}
		validateWireBodies(t, policy, events, &seq)
		for _, raw := range events {
			if strings.Contains(string(raw), "observation/v0.2") || strings.Contains(string(raw), "ground_truth") {
				t.Fatalf("observation emitted after post-input publish failure: %s", raw)
			}
		}
	})

	t.Run("surface_lost_during_post_input_capture", func(t *testing.T) {
		root, baseRunner, _, _, _, _ := setupHoldingsWireFixture(t)
		policy := newWireTestPolicy(t)
		var seq uint64
		profiles := map[string]capsule.Profile{
			"game": {
				Kind:       "game_capsule",
				NativeKind: "holdings",
				AppDir:     "/opt/game",
				RAMRoot:    root,
				Display:    ":100",
				Width:      2,
				Height:     1,
			},
		}
		hookRunner := &hookHoldingsWireRunner{holdingsWireWitnessRunner: baseRunner}
		m, err := capsule.NewManager(
			capsule.Config{
				BinDir:         t.TempDir(),
				Profiles:       profiles,
				MaxSurfaces:    2,
				MaxOutputBytes: 8192,
				Timeout:        time.Second,
				OriginNS:       100,
				VerifyHoldingsInput: func(_ context.Context, _ capsule.Binding, proposal string, _ json.RawMessage, stamp uint64) error {
					if proposal == "" || stamp != 200 {
						return errors.New("invalid holdings verification args")
					}
					return nil
				},
			},
			hookRunner,
			func() uint64 { return 200 },
		)
		if err != nil {
			t.Fatal(err)
		}
		pub, err := frames.NewPublisher(frames.PublishConfig{
			RAMRoot:       root,
			MaxFrameBytes: 8192,
			MaxPixels:     2,
			MaxSurfaces:   2,
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = pub.Close() })

		h := isolatedWireHandler(t, m, profiles, map[string]*frames.Publisher{root: pub}, 100)
		createBody, _ := json.Marshal(map[string]any{
			"schema": "surface_request/v0.2",
			"op":     "create",
			"params": map[string]any{
				"kind":       "game_capsule",
				"profile_id": "game",
				"geometry":   map[string]int{"w": 2, "h": 1},
			},
		})
		created, err := h(context.Background(), ipc.Envelope{Body: createBody})
		if err != nil || len(created) != 2 {
			t.Fatalf("create failed: %s (%v)", created, err)
		}
		var createEv struct {
			Data struct {
				Surface capsule.Surface `json:"surface"`
			} `json:"data"`
		}
		if err := json.Unmarshal(created[0], &createEv); err != nil {
			t.Fatal(err)
		}
		sid := createEv.Data.Surface.SurfaceID
		baseRunner.observeRaw = []byte(`{"state_sha256":"` + strings.Repeat("6d", 32) + `","tick":12}`)
		hookRunner.onFrame = func() {
			_, _ = m.MarkLost(sid, true)
		}
		reqBody, _ := json.Marshal(map[string]any{
			"schema": "surface_request/v0.2",
			"op":     "input",
			"params": map[string]any{
				"surface_id":  sid,
				"proposal_id": "prop-lost-capture",
				"origin":      "agent",
				"action":      map[string]any{"type": "key", "keys": []string{"a"}},
			},
		})
		events, err := h(context.Background(), ipc.Envelope{Body: reqBody})
		if err != nil {
			t.Fatalf("wire input returned unexpected error: %v", err)
		}
		validateWireBodies(t, policy, events, &seq)
		for _, raw := range events {
			if strings.Contains(string(raw), "observation/v0.2") || strings.Contains(string(raw), "ground_truth") {
				t.Fatalf("observation emitted for lost surface: %s", raw)
			}
		}
	})

	t.Run("surface_inactive_before_wire_observation", func(t *testing.T) {
		root, _, _, _, _, _ := setupHoldingsWireFixture(t)
		policy := newWireTestPolicy(t)
		var seq uint64

		// Write two distinct 512x512 PNGs so post-input PublishForced cannot use sameEncoded fast path
		// and takes ~1.5ms in decodeAndVerifyPNG while Capture finishes in <5us.
		const w, hPx = 512, 512
		writePNG := func(name string, seed uint8) string {
			p := filepath.Join(root, "hc-0123456789ab/frames", name)
			f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
			if err != nil {
				t.Fatal(err)
			}
			img := image.NewNRGBA(image.Rect(0, 0, w, hPx))
			rawRGB := make([]byte, 0, w*hPx*3)
			for y := 0; y < hPx; y++ {
				for x := 0; x < w; x++ {
					rC := uint8((x + y + int(seed)) & 0xff)
					gC := uint8((x ^ int(seed)) & 0xff)
					bC := uint8((y + int(seed)*3) & 0xff)
					img.Set(x, y, color.NRGBA{R: rC, G: gC, B: bC, A: 255})
					rawRGB = append(rawRGB, rC, gC, bC)
				}
			}
			if err = png.Encode(f, img); err != nil {
				f.Close()
				t.Fatal(err)
			}
			f.Close()
			return fmt.Sprintf("%x", sha256.Sum256(rawRGB))
		}
		sha1 := writePNG("f1.png", 1)
		sha2 := writePNG("f2.png", 2)

		profiles := map[string]capsule.Profile{
			"game": {
				Kind:       "game_capsule",
				NativeKind: "holdings",
				AppDir:     "/opt/game",
				RAMRoot:    root,
				Display:    ":100",
				Width:      w,
				Height:     hPx,
			},
		}
		pub, err := frames.NewPublisher(frames.PublishConfig{
			RAMRoot:       root,
			MaxFrameBytes: 4 << 20,
			MaxPixels:     w * hPx,
			MaxSurfaces:   2,
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = pub.Close() })

		customRunner := &customDimHoldingsRunner{
			root:       root,
			w:          w,
			h:          hPx,
			fileName:   "f1.png",
			rgbSHA:     sha1,
			observeRaw: []byte(`{"state_sha256":"` + strings.Repeat("6d", 32) + `","tick":12}`),
		}
		m, err := capsule.NewManager(
			capsule.Config{
				BinDir:         t.TempDir(),
				Profiles:       profiles,
				MaxSurfaces:    2,
				MaxOutputBytes: 8192,
				Timeout:        time.Second,
				OriginNS:       100,
				VerifyHoldingsInput: func(_ context.Context, _ capsule.Binding, proposal string, _ json.RawMessage, stamp uint64) error {
					if proposal == "" || stamp != 200 {
						return errors.New("invalid holdings verification args")
					}
					return nil
				},
			},
			customRunner,
			func() uint64 { return 200 },
		)
		if err != nil {
			t.Fatal(err)
		}

		h := isolatedWireHandler(t, m, profiles, map[string]*frames.Publisher{root: pub}, 100)
		createBody, _ := json.Marshal(map[string]any{
			"schema": "surface_request/v0.2",
			"op":     "create",
			"params": map[string]any{
				"kind":       "game_capsule",
				"profile_id": "game",
				"geometry":   map[string]int{"w": w, "h": hPx},
			},
		})
		created, err := h(context.Background(), ipc.Envelope{Body: createBody})
		if err != nil || len(created) != 2 {
			t.Fatalf("create failed: %s (%v)", created, err)
		}
		var createEv struct {
			Data struct {
				Surface capsule.Surface `json:"surface"`
			} `json:"data"`
		}
		if err := json.Unmarshal(created[0], &createEv); err != nil {
			t.Fatal(err)
		}
		sid := createEv.Data.Surface.SurfaceID

		customRunner.fileName = "f2.png"
		customRunner.rgbSHA = sha2
		customRunner.onFrame = func() {
			started := make(chan struct{})
			go func() {
				close(started)
				time.Sleep(50 * time.Microsecond)
				_, _ = m.MarkLost(sid, true)
			}()
			<-started
		}

		reqBody, _ := json.Marshal(map[string]any{
			"schema": "surface_request/v0.2",
			"op":     "input",
			"params": map[string]any{
				"surface_id":  sid,
				"proposal_id": "prop-inactive-surface",
				"origin":      "agent",
				"action":      map[string]any{"type": "key", "keys": []string{"a"}},
			},
		})
		events, err := h(context.Background(), ipc.Envelope{Body: reqBody})
		if err != nil {
			t.Fatalf("wire input returned unexpected error: %v", err)
		}
		validateWireBodies(t, policy, events, &seq)
		for _, raw := range events {
			if strings.Contains(string(raw), "observation/v0.2") || strings.Contains(string(raw), "ground_truth") {
				t.Fatalf("observation emitted for lost/inactive surface: %s", raw)
			}
		}
	})
}

type customDimHoldingsRunner struct {
	root       string
	w, h       int
	fileName   string
	rgbSHA     string
	seq        uint64
	observeRaw []byte
	onFrame    func()
}

func (r *customDimHoldingsRunner) Run(_ context.Context, args []string, _ []byte) ([]byte, error) {
	if len(args) < 2 {
		return nil, errors.New("missing verb")
	}
	switch filepath.Base(args[0]) + ":" + args[1] {
	case "srf-holdings-capsule:start":
		framesDir := filepath.Join(r.root, "hc-0123456789ab/frames")
		return json.Marshal([]map[string]any{{
			"slot":        1,
			"container":   "srf-ng-hcap-hc-0123456789ab-1",
			"run_id":      "hc-0123456789ab",
			"display":     ":100",
			"width":       r.w,
			"height":      r.h,
			"lane_socket": "/tmp/lane.sock",
			"ready_line":  "HOLDINGS_READY 1 0",
			"ready_ms":    0,
			"frames_dir":  framesDir,
		}})
	case "srf-holdings-capsule:frame":
		r.seq++
		name := r.fileName
		if name == "" {
			name = "f.png"
		}
		path := filepath.Join(r.root, "hc-0123456789ab/frames", name)
		out, err := json.Marshal(map[string]any{
			"sha256_rgb24":    r.rgbSHA,
			"path":            path,
			"seq":             r.seq,
			"width":           r.w,
			"height":          r.h,
			"capture_mono_ns": 200,
			"generation":      "srf-ng-hcap-hc-0123456789ab-1",
		})
		if r.onFrame != nil {
			r.onFrame()
		}
		return out, err
	case "srf-holdings-capsule:input":
		return []byte(`{"input_mono_ns":200}`), nil
	case "srf-holdings-capsule:observe":
		return r.observeRaw, nil
	default:
		return nil, errors.New("unexpected native command")
	}
}

func TestHoldingsAgentInputWireCarriesBeforeAfterStateAndTickBinding(t *testing.T) {
	root, runner, _, _, h, sid := setupHoldingsWireFixture(t)
	policy := newWireTestPolicy(t)
	var seq uint64

	beforeDigest := "752988613fda42d018626fa551a2024dbf74fb41ce6542b7397a437072057da5"
	afterDigest := "be76c7f6428412ebd2e657d1f9f4add0818cc8d8e43694d8fc83a36d858dcce8"
	beforeState := `{"schema":"wender.state/v1","counts":{"raw":1,"nodes":1,"actionable":1}}`
	afterState := `{"schema":"wender.state/v1","counts":{"raw":2,"nodes":2,"actionable":1}}`
	runner.observeQueue = [][]byte{
		[]byte(`{"state_sha256":"` + beforeDigest + `","tick":7,"state":` + beforeState + `}`),
		[]byte(`{"state_sha256":"` + afterDigest + `","tick":11,"state":` + afterState + `}`),
	}
	runner.calls = nil

	reqBody, _ := json.Marshal(map[string]any{
		"schema": "surface_request/v0.2",
		"op":     "input",
		"params": map[string]any{
			"surface_id":  sid,
			"proposal_id": "prop-state-sidecar",
			"origin":      "agent",
			"action":      map[string]any{"type": "click", "x": 1, "y": 0, "button": "left"},
		},
	})
	events, err := h(context.Background(), ipc.Envelope{Body: reqBody})
	if err != nil {
		t.Fatalf("wire input failed: %v", err)
	}
	validateWireBodies(t, policy, events, &seq)
	if len(events) != 5 {
		t.Fatalf("expected 5 events, got %d: %s", len(events), events)
	}

	var beforeObs, afterObs struct {
		Schema      string               `json:"schema"`
		FrameRef    frames.Ref           `json:"frame_ref"`
		GroundTruth *capsule.GroundTruth `json:"ground_truth"`
	}
	if err := json.Unmarshal(events[1], &beforeObs); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(events[3], &afterObs); err != nil {
		t.Fatal(err)
	}
	if beforeObs.FrameRef.Tick != 7 || beforeObs.GroundTruth.Tick != 7 || beforeObs.GroundTruth.StateSHA256 != beforeDigest {
		t.Fatalf("before observation mismatch: %+v", beforeObs)
	}
	if afterObs.FrameRef.Tick != 11 || afterObs.GroundTruth.Tick != 11 || afterObs.GroundTruth.StateSHA256 != afterDigest {
		t.Fatalf("after observation mismatch: %+v", afterObs)
	}

	beforeSidecar, err := os.ReadFile(HoldingsStateSidecarPath(root, beforeObs.FrameRef.RAMWSPath))
	if err != nil || string(beforeSidecar) != beforeState {
		t.Fatalf("before state sidecar mismatch: %q (%v)", beforeSidecar, err)
	}
	afterSidecar, err := os.ReadFile(HoldingsStateSidecarPath(root, afterObs.FrameRef.RAMWSPath))
	if err != nil || string(afterSidecar) != afterState {
		t.Fatalf("after state sidecar mismatch: %q (%v)", afterSidecar, err)
	}
}
