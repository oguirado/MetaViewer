package capsule

// Graphical sessions address the explicit QEMU VM variant only. Native process
// identity stays in the existing surface binding; renderer values never select it.
import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"metaviewer/daemon-adapter/internal/cli"
)

const graphicalMaxInteger = uint64(9007199254740991)

var graphicalRequestID = regexp.MustCompile(`^request-[a-z0-9][a-z0-9._-]{0,63}$`)
var graphicalPointID = regexp.MustCompile(`^point-[a-z0-9][a-z0-9._-]{0,63}$`)
var graphicalOwnerID = regexp.MustCompile(`^actor-[a-z0-9][a-z0-9._-]{0,63}$`)
var graphicalRuntimeID = regexp.MustCompile(`^runtime-[0-9a-f]{64}$`)

type GraphicalRequest struct {
	Schema         string          `json:"schema"`
	RequestID      string          `json:"request_id"`
	OwnerID        string          `json:"owner_id"`
	SurfaceID      string          `json:"surface_id"`
	Op             string          `json:"op"`
	Params         json.RawMessage `json:"params"`
	Generation     *uint64         `json:"generation,omitempty"`
	AuthorityEpoch *uint64         `json:"authority_epoch,omitempty"`
}
type GraphicalPoint struct {
	PointID        string `json:"point_id"`
	Generation     uint64 `json:"generation"`
	Label          string `json:"label"`
	ManifestSHA256 string `json:"manifest_sha256"`
	CreatedMonoNS  uint64 `json:"created_mono_ns"`
}
type GraphicalSession struct {
	Schema           string           `json:"schema"`
	SurfaceID        string           `json:"surface_id"`
	RuntimeID        string           `json:"runtime_id"`
	OwnerID          string           `json:"owner_id"`
	Generation       uint64           `json:"generation"`
	AuthorityEpoch   uint64           `json:"authority_epoch"`
	Authority        string           `json:"authority"`
	Phase            string           `json:"phase"`
	Ownership        string           `json:"ownership"`
	PendingRequestID *string          `json:"pending_request_id"`
	Points           []GraphicalPoint `json:"points"`
	Backend          string           `json:"backend"`
	ISA              string           `json:"isa"`
}
type GraphicalEvent struct {
	Schema          string            `json:"schema"`
	EventID         string            `json:"event_id"`
	RequestID       string            `json:"request_id"`
	OwnerID         string            `json:"owner_id"`
	SurfaceID       string            `json:"surface_id"`
	Generation      uint64            `json:"generation"`
	AuthorityEpoch  uint64            `json:"authority_epoch"`
	Op              string            `json:"op"`
	Event           string            `json:"event"`
	ReasonCode      *string           `json:"reason_code"`
	PointID         *string           `json:"point_id"`
	Session         *GraphicalSession `json:"session"`
	ElapsedMS       *uint64           `json:"elapsed_ms"`
	FrameSHA256     *string           `json:"frame_sha256"`
	FrameGeneration *uint64           `json:"frame_generation"`
}
type graphicalNative struct {
	Schema         string  `json:"schema"`
	RuntimeID      string  `json:"runtime_id"`
	Generation     uint64  `json:"generation"`
	Op             string  `json:"op"`
	PointID        *string `json:"point_id"`
	ManifestSHA256 *string `json:"manifest_sha256"`
	ElapsedMS      uint64  `json:"elapsed_ms"`
	Status         string  `json:"status"`
	Code           *int    `json:"code"`
}
type graphicalSessionState struct {
	session                 *GraphicalSession
	surface, run            string
	busy, unknown, stopping bool
	requests                map[string]bool
	cancel                  context.CancelFunc
	deliveryRequest         string
}
type graphicalCaptureKey struct{}

func parseGraphicalNative(raw []byte, dst *graphicalNative) error {
	var fields map[string]json.RawMessage
	if err := cli.ParseLine(raw, 65536, &fields); err != nil {
		return err
	}
	names := []string{"schema", "runtime_id", "generation", "op", "point_id", "manifest_sha256", "elapsed_ms", "status", "code"}
	if len(fields) != len(names) {
		return fault("malformed_cli", "complete graphical native receipt required")
	}
	for _, name := range names {
		if _, ok := fields[name]; !ok {
			return fault("malformed_cli", "missing graphical native receipt field")
		}
	}
	for _, name := range []string{"schema", "runtime_id", "generation", "op", "elapsed_ms", "status"} {
		if string(fields[name]) == "null" {
			return fault("malformed_cli", "null graphical native receipt field")
		}
	}
	return cli.ParseLine(raw, 65536, dst)
}

func cloneGraphical(s *GraphicalSession) *GraphicalSession {
	if s == nil {
		return nil
	}
	n := *s
	n.Points = append([]GraphicalPoint{}, s.Points...)
	if s.PendingRequestID != nil {
		p := *s.PendingRequestID
		n.PendingRequestID = &p
	}
	return &n
}
func (m *Manager) graphicalBlocks(id string) bool {
	g := m.graphical
	return g != nil && g.surface == id && (g.busy || g.unknown || g.stopping)
}

// CompleteGraphicalEmission keeps normal captures fenced until the fresh frame
// and its completion event have entered the same authenticated ordered stream.
func (m *Manager) CompleteGraphicalEmission(surfaceID, requestID string, delivered bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	g := m.graphical
	if g == nil || g.surface != surfaceID || g.deliveryRequest != requestID || g.stopping {
		return
	}
	g.deliveryRequest = ""
	g.busy = false
	if !delivered {
		g.unknown = true
		if g.session != nil {
			g.session.Phase = "outcome_unknown"
			g.session.PendingRequestID = &requestID
		}
	}
}
func (m *Manager) graphicalCaptureBlocked(ctx context.Context, id string) bool {
	return m.graphicalBlocks(id) && ctx.Value(graphicalCaptureKey{}) != m.graphical
}
func (m *Manager) stopGraphicalLocked(id string) {
	if g := m.graphical; g != nil && g.surface == id {
		g.stopping = true
		if g.cancel != nil {
			g.cancel()
		}
	}
}
func parseGraphical(raw []byte) (GraphicalRequest, string, string, error) {
	var q GraphicalRequest
	if err := cli.ParseLine(raw, 65536, &q); err != nil {
		return q, "", "", err
	}
	if q.Schema != "graphical_session_request/v0.2" || !graphicalRequestID.MatchString(q.RequestID) || !graphicalOwnerID.MatchString(q.OwnerID) || q.SurfaceID == "" || len(q.SurfaceID) > 128 {
		return q, "", "", fault("usage", "invalid graphical session identity")
	}
	if q.Op != "attach" && (q.Generation == nil || q.AuthorityEpoch == nil || *q.Generation < 1 || *q.AuthorityEpoch < 1 || *q.Generation > graphicalMaxInteger || *q.AuthorityEpoch > graphicalMaxInteger) {
		return q, "", "", fault("usage", "graphical session tuple required")
	}
	var label, point string
	switch q.Op {
	case "attach":
		var p struct{}
		if q.Generation != nil || q.AuthorityEpoch != nil || cli.ParseLine(q.Params, 128, &p) != nil {
			return q, "", "", fault("usage", "closed attach required")
		}
	case "mark":
		var p struct {
			Label *string `json:"label"`
		}
		if cli.ParseLine(q.Params, 1024, &p) != nil || p.Label == nil || !utf8.ValidString(*p.Label) || utf8.RuneCountInString(*p.Label) > 80 || strings.ContainsAny(*p.Label, "/\\") {
			return q, "", "", fault("usage", "closed mark required")
		}
		for _, r := range *p.Label {
			if r < 32 || r == 127 {
				return q, "", "", fault("usage", "invalid label")
			}
		}
		label = *p.Label
	case "restore":
		var p struct {
			PointID string `json:"point_id"`
		}
		if cli.ParseLine(q.Params, 256, &p) != nil || !graphicalPointID.MatchString(p.PointID) {
			return q, "", "", fault("usage", "closed restore required")
		}
		point = p.PointID
	default:
		return q, "", "", fault("usage", "unsupported graphical session operation")
	}
	return q, label, point, nil
}
func graphicalCode(code int) string {
	switch code {
	case 2, 6:
		return "POLICY"
	case 3, 4:
		return "UNAVAILABLE"
	default:
		return "NATIVE_FAILED"
	}
}
func graphicalEvent(q GraphicalRequest, s *GraphicalSession, kind, code string) GraphicalEvent {
	g, e := uint64(1), uint64(1)
	if q.Generation != nil {
		g = *q.Generation
		e = *q.AuthorityEpoch
	}
	if s != nil {
		g = s.Generation
		e = s.AuthorityEpoch
	}
	var c *string
	if code != "" {
		c = &code
	}
	return GraphicalEvent{Schema: "graphical_session_event/v0.2", EventID: "event-" + strings.TrimPrefix(q.RequestID, "request-"), RequestID: q.RequestID, OwnerID: q.OwnerID, SurfaceID: q.SurfaceID, Generation: g, AuthorityEpoch: e, Op: q.Op, Event: kind, ReasonCode: c, Session: cloneGraphical(s)}
}

// HandleGraphicalSession is called only after the authenticated core route. A
// restore completes only after publication of a fresh existing frame reference.
func (m *Manager) HandleGraphicalSession(ctx context.Context, raw []byte, publish func(Binding, NativeFrame) (string, uint64, error)) (json.RawMessage, error) {
	q, label, point, err := parseGraphical(raw)
	if err != nil {
		return nil, err
	}
	encode := func(e GraphicalEvent) (json.RawMessage, error) {
		v, er := json.Marshal(e)
		return json.RawMessage(v), er
	}
	m.mu.Lock()
	b, ok := m.bindings[q.SurfaceID]
	refuse := func(code string) (json.RawMessage, error) {
		var s *GraphicalSession
		if m.graphical != nil && m.graphical.surface == q.SurfaceID && m.graphical.session != nil && m.graphical.session.OwnerID == q.OwnerID {
			s = m.graphical.session
		}
		e := graphicalEvent(q, s, "refused", code)
		m.mu.Unlock()
		return encode(e)
	}
	if !m.cfg.GraphicalSessions || !ok || b.Surface.State != "active" || b.NativeKind != "vm" || b.Program != "notepad-rw-vm" || m.destroying[q.SurfaceID] {
		return refuse("UNAVAILABLE")
	}
	g := m.graphical
	if g != nil && (g.surface != q.SurfaceID || g.run != b.RunID) {
		return refuse("BUSY")
	}
	if g == nil {
		g = &graphicalSessionState{surface: q.SurfaceID, run: b.RunID, requests: map[string]bool{}}
		m.graphical = g
	}
	if g.busy || g.unknown || g.stopping || m.hasPending(q.SurfaceID) {
		return refuse("BUSY")
	}
	if g.requests[q.RequestID] {
		return refuse("STALE")
	}
	if len(g.requests) >= 128 {
		return refuse("CAPACITY")
	}
	if q.Op != "attach" {
		if g.session == nil || g.session.OwnerID != q.OwnerID || g.session.Generation != *q.Generation || g.session.AuthorityEpoch != *q.AuthorityEpoch {
			return refuse("STALE")
		}
		if q.Op == "mark" && len(g.session.Points) >= 4 {
			return refuse("CAPACITY")
		}
		if q.Op == "restore" {
			found := false
			for _, p := range g.session.Points {
				if p.PointID == point {
					found = true
				}
			}
			if !found {
				return refuse("POINT_UNAVAILABLE")
			}
			if g.session.Generation == graphicalMaxInteger || g.session.AuthorityEpoch == graphicalMaxInteger {
				return refuse("CAPACITY")
			}
		}
	} else if g.session != nil && g.session.OwnerID != q.OwnerID {
		return refuse("POLICY")
	}
	if q.Op == "mark" {
		var bytes [12]byte
		if _, err = rand.Read(bytes[:]); err != nil {
			m.mu.Unlock()
			return nil, err
		}
		point = "point-" + hex.EncodeToString(bytes[:])
	}
	work, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	g.cancel = cancel
	g.busy = true
	g.requests[q.RequestID] = true
	prior := cloneGraphical(g.session)
	profile := m.cfg.Profiles[b.Surface.ProfileID]
	m.mu.Unlock()
	// Prevent new captures first, then drain the already admitted native calls.
	// No QMP operation has been dispatched while this local gate is pending.
	drainDeadline := time.Now().Add(2 * time.Second)
	for {
		m.mu.Lock()
		inflight := m.graphicalCaptures[q.SurfaceID]
		aborted := g.stopping || m.destroying[q.SurfaceID] || m.graphical != g
		m.mu.Unlock()
		if aborted {
			return nil, nil
		}
		if inflight == 0 {
			break
		}
		if work.Err() != nil || time.Now().After(drainDeadline) {
			m.mu.Lock()
			g.busy = false
			g.cancel = nil
			m.mu.Unlock()
			return encode(graphicalEvent(q, prior, "refused", "BUSY"))
		}
		time.Sleep(10 * time.Millisecond)
	}
	args := []string{"graphical-session", "--container", b.Container, "--op", q.Op}
	if q.Op != "attach" {
		args = append(args, "--generation", strconv.FormatUint(*q.Generation, 10))
	}
	if point != "" {
		args = append(args, "--point-id", point)
	}
	out, execErr := m.execute(work, profile, args, nil)
	var n graphicalNative
	if execErr == nil {
		execErr = parseGraphicalNative(out, &n)
	}
	if execErr == nil && (n.Schema != "graphical_native/v1" || n.Op != q.Op || !graphicalRuntimeID.MatchString(n.RuntimeID) || n.Generation < 1 || n.Generation > graphicalMaxInteger || n.ElapsedMS > 30000) {
		execErr = fault("malformed_cli", "graphical native binding refused")
	}
	if execErr == nil && prior != nil && n.RuntimeID != prior.RuntimeID {
		execErr = fault("malformed_cli", "graphical runtime changed")
	}
	expectedGen := uint64(1)
	if prior != nil {
		expectedGen = prior.Generation
	}
	if q.Op == "restore" && n.Status == "ready" {
		expectedGen++
	}
	if execErr == nil && n.Generation != expectedGen {
		execErr = fault("malformed_cli", "graphical native generation refused")
	}
	if execErr == nil && n.Status == "ready" {
		if n.Code != nil {
			execErr = fault("malformed_cli", "ready native result has refusal")
		}
		if q.Op == "attach" {
			if n.PointID != nil || n.ManifestSHA256 != nil {
				execErr = fault("malformed_cli", "unexpected attach point")
			}
		}
		if q.Op != "attach" && (n.PointID == nil || *n.PointID != point || n.ManifestSHA256 == nil || !digest.MatchString(*n.ManifestSHA256)) {
			execErr = fault("malformed_cli", "graphical point binding refused")
		}
		if q.Op == "restore" && execErr == nil {
			for _, p := range prior.Points {
				if p.PointID == point && p.ManifestSHA256 != *n.ManifestSHA256 {
					execErr = fault("malformed_cli", "graphical point manifest changed")
				}
			}
		}
	}
	m.mu.Lock()
	current, live := m.bindings[q.SurfaceID]
	if m.graphical != g || !live || current.RunID != b.RunID || current.Surface.State != "active" || m.destroying[q.SurfaceID] || g.stopping {
		m.mu.Unlock()
		return nil, nil
	}
	finish := func(e GraphicalEvent) (json.RawMessage, error) {
		if e.Event == "completed" {
			g.deliveryRequest = q.RequestID
		} else {
			g.busy = false
		}
		g.cancel = nil
		m.mu.Unlock()
		return encode(e)
	}
	if execErr != nil || n.Status == "outcome_unknown" {
		if q.Op == "attach" {
			return finish(graphicalEvent(q, prior, "refused", "UNAVAILABLE"))
		}
		g.unknown = true
		if g.session != nil {
			g.session.Phase = "outcome_unknown"
			g.session.PendingRequestID = &q.RequestID
		}
		return finish(graphicalEvent(q, g.session, "outcome_unknown", "OUTCOME_UNKNOWN"))
	}
	if n.Status == "refused" {
		code := "NATIVE_FAILED"
		if n.Code != nil {
			code = graphicalCode(*n.Code)
		}
		return finish(graphicalEvent(q, prior, "refused", code))
	}
	if n.Status != "ready" {
		g.unknown = true
		return finish(graphicalEvent(q, prior, "outcome_unknown", "OUTCOME_UNKNOWN"))
	}
	next := cloneGraphical(prior)
	if next == nil {
		next = &GraphicalSession{Schema: "graphical_session/v0.2", SurfaceID: q.SurfaceID, RuntimeID: n.RuntimeID, OwnerID: q.OwnerID, Generation: n.Generation, AuthorityEpoch: 1, Authority: "core", Phase: "ready", Ownership: "held", Points: []GraphicalPoint{}, Backend: "qemu", ISA: "aarch64"}
	}
	if q.Op == "mark" {
		now := m.clock()
		if now == 0 || now > graphicalMaxInteger {
			g.unknown = true
			return finish(graphicalEvent(q, prior, "outcome_unknown", "OUTCOME_UNKNOWN"))
		}
		next.Points = append(next.Points, GraphicalPoint{PointID: point, Generation: next.Generation, Label: label, ManifestSHA256: *n.ManifestSHA256, CreatedMonoNS: now})
	}
	if q.Op == "restore" {
		next.Generation++
		next.AuthorityEpoch++
		m.nextInputEpoch(q.SurfaceID)
	}
	var frameHash *string
	var frameGen *uint64
	if q.Op == "restore" {
		m.mu.Unlock()
		cb, frame, captureErr := m.Capture(context.WithValue(work, graphicalCaptureKey{}, g), q.SurfaceID)
		var hash string
		var generation uint64
		if captureErr == nil {
			if publish == nil {
				captureErr = fault("configuration", "fresh graphical frame publisher required")
			} else {
				hash, generation, captureErr = publish(cb, frame)
			}
		}
		m.mu.Lock()
		current, live = m.bindings[q.SurfaceID]
		if m.graphical != g || !live || current.Surface.State != "active" || g.stopping || m.destroying[q.SurfaceID] {
			m.mu.Unlock()
			return nil, nil
		}
		if captureErr != nil || !digest.MatchString(hash) || generation < 1 || generation > graphicalMaxInteger {
			g.unknown = true
			if g.session != nil {
				g.session.Phase = "outcome_unknown"
				g.session.PendingRequestID = &q.RequestID
			}
			return finish(graphicalEvent(q, g.session, "outcome_unknown", "OUTCOME_UNKNOWN"))
		}
		frameHash = &hash
		frameGen = &generation
	}
	next.Phase = "ready"
	next.PendingRequestID = nil
	g.session = next
	e := graphicalEvent(q, next, "completed", "")
	e.ElapsedMS = &n.ElapsedMS
	e.FrameSHA256 = frameHash
	e.FrameGeneration = frameGen
	if q.Op != "attach" {
		e.PointID = &point
	}
	return finish(e)
}
