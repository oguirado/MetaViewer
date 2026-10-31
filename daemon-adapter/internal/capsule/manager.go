package capsule

// [TARGET, unit decision] Profiles bind public kinds to admitted native programs,
// geometry, display and RAM allocation. The caller supplies hello's monotonic origin.
// [TARGET, unit decision] Holdings' documented timestamp-only input receipt and
// stopped-only stop reply lack independent proof. Trusted verification hooks
// must affirm the bound operation/removal; absent hooks fail closed.
// Local observation IDs are opaque and never reused within this manager's session.
// Uncertain native effects quarantine the profile until explicit reconciliation.
// [TARGET, unit decision] Failed readiness is compensated only for a validated,
// non-conflicting identity correlated with a pending create before native start.
// Verified removal releases quarantine;
// otherwise an uncertain fault exposes the retained quarantine. Create has no
// request dedup key: an uncertain start must never be retried automatically.
// [TARGET, unit decision] Profile geometry caps identity readiness; surface and
// input bounds track the actual CLI window, including valid smaller captures.
// Holdings has no window identity and requires exact configured capture geometry.
// [TARGET, unit decision] HandleInputWithEvidence returns request-local native
// evidence only after all input checks pass. Holdings never acquires synthetic
// focus proof; its independent verifier does not supply native focus fields.
// [TARGET, unit decision] After an agent-origin Holdings input passes
// VerifyHoldingsInput, Manager.input invokes observe --container <c> under the
// configured timeout/output caps and attaches a strictly validated GroundTruth
// to InputEvidence. Human-origin input never calls observe or attaches
// GroundTruth; observe failures/refusals/malformed replies omit GroundTruth.
// [TARGET, unit decision] Long text uses one permit and serial verified native calls.
import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"metaviewer/daemon-adapter/internal/cli"
)

type Profile struct {
	TextInput                                           string `json:"text_input,omitempty"`
	Kind, NativeKind, Program, AppDir, RAMRoot, Display string
	Width, Height, NestedDepth                          int
}

// ValidTextInput admits only the default or the two native text modes.
func ValidTextInput(mode string) bool {
	return mode == "" || mode == "type" || mode == "paste"
}

type ViewBackend interface {
	Open(context.Context, string, bool) error
	Stop(context.Context, string) error
}

type Config struct {
	BinDir string
	// NetModes is trusted startup knowledge; absence preserves legacy argv/env.
	NetModes                    []string
	Profiles                    map[string]Profile
	MaxSurfaces, MaxOutputBytes int
	Timeout                     time.Duration
	OriginNS                    uint64
	LivenessInterval            time.Duration
	LivenessMisses              int
	LivenessTimeout             time.Duration
	View                        ViewBackend
	// BeforeDestroy drains any capture subscriptions before native stop.
	BeforeDestroy         func(context.Context, string) error
	VerifyHoldingsInput   func(context.Context, Binding, string, json.RawMessage, uint64) error
	VerifyHoldingsRemoval func(context.Context, Binding) error
}
type Geometry struct {
	W int `json:"w"`
	H int `json:"h"`
}
type Surface struct {
	Schema     string   `json:"schema"`
	SurfaceID  string   `json:"surface_id"`
	Kind       string   `json:"kind"`
	Display    string   `json:"display"`
	Geometry   Geometry `json:"geometry"`
	State      string   `json:"state"`
	Visibility string   `json:"visibility"`
	Control    string   `json:"control"`
	ProfileID  string   `json:"profile_id"`
}
type Window struct {
	ID    string `json:"id"`
	X     int    `json:"x"`
	Y     int    `json:"y"`
	W     int    `json:"w"`
	H     int    `json:"h"`
	Title string `json:"title"`
	URL   string `json:"url"`
}
type Binding struct {
	Surface                                                   Surface
	Container, RunID, Window, FramesRoot, NativeKind, Program string
	ConfirmedAbsent                                           bool
	// [TARGET, unit decision] Delivery rollback requires a fresh positive probe.
	// A distinct token prevents a probe started before rollback from reopening I/O.
	recoveryProbe *bool
}
type NativeFrame struct {
	Path            string          `json:"path"`
	Seq             uint64          `json:"seq"`
	SHA256RGB24     string          `json:"sha256_rgb24"`
	Width           int             `json:"width"`
	Height          int             `json:"height"`
	CaptureMonoNS   uint64          `json:"capture_mono_ns"`
	Generation      string          `json:"generation"`
	Window          *Window         `json:"window,omitempty"`
	State           json.RawMessage `json:"state,omitempty"`
	TSNS, CaptureUS uint64          `json:"-"`
}

// NativeTextMaxRunes follows OpenSuperficies src/browserid/inject/inject.go:279-281
// at deps.lock commit a9ac1ac8543872b428990ea23fa2629cd0a6d1d5 [CITED].
const NativeTextMaxRunes = 2000

// AdapterTextMaxRunes caps each proposal [TARGET, unit decision].
const AdapterTextMaxRunes = 16384

// [TARGET, unit decision] Human text and wheel lowering (input-control U1).
// A human text batch goes through srf --paste only when it holds a rune outside
// 0x20-0x7E, because xdotool type drops non-ASCII runes and a paste costs about
// 1.7 s per call [MEASURED, OpenSuperficies io.go paste timers]; plain ASCII keeps
// --type-stdin. Agent text keeps the profile rule. A human wheel delta (px) lowers
// to one srf scroll call on the dominant axis: WheelStepPx per step
// [CITED: noVNC core/rfb.js WHEEL_STEP], at least one step for a nonzero delta,
// at most ScrollMaxSteps (the srf --count ceiling). The action carries no pointer
// position in the closed core schema, so an absent x,y scrolls at the surface centre.
const (
	WheelStepPx    = 50
	ScrollMaxSteps = 20
)

// needsPaste reports whether text holds a rune outside printable ASCII 0x20-0x7E.
func needsPaste(text string) bool {
	for _, r := range text {
		if r < 0x20 || r > 0x7E {
			return true
		}
	}
	return false
}

// scrollSteps converts a pixel delta to srf wheel steps (see WheelStepPx).
func scrollSteps(delta int64) int {
	if delta < 0 {
		delta = -delta
	}
	n := delta / WheelStepPx
	if n < 1 {
		n = 1
	}
	if n > ScrollMaxSteps {
		n = ScrollMaxSteps
	}
	return int(n)
}

type NativeInputReceipt struct {
	SurfaceID     string  `json:"surface_id,omitempty"`
	Kind          string  `json:"kind,omitempty"`
	InputMonoNS   *uint64 `json:"input_mono_ns"`
	FocusVerified *bool   `json:"focus_verified,omitempty"`
	Result        string  `json:"result,omitempty"`
}
type TextChunkEvidence struct {
	NativeInputReceipt
	Runes  int    `json:"runes"`
	SHA256 string `json:"sha256"`
}
type TextSequenceEvidence struct {
	Chunks []TextChunkEvidence `json:"chunks"`
}

// InputEvidence keeps request-local native proof. TextSequence is adapter-local:
// contracts/v0.2/action_receipt.schema.json:107 closes the wire evidence fields.
// The final native result is published only after the whole sequence verifies.
type InputEvidence struct {
	TextSequence      *TextSequenceEvidence `json:"-"`
	SurfaceID         string                `json:"surface_id"`
	NativeSurfaceID   string                `json:"native_surface_id,omitempty"`
	Kind              string                `json:"kind,omitempty"`
	InputMonoNS       uint64                `json:"input_mono_ns"`
	InputTSNS         uint64                `json:"input_ts_ns"`
	FocusVerified     *bool                 `json:"focus_verified,omitempty"`
	Result            string                `json:"result,omitempty"`
	BeforeGroundTruth *GroundTruth          `json:"before_ground_truth,omitempty"`
	GroundTruth       *GroundTruth          `json:"ground_truth,omitempty"`
}
type Manager struct {
	mu          sync.Mutex
	cfg         Config
	runner      cli.Runner
	clock       cli.Clock
	bindings    map[string]Binding
	quarantined map[string]bool
	creates     map[string]pendingCreate
	destroying  map[string]bool
	pending     map[string]*pendingInput
	inputEpochs map[string]uint64
	used        map[string]bool
	refresh     map[string]bool
	views       map[string]bool
	loginLocks  map[string]bool
	lostDone    map[string]chan struct{}
}

var profileID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
var identityContainer = regexp.MustCompile(`^srf-(id|pg|vm)-[a-z0-9][a-z0-9-]{0,39}$`)
var holdingsContainer = regexp.MustCompile(`^srf-ng-hcap-hc-[0-9a-f]{12}-[0-9]{1,2}$`)
var runID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
var digest = regexp.MustCompile(`^[0-9a-f]{64}$`)
var displayID = regexp.MustCompile(`^:[0-9]+(\.[0-9]+)?$`)

func fault(code, detail string) error { return &cli.Fault{Code: code, Detail: detail} }

// [TARGET, unit decision] DAM-FIX close-F2 / L-02: refusal reasons that the
// operator can act on carry a stable uppercase wire code. The internal Fault
// code stays lowercase (tests and callers key on it); WireCode maps it for the
// surface_event error body. The detail strings below are the single source of
// truth shared by the fault constructor and the mapping.
const (
	detailProfileBound         = "profile already bound"
	detailCapacityOrQuarantine = "surface capacity or unresolved native outcome"
	detailIdentityUnavailable  = "native start reported the identity unavailable (exit status 4): the identity may be " +
		"exclusively held by a live capsule or by a lease abandoned by an earlier session; the adapter has no " +
		"authority to reclaim a lease and no shipped native CLI reclaims it (ABSENT, do not invent); close the " +
		"holder, or recover the lease out of band, before retrying"
)

// wireCodePattern is the code shape the UI authority wire passes through.
var wireCodePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{1,63}$`)

// WireCode maps an error to a stable uppercase code for the wire. Codes that
// already match the wire shape pass through unchanged; known lowercase refusals
// map to named codes; any other Fault becomes ADAPTER_<CODE>; a non-Fault error
// is ADAPTER_ERROR. The result always matches wireCodePattern.
func WireCode(err error) string {
	var f *cli.Fault
	if !errors.As(err, &f) {
		return "ADAPTER_ERROR"
	}
	if wireCodePattern.MatchString(f.Code) {
		return f.Code
	}
	switch {
	case f.Code == "binding" && f.Detail == detailProfileBound:
		return "PROFILE_ALREADY_BOUND"
	case f.Code == "uncertain" && f.Detail == detailCapacityOrQuarantine:
		return "SURFACE_CAPACITY_OR_QUARANTINE"
	case f.Code == "identity_unavailable":
		return "IDENTITY_UNAVAILABLE"
	}
	var b strings.Builder
	b.WriteString("ADAPTER_")
	for _, r := range strings.ToUpper(f.Code) {
		if b.Len() >= 64 {
			break
		}
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	if code := b.String(); wireCodePattern.MatchString(code) && code != "ADAPTER_" {
		return code
	}
	return "ADAPTER_ERROR"
}

// [TARGET, unit decision] desktop_capsule program profiles admit only the
// catalog-sanctioned programs ("notepad" at nested_depth 0, or
// "metaviewer-nested" at nested_depth 0 or 1); nested_depth > 1 is refused.
func admittedProgram(program string, nestedDepth int) bool {
	if !profileID.MatchString(program) {
		return false
	}
	switch nestedDepth {
	case 0:
		return program == "notepad" || program == "metaviewer-nested"
	case 1:
		return program == "metaviewer-nested"
	default:
		return false
	}
}

func NewManager(cfg Config, r cli.Runner, clock cli.Clock) (*Manager, error) {
	if r == nil || clock == nil || cfg.OriginNS == 0 || !filepath.IsAbs(cfg.BinDir) || cfg.MaxSurfaces < 1 || cfg.MaxOutputBytes < 1 || cfg.MaxOutputBytes > 1<<20 || cfg.Timeout <= 0 || cfg.Timeout > 3*time.Minute || len(cfg.Profiles) == 0 {
		return nil, fault("configuration", "complete bounded native configuration required")
	}
	if cfg.LivenessInterval == 0 {
		cfg.LivenessInterval = 5 * time.Second
	}
	if cfg.LivenessMisses == 0 {
		cfg.LivenessMisses = 2
	}
	if cfg.LivenessTimeout == 0 {
		cfg.LivenessTimeout = min(cfg.Timeout, 2*time.Second)
	}
	if cfg.LivenessTimeout <= 0 || cfg.LivenessTimeout > cfg.Timeout {
		return nil, fault("configuration", "bounded liveness timeout required")
	}
	if cfg.LivenessInterval < time.Millisecond || cfg.LivenessInterval > time.Hour || cfg.LivenessMisses < 1 || cfg.LivenessMisses > 100 {
		return nil, fault("configuration", "bounded liveness configuration required")
	}
	seenModes := map[string]bool{}
	for _, mode := range cfg.NetModes {
		if (mode != "legacy" && mode != "open" && mode != "proxied") || seenModes[mode] {
			return nil, fault("configuration", "invalid native network capability declaration")
		}
		seenModes[mode] = true
	}
	cfg.NetModes = append([]string(nil), cfg.NetModes...)
	copyProfiles := make(map[string]Profile, len(cfg.Profiles))
	seenDisplays := make(map[string]bool)
	for id, p := range cfg.Profiles {
		if !ValidTextInput(p.TextInput) {
			return nil, fault("configuration", "invalid text input mode")
		}
		if !profileID.MatchString(id) || p.Width < 1 || p.Height < 1 || p.Width > 8192 || p.Height > 8192 || p.NestedDepth < 0 || p.NestedDepth > 1 || !displayID.MatchString(p.Display) || !filepath.IsAbs(p.RAMRoot) || !withinRAM(p.RAMRoot) {
			return nil, fault("configuration", "invalid profile geometry or allocation")
		}
		if p.NestedDepth != 0 && (p.Kind != "desktop_capsule" || p.Width != 1280 || p.Height != 720) {
			return nil, fault("configuration", "nested profile requires 1280x720 desktop_capsule")
		}
		switch p.Kind {
		case "browser":
			if p.NativeKind != "browser" || p.Program != "" {
				return nil, fault("configuration", "browser mapping invalid")
			}
		case "desktop_capsule":
			if p.NativeKind != "program" || !admittedProgram(p.Program, p.NestedDepth) {
				return nil, fault("configuration", "program mapping required")
			}
		case "vm":
			if p.NativeKind != "vm" || !profileID.MatchString(p.Program) {
				return nil, fault("configuration", "virtual program mapping required")
			}
		case "game_capsule":
			if p.NativeKind != "holdings" || !filepath.IsAbs(p.AppDir) {
				return nil, fault("configuration", "game application mapping required")
			}
		default:
			return nil, fault("configuration", "unsupported public kind")
		}
		if seenDisplays[p.Display] {
			return nil, fault("configuration", "distinct profile displays required")
		}
		seenDisplays[p.Display] = true
		copyProfiles[id] = p
	}
	cfg.Profiles = copyProfiles
	return &Manager{cfg: cfg, runner: r, clock: clock, bindings: make(map[string]Binding), quarantined: make(map[string]bool), destroying: make(map[string]bool), pending: make(map[string]*pendingInput), inputEpochs: make(map[string]uint64), used: make(map[string]bool), refresh: make(map[string]bool), views: make(map[string]bool), lostDone: make(map[string]chan struct{})}, nil
}
func withinRAM(path string) bool {
	return path == "/dev/shm" || len(path) > 9 && path[:9] == "/dev/shm/" && filepath.Clean(path) == path
}
func (m *Manager) execute(ctx context.Context, p Profile, args []string, in []byte) ([]byte, error) {
	if err := refuseProtectedContainer(args); err != nil {
		return nil, err
	}
	name := "srf-identity-surface"
	if p.NativeKind == "holdings" {
		name = "srf-holdings-capsule"
	}
	ctx, cancel := context.WithTimeout(ctx, m.cfg.Timeout)
	defer cancel()
	runner := m.runner
	if r, ok := runner.(*ProcessRunner); ok {
		if mode, _ := ctx.Value(networkModeKey{}).(string); mode != "" {
			runner = networkRunner(r, mode)
		}
	}
	out, err := runner.Run(ctx, append([]string{filepath.Join(m.cfg.BinDir, name)}, args...), in)
	if err != nil {
		if len(out) <= m.cfg.MaxOutputBytes {
			return out, err // Failed starts may still identify their pending create.
		}
		return nil, err
	}
	if len(out) > m.cfg.MaxOutputBytes {
		return nil, fault("malformed_cli", "native output exceeds cap")
	}
	return out, nil
}
func event(version, event string, data any) json.RawMessage {
	b, _ := json.Marshal(struct {
		Schema string `json:"schema"`
		Event  string `json:"event"`
		Data   any    `json:"data"`
	}{"surface_event/" + version, event, data})
	return b
}
func surfaceEvent(version, kind string, s Surface) json.RawMessage {
	s.Schema = "surface/" + version
	return event(version, kind, struct {
		Surface Surface `json:"surface"`
	}{s})
}
func (m *Manager) Handle(ctx context.Context, r Request) ([]json.RawMessage, error) {
	return m.handle(ctx, r, nil)
}

func (m *Manager) HandleInputWithEvidence(ctx context.Context, r Request) ([]json.RawMessage, InputEvidence, error) {
	var evidence InputEvidence
	if r.Op != "input" {
		return nil, evidence, fault("input", "input request required for evidence")
	}
	events, err := m.handle(ctx, r, &evidence)
	return events, evidence, err
}

func (m *Manager) handle(ctx context.Context, r Request, evidence *InputEvidence) ([]json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	version := "v0.2"
	if r.Schema == "surface_request/v0.1" {
		version = "v0.1"
	} else if r.Schema != "surface_request/v0.2" {
		return nil, fault("schema", "unsupported request schema")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	switch r.Op {
	case "create":
		return m.create(ctx, r, version)
	case "list":
		var p struct{}
		if e := cli.ParseLine(r.Params, m.cfg.MaxOutputBytes, &p); e != nil {
			return nil, e
		}
		ids := make([]string, 0, len(m.bindings))
		for id, b := range m.bindings {
			if b.Surface.State != "destroyed" {
				ids = append(ids, id)
			}
		}
		sort.Strings(ids)
		out := make([]json.RawMessage, 0, len(ids))
		for _, id := range ids {
			out = append(out, surfaceEvent(version, "created", m.bindings[id].Surface))
		}
		return out, nil
	case "destroy":
		return m.destroy(ctx, r, version)
	case "input":
		return m.input(ctx, r, version, evidence)
	case "take_control", "release_control":
		return m.control(r, version)
	case "view", "login", "view-stop":
		return m.view(ctx, r, version)
	case "frame_subscribe", "frame_unsubscribe", "record_start", "record_stop":
		return nil, cli.Unsupported(r.Op)
	default:
		return nil, fault("unknown_op", "unknown surface operation")
	}
}
func (m *Manager) view(ctx context.Context, r Request, version string) ([]json.RawMessage, error) {
	var q struct {
		SurfaceID string `json:"surface_id"`
	}
	if e := cli.ParseLine(r.Params, m.cfg.MaxOutputBytes, &q); e != nil {
		return nil, e
	}
	if q.SurfaceID == "" {
		return nil, fault("usage", "surface_id required")
	}
	if m.cfg.View == nil {
		return nil, cli.Unsupported(r.Op)
	}
	var b Binding
	found := false
	if cand, ok := m.bindings[q.SurfaceID]; ok && cand.Surface.State == "active" && !m.destroying[q.SurfaceID] {
		b, found = cand, true
	} else {
		for id, cand := range m.bindings {
			if cand.Container == q.SurfaceID && cand.Surface.State == "active" && !m.destroying[id] {
				b, found = cand, true
				break
			}
		}
	}
	if !found {
		if !identityContainer.MatchString(q.SurfaceID) {
			return nil, fault("usage", "invalid identity capsule")
		}
		return nil, fault("surface", "active surface required")
	}
	if b.NativeKind == "holdings" {
		return nil, fault("usage", "invalid identity capsule")
	}
	if r.Op != "view-stop" && m.views[b.Container] {
		return nil, fault("refused", "view unavailable or already registered")
	}
	if r.Op == "login" {
		if m.hasPending(b.Surface.SurfaceID) {
			return nil, fault("POLICY", "input must drain before operator login")
		}
		if m.loginLocks == nil {
			m.loginLocks = make(map[string]bool)
		}
		if m.loginLocks[b.Container] {
			return nil, fault("LOGIN_ACTIVE", "operator login is already opening")
		}
		m.loginLocks[b.Container] = true
	}
	m.mu.Unlock()
	var err error
	if r.Op == "view-stop" {
		err = m.cfg.View.Stop(ctx, b.Container)
	} else {
		err = m.cfg.View.Open(ctx, b.Container, r.Op == "login")
	}
	m.mu.Lock()
	if err != nil {
		// Keep the lock after uncertain native failures: only a verified stop
		// may reopen agent admission.
		return nil, err
	}
	current, ok := m.bindings[b.Surface.SurfaceID]
	if r.Op == "view-stop" {
		delete(m.loginLocks, b.Container)
		delete(m.views, b.Container)
		if !ok || current.Surface.State != "active" || m.destroying[b.Surface.SurfaceID] || current.Container != b.Container || current.RunID != b.RunID {
			return nil, fault("surface", "active surface required")
		}
		return []json.RawMessage{surfaceEvent(version, "state_changed", current.Surface)}, nil
	}
	if !ok || current.Surface.State != "active" || m.destroying[b.Surface.SurfaceID] || current.Container != b.Container || current.RunID != b.RunID {
		delete(m.views, b.Container)
		m.mu.Unlock()
		stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), m.cfg.Timeout)
		stopErr := m.cfg.View.Stop(stopCtx, b.Container)
		cancel()
		m.mu.Lock()
		if stopErr == nil {
			delete(m.loginLocks, b.Container)
		}
		return nil, fault("surface", "active surface required")
	}
	if m.views[b.Container] {
		return nil, fault("refused", "view unavailable or already registered")
	}
	m.views[b.Container] = true
	return []json.RawMessage{surfaceEvent(version, "state_changed", current.Surface)}, nil
}
func (m *Manager) create(ctx context.Context, r Request, version string) (events []json.RawMessage, err error) {
	var q struct {
		Kind        string   `json:"kind"`
		ProfileID   string   `json:"profile_id"`
		Geometry    Geometry `json:"geometry"`
		NestedDepth *int     `json:"nested_depth,omitempty"`
	}
	if e := cli.ParseLine(r.Params, m.cfg.MaxOutputBytes, &q); e != nil {
		return nil, e
	}
	if q.NestedDepth != nil && (*q.NestedDepth < 0 || *q.NestedDepth > 1) {
		return nil, fault("nested_depth", "nested_depth must be 0 or 1")
	}
	if q.NestedDepth != nil && q.Kind != "desktop_capsule" {
		return nil, fault("nested_depth", "nested_depth requires desktop_capsule")
	}
	p, ok := m.cfg.Profiles[q.ProfileID]
	if !ok || !profileID.MatchString(q.ProfileID) || p.Kind != q.Kind || q.Geometry.W != p.Width || q.Geometry.H != p.Height {
		return nil, fault("profile", "unadmitted profile, kind or geometry")
	}
	effectiveDepth := 0
	if q.NestedDepth != nil {
		effectiveDepth = *q.NestedDepth
	}
	if p.NestedDepth < 0 || p.NestedDepth > 1 || effectiveDepth != p.NestedDepth || (p.Kind != "desktop_capsule" && p.NestedDepth != 0) {
		return nil, fault("nested_depth", "profile nested_depth mismatch")
	}
	if p.Kind == "desktop_capsule" && (p.NativeKind != "program" || !admittedProgram(p.Program, p.NestedDepth) || (p.NestedDepth == 1 && (p.Width != 1280 || p.Height != 720))) {
		return nil, fault("profile", "unadmitted profile, kind or geometry")
	}
	// Refuse protected profile collisions before any create state or native call.
	var profileContainer string
	switch p.NativeKind {
	case "browser":
		profileContainer = "srf-id-" + q.ProfileID
	case "program":
		profileContainer = "srf-pg-" + q.ProfileID
	case "vm":
		profileContainer = "srf-vm-" + q.ProfileID
	}
	if e := refuseProtectedContainer([]string{"--container", profileContainer}); e != nil {
		return nil, e
	}
	// Lost bindings retain their profile and capacity: native state may be orphaned.
	// Only destroy with a verified stop receipt releases both; keep the old ID
	// as a tombstone and generate a fresh ID for the replacement.
	active := len(m.quarantined)
	for _, b := range m.bindings {
		if b.Surface.State != "destroyed" {
			if b.Surface.ProfileID == q.ProfileID {
				return nil, fault("binding", detailProfileBound)
			}
			active++
		}
	}
	if active >= m.cfg.MaxSurfaces || m.quarantined[q.ProfileID] {
		return nil, fault("uncertain", detailCapacityOrQuarantine)
	}
	idBytes := make([]byte, 16)
	if _, e := rand.Read(idBytes); e != nil {
		return nil, e
	}
	id := "surface-" + hex.EncodeToString(idBytes)
	args := []string{"start", "--kind", p.NativeKind, "--identity", q.ProfileID, "--windows", "1"}
	if p.NativeKind == "program" || p.NativeKind == "vm" {
		args = append(args, "--program", p.Program)
	}
	if p.NativeKind == "holdings" {
		args = []string{"start", "--slots", "1", "--app", p.AppDir}
	}
	var started *EgressStarted
	witnessState := m.egressState()
	if p.NativeKind == "browser" {
		var frozen string
		if witnessState != "" {
			if runner, ok := m.runner.(*ProcessRunner); ok {
				if err := runner.validateStateDir(); err != nil {
					return nil, err
				}
			}
			var snapshotErr error
			frozen, snapshotErr = egressRecordDigest(witnessState, q.ProfileID)
			if snapshotErr != nil {
				return nil, fault("NET_EGRESS_IO", snapshotErr.Error())
			}
		}
		egress, mode, policy, netErr := m.browserNetwork(q.ProfileID, profileContainer)
		if netErr != nil {
			return nil, netErr
		}
		args, netErr = networkStartArgs(args, mode, policy)
		if netErr != nil {
			return nil, netErr
		}
		if witnessState != "" {
			if err := verifyEgressRecord(witnessState, q.ProfileID, egress); err != nil {
				return nil, err
			}
			current, err := egressRecordDigest(witnessState, q.ProfileID)
			if err != nil || current != frozen {
				return nil, fault("NET_EGRESS_CHANGED", "egress record changed during start preparation")
			}
			started = &EgressStarted{Schema: egressStartedSchema, CapsuleID: profileContainer, EffectiveMode: mode, RecordSHA256: frozen, StartMonoNS: m.clock(), StartWallNS: time.Now().UnixNano()}
			if started.EffectiveMode == "" {
				started.EffectiveMode = "legacy"
			}
			if err := removeEgressStarted(witnessState, q.ProfileID); err != nil {
				return nil, err
			}
		}
		ctx = context.WithValue(ctx, networkModeKey{}, mode)
	}
	// Quarantine before execution; clear only on a proven pre-spawn refusal.
	m.quarantined[q.ProfileID] = true
	// [TARGET, unit decision] The profile slot and generation establish cleanup
	// authority before start. A reply alone cannot create that authority.
	if m.creates == nil {
		m.creates = make(map[string]pendingCreate)
	}
	pending := pendingCreate{Generation: id, NativeKind: p.NativeKind, Slot: 1}
	switch p.NativeKind {
	case "browser":
		pending.Container = "srf-id-" + q.ProfileID
	case "program":
		pending.Container = "srf-pg-" + q.ProfileID
	case "vm":
		pending.Container = "srf-vm-" + q.ProfileID
	}
	m.creates[q.ProfileID] = pending
	defer delete(m.creates, q.ProfileID)
	out, e := m.execute(ctx, p, args, nil)
	var refused *preSpawnRefusal
	if errors.As(e, &refused) {
		delete(m.quarantined, q.ProfileID)
		return nil, e
	}
	// [TARGET, unit decision] L-02: exit status 4 of an identity start is a bare
	// "unavailable"; give it a typed, actionable refusal. Quarantine is kept: exit
	// 4 can also follow a retained lease after a native launch, so absence is
	// unproven and the reservation must keep counting.
	var native *cli.Fault
	if e != nil && p.NativeKind != "holdings" && errors.As(e, &native) && native.Code == "unavailable" {
		e = fault("identity_unavailable", detailIdentityUnavailable)
	}
	b := Binding{Surface: Surface{Schema: "surface/" + version, SurfaceID: id, Kind: p.Kind, Display: p.Display, Geometry: q.Geometry, State: "active", Visibility: "unfolded", Control: "agent", ProfileID: q.ProfileID}, NativeKind: p.NativeKind, Program: p.Program}
	// Recover only the cleanup identity from syntactically valid bounded JSON.
	// Readiness validation below remains closed and authoritative for admission.
	var cleanup struct {
		Slot      int    `json:"slot"`
		Container string `json:"container"`
		RunID     string `json:"run_id"`
	}
	if p.NativeKind == "holdings" {
		var records []struct {
			Slot      int    `json:"slot"`
			Container string `json:"container"`
			RunID     string `json:"run_id"`
		}
		if len(out) <= m.cfg.MaxOutputBytes && json.Unmarshal(out, &records) == nil && len(records) == 1 {
			cleanup.Slot, cleanup.Container, cleanup.RunID = records[0].Slot, records[0].Container, records[0].RunID
		}
	} else if len(out) <= m.cfg.MaxOutputBytes {
		if json.Unmarshal(out, &cleanup) != nil {
			cleanup.Container, cleanup.RunID = "", ""
		}
	}
	defer func() {
		if err == nil {
			return
		}
		valid := identityContainer.MatchString(cleanup.Container)
		if p.NativeKind == "holdings" {
			valid = holdingsContainer.MatchString(cleanup.Container)
		}
		valid = valid && runID.MatchString(cleanup.RunID)
		valid = valid && m.pendingCleanup(q.ProfileID, id, p.NativeKind, cleanup.Slot, cleanup.Container)
		for _, old := range m.bindings {
			if (old.Container == cleanup.Container || old.RunID == cleanup.RunID) && old.Surface.State != "destroyed" {
				valid = false
			}
		}
		if valid {
			candidate := b
			candidate.Container, candidate.RunID = cleanup.Container, cleanup.RunID
			cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), m.cfg.Timeout)
			defer cancel()
			if stopErr := m.stopNative(cleanupCtx, candidate); stopErr == nil {
				delete(m.quarantined, q.ProfileID)
				return
			}
		}
		if e != nil {
			return // Preserve the native fault while retaining quarantine.
		}
		err = fault("uncertain", "profile "+q.ProfileID+" remains quarantined after failed create: "+err.Error())
	}()
	if e != nil {
		return nil, e
	}
	if p.NativeKind == "holdings" {
		var records []struct {
			Slot       int    `json:"slot"`
			Container  string `json:"container"`
			RunID      string `json:"run_id"`
			Display    string `json:"display"`
			Width      int    `json:"width"`
			Height     int    `json:"height"`
			LaneSocket string `json:"lane_socket"`
			ReadyLine  string `json:"ready_line"`
			ReadyMS    *int64 `json:"ready_ms"`
			FramesDir  string `json:"frames_dir"`
		}
		if e := parseArray(out, m.cfg.MaxOutputBytes, &records); e != nil {
			return nil, e
		}
		if len(records) != 1 {
			return nil, fault("malformed_cli", "one game capsule required")
		}
		c := records[0]
		if c.Slot != 1 || !holdingsContainer.MatchString(c.Container) || !runID.MatchString(c.RunID) || c.Display != p.Display || c.Width != p.Width || c.Height != p.Height || c.ReadyLine == "" || c.ReadyMS == nil || *c.ReadyMS < 0 || !under(p.RAMRoot, c.FramesDir) {
			return nil, fault("malformed_cli", "invalid game readiness or binding")
		}
		b.Container = c.Container
		b.RunID = c.RunID
		b.FramesRoot = c.FramesDir
	} else {
		var c struct {
			Kind      string   `json:"kind,omitempty"`
			Container string   `json:"container"`
			RunID     string   `json:"run_id"`
			Windows   []Window `json:"windows"`
		}
		if e := cli.ParseLine(out, m.cfg.MaxOutputBytes, &c); e != nil {
			return nil, e
		}
		if !identityContainer.MatchString(c.Container) || !runID.MatchString(c.RunID) || len(c.Windows) != 1 || c.Windows[0].ID != "w1" || c.Windows[0].W < 1 || c.Windows[0].H < 1 || c.Windows[0].W > p.Width || c.Windows[0].H > p.Height || c.Windows[0].X < 0 || c.Windows[0].Y < 0 || (c.Kind != p.NativeKind && !(p.NativeKind == "browser" && c.Kind == "")) {
			return nil, fault("malformed_cli", "invalid identity readiness or binding")
		}
		b.Container = c.Container
		b.RunID = c.RunID
		b.Window = c.Windows[0].ID
		b.Surface.Geometry = Geometry{W: c.Windows[0].W, H: c.Windows[0].H}
		b.FramesRoot = filepath.Join(p.RAMRoot, c.RunID, "frames", b.Window)
	}
	if err := refuseProtectedContainer([]string{"--container", b.Container}); err != nil {
		return nil, err
	}
	// [TARGET, unit decision] Shared producer roots require unique live run IDs
	// and disjoint frame allocations, including native-provided Holdings paths.
	for _, old := range m.bindings {
		if old.Surface.State != "destroyed" && (old.RunID == b.RunID || old.FramesRoot == b.FramesRoot || under(old.FramesRoot, b.FramesRoot) || under(b.FramesRoot, old.FramesRoot)) {
			// A colliding allocation grants no authority to clean up native files.
			cleanup.Container = ""
			e = fault("binding", "native run or frame allocation already observed")
			return nil, e
		}
		if old.Container == b.Container && old.Surface.State != "destroyed" {
			return nil, fault("binding", "native container already observed")
		}
	}
	if started != nil {
		if _, err := writePrivateEgressFile(witnessState, q.ProfileID+".started.json", started, 0400); err != nil {
			return nil, err
		}
	}
	m.bindings[id] = b
	delete(m.quarantined, q.ProfileID)
	return []json.RawMessage{surfaceEvent(version, "created", b.Surface)}, nil
}
func under(root, path string) bool {
	rel, e := filepath.Rel(root, path)
	return e == nil && filepath.Clean(path) == path && rel != "." && rel != ".." && len(rel) > 0 && rel[0] != '.' && !filepath.IsAbs(rel)
}
func (m *Manager) destroy(ctx context.Context, r Request, version string) ([]json.RawMessage, error) {
	var q struct {
		SurfaceID string `json:"surface_id"`
	}
	if e := cli.ParseLine(r.Params, m.cfg.MaxOutputBytes, &q); e != nil {
		return nil, e
	}
	b, ok := m.bindings[q.SurfaceID]
	if !ok || b.Surface.State == "destroyed" || m.destroying[q.SurfaceID] {
		return nil, fault("surface", "unknown or terminal surface")
	}
	if m.hasPending(q.SurfaceID) {
		return nil, fault("POLICY", "input must be drained before destroy")
	}
	m.destroying[q.SurfaceID] = true
	defer delete(m.destroying, q.SurfaceID)
	// Drain outside mu: capture subscribers may be waiting to acquire it.
	if m.cfg.BeforeDestroy != nil {
		m.mu.Unlock()
		e := m.cfg.BeforeDestroy(ctx, q.SurfaceID)
		m.mu.Lock()
		if e != nil {
			return nil, e
		}
	}
	if m.cfg.View != nil && m.views[b.Container] {
		delete(m.views, b.Container)
		m.mu.Unlock()
		_ = m.cfg.View.Stop(ctx, b.Container)
		m.mu.Lock()
	}
	// Stop may have effects even without a usable receipt. Keep the binding lost
	// until verified removal; never reopen input/capture after an uncertain stop.
	b.Surface.State = "lost"
	m.bindings[q.SurfaceID] = b
	if e := m.stopNative(ctx, b); e != nil {
		return nil, e
	}
	delete(m.quarantined, b.Surface.ProfileID)
	delete(m.loginLocks, b.Container)
	b.Surface.State = "destroyed"
	m.bindings[q.SurfaceID] = b
	delete(m.inputEpochs, q.SurfaceID)
	delete(m.refresh, q.SurfaceID)
	return []json.RawMessage{surfaceEvent(version, "state_changed", b.Surface)}, nil
}

// stopNative requires mu and preserves the same removal proof for rollback and destroy.
// An unavailable stop settles only previously proven absence; Holdings also
// requires its independent ownership/removal verifier. Unknown outcomes retain the slot.
func (m *Manager) stopNative(ctx context.Context, b Binding) (err error) {
	defer func() {
		if err == nil && b.NativeKind == "browser" && m.egressState() != "" {
			err = removeEgressStarted(m.egressState(), b.Surface.ProfileID)
		}
	}()
	out, e := m.execute(ctx, m.cfg.Profiles[b.Surface.ProfileID], []string{"stop", "--container", b.Container}, nil)
	if e != nil {
		var f *cli.Fault
		if b.ConfirmedAbsent && errors.As(e, &f) && f.Code == "unavailable" {
			if b.NativeKind == "holdings" {
				if m.cfg.VerifyHoldingsRemoval == nil {
					return fault("uncertain", "independent Holdings removal proof required")
				}
				m.mu.Unlock()
				ve := m.cfg.VerifyHoldingsRemoval(ctx, b)
				m.mu.Lock()
				return ve
			}
			return nil
		}
		return e
	}
	var stopped struct {
		Stopped         string `json:"stopped"`
		RemovedVerified *bool  `json:"removed_verified,omitempty"`
	}
	if e := cli.ParseLine(out, m.cfg.MaxOutputBytes, &stopped); e != nil {
		return e
	}
	if stopped.Stopped != b.Container || (stopped.RemovedVerified != nil && !*stopped.RemovedVerified) || (b.NativeKind != "holdings" && stopped.RemovedVerified == nil) {
		return fault("malformed_cli", "native removal was not verified")
	}
	if b.NativeKind == "holdings" {
		if m.cfg.VerifyHoldingsRemoval == nil {
			return fault("uncertain", "independent Holdings removal proof required")
		}
		m.mu.Unlock()
		e := m.cfg.VerifyHoldingsRemoval(ctx, b)
		m.mu.Lock()
		if e != nil {
			return e
		}
	}
	return nil
}
func (m *Manager) Capture(ctx context.Context, id string) (Binding, NativeFrame, error) {
	m.mu.Lock()
	b, ok := m.bindings[id]
	if !ok || b.Surface.State != "active" || b.recoveryProbe != nil || m.destroying[id] {
		m.mu.Unlock()
		return Binding{}, NativeFrame{}, fault("surface", "capture requires an active surface")
	}
	if m.hasPending(id) {
		m.mu.Unlock()
		return Binding{}, NativeFrame{}, fault("POLICY", "input must be drained before capture")
	}
	epoch := m.beginCapture(id)
	profile := m.cfg.Profiles[b.Surface.ProfileID]
	args := []string{"frame", "--container", b.Container}
	if b.Window != "" {
		args = append(args, "--window", b.Window)
	}
	before := m.clock()
	m.mu.Unlock()
	out, e := m.execute(ctx, profile, args, nil)
	after := m.clock()
	m.mu.Lock()
	defer m.mu.Unlock()
	current, ok := m.bindings[id]
	if !ok || current.Surface.State != "active" || current.recoveryProbe != nil || m.destroying[id] || current.Container != b.Container || current.RunID != b.RunID {
		return Binding{}, NativeFrame{}, fault("surface", "capture requires an active surface")
	}
	if m.hasPending(id) || m.inputEpochs[id] != epoch {
		return Binding{}, NativeFrame{}, fault("POLICY", "input must be drained before capture")
	}
	b = current
	if e != nil {
		return b, NativeFrame{}, e
	}
	var f NativeFrame
	if e = cli.ParseLine(out, m.cfg.MaxOutputBytes, &f); e != nil {
		return b, f, e
	}
	if f.Seq == 0 || f.Generation != b.Container || f.Width < 1 || f.Height < 1 || f.Width > b.Surface.Geometry.W || f.Height > b.Surface.Geometry.H || !digest.MatchString(f.SHA256RGB24) || !under(b.FramesRoot, f.Path) || f.CaptureMonoNS < m.cfg.OriginNS || f.CaptureMonoNS < before || f.CaptureMonoNS > after || after < before || (b.Window != "" && (f.Window == nil || f.Window.ID != b.Window || f.Window.W != f.Width || f.Window.H != f.Height)) || (b.Window == "" && (f.Window != nil || f.Width != b.Surface.Geometry.W || f.Height != b.Surface.Geometry.H)) {
		return b, f, fault("frame", "native frame identity, time or allocation mismatch")
	}
	if b.Window != "" {
		b.Surface.Geometry = Geometry{W: f.Window.W, H: f.Window.H}
		m.bindings[id] = b
	}
	delete(m.refresh, id)
	f.TSNS = f.CaptureMonoNS - m.cfg.OriginNS
	f.CaptureUS = (after - before) / 1000
	return b, f, nil
}

// MarkLost is called only after the owner independently proves native absence.
func (m *Manager) MarkLost(id string, confirmedAbsent bool) (json.RawMessage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.markLostLocked(id, confirmedAbsent, false)
}

// BeginMarkLost transitions an active surface to lost and tracks in-flight delivery
// until CompleteLost is called.
func (m *Manager) BeginMarkLost(id string) (json.RawMessage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.markLostLocked(id, true, true)
}

func (m *Manager) markLostLocked(id string, confirmedAbsent bool, trackDelivery bool) (json.RawMessage, error) {
	b, ok := m.bindings[id]
	if ok && b.Surface.State == "lost" {
		if !confirmedAbsent || !b.ConfirmedAbsent {
			return nil, fault("surface", "confirmed active disappearance required")
		}
		return nil, nil
	}
	if !confirmedAbsent || !ok || b.Surface.State != "active" || m.destroying[id] {
		return nil, fault("surface", "confirmed active disappearance required")
	}
	// [TARGET, unit decision] Confirmed native loss invalidates in-flight input.
	// Cancel its execution/proof without waiting under mu; completion must fail
	// against the lost binding and the wire owner settles the proposal as failed.
	for _, p := range m.pending {
		if p.surface == id {
			p.cancel()
		}
	}
	b.Surface.State = "lost"
	b.ConfirmedAbsent = true
	m.bindings[id] = b
	if trackDelivery {
		m.lostDone[id] = make(chan struct{})
	}
	return surfaceEvent("v0.2", "state_changed", b.Surface), nil
}

// CompleteLost finishes or rolls back a tracked state_changed(lost) emission.
func (m *Manager) CompleteLost(id string, delivered bool) {
	m.mu.Lock()
	ch := m.lostDone[id]
	delete(m.lostDone, id)
	if !delivered {
		if b, ok := m.bindings[id]; ok && b.Surface.State == "lost" && b.ConfirmedAbsent && !m.destroying[id] {
			b.Surface.State = "active"
			b.ConfirmedAbsent = false
			b.recoveryProbe = new(bool)
			m.bindings[id] = b
		}
	}
	m.mu.Unlock()
	if ch != nil {
		close(ch)
	}
}

// WaitLostDelivered waits (up to ctx) for an in-flight state_changed(lost) emission to finish.
func (m *Manager) WaitLostDelivered(ctx context.Context, id string) {
	m.mu.Lock()
	ch := m.lostDone[id]
	m.mu.Unlock()
	if ch == nil {
		return
	}
	select {
	case <-ch:
	case <-ctx.Done():
	}
}
func (m *Manager) input(ctx context.Context, r Request, version string, evidence *InputEvidence) ([]json.RawMessage, error) {
	var q struct {
		SurfaceID  string `json:"surface_id"`
		ProposalID string `json:"proposal_id"`
		Origin     string `json:"origin,omitempty"`
		Action     struct {
			Type   string   `json:"type"`
			X      *int     `json:"x,omitempty"`
			Y      *int     `json:"y,omitempty"`
			Button string   `json:"button,omitempty"`
			Keys   []string `json:"keys,omitempty"`
			Text   string   `json:"text,omitempty"`
			DX     *int64   `json:"dx,omitempty"`
			DY     *int64   `json:"dy,omitempty"`
		} `json:"action"`
	}
	if e := cli.ParseLine(r.Params, m.cfg.MaxOutputBytes, &q); e != nil {
		return nil, e
	}
	origin := q.Origin
	if origin == "" {
		origin = "agent"
	}
	if origin != "agent" && origin != "human" {
		return nil, fault("input", "invalid input origin")
	}
	b, ok := m.bindings[q.SurfaceID]
	if !ok || b.Surface.State != "active" || b.recoveryProbe != nil || q.ProposalID == "" || len(q.ProposalID) > 128 {
		return nil, fault("surface", "input identity required")
	}
	if m.destroying[q.SurfaceID] {
		return nil, fault("POLICY", "surface is draining")
	}
	if origin == "agent" {
		if err := m.refuseLoginInput(b.Container); err != nil {
			return nil, err
		}
	}
	if origin == "human" {
		if b.Surface.Control != "human" {
			return nil, fault("SURFACE_NOT_HUMAN_CONTROLLED", "agent control blocks human input")
		}
	} else if b.Surface.Control != "agent" {
		return nil, fault("SURFACE_NOT_AGENT_CONTROLLED", "human control blocks agent input")
	}
	if (origin == "agent" && m.refresh[q.SurfaceID]) || m.hasPending(q.SurfaceID) || m.used[q.ProposalID] || len(m.used) >= 100000 {
		return nil, fault("POLICY", "fresh frame and unused input permit required")
	}
	args := []string{"input", "--container", b.Container}
	if b.Window != "" {
		args = append(args, "--window", b.Window)
	}
	var stdin []byte
	var textChunks [][]byte
	nativeAction := q.Action.Type
	switch q.Action.Type {
	case "click":
		button, valid := map[string]string{"left": "1", "middle": "2", "right": "3"}[q.Action.Button]
		if !valid || q.Action.X == nil || q.Action.Y == nil || *q.Action.X < 0 || *q.Action.Y < 0 || *q.Action.X >= b.Surface.Geometry.W || *q.Action.Y >= b.Surface.Geometry.H || len(q.Action.Keys) != 0 || q.Action.Text != "" {
			return nil, fault("input", "invalid click")
		}
		args = append(args, "--click", strconv.Itoa(*q.Action.X)+","+strconv.Itoa(*q.Action.Y), "--button", button)
	case "key":
		if len(q.Action.Keys) < 1 || len(q.Action.Keys) > 8 || q.Action.X != nil || q.Action.Y != nil || q.Action.Button != "" || q.Action.Text != "" {
			return nil, fault("input", "invalid key")
		}
		key := strings.Join(q.Action.Keys, "+")
		if !regexp.MustCompile(`^[A-Za-z0-9_+]{1,32}$`).MatchString(key) {
			return nil, fault("input", "invalid key chord")
		}
		args = append(args, "--key", key)
	case "type":
		if b.NativeKind == "holdings" || len(q.Action.Text) == 0 || q.Action.X != nil || q.Action.Y != nil || q.Action.Button != "" || len(q.Action.Keys) != 0 {
			return nil, fault("input", "invalid text")
		}
		if utf8.RuneCountInString(q.Action.Text) > AdapterTextMaxRunes {
			return nil, fault("TEXT_TOO_LONG", "text exceeds adapter rune limit")
		}
		for _, r := range q.Action.Text {
			if !unicode.IsPrint(r) {
				return nil, fault("input", "text must contain printable runes")
			}
		}
		runes := []rune(q.Action.Text)
		for len(runes) > 0 {
			n := min(len(runes), NativeTextMaxRunes)
			textChunks = append(textChunks, []byte(string(runes[:n])))
			runes = runes[n:]
		}
		nativeAction = "text"
		args = append(args, "--type-stdin")
		if (origin == "agent" && m.cfg.Profiles[b.Surface.ProfileID].TextInput == "paste") || (origin == "human" && needsPaste(q.Action.Text)) {
			args = append(args, "--paste")
		}
		stdin = []byte(q.Action.Text)
	case "scroll":
		if origin != "human" || b.NativeKind == "holdings" {
			return nil, cli.Unsupported("input action")
		}
		const i32 = 1 << 31
		if q.Action.DX == nil || q.Action.DY == nil || len(q.Action.Keys) != 0 || q.Action.Text != "" || q.Action.Button != "" || (q.Action.X == nil) != (q.Action.Y == nil) ||
			*q.Action.DX < -i32 || *q.Action.DX >= i32 || *q.Action.DY < -i32 || *q.Action.DY >= i32 || (*q.Action.DX == 0 && *q.Action.DY == 0) {
			return nil, fault("input", "invalid scroll")
		}
		px, py := b.Surface.Geometry.W/2, b.Surface.Geometry.H/2
		if q.Action.X != nil {
			px, py = *q.Action.X, *q.Action.Y
			if px < 0 || py < 0 || px >= b.Surface.Geometry.W || py >= b.Surface.Geometry.H {
				return nil, fault("input", "invalid scroll")
			}
		}
		dx, dy := *q.Action.DX, *q.Action.DY
		absDX, absDY := dx, dy
		if absDX < 0 {
			absDX = -absDX
		}
		if absDY < 0 {
			absDY = -absDY
		}
		dir, delta := "down", dy
		switch {
		case absDX > absDY && dx < 0:
			dir, delta = "left", dx
		case absDX > absDY:
			dir, delta = "right", dx
		case dy < 0:
			dir = "up"
		}
		args = append(args, "--scroll", strconv.Itoa(px)+","+strconv.Itoa(py), "--dir", dir, "--count", strconv.Itoa(scrollSteps(delta)))
	default:
		return nil, cli.Unsupported("input action")
	}
	run, cancel := context.WithCancel(ctx)
	pending := &pendingInput{surface: q.SurfaceID, epoch: m.nextInputEpoch(q.SurfaceID), cancel: cancel}
	m.pending[q.ProposalID] = pending
	m.used[q.ProposalID] = true
	defer func() {
		cancel()
		pending.done = true
		if !pending.cancelled {
			delete(m.pending, q.ProposalID)
		}
	}()
	var beforeGroundTruth *GroundTruth
	if b.NativeKind == "holdings" && origin == "agent" && evidence != nil {
		profile := m.cfg.Profiles[b.Surface.ProfileID]
		container := b.Container
		m.mu.Unlock()
		preObsOut, preObsErr := m.execute(run, profile, []string{"observe", "--container", container}, nil)
		m.mu.Lock()
		if pending.cancelled {
			return nil, fault("SURFACE_NOT_AGENT_CONTROLLED", "input cancelled by control takeover")
		}
		b, ok = m.bindings[q.SurfaceID]
		if !ok || b.Surface.State != "active" || m.destroying[q.SurfaceID] {
			return nil, fault("surface", "surface lost during input")
		}
		if b.Surface.Control != origin {
			return nil, fault("SURFACE_NOT_AGENT_CONTROLLED", "human control blocks agent input")
		}
		if e := run.Err(); e != nil {
			return nil, e
		}
		if preObsErr == nil {
			if gt, parseErr := ParseHoldingsObserve(preObsOut, m.cfg.MaxOutputBytes); parseErr == nil {
				beforeGroundTruth = gt
			}
		}
	}
	dispatched := b
	var receipt NativeInputReceipt
	var sequence *TextSequenceEvidence
	inputs := [][]byte{stdin}
	if len(textChunks) > 0 {
		inputs = textChunks
	}
	if len(textChunks) > 1 {
		sequence = &TextSequenceEvidence{}
	}
	for _, chunk := range inputs {
		if err := run.Err(); err != nil {
			return nil, err
		}
		before := m.clock()
		m.mu.Unlock()
		out, e := m.execute(run, m.cfg.Profiles[b.Surface.ProfileID], args, chunk)
		after := m.clock()
		m.mu.Lock()
		if pending.cancelled {
			return nil, fault("SURFACE_NOT_AGENT_CONTROLLED", "input cancelled by control takeover")
		}
		b, ok = m.bindings[q.SurfaceID]
		if !ok || b.Surface.State != "active" || b.recoveryProbe != nil || m.destroying[q.SurfaceID] || b.Container != dispatched.Container || b.RunID != dispatched.RunID {
			return nil, fault("surface", "surface lost during input")
		}
		if b.Surface.Control != origin {
			if origin == "human" {
				return nil, fault("SURFACE_NOT_HUMAN_CONTROLLED", "agent control blocks human input")
			}
			return nil, fault("SURFACE_NOT_AGENT_CONTROLLED", "human control blocks agent input")
		}
		if e != nil {
			return nil, e
		}
		receipt = NativeInputReceipt{}
		if e := cli.ParseLine(out, m.cfg.MaxOutputBytes, &receipt); e != nil {
			return nil, e
		}
		if receipt.Result == "refused" {
			return nil, fault("refused", "native input refused")
		}
		if receipt.InputMonoNS == nil || *receipt.InputMonoNS < m.cfg.OriginNS || *receipt.InputMonoNS > 9007199254740991 || *receipt.InputMonoNS < before || *receipt.InputMonoNS > after || after < before || (b.Window != "" && (receipt.SurfaceID != b.Window || receipt.Kind != nativeAction || receipt.FocusVerified == nil || !*receipt.FocusVerified || receipt.Result != "ok")) {
			return nil, fault("input", "unverified input receipt")
		}
		if sequence != nil {
			digest := sha256.Sum256(chunk)
			sequence.Chunks = append(sequence.Chunks, TextChunkEvidence{NativeInputReceipt: receipt, Runes: utf8.RuneCount(chunk), SHA256: hex.EncodeToString(digest[:])})
		}
	}
	var groundTruth *GroundTruth
	if b.NativeKind == "holdings" {
		// The component documents only input_mono_ns. Never interpret extra fields
		// as proof of identity or action: the verifier owns independent correlation.
		if receipt.Result != "" || receipt.SurfaceID != "" || receipt.Kind != "" || receipt.FocusVerified != nil || m.cfg.VerifyHoldingsInput == nil {
			return nil, fault("input", "independent Holdings input proof required")
		}
		action, _ := json.Marshal(q.Action)
		m.mu.Unlock()
		e := m.cfg.VerifyHoldingsInput(run, b, q.ProposalID, action, *receipt.InputMonoNS)
		m.mu.Lock()
		if m.bindings[q.SurfaceID].Surface.State != "active" {
			return nil, fault("surface", "surface lost during input verification")
		}
		if pending.cancelled {
			return nil, fault("SURFACE_NOT_AGENT_CONTROLLED", "input verification cancelled by takeover")
		}
		if m.bindings[q.SurfaceID].Surface.Control != origin {
			if origin == "human" {
				return nil, fault("SURFACE_NOT_HUMAN_CONTROLLED", "agent control blocks human input")
			}
			return nil, fault("SURFACE_NOT_AGENT_CONTROLLED", "human control blocks agent input")
		}
		if e != nil {
			return nil, e
		}
		if e := run.Err(); e != nil {
			return nil, e
		}
		if origin == "agent" && evidence != nil {
			profile := m.cfg.Profiles[b.Surface.ProfileID]
			container := b.Container
			m.mu.Unlock()
			obsOut, obsErr := m.execute(run, profile, []string{"observe", "--container", container}, nil)
			m.mu.Lock()
			if m.bindings[q.SurfaceID].Surface.State != "active" || m.destroying[q.SurfaceID] {
				return nil, fault("surface", "surface lost during input verification")
			}
			if pending.cancelled {
				return nil, fault("SURFACE_NOT_AGENT_CONTROLLED", "input verification cancelled by takeover")
			}
			if m.bindings[q.SurfaceID].Surface.Control != origin {
				return nil, fault("SURFACE_NOT_AGENT_CONTROLLED", "human control blocks agent input")
			}
			if e := run.Err(); e != nil {
				return nil, e
			}
			if obsErr == nil && beforeGroundTruth != nil {
				if gt, parseErr := ParseHoldingsObserve(obsOut, m.cfg.MaxOutputBytes); parseErr == nil {
					if (beforeGroundTruth.State == "") == (gt.State == "") {
						groundTruth = gt
					}
				}
			}
			if groundTruth == nil {
				beforeGroundTruth = nil
			}
		}
	}
	if m.bindings[q.SurfaceID].Surface.State != "active" {
		return nil, fault("surface", "surface lost during input verification")
	}
	if evidence != nil {
		// [TARGET, unit decision] contracts/v0.2 action_receipt native_evidence.kind
		// admits only click|key|text (frozen, not editable here); a verified scroll
		// receipt omits the optional kind instead of forging another value.
		evidenceKind := receipt.Kind
		if evidenceKind == "scroll" {
			evidenceKind = ""
		}
		*evidence = InputEvidence{
			TextSequence: sequence,
			SurfaceID:    q.SurfaceID, NativeSurfaceID: receipt.SurfaceID,
			Kind: evidenceKind, InputMonoNS: *receipt.InputMonoNS,
			InputTSNS:     *receipt.InputMonoNS - m.cfg.OriginNS,
			FocusVerified: receipt.FocusVerified, Result: receipt.Result,
			BeforeGroundTruth: beforeGroundTruth,
			GroundTruth:       groundTruth,
		}
	}
	return []json.RawMessage{event(version, "input_applied", struct {
		SurfaceID  string `json:"surface_id"`
		ProposalID string `json:"proposal_id"`
	}{q.SurfaceID, q.ProposalID})}, nil
}
func parseArray(b []byte, max int, dst any) error {
	if len(b) > max {
		return fault("malformed_cli", "oversize native array")
	}
	// Reuse the closed JSON decoder with a synthetic object; native start is an array.
	wrapper := append([]byte(`{"items":`), bytes.TrimSuffix(b, []byte{'\n'})...)
	wrapper = append(wrapper, '}')
	var w struct {
		Items json.RawMessage `json:"items"`
	}
	if e := cli.ParseLine(wrapper, max+16, &w); e != nil {
		return e
	}
	decoder := json.NewDecoder(bytes.NewReader(w.Items))
	decoder.DisallowUnknownFields()
	if e := decoder.Decode(dst); e != nil {
		return fault("malformed_cli", "invalid native array")
	}
	return nil
}

// HandleFor translates failures using a correlation identity reserved by the caller.
// Create has no surface_id on the wire, so no synthetic error identity is invented.
func (m *Manager) HandleFor(ctx context.Context, id string, r Request) ([]json.RawMessage, error) {
	if id == "" || len(id) > 128 {
		return nil, fault("correlation", "reserved correlation identity required")
	}
	out, e := m.Handle(ctx, r)
	if e == nil {
		return out, nil
	}
	var f *cli.Fault
	if !errors.As(e, &f) {
		f = &cli.Fault{Code: "native_failed", Detail: "native operation has no verified result"}
	}
	ev, eventErr := NewErrorEvent(id, f)
	if eventErr != nil {
		return nil, e
	}
	if r.Schema == "surface_request/v0.2" {
		ev.Schema = "surface_event/v0.2"
	}
	raw, eventErr := json.Marshal(ev)
	if eventErr != nil {
		return nil, eventErr
	}
	return []json.RawMessage{raw}, nil
}

// SubscriptionBinding admits only active surfaces; no native capture is needed.
func (m *Manager) SubscriptionBinding(id string) (Binding, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.bindings[id]
	if !ok || b.Surface.State != "active" || b.recoveryProbe != nil || m.destroying[id] {
		return Binding{}, fault("surface", "subscription requires an active surface")
	}
	return b, nil
}
