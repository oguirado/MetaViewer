package capsule

// [TARGET, unit decision] Host-xpra uses one unreaped Xvfb group anchor; xpra
// and its shell-free child inherit that group. All browser state lives in RAM.
import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type hostXpraLog struct {
	mu   sync.Mutex
	tail []byte
}

func (l *hostXpraLog) Write(data []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := len(data)
	if n >= 8192 {
		l.tail = append(l.tail[:0], data[n-8192:]...)
	} else {
		l.tail = append(l.tail, data...)
		if len(l.tail) > 8192 {
			l.tail = append(l.tail[:0], l.tail[len(l.tail)-8192:]...)
		}
	}
	return n, nil
}
func (l *hostXpraLog) String() string { l.mu.Lock(); defer l.mu.Unlock(); return string(l.tail) }

type hostXpraProcess struct {
	log                                   *hostXpraLog
	anchor, server                        *exec.Cmd
	start, root, view, display, authority string
	port                                  int
}

func processWitness(pid int) (string, int, string, error) {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "", 0, "", err
	}
	end := strings.LastIndexByte(string(raw), ')')
	if end < 0 {
		return "", 0, "", errors.New("invalid process witness")
	}
	f := strings.Fields(string(raw)[end+1:])
	if len(f) < 20 {
		return "", 0, "", errors.New("short process witness")
	}
	group, err := strconv.Atoi(f[2])
	return f[19], group, f[0], err
}
func liveProcessGroup(group int) bool {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return true
	}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		_, g, state, err := processWitness(pid)
		if err == nil && g == group && state != "Z" && state != "X" {
			return true
		}
	}
	return false
}
func (p *hostXpraProcess) stop() error {
	if p == nil || p.anchor == nil || p.anchor.Process == nil {
		return fault("host_program_unavailable", "recorded process group absent")
	}
	pid := p.anchor.Process.Pid
	start, group, _, err := processWitness(pid)
	// No asynchronous Wait: this unreaped child reserves the PID through killpg.
	if err != nil || start != p.start || group != pid {
		return fault("host_program_unavailable", "stale process witness: no signal sent")
	}
	if err = syscall.Kill(-pid, syscall.SIGTERM); err != nil && err != syscall.ESRCH {
		return err
	}
	deadline := time.Now().Add(2 * time.Second)
	for liveProcessGroup(pid) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if liveProcessGroup(pid) {
		if err = syscall.Kill(-pid, syscall.SIGKILL); err != nil && err != syscall.ESRCH {
			return err
		}
	}
	if p.server != nil {
		_ = p.server.Wait()
	}
	_ = p.anchor.Wait()
	deadline = time.Now().Add(time.Second)
	for liveProcessGroup(pid) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if liveProcessGroup(pid) {
		return fault("host_program_unavailable", "recorded group removal unverified")
	}
	if err := os.RemoveAll(p.view); err != nil {
		return err
	}
	return os.RemoveAll(p.root)
}

// xpra 3.1 uses shlex.split followed by Popen(shell=False), not a shell.
func xpraChild(path, root string) string {
	argv := []string{path}
	name := strings.ToLower(filepath.Base(path))
	if strings.Contains(name, "chromium") || strings.Contains(name, "chrome") {
		argv = append(argv, "--user-data-dir="+filepath.Join(root, "browser"), "--no-first-run", "--no-default-browser-check")
	} else if strings.Contains(name, "firefox") {
		argv = append(argv, "--no-remote", "--profile", filepath.Join(root, "browser"))
	}
	for i, arg := range argv {
		argv[i] = "'" + strings.ReplaceAll(arg, "'", "'\"'\"'") + "'"
	}
	return strings.Join(argv, " ")
}
func waitHostSocket(ctx context.Context, path string) error {
	for {
		c, err := net.DialTimeout("unix", path, 100*time.Millisecond)
		if err == nil {
			c.Close()
			return nil
		}
		select {
		case <-ctx.Done():
			return fault("host_program_unavailable", "private display/socket readiness timed out")
		case <-time.After(50 * time.Millisecond):
		}
	}
}
func startHostXpra(ctx context.Context, r *ProcessRunner, path, container, role string) (_ *hostXpraProcess, err error) {
	if err = r.validateStateDir(); err != nil {
		return nil, err
	}
	tools := map[string]string{}
	for _, name := range []string{"xpra", "Xvfb", "xauth"} {
		tools[name], err = ResolveHostBinary(name, r.SearchPath())
		if err != nil {
			return nil, fault("host_program_unavailable", "host_program_unavailable: "+name+" missing; install xpra xvfb xauth (apt install xpra xvfb xauth)")
		}
	}
	root, err := os.MkdirTemp("/dev/shm", "mv-host-xpra-")
	if err != nil {
		return nil, err
	}
	p := &hostXpraProcess{log: &hostXpraLog{}, root: root, view: filepath.Join(r.stateDir, "view", container), authority: filepath.Join(root, "Xauthority")}
	defer func() {
		if err != nil {
			if p.anchor != nil && p.start != "" {
				_ = p.stop()
			} else {
				_ = os.RemoveAll(root)
				_ = os.RemoveAll(p.view)
			}
		}
	}()
	for _, dir := range []string{filepath.Join(root, "browser"), filepath.Join(root, "config"), filepath.Join(root, "cache"), filepath.Join(root, "data"), filepath.Join(root, "runtime"), filepath.Join(r.stateDir, "view"), p.view, filepath.Join(p.view, "s")} {
		if err = os.MkdirAll(dir, 0700); err != nil {
			return nil, err
		}
	}
	var entropy [16]byte
	if _, err = rand.Read(entropy[:]); err != nil {
		return nil, err
	}
	// No fixed display pool; Xvfb's atomic X lock refuses any random collision.
	p.display = ":" + strconv.Itoa(10000+int(binary.BigEndian.Uint32(entropy[:4])%50000))
	env := []string{"PATH=" + r.SearchPath(), "HOME=" + root, "XDG_CONFIG_HOME=" + filepath.Join(root, "config"), "XDG_CACHE_HOME=" + filepath.Join(root, "cache"), "XDG_DATA_HOME=" + filepath.Join(root, "data"), "XDG_RUNTIME_DIR=" + filepath.Join(root, "runtime"), "XAUTHORITY=" + p.authority, "DISPLAY=" + p.display, "LANG=C.UTF-8", "GDK_BACKEND=x11", "QT_QPA_PLATFORM=xcb"}
	auth := exec.CommandContext(ctx, tools["xauth"], "-f", p.authority, "add", p.display, "MIT-MAGIC-COOKIE-1", hex.EncodeToString(entropy[:]))
	auth.Env = env
	if err = auth.Run(); err != nil {
		return nil, fault("host_program_unavailable", "private Xauthority creation failed")
	}
	p.anchor = exec.Command(tools["Xvfb"], p.display, "-screen", "0", "1280x900x24", "-nolisten", "tcp", "-noreset", "+extension", "Composite", "-auth", p.authority)
	p.anchor.Env = env
	p.anchor.Stderr = p.log
	p.anchor.WaitDelay = time.Second
	p.anchor.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err = p.anchor.Start(); err != nil {
		return nil, err
	}
	p.start, _, _, err = processWitness(p.anchor.Process.Pid)
	if err != nil {
		return nil, err
	}
	ready, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if err = waitHostSocket(ready, filepath.Join("/tmp/.X11-unix", "X"+strings.TrimPrefix(p.display, ":"))); err != nil {
		return nil, err
	}
	l, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		return nil, e
	}
	p.port = l.Addr().(*net.TCPAddr).Port
	l.Close()
	args := []string{"start-desktop", p.display, "--readonly=" + strconv.FormatBool(role == "agent"), "--use-display=yes", "--daemon=no", "--bind=" + filepath.Join(p.view, "s", "xpra.sock"), "--socket-dir=" + filepath.Join(root, "runtime"), "--socket-dirs=" + filepath.Join(root, "runtime"), "--socket-permissions=600", "--bind-tcp=127.0.0.1:" + strconv.Itoa(p.port), "--html=on", "--mdns=no", "--notifications=no", "--pulseaudio=no", "--printing=no", "--webcam=no", "--dbus-proxy=no", "--dbus-launch=", "--clipboard=no", "--start-new-commands=no", "--exit-with-client=no", "--exit-with-children=yes", "--start-child=" + xpraChild(path, root)}
	p.server = exec.Command(tools["xpra"], args...)
	p.server.Env = env
	p.server.Stdout = p.log
	p.server.Stderr = p.log
	p.server.WaitDelay = time.Second
	p.server.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pgid: p.anchor.Process.Pid}
	if err = p.server.Start(); err != nil {
		p.server = nil
		return nil, err
	}
	if err = waitHostSocket(ready, filepath.Join(p.view, "s", "xpra.sock")); err != nil {
		return nil, err
	}
	return p, nil
}
func (m *Manager) createHostXpra(ctx context.Context, profile, id, version string, p Profile, path string, geom Geometry) ([]json.RawMessage, error) {
	r, ok := m.runner.(*ProcessRunner)
	if !ok {
		return nil, fault("configuration", "host-xpra requires process runner")
	}
	container := "srf-pg-hx-" + profile
	process, err := startHostXpra(ctx, r, path, container, p.Role)
	if err != nil {
		return nil, err
	}
	success := false
	defer func() {
		if !success {
			_ = process.stop()
		}
	}()
	var spec *HostWindowSpec
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) && ctx.Err() == nil {
		out, e := m.executeRawHostWindow(ctx, p, append([]string{"list"}, HostWindowSessionArgs(process.display, process.authority)...), nil)
		if e == nil {
			var reply struct {
				Windows []struct {
					XID     uint32 `json:"xid"`
					Witness string `json:"witness"`
					Title   string `json:"title"`
					PID     int    `json:"pid"`
				} `json:"windows"`
			}
			if json.Unmarshal(out, &reply) == nil {
				for _, w := range reply.Windows {
					_, group, state, witnessErr := processWitness(w.PID)
					if witnessErr == nil && group == process.anchor.Process.Pid && state != "Z" && w.XID != 0 && validHostWitness(w.Witness) {
						spec = &HostWindowSpec{XID: w.XID, Witness: w.Witness, Title: w.Title, Program: filepath.Base(path), Display: process.display, Xauthority: process.authority}
						break
					}
				}
			}
		}
		if spec != nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if spec == nil {
		return nil, fault("host_program_unavailable", "host_program_unavailable: program did not publish an X11 window on its private display")
	}
	p.Display = process.display
	m.cfg.Profiles[profile] = p
	if _, err = m.attachHostWindow(profile, id, version, p, spec, geom); err != nil {
		return nil, err
	}
	b := m.bindings[id]
	b.NativeKind = "host-xpra"
	b.Program = path
	b.Container = container
	b.Role = p.Role
	b.HostXpra = process
	if p.Role == "human" {
		b.Surface.Control = "human"
	}
	m.bindings[id] = b
	if err = m.publishHumanBinding(b); err != nil {
		delete(m.bindings, id)
		return nil, err
	}
	success = true
	return []json.RawMessage{surfaceEvent(version, "created", b.Surface)}, nil
}
