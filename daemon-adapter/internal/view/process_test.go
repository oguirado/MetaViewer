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
	r := processFixture(t, `'not json'`)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := r.Start(ctx, []string{"srf-identity-surface", "login", "--container", "srf-id-demo"}); err == nil {
		t.Fatal("malformed foreground accepted")
	}
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
