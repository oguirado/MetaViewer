// Package record owns bounded RAM captures and explicitly authorized exports.
// [TARGET, unit decision] Callers register admitted surfaces and supply requests
// through Handle, then drive Poll with their scheduler. No background process or
// disk destination is inferred. Disk stop exports a sealed tar of PNG frames.
// Owned RAM copies pin recordings independently of the live-view lease trimmer.
// Counts describe retained frames, including after ring eviction.
// [TARGET, unit decision] Release is a local lifecycle API for sealed captures;
// it deletes only owned RAM copies, reclaims budget, and retains ID tombstones.
// There is no release operation/event in the current wire contract.
package record

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"metaviewer/daemon-adapter/internal/cli"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
)

const capBytes uint64 = 1 << 30

var (
	ErrUnknownRecording = errors.New("unknown recording")
	ErrActiveRecording  = errors.New("recording is active")
)

var identity = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

type Backend interface {
	Start(context.Context, string, string) error
	Stop(context.Context, string, string) error
	Screenshot(context.Context, string) error
}
type unconfigured struct{}

func New() Backend { return unconfigured{} }
func (unconfigured) Start(context.Context, string, string) error {
	return cli.Unsupported("recording authority")
}
func (unconfigured) Stop(context.Context, string, string) error {
	return cli.Unsupported("recording authority")
}
func (unconfigured) Screenshot(context.Context, string) error {
	return cli.Unsupported("recording authority")
}

type Destination struct {
	CapabilityID string
	Path         string
}
type Surface struct {
	Family     string
	Container  string
	Window     string
	FramesRoot string
}

// Clock returns session-relative monotonic nanoseconds. OriginNS converts CLI stamps.
type Config struct {
	Runner                         cli.Runner
	Clock                          cli.Clock
	OriginNS                       uint64
	BinDir                         string
	Surfaces                       map[string]Surface
	Destination                    *Destination
	MemoryBytes, RingBytes, MaxFPS uint64
}
type Event struct {
	Schema                  string  `json:"schema"`
	RequestID               string  `json:"request_id"`
	SurfaceID               string  `json:"surface_id"`
	RecordingID             string  `json:"recording_id"`
	Event                   string  `json:"event"`
	MonoNS                  uint64  `json:"mono_ns"`
	Mode                    string  `json:"mode,omitempty"`
	FrameCount              *uint64 `json:"frame_count,omitempty"`
	ByteCount               *uint64 `json:"byte_count,omitempty"`
	RAMPath                 string  `json:"ram_path,omitempty"`
	SHA256                  string  `json:"sha256,omitempty"`
	DestinationCapabilityID string  `json:"destination_capability_id,omitempty"`
	DestinationPath         string  `json:"destination_path,omitempty"`
	DroppedFrames           *uint64 `json:"dropped_frames,omitempty"`
	Policy                  string  `json:"policy,omitempty"`
	ReasonCode              string  `json:"reason_code,omitempty"`
	Detail                  string  `json:"detail,omitempty"`
}
type Refusal struct{ ReasonCode, Detail string }

func (e *Refusal) Error() string { return e.ReasonCode + ": " + e.Detail }

type params struct {
	SurfaceID   string `json:"surface_id"`
	RecordingID string `json:"recording_id,omitempty"`
	CaptureID   string `json:"capture_id,omitempty"`
	RingBytes   uint64 `json:"ring_bytes,omitempty"`
	MaxFPS      uint64 `json:"max_fps,omitempty"`
	Capability  string `json:"destination_capability_id,omitempty"`
	Path        string `json:"destination_path,omitempty"`
}
type request struct {
	Schema    string          `json:"schema"`
	RequestID string          `json:"request_id"`
	Op        string          `json:"op"`
	Params    json.RawMessage `json:"params"`
}
type frame struct {
	path, hash        string
	bytes, generation uint64
}
type recording struct {
	surface, mode   string
	ring, fps, size uint64
	frames          []frame
	sealed          bool
	generation      uint64
	captured        bool
	lastNS          uint64
}
type Manager struct {
	mu       sync.Mutex
	cfg      Config
	records  map[string]*recording
	released map[string]struct{}
	root     string
	closed   bool
}

func NewManager(c Config) (*Manager, error) {
	if c.Runner == nil || c.Clock == nil || c.RingBytes == 0 || c.RingBytes > capBytes || c.RingBytes > c.MemoryBytes || c.MaxFPS == 0 || c.MaxFPS > 120 {
		return nil, errors.New("invalid recorder configuration")
	}
	if c.BinDir == "" {
		c.BinDir = os.Getenv("MV_SRF_BIN_DIR")
	}
	if !cleanAbsolute(c.BinDir) {
		return nil, errors.New("CLI binary directory required")
	}
	if c.Destination != nil {
		if !identity.MatchString(c.Destination.CapabilityID) || !cleanAbsolute(c.Destination.Path) {
			return nil, errors.New("invalid destination")
		}
		copy := *c.Destination
		c.Destination = &copy
	}
	surfaces := make(map[string]Surface, len(c.Surfaces))
	for id, s := range c.Surfaces {
		if !identity.MatchString(id) || (s.Family != "srf-identity-surface" && s.Family != "srf-holdings-capsule") || !identity.MatchString(s.Container) || (s.Family == "srf-identity-surface" && !regexp.MustCompile(`^w[0-9]+$`).MatchString(s.Window)) || !under("/dev/shm", s.FramesRoot) {
			return nil, errors.New("invalid surface binding")
		}
		surfaces[id] = s
	}
	c.Surfaces = surfaces
	return &Manager{cfg: c, records: map[string]*recording{}, released: map[string]struct{}{}}, nil
}
func cleanAbsolute(p string) bool {
	return filepath.IsAbs(p) && len(p) <= 4096 && filepath.Clean(p) == p && !strings.ContainsAny(p, "\x00\r\n")
}
func under(root, path string) bool {
	if !cleanAbsolute(root) || !cleanAbsolute(path) {
		return false
	}
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != "." && rel != ".." && len(rel) > 0 && rel[0] != '.' && !filepath.IsAbs(rel)
}
func ptr(v uint64) *uint64 { return &v }
func (m *Manager) base(q request, p params, id string) Event {
	return Event{Schema: "record_event/v0.2", RequestID: q.RequestID, SurfaceID: p.SurfaceID, RecordingID: id, MonoNS: m.cfg.Clock()}
}
func refuse(e Event, code, detail string) ([]Event, error) {
	e.Event = "refused"
	e.ReasonCode = code
	e.Detail = detail
	return []Event{e}, &Refusal{code, detail}
}
func parse(raw []byte) (request, params, error) {
	var q request
	var p params
	if err := cli.ParseLine(raw, 1<<20, &q); err != nil {
		return q, p, err
	}
	if q.Schema != "record_request/v0.2" || !identity.MatchString(q.RequestID) {
		return q, p, errors.New("invalid record request")
	}
	if err := cli.ParseLine(q.Params, 1<<20, &p); err != nil {
		return q, p, err
	}
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(q.Params, &fields); err != nil {
		return q, p, err
	}
	allowed := "surface_id recording_id"
	switch q.Op {
	case "ram_start":
		allowed += " ring_bytes max_fps"
	case "disk_start":
		allowed += " destination_capability_id destination_path max_fps"
	case "ram_stop", "disk_stop":
	case "screenshot":
		allowed = "surface_id capture_id"
	default:
		return q, p, errors.New("unknown record operation")
	}
	names := strings.Fields(allowed)
	if len(fields) != len(names) {
		return q, p, errors.New("closed record parameters required")
	}
	for _, name := range names {
		if value, ok := fields[name]; !ok || bytes.Equal(value, []byte("null")) {
			return q, p, errors.New("missing record parameter")
		}
	}
	return q, p, nil
}

func (m *Manager) Handle(ctx context.Context, raw []byte) ([]Event, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if m.closed {
		return nil, errors.New("recorder is closed")
	}
	q, p, err := parse(raw)
	if err != nil {
		return nil, err
	}
	id := p.RecordingID
	if q.Op == "screenshot" {
		id = p.CaptureID
	}
	if !identity.MatchString(id) || !identity.MatchString(p.SurfaceID) {
		return nil, errors.New("supplied identities required")
	}
	e := m.base(q, p, id)
	if _, ok := m.cfg.Surfaces[p.SurfaceID]; !ok {
		return refuse(e, "POLICY", "surface is not admitted")
	}
	if q.Op == "ram_stop" || q.Op == "disk_stop" {
		return m.stop(e, q.Op)
	}
	_, released := m.released[id]
	if _, ok := m.records[id]; ok || released {
		return refuse(e, "POLICY", "recording identity was already used")
	}
	mode, ring, fps := "ram", p.RingBytes, p.MaxFPS
	if q.Op == "screenshot" {
		mode = "screenshot"
		ring = m.cfg.RingBytes
		fps = 1
	}
	if q.Op == "disk_start" {
		d := m.cfg.Destination
		if d == nil || p.Capability != d.CapabilityID || p.Path != d.Path || !cleanAbsolute(p.Path) {
			return refuse(e, "POLICY", "host destination is not authorized")
		}
		mode = "disk"
		ring = m.cfg.RingBytes
	}
	if ring == 0 || ring > capBytes || fps == 0 || fps > 120 {
		return refuse(e, "POLICY", "invalid recording bounds")
	}
	if ring > m.cfg.RingBytes || fps > m.cfg.MaxFPS {
		return refuse(e, "BUDGET_EXCEEDED", "recording exceeds configured limits")
	}
	reserved := uint64(0)
	for _, r := range m.records {
		if r.ring > m.cfg.MemoryBytes-reserved {
			return refuse(e, "BUDGET_EXCEEDED", "session memory exceeded")
		}
		reserved += r.ring
	}
	if ring > m.cfg.MemoryBytes-reserved {
		return refuse(e, "BUDGET_EXCEEDED", "session memory exceeded")
	}
	r := &recording{surface: p.SurfaceID, mode: mode, ring: ring, fps: fps}
	e.Event = "started"
	e.Mode = mode
	if mode == "screenshot" {
		events, err := m.capture(ctx, q.RequestID, id, r)
		if err != nil {
			return nil, err
		}
		r.sealed = true
		m.records[id] = r
		end := m.base(q, p, id)
		end.Event = "stopped"
		end.FrameCount = ptr(uint64(len(r.frames)))
		end.ByteCount = ptr(r.size)
		return append(append([]Event{e}, events...), end), nil
	}
	m.records[id] = r
	return []Event{e}, nil
}

func (m *Manager) Poll(ctx context.Context, requestID, id string) ([]Event, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, errors.New("recorder is closed")
	}
	if !identity.MatchString(requestID) {
		return nil, errors.New("request identity required")
	}
	r, ok := m.records[id]
	if !ok || r.sealed {
		return nil, &Refusal{"POLICY", "recording is not active"}
	}
	return m.capture(ctx, requestID, id, r)
}

func (m *Manager) stop(e Event, op string) ([]Event, error) {
	r, ok := m.records[e.RecordingID]
	if !ok || r.sealed || r.surface != e.SurfaceID || (op == "disk_stop") != (r.mode == "disk") {
		return refuse(e, "POLICY", "recording is not active in this mode and surface")
	}
	var export *Event
	if r.mode == "disk" {
		out, err := m.export(e, r)
		if err != nil {
			return nil, err
		}
		export = &out
	}
	r.sealed = true
	e.Event = "stopped"
	e.FrameCount = ptr(uint64(len(r.frames)))
	e.ByteCount = ptr(r.size)
	events := []Event{e}
	if export != nil {
		events = append(events, *export)
	}
	return events, nil
}

// Release reclaims a sealed capture. Removal failures keep its reservation and
// metadata for retry; already removed owned copies are harmless on that retry.
// Producer frames and successful disk exports are never removed.
func (m *Manager) Release(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return errors.New("recorder is closed")
	}
	r, ok := m.records[id]
	if !ok {
		return ErrUnknownRecording
	}
	if !r.sealed {
		return ErrActiveRecording
	}
	for _, f := range r.frames {
		if err := os.Remove(f.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	m.released[id] = struct{}{}
	delete(m.records, id)
	return nil
}

// Close releases only the private RAM workspace, never producer-owned frames.
func (m *Manager) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.root != "" {
		if err := os.RemoveAll(m.root); err != nil {
			return err
		}
		m.root = ""
	}
	m.closed = true
	for _, r := range m.records {
		r.sealed = true
		r.frames = nil
		r.size = 0
	}
	return nil
}

// openNoLinks traverses pinned directory descriptors; symlink races fail closed.
func openNoLinks(path string, flags int, mode uint32) (*os.File, error) {
	dir, file, _, err := openNoLinksParent(path, flags, mode)
	if dir != nil {
		_ = dir.Close()
	}
	return file, err
}
func openNoLinksParent(path string, flags int, mode uint32) (*os.File, *os.File, string, error) {
	if !cleanAbsolute(path) || path == "/" {
		return nil, nil, "", errors.New("invalid file path")
	}
	dir, err := os.Open("/")
	if err != nil {
		return nil, nil, "", err
	}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	for _, part := range parts[:len(parts)-1] {
		fd, e := syscall.Openat(int(dir.Fd()), part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if e != nil {
			_ = dir.Close()
			return nil, nil, "", e
		}
		_ = dir.Close()
		dir = os.NewFile(uintptr(fd), part)
	}
	base := parts[len(parts)-1]
	fd, err := syscall.Openat(int(dir.Fd()), base, flags|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, mode)
	if err != nil {
		_ = dir.Close()
		return nil, nil, "", err
	}
	return dir, os.NewFile(uintptr(fd), path), base, nil
}
func ramFile(path string) (*os.File, error) {
	if !strings.HasPrefix(path, "/dev/shm/") {
		return nil, errors.New("frame is outside RAM")
	}
	file, err := openNoLinks(path, syscall.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	var stat syscall.Statfs_t
	info, e := file.Stat()
	if e != nil || !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, errors.New("frame is not a regular file")
	}
	if err = syscall.Fstatfs(int(file.Fd()), &stat); err != nil || stat.Type != 0x01021994 {
		_ = file.Close()
		return nil, errors.New("frame is not on tmpfs")
	}
	return file, nil
}
