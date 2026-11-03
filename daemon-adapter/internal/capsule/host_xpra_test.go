package capsule

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestHostXpraStopWitnessAndGroupIsolation(t *testing.T) {
	sleep, err := exec.LookPath("sleep")
	if err != nil {
		t.Fatal(err)
	}
	peer := exec.Command(sleep, "30")
	peer.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err = peer.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = peer.Process.Kill(); _ = peer.Wait() }()
	pidFile := filepath.Join(t.TempDir(), "child")
	child := exec.Command(os.Args[0], "-test.run=^TestHostXpraGroupChild$")
	child.Env = append(os.Environ(), "MV_HOST_XPRA_GROUP_CHILD="+pidFile)
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		if _, e := os.Stat(pidFile); e == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("child not ready")
		}
		time.Sleep(10 * time.Millisecond)
	}
	start, _, _, err := processWitness(child.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	p := &hostXpraProcess{anchor: child, start: start + "-stale", root: t.TempDir(), view: t.TempDir()}
	if err = p.stop(); err == nil {
		t.Fatal("stale witness was accepted")
	}
	if err = child.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatal("stale witness killed live process")
	}
	p.start = start
	if err = p.stop(); err != nil {
		t.Fatal(err)
	}
	if liveProcessGroup(child.Process.Pid) {
		t.Fatal("owned process group survived")
	}
	if err = peer.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatal("unrelated process killed", err)
	}
	if err = p.stop(); err == nil {
		t.Fatal("already reaped PID accepted")
	}
}

func TestHostXpraBrowserArgumentsUseOnlyFreshProfile(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Música", "fresh profile")
	for _, binary := range []string{"/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/firefox"} {
		args := xpraChild(binary, root)
		if !strings.Contains(args, filepath.Join(root, "browser")) || strings.Contains(args, os.Getenv("HOME")+"/.config") {
			t.Fatal(args)
		}
		if strings.Contains(args, "sh -c") {
			t.Fatal("shell launch", args)
		}
	}
}

func TestHostXpraMissingDependencyRefusesBeforeSpawn(t *testing.T) {
	state := t.TempDir()
	if err := os.Chmod(state, 0700); err != nil {
		t.Fatal(err)
	}
	r, err := NewProcessRunner(t.TempDir(), []string{"PATH=" + t.TempDir(), "MV_SRF_STATE_DIR=" + state}, 4096, 1e9)
	if err != nil {
		t.Fatal(err)
	}
	p, err := startHostXpra(context.Background(), r, "/absent/app", "srf-pg-hx-test", "human")
	if err == nil || p != nil || !strings.Contains(err.Error(), "install xpra xvfb xauth") {
		t.Fatalf("%v %v", p, err)
	}
}

// These fixtures were captured from real tools on a private Xvfb display.
func TestHostXpraReplaysRealCaptureAndInput(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "host-xpra", "list.json"))
	if err != nil {
		t.Fatal(err)
	}
	var listed struct {
		Windows []struct {
			XID     uint32 `json:"xid"`
			Witness string `json:"witness"`
			PID     int    `json:"pid"`
		} `json:"windows"`
	}
	if err = json.Unmarshal(raw, &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Windows) == 0 || listed.Windows[0].PID == 0 {
		t.Fatal("real window fixture missing")
	}
	xwd, err := os.ReadFile(filepath.Join("testdata", "host-xpra", "capture.xwd"))
	if err != nil {
		t.Fatal(err)
	}
	input, err := os.ReadFile(filepath.Join("testdata", "host-xpra", "input.json"))
	if err != nil {
		t.Fatal(err)
	}
	rgb, w, h, err := DecodeHostWindowXWD(xwd)
	if err != nil || len(rgb) != w*h*3 {
		t.Fatal("invalid real capture", err)
	}
	ram, err := os.MkdirTemp("/dev/shm", "hx-replay-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(ram)
	runner := &hostWindowFakeRunner{captureOut: xwd, inputOut: input}
	m, err := NewManager(Config{BinDir: t.TempDir(), MaxSurfaces: 16, MaxOutputBytes: 4096, Timeout: time.Second, OriginNS: 100, Profiles: map[string]Profile{"demo": {Kind: "browser", NativeKind: "browser", Width: 2, Height: 1, Display: ":100", RAMRoot: ram}}}, runner, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	p := Profile{Kind: "desktop_capsule", NativeKind: "host-xpra", RAMRoot: ram, Width: w, Height: h, Display: ":12345"}
	m.cfg.Profiles["hx-replay"] = p
	spec := &HostWindowSpec{XID: listed.Windows[0].XID, Witness: listed.Windows[0].Witness, Display: p.Display}
	if _, err = m.attachHostWindow("hx-replay", "surface-replay", "v0.2", p, spec, Geometry{W: w, H: h}); err != nil {
		t.Fatal(err)
	}
	b := m.bindings["surface-replay"]
	b.NativeKind = "host-xpra"
	m.bindings["surface-replay"] = b
	_, frame, err := m.Capture(context.Background(), b.Surface.SurfaceID)
	if err != nil || frame.Width != w || frame.Height != h {
		t.Fatal("capture replay", err)
	}
	params := json.RawMessage(`{"surface_id":"surface-replay","proposal_id":"replay-input","action":{"type":"key","keys":["Return"]}}`)
	if _, err = m.Handle(context.Background(), Request{Schema: "surface_request/v0.2", Op: "input", Params: params}); err != nil {
		t.Fatal("input replay", err)
	}
	for _, argv := range runner.calls {
		joined := strings.Join(argv, " ")
		if !strings.Contains(joined, "--display :12345") || strings.Contains(joined, "--display :0") {
			t.Fatal("private display lost", argv)
		}
	}
	// Negative control: a corrupt real frame must fail its decoder.
	mutant := append([]byte(nil), xwd...)
	mutant[4] = 255
	if _, _, _, err = DecodeHostWindowXWD(mutant); err == nil {
		t.Fatal("corrupt real capture accepted")
	}
}

func TestHostXpraGroupChild(t *testing.T) {
	path := os.Getenv("MV_HOST_XPRA_GROUP_CHILD")
	if path == "" {
		return
	}
	sleep, err := exec.LookPath("sleep")
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(sleep, "30")
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, []byte("ready"), 0600); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
}

func TestV027XdotoolRecoveryNamesMissingPackage(t *testing.T) {
	state, bin := t.TempDir(), t.TempDir()
	if err := os.Chmod(state, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"xpra", "Xvfb", "xauth"} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	r, err := NewProcessRunner(bin, []string{"PATH=" + bin, "MV_SRF_STATE_DIR=" + state}, 4096, 1e9)
	if err != nil {
		t.Fatal(err)
	}
	_, err = startHostXpra(context.Background(), r, "/absent/app", "srf-pg-hx-test", "human")
	if err == nil || !strings.Contains(err.Error(), "apt install xpra xvfb xauth xdotool") {
		t.Fatalf("missing actionable package: %v", err)
	}
}

func TestV027HostProgramExitDuringWindowDiscovery(t *testing.T) {
	for _, scenario := range []string{"exited", "slow-live", "probe-error"} {
		t.Run(scenario, func(t *testing.T) {
			exited := scenario == "exited"
			var children []*exec.Cmd
			probes := 0
			bin := t.TempDir()
			if err := os.WriteFile(filepath.Join(bin, "srf-host-window"), []byte("#!/bin/sh\nprintf '{\"windows\":[]}'\n"), 0700); err != nil {
				t.Fatal(err)
			}
			runner, err := NewProcessRunner(bin, []string{"PATH=" + os.Getenv("PATH")}, 4096, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			sleep, err := exec.LookPath("sleep")
			if err != nil {
				t.Fatal(err)
			}
			m := testManager(t, &scriptRunner{})
			m.runner = runner
			m.cfg.BinDir = bin
			m.hostXpraStart = func(context.Context, *ProcessRunner, string, string, string) (*hostXpraProcess, error) {
				anchor := exec.Command(sleep, "30")
				anchor.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
				if e := anchor.Start(); e != nil {
					return nil, e
				}
				children = append(children, anchor)
				t.Cleanup(func() { _ = anchor.Process.Kill(); _ = anchor.Wait() })
				start, _, _, e := processWitness(anchor.Process.Pid)
				if e != nil {
					t.Fatal(e)
				}
				server := exec.Command(sleep, "30")
				if exited {
					server = exec.Command(sleep, "0")
				}
				server.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pgid: anchor.Process.Pid}
				if e = server.Start(); e != nil {
					t.Fatal(e)
				}
				children = append(children, server)
				t.Cleanup(func() { _ = server.Process.Kill(); _ = server.Wait() })
				if exited {
					for {
						_, _, state, e := processWitness(server.Process.Pid)
						if e != nil || state == "Z" || state == "X" {
							break
						}
						time.Sleep(time.Millisecond)
					}
				}
				process := &hostXpraProcess{anchor: anchor, server: server, start: start, root: t.TempDir(), view: t.TempDir()}
				if scenario == "probe-error" {
					process.probe = func(int) (string, int, string, error) {
						probes++
						return "", 0, "", os.ErrPermission
					}
				}
				return process, nil
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			m.mu.Lock()
			_, err = m.createHostXpra(ctx, "demo", "surface-fast-exit", "v0.2", Profile{}, "/app", Geometry{W: 1, H: 1})
			m.mu.Unlock()
			if err == nil {
				t.Fatal("windowless program admitted")
			}
			if exited && (ctx.Err() != nil || !strings.Contains(err.Error(), "exited")) {
				t.Fatalf("did not detect early exit: %v, context: %v", err, ctx.Err())
			}
			if !exited && ctx.Err() == nil {
				t.Fatalf("live program refused before discovery deadline: %v", err)
			}
			if scenario == "probe-error" && probes < 2 {
				t.Fatalf("unknown probe result ended discovery: %d probes", probes)
			}
			for _, child := range children {
				if child.ProcessState == nil {
					t.Fatalf("discovery returned without waiting for child %d", child.Process.Pid)
				}
				if _, e := os.Stat(fmt.Sprintf("/proc/%d", child.Process.Pid)); !os.IsNotExist(e) {
					t.Fatalf("child %d still present after cleanup: %v", child.Process.Pid, e)
				}
			}
		})
	}
}

// Measured on WSL2: /tmp/.X11-unix is a read-only mount and Xvfb listens only on the abstract socket.
func TestHostDisplayReadyOnAbstractSocket(t *testing.T) {
	display := ":64999"
	sockets := hostDisplaySockets(display)
	if len(sockets) != 2 || sockets[1] != "@"+sockets[0] {
		t.Fatalf("sockets %v", sockets)
	}
	l, err := net.Listen("unix", sockets[1])
	if err != nil {
		t.Skip("abstract sockets unavailable:", err)
	}
	defer l.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := waitHostSocket(ctx, sockets, nil, "Xvfb", &hostXpraLog{}); err != nil {
		t.Fatal(err)
	}
	short, stop := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer stop()
	if err := waitHostSocket(short, []string{"/nonexistent/socket"}, nil, "Xvfb", &hostXpraLog{}); err == nil {
		t.Fatal("absent socket reported ready")
	}
}

// The X client library matches this entry when the connection has no display number.
func TestAbstractXauthEntryFormat(t *testing.T) {
	path := filepath.Join(t.TempDir(), "xauthority")
	if err := os.WriteFile(path, []byte("existing"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := appendAbstractXauth(path, []byte{1, 2}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := append([]byte("existing"), 0xff, 0xff, 0, 0, 0, 0, 0, 18)
	want = append(want, "MIT-MAGIC-COOKIE-1"...)
	want = append(want, 0, 2, 1, 2)
	if string(raw) != string(want) {
		t.Fatalf("entry %x want %x", raw, want)
	}
	if appendAbstractXauth(filepath.Join(t.TempDir(), "absent", "file"), []byte{1}) == nil {
		t.Fatal("unwritable path admitted")
	}
}
