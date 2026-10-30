package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"image/color"
	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSettleInputSequence(t *testing.T) {
	for _, tc := range []struct {
		name     string
		changeAt int
	}{{"delayed-paint", 2}, {"already-painted", 1}, {"never-changes", 0}} {
		t.Run(tc.name, func(t *testing.T) {
			start := time.Unix(0, 0)
			clock := start
			count := 0
			var captures []time.Time
			capture := func(ctx context.Context) (capsule.Binding, capsule.NativeFrame, error) {
				if _, ok := ctx.Deadline(); !ok {
					t.Fatal("capture missing deadline")
				}
				count++
				captures = append(captures, clock)
				sha := "before"
				if tc.changeAt > 0 && count >= tc.changeAt {
					sha = "after"
				}
				return capsule.Binding{}, capsule.NativeFrame{Seq: uint64(count), SHA256RGB24: sha}, nil
			}
			wait := func(_ context.Context, d time.Duration) error { clock = clock.Add(d); return nil }
			_, frame, err := settleInput(context.Background(), "before", capture, func() time.Time { return clock }, wait)
			if err != nil {
				t.Fatal(err)
			}
			if tc.changeAt > 0 && (count != tc.changeAt || frame.SHA256RGB24 != "after") {
				t.Fatalf("delayed paint not settled: captures=%d frame=%+v", count, frame)
			}
			if tc.changeAt == 0 && (frame.SHA256RGB24 != "before" || count < 2 || frame.Seq != uint64(count)) {
				t.Fatalf("timeout invented change or lost last capture: %+v count=%d", frame, count)
			}
			if clock.Sub(start) > 1500*time.Millisecond || postInputSettleBound > 1500*time.Millisecond {
				t.Fatal("MUT-SETTLE-UNBOUNDED: deadline exceeds 1500ms")
			}
			for i := 1; i < len(captures); i++ {
				if captures[i].Sub(captures[i-1]) < 50*time.Millisecond {
					t.Fatal("capture interval below 50ms")
				}
			}
		})
	}
}
func TestSettleCaptureDeadlineAndCancellation(t *testing.T) {
	start := time.Now()
	capture := func(ctx context.Context) (capsule.Binding, capsule.NativeFrame, error) {
		<-ctx.Done()
		return capsule.Binding{}, capsule.NativeFrame{}, ctx.Err()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, _, err := settleInput(ctx, "before", capture, time.Now, waitInputCapture)
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > time.Second {
		t.Fatalf("cancellation ignored: %v", err)
	}
}
func TestDecodeTextInputModes(t *testing.T) {
	for _, mode := range []string{"", "type", "paste", "bad", "Paste", " paste"} {
		var profiles map[string]capsule.Profile
		err := decodeProfiles(`{"demo":{"text_input":"`+mode+`"}}`, &profiles)
		valid := mode == "" || mode == "type" || mode == "paste"
		if (err == nil) != valid {
			t.Fatalf("profile mode %q: %v", mode, err)
		}
	}
}

// Native boundary only: all drain, epoch, capture and receipt code is production.
type delayedPaintRunner struct {
	postInputTestRunner
	afterPath, afterSHA string
	action, mode        string
	input               bool
	captures            int
	never               bool
}

func (r *delayedPaintRunner) Run(ctx context.Context, argv []string, stdin []byte) ([]byte, error) {
	if argv[1] == "input" {
		r.input = true
		r.captures = 0
		r.mode = "type"
		for _, arg := range argv {
			if arg == "--paste" {
				r.mode = "paste"
			}
		}
		kind := r.action
		if kind == "type" {
			kind = "text"
		}
		return json.Marshal(map[string]any{"surface_id": "w1", "kind": kind, "input_mono_ns": monotonic(), "focus_verified": true, "result": "ok"})
	}
	if argv[1] == "frame" && r.input {
		r.captures++
		if !r.never && (r.captures > 1 || r.mode == "paste") {
			r.pngPath = r.afterPath
			r.sha = r.afterSHA
		}
	}
	return r.postInputTestRunner.Run(ctx, argv, stdin)
}
func TestPostInputDelayedPaint(t *testing.T) {
	for _, tc := range []struct {
		name, action, mode string
		never              bool
	}{
		{"type-delayed", "type", "type", false}, {"paste", "type", "paste", false},
		{"key-delayed", "key", "type", false}, {"unchanged-timeout", "type", "type", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root, err := os.MkdirTemp("/dev/shm", "mv-settle-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.RemoveAll(root) })
			path, sha := writeTestPNG(t, root)
			afterPath, afterSHA := writeTestPNGNamed(t, root, "after.png", color.NRGBA{R: 120, G: 80, B: 40, A: 255})
			runner := &delayedPaintRunner{postInputTestRunner: postInputTestRunner{pngPath: path, sha: sha}, afterPath: afterPath, afterSHA: afterSHA, action: tc.action, never: tc.never}
			profiles := map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1, TextInput: tc.mode}}
			origin := monotonic()
			m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: profiles, MaxSurfaces: 1, MaxOutputBytes: 8192, Timeout: 5 * time.Second, OriginNS: origin}, runner, monotonic)
			if err != nil {
				t.Fatal(err)
			}
			pub, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 8192, MaxPixels: 64, MaxSurfaces: 4})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = pub.Close() })
			handler := wireHandler(m, profiles, map[string]*frames.Publisher{root: pub}, origin)
			events, err := handler(context.Background(), ipc.Envelope{MsgID: "create", Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"create","params":{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}}`)})
			if err != nil || len(events) < 2 {
				t.Fatalf("create: %s %v", events, err)
			}
			var created struct {
				Data struct {
					Surface capsule.Surface `json:"surface"`
				} `json:"data"`
			}
			_ = json.Unmarshal(events[0], &created)
			id := created.Data.Surface.SurfaceID
			action := `{"type":"type","text":"hello"}`
			if tc.action == "key" {
				action = `{"type":"key","keys":["ctrl","l"]}`
			}
			events, err = handler(context.Background(), ipc.Envelope{MsgID: "input", Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"input","params":{"surface_id":"` + id + `","proposal_id":"p1","action":` + action + `}}`)})
			if err != nil || len(events) != 3 {
				t.Fatalf("input: %s %v", events, err)
			}
			var receipt struct {
				After    frames.Ref `json:"after_frame"`
				Verified bool       `json:"verified"`
				Error    string     `json:"error"`
			}
			if err := json.Unmarshal(events[2], &receipt); err != nil {
				t.Fatal(err)
			}
			if receipt.Error != "" || receipt.Verified {
				t.Fatalf("receipt bypassed core verification: %s", events[2])
			}
			want := afterSHA
			if tc.never {
				want = sha
			}
			if receipt.After.SHA256 != want {
				t.Fatalf("VERIFICATION_FAILED: wrong post-input sha=%s want=%s captures=%d", receipt.After.SHA256, want, runner.captures)
			}
			if tc.action == "type" && runner.mode != tc.mode {
				t.Fatalf("input mode=%s want=%s", runner.mode, tc.mode)
			}
			if !tc.never && tc.mode == "type" && runner.captures < 2 {
				t.Fatal("MUT-NO-SETTLE: delayed paint not captured")
			}
		})
	}
}
func TestLiveTextInputConfiguration(t *testing.T) {
	for _, mode := range []string{"", "type", "paste", "bad", "Paste", " paste"} {
		t.Run(mode, func(t *testing.T) {
			nvEnvironment(t)
			t.Setenv("MV_SRF_LIVE_TEXT_INPUT", mode)
			runtime, err := RuntimeFromEnv()
			if err == nil {
				defer runtime.Close()
			}
			valid := mode == "" || mode == "type" || mode == "paste"
			if (err == nil) != valid {
				t.Fatalf("live mode %q: %v", mode, err)
			}
			if !valid && !strings.Contains(err.Error(), "MV_SRF_LIVE_TEXT_INPUT") {
				t.Fatalf("live mode refusal lost configuration diagnostic: %v", err)
			}
		})
	}
}

func TestSettleSourceMutants(t *testing.T) {
	// Go overlays mutate production code without changing this worktree.
	sourcePath, err := filepath.Abs("environment.go")
	if err != nil {
		t.Fatal(err)
	}
	source, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, before, after, test, diagnostic string }{
		{"MUT-NO-SETTLE", "binding, native, err = settleInput(ctx, baseline.SHA256, capture, time.Now, waitInputCapture)", "binding, native, err = capture(ctx)", "TestPostInputDelayedPaint/type-delayed$", "VERIFICATION_FAILED"},
		{"MUT-SETTLE-UNBOUNDED", "postInputSettleBound = 1500 * time.Millisecond", "postInputSettleBound = 1501 * time.Millisecond", "TestSettleInputSequence/never-changes$", "MUT-SETTLE-UNBOUNDED"},
		{"MUT-SETTLE-PUBLISHES-BEFORE", `"after_frame": ref, "native_evidence": wireEvidence`, `"after_frame": baseline, "native_evidence": wireEvidence`, "TestPostInputDelayedPaint/type-delayed$", "VERIFICATION_FAILED"},
		{"MUT-PASTE-MODE-INVALID-live", `if !capsule.ValidTextInput(mode) {`, `if false {`, "TestLiveTextInputConfiguration/bad$", "live mode"},
		{"MUT-PASTE-MODE-INVALID-profile", `if !capsule.ValidTextInput(profile.TextInput) {`, `if !capsule.ValidTextInput(profile.TextInput) && false {`, "TestDecodeTextInputModes$", "profile mode"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if strings.Count(string(source), tc.before) != 1 {
				t.Fatal("mutation anchor must be unique")
			}
			dir := t.TempDir()
			replacement := filepath.Join(dir, "environment.go")
			if err := os.WriteFile(replacement, []byte(strings.Replace(string(source), tc.before, tc.after, 1)), 0600); err != nil {
				t.Fatal(err)
			}
			overlay := filepath.Join(dir, "overlay.json")
			raw, _ := json.Marshal(map[string]any{"Replace": map[string]string{sourcePath: replacement}})
			if err := os.WriteFile(overlay, raw, 0600); err != nil {
				t.Fatal(err)
			}
			goTool, err := exec.LookPath("go")
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, goTool, "test", "-count=1", "-overlay", overlay, "-run", "^"+tc.test, ".")
			output, err := cmd.CombinedOutput()
			var exit *exec.ExitError
			if ctx.Err() != nil || !errors.As(err, &exit) || exit.ExitCode() != 1 || !strings.Contains(string(output), "--- FAIL:") || !strings.Contains(string(output), tc.diagnostic) {
				t.Fatalf("mutation survived or failed outside assertion: %v\n%s", err, output)
			}
			t.Logf("KILLED %s: %s", tc.name, output)
		})
	}
}
