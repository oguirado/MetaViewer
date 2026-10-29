package frames

// [TARGET, unit decision] Opt-in MV_CAPTURE_RING=1 selects the resident source
// only after a validated root. Initial refusal reports legacy-pair and reason;
// failures after selection never fall back. Root is compiled, not configurable.
// Payload handoff retains at most two frames per surface (pipeline capacity).
import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const HostRingRoot = "/dev/shm/vqa-ring"
const ringWriterUID = 10001 // OpenSuperficies capsule writer identity
const ringFlags = 2 | 4 | 8 // ST_NOSUID, ST_NODEV, ST_NOEXEC
var ringComponent = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

type RingError struct{ Code, Detail string }

func (e *RingError) Error() string { return e.Code + ": " + e.Detail }
func ringError(code string) error  { return &RingError{Code: code, Detail: "resident ring refused"} }
func (e *RingError) Unwrap() error {
	if e.Code == "ring_stale" || e.Code == "ring_torn" {
		return context.DeadlineExceeded
	}
	return nil
}

type ringGeometry struct{ slots, w, h, stride, fps uint32 }
type ringPayload struct {
	frame capsule.NativeFrame
	raw   []byte
}
type RingSource struct {
	*capsule.Manager
	root     string
	uid, gid uint32
	clock    cli.Clock
	origin   uint64
	retries  int
	maxAge   uint64
	statfs   func(int, *syscall.Statfs_t) error
	stat     func(int, *syscall.Stat_t) error
	mu       sync.Mutex
	pinned   map[string]ringGeometry
	payloads map[string][]ringPayload
}

// RingPollInterval clamps requested FPS and caps subscription spacing at 40 ms.
func RingPollInterval(fps int) time.Duration {
	if fps < 1 {
		fps = 1
	}
	if fps > 120 {
		fps = 120
	}
	d := time.Second / time.Duration(fps)
	if d > 40*time.Millisecond {
		d = 40 * time.Millisecond
	}
	return d
}

func NewRingSource(m *capsule.Manager, clock cli.Clock, origin uint64) (*RingSource, error) {
	group, err := user.LookupGroup("vqa-ring")
	if err != nil {
		return nil, ringError("ring_root")
	}
	gid, err := strconv.ParseUint(group.Gid, 10, 32)
	if err != nil {
		return nil, ringError("ring_root")
	}
	s := &RingSource{Manager: m, root: HostRingRoot, uid: uint32(os.Geteuid()), gid: uint32(gid), clock: clock, origin: origin, retries: 4, maxAge: 500_000_000, statfs: syscall.Fstatfs, stat: syscall.Fstat, pinned: map[string]ringGeometry{}, payloads: map[string][]ringPayload{}}
	root, err := s.openRoot()
	if err != nil {
		return nil, err
	}
	root.Close()
	return s, nil
}

func openRingDir(path string) (*os.File, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, ringError("ring_root")
	}
	fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for _, part := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		next, e := syscall.Openat(fd, part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		syscall.Close(fd)
		if e != nil {
			return nil, e
		}
		fd = next
	}
	return os.NewFile(uintptr(fd), path), nil
}
func (s *RingSource) checkDir(fd int) error {
	var st syscall.Stat_t
	var fs syscall.Statfs_t
	if s.stat(fd, &st) != nil || s.statfs(fd, &fs) != nil || fs.Type != 0x01021994 || fs.Flags&ringFlags != ringFlags || st.Mode&syscall.S_IFMT != syscall.S_IFDIR || st.Mode&07777 != 02770 || st.Uid != s.uid || st.Gid != s.gid {
		return ringError("ring_root")
	}
	return nil
}
func (s *RingSource) openRoot() (*os.File, error) {
	root, err := openRingDir(s.root)
	if err != nil {
		return nil, ringError("ring_root")
	}
	if err = s.checkDir(int(root.Fd())); err != nil {
		root.Close()
		return nil, err
	}
	return root, nil
}
func (s *RingSource) openWindow(b capsule.Binding) (*os.File, error) {
	run, window := b.RunID, b.Window
	if run == "" {
		run = b.Container
	}
	if b.NativeKind == "holdings" {
		window = b.Container[strings.LastIndexByte(b.Container, '-')+1:]
	}
	if !ringComponent.MatchString(run) || !ringComponent.MatchString(window) || run == "." || run == ".." || window == "." || window == ".." {
		return nil, ringError("ring_wire")
	}
	dir, err := s.openRoot()
	if err != nil {
		return nil, err
	}
	for _, part := range []string{run, window} {
		fd, e := syscall.Openat(int(dir.Fd()), part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		dir.Close()
		if e != nil {
			if errors.Is(e, syscall.ENOENT) {
				return nil, ringError("ring_missing")
			}
			return nil, ringError("ring_hostile")
		}
		dir = os.NewFile(uintptr(fd), filepath.Join(dir.Name(), part))
		if s.checkDir(fd) != nil {
			dir.Close()
			return nil, ringError("ring_hostile")
		}
	}
	return dir, nil
}
func decodeRingGeometry(h []byte) (ringGeometry, error) {
	u := binary.BigEndian.Uint32
	g := ringGeometry{u(h[8:12]), u(h[12:16]), u(h[16:20]), u(h[20:24]), u(h[24:28])}
	if string(h[:4]) != "OSRG" || u(h[4:8]) != 1 || u(h[28:32]) != 0 || g.slots < 1 || g.slots > 16 || g.w < 1 || g.w > 4096 || g.h < 1 || g.h > 4096 || g.stride != g.w*3 || g.fps < 1 || g.fps > 120 || (binary.BigEndian.Uint64(h[40:48]) > 0 && binary.BigEndian.Uint64(h[32:40]) >= uint64(g.slots)) {
		return g, ringError("ring_wire")
	}
	return g, nil
}
func (s *RingSource) read(b capsule.Binding) (capsule.NativeFrame, []byte, error) {
	var empty capsule.NativeFrame
	dir, err := s.openWindow(b)
	if err != nil {
		return empty, nil, err
	}
	defer dir.Close()
	entries, err := dir.ReadDir(2)
	if err != nil && !errors.Is(err, io.EOF) {
		return empty, nil, ringError("ring_hostile")
	}
	if len(entries) == 0 {
		return empty, nil, ringError("ring_missing")
	}
	if len(entries) != 1 || entries[0].Name() != "ring.rgb24" || !entries[0].Type().IsRegular() {
		return empty, nil, ringError("ring_hostile")
	}
	fd, err := syscall.Openat(int(dir.Fd()), "ring.rgb24", syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return empty, nil, ringError("ring_hostile")
	}
	file := os.NewFile(uintptr(fd), filepath.Join(dir.Name(), "ring.rgb24"))
	defer file.Close()
	var st syscall.Stat_t
	var fs syscall.Statfs_t
	if s.statfs(fd, &fs) != nil || fs.Type != 0x01021994 || fs.Flags&ringFlags != ringFlags {
		return empty, nil, ringError("ring_hostile")
	}
	if s.stat(fd, &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Mode&07777 != 0640 || (st.Uid != s.uid && st.Uid != ringWriterUID) || st.Gid != s.gid || st.Nlink != 1 {
		return empty, nil, ringError("ring_hostile")
	}
	h := make([]byte, 64)
	if _, err = file.ReadAt(h, 0); err != nil {
		return empty, nil, ringError("ring_length")
	}
	g, err := decodeRingGeometry(h)
	if err != nil {
		return empty, nil, err
	}
	slotBytes := int64(64) + int64(g.w)*int64(g.h)*3
	if st.Size != 64+int64(g.slots)*slotBytes {
		return empty, nil, ringError("ring_length")
	}
	if int(g.w) > b.Surface.Geometry.W || int(g.h) > b.Surface.Geometry.H || (b.Window == "" && (int(g.w) != b.Surface.Geometry.W || int(g.h) != b.Surface.Geometry.H)) {
		return empty, nil, ringError("ring_geometry")
	}
	s.mu.Lock()
	pinned, ok := s.pinned[b.Surface.SurfaceID]
	if !ok {
		s.pinned[b.Surface.SurfaceID] = g
	}
	s.mu.Unlock()
	if ok && pinned != g {
		return empty, nil, ringError("ring_geometry")
	}
	retries := s.retries
	if retries < 1 {
		retries = 4
	}
	if retries > 16 {
		retries = 16
	}
	var best capsule.NativeFrame
	var raw []byte
	stale := false
	payload := make([]byte, int(slotBytes)-64)
	var pre, post [64]byte
	for attempt := 0; attempt < retries; attempt++ {
		for slot := uint32(0); slot < g.slots; slot++ {
			off := 64 + int64(slot)*slotBytes
			if _, err = file.ReadAt(pre[:], off); err != nil {
				continue
			}
			u := binary.BigEndian.Uint64
			lock, seq, mono := u(pre[:8]), u(pre[8:16]), u(pre[16:24])
			if lock == 0 || lock%2 != 0 || seq < 1 || binary.BigEndian.Uint32(pre[24:28]) != g.w || binary.BigEndian.Uint32(pre[28:32]) != g.h {
				continue
			}
			if _, err = file.ReadAt(payload, off+64); err != nil {
				continue
			}
			if _, err = file.ReadAt(post[:], off); err != nil || !bytes.Equal(pre[:], post[:]) {
				continue
			}
			digest := sha256.Sum256(payload)
			if !bytes.Equal(digest[:], pre[32:64]) {
				continue
			}
			now := s.clock()
			if mono > now || mono < s.origin || now-mono > s.maxAge {
				stale = true
				continue
			}
			if seq > best.Seq {
				best = capsule.NativeFrame{Path: file.Name(), Seq: seq, SHA256RGB24: hex.EncodeToString(digest[:]), Width: int(g.w), Height: int(g.h), CaptureMonoNS: mono, Generation: b.Container, TSNS: mono - s.origin}
				if b.Window != "" {
					best.Window = &capsule.Window{ID: b.Window, W: int(g.w), H: int(g.h)}
				}
				raw = append(raw[:0], payload...)
			}
		}
		if best.Seq > 0 {
			break
		}
	}
	after := make([]byte, 64)
	var final syscall.Stat_t
	var finalFS syscall.Statfs_t
	if _, err = file.ReadAt(after, 0); err != nil || s.stat(fd, &final) != nil || final.Size != st.Size || final.Gid != st.Gid || final.Uid != st.Uid || final.Mode != st.Mode || final.Nlink != 1 || s.statfs(fd, &finalFS) != nil || finalFS.Type != 0x01021994 || finalFS.Flags&ringFlags != ringFlags {
		return empty, nil, ringError("ring_hostile")
	}
	finalGeometry, err := decodeRingGeometry(after)
	if err != nil || finalGeometry != g {
		return empty, nil, ringError("ring_geometry")
	}
	if best.Seq == 0 {
		if stale {
			return empty, nil, ringError("ring_stale")
		}
		return empty, nil, ringError("ring_torn")
	}
	return best, raw, nil
}
func (s *RingSource) Capture(ctx context.Context, id string) (capsule.Binding, capsule.NativeFrame, error) {
	if err := ctx.Err(); err != nil {
		return capsule.Binding{}, capsule.NativeFrame{}, err
	}
	var raw []byte
	b, f, err := s.Manager.CaptureResident(ctx, id, func(b capsule.Binding) (capsule.NativeFrame, error) { f, p, e := s.read(b); raw = p; return f, e })
	if err != nil {
		var refusal *RingError
		if errors.As(err, &refusal) && refusal.Code != "ring_missing" && refusal.Code != "ring_stale" && refusal.Code != "ring_torn" {
			s.Forget(id)
			if stopErr := s.Manager.RefuseResident(ctx, b); stopErr != nil {
				return b, f, fmt.Errorf("%w; writer stop: %v", err, stopErr)
			}
		}
		return b, f, err
	}
	s.mu.Lock()
	q := append(s.payloads[id], ringPayload{f, raw})
	if len(q) > 2 {
		q = append([]ringPayload(nil), q[len(q)-2:]...)
	}
	s.payloads[id] = q
	s.mu.Unlock()
	return b, f, nil
}
func (s *RingSource) take(id string, f capsule.NativeFrame) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, p := range s.payloads[id] {
		if p.frame.Path == f.Path && p.frame.Seq == f.Seq && p.frame.Generation == f.Generation && p.frame.SHA256RGB24 == f.SHA256RGB24 {
			q := s.payloads[id]
			copy(q[i:], q[i+1:])
			q[len(q)-1] = ringPayload{}
			if len(q) == 1 {
				delete(s.payloads, id)
			} else {
				s.payloads[id] = q[:len(q)-1]
			}
			return p.raw, nil
		}
	}
	return nil, ringError("ring_wire")
}

// UseRingSource binds the verified in-memory handoff before subscriptions start.
func (p *Publisher) UseRingSource(s *RingSource) { p.ringSource = s }
func (p *Publisher) PublishRGB24(id string, b capsule.Binding, f capsule.NativeFrame, raw []byte) (Ref, bool, error) {
	ref, changed, _, err := p.publish(id, b, f, true, nil, raw)
	return ref, changed, err
}

// Forget releases resident state after capture subscriptions have drained.
func (s *RingSource) Forget(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.pinned, id)
	delete(s.payloads, id)
}
