package capsule

// [TARGET, unit decision] Profiles bind public kinds to admitted native programs,
// geometry, display and RAM allocation. The caller supplies hello's monotonic origin.
// [TARGET, unit decision] Holdings' documented timestamp-only input receipt and
// stopped-only stop reply lack independent proof. Trusted verification hooks
// must affirm the bound operation/removal; absent hooks fail closed.
// Local observation IDs are opaque and never reused within this manager's session.
// Uncertain native effects quarantine the profile until explicit reconciliation.
// [TARGET, unit decision] Failed readiness is compensated only for a validated,
// non-conflicting container identity. Verified removal releases quarantine;
// otherwise an uncertain fault exposes the retained quarantine. Create has no
// request dedup key: an uncertain start must never be retried automatically.
// [TARGET, unit decision] Profile geometry caps identity readiness; surface and
// input bounds track the actual CLI window, including valid smaller captures.
// Holdings has no window identity and requires exact configured capture geometry.
// [TARGET, unit decision] HandleInputWithEvidence returns request-local native
// evidence only after all input checks pass. Holdings never acquires synthetic
// focus proof; its independent verifier does not supply native focus fields.
import (
	"bytes"
	"context"
	"crypto/rand"
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

	"metaviewer/daemon-adapter/internal/cli"
)

type Profile struct {
	Kind, NativeKind, Program, AppDir, RAMRoot, Display string
	Width, Height                                       int
}
type ViewBackend interface {
	Open(context.Context, string, bool) error
	Stop(context.Context, string) error
}

type Config struct {
	BinDir                      string
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

// InputEvidence keeps the native clock and window identity alongside the public
// surface binding and the hello-relative timestamp. No evidence is cached/reused.
type InputEvidence struct {
	SurfaceID       string `json:"surface_id"`
	NativeSurfaceID string `json:"native_surface_id,omitempty"`
	Kind            string `json:"kind,omitempty"`
	InputMonoNS     uint64 `json:"input_mono_ns"`
	InputTSNS       uint64 `json:"input_ts_ns"`
	FocusVerified   *bool  `json:"focus_verified,omitempty"`
	Result          string `json:"result,omitempty"`
}
type Manager struct {
	mu          sync.Mutex
	cfg         Config
	runner      cli.Runner
	clock       cli.Clock
	bindings    map[string]Binding
	quarantined map[string]bool
	destroying  map[string]bool
	pending     map[string]*pendingInput
	used        map[string]bool
	refresh     map[string]bool
	views       map[string]bool
}

var profileID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
var identityContainer = regexp.MustCompile(`^srf-(id|pg|vm)-[a-z0-9][a-z0-9-]{0,39}$`)
var holdingsContainer = regexp.MustCompile(`^srf-ng-hcap-hc-[0-9a-f]{12}-[0-9]{1,2}$`)
var runID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
var digest = regexp.MustCompile(`^[0-9a-f]{64}$`)
var displayID = regexp.MustCompile(`^:[0-9]+(\.[0-9]+)?$`)

func fault(code, detail string) error { return &cli.Fault{Code: code, Detail: detail} }
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
	copyProfiles := make(map[string]Profile, len(cfg.Profiles))
	for id, p := range cfg.Profiles {
		if !profileID.MatchString(id) || p.Width < 1 || p.Height < 1 || p.Width > 8192 || p.Height > 8192 || !displayID.MatchString(p.Display) || !filepath.IsAbs(p.RAMRoot) || !withinRAM(p.RAMRoot) {
			return nil, fault("configuration", "invalid profile geometry or allocation")
		}
		switch p.Kind {
		case "browser":
			if p.NativeKind != "browser" || p.Program != "" {
				return nil, fault("configuration", "browser mapping invalid")
			}
		case "desktop_capsule":
			if p.NativeKind != "program" || !profileID.MatchString(p.Program) {
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
		copyProfiles[id] = p
	}
	cfg.Profiles = copyProfiles
	return &Manager{cfg: cfg, runner: r, clock: clock, bindings: make(map[string]Binding), quarantined: make(map[string]bool), destroying: make(map[string]bool), pending: make(map[string]*pendingInput), used: make(map[string]bool), refresh: make(map[string]bool), views: make(map[string]bool)}, nil
}
func withinRAM(path string) bool {
	return path == "/dev/shm" || len(path) > 9 && path[:9] == "/dev/shm/" && filepath.Clean(path) == path
}
func (m *Manager) execute(ctx context.Context, p Profile, args []string, in []byte) ([]byte, error) {
	name := "srf-identity-surface"
	if p.NativeKind == "holdings" {
		name = "srf-holdings-capsule"
	}
	ctx, cancel := context.WithTimeout(ctx, m.cfg.Timeout)
	defer cancel()
	out, err := m.runner.Run(ctx, append([]string{filepath.Join(m.cfg.BinDir, name)}, args...), in)
	if err != nil {
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
	m.mu.Unlock()
	var err error
	if r.Op == "view-stop" {
		err = m.cfg.View.Stop(ctx, b.Container)
	} else {
		err = m.cfg.View.Open(ctx, b.Container, r.Op == "login")
	}
	m.mu.Lock()
	if err != nil {
		return nil, err
	}
	if r.Op == "view-stop" {
		delete(m.views, b.Container)
	} else {
		m.views[b.Container] = true
	}
	if current, ok := m.bindings[b.Surface.SurfaceID]; ok {
		b = current
	}
	return []json.RawMessage{surfaceEvent(version, "state_changed", b.Surface)}, nil
}
func (m *Manager) create(ctx context.Context, r Request, version string) (events []json.RawMessage, err error) {
	var q struct {
		Kind      string   `json:"kind"`
		ProfileID string   `json:"profile_id"`
		Geometry  Geometry `json:"geometry"`
	}
	if e := cli.ParseLine(r.Params, m.cfg.MaxOutputBytes, &q); e != nil {
		return nil, e
	}
	p, ok := m.cfg.Profiles[q.ProfileID]
	if !ok || !profileID.MatchString(q.ProfileID) || p.Kind != q.Kind || q.Geometry.W != p.Width || q.Geometry.H != p.Height {
		return nil, fault("profile", "unadmitted profile, kind or geometry")
	}
	active := len(m.quarantined)
	for _, b := range m.bindings {
		if b.Surface.State != "destroyed" {
			if b.Surface.ProfileID == q.ProfileID {
				return nil, fault("binding", "profile already bound")
			}
			active++
		}
	}
	if active >= m.cfg.MaxSurfaces || m.quarantined[q.ProfileID] {
		return nil, fault("uncertain", "surface capacity or unresolved native outcome")
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
	// Quarantine before execution; clear only on a proven pre-spawn refusal.
	m.quarantined[q.ProfileID] = true
	out, e := m.execute(ctx, p, args, nil)
	if e != nil {
		var refused *preSpawnRefusal
		if errors.As(e, &refused) {
			delete(m.quarantined, q.ProfileID)
		}
		return nil, e
	}
	b := Binding{Surface: Surface{Schema: "surface/" + version, SurfaceID: id, Kind: p.Kind, Display: p.Display, Geometry: q.Geometry, State: "active", Visibility: "unfolded", Control: "agent", ProfileID: q.ProfileID}, NativeKind: p.NativeKind, Program: p.Program}
	// Recover only the cleanup identity from syntactically valid bounded JSON.
	// Readiness validation below remains closed and authoritative for admission.
	var cleanup struct {
		Container string `json:"container"`
		RunID     string `json:"run_id"`
	}
	if p.NativeKind == "holdings" {
		var records []struct {
			Container string `json:"container"`
			RunID     string `json:"run_id"`
		}
		if len(out) <= m.cfg.MaxOutputBytes && json.Unmarshal(out, &records) == nil && len(records) == 1 {
			cleanup.Container, cleanup.RunID = records[0].Container, records[0].RunID
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
		for _, old := range m.bindings {
			if old.Container == cleanup.Container && old.Surface.State != "destroyed" {
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
		err = fault("uncertain", "profile "+q.ProfileID+" remains quarantined after failed create: "+err.Error())
	}()
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
	for _, old := range m.bindings {
		if old.Container == b.Container && old.Surface.State != "destroyed" {
			return nil, fault("binding", "native container already observed")
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
	b.Surface.State = "destroyed"
	m.bindings[q.SurfaceID] = b
	return []json.RawMessage{surfaceEvent(version, "state_changed", b.Surface)}, nil
}

// stopNative requires mu and preserves the same removal proof for rollback and destroy.
func (m *Manager) stopNative(ctx context.Context, b Binding) error {
	out, e := m.execute(ctx, m.cfg.Profiles[b.Surface.ProfileID], []string{"stop", "--container", b.Container}, nil)
	if e != nil {
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
	if !ok || b.Surface.State != "active" || m.destroying[id] {
		m.mu.Unlock()
		return Binding{}, NativeFrame{}, fault("surface", "capture requires an active surface")
	}
	if m.hasPending(id) {
		m.mu.Unlock()
		return Binding{}, NativeFrame{}, fault("POLICY", "input must be drained before capture")
	}
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
	if !ok || current.Surface.State != "active" || m.destroying[id] || current.Container != b.Container || current.RunID != b.RunID {
		return Binding{}, NativeFrame{}, fault("surface", "capture requires an active surface")
	}
	if m.hasPending(id) {
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
	return m.markLostLocked(id, confirmedAbsent)
}

func (m *Manager) markLostLocked(id string, confirmedAbsent bool) (json.RawMessage, error) {
	b, ok := m.bindings[id]
	if confirmedAbsent && ok && b.Surface.State == "lost" {
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
	m.bindings[id] = b
	return surfaceEvent("v0.2", "state_changed", b.Surface), nil
}
func (m *Manager) input(ctx context.Context, r Request, version string, evidence *InputEvidence) ([]json.RawMessage, error) {
	var q struct {
		SurfaceID  string `json:"surface_id"`
		ProposalID string `json:"proposal_id"`
		Action     struct {
			Type   string   `json:"type"`
			X      *int     `json:"x,omitempty"`
			Y      *int     `json:"y,omitempty"`
			Button string   `json:"button,omitempty"`
			Keys   []string `json:"keys,omitempty"`
			Text   string   `json:"text,omitempty"`
		} `json:"action"`
	}
	if e := cli.ParseLine(r.Params, m.cfg.MaxOutputBytes, &q); e != nil {
		return nil, e
	}
	b, ok := m.bindings[q.SurfaceID]
	if !ok || b.Surface.State != "active" || q.ProposalID == "" || len(q.ProposalID) > 128 {
		return nil, fault("surface", "input identity required")
	}
	if m.destroying[q.SurfaceID] {
		return nil, fault("POLICY", "surface is draining")
	}
	if b.Surface.Control != "agent" {
		return nil, fault("SURFACE_NOT_AGENT_CONTROLLED", "human control blocks agent input")
	}
	if m.refresh[q.SurfaceID] || m.hasPending(q.SurfaceID) || m.used[q.ProposalID] || len(m.used) >= 100000 {
		return nil, fault("POLICY", "fresh frame and unused input permit required")
	}
	args := []string{"input", "--container", b.Container}
	if b.Window != "" {
		args = append(args, "--window", b.Window)
	}
	var stdin []byte
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
		if b.NativeKind == "holdings" || len(q.Action.Text) == 0 || len(q.Action.Text) > 16384 || q.Action.X != nil || q.Action.Y != nil || q.Action.Button != "" || len(q.Action.Keys) != 0 {
			return nil, fault("input", "invalid text")
		}
		nativeAction = "text"
		args = append(args, "--type-stdin")
		stdin = []byte(q.Action.Text)
	default:
		return nil, cli.Unsupported("input action")
	}
	run, cancel := context.WithCancel(ctx)
	pending := &pendingInput{surface: q.SurfaceID, cancel: cancel}
	m.pending[q.ProposalID] = pending
	m.used[q.ProposalID] = true
	before := m.clock()
	m.mu.Unlock()
	out, e := m.execute(run, m.cfg.Profiles[b.Surface.ProfileID], args, stdin)
	after := m.clock()
	m.mu.Lock()
	defer func() {
		cancel()
		pending.done = true
		if !pending.cancelled {
			delete(m.pending, q.ProposalID)
		}
	}()
	if pending.cancelled {
		return nil, fault("SURFACE_NOT_AGENT_CONTROLLED", "input cancelled by control takeover")
	}
	b, ok = m.bindings[q.SurfaceID]
	if !ok || b.Surface.State != "active" {
		return nil, fault("surface", "surface lost during input")
	}
	if e != nil {
		return nil, e
	}
	var receipt struct {
		SurfaceID     string  `json:"surface_id,omitempty"`
		Kind          string  `json:"kind,omitempty"`
		InputMonoNS   *uint64 `json:"input_mono_ns"`
		FocusVerified *bool   `json:"focus_verified,omitempty"`
		Result        string  `json:"result,omitempty"`
	}
	if e := cli.ParseLine(out, m.cfg.MaxOutputBytes, &receipt); e != nil {
		return nil, e
	}
	if receipt.Result == "refused" {
		return nil, fault("refused", "native input refused")
	}
	if receipt.InputMonoNS == nil || *receipt.InputMonoNS < m.cfg.OriginNS || *receipt.InputMonoNS > 9007199254740991 || *receipt.InputMonoNS < before || *receipt.InputMonoNS > after || after < before || (b.Window != "" && (receipt.SurfaceID != b.Window || receipt.Kind != nativeAction || receipt.FocusVerified == nil || !*receipt.FocusVerified || receipt.Result != "ok")) {
		return nil, fault("input", "unverified input receipt")
	}
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
		if e != nil {
			return nil, e
		}
		if e := run.Err(); e != nil {
			return nil, e
		}
	}
	if m.bindings[q.SurfaceID].Surface.State != "active" {
		return nil, fault("surface", "surface lost during input verification")
	}
	if evidence != nil {
		*evidence = InputEvidence{
			SurfaceID: q.SurfaceID, NativeSurfaceID: receipt.SurfaceID,
			Kind: receipt.Kind, InputMonoNS: *receipt.InputMonoNS,
			InputTSNS:     *receipt.InputMonoNS - m.cfg.OriginNS,
			FocusVerified: receipt.FocusVerified, Result: receipt.Result,
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
	if !ok || b.Surface.State != "active" || m.destroying[id] {
		return Binding{}, fault("surface", "subscription requires an active surface")
	}
	return b, nil
}
