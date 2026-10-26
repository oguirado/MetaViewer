package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/record"
	"metaviewer/daemon-adapter/internal/view"
)

type Command func(context.Context, json.RawMessage) error

// Commands declares internal routing only; it grants no wire authority.
func Commands() map[string]Command {
	cap := capsule.New(nil, nil)
	fr := frames.New()
	rec := record.New()
	vw := view.New()
	table := map[string]Command{}
	for _, op := range []string{"create", "list", "destroy", "take_control", "release_control", "input"} {
		table[op] = func(ctx context.Context, params json.RawMessage) error {
			_, err := cap.Handle(ctx, capsule.Request{Schema: "surface_request/v0.2", Op: op, Params: params})
			return err
		}
	}
	table["frame_subscribe"] = func(ctx context.Context, _ json.RawMessage) error { return fr.Subscribe(ctx, "") }
	table["frame_unsubscribe"] = func(ctx context.Context, _ json.RawMessage) error { return fr.Unsubscribe(ctx, "") }
	table["view"] = func(ctx context.Context, _ json.RawMessage) error { return vw.Open(ctx, "", false) }
	table["login"] = func(ctx context.Context, _ json.RawMessage) error { return vw.Open(ctx, "", true) }
	table["view-stop"] = func(ctx context.Context, _ json.RawMessage) error { return vw.Stop(ctx, "") }
	table["record_start"] = func(ctx context.Context, _ json.RawMessage) error { return rec.Start(ctx, "", "") }
	table["record_stop"] = func(ctx context.Context, _ json.RawMessage) error { return rec.Stop(ctx, "", "") }
	table["screenshot"] = func(ctx context.Context, _ json.RawMessage) error { return rec.Screenshot(ctx, "") }
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
