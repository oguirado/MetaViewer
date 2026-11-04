package resourceinventory

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type Mount struct {
	Source      string `json:"source"`
	Destination string `json:"destination"`
}
type NativeSnapshot struct {
	CID     string  `json:"id"`
	Name    string  `json:"name"`
	Image   string  `json:"image"`
	PID     uint64  `json:"pid"`
	Running bool    `json:"running"`
	Memory  uint64  `json:"memory"`
	Swap    uint64  `json:"swap"`
	Mounts  []Mount `json:"mounts"`
}
type NativePID struct {
	PID   uint64 `json:"pid"`
	Start uint64 `json:"start"`
}
type nativeObserver interface {
	Inspect(context.Context, string) (NativeSnapshot, error)
	Absent(context.Context, string) (bool, error)
	PID(uint64) (*NativePID, error)
}
type dockerObserver struct{}

const inspectTemplate = `{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"pid":{{.State.Pid}},"running":{{.State.Running}},"memory":{{.HostConfig.Memory}},"swap":{{.HostConfig.MemorySwap}},"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}{"source":{{json $m.Source}},"destination":{{json $m.Destination}}}{{end}}]}`

type boundedBuffer struct{ bytes.Buffer }

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 1<<20 {
		return 0, fail("Docker metadata bound")
	}
	return b.Buffer.Write(p)
}
func dockerMetadata(ctx context.Context, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/docker", append([]string{"--host", "unix:///var/run/docker.sock"}, args...)...)
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	var out boundedBuffer
	cmd.Stdout = &out
	cmd.Stderr = &boundedBuffer{}
	if e := cmd.Run(); e != nil {
		return nil, fail("Docker metadata unavailable")
	}
	return out.Bytes(), nil
}
func (dockerObserver) Inspect(ctx context.Context, name string) (NativeSnapshot, error) {
	var s NativeSnapshot
	b, e := dockerMetadata(ctx, "container", "inspect", "--format", inspectTemplate, name)
	if e != nil {
		return s, e
	}
	e = decode(bytes.TrimSpace(b), &s)
	return s, e
}
func (dockerObserver) Absent(ctx context.Context, cid string) (bool, error) {
	if !hexLen(cid, 64) {
		return false, fail("CID format")
	}
	b, e := dockerMetadata(ctx, "container", "ls", "--all", "--no-trunc", "--filter", "id="+cid, "--format", "{{.ID}}")
	if e != nil {
		return false, e
	}
	s := strings.TrimSpace(string(b))
	if s == "" {
		return true, nil
	}
	if s != cid {
		return false, fail("unexpected container inventory")
	}
	return false, nil
}
func (dockerObserver) PID(pid uint64) (*NativePID, error) { return readPID(pid) }
func readPID(pid uint64) (*NativePID, error) {
	if pid == 0 || pid > maxSafe {
		return nil, fail("PID bound")
	}
	b, e := os.ReadFile(filepath.Join("/proc", strconv.FormatUint(pid, 10), "stat"))
	if os.IsNotExist(e) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	s := string(b)
	at := strings.LastIndex(s, ") ")
	if at < 0 || !strings.HasPrefix(s, strconv.FormatUint(pid, 10)+" (") {
		return nil, fail("malformed proc stat")
	}
	f := strings.Fields(s[at+2:])
	if len(f) < 20 || !strings.Contains("RSDZTtXxKWPI", f[0]) {
		return nil, fail("malformed proc state")
	}
	start, e := strconv.ParseUint(f[19], 10, 64)
	if e != nil || start == 0 || start > maxSafe {
		return nil, fail("malformed process start")
	}
	return &NativePID{pid, start}, nil
}

type Graphical struct {
	producer    *Producer
	observer    nativeObserver
	payloadStat func(string) (os.FileInfo, error)
}

func NewGraphicalFromEnv() (*Graphical, error) {
	p, e := OpenFromEnv("graphical")
	if e != nil || p == nil {
		return nil, e
	}
	return &Graphical{producer: p, observer: dockerObserver{}}, nil
}
func (g *Graphical) statPayload(path string) (os.FileInfo, error) {
	if g.payloadStat != nil {
		return g.payloadStat(path)
	}
	return os.Stat(path)
}
func (g *Graphical) Pending(id, profile, kind, container string) error {
	c := g.producer.cfg
	expected := profile
	prefix := map[string]string{"vm": "srf-vm-", "browser": "srf-id-", "program": "srf-pg-"}[kind]
	if id == "" || !c.allowsProfile(kind, profile) || prefix == "" || container != prefix+expected || c.Images[kind] == "" {
		return fail("unconfigured native allocation")
	}
	payload := filepath.Join(c.Root, "store", "profiles", profile)
	if e := canonical(payload); e != nil {
		return e
	}
	s, e := g.statPayload(payload)
	if e != nil {
		return e
	}
	st, ok := s.Sys().(*syscall.Stat_t)
	if !ok || !s.IsDir() || st.Uid != 10001 || st.Gid != 10001 || s.Mode().Perm() != 0700 {
		return fail("payload inode custody")
	}
	return g.producer.Append("native_pending", id, map[string]any{"generation": id, "profile_id": profile, "native_kind": kind, "container_name": container, "image_id": c.Images[kind], "payload": payload, "payload_device": st.Dev, "payload_inode": st.Ino})
}
func (p *Producer) history() (History, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || p.poisoned {
		return History{}, fail("producer fenced")
	}
	if e := lockBounded(p.lock); e != nil {
		return History{}, e
	}
	defer syscall.Flock(int(p.lock.Fd()), syscall.LOCK_UN)
	if e := p.checkRoot(); e != nil {
		return History{}, e
	}
	if _, e := p.journal.Seek(0, 0); e != nil {
		return History{}, e
	}
	raw, e := io.ReadAll(io.LimitReader(p.journal, maxJournal+1))
	if e != nil {
		return History{}, e
	}
	return parseHistory(p.cfg, raw, p.rootStat)
}
func (g *Graphical) Bound(ctx context.Context, id, container, run string) error {
	err := g.bind(ctx, id, container, run)
	if err != nil {
		_ = g.producer.Unknown(id)
	}
	return err
}
func (g *Graphical) bind(ctx context.Context, id, container, run string) error {
	h, e := g.producer.history()
	if e != nil {
		return e
	}
	r := h.Resources["graphical:"+id]
	if r == nil {
		return fail("unreserved native binding")
	}
	pending := object(r["pending"])
	if text(pending, "container_name") != container || run != container {
		return fail("returned native tuple")
	}
	statePath := filepath.Join(g.producer.cfg.Root, "native-state", container+".json")
	raw, e := readProtected(statePath, 65536, true)
	if e != nil {
		return e
	}
	var state map[string]any
	if e = decode(raw, &state); e != nil {
		return e
	}
	capsule, lease := object(state["Capsule"]), object(state["Lease"])
	kind := text(pending, "native_kind")
	if text(state, "kind") != kind || text(capsule, "kind") != kind || text(capsule, "container") != container || text(capsule, "run_id") != run || text(lease, "ProfileID") != text(pending, "profile_id") || text(lease, "Holder") != container {
		return fail("native state corroboration")
	}
	inspect, e := g.observer.Inspect(ctx, container)
	if e != nil {
		return e
	}
	if !hexLen(inspect.CID, 64) || inspect.Name != "/"+container || inspect.Image != text(pending, "image_id") || !inspect.Running || inspect.PID == 0 || inspect.Memory == 0 || inspect.Memory > 8<<30 || inspect.Swap != inspect.Memory {
		return fail("native Docker identity or limits")
	}
	if kind == "vm" && inspect.Memory != 8<<30 {
		return fail("VM memory limits")
	}
	payload := text(pending, "payload")
	mounted := false
	for _, m := range inspect.Mounts {
		if m.Destination == "/profile" {
			if m.Source != payload || mounted {
				return fail("native payload mount")
			}
			mounted = true
		}
	}
	if !mounted {
		return fail("native payload absent")
	}
	s, e := g.statPayload(payload)
	if e != nil {
		return e
	}
	st := s.Sys().(*syscall.Stat_t)
	dev, _ := number(pending["payload_device"])
	ino, _ := number(pending["payload_inode"])
	if st.Dev != dev || st.Ino != ino || st.Uid != 10001 || st.Gid != 10001 || s.Mode().Perm() != 0700 {
		return fail("payload changed")
	}
	pid, e := g.observer.PID(inspect.PID)
	if e != nil || pid == nil || pid.PID != inspect.PID || pid.Start == 0 {
		return fail("native process unobserved")
	}
	again, e := g.observer.Inspect(ctx, container)
	if e != nil || !same(inspect, again) {
		return fail("native container changed")
	}
	now, e := g.observer.PID(pid.PID)
	if e != nil || now == nil || *now != *pid {
		return fail("native process changed")
	}
	raw2, e := readProtected(statePath, 65536, true)
	if e != nil || hash(raw) != hash(raw2) {
		return fail("native state changed")
	}
	return g.producer.Append("native_bound", id, map[string]any{"container_name": container, "run_id": run, "cid": inspect.CID, "native_pid": pid, "native_state_path": statePath, "native_state_sha256": hash(raw)})
}
func (g *Graphical) Closed(ctx context.Context, id string) error {
	h, e := g.producer.history()
	if e != nil {
		return e
	}
	r := h.Resources["graphical:"+id]
	if r == nil || r["bound"] == nil {
		return fail("native closure lacks bound identity")
	}
	b := object(r["bound"])
	absent, e := g.observer.Absent(ctx, text(b, "cid"))
	if e != nil || !absent {
		_ = g.producer.Unknown(id)
		return fail("native CID closure unknown")
	}
	recorded := object(b["native_pid"])
	pid, _ := number(recorded["pid"])
	start, _ := number(recorded["start"])
	current, e := g.observer.PID(pid)
	if e != nil || current != nil && current.Start == start {
		_ = g.producer.Unknown(id)
		return fail("native PID closure unknown")
	}
	if _, e = os.Lstat(text(b, "native_state_path")); !os.IsNotExist(e) {
		_ = g.producer.Unknown(id)
		return fail("native state closure unknown")
	}
	return g.producer.Append("native_closed", id, nil)
}
func (g *Graphical) Unknown(id string) error { return g.producer.Unknown(id) }
func (g *Graphical) Seal() error {
	if g == nil {
		return nil
	}
	return g.producer.Seal()
}
func (p *Producer) Actor() string { return p.cfg.Actor }
func (p *Producer) ServicePending(id, unit string) error {
	return p.Append("service_pending", id, map[string]any{"unit": unit})
}
func (p *Producer) ServiceBound(id, unit, invocation, group string, device, inode uint64, pid int, start string) error {
	n, e := strconv.ParseUint(start, 10, 64)
	if e != nil {
		return e
	}
	return p.Append("service_bound", id, map[string]any{"unit": unit, "invocation": invocation, "cgroup": group, "device": device, "inode": inode, "pid": pid, "start_ticks": n})
}
func (p *Producer) ServiceClosed(id string) error { return p.Append("service_closed", id, nil) }
