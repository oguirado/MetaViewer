package daemon

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
	"metaviewer/daemon-adapter/internal/ipc"
)

// damRunner is a native CLI double that honors context cancellation the way
// ProcessRunner does: a cancelled call returns the uncertain fault, no output.
type damRunner struct {
	mu          sync.Mutex
	startDelay  time.Duration // 0: instant; negative: never finishes on its own
	startedOnce sync.Once
	started     chan struct{}
	startCancel bool            // a start observed its context cancelled mid-flight
	active      map[string]bool // containers started and not yet stopped
	hangStops   int             // the first N stop calls block until their context ends
	stopCalls   int
	deadStops   int // stop invoked with an already-cancelled context
	startErr    error
}

func newDamRunner() *damRunner {
	return &damRunner{started: make(chan struct{}), active: map[string]bool{}}
}

func (r *damRunner) Run(ctx context.Context, argv []string, _ []byte) ([]byte, error) {
	switch argv[1] {
	case "start":
		r.startedOnce.Do(func() { close(r.started) })
		if r.startErr != nil {
			return nil, r.startErr
		}
		if r.startDelay != 0 {
			var wait <-chan time.Time
			if r.startDelay > 0 {
				timer := time.NewTimer(r.startDelay)
				defer timer.Stop()
				wait = timer.C
			}
			select {
			case <-wait:
			case <-ctx.Done():
				r.mu.Lock()
				r.startCancel = true
				r.mu.Unlock()
				return nil, &cli.Fault{Code: "uncertain", Detail: "native command deadline or cancellation"}
			}
		}
		var random [6]byte
		if _, err := rand.Read(random[:]); err != nil {
			return nil, err
		}
		id := fmt.Sprintf("srf-id-%x", random)
		r.mu.Lock()
		r.active[id] = true
		r.mu.Unlock()
		return []byte(fmt.Sprintf(`{"container":"%s","run_id":"run","windows":[{"id":"w1","w":2,"h":1}]}`, id)), nil
	case "stop":
		container := ""
		for i, v := range argv {
			if v == "--container" && i+1 < len(argv) {
				container = argv[i+1]
			}
		}
		r.mu.Lock()
		r.stopCalls++
		hang := r.stopCalls <= r.hangStops
		if ctx.Err() != nil {
			r.deadStops++
		}
		r.mu.Unlock()
		if hang {
			<-ctx.Done()
			return nil, &cli.Fault{Code: "uncertain", Detail: "native command deadline or cancellation"}
		}
		r.mu.Lock()
		delete(r.active, container)
		r.mu.Unlock()
		return []byte(fmt.Sprintf(`{"stopped":"%s","removed_verified":true}`, container)), nil
	}
	return nil, fmt.Errorf("unexpected %v", argv)
}

func (r *damRunner) snapshot() (cancelled bool, active, dead int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.startCancel, len(r.active), r.deadStops
}

// damHandler builds the admitted handler over a bare manager (no frame publisher)
// with an abundant memory reading, and a private shared admission directory.
func damHandler(t *testing.T, r cli.Runner) (*capsule.Manager, ipc.Handler, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "shared")
	t.Setenv("MV_RAM_ADMISSION_DIR", dir)
	root, err := os.MkdirTemp("/dev/shm", "mv-dam-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	profiles := map[string]capsule.Profile{}
	for i, id := range []string{"pair-a", "pair-b", "pair-c"} {
		profiles[id] = capsule.Profile{Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: fmt.Sprintf(":%d", 100+i), Width: 2, Height: 1}
	}
	m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: profiles, MaxSurfaces: 16, MaxOutputBytes: 8192, Timeout: 30 * time.Second, OriginNS: 1}, r, monotonic)
	if err != nil {
		t.Fatal(err)
	}
	next := func(ctx context.Context, e ipc.Envelope) ([]json.RawMessage, error) {
		var q capsule.Request
		_ = json.Unmarshal(e.Body, &q)
		events, err := m.Handle(ctx, q)
		if err != nil {
			return wireFailure(e, q, err)
		}
		return events, nil
	}
	h := admittedHandler(m, next, func() (ramMemory, error) {
		return ramMemory{available: 100 * 1024 * 1024, total: 121 * 1024 * 1024}, nil
	})
	return m, h, dir
}

func damCall(ctx context.Context, h ipc.Handler, op string, params any) []json.RawMessage {
	body, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": op, "params": params})
	out, err := h(ctx, ipc.Envelope{Body: body})
	if err != nil {
		panic(err)
	}
	return out
}

func damCreate(ctx context.Context, h ipc.Handler, profile string) []json.RawMessage {
	return damCall(ctx, h, "create", map[string]any{"kind": "browser", "profile_id": profile, "geometry": map[string]int{"w": 2, "h": 1}})
}

// errorEvent returns code and detail of the single surface_event error, or fails.
func errorEvent(t *testing.T, out []json.RawMessage) (string, string) {
	t.Helper()
	if len(out) != 1 {
		t.Fatalf("expected one event: %s", out)
	}
	var ev struct {
		Event string
		Data  struct{ Code, Detail string }
	}
	if json.Unmarshal(out[0], &ev) != nil || ev.Event != "error" {
		t.Fatalf("expected error event: %s", out[0])
	}
	return ev.Data.Code, ev.Data.Detail
}

func createdID(t *testing.T, out []json.RawMessage) string {
	t.Helper()
	var ev struct {
		Event string
		Data  struct{ Surface capsule.Surface }
	}
	if len(out) == 0 || json.Unmarshal(out[0], &ev) != nil || ev.Event != "created" {
		t.Fatalf("expected created: %s", out)
	}
	return ev.Data.Surface.SurfaceID
}

func reservationCount(t *testing.T, dir string) int {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	return len(entries)
}

func setCreateGrace(t *testing.T, d time.Duration) {
	t.Helper()
	old := createGrace
	createGrace = d
	t.Cleanup(func() { createGrace = old })
}

// ---- QC-01: quit during a pending create ----

func TestGraceContextSurvivesParentCancelThenExpires(t *testing.T) {
	type key struct{}
	parent, cancelParent := context.WithCancel(context.WithValue(context.Background(), key{}, "v"))
	ctx, cancel := graceContext(parent, 150*time.Millisecond)
	defer cancel()
	if ctx.Value(key{}) != "v" {
		t.Fatal("parent values lost")
	}
	cancelParent()
	time.Sleep(50 * time.Millisecond)
	if ctx.Err() != nil {
		t.Fatalf("cancelled before the grace elapsed: %v", ctx.Err())
	}
	select {
	case <-ctx.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("grace never expired")
	}
}

func TestGraceContextReleasesOnCancelAndKeepsUncancelledParentOpen(t *testing.T) {
	parent, cancelParent := context.WithCancel(context.Background())
	defer cancelParent()
	ctx, cancel := graceContext(parent, time.Hour)
	if ctx.Err() != nil {
		t.Fatal("cancelled without a parent cancellation")
	}
	cancel()
	if ctx.Err() == nil {
		t.Fatal("cancel did not release the context")
	}
	// Parent cancelled after release must not panic or resurrect anything.
	cancelParent()
}

func TestQuitDuringCreateLetsStartFinishAndShutdownReleasesReservation(t *testing.T) {
	r := newDamRunner()
	r.startDelay = 200 * time.Millisecond
	m, h, dir := damHandler(t, r)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { <-r.started; cancel() }() // the quit arrives while the native start runs
	out := damCreate(ctx, h, "pair-a")
	if cancelled, _, _ := r.snapshot(); cancelled {
		t.Fatal("QC-01: the quit killed the in-flight native start")
	}
	createdID(t, out)
	if reservationCount(t, dir) != 1 {
		t.Fatalf("expected the live capsule's reservation: %d", reservationCount(t, dir))
	}
	// The shutdown path the adapter runs after the session ends.
	s := &helloState{manager: m, handler: h}
	if err := s.closeManager(context.Background()); err != nil {
		t.Fatalf("closeManager: %v", err)
	}
	if _, active, _ := r.snapshot(); active != 0 {
		t.Fatalf("capsule survived the quit: %d active", active)
	}
	if n := reservationCount(t, dir); n != 0 || len(m.AdmissionProfiles()) != 0 {
		t.Fatalf("QC-01: reservation leaked after a clean quit: %d records, %v", n, m.AdmissionProfiles())
	}
}

// Negative control and mutant: with the grace removed the legacy behavior returns
// (start killed, quarantine and reservation retained), so the test above is not vacuous.
func TestQuitDuringCreateWithoutGraceLeaksReservation(t *testing.T) {
	setCreateGrace(t, 0) // MUT-QC01-NO-GRACE
	r := newDamRunner()
	r.startDelay = 2 * time.Second
	m, h, dir := damHandler(t, r)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { <-r.started; cancel() }()
	damCreate(ctx, h, "pair-a")
	if cancelled, _, _ := r.snapshot(); !cancelled {
		t.Fatal("mutant did not reproduce the killed start")
	}
	if reservationCount(t, dir) != 1 || !m.AdmissionProfiles()["pair-a"] {
		t.Fatalf("legacy leak not reproduced: %d records, %v", reservationCount(t, dir), m.AdmissionProfiles())
	}
}

// The grace is bounded: a start that never finishes is still cut, within the shutdown budget.
func TestQuitDuringCreateGraceIsBounded(t *testing.T) {
	setCreateGrace(t, 150*time.Millisecond)
	r := newDamRunner()
	r.startDelay = -1
	_, h, _ := damHandler(t, r)
	ctx, cancel := context.WithCancel(context.Background())
	var quit time.Time
	go func() { <-r.started; quit = time.Now(); cancel() }()
	damCreate(ctx, h, "pair-a")
	elapsed := time.Since(quit)
	if cancelled, _, _ := r.snapshot(); !cancelled {
		t.Fatal("hung start was never cut")
	}
	if elapsed < 100*time.Millisecond || elapsed > 3*time.Second {
		t.Fatalf("cut %v after the quit, want about the 150ms grace", elapsed)
	}
}

// An un-cancelled session behaves exactly as before: the grace never shortens or extends a create.
func TestCreateWithoutQuitIsUnchanged(t *testing.T) {
	r := newDamRunner()
	_, h, dir := damHandler(t, r)
	createdID(t, damCreate(context.Background(), h, "pair-a"))
	if reservationCount(t, dir) != 1 {
		t.Fatal("reservation missing")
	}
}

// Refusal hint: foreign reservation records are named and the documented recovery is cited.
func TestRAMRefusalNamesForeignReservationsAndReclaim(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "shared")
	t.Setenv("MV_RAM_ADMISSION_DIR", dir)
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "999-deadowner-"+strings.Repeat("a", 64)+"--pair-a"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	_, h := bareAdmissionManager(t, false)
	code, detail := errorEvent(t, admissionCreate(h, "pair-b"))
	if code != "RAM_ADMISSION_REFUSED" {
		t.Fatalf("code %q", code)
	}
	for _, want := range []string{"MemAvailable below floor", "records counted: 1", "1 belong to other owners", "reclaim --dry-run"} {
		if !strings.Contains(detail, want) {
			t.Errorf("detail lacks %q: %s", want, detail)
		}
	}
}

// Negative control: a refusal caused only by this daemon's own reservations carries no reclaim advice.
func TestRAMRefusalOwnReservationsGetNoReclaimHint(t *testing.T) {
	t.Setenv("MV_RAM_ADMISSION_DIR", filepath.Join(t.TempDir(), "shared"))
	_, h := bareAdmissionManager(t, false)
	if out := admissionCreate(h, "pair-a"); !strings.Contains(string(out[0]), `"event":"created"`) {
		t.Fatalf("first create: %s", out)
	}
	code, detail := errorEvent(t, admissionCreate(h, "pair-b"))
	if code != "RAM_ADMISSION_REFUSED" || !strings.Contains(detail, "records counted: 1") {
		t.Fatalf("code %q detail %s", code, detail)
	}
	if strings.Contains(detail, "other owners") || strings.Contains(detail, "reclaim") {
		t.Fatalf("own reservation produced reclaim advice: %s", detail)
	}
}

func TestWithReclaimHintKeepsFaultCodeAndPassesOtherErrors(t *testing.T) {
	plain := errors.New("plain")
	if got := withReclaimHint(plain, 3, 2); got != plain {
		t.Fatal("non-fault error rewritten")
	}
	got := withReclaimHint(&cli.Fault{Code: "RAM_ADMISSION_REFUSED", Detail: "d"}, 3, 2)
	var f *cli.Fault
	if !errors.As(got, &f) || f.Code != "RAM_ADMISSION_REFUSED" {
		t.Fatalf("code changed: %v", got)
	}
}

// ---- close-F2: stable uppercase wire codes ----

func TestWireFailureEmitsUppercaseCodeAndKeepsDetail(t *testing.T) {
	q := capsule.Request{Params: json.RawMessage(`{"surface_id":"s1"}`)}
	for _, tc := range []struct {
		err        error
		code, part string
	}{
		{&cli.Fault{Code: "binding", Detail: "profile already bound"}, "PROFILE_ALREADY_BOUND", "profile already bound"},
		{&cli.Fault{Code: "uncertain", Detail: "surface capacity or unresolved native outcome"}, "SURFACE_CAPACITY_OR_QUARANTINE", "surface capacity"},
		{&cli.Fault{Code: "identity_unavailable", Detail: "held"}, "IDENTITY_UNAVAILABLE", "held"},
		{&cli.Fault{Code: "RAM_ADMISSION_REFUSED", Detail: "ram"}, "RAM_ADMISSION_REFUSED", "ram"},
		{errors.New("boom"), "ADAPTER_ERROR", "boom"},
	} {
		code, detail := errorEvent(t, mustWire(t, q, tc.err))
		if code != tc.code || !strings.Contains(detail, tc.part) {
			t.Errorf("%v: code %q detail %q, want %q containing %q", tc.err, code, detail, tc.code, tc.part)
		}
	}
}

func mustWire(t *testing.T, q capsule.Request, err error) []json.RawMessage {
	t.Helper()
	out, e := wireFailure(ipc.Envelope{MsgID: "m1"}, q, err)
	if e != nil {
		t.Fatal(e)
	}
	return out
}

// End to end through the admitted handler: the same-profile second create is
// refused with the real reason on the wire (the exact close-F2 trigger).
func TestSecondCreateOfBoundProfileCarriesRealReasonOnWire(t *testing.T) {
	r := newDamRunner()
	_, h, _ := damHandler(t, r)
	createdID(t, damCreate(context.Background(), h, "pair-a"))
	code, detail := errorEvent(t, damCreate(context.Background(), h, "pair-a"))
	if code != "PROFILE_ALREADY_BOUND" || !strings.Contains(detail, "profile already bound") {
		t.Fatalf("code %q detail %q", code, detail)
	}
}

// ---- QC-03: shutdown budgets and fair stop slices ----

func TestStopSliceFairShareAndFloor(t *testing.T) {
	const floor = 10 * time.Second
	for _, tc := range []struct {
		remaining time.Duration
		queued    int
		want      time.Duration
	}{
		{30 * time.Second, 1, 30 * time.Second},
		{30 * time.Second, 2, 15 * time.Second},
		{30 * time.Second, 16, 10 * time.Second}, // floor: a hung stop leaves each queued one a real chance
		{4 * time.Second, 3, 4 * time.Second},    // floor never exceeds what remains
		{0, 2, 0},
		{-time.Second, 2, 0},
		{time.Second, 0, 0},
	} {
		if got := stopSlice(tc.remaining, tc.queued, floor); got != tc.want {
			t.Errorf("stopSlice(%v,%d) = %v, want %v", tc.remaining, tc.queued, got, tc.want)
		}
	}
}

// Read the host's actual wire configuration, accepting either the original
// numeric literal or PKG-FIX's named constant. Missing/ambiguous pins fail closed.
func hostShutdownGrace(source string) (time.Duration, error) {
	values := regexp.MustCompile(`\bshutdownTimeoutMs\s*:\s*([0-9]+|ADAPTER_SHUTDOWN_GRACE_MS)\b`).FindAllStringSubmatch(source, -1)
	if len(values) != 1 {
		return 0, fmt.Errorf("expected one shutdownTimeoutMs pin, got %d", len(values))
	}
	value := values[0][1]
	if value == "ADAPTER_SHUTDOWN_GRACE_MS" {
		constants := regexp.MustCompile(`\bconst\s+ADAPTER_SHUTDOWN_GRACE_MS\s*=\s*([0-9]+)\s*;`).FindAllStringSubmatch(source, -1)
		if len(constants) != 1 {
			return 0, errors.New("ADAPTER_SHUTDOWN_GRACE_MS numeric constant missing or ambiguous")
		}
		value = constants[0][1]
	}
	ms, err := strconv.ParseInt(value, 10, 64)
	if err != nil || ms <= 0 || ms > int64((1<<63-1)/time.Millisecond) {
		return 0, fmt.Errorf("invalid shutdownTimeoutMs %q", value)
	}
	return time.Duration(ms) * time.Millisecond, nil
}

func TestHostShutdownGracePins(t *testing.T) {
	for _, tc := range []struct {
		name, source string
		want         time.Duration
	}{
		{"literal", "limits: {shutdownTimeoutMs: 30000}", 30 * time.Second},
		{"PKG-FIX constant", "const ADAPTER_SHUTDOWN_GRACE_MS = 45000; limits: {shutdownTimeoutMs: ADAPTER_SHUTDOWN_GRACE_MS}", 45 * time.Second},
		{"missing", "limits: {}", 0},
		{"unresolved", "limits: {shutdownTimeoutMs: ADAPTER_SHUTDOWN_GRACE_MS}", 0},
		{"ambiguous", "shutdownTimeoutMs: 30000, shutdownTimeoutMs: 45000", 0},
		{"zero", "shutdownTimeoutMs: 0", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := hostShutdownGrace(tc.source)
			if tc.want == 0 {
				if err == nil {
					t.Fatal("invalid host pin accepted")
				}
			} else if err != nil || got != tc.want {
				t.Fatalf("grace = %v, %v; want %v", got, err, tc.want)
			}
		})
	}
}

// The IPC wait and subscription close run before closeManager. Pin their real
// configuration too, so this parity check cannot silently omit either stage.
func TestShutdownBudgetsStaggerBelowHostGrace(t *testing.T) {
	hostSource, err := os.ReadFile(filepath.Join("..", "..", "..", "ui", "electron", "main.js"))
	if err != nil {
		t.Fatal(err)
	}
	hostGrace, err := hostShutdownGrace(string(hostSource))
	if err != nil {
		t.Fatal(err)
	}
	adapterSource, err := os.ReadFile("environment.go")
	if err != nil {
		t.Fatal(err)
	}
	configTimeout := func(config string) time.Duration {
		t.Helper()
		pins := regexp.MustCompile(regexp.QuoteMeta(config)+`\{[^\n]*\bShutdownTimeout:\s*([0-9]+)\s*\*\s*time.Second\b`).FindAllStringSubmatch(string(adapterSource), -1)
		if len(pins) != 1 {
			t.Fatalf("expected one %s ShutdownTimeout pin, got %d", config, len(pins))
		}
		seconds, err := strconv.ParseInt(pins[0][1], 10, 32)
		if err != nil || seconds <= 0 {
			t.Fatalf("invalid %s ShutdownTimeout %q", config, pins[0][1])
		}
		return time.Duration(seconds) * time.Second
	}
	ipcWait := configTimeout("ipc.Config")
	subscriptionClose := configTimeout("frames.SubscriptionConfig")
	worstStop := ipcWait + subscriptionClose + closeManagerBudget
	t.Logf("shutdown parity: IPC %v + subscription close %v + manager %v = %v; host %v", ipcWait, subscriptionClose, closeManagerBudget, worstStop, hostGrace)
	if worstStop >= hostGrace {
		t.Fatalf("PKG-FIX required companion: host shutdownTimeoutMs grace %v must exceed adapter worst-case stop %v (IPC %v + subscription close %v + closeManager %v); do not lower adapter budgets", hostGrace, worstStop, ipcWait, subscriptionClose, closeManagerBudget)
	}
	if closeManagerBudget+createQuitGrace > shutdownBudgetCeiling {
		t.Fatalf("create grace %v + close budget %v exceed the ceiling %v", createQuitGrace, closeManagerBudget, shutdownBudgetCeiling)
	}
	if minStopSlice > closeManagerBudget || createQuitGrace <= 0 {
		t.Fatal("slice floor or create grace outside the budget")
	}
}

func twoCapsules(t *testing.T, r *damRunner) (*capsule.Manager, ipc.Handler, string) {
	t.Helper()
	m, h, dir := damHandler(t, r)
	createdID(t, damCreate(context.Background(), h, "pair-a"))
	createdID(t, damCreate(context.Background(), h, "pair-b"))
	if _, active, _ := r.snapshot(); active != 2 {
		t.Fatalf("setup: %d active", active)
	}
	return m, h, dir
}

func TestCloseManagerHungStopDoesNotStarveTheNextCapsule(t *testing.T) {
	r := newDamRunner()
	r.hangStops = 1
	m, h, _ := twoCapsules(t, r)
	s := &helloState{manager: m, handler: h, closeBudget: 600 * time.Millisecond, minStopSlice: 50 * time.Millisecond}
	started := time.Now()
	err := s.closeManager(context.Background())
	if err == nil {
		t.Fatal("hung stop reported as success")
	}
	if _, active, _ := r.snapshot(); active != 1 {
		t.Fatalf("the capsule queued behind the hung stop was starved: %d active, want 1", active)
	}
	if time.Since(started) > 3*time.Second {
		t.Fatalf("closeManager overran its budget: %v", time.Since(started))
	}
}

// Mutant: a floor equal to the whole budget is the legacy single shared deadline;
// the hung first stop then consumes everything and the second capsule survives.
func TestCloseManagerSharedDeadlineMutantStarvesTheNextCapsule(t *testing.T) {
	r := newDamRunner()
	r.hangStops = 1
	m, h, _ := twoCapsules(t, r)
	s := &helloState{manager: m, handler: h, closeBudget: 600 * time.Millisecond, minStopSlice: time.Hour} // MUT-QC03-SHARED
	_ = s.closeManager(context.Background())
	if _, active, _ := r.snapshot(); active != 2 {
		t.Fatalf("mutant did not reproduce starvation: %d active, want 2", active)
	}
}

// A lone slow-but-healthy stop still gets the whole remaining budget (never cut early).
func TestCloseManagerLoneSlowStopGetsWholeBudget(t *testing.T) {
	r := newDamRunner()
	m, h, dir := damHandler(t, &slowStop{damRunner: r, delay: 300 * time.Millisecond})
	createdID(t, damCreate(context.Background(), h, "pair-a"))
	s := &helloState{manager: m, handler: h, closeBudget: 2 * time.Second, minStopSlice: 50 * time.Millisecond}
	if err := s.closeManager(context.Background()); err != nil {
		t.Fatalf("slow stop failed inside its budget: %v", err)
	}
	if _, active, _ := r.snapshot(); active != 0 || reservationCount(t, dir) != 0 {
		t.Fatalf("slow stop left %d active, %d reservations", active, reservationCount(t, dir))
	}
}

// slowStop delays every stop but honors the context, like ProcessRunner.
type slowStop struct {
	*damRunner
	delay time.Duration
}

func (s *slowStop) Run(ctx context.Context, argv []string, in []byte) ([]byte, error) {
	if argv[1] == "stop" {
		select {
		case <-time.After(s.delay):
		case <-ctx.Done():
			return nil, &cli.Fault{Code: "uncertain", Detail: "native command deadline or cancellation"}
		}
	}
	return s.damRunner.Run(ctx, argv, in)
}

// No native stop may start with an already-cancelled context once the budget is spent.
func TestCloseManagerNeverStartsStopOnSpentBudget(t *testing.T) {
	r := newDamRunner()
	r.hangStops = 100
	m, h, _ := damHandler(t, r)
	for _, p := range []string{"pair-a", "pair-b", "pair-c"} {
		createdID(t, damCreate(context.Background(), h, p))
	}
	s := &helloState{manager: m, handler: h, closeBudget: 150 * time.Millisecond, minStopSlice: 100 * time.Millisecond}
	err := s.closeManager(context.Background())
	if err == nil {
		t.Fatal("hung stops reported as success")
	}
	if _, _, dead := r.snapshot(); dead != 0 {
		t.Fatalf("%d native stops started with an already-cancelled context", dead)
	}
	if !strings.Contains(err.Error(), "shutdown budget exhausted before stopping") {
		t.Fatalf("the skipped capsule was not reported: %v", err)
	}
}
