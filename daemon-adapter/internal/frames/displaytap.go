package frames

// [TARGET, unit decision] DISPLAY is an independent, best-effort consumer of
// OpenSuperficies W8U streams. It never calls Capture or Publisher. One supervisor
// serializes incarnations; EOF, malformed framing and window replacement retire
// and reap the old child before restart. Bounds: 4096 pixels per dimension,
// one record plus one converted frame, and a two-slot tmpfs ring [TARGET].
import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
)

// DisplayBaseDir selects the spec-v1.1 tmpfs base independently of the
// packaged application's private (possibly ext4) XDG_RUNTIME_DIR.
func DisplayBaseDir() string {
	if base := os.Getenv("MV_DISPLAY_DIR"); base != "" {
		return base
	}
	return fmt.Sprintf("/dev/shm/metaviewer-display-%d", os.Getuid())
}

type DisplayTarget struct {
	Container, Run, Window string
	XID                    uint32
	Width, Height          int
}
type DisplayTapConfig struct {
	RuntimeDir  string
	Resolve     func(string) (DisplayTarget, error)
	Admit       func() error
	Diagnostics io.Writer
	// Command is a deterministic test seam; production always uses docker exec.
	Command func(context.Context, DisplayTarget) *exec.Cmd
}
type displayTask struct {
	cancel context.CancelFunc
	done   chan struct{}
}
type DisplayTaps struct {
	mu     sync.Mutex
	ctx    context.Context
	cfg    DisplayTapConfig
	tasks  map[string]*displayTask
	closed bool
}

var displayGeneration atomic.Uint64

func NewDisplayTaps(ctx context.Context, cfg DisplayTapConfig) *DisplayTaps {
	return &DisplayTaps{ctx: ctx, cfg: cfg, tasks: map[string]*displayTask{}}
}
func (d *DisplayTaps) Start(id string) {
	if d == nil || os.Getenv("MV_DISPLAY_TAP") == "off" || !ringComponent.MatchString(id) {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed || d.ctx.Err() != nil || d.tasks[id] != nil {
		return
	}
	ctx, cancel := context.WithCancel(d.ctx)
	t := &displayTask{cancel: cancel, done: make(chan struct{})}
	d.tasks[id] = t
	go func() {
		defer close(t.done)
		defer cancel()
		defer func() {
			d.mu.Lock()
			if d.tasks[id] == t {
				delete(d.tasks, id)
			}
			d.mu.Unlock()
		}()
		d.run(ctx, id)
	}()
}

// StartReplies handles the admitted create reply. Live creates need not include
// a frame_ready event: the binding already exists when created is emitted.
func (d *DisplayTaps) StartReplies(events []json.RawMessage) {
	for _, raw := range events {
		var ev struct {
			Event string
			Data  struct {
				Surface  capsule.Surface
				FrameRef Ref `json:"frame_ref"`
			}
		}
		if json.Unmarshal(raw, &ev) != nil {
			continue
		}
		if ev.Event == "frame_ready" && ev.Data.FrameRef.Generation > 0 {
			d.Start(ev.Data.FrameRef.SurfaceID)
		} else if ev.Event == "created" && ev.Data.Surface.SurfaceID != "" {
			d.Start(ev.Data.Surface.SurfaceID)
		}
	}
}

func (d *DisplayTaps) Stop(ctx context.Context, id string) error {
	if d == nil {
		return nil
	}
	d.mu.Lock()
	t := d.tasks[id]
	if t != nil {
		t.cancel()
	}
	d.mu.Unlock()
	if t == nil {
		return nil
	}
	select {
	case <-t.done:
		d.mu.Lock()
		if d.tasks[id] == t {
			delete(d.tasks, id)
		}
		d.mu.Unlock()
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (d *DisplayTaps) Close(ctx context.Context) error {
	if d == nil {
		return nil
	}
	d.mu.Lock()
	d.closed = true
	ids := make([]string, 0, len(d.tasks))
	for id, t := range d.tasks {
		t.cancel()
		ids = append(ids, id)
	}
	d.mu.Unlock()
	var errs []error
	for _, id := range ids {
		errs = append(errs, d.Stop(ctx, id))
	}
	return errors.Join(errs...)
}
func (d *DisplayTaps) run(ctx context.Context, id string) {
	path := filepath.Join(d.cfg.RuntimeDir, "metaviewer", "display", id+".ring")
	delay := 100 * time.Millisecond
	warned := false
	for ctx.Err() == nil {
		if d.cfg.Admit == nil {
			return
		}
		if err := d.cfg.Admit(); err != nil {
			if !warned && d.cfg.Diagnostics != nil {
				fmt.Fprintln(d.cfg.Diagnostics, "adapter: DISPLAY tap refused by RAM admission")
				warned = true
			}
			return
		}
		if ctx.Err() != nil {
			return
		}
		target, err := d.cfg.Resolve(id)
		if err != nil {
			d.diag("adapter: DISPLAY tap %s: resolve: %v", id, err)
			return
		}
		if err = validDisplayTarget(target); err != nil {
			d.diag("adapter: DISPLAY tap %s: %v (%+v)", id, err, target)
			return
		}
		if err = d.session(ctx, id, path, target); err != nil && ctx.Err() == nil {
			d.diag("adapter: DISPLAY tap %s: session ended: %v", id, err)
		}
		if ctx.Err() != nil {
			return
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		delay = min(2*time.Second, delay*2)
	}
}
func validDisplayTarget(t DisplayTarget) error {
	if !ringComponent.MatchString(t.Container) || !ringComponent.MatchString(t.Run) || t.XID == 0 || t.Width < 1 || t.Height < 1 || t.Width > 4096 || t.Height > 4096 {
		return errors.New("invalid DISPLAY target")
	}
	return nil
}
func (d *DisplayTaps) session(parent context.Context, id, path string, target DisplayTarget) error {
	if err := parent.Err(); err != nil {
		return err
	}
	// Renew below the recorder's documented session cap [CITED: recstream.go].
	ctx, cancel := context.WithTimeout(parent, 9*time.Minute)
	defer cancel()
	processCtx, kill := context.WithCancel(context.WithoutCancel(parent))
	defer kill()
	ring := &displayRing{path: path, generation: uint64(time.Now().UnixNano()) + displayGeneration.Add(1)}
	if err := ring.open(target); err != nil {
		return err
	}
	defer ring.close()
	cmd := (*exec.Cmd)(nil)
	xwdMode := false
	if d.cfg.Command != nil {
		cmd = d.cfg.Command(processCtx, target)
	} else {
		// [TARGET, conductor decision 2026-10-31] The deployed identity image's
		// srf-fbread has no `stream` verb (usage: read | getimage | pair), so the
		// production DISPLAY sender is ONE resident docker exec looping the same
		// binary's `getimage` (an XWD of the window on stdout) at about 30 fps,
		// as the VERIFIED capture's user and display. No per-frame docker exec.
		cmd = displayGetimageCommand(processCtx, target)
		xwdMode = true
	}
	// Own the local process group, including fake sender descendants. Closing
	// control also makes the remote sender leave its credit wait on EOF.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 100 * time.Millisecond
	input, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		return err
	}
	stderrTail := &tailBuffer{max: 2048}
	cmd.Stderr = stderrTail
	if err = cmd.Start(); err != nil {
		input.Close()
		output.Close()
		return err
	}
	body, digest := displayBinding(target)
	decodeDone := make(chan error, 1)
	go func() {
		if xwdMode {
			decodeDone <- displayDecodeXWD(output, target, ring.publish)
			return
		}
		e := displayWriteControl(input, 1, digest, body)
		if e == nil {
			e = displayAck(input, digest, 0)
		}
		if e == nil {
			e = displayDecode(output, input, digest, target, ring.publish)
		}
		decodeDone <- e
	}()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	var result error
	decoded := false
loop:
	for {
		select {
		case result = <-decodeDone:
			decoded = true
			break loop
		case <-ctx.Done():
			result = ctx.Err()
			break loop
		case <-ticker.C:
			current, e := d.cfg.Resolve(id)
			if e != nil || current != target {
				result = errors.New("DISPLAY binding retired")
				break loop
			}
		}
	}
	// STOP is bounded: a sender wedged mid-frame must not extend shutdown.
	_ = input.(*os.File).SetWriteDeadline(time.Now().Add(20 * time.Millisecond))
	_ = displayWriteControl(input, 3, digest, nil)
	input.Close()
	output.Close()
	waited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(waited) }()
	select {
	case <-waited:
	case <-time.After(100 * time.Millisecond):
		kill()
		<-waited
	}
	// Closing both pipes releases a truncated read or blocked ACK before unmap.
	if !decoded {
		<-decodeDone
	}
	ring.close()
	if result != nil && !errors.Is(result, context.Canceled) {
		if tail := stderrTail.String(); tail != "" {
			result = fmt.Errorf("%w (sender stderr: %s)", result, tail)
		}
	}
	return result
}

func displayGetimageCommand(ctx context.Context, target DisplayTarget) *exec.Cmd {
	loop := "while :; do /usr/local/libexec/srf-fbread getimage :100 " + strconv.FormatUint(uint64(target.XID), 10) + " 2>/dev/null || exit 9; sleep 0.03; done"
	return exec.CommandContext(ctx, "docker", "exec", "-i", "-u", "10001:10001", "-e", "DISPLAY=:100", target.Container, "sh", "-c", loop)
}

func displayBinding(t DisplayTarget) ([]byte, [32]byte) {
	// Map encoding sorts keys recursively, matching ramcap.CanonicalJSON.
	root := "/dev/shm/vqa-ramws"
	b, _ := json.Marshal(map[string]any{"schema": "w8u-binding/1", "run_id": t.Run, "lease_id": "metaviewer-display", "seat_grant_sha256": "AUSENTE", "container_id": t.Container, "target_handle": map[string]any{"kind": "capsule", "canonical_id": t.Container, "generation": t.Run}, "epoch": 0, "display": ":100", "xid": t.XID, "width": t.Width, "height": t.Height, "frames_root": root, "frame_run_root": root + "/opensuperficies/os-cu-0/" + t.Run, "image_sha256": "AUSENTE", "reader_sha256": "AUSENTE", "exec_allowlist_sha256": "AUSENTE", "max_record_bytes": displayRecordCap(t), "max_inflight_frames": 2, "tick_mode": "unavailable"})
	return b, sha256.Sum256(b)
}
func displayRecordCap(t DisplayTarget) uint64 {
	return 144 + 2*(4*uint64(t.Width)*uint64(t.Height)+(1<<20))
}
func displayWriteControl(w io.Writer, kind uint16, digest [32]byte, body []byte) error {
	h := make([]byte, 44+len(body))
	copy(h, "W8UC")
	binary.BigEndian.PutUint16(h[4:], 1)
	binary.BigEndian.PutUint16(h[6:], kind)
	binary.BigEndian.PutUint32(h[8:], uint32(len(body)))
	copy(h[12:], digest[:])
	copy(h[44:], body)
	n, e := w.Write(h)
	if e == nil && n != len(h) {
		e = io.ErrShortWrite
	}
	return e
}
func displayAck(w io.Writer, digest [32]byte, seq uint64) error {
	b := make([]byte, 16)
	binary.BigEndian.PutUint64(b, seq)
	binary.BigEndian.PutUint64(b[8:], seq+2)
	return displayWriteControl(w, 2, digest, b)
}

// ResolveDisplayTarget reads the same private state used by selectWindow in
// OpenSuperficies src/browserid/surface/{surface.go,io.go}. No CLI spawn is needed.
// stateDir is the native state directory the adapter passes to srf (MV_SRF_STATE_DIR);
// an empty value keeps the native default <RAM root>/identity-state.
func ResolveDisplayTarget(b capsule.Binding, stateDir string) (DisplayTarget, error) {
	var t DisplayTarget
	if b.NativeKind != "browser" || b.Window == "" {
		return t, errors.New("DISPLAY requires browser window")
	}
	if stateDir == "" {
		stateDir = filepath.Join(filepath.Dir(filepath.Dir(filepath.Dir(b.FramesRoot))), "identity-state")
	}
	path := filepath.Join(stateDir, b.Container+".json")
	dir, e := openRingDir(filepath.Dir(path))
	if e != nil {
		return t, e
	}
	defer dir.Close()
	fd, e := syscall.Openat(int(dir.Fd()), filepath.Base(path), syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if e != nil {
		return t, e
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	var st syscall.Stat_t
	if syscall.Fstat(fd, &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Uid != uint32(os.Geteuid()) || st.Mode&0777 != 0600 || st.Size > 1<<20 {
		return t, errors.New("unsafe DISPLAY identity state")
	}
	var s struct {
		Ready   bool
		Capsule struct {
			Container string `json:"container"`
			RunID     string `json:"run_id"`
		}
		XIDs map[string]string
	}
	data, e := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	if e != nil {
		return t, e
	}
	if json.Unmarshal(data, &s) != nil || !s.Ready || s.Capsule.Container != b.Container || s.Capsule.RunID != b.RunID {
		return t, errors.New("DISPLAY state mismatch")
	}
	xid, e := strconv.ParseUint(s.XIDs[b.Window], 10, 32)
	if e != nil {
		return t, e
	}
	t = DisplayTarget{b.Container, b.RunID, b.Window, uint32(xid), b.Surface.Geometry.W, b.Surface.Geometry.H}
	return t, validDisplayTarget(t)
}

func displayDecode(r io.Reader, control io.Writer, digest [32]byte, t DisplayTarget, publish func([]byte, uint64, DisplayTarget) error) error {
	var seq uint64
	hello := false
	for {
		h := make([]byte, 128)
		if _, e := io.ReadFull(r, h[:4]); e != nil {
			return e
		}
		magic := string(h[:4])
		if magic == "W8UH" || magic == "W8UE" {
			if _, e := io.ReadFull(r, h[4:44]); e != nil {
				return e
			}
			n := binary.BigEndian.Uint32(h[8:])
			kind := binary.BigEndian.Uint16(h[6:])
			if binary.BigEndian.Uint16(h[4:]) != 1 || !bytes.Equal(h[12:44], digest[:]) {
				return errors.New("DISPLAY control header")
			}
			if magic == "W8UE" {
				if kind != 4 || n != 20 {
					return errors.New("DISPLAY END length")
				}
				if _, e := io.ReadFull(r, h[:20]); e != nil {
					return e
				}
				return io.EOF
			}
			if hello || kind != 1 || n != 0 {
				return errors.New("DISPLAY HELLO")
			}
			hello = true
			continue
		}
		if magic != "W8UF" || !hello {
			return errors.New("DISPLAY framing")
		}
		if _, e := io.ReadFull(r, h[4:]); e != nil {
			return e
		}
		be := binary.BigEndian
		n := be.Uint64(h[8:])
		next := be.Uint64(h[16:])
		mono := be.Uint64(h[32:])
		if be.Uint16(h[4:]) != 1 || be.Uint16(h[6:]) != 128 || n < 144 || n > displayRecordCap(t) || be.Uint64(h[56:]) != n-128 || next != seq+1 || mono == 0 || be.Uint64(h[24:]) != 0 || be.Uint32(h[40:]) != uint32(t.Width) || be.Uint32(h[44:]) != uint32(t.Height) || be.Uint32(h[48:]) != uint32(3*t.Width) || be.Uint16(h[52:]) != 1 || be.Uint16(h[54:]) != 1 || !bytes.Equal(h[96:], digest[:]) {
			return errors.New("DISPLAY frame header")
		}
		payload := make([]byte, int(n)-128)
		if _, e := io.ReadFull(r, payload); e != nil {
			return e
		}
		a := be.Uint64(payload)
		if a > uint64(len(payload)-16) {
			return errors.New("DISPLAY leg A length")
		}
		rest := payload[8+int(a):]
		nb := be.Uint64(rest)
		if nb != uint64(len(rest)-8) {
			return errors.New("DISPLAY leg B length")
		}
		if _, _, _, e := displayXWDLayout(rest[8:], t); e != nil {
			return e
		}
		rgb, e := displayXWD(payload[8:8+int(a)], t)
		if e != nil {
			return e
		}
		// DISPLAY performs no per-frame hash; the sender already pair-validates.
		if e = publish(rgb, mono, t); e != nil {
			return e
		}
		seq = next
		if e = displayAck(control, digest, seq); e != nil {
			return e
		}
	}
}
func displayXWDLayout(b []byte, t DisplayTarget) (uint64, uint64, uint32, error) {
	if len(b) < 100 {
		return 0, 0, 0, errors.New("DISPLAY XWD short")
	}
	be := binary.BigEndian
	v := func(i int) uint32 { return be.Uint32(b[i*4:]) }
	off := uint64(v(0)) + 12*uint64(v(19))
	stride := uint64(v(12))
	if v(0) < 100 || v(0) > 65536 || v(19) > 65536 || v(1) != 7 || v(2) != 2 || v(3) != 24 || v(4) != uint32(t.Width) || v(5) != uint32(t.Height) || v(7) > 1 || v(11) != 32 || stride < uint64(t.Width)*4 || stride > 65536 || stride%4 != 0 || (v(13) != 4 && v(13) != 5) || v(14) != 0xff0000 || v(15) != 0xff00 || v(16) != 0xff || off+stride*uint64(t.Height) != uint64(len(b)) {
		return 0, 0, 0, errors.New("DISPLAY XWD geometry")
	}
	return off, stride, v(7), nil
}
func displayXWD(b []byte, t DisplayTarget) ([]byte, error) {
	off, stride, order, e := displayXWDLayout(b, t)
	if e != nil {
		return nil, e
	}
	rgb := make([]byte, t.Width*t.Height*3)
	for y := 0; y < t.Height; y++ {
		for x := 0; x < t.Width; x++ {
			i := int(off) + y*int(stride) + x*4
			o := (y*t.Width + x) * 3
			if order == 0 {
				rgb[o], rgb[o+1], rgb[o+2] = b[i+2], b[i+1], b[i]
			} else {
				rgb[o], rgb[o+1], rgb[o+2] = b[i+1], b[i+2], b[i+3]
			}
		}
	}
	return rgb, nil
}
func (d *DisplayTaps) diag(format string, args ...any) {
	if d.cfg.Diagnostics != nil {
		fmt.Fprintf(d.cfg.Diagnostics, format+"\n", args...)
	}
}

// tailBuffer keeps the last max bytes a sender wrote to stderr for diagnostics.
type tailBuffer struct {
	mu  sync.Mutex
	max int
	b   []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.b = append(t.b, p...)
	if len(t.b) > t.max {
		t.b = t.b[len(t.b)-t.max:]
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.TrimSpace(string(t.b))
}

// displayDecodeXWD reads concatenated XWD images (srf-fbread getimage output:
// big-endian header, header_size includes the window name, then ncolors*12
// colormap bytes, then bytes_per_line*height pixels, 32 bpp ZPixmap) and
// publishes each as RGB24. A malformed or mismatched image ends the session.
func displayDecodeXWD(r io.Reader, t DisplayTarget, publish func([]byte, uint64, DisplayTarget) error) error {
	be := binary.BigEndian
	rgb := make([]byte, t.Width*t.Height*3)
	var pix []byte
	for {
		h := make([]byte, 100)
		if _, e := io.ReadFull(r, h); e != nil {
			return e
		}
		size := int(be.Uint32(h[0:]))
		w, ht := int(be.Uint32(h[16:])), int(be.Uint32(h[20:]))
		order, bpp, bpl, ncolors := be.Uint32(h[28:]), be.Uint32(h[44:]), int(be.Uint32(h[48:])), int(be.Uint32(h[76:]))
		if size < 100 || size > 4096 || be.Uint32(h[4:]) != 7 || be.Uint32(h[8:]) != 2 || order > 1 || bpp != 32 || w != t.Width || ht != t.Height || bpl < 4*w || bpl > 4*w+64 || ncolors < 0 || ncolors > 256 {
			return errors.New("DISPLAY XWD header")
		}
		if _, e := io.CopyN(io.Discard, r, int64(size-100+ncolors*12)); e != nil {
			return e
		}
		if len(pix) != bpl*ht {
			pix = make([]byte, bpl*ht)
		}
		if _, e := io.ReadFull(r, pix); e != nil {
			return e
		}
		mono := uint64(time.Now().UnixNano())
		for y := 0; y < ht; y++ {
			src := pix[y*bpl:]
			dst := rgb[y*w*3:]
			for x := 0; x < w; x++ {
				if order == 0 { // LSBFirst: B G R X
					dst[x*3], dst[x*3+1], dst[x*3+2] = src[x*4+2], src[x*4+1], src[x*4]
				} else { // MSBFirst: X R G B
					dst[x*3], dst[x*3+1], dst[x*3+2] = src[x*4+1], src[x*4+2], src[x*4+3]
				}
			}
		}
		if e := publish(rgb, mono, t); e != nil {
			return e
		}
	}
}
