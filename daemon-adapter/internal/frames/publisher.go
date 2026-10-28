package frames

// [TARGET, unit decision] Each immutable raw allocation is a publication generation;
// native sequence remains tick. Retain a time-and-byte bounded ring of recent
// publications per surface: keep each publication at least MinRetention (4 s default
// for live 64 MiB frame budgets, >= 2 s target so core witness fsyncs and UI reader
// hops never hit OPEN_ENOENT), bounded by MaxSurfaceBytes (128 MiB default for live
// budgets; min(4 * MaxFrameBytes, 64 MiB) for smaller test budgets), MaxTotalBytes
// (512 MiB global cap across surfaces), and at most MaxRetained generations (64 for
// live budgets, 16 for >= 1 MiB fixtures, 2 for small fixtures < 1 MiB), never fewer
// than 2 generations. When deduplication is enabled (PublishIfChanged or Deduplicate),
// unchanged RGB24 content hashes refresh the latest generation's retention without
// writing duplicate .rgb files, while reclaiming burst generations past MinRetention
// down to the 2-generation floor.
// Only adapter-created raw files are reclaimed; native PNGs remain producer-owned.
// [TARGET, unit decision] The configured producer root may be group-writable
// (OpenSuperficies uses 0775); world writes are refused. Output stays 0700
// and source files retain owner, mode, no-follow, immutability and hash checks.
import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
)

type Budget struct {
	mu         sync.Mutex
	maxBytes   int64
	publishers []*Publisher
}

const (
	minRGB24FrameBytes      = 3
	minRetainedSurfaceBytes = 2 * minRGB24FrameBytes
)

func NewBudget(maxTotalBytes int64) (*Budget, error) {
	if maxTotalBytes < minRetainedSurfaceBytes || maxTotalBytes > maxAllowedTotalBytes {
		return nil, frameError()
	}
	return &Budget{maxBytes: maxTotalBytes}, nil
}

type PublishConfig struct {
	RAMRoot         string
	MaxFrameBytes   int64
	MaxPixels       uint64
	MaxSurfaces     int
	MaxRetained     int
	MinRetention    time.Duration
	MaxSurfaceBytes int64
	MaxTotalBytes   int64
	Deduplicate     bool
	Budget          *Budget
}

// StageDurations records the per-frame execution time of each pipeline stage.
type StageDurations struct {
	Capture time.Duration
	Decode  time.Duration
	Hash    time.Duration
	Write   time.Duration
	Total   time.Duration
}
type publication struct {
	native    string
	seq       uint64
	refs      []Ref
	published []time.Time
	encoded   []byte
}
type Publisher struct {
	mu           sync.Mutex
	cfg          PublishConfig
	root, output *os.File
	outputPath   string
	next         uint64
	surfaces     map[string]publication
	onRelease    []func(string)
	closed       bool
	now          func() time.Time
}

func (p *Publisher) addReleaseHook(fn func(string)) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.onRelease = append(p.onRelease, fn)
}

const (
	maxRetainedSurfaceBytes  int64         = 64 << 20
	liveRetainedSurfaceBytes int64         = 128 << 20
	maxAllowedSurfaceBytes   int64         = 256 << 20
	defaultRetainedTotal     int64         = 512 << 20
	maxAllowedTotalBytes     int64         = 1024 << 20
	defaultLiveMinRetention  time.Duration = 4 * time.Second
	maxAllowedRetention      time.Duration = 60 * time.Second
)

func frameError() error { return errors.New("frame identity, allocation or pixels refused") }
func (p *Publisher) nowTime() time.Time {
	if p.now != nil {
		return p.now()
	}
	return time.Now()
}
func (p *Publisher) minRetention() time.Duration {
	if p.cfg.MinRetention > 0 {
		return p.cfg.MinRetention
	}
	if p.cfg.MaxFrameBytes >= 32<<20 {
		return defaultLiveMinRetention
	}
	return 0
}
func (p *Publisher) maxRetained() int {
	if p.cfg.MaxRetained >= 2 {
		return p.cfg.MaxRetained
	}
	if p.cfg.MaxFrameBytes >= 32<<20 || p.cfg.MinRetention > 0 || p.cfg.MaxSurfaceBytes > maxRetainedSurfaceBytes {
		return 64
	}
	if p.cfg.MaxFrameBytes >= 1<<20 {
		return 16
	}
	return 2
}
func (p *Publisher) maxRetainedBytes() int64 {
	if p.cfg.MaxSurfaceBytes > 0 {
		return p.cfg.MaxSurfaceBytes
	}
	if p.cfg.MaxFrameBytes >= 32<<20 {
		return liveRetainedSurfaceBytes
	}
	limit := p.cfg.MaxFrameBytes * 4
	if limit <= 0 || limit > maxRetainedSurfaceBytes {
		return maxRetainedSurfaceBytes
	}
	return limit
}
func (p *Publisher) maxTotalRetainedBytes() int64 {
	limit := defaultRetainedTotal
	if p.cfg.MaxTotalBytes > 0 {
		limit = p.cfg.MaxTotalBytes
	} else if p.cfg.Budget != nil && p.cfg.Budget.maxBytes > 0 {
		limit = p.cfg.Budget.maxBytes
	}
	if p.cfg.Budget != nil && p.cfg.Budget.maxBytes > 0 && p.cfg.Budget.maxBytes < limit {
		limit = p.cfg.Budget.maxBytes
	}
	return limit
}
func (p *Publisher) lockGroup() {
	if p.cfg.Budget != nil {
		p.cfg.Budget.mu.Lock()
	}
	p.mu.Lock()
}
func (p *Publisher) unlockGroup() {
	p.mu.Unlock()
	if p.cfg.Budget != nil {
		p.cfg.Budget.mu.Unlock()
	}
}
func retainedBytes(refs []Ref) int64 {
	var total int64
	for _, r := range refs {
		total += int64(r.Width) * int64(r.Height) * 3
	}
	return total
}
func (p *Publisher) otherSurfacesBytes(excludeID string) int64 {
	p.lockGroup()
	defer p.unlockGroup()
	var total int64
	for sid, s := range p.surfaces {
		if sid == excludeID {
			continue
		}
		total += retainedBytes(s.refs)
	}
	if p.cfg.Budget != nil {
		for _, peer := range p.cfg.Budget.publishers {
			if peer == p {
				continue
			}
			peer.mu.Lock()
			if !peer.closed {
				for _, s := range peer.surfaces {
					total += retainedBytes(s.refs)
				}
			}
			peer.mu.Unlock()
		}
	}
	return total
}
func NewPublisher(cfg PublishConfig) (*Publisher, error) {
	if cfg.MaxFrameBytes < minRGB24FrameBytes || cfg.MaxFrameBytes > 64<<20 || cfg.MaxPixels < 1 || cfg.MaxPixels > 64<<20 || cfg.MaxSurfaces < 1 || cfg.MaxRetained < 0 || cfg.MaxRetained == 1 || cfg.MaxRetained > 64 || cfg.MinRetention < 0 || cfg.MinRetention > maxAllowedRetention || cfg.MaxSurfaceBytes < 0 || (cfg.MaxSurfaceBytes > 0 && cfg.MaxSurfaceBytes < minRetainedSurfaceBytes) || cfg.MaxSurfaceBytes > maxAllowedSurfaceBytes || cfg.MaxTotalBytes < 0 || (cfg.MaxTotalBytes > 0 && cfg.MaxTotalBytes < minRetainedSurfaceBytes) || cfg.MaxTotalBytes > maxAllowedTotalBytes || (cfg.Budget != nil && (cfg.Budget.maxBytes < minRetainedSurfaceBytes || cfg.Budget.maxBytes > maxAllowedTotalBytes)) || (cfg.MaxSurfaceBytes > 0 && cfg.MaxTotalBytes > 0 && cfg.MaxSurfaceBytes > cfg.MaxTotalBytes) || filepath.Clean(cfg.RAMRoot) != cfg.RAMRoot || !strings.HasPrefix(cfg.RAMRoot, "/dev/shm/") {
		return nil, frameError()
	}
	p := &Publisher{cfg: cfg, surfaces: make(map[string]publication), now: time.Now}
	if p.maxRetainedBytes() < minRetainedSurfaceBytes || p.maxTotalRetainedBytes() < minRetainedSurfaceBytes || p.maxRetainedBytes() > p.maxTotalRetainedBytes() || (cfg.Budget != nil && p.maxRetainedBytes() > cfg.Budget.maxBytes) {
		return nil, frameError()
	}
	root, e := openRAMRoot(cfg.RAMRoot, false)
	if e != nil {
		return nil, e
	}
	path, e := os.MkdirTemp(cfg.RAMRoot, "frames-")
	if e != nil {
		_ = root.Close()
		return nil, e
	}
	output, e := openRAMRoot(path, true)
	if e != nil {
		_ = root.Close()
		_ = os.Remove(path)
		return nil, e
	}
	p.root = root
	p.output = output
	p.outputPath = path
	if cfg.Budget != nil {
		cfg.Budget.mu.Lock()
		cfg.Budget.publishers = append(cfg.Budget.publishers, p)
		cfg.Budget.mu.Unlock()
	}
	return p, nil
}
func openRAMRoot(path string, private bool) (*os.File, error) {
	fd, e := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if e != nil {
		return nil, e
	}
	for _, part := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		if part == "" || part == "." || part == ".." {
			_ = syscall.Close(fd)
			return nil, frameError()
		}
		next, e := syscall.Openat(fd, part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		_ = syscall.Close(fd)
		if e != nil {
			return nil, frameError()
		}
		fd = next
	}
	file := os.NewFile(uintptr(fd), path)
	var st syscall.Stat_t
	var fs syscall.Statfs_t
	if syscall.Fstat(fd, &st) != nil || syscall.Fstatfs(fd, &fs) != nil || fs.Type != 0x01021994 || st.Uid != uint32(os.Geteuid()) || (st.Mode&0002 != 0 || (private && st.Mode&0777 != 0700)) {
		_ = file.Close()
		return nil, frameError()
	}
	return file, nil
}
func (p *Publisher) readSource(rootFd int, root, path string) ([]byte, error) {
	rel, e := filepath.Rel(p.cfg.RAMRoot, path)
	bindingRel, be := filepath.Rel(p.cfg.RAMRoot, root)
	if e != nil || be != nil || filepath.Clean(path) != path || filepath.Clean(root) != root || bindingRel == ".." || strings.HasPrefix(bindingRel, "../") || !strings.HasPrefix(path, root+"/") || filepath.IsAbs(rel) || strings.HasPrefix(rel, "../") {
		_ = syscall.Close(rootFd)
		return nil, frameError()
	}
	fd := rootFd
	parts := strings.Split(rel, "/")
	for i, part := range parts {
		if part == "" || part == "." || part == ".." {
			_ = syscall.Close(fd)
			return nil, frameError()
		}
		flags := syscall.O_RDONLY | syscall.O_CLOEXEC | syscall.O_NOFOLLOW | syscall.O_NONBLOCK
		if i < len(parts)-1 {
			flags |= syscall.O_DIRECTORY
		}
		next, e := syscall.Openat(fd, part, flags, 0)
		_ = syscall.Close(fd)
		if e != nil {
			return nil, frameError()
		}
		fd = next
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	var before, after syscall.Stat_t
	var fs syscall.Statfs_t
	if syscall.Fstat(fd, &before) != nil || syscall.Fstatfs(fd, &fs) != nil || fs.Type != 0x01021994 || before.Mode&syscall.S_IFMT != syscall.S_IFREG || before.Uid != uint32(os.Geteuid()) || before.Mode&0077 != 0 || before.Nlink != 1 || before.Size < 1 || before.Size > p.cfg.MaxFrameBytes {
		return nil, frameError()
	}
	data, e := io.ReadAll(io.LimitReader(file, p.cfg.MaxFrameBytes+1))
	if e != nil {
		return nil, e
	}
	if syscall.Fstat(fd, &after) != nil {
		return nil, frameError()
	}
	before.Atim = after.Atim
	if int64(len(data)) != before.Size || before != after {
		return nil, frameError()
	}
	return data, nil
}
func (p *Publisher) Publish(id string, b capsule.Binding, f capsule.NativeFrame) (Ref, error) {
	ref, _, _, err := p.publish(id, b, f, false, nil)
	return ref, err
}

func (p *Publisher) PublishForced(id string, b capsule.Binding, f capsule.NativeFrame) (Ref, error) {
	ref, _, _, err := p.publish(id, b, f, false, nil)
	return ref, err
}

func (p *Publisher) PublishIfChanged(id string, b capsule.Binding, f capsule.NativeFrame) (Ref, bool, error) {
	ref, changed, _, err := p.publish(id, b, f, true, nil)
	return ref, changed, err
}

// PublishWithTimings publishes a frame like PublishIfChanged (when deduplicate is true)
// or Publish (when deduplicate is false) and returns the per-stage execution durations.
func (p *Publisher) PublishWithTimings(id string, b capsule.Binding, f capsule.NativeFrame, deduplicate bool) (Ref, bool, StageDurations, error) {
	return p.publish(id, b, f, deduplicate, nil)
}

var errSubscriptionCancelled = errors.New("subscription cancelled before publish commit")

func (p *Publisher) evictExpiredFloor(old *publication, now time.Time) error {
	minWin := p.minRetention()
	if minWin <= 0 {
		return nil
	}
	for len(old.refs) > 2 && len(old.published) > 0 && !now.Before(old.published[0].Add(minWin)) {
		expired := old.refs[0]
		if e := syscall.Unlinkat(int(p.output.Fd()), filepath.Base(expired.RAMWSPath)); e != nil && !errors.Is(e, syscall.ENOENT) {
			return fmt.Errorf("frame lease release: %w", e)
		}
		old.refs = old.refs[1:]
		old.published = old.published[1:]
	}
	return nil
}

func checkPNGDimensions(encoded []byte, width, height int) bool {
	if len(encoded) < 24 || string(encoded[:16]) != "\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR" {
		return false
	}
	w := int(binary.BigEndian.Uint32(encoded[16:20]))
	h := int(binary.BigEndian.Uint32(encoded[20:24]))
	return w == width && h == height
}

func decodeAndVerifyPNG(encoded []byte, width, height int, expectedSHA string) ([]byte, string, time.Duration, time.Duration, error) {
	tDecode := time.Now()
	if !checkPNGDimensions(encoded, width, height) {
		return nil, "", time.Since(tDecode), 0, frameError()
	}
	img, e := png.Decode(bytes.NewReader(encoded))
	if e != nil || img.Bounds().Dx() != width || img.Bounds().Dy() != height {
		return nil, "", time.Since(tDecode), 0, frameError()
	}
	raw, ok := extractRGB24(img, width, height)
	decodeDur := time.Since(tDecode)
	if !ok {
		return nil, "", decodeDur, 0, frameError()
	}
	tHash := time.Now()
	sum := sha256.Sum256(raw)
	sha := hex.EncodeToString(sum[:])
	hashDur := time.Since(tHash)
	if sha != expectedSHA {
		return nil, "", decodeDur, hashDur, frameError()
	}
	return raw, sha, decodeDur, hashDur, nil
}

func (p *Publisher) publish(id string, b capsule.Binding, f capsule.NativeFrame, deduplicate bool, isCancelled func() bool) (Ref, bool, StageDurations, error) {
	tStart := time.Now()
	var stages StageDurations
	p.mu.Lock()
	if isCancelled != nil && isCancelled() {
		p.mu.Unlock()
		return Ref{}, false, stages, errSubscriptionCancelled
	}
	old, exists := p.surfaces[id]
	if p.closed || p.output == nil || p.root == nil || p.next == ^uint64(0) || id == "" || id != b.Surface.SurfaceID || b.Container != f.Generation || f.Seq == 0 || len(f.SHA256RGB24) != 64 || (exists && (old.native != f.Generation || f.Seq <= old.seq)) || (!exists && len(p.surfaces) >= p.cfg.MaxSurfaces) || f.Width < 1 || f.Height < 1 || f.Width > b.Surface.Geometry.W || f.Height > b.Surface.Geometry.H || uint64(f.Width) > p.cfg.MaxPixels/uint64(f.Height) || uint64(f.Width)*uint64(f.Height) > uint64(p.cfg.MaxFrameBytes)/3 || (b.Window != "" && (f.Window == nil || f.Window.ID != b.Window || f.Window.W != f.Width || f.Window.H != f.Height)) {
		p.mu.Unlock()
		return Ref{}, false, stages, frameError()
	}
	var prevLast Ref
	var hasPrev bool
	var prevEncoded []byte
	if exists && len(old.refs) > 0 {
		prevLast = old.refs[len(old.refs)-1]
		hasPrev = true
		prevEncoded = old.encoded
	}
	rootFd, e := syscall.Dup(int(p.root.Fd()))
	p.mu.Unlock()
	if e != nil {
		return Ref{}, false, stages, e
	}

	encoded, e := p.readSource(rootFd, b.FramesRoot, f.Path)
	if e != nil {
		return Ref{}, false, stages, e
	}
	if isCancelled != nil && isCancelled() {
		return Ref{}, false, stages, errSubscriptionCancelled
	}

	var raw []byte
	sha := f.SHA256RGB24
	sameEncoded := hasPrev && len(prevEncoded) > 0 && bytes.Equal(encoded, prevEncoded) && prevLast.SHA256 == f.SHA256RGB24 && prevLast.Width == uint32(f.Width) && prevLast.Height == uint32(f.Height)
	if !sameEncoded {
		raw, sha, stages.Decode, stages.Hash, e = decodeAndVerifyPNG(encoded, f.Width, f.Height, f.SHA256RGB24)
		if e != nil {
			return Ref{}, false, stages, e
		}
	}

	p.lockGroup()
	defer p.unlockGroup()
	if isCancelled != nil && isCancelled() {
		return Ref{}, false, stages, errSubscriptionCancelled
	}
	old, exists = p.surfaces[id]
	if p.closed || p.output == nil || p.next == ^uint64(0) || (exists && (old.native != f.Generation || f.Seq <= old.seq)) || (!exists && len(p.surfaces) >= p.cfg.MaxSurfaces) {
		return Ref{}, false, stages, frameError()
	}
	now := p.nowTime()
	unchanged := exists && len(old.refs) > 0 && old.refs[len(old.refs)-1].SHA256 == sha && old.refs[len(old.refs)-1].Width == uint32(f.Width) && old.refs[len(old.refs)-1].Height == uint32(f.Height)
	if deduplicate && unchanged {
		last := old.refs[len(old.refs)-1]
		old.seq = f.Seq
		old.encoded = encoded
		if len(old.published) == len(old.refs) {
			old.published[len(old.published)-1] = now
		}
		if err := p.evictExpiredFloor(&old, now); err != nil {
			p.surfaces[id] = old
			return Ref{}, false, stages, err
		}
		p.surfaces[id] = old
		stages.Total = time.Since(tStart)
		if stages.Total > stages.Decode+stages.Hash {
			stages.Write = stages.Total - stages.Decode - stages.Hash
		}
		return last, false, stages, nil
	}

	expectedBytes := int64(f.Width) * int64(f.Height) * 3
	maxSlots := p.maxRetained()
	maxBytes := p.maxRetainedBytes()
	maxTotal := p.maxTotalRetainedBytes()
	minWin := p.minRetention()
	newBytes := expectedBytes

	type surfaceKey struct {
		pub *Publisher
		id  string
	}
	type surfaceSim struct {
		refs      []Ref
		published []time.Time
	}
	type plannedEviction struct {
		pub       *Publisher
		surfaceID string
		ref       Ref
	}

	simRefs := append([]Ref(nil), old.refs...)
	simPublished := append([]time.Time(nil), old.published...)
	var evictions []plannedEviction
	for len(simRefs) >= maxSlots || (len(simRefs) >= 2 && (retainedBytes(simRefs)+newBytes > maxBytes || (minWin > 0 && len(simPublished) > 0 && !now.Before(simPublished[0].Add(minWin))))) {
		evictions = append(evictions, plannedEviction{pub: p, surfaceID: id, ref: simRefs[0]})
		simRefs = simRefs[1:]
		if len(simPublished) > 0 {
			simPublished = simPublished[1:]
		}
	}
	if retainedBytes(simRefs)+newBytes > maxBytes {
		return Ref{}, false, stages, frameError()
	}

	peers := []*Publisher{p}
	if p.cfg.Budget != nil {
		peers = make([]*Publisher, 0, len(p.cfg.Budget.publishers))
		for _, peer := range p.cfg.Budget.publishers {
			if peer != p {
				peer.mu.Lock()
			}
			if !peer.closed && peer.output != nil {
				peers = append(peers, peer)
			} else if peer != p {
				peer.mu.Unlock()
			}
		}
	}
	peersLocked := true
	unlockPeers := func() {
		if !peersLocked {
			return
		}
		peersLocked = false
		for _, peer := range peers {
			if peer != p {
				peer.mu.Unlock()
			}
		}
	}
	defer unlockPeers()

	simOthers := make(map[surfaceKey]*surfaceSim)
	var otherKeys []surfaceKey
	var otherBytes int64
	for _, peer := range peers {
		for sid, s := range peer.surfaces {
			if peer == p && sid == id {
				continue
			}
			otherBytes += retainedBytes(s.refs)
			k := surfaceKey{pub: peer, id: sid}
			simOthers[k] = &surfaceSim{
				refs:      append([]Ref(nil), s.refs...),
				published: append([]time.Time(nil), s.published...),
			}
			otherKeys = append(otherKeys, k)
		}
	}

	for otherBytes+retainedBytes(simRefs)+newBytes > maxTotal {
		var victimKey surfaceKey
		var victimTime time.Time
		hasVictim := false
		if len(simRefs) >= 2 {
			victimKey = surfaceKey{pub: p, id: id}
			if len(simPublished) > 0 {
				victimTime = simPublished[0]
			}
			hasVictim = true
		}
		for _, k := range otherKeys {
			sim := simOthers[k]
			if len(sim.refs) <= 2 {
				continue
			}
			var t time.Time
			if len(sim.published) > 0 {
				t = sim.published[0]
			}
			if !hasVictim || t.Before(victimTime) || (t.Equal(victimTime) && (k.id < victimKey.id || (k.id == victimKey.id && k.pub.outputPath < victimKey.pub.outputPath))) {
				victimKey = k
				victimTime = t
				hasVictim = true
			}
		}
		if !hasVictim {
			break
		}
		if victimKey.pub == p && victimKey.id == id {
			evictions = append(evictions, plannedEviction{pub: p, surfaceID: id, ref: simRefs[0]})
			simRefs = simRefs[1:]
			if len(simPublished) > 0 {
				simPublished = simPublished[1:]
			}
		} else {
			sim := simOthers[victimKey]
			expired := sim.refs[0]
			evictions = append(evictions, plannedEviction{pub: victimKey.pub, surfaceID: victimKey.id, ref: expired})
			otherBytes -= int64(expired.Width) * int64(expired.Height) * 3
			sim.refs = sim.refs[1:]
			if len(sim.published) > 0 {
				sim.published = sim.published[1:]
			}
		}
	}
	if otherBytes+retainedBytes(simRefs)+newBytes > maxTotal {
		return Ref{}, false, stages, frameError()
	}

	random := make([]byte, 16)
	if _, e = rand.Read(random); e != nil {
		return Ref{}, false, stages, e
	}
	name := hex.EncodeToString(random) + ".rgb"
	path := filepath.Join(p.outputPath, name)
	info, se := os.Stat(p.outputPath)
	held, he := p.output.Stat()
	if se != nil || he != nil || !os.SameFile(info, held) {
		return Ref{}, false, stages, frameError()
	}
	linkedUnchanged := false
	if unchanged {
		lastPath := old.refs[len(old.refs)-1].RAMWSPath
		if st, stErr := os.Lstat(lastPath); stErr == nil && st.Mode().IsRegular() && st.Size() == expectedBytes {
			if os.Link(lastPath, path) == nil {
				linkedUnchanged = true
			}
		}
	}
	if !linkedUnchanged {
		if raw == nil {
			var dDur, hDur time.Duration
			raw, sha, dDur, hDur, e = decodeAndVerifyPNG(encoded, f.Width, f.Height, f.SHA256RGB24)
			stages.Decode += dDur
			stages.Hash += hDur
			if e != nil {
				return Ref{}, false, stages, e
			}
		}
		tempName := name + ".tmp"
		// Open relative to the held private directory, never through a mutable ancestor.
		fd, e := syscall.Openat(int(p.output.Fd()), tempName, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
		if e != nil {
			return Ref{}, false, stages, e
		}
		out := os.NewFile(uintptr(fd), tempName)
		written, we := out.Write(raw)
		ce := out.Close()
		if we != nil || ce != nil || written != len(raw) {
			_ = syscall.Unlinkat(int(p.output.Fd()), tempName)
			return Ref{}, false, stages, frameError()
		}
		if e = os.Link(filepath.Join(p.outputPath, tempName), path); e != nil {
			_ = syscall.Unlinkat(int(p.output.Fd()), tempName)
			return Ref{}, false, stages, e
		}
		if e = syscall.Unlinkat(int(p.output.Fd()), tempName); e != nil {
			_ = syscall.Unlinkat(int(p.output.Fd()), name)
			return Ref{}, false, stages, e
		}
	}
	if isCancelled != nil && isCancelled() {
		_ = syscall.Unlinkat(int(p.output.Fd()), name)
		return Ref{}, false, stages, errSubscriptionCancelled
	}
	refs := old.refs
	published := old.published
	for _, ev := range evictions {
		if e = syscall.Unlinkat(int(ev.pub.output.Fd()), filepath.Base(ev.ref.RAMWSPath)); e != nil && !errors.Is(e, syscall.ENOENT) {
			_ = syscall.Unlinkat(int(p.output.Fd()), name)
			if exists {
				old.refs = refs
				old.published = published
				p.surfaces[id] = old
			}
			return Ref{}, false, stages, fmt.Errorf("frame lease release: %w", e)
		}
		if ev.pub == p && ev.surfaceID == id {
			refs = refs[1:]
			if len(published) > 0 {
				published = published[1:]
			}
		} else {
			vs := ev.pub.surfaces[ev.surfaceID]
			vs.refs = vs.refs[1:]
			if len(vs.published) > 0 {
				vs.published = vs.published[1:]
			}
			ev.pub.surfaces[ev.surfaceID] = vs
		}
	}

	p.next++
	ref := Ref{Schema: "frame_ref/v0.2", SurfaceID: id, Generation: p.next, Tick: f.Seq, TsNS: f.TSNS, Width: uint32(f.Width), Height: uint32(f.Height), Format: "rgb24", RAMWSPath: path, SHA256: sha, CaptureUS: f.CaptureUS}
	refs = append(refs, ref)
	published = append(published, now)
	p.surfaces[id] = publication{native: f.Generation, seq: f.Seq, refs: refs, published: published, encoded: encoded}
	stages.Total = time.Since(tStart)
	if stages.Total > stages.Decode+stages.Hash {
		stages.Write = stages.Total - stages.Decode - stages.Hash
	}
	return ref, true, stages, nil
}

func extractRGB24(img image.Image, width, height int) ([]byte, bool) {
	switch typed := img.(type) {
	case *image.RGBA:
		return compactRGBA8ToRGB24(typed.Pix, typed.Stride, typed.Bounds(), width, height)
	case *image.NRGBA:
		return compactRGBA8ToRGB24(typed.Pix, typed.Stride, typed.Bounds(), width, height)
	default:
		raw := make([]byte, width*height*3)
		n := 0
		b := img.Bounds()
		for y := b.Min.Y; y < b.Min.Y+height; y++ {
			for x := b.Min.X; x < b.Min.X+width; x++ {
				r, g, bl, a := img.At(x, y).RGBA()
				if a != 65535 {
					return nil, false
				}
				raw[n] = byte(r >> 8)
				raw[n+1] = byte(g >> 8)
				raw[n+2] = byte(bl >> 8)
				n += 3
			}
		}
		return raw, true
	}
}

func compactRGBA8ToRGB24(pix []byte, stride int, b image.Rectangle, width, height int) ([]byte, bool) {
	rawLen := width * height * 3
	rowBytes := width * 4
	total4 := width * height * 4
	if b.Min.X == 0 && b.Min.Y == 0 && stride == rowBytes && len(pix) >= total4 {
		src := pix[:total4]
		dst := pix[:rawLen]
		n := 0
		i := 0
		for ; i+32 <= len(src); i += 32 {
			w0 := binary.LittleEndian.Uint64(src[i:])
			w1 := binary.LittleEndian.Uint64(src[i+8:])
			w2 := binary.LittleEndian.Uint64(src[i+16:])
			w3 := binary.LittleEndian.Uint64(src[i+24:])
			if (w0 & w1 & w2 & w3 & 0xff000000ff000000) != 0xff000000ff000000 {
				return nil, false
			}
			o0 := (w0 & 0x00ffffff) | ((w0 >> 8) & 0x00ffffff000000) | (w1 << 48)
			o1 := ((w1 >> 16) & 0xff) | ((w1 >> 24) & 0x00ffffff00) | ((w2 & 0x00ffffff) << 32) | ((w2 >> 32) << 56)
			o2 := ((w2 >> 40) & 0xffff) | ((w3 & 0x00ffffff) << 16) | ((w3 << 8) & 0xffffff0000000000)
			binary.LittleEndian.PutUint64(dst[n:], o0)
			binary.LittleEndian.PutUint64(dst[n+8:], o1)
			binary.LittleEndian.PutUint64(dst[n+16:], o2)
			n += 24
		}
		for ; i < len(src); i += 4 {
			r, g, bl, a := src[i], src[i+1], src[i+2], src[i+3]
			if a != 0xff {
				return nil, false
			}
			dst[n] = r
			dst[n+1] = g
			dst[n+2] = bl
			n += 3
		}
		return dst, true
	}
	raw := make([]byte, rawLen)
	n := 0
	for y := 0; y < height; y++ {
		off := (y-b.Min.Y)*stride - b.Min.X*4
		row := pix[off : off+rowBytes]
		for i := 0; i < len(row); i += 4 {
			if row[i+3] != 0xff {
				return nil, false
			}
			raw[n] = row[i]
			raw[n+1] = row[i+1]
			raw[n+2] = row[i+2]
			n += 3
		}
	}
	return raw, true
}

// [TARGET, unit decision] Release is called by the owner only after capture
// subscriptions drain and native removal is verified. Failure retains capacity;
// retries tolerate already unlinked owned leases. Source PNGs are never removed.
// [TARGET, unit decision] Record each successful unlink immediately so a partial
// release followed by Close never attempts to reclaim the same lease twice.
func (p *Publisher) Release(id string) error {
	p.lockGroup()
	s, ok := p.surfaces[id]
	if p.closed || p.output == nil || !ok {
		p.unlockGroup()
		return frameError()
	}
	for len(s.refs) > 0 {
		r := s.refs[0]
		if e := syscall.Unlinkat(int(p.output.Fd()), filepath.Base(r.RAMWSPath)); e != nil && !errors.Is(e, syscall.ENOENT) {
			p.unlockGroup()
			return e
		}
		s.refs = s.refs[1:]
		if len(s.published) > 0 {
			s.published = s.published[1:]
		}
		p.surfaces[id] = s
	}
	delete(p.surfaces, id)
	hooks := append(make([]func(string), 0, len(p.onRelease)), p.onRelease...)
	p.unlockGroup()
	for _, fn := range hooks {
		fn(id)
	}
	return nil
}
func (p *Publisher) Close() error {
	p.lockGroup()
	defer p.unlockGroup()
	if p.closed {
		return nil
	}
	var errs []error
	for id, s := range p.surfaces {
		var remaining []Ref
		var remainingPublished []time.Time
		for i, r := range s.refs {
			if e := syscall.Unlinkat(int(p.output.Fd()), filepath.Base(r.RAMWSPath)); e != nil && !errors.Is(e, syscall.ENOENT) {
				errs = append(errs, e)
				remaining = append(remaining, r)
				if i < len(s.published) {
					remainingPublished = append(remainingPublished, s.published[i])
				}
			}
		}
		if len(remaining) == 0 {
			delete(p.surfaces, id)
		} else {
			s.refs = remaining
			s.published = remainingPublished
			p.surfaces[id] = s
		}
	}
	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	var closeErrs []error
	if p.output != nil {
		closeErrs = append(closeErrs, p.output.Close())
		p.output = nil
	}
	if p.root != nil {
		closeErrs = append(closeErrs, p.root.Close())
		p.root = nil
	}
	if e := os.Remove(p.outputPath); e != nil && !errors.Is(e, os.ErrNotExist) {
		closeErrs = append(closeErrs, e)
		return errors.Join(closeErrs...)
	}
	p.closed = true
	if p.cfg.Budget != nil {
		for i, peer := range p.cfg.Budget.publishers {
			if peer == p {
				p.cfg.Budget.publishers = append(p.cfg.Budget.publishers[:i], p.cfg.Budget.publishers[i+1:]...)
				break
			}
		}
	}
	return errors.Join(closeErrs...)
}
