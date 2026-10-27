package frames

// [TARGET, unit decision] Each immutable raw allocation is a publication generation;
// native sequence remains tick. Retain the latest two publications per surface.
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
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"

	"metaviewer/daemon-adapter/internal/capsule"
)

type PublishConfig struct {
	RAMRoot       string
	MaxFrameBytes int64
	MaxPixels     uint64
	MaxSurfaces   int
}
type publication struct {
	native string
	seq    uint64
	refs   []Ref
}
type Publisher struct {
	mu           sync.Mutex
	cfg          PublishConfig
	root, output *os.File
	outputPath   string
	next         uint64
	surfaces     map[string]publication
	closed       bool
}

func frameError() error { return errors.New("frame identity, allocation or pixels refused") }
func NewPublisher(cfg PublishConfig) (*Publisher, error) {
	if cfg.MaxFrameBytes < 1 || cfg.MaxFrameBytes > 64<<20 || cfg.MaxPixels < 1 || cfg.MaxPixels > 64<<20 || cfg.MaxSurfaces < 1 || filepath.Clean(cfg.RAMRoot) != cfg.RAMRoot || !strings.HasPrefix(cfg.RAMRoot, "/dev/shm/") {
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
	return &Publisher{cfg: cfg, root: root, output: output, outputPath: path, surfaces: make(map[string]publication)}, nil
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
	p.mu.Lock()
	defer p.mu.Unlock()
	old, exists := p.surfaces[id]
	if p.closed || p.output == nil || id == "" || id != b.Surface.SurfaceID || b.Container != f.Generation || f.Seq == 0 || (exists && (old.native != f.Generation || f.Seq <= old.seq)) || (!exists && len(p.surfaces) >= p.cfg.MaxSurfaces) || f.Width < 1 || f.Height < 1 || f.Width > b.Surface.Geometry.W || f.Height > b.Surface.Geometry.H || uint64(f.Width) > p.cfg.MaxPixels/uint64(f.Height) || uint64(f.Width)*uint64(f.Height) > uint64(p.cfg.MaxFrameBytes)/3 || (b.Window != "" && (f.Window == nil || f.Window.ID != b.Window || f.Window.W != f.Width || f.Window.H != f.Height)) {
		return Ref{}, frameError()
	}
	encoded, e := p.readSource(b.FramesRoot, f.Path)
	if e != nil {
		return Ref{}, e
	}
	hdr, e := png.DecodeConfig(bytes.NewReader(encoded))
	if e != nil || hdr.Width != f.Width || hdr.Height != f.Height {
		return Ref{}, frameError()
	}
	img, e := png.Decode(bytes.NewReader(encoded))
	if e != nil {
		return Ref{}, frameError()
	}
	raw := make([]byte, f.Width*f.Height*3)
	n := 0
	for y := 0; y < f.Height; y++ {
		for x := 0; x < f.Width; x++ {
			r, g, b, a := img.At(x, y).RGBA()
			if a != 65535 {
				return Ref{}, frameError()
			}
			raw[n] = byte(r >> 8)
			raw[n+1] = byte(g >> 8)
			raw[n+2] = byte(b >> 8)
			n += 3
		}
	}
	sum := sha256.Sum256(raw)
	sha := hex.EncodeToString(sum[:])
	if sha != f.SHA256RGB24 {
		return Ref{}, frameError()
	}
	if p.next == ^uint64(0) {
		return Ref{}, frameError()
	}
	random := make([]byte, 16)
	if _, e = rand.Read(random); e != nil {
		return Ref{}, e
	}
	name := hex.EncodeToString(random) + ".rgb"
	tempName := name + ".tmp"
	// Open relative to the held private directory, never through a mutable ancestor.
	fd, e := syscall.Openat(int(p.output.Fd()), tempName, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if e != nil {
		return Ref{}, e
	}
	out := os.NewFile(uintptr(fd), tempName)
	written, we := out.Write(raw)
	ce := out.Close()
	if we != nil || ce != nil || written != len(raw) {
		_ = syscall.Unlinkat(int(p.output.Fd()), tempName)
		return Ref{}, frameError()
	}
	path := filepath.Join(p.outputPath, name)
	info, se := os.Stat(p.outputPath)
	held, he := p.output.Stat()
	if se != nil || he != nil || !os.SameFile(info, held) {
		_ = syscall.Unlinkat(int(p.output.Fd()), tempName)
		return Ref{}, frameError()
	}
	if e = os.Link(filepath.Join(p.outputPath, tempName), path); e != nil {
		_ = syscall.Unlinkat(int(p.output.Fd()), tempName)
		return Ref{}, e
	}
	if e = syscall.Unlinkat(int(p.output.Fd()), tempName); e != nil {
		_ = syscall.Unlinkat(int(p.output.Fd()), name)
		return Ref{}, e
	}
	refs := old.refs
	if len(refs) >= 2 {
		expired := refs[0]
		if e = syscall.Unlinkat(int(p.output.Fd()), filepath.Base(expired.RAMWSPath)); e != nil {
			_ = syscall.Unlinkat(int(p.output.Fd()), name)
			return Ref{}, fmt.Errorf("frame lease release: %w", e)
		}
		refs = refs[1:]
	}
	p.next++
	ref := Ref{Schema: "frame_ref/v0.2", SurfaceID: id, Generation: p.next, Tick: f.Seq, TsNS: f.TSNS, Width: uint32(f.Width), Height: uint32(f.Height), Format: "rgb24", RAMWSPath: path, SHA256: sha, CaptureUS: f.CaptureUS}
	refs = append(refs, ref)
	p.surfaces[id] = publication{native: f.Generation, seq: f.Seq, refs: refs}
	return ref, nil
}

// [TARGET, unit decision] Release is called by the owner only after capture
// subscriptions drain and native removal is verified. Failure retains capacity;
// retries tolerate already unlinked owned leases. Source PNGs are never removed.
// [TARGET, unit decision] Record each successful unlink immediately so a partial
// release followed by Close never attempts to reclaim the same lease twice.
func (p *Publisher) Release(id string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	s, ok := p.surfaces[id]
	if p.closed || p.output == nil || !ok {
		return frameError()
	}
	for len(s.refs) > 0 {
		r := s.refs[0]
		if e := syscall.Unlinkat(int(p.output.Fd()), filepath.Base(r.RAMWSPath)); e != nil && !errors.Is(e, syscall.ENOENT) {
			return e
		}
		s.refs = s.refs[1:]
		p.surfaces[id] = s
	}
	delete(p.surfaces, id)
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
		for _, r := range s.refs {
			if e := syscall.Unlinkat(int(p.output.Fd()), filepath.Base(r.RAMWSPath)); e != nil && !errors.Is(e, syscall.ENOENT) {
				errs = append(errs, e)
				remaining = append(remaining, r)
			}
		}
		if len(remaining) == 0 {
			delete(p.surfaces, id)
		} else {
			s.refs = remaining
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
