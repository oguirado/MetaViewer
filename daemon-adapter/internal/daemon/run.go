package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
	"metaviewer/daemon-adapter/internal/ipc"
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

// [TARGET, unit decision] Runtime is the explicit authority integration seam.
// A bare CLI launch retains the configuration refusal; no authority is fabricated.
type Runtime struct {
	Config  ipc.Config
	Policy  ipc.Policy
	Handler ipc.Handler
}

func Run(ctx context.Context, args []string, stderr io.Writer, configured ...Runtime) int {
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
	if len(configured) > 1 {
		fmt.Fprintln(stderr, "adapter: one runtime required")
		return 2
	}
	if len(configured) == 1 {
		runtime := configured[0]
		if runtime.Policy == nil || runtime.Handler == nil {
			fmt.Fprintln(stderr, "adapter: policy and handler required")
			return 2
		}
		listener, err := ipc.Listen(ctx, runtime.Config)
		if err == nil {
			err = ipc.Serve(ctx, listener, runtime.Config, runtime.Policy, runtime.Handler, stderr)
		}
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 2
		}
		return 0
	}
	_ = Commands()
	fmt.Fprintln(stderr, cli.Unsupported("authority policy: authenticated sender binding, durable replay and outbound identity"))
	return 2
}
