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
}
type publication struct {
	native        string
	seq           uint64
	refs          []Ref
	published     []time.Time
	encodedSum    [32]byte
	hasEncodedSum bool
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
	if p.cfg.MaxTotalBytes > 0 {
		return p.cfg.MaxTotalBytes
	}
	return defaultRetainedTotal
}
func retainedBytes(refs []Ref) int64 {
	var total int64
	for _, r := range refs {
		total += int64(r.Width) * int64(r.Height) * 3
	}
	return total
}
func (p *Publisher) otherSurfacesBytes(excludeID string) int64 {
	var total int64
	for sid, s := range p.surfaces {
		if sid == excludeID {
			continue
		}
		total += retainedBytes(s.refs)
	}
	return total
}
func NewPublisher(cfg PublishConfig) (*Publisher, error) {
	if cfg.MaxFrameBytes < 1 || cfg.MaxFrameBytes > 64<<20 || cfg.MaxPixels < 1 || cfg.MaxPixels > 64<<20 || cfg.MaxSurfaces < 1 || cfg.MaxRetained < 0 || cfg.MaxRetained == 1 || cfg.MaxRetained > 64 || cfg.MinRetention < 0 || cfg.MinRetention > maxAllowedRetention || cfg.MaxSurfaceBytes < 0 || cfg.MaxSurfaceBytes > maxAllowedSurfaceBytes || cfg.MaxTotalBytes < 0 || cfg.MaxTotalBytes > maxAllowedTotalBytes || (cfg.MaxSurfaceBytes > 0 && cfg.MaxTotalBytes > 0 && cfg.MaxSurfaceBytes > cfg.MaxTotalBytes) || filepath.Clean(cfg.RAMRoot) != cfg.RAMRoot || !strings.HasPrefix(cfg.RAMRoot, "/dev/shm/") {
		return nil, frameError()
	}
	p := &Publisher{cfg: cfg, surfaces: make(map[string]publication), now: time.Now}
	if p.maxRetainedBytes() > p.maxTotalRetainedBytes() {
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
func (p *Publisher) readSource(root, path string) ([]byte, error) {
	rel, e := filepath.Rel(p.cfg.RAMRoot, path)
	bindingRel, be := filepath.Rel(p.cfg.RAMRoot, root)
	if e != nil || be != nil || filepath.Clean(path) != path || filepath.Clean(root) != root || bindingRel == ".." || strings.HasPrefix(bindingRel, "../") || !strings.HasPrefix(path, root+"/") || filepath.IsAbs(rel) || strings.HasPrefix(rel, "../") {
		return nil, frameError()
	}
	fd, e := syscall.Dup(int(p.root.Fd()))
	if e != nil {
		return nil, e
	}
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
	ref, _, err := p.publish(id, b, f, false)
	return ref, err
}

func (p *Publisher) PublishForced(id string, b capsule.Binding, f capsule.NativeFrame) (Ref, error) {
	ref, _, err := p.publish(id, b, f, false)
	return ref, err
}

func (p *Publisher) PublishIfChanged(id string, b capsule.Binding, f capsule.NativeFrame) (Ref, bool, error) {
	return p.publish(id, b, f, true)
}

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

func (p *Publisher) publish(id string, b capsule.Binding, f capsule.NativeFrame, deduplicate bool) (Ref, bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	old, exists := p.surfaces[id]
	if p.closed || p.output == nil || id == "" || id != b.Surface.SurfaceID || b.Container != f.Generation || f.Seq == 0 || (exists && (old.native != f.Generation || f.Seq <= old.seq)) || (!exists && len(p.surfaces) >= p.cfg.MaxSurfaces) || f.Width < 1 || f.Height < 1 || f.Width > b.Surface.Geometry.W || f.Height > b.Surface.Geometry.H || uint64(f.Width) > p.cfg.MaxPixels/uint64(f.Height) || uint64(f.Width)*uint64(f.Height) > uint64(p.cfg.MaxFrameBytes)/3 || (b.Window != "" && (f.Window == nil || f.Window.ID != b.Window || f.Window.W != f.Width || f.Window.H != f.Height)) {
		return Ref{}, false, frameError()
	}
	encoded, e := p.readSource(b.FramesRoot, f.Path)
	if e != nil {
		return Ref{}, false, e
	}
	encodedSum := sha256.Sum256(encoded)
	now := p.nowTime()
	if deduplicate && exists && len(old.refs) > 0 {
		last := old.refs[len(old.refs)-1]
		if old.hasEncodedSum && encodedSum == old.encodedSum && last.SHA256 == f.SHA256RGB24 && last.Width == uint32(f.Width) && last.Height == uint32(f.Height) {
			old.seq = f.Seq
			if len(old.published) == len(old.refs) {
				old.published[len(old.published)-1] = now
			}
			if err := p.evictExpiredFloor(&old, now); err != nil {
				p.surfaces[id] = old
				return Ref{}, false, err
			}
			p.surfaces[id] = old
			return last, false, nil
		}
	}
	hdr, e := png.DecodeConfig(bytes.NewReader(encoded))
	if e != nil || hdr.Width != f.Width || hdr.Height != f.Height {
		return Ref{}, false, frameError()
	}
	img, e := png.Decode(bytes.NewReader(encoded))
	if e != nil {
		return Ref{}, false, frameError()
	}
	raw, ok := extractRGB24(img, f.Width, f.Height)
	if !ok {
		return Ref{}, false, frameError()
	}
	sum := sha256.Sum256(raw)
	sha := hex.EncodeToString(sum[:])
	if sha != f.SHA256RGB24 {
		return Ref{}, false, frameError()
	}
	if deduplicate && exists && len(old.refs) > 0 {
		last := old.refs[len(old.refs)-1]
		if last.SHA256 == sha && last.Width == uint32(f.Width) && last.Height == uint32(f.Height) {
			old.seq = f.Seq
			old.encodedSum = encodedSum
			old.hasEncodedSum = true
			if len(old.published) == len(old.refs) {
				old.published[len(old.published)-1] = now
			}
			if err := p.evictExpiredFloor(&old, now); err != nil {
				p.surfaces[id] = old
				return Ref{}, false, err
			}
			p.surfaces[id] = old
			return last, false, nil
		}
	}
	if p.next == ^uint64(0) {
		return Ref{}, false, frameError()
	}
	random := make([]byte, 16)
	if _, e = rand.Read(random); e != nil {
		return Ref{}, false, e
	}
	name := hex.EncodeToString(random) + ".rgb"
	tempName := name + ".tmp"
	// Open relative to the held private directory, never through a mutable ancestor.
	fd, e := syscall.Openat(int(p.output.Fd()), tempName, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if e != nil {
		return Ref{}, false, e
	}
	out := os.NewFile(uintptr(fd), tempName)
	written, we := out.Write(raw)
	ce := out.Close()
	if we != nil || ce != nil || written != len(raw) {
		_ = syscall.Unlinkat(int(p.output.Fd()), tempName)
		return Ref{}, false, frameError()
	}
	path := filepath.Join(p.outputPath, name)
	info, se := os.Stat(p.outputPath)
	held, he := p.output.Stat()
	if se != nil || he != nil || !os.SameFile(info, held) {
		_ = syscall.Unlinkat(int(p.output.Fd()), tempName)
		return Ref{}, false, frameError()
	}
	if e = os.Link(filepath.Join(p.outputPath, tempName), path); e != nil {
		_ = syscall.Unlinkat(int(p.output.Fd()), tempName)
		return Ref{}, false, e
	}
	if e = syscall.Unlinkat(int(p.output.Fd()), tempName); e != nil {
		_ = syscall.Unlinkat(int(p.output.Fd()), name)
		return Ref{}, false, e
	}
	refs := old.refs
	published := old.published
	maxSlots := p.maxRetained()
	maxBytes := p.maxRetainedBytes()
	maxTotal := p.maxTotalRetainedBytes()
	minWin := p.minRetention()
	newBytes := int64(len(raw))
	for len(refs) >= maxSlots || (len(refs) >= 2 && (retainedBytes(refs)+newBytes > maxBytes || (minWin > 0 && len(published) > 0 && !now.Before(published[0].Add(minWin))))) {
		expired := refs[0]
		if e = syscall.Unlinkat(int(p.output.Fd()), filepath.Base(expired.RAMWSPath)); e != nil {
			_ = syscall.Unlinkat(int(p.output.Fd()), name)
			if exists {
				old.refs = refs
				old.published = published
				p.surfaces[id] = old
			}
			return Ref{}, false, fmt.Errorf("frame lease release: %w", e)
		}
		refs = refs[1:]
		if len(published) > 0 {
			published = published[1:]
		}
	}
	for p.otherSurfacesBytes(id)+retainedBytes(refs)+newBytes > maxTotal {
		victimID := ""
		var victimTime time.Time
		if len(refs) >= 2 {
			victimID = id
			if len(published) > 0 {
				victimTime = published[0]
			}
		}
		for sid, s := range p.surfaces {
			if sid == id || len(s.refs) <= 2 {
				continue
			}
			var t time.Time
			if len(s.published) > 0 {
				t = s.published[0]
			}
			if victimID == "" || t.Before(victimTime) || (t.Equal(victimTime) && sid < victimID) {
				victimID = sid
				victimTime = t
			}
		}
		if victimID == "" {
			break
		}
		if victimID == id {
			expired := refs[0]
			if e = syscall.Unlinkat(int(p.output.Fd()), filepath.Base(expired.RAMWSPath)); e != nil {
				_ = syscall.Unlinkat(int(p.output.Fd()), name)
				if exists {
					old.refs = refs
					old.published = published
					p.surfaces[id] = old
				}
				return Ref{}, false, fmt.Errorf("frame lease release: %w", e)
			}
			refs = refs[1:]
			if len(published) > 0 {
				published = published[1:]
			}
		} else {
			vs := p.surfaces[victimID]
			expired := vs.refs[0]
			if e = syscall.Unlinkat(int(p.output.Fd()), filepath.Base(expired.RAMWSPath)); e != nil {
				_ = syscall.Unlinkat(int(p.output.Fd()), name)
				if exists {
					old.refs = refs
					old.published = published
					p.surfaces[id] = old
				}
				return Ref{}, false, fmt.Errorf("frame lease release: %w", e)
			}
			vs.refs = vs.refs[1:]
			if len(vs.published) > 0 {
				vs.published = vs.published[1:]
			}
			p.surfaces[victimID] = vs
		}
	}
	p.next++
	ref := Ref{Schema: "frame_ref/v0.2", SurfaceID: id, Generation: p.next, Tick: f.Seq, TsNS: f.TSNS, Width: uint32(f.Width), Height: uint32(f.Height), Format: "rgb24", RAMWSPath: path, SHA256: sha, CaptureUS: f.CaptureUS}
	refs = append(refs, ref)
	published = append(published, now)
	p.surfaces[id] = publication{native: f.Generation, seq: f.Seq, refs: refs, published: published, encodedSum: encodedSum, hasEncodedSum: true}
	return ref, true, nil
}

func extractRGB24(img image.Image, width, height int) ([]byte, bool) {
	raw := make([]byte, width*height*3)
	n := 0
	switch typed := img.(type) {
	case *image.RGBA:
		b := typed.Bounds()
		for y := 0; y < height; y++ {
			row := (y - b.Min.Y) * typed.Stride
			for x := 0; x < width; x++ {
				off := row + (x-b.Min.X)*4
				if typed.Pix[off+3] != 0xff {
					return nil, false
				}
				raw[n] = typed.Pix[off]
				raw[n+1] = typed.Pix[off+1]
				raw[n+2] = typed.Pix[off+2]
				n += 3
			}
		}
		return raw, true
	case *image.NRGBA:
		b := typed.Bounds()
		for y := 0; y < height; y++ {
			row := (y - b.Min.Y) * typed.Stride
			for x := 0; x < width; x++ {
				off := row + (x-b.Min.X)*4
				if typed.Pix[off+3] != 0xff {
					return nil, false
				}
				raw[n] = typed.Pix[off]
				raw[n+1] = typed.Pix[off+1]
				raw[n+2] = typed.Pix[off+2]
				n += 3
			}
		}
		return raw, true
	default:
		for y := 0; y < height; y++ {
			for x := 0; x < width; x++ {
				r, g, b, a := img.At(x, y).RGBA()
				if a != 65535 {
					return nil, false
				}
				raw[n] = byte(r >> 8)
				raw[n+1] = byte(g >> 8)
				raw[n+2] = byte(b >> 8)
				n += 3
			}
		}
		return raw, true
	}
}

// [TARGET, unit decision] Release is called by the owner only after capture
// subscriptions drain and native removal is verified. Failure retains capacity;
// retries tolerate already unlinked owned leases. Source PNGs are never removed.
// [TARGET, unit decision] Record each successful unlink immediately so a partial
// release followed by Close never attempts to reclaim the same lease twice.
func (p *Publisher) Release(id string) error {
	p.mu.Lock()
	s, ok := p.surfaces[id]
	if p.closed || p.output == nil || !ok {
		p.mu.Unlock()
		return frameError()
	}
	for len(s.refs) > 0 {
		r := s.refs[0]
		if e := syscall.Unlinkat(int(p.output.Fd()), filepath.Base(r.RAMWSPath)); e != nil && !errors.Is(e, syscall.ENOENT) {
			p.mu.Unlock()
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
	p.mu.Unlock()
	for _, fn := range hooks {
		fn(id)
	}
	return nil
}
func (p *Publisher) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
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
	return errors.Join(closeErrs...)
}
