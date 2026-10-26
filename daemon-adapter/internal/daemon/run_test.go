package daemon

import (
	"bytes"
	"context"
	"errors"
	"metaviewer/daemon-adapter/internal/cli"
	"testing"
)

func TestStubRefusal(t *testing.T) {
	table := Commands()
	for _, op := range []string{"create", "list", "destroy", "take_control", "release_control", "input", "frame_subscribe", "frame_unsubscribe", "view", "login", "view-stop", "record_start", "record_stop", "screenshot"} {
		t.Run(op, func(t *testing.T) {
			fn, ok := table[op]
			if !ok {
				t.Fatal("missing command")
			}
			var fault *cli.Fault
			if err := fn(context.Background(), nil); !errors.As(err, &fault) || fault.Code != "unsupported" {
				t.Fatalf("stub fabricated success: %v", err)
			}
		})
	}
}
func TestRunFailsClosed(t *testing.T) {
	var log bytes.Buffer
	if Run(context.Background(), nil, &log) == 0 || log.Len() == 0 {
		t.Fatal("missing policy accepted")
	}
	if Run(context.Background(), []string{"unknown"}, &log) == 0 {
		t.Fatal("unknown argv accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if Run(ctx, nil, &log) == 0 {
		t.Fatal("cancelled startup accepted")
	}
}
