package daemon

// [TARGET, unit decision] Delay only the native capture boundary. Pending input,
// drain, settlement, publication and native evidence use production code.
import (
	"context"
	"encoding/json"
	"errors"
	"image/color"
	"os"
	"strings"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

func TestSlowCaptureBudgetAndCallerDeadline(t *testing.T) {
	for _, tc := range []struct{ cost, want time.Duration }{
		{0, postInputSettleBound}, {-time.Second, postInputSettleBound},
		{20 * time.Millisecond, postInputSettleBound},
		{660 * time.Millisecond, 2790 * time.Millisecond},
		{1400 * time.Millisecond, 5750 * time.Millisecond},
		{time.Duration(1<<63 - 1), postInputSlowCaptureBound},
	} {
		if got := inputSettleBudget(tc.cost); got != tc.want {
			t.Fatalf("cost %v budget %v want %v", tc.cost, got, tc.want)
		}
	}
	if postInputSlowCaptureBound > 6*time.Second {
		t.Fatal("slow capture ceiling raised")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, frame, err := settleInput(ctx, "before", func(c context.Context) (capsule.Binding, capsule.NativeFrame, error) {
		if err := waitInputCapture(c, 660*time.Millisecond); err != nil {
			return capsule.Binding{}, capsule.NativeFrame{}, err
		}
		t.Fatal("capture exceeded caller deadline")
		return capsule.Binding{}, capsule.NativeFrame{}, nil
	}, time.Now, waitInputCapture)
	if !errors.Is(err, context.DeadlineExceeded) || frame.Seq != 0 || time.Since(start) > time.Second {
		t.Fatalf("caller deadline lost or evidence invented: frame=%+v err=%v", frame, err)
	}
}

type slowCaptureRunner struct {
	delayedPaintRunner
	latency      time.Duration
	tailLatency  time.Duration
	pendingProbe func()
}

func (r *slowCaptureRunner) Run(ctx context.Context, argv []string, stdin []byte) ([]byte, error) {
	if argv[1] == "input" && r.pendingProbe != nil {
		r.pendingProbe()
	}
	if argv[1] == "frame" {
		delay := r.latency
		if r.input && r.captures > 0 && r.tailLatency > 0 {
			delay = r.tailLatency
		}
		if err := waitInputCapture(ctx, delay); err != nil {
			return nil, err
		}
	}
	return r.delayedPaintRunner.Run(ctx, argv, stdin)
}

func TestSlowCapturePreservesPostInputEvidence(t *testing.T) {
	for _, tc := range []struct {
		name, action  string
		latency, tail time.Duration
	}{
		{"click-660", "click", 660 * time.Millisecond, 0},
		{"type-1100", "type", 1100 * time.Millisecond, 0},
		{"key-1400", "key", 1400 * time.Millisecond, 0},
		{"click-1700", "click", 1700 * time.Millisecond, 0},
		{"click-variable", "click", 660 * time.Millisecond, 1400 * time.Millisecond},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root, err := os.MkdirTemp("/dev/shm", "mv-slow-evidence-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.RemoveAll(root) })
			path, sha := writeTestPNG(t, root)
			after, afterSHA := writeTestPNGNamed(t, root, "after.png", color.NRGBA{R: 120, A: 255})
			r := &slowCaptureRunner{delayedPaintRunner: delayedPaintRunner{postInputTestRunner: postInputTestRunner{pngPath: path, sha: sha}, afterPath: after, afterSHA: afterSHA, action: tc.action}, latency: tc.latency, tailLatency: tc.tail}
			profiles := map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1}}
			origin := monotonic()
			m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: profiles, MaxSurfaces: 1, MaxOutputBytes: 8192, Timeout: 8 * time.Second, OriginNS: origin}, r, monotonic)
			if err != nil {
				t.Fatal(err)
			}
			p, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 8192, MaxPixels: 64, MaxSurfaces: 4})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = p.Close() })
			h := wireHandler(m, profiles, map[string]*frames.Publisher{root: p}, origin)
			events, err := h(context.Background(), ipc.Envelope{MsgID: "create", Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"create","params":{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}}`)})
			if err != nil || len(events) < 2 {
				t.Fatalf("create: %s %v", events, err)
			}
			var created struct {
				Data struct {
					Surface capsule.Surface `json:"surface"`
				} `json:"data"`
			}
			if err := json.Unmarshal(events[0], &created); err != nil {
				t.Fatal(err)
			}
			id := created.Data.Surface.SurfaceID
			r.pendingProbe = func() {
				_, _, err := m.Capture(context.Background(), id)
				if err == nil || !strings.Contains(err.Error(), "input must be drained") {
					t.Fatalf("pending capture accepted: %v", err)
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
			defer cancel()
			action := `{"type":"click","x":1,"y":0,"button":"left"}`
			if tc.action == "type" {
				action = `{"type":"type","text":"hello"}`
			}
			if tc.action == "key" {
				action = `{"type":"key","keys":["Enter"]}`
			}
			events, err = h(ctx, ipc.Envelope{MsgID: "input", Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"input","params":{"surface_id":"` + id + `","proposal_id":"slow","action":` + action + `}}`)})
			if err != nil || len(events) != 3 {
				t.Fatalf("SLOW_CAPTURE_EVIDENCE: input: %s %v", events, err)
			}
			var receipt struct {
				After    frames.Ref            `json:"after_frame"`
				Evidence capsule.InputEvidence `json:"native_evidence"`
				Verified bool                  `json:"verified"`
				Error    string                `json:"error"`
			}
			if err := json.Unmarshal(events[2], &receipt); err != nil {
				t.Fatal(err)
			}
			if receipt.Error != "" || receipt.Verified || receipt.After.SHA256 != afterSHA || receipt.Evidence.InputMonoNS == 0 || receipt.After.TsNS < receipt.Evidence.InputTSNS || (receipt.Evidence.FocusVerified == nil || !*receipt.Evidence.FocusVerified) || r.inputs != 1 {
				t.Fatalf("SLOW_CAPTURE_EVIDENCE: missing post-input effect/evidence: %s", events[2])
			}
		})
	}
}
