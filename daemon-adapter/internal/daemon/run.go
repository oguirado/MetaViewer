package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
)

type Command func(context.Context, json.RawMessage) error

// Commands declares internal routing only; it grants no wire authority.
func Commands() map[string]Command {
	cap := capsule.New(nil, nil)
	// [TARGET, unit decision] Until native profile/session configuration is
	// supplied, every route shares the backend's typed configuration refusal.
	table := map[string]Command{}
	for _, op := range []string{"create", "list", "destroy", "take_control", "release_control", "input", "frame_subscribe", "frame_unsubscribe", "view", "login", "view-stop", "record_start", "record_stop", "screenshot"} {
		table[op] = func(ctx context.Context, params json.RawMessage) error {
			_, err := cap.Handle(ctx, capsule.Request{Schema: "surface_request/v0.2", Op: op, Params: params})
			return err
		}
	}
	return table
}
func Run(ctx context.Context, args []string, stderr io.Writer) int {
	if stderr == nil {
		return 2
	}
	if len(args) != 0 {
		fmt.Fprintln(stderr, "adapter: unsupported arguments")
		return 2
	}
	if err := ctx.Err(); err != nil {
		fmt.Fprintln(stderr, "adapter: startup cancelled")
		return 2
	}
	_ = Commands()
	fmt.Fprintln(stderr, cli.Unsupported("authority policy: authenticated sender binding, durable replay and outbound identity"))
	return 2
}
