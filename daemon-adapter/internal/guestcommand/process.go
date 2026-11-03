package guestcommand

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type process interface {
	Send(context.Context, []byte) error
	Read(context.Context) ([]byte, error)
	Close(context.Context) error
}
type factory func(context.Context, *Profile, string, string) (process, error)
type lineResult struct {
	b   []byte
	err error
}
type processHandle interface {
	WithHandle(func(uintptr)) error
	Signal(os.Signal) error
	Release() error
}
type serviceIdentity struct {
	Invocation, Group, Start string
	PID                      int
	Device, Inode            uint64
}
type serviceProcess struct {
	inventory       serviceInventory
	inventoryClosed bool
	closeMu         sync.Mutex
	cmd             *exec.Cmd
	input           io.WriteCloser
	lines           chan lineResult
	exited          chan struct{}
	waitErr         error
	unit, cgroup    string
	stopRead        chan struct{}
	stopOnce        sync.Once
	identity        serviceIdentity
	main            processHandle
	inspect         func(context.Context, string) (map[string]string, error)
	observe         func(map[string]string) (serviceIdentity, error)
}

func control(ctx context.Context, args ...string) ([]byte, error) {
	c := exec.CommandContext(ctx, "/usr/bin/systemctl", append([]string{"--user"}, args...)...)
	c.Env = []string{fmt.Sprintf("XDG_RUNTIME_DIR=/run/user/%d", os.Getuid()), fmt.Sprintf("DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/%d/bus", os.Getuid()), "PATH=/usr/bin:/bin"}
	return c.Output()
}
func properties(ctx context.Context, unit string) (map[string]string, error) {
	b, e := control(ctx, "show", unit, "--property=LoadState,ActiveState,ControlGroup,InvocationID,MainPID")
	m := map[string]string{}
	for _, line := range strings.Split(string(b), "\n") {
		k, v, ok := strings.Cut(line, "=")
		if ok {
			m[k] = v
		}
	}
	if m["LoadState"] == "" || m["ActiveState"] == "" {
		return nil, errors.New("missing service witness")
	}
	if e != nil && !(m["LoadState"] == "not-found" && m["ActiveState"] == "inactive" && m["ControlGroup"] == "") {
		return nil, e
	}
	return m, nil
}
func observeIdentity(m map[string]string) (serviceIdentity, error) {
	var id serviceIdentity
	if m["ActiveState"] != "active" || !regexpInvocation.MatchString(m["InvocationID"]) {
		return id, errors.New("active invocation required")
	}
	pid, e := strconv.Atoi(m["MainPID"])
	if e != nil || pid <= 0 {
		return id, errors.New("main PID required")
	}
	group := m["ControlGroup"]
	if !strings.HasPrefix(group, "/") || group == "/" || filepath.Clean(group) != group {
		return id, errors.New("canonical cgroup required")
	}
	cg := "/sys/fs/cgroup" + group
	st, e := os.Lstat(cg)
	if e != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return id, errors.New("cgroup identity absent")
	}
	statBytes, e := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if e != nil {
		return id, e
	}
	end := strings.LastIndex(string(statBytes), ")")
	if end < 0 {
		return id, errors.New("process stat malformed")
	}
	fields := strings.Fields(string(statBytes)[end+1:])
	if len(fields) <= 19 {
		return id, errors.New("process start absent")
	}
	membership, e := os.ReadFile(fmt.Sprintf("/proc/%d/cgroup", pid))
	if e != nil || strings.TrimSpace(string(membership)) != "0::"+group {
		return id, errors.New("main cgroup mismatch")
	}
	s := st.Sys().(*syscall.Stat_t)
	return serviceIdentity{m["InvocationID"], group, fields[19], pid, uint64(s.Dev), s.Ino}, nil
}

var regexpInvocation = regexp.MustCompile(`^[0-9a-f]{32}$`)

func verifyGuardian(ctx context.Context, p *Profile) error {
	m, e := properties(ctx, p.GuardianUnit)
	if e != nil {
		return e
	}
	g := m["ControlGroup"]
	if m["ActiveState"] != "active" || g == "" || g == "/" {
		return errors.New("guardian inactive")
	}
	b, e := os.ReadFile("/proc/self/cgroup")
	if e != nil {
		return e
	}
	current := strings.TrimSpace(strings.TrimPrefix(string(b), "0::"))
	if current != g && !strings.HasPrefix(current, g+"/") {
		return errors.New("daemon outside guardian")
	}
	return nil
}
func serviceArgs(p *Profile, attempt, unit string) []string {
	return []string{"--user", "--quiet", "--pipe", "--wait", "--collect", "--service-type=exec", "--unit=" + unit, "--slice=newton-ia.slice",
		"--property=MemoryMax=512M", "--property=MemorySwapMax=0", "--property=CPUQuota=100%", "--property=TasksMax=64",
		"--property=RuntimeMaxSec=180", "--property=TimeoutStopSec=5", "--property=KillMode=control-group", "--property=Restart=no",
		"--property=BindsTo=" + p.GuardianUnit, "--property=After=" + p.GuardianUnit,
		"/usr/bin/env", "-i", "PATH=/usr/bin:/bin", filepath.Join(attempt, "python"), "-I", "-B", filepath.Join(attempt, "runner.py"), attempt}
}
func startService(ctx context.Context, p *Profile, attempt, unit string) (process, error) {
	if e := verifyGuardian(ctx, p); e != nil {
		return nil, e
	}
	if _, e := pinnedExecutable(Pin{filepath.Join(attempt, "python"), p.Python.SHA256}); e != nil {
		return nil, e
	}
	if _, e := pinnedExecutable(p.Python); e != nil {
		return nil, e
	}
	for _, path := range []string{p.Python.Path, filepath.Join(attempt, "python")} {
		if e := probeInterpreter(ctx, path, p.PythonPrefix); e != nil {
			return nil, e
		}
	}
	if _, e := pinnedExecutable(p.Python); e != nil {
		return nil, e
	}
	cmd := exec.Command("/usr/bin/systemd-run", serviceArgs(p, attempt, unit)...)
	cmd.Env = []string{fmt.Sprintf("XDG_RUNTIME_DIR=/run/user/%d", os.Getuid()), fmt.Sprintf("DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/%d/bus", os.Getuid()), "PATH=/usr/bin:/bin"}
	in, e := cmd.StdinPipe()
	if e != nil {
		return nil, e
	}
	out, e := cmd.StdoutPipe()
	if e != nil {
		in.Close()
		return nil, e
	}
	// Controller stderr is not part of the event stream.
	inventory, _ := ctx.Value(inventoryContextKey{}).(serviceInventory)
	s := &serviceProcess{inventory: inventory, cmd: cmd, input: in, lines: make(chan lineResult, 8), exited: make(chan struct{}), unit: unit, stopRead: make(chan struct{}), inspect: properties, observe: observeIdentity}
	if e = cmd.Start(); e != nil {
		in.Close()
		out.Close()
		return nil, e
	}
	go func() { s.waitErr = cmd.Wait(); close(s.exited) }()
	go func() {
		defer close(s.lines)
		scan := bufio.NewScanner(out)
		scan.Buffer(make([]byte, 4096), 262144)
		for scan.Scan() {
			b := append([]byte(nil), scan.Bytes()...)
			select {
			case s.lines <- lineResult{b: b}:
			case <-s.stopRead:
				return
			}
		}
		if e := scan.Err(); e != nil {
			select {
			case s.lines <- lineResult{err: e}:
			case <-s.stopRead:
				return
			}
		}
	}()
	readyCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	raw, e := s.Read(readyCtx)
	if e != nil {
		return s, e
	}
	var ready struct {
		Ready  bool   `json:"guest_command_ready"`
		Cgroup string `json:"cgroup"`
	}
	if json.Unmarshal(raw, &ready) != nil || !ready.Ready || !strings.HasPrefix(ready.Cgroup, "/sys/fs/cgroup/") || !strings.HasSuffix(ready.Cgroup, "/"+unit) {
		return s, errors.New("service readiness witness")
	}
	m, e := properties(readyCtx, unit)
	if e != nil || m["ActiveState"] != "active" || "/sys/fs/cgroup"+m["ControlGroup"] != ready.Cgroup {
		return s, errors.New("service cgroup mismatch")
	}
	s.cgroup = ready.Cgroup
	id, e := observeIdentity(m)
	if e != nil {
		return s, e
	}
	main, e := os.FindProcess(id.PID)
	if e != nil {
		return s, e
	}
	if e = main.WithHandle(func(uintptr) {}); e != nil {
		main.Release()
		return s, errors.New("stable pidfd unavailable")
	}
	s.main = main
	s.identity = id
	latest, e := properties(readyCtx, unit)
	if e != nil {
		return s, e
	}
	again, e := observeIdentity(latest)
	if e != nil || again != id {
		return s, errors.New("service changed during pidfd acquisition")
	}
	if e = writeNew(filepath.Join(attempt, "service.json"), map[string]any{"unit": unit, "identity": id, "controller_ready": true}); e != nil {
		return s, e
	}
	if inventory != nil {
		if e = inventory.ServiceBound(unit, unit, id.Invocation, id.Group, id.Device, id.Inode, id.PID, id.Start); e != nil {
			return s, e
		}
	}
	return s, nil
}

const interpreterProbe = "import json,pathlib,socket,select,ctypes,hashlib,threading,sys; print(json.dumps({'prefix':sys.prefix,'base_prefix':sys.base_prefix}))"

type boundedProbeOutput struct{ bytes.Buffer }

func (b *boundedProbeOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 4096 {
		return 0, errors.New("interpreter probe output bound")
	}
	return b.Buffer.Write(p)
}
func probeInterpreter(ctx context.Context, path, prefix string) error {
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(probeCtx, path, "-I", "-B", "-c", interpreterProbe)
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	cmd.Stderr = io.Discard
	var out boundedProbeOutput
	cmd.Stdout = &out
	if e := cmd.Run(); e != nil {
		return errors.New("interpreter import probe failed")
	}
	return checkInterpreterProbe(out.Bytes(), prefix)
}
func checkInterpreterProbe(raw []byte, prefix string) error {
	var result struct {
		Prefix string `json:"prefix"`
		Base   string `json:"base_prefix"`
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&result) != nil || d.Decode(new(any)) != io.EOF || result.Prefix != prefix || result.Base != prefix {
		return errors.New("interpreter prefix mismatch")
	}
	return nil
}
func (s *serviceProcess) emergencySignal(ctx context.Context) error {
	if s.main == nil || s.identity.Invocation == "" {
		return errors.New("service ownership unobserved")
	}
	m, e := s.inspect(ctx, s.unit)
	if e != nil {
		return e
	}
	now, e := s.observe(m)
	if e != nil || now != s.identity {
		return errors.New("service replaced or unknown; no signal")
	}
	if e = s.main.WithHandle(func(uintptr) {}); e != nil {
		return errors.New("stable pidfd unavailable")
	}
	// Process was admitted only with a retained Linux handle. Signal uses that
	// handle (never the reusable unit name or numeric PID).
	return s.main.Signal(syscall.SIGTERM)
}
func (s *serviceProcess) Send(ctx context.Context, b []byte) error {
	if len(b) >= 262144 {
		return errors.New("request line bound")
	}
	done := make(chan error, 1)
	go func() {
		n, e := s.input.Write(append(append([]byte(nil), b...), '\n'))
		if e == nil && n != len(b)+1 {
			e = io.ErrShortWrite
		}
		done <- e
	}()
	select {
	case e := <-done:
		return e
	case <-ctx.Done():
		_ = s.input.Close()
		return ctx.Err()
	}
}
func (s *serviceProcess) Read(ctx context.Context) ([]byte, error) {
	select {
	case r, ok := <-s.lines:
		if !ok {
			return nil, io.EOF
		}
		return r.b, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func (s *serviceProcess) Close(ctx context.Context) (err error) {
	s.closeMu.Lock()
	defer s.closeMu.Unlock()
	if s.inventory != nil && !s.inventoryClosed {
		defer func() {
			if err == nil {
				err = s.inventory.ServiceClosed(s.unit)
				if err == nil {
					s.inventoryClosed = true
				}
			} else {
				_ = s.inventory.Unknown(s.unit)
			}
		}()
	}
	defer s.stopOnce.Do(func() { close(s.stopRead) })
	_ = s.input.Close()
	select {
	case <-s.exited:
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(2 * time.Second):
		if e := s.emergencySignal(ctx); e != nil {
			return e
		}
		select {
		case <-s.exited:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if s.waitErr != nil {
		return fmt.Errorf("controller service exit: %w", s.waitErr)
	}
	if s.main == nil || s.identity.Invocation == "" {
		return errors.New("service ownership unobserved")
	}
	m, e := s.inspect(ctx, s.unit)
	if e != nil {
		return e
	}
	if m["ActiveState"] != "inactive" && m["ActiveState"] != "failed" {
		return errors.New("service still active")
	}
	if m["LoadState"] != "not-found" && m["InvocationID"] != s.identity.Invocation {
		return errors.New("replacement service; closure unknown")
	}
	if m["ControlGroup"] != "" && m["ControlGroup"] != s.identity.Group {
		return errors.New("replacement cgroup; closure unknown")
	}
	if s.cgroup == "" {
		return errors.New("unobserved service cgroup")
	}
	if e = s.main.WithHandle(func(uintptr) {}); e != nil {
		return errors.New("lost closure handle")
	}
	if e = s.main.Signal(syscall.Signal(0)); !errors.Is(e, os.ErrProcessDone) {
		return errors.New("owned main process closure unproved")
	}
	st, e := os.Lstat(s.cgroup)
	if os.IsNotExist(e) {
		_ = s.main.Release()
		return nil
	}
	if e != nil {
		return e
	}
	sg := st.Sys().(*syscall.Stat_t)
	if uint64(sg.Dev) != s.identity.Device || sg.Ino != s.identity.Inode || !st.IsDir() {
		return errors.New("cgroup replaced; closure unknown")
	}
	b, e := os.ReadFile(filepath.Join(s.cgroup, "cgroup.events"))
	if e != nil {
		return e
	}
	if !strings.Contains(string(b), "populated 0\n") {
		return errors.New("service cgroup populated")
	}
	_ = s.main.Release()
	return nil
}
