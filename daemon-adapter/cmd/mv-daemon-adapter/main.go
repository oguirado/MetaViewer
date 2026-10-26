package main

import (
	"context"
	"fmt"
	"metaviewer/daemon-adapter/internal/daemon"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
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
