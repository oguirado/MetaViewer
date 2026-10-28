package view

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/cli"
)

func processFixture(t *testing.T, announcement string) *ProcessRunner {
	t.Helper()
	interpreter, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	state := filepath.Join(root, "state")
	if err = os.Mkdir(state, 0700); err != nil {
		t.Fatal(err)
	}
	script := "#!" + interpreter + "\n" + `import json, os, sys, time
verb = sys.argv[1]
if verb in ('view', 'login'):
    print(` + announcement + `, flush=True)
    try:
        while True: time.sleep(0.01)
    except KeyboardInterrupt:
        pass
elif verb == 'paste-text':
    text = sys.stdin.read()
    print(json.dumps({'pasted_runes': len(text), 'container': sys.argv[3]}))
else:
    sys.exit(4)
`
	if err = os.WriteFile(filepath.Join(root, "srf-identity-surface"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	r, err := NewProcessRunner(root, []string{"PATH=" + os.Getenv("PATH"), "MV_SRF_STATE_DIR=" + state})
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func TestForegroundReadinessAndReap(t *testing.T) {
	r := processFixture(t, `json.dumps({'url':'http://127.0.0.1:1234/', 'native':str(os.getpid()), 'socket':'/runtime/view.sock'})`)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	child, err := r.Start(ctx, []string{"srf-identity-surface", "view", "--container", "srf-id-demo"})
	if err != nil {
		t.Fatal(err)
	}
	info, err := parseInfo(child.Announcement)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(info.Native)
	if err != nil || pid <= 1 || pid == os.Getpid() || pid == syscall.Getpgrp() {
		t.Fatal("invalid child identity")
	}
	cancel()
	time.Sleep(30 * time.Millisecond)
	if err := syscall.Kill(pid, 0); err != nil {
		t.Fatal("request cancellation killed registered view", err)
	}
	child.Close()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("view child was not reaped")
}
func TestMalformedForegroundIsClosed(t *testing.T) {
	interpreter, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	state := filepath.Join(root, "state")
	if err := os.Mkdir(state, 0700); err != nil {
		t.Fatal(err)
	}
	lockPath := filepath.Join(root, "malformed.lock")
	script := "#!" + interpreter + "\n" + fmt.Sprintf(`import fcntl, os, signal, time
pid = os.fork()
if pid == 0:
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    os.close(0)
    os.close(1)
    os.close(2)
    fd = os.open(%q, os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    while True:
        time.sleep(0.05)
while not os.path.exists(%q):
    time.sleep(0.01)
print('not json', flush=True)
try:
    while True:
        time.sleep(0.05)
except KeyboardInterrupt:
    pass
`, lockPath, lockPath)
	if err := os.WriteFile(filepath.Join(root, "srf-identity-surface"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	r, err := NewProcessRunner(root, []string{"PATH=" + os.Getenv("PATH"), "MV_SRF_STATE_DIR=" + state})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := r.Start(ctx, []string{"srf-identity-surface", "login", "--container", "srf-id-demo"}); err == nil {
		t.Fatal("malformed foreground accepted")
	}
	lockFile, err := os.OpenFile(lockPath, os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lockFile.Close() }()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err == nil {
			_ = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("malformed foreground descendant was not reaped")
}
func TestProcessRefusalsAndPasteStdin(t *testing.T) {
	r := processFixture(t, `'not json'`)
	if _, err := r.Start(context.Background(), []string{"sh", "login", "--container", "srf-id-demo"}); err == nil {
		t.Fatal("foreign executable")
	}
	if _, err := r.Run(context.Background(), []string{"srf-identity-surface", "input"}, nil); err == nil {
		t.Fatal("agent input on operator seam")
	}
	if _, err := r.Run(context.Background(), []string{"srf-identity-surface", "view-stop", "--container", "srf-id-demo"}, nil); err == nil {
		t.Fatal("stop without view")
	}
	out, err := r.Run(context.Background(), []string{"srf-identity-surface", "paste-text", "--container", "srf-id-demo", "--file", "-"}, []byte("café"))
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != fmt.Sprintln(`{"pasted_runes": 4, "container": "srf-id-demo"}`) {
		t.Fatal(string(out))
	}
	if err = os.Chmod(r.stateDir, 0755); err != nil {
		t.Fatal(err)
	}
	if _, err = r.Start(context.Background(), []string{"srf-identity-surface", "view", "--container", "srf-id-demo"}); err == nil {
		t.Fatal("public state directory accepted")
	}
}

func TestManagerReapsOnFailedStopAndClose(t *testing.T) {
	for _, stop := range []bool{false, true} {
		r := processFixture(t, `json.dumps({'url':'http://127.0.0.1:1234/', 'native':str(os.getpid()), 'socket':'/runtime/view.sock'})`)
		b := NewManager(r)
		t.Cleanup(b.Close)
		ctx, cancel := context.WithCancel(context.Background())
		if err := b.Open(ctx, "srf-id-demo", false); err != nil {
			cancel()
			t.Fatal(err)
		}
		info, _ := b.Info("srf-id-demo")
		pid, err := strconv.Atoi(info.Native)
		if err != nil || pid <= 1 || pid == os.Getpid() {
			cancel()
			t.Fatal("invalid child")
		}
		cancel()
		if stop {
			if err := b.Stop(context.Background(), "srf-id-demo"); err == nil {
				t.Fatal("fake stop should refuse")
			}
		} else {
			b.Close()
		}
		if !errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
			t.Fatal("retained child after cleanup")
		}
		if _, ok := b.Info("srf-id-demo"); ok {
			t.Fatal("retained stale view")
		}
	}
}

func TestManagerEvictsExitedChild(t *testing.T) {
	r := processFixture(t, `json.dumps({'url':'http://127.0.0.1:1234/', 'native':str(os.getpid()), 'socket':'/runtime/view.sock'})`)
	b := NewManager(r)
	t.Cleanup(b.Close)
	if err := b.Open(context.Background(), "srf-id-demo", false); err != nil {
		t.Fatal(err)
	}
	b.mu.Lock()
	child := b.views["srf-id-demo"].child
	b.mu.Unlock()
	child.Close()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, ok := b.Info("srf-id-demo"); !ok {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("exited child still registered")
}

func TestStateDirPathBypassesRefused(t *testing.T) {
	interpreter, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"relative", "dot", "dotdot", "double-slash", "symlink-slash", "symlink-dot", "ancestor-symlink", "ancestor-symlink-create"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			marker := filepath.Join(root, "launched")
			state := filepath.Join(root, "state")
			if err := os.Mkdir(state, 0700); err != nil {
				t.Fatal(err)
			}
			link := filepath.Join(root, "link")
			target := root
			if mode == "symlink-slash" || mode == "symlink-dot" {
				target = state
			}
			if err := os.Symlink(target, link); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "relative":
				cwd, err := os.Getwd()
				if err != nil {
					t.Fatal(err)
				}
				state, err = filepath.Rel(cwd, state)
				if err != nil {
					t.Fatal(err)
				}
			case "dot":
				state += "/."
			case "dotdot":
				state = root + "/state/../state"
			case "double-slash":
				state = root + "//state"
			case "symlink-slash":
				state = link + "/"
			case "symlink-dot":
				state = link + "/."
			case "ancestor-symlink":
				state = link + "/state"
			case "ancestor-symlink-create":
				state = link + "/new-state"
			}
			script := "#!" + interpreter + "\n" + fmt.Sprintf("open(%q, 'w').write('1')\n", marker)
			if err := os.WriteFile(filepath.Join(root, "srf-identity-surface"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			r, err := NewProcessRunner(root, []string{"PATH=" + os.Getenv("PATH"), "MV_SRF_STATE_DIR=" + state})
			if err != nil {
				t.Fatal(err)
			}
			_, err = r.Start(context.Background(), []string{"srf-identity-surface", "view", "--container", "srf-id-demo"})
			var f *cli.Fault
			if !errors.As(err, &f) || f.Code != "configuration" {
				t.Fatalf("path bypass %s accepted: %v", mode, err)
			}
			if _, statErr := os.Stat(marker); !os.IsNotExist(statErr) {
				t.Fatalf("helper launched on refused path %s", mode)
			}
			if _, statErr := os.Stat(filepath.Join(root, "new-state")); !os.IsNotExist(statErr) {
				t.Fatalf("created state through symlink ancestor in %s", mode)
			}
		})
	}
	// Negative control: normal 0700 state directory launches.
	valid := processFixture(t, `json.dumps({'url':'http://127.0.0.1:1234/', 'native':str(os.getpid()), 'socket':'/runtime/view.sock'})`)
	child, err := valid.Start(context.Background(), []string{"srf-identity-surface", "view", "--container", "srf-id-demo"})
	if err != nil {
		t.Fatal(err)
	}
	child.Close()
}

func TestRemovedStateDirRefusedWithoutRecreation(t *testing.T) {
	r := processFixture(t, `json.dumps({'url':'http://127.0.0.1:1234/', 'native':str(os.getpid()), 'socket':'/runtime/view.sock'})`)
	if err := os.Remove(r.stateDir); err != nil {
		t.Fatal(err)
	}
	_, err := r.Start(context.Background(), []string{"srf-identity-surface", "view", "--container", "srf-id-demo"})
	var f *cli.Fault
	if !errors.As(err, &f) || f.Code != "configuration" {
		t.Fatalf("removed stateDir not refused with configuration fault: %v", err)
	}
	if _, statErr := os.Stat(r.stateDir); !os.IsNotExist(statErr) {
		t.Fatalf("removed stateDir was recreated on Start: %v", statErr)
	}
	// Negative control: restoring valid 0700 stateDir allows Start to succeed.
	if err := os.Mkdir(r.stateDir, 0700); err != nil {
		t.Fatal(err)
	}
	child, err := r.Start(context.Background(), []string{"srf-identity-surface", "view", "--container", "srf-id-demo"})
	if err != nil {
		t.Fatalf("restored stateDir refused: %v", err)
	}
	child.Close()
}

func TestForegroundProcessGroupDescendantReapAndSentinel(t *testing.T) {
	interpreter, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal(err)
	}
	sentinel := exec.Command(interpreter, "-c", "import time\nwhile True: time.sleep(0.1)\n")
	sentinel.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := sentinel.Start(); err != nil {
		t.Fatal(err)
	}
	sentinelPID := sentinel.Process.Pid
	t.Cleanup(func() {
		_ = syscall.Kill(-sentinelPID, syscall.SIGKILL)
		_ = sentinel.Wait()
	})

	for _, ignoreSIGINT := range []bool{false, true} {
		name := "default_sigint"
		if ignoreSIGINT {
			name = "ignore_sigint"
		}
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			state := filepath.Join(root, "state")
			if err := os.Mkdir(state, 0700); err != nil {
				t.Fatal(err)
			}
			lockPath := filepath.Join(root, "descendant.lock")
			readyPath := filepath.Join(root, "descendant.ready")
			sigSetup := ""
			if ignoreSIGINT {
				sigSetup = "signal.signal(signal.SIGINT, signal.SIG_IGN)\n"
			}
			script := "#!" + interpreter + "\n" + fmt.Sprintf(`import fcntl, json, os, signal, sys, time
%spid = os.fork()
if pid == 0:
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    os.close(0)
    os.close(1)
    os.close(2)
    fd = os.open(%q, os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    with open(%q, 'w') as rf:
        rf.write('ready')
    while True:
        time.sleep(0.05)
while not os.path.exists(%q):
    time.sleep(0.01)
print(json.dumps({'url':'http://127.0.0.1:1234/', 'native':'999999', 'socket':'/runtime/view.sock'}), flush=True)
try:
    while True:
        time.sleep(0.05)
except KeyboardInterrupt:
    pass
`, sigSetup, lockPath, readyPath, readyPath)
			if err := os.WriteFile(filepath.Join(root, "srf-identity-surface"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			r, err := NewProcessRunner(root, []string{"PATH=" + os.Getenv("PATH"), "MV_SRF_STATE_DIR=" + state})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			child, err := r.Start(ctx, []string{"srf-identity-surface", "view", "--container", "srf-id-demo"})
			if err != nil {
				t.Fatal(err)
			}
			lockFile, err := os.OpenFile(lockPath, os.O_RDWR, 0600)
			if err != nil {
				child.Close()
				t.Fatal(err)
			}
			defer func() { _ = lockFile.Close() }()
			if err := syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err == nil {
				_ = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)
				child.Close()
				t.Fatal("descendant did not hold flock while view was active")
			}

			child.Close()

			deadline := time.Now().Add(15 * time.Second)
			reapedDescendant := false
			for time.Now().Before(deadline) {
				if err := syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err == nil {
					_ = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)
					reapedDescendant = true
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			if !reapedDescendant {
				t.Fatal("descendant process outlived Process.Close()")
			}
			if err := syscall.Kill(sentinelPID, 0); err != nil {
				t.Fatalf("unrelated sentinel process harmed: %v", err)
			}
		})
	}
}
