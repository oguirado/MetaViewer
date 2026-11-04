package main

import (
	"context"
	"fmt"
	"metaviewer/daemon-adapter/internal/daemon"
	"os"
	"os/signal"
	"runtime"
	"syscall"
)

func main() {
	// [TARGET, unit decision] A slot write may not outlive its launching app.
	// Linux delivers the parent-death signal to this thread; keep it resident.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	if err := bindParentLifetime(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		stop()
		os.Exit(2)
	}
	runtime, err := daemon.RuntimeFromEnv()
	code := 2
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
	} else {
		code = daemon.Run(ctx, os.Args[1:], os.Stderr, runtime)
	}
	stop()
	os.Exit(code)
}

func bindParentLifetime() error {
	parent := os.Getppid()
	_, _, errno := syscall.Syscall6(syscall.SYS_PRCTL, syscall.PR_SET_PDEATHSIG, uintptr(syscall.SIGTERM), 0, 0, 0, 0)
	if errno != 0 {
		return errno
	}
	if os.Getppid() != parent {
		return fmt.Errorf("launching parent exited before lifetime binding")
	}
	return nil
}
