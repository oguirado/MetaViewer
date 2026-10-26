package main

import (
	"context"
	"metaviewer/daemon-adapter/internal/daemon"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	code := daemon.Run(ctx, os.Args[1:], os.Stderr)
	stop()
	os.Exit(code)
}
