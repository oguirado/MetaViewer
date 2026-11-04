package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestSlotWorkerEndsWithLaunchingParent(t *testing.T) {
	root := os.Getenv("MV_SLOT_PARENT_TEST_ROOT")
	mode := os.Getenv("MV_SLOT_PARENT_TEST_MODE")
	if mode == "child" {
		runtime.LockOSThread()
		if e := bindParentLifetime(); e != nil {
			os.Exit(3)
		}
		if e := os.WriteFile(filepath.Join(root, "ready"), []byte("ready"), 0600); e != nil {
			os.Exit(4)
		}
		time.Sleep(30 * time.Second)
		os.Exit(5)
	}
	if mode == "parent" {
		child := exec.Command(os.Args[0], "-test.run=^TestSlotWorkerEndsWithLaunchingParent$")
		child.Env = append(os.Environ(), "MV_SLOT_PARENT_TEST_MODE=child")
		if e := child.Start(); e != nil {
			os.Exit(6)
		}
		_ = os.WriteFile(filepath.Join(root, "pid"), []byte(strconv.Itoa(child.Process.Pid)), 0600)
		deadline := time.Now().Add(3 * time.Second)
		for {
			if _, e := os.Stat(filepath.Join(root, "ready")); e == nil {
				break
			}
			if time.Now().After(deadline) {
				os.Exit(7)
			}
			time.Sleep(time.Millisecond)
		}
		// Negative control: the child must remain alive while its parent lives.
		time.Sleep(30 * time.Millisecond)
		if e := syscall.Kill(child.Process.Pid, 0); e != nil {
			os.Exit(8)
		}
		os.Exit(0)
	}
	root = t.TempDir()
	parent := exec.Command(os.Args[0], "-test.run=^TestSlotWorkerEndsWithLaunchingParent$")
	parent.Env = append(os.Environ(), "MV_SLOT_PARENT_TEST_ROOT="+root, "MV_SLOT_PARENT_TEST_MODE=parent")
	if out, e := parent.CombinedOutput(); e != nil {
		t.Fatal(string(out), e)
	}
	raw, e := os.ReadFile(filepath.Join(root, "pid"))
	if e != nil {
		t.Fatal(e)
	}
	pid, e := strconv.Atoi(string(raw))
	if e != nil {
		t.Fatal(e)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		stat, e := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
		if os.IsNotExist(e) || (e == nil && strings.HasPrefix(string(stat[strings.LastIndex(string(stat), ")")+1:]), " Z")) {
			return
		}
		if time.Now().After(deadline) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
			t.Fatal("slot worker survived launching parent")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
