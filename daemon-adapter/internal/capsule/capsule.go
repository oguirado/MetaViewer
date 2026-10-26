package capsule

import (
	"context"
	"encoding/json"
	"errors"
	"metaviewer/daemon-adapter/internal/cli"
)

type Request struct {
	Schema string          `json:"schema"`
	Op     string          `json:"op"`
	Params json.RawMessage `json:"params"`
}
type ErrorData struct {
	SurfaceID string `json:"surface_id"`
	Code      string `json:"code"`
	Detail    string `json:"detail"`
}
type ErrorEvent struct {
	Schema string    `json:"schema"`
	Event  string    `json:"event"`
	Data   ErrorData `json:"data"`
}

func NewErrorEvent(surfaceID string, fault *cli.Fault) (ErrorEvent, error) {
	if surfaceID == "" || len(surfaceID) > 128 || fault == nil || fault.Code == "" || len(fault.Code) > 128 || fault.Detail == "" || len(fault.Detail) > 65536 {
		return ErrorEvent{}, errors.New("error event requires supplied surface identity and fault")
	}
	return ErrorEvent{Schema: "surface_event/v0.1", Event: "error", Data: ErrorData{SurfaceID: surfaceID, Code: fault.Code, Detail: fault.Detail}}, nil
}

type Backend interface {
	Handle(context.Context, Request) ([]json.RawMessage, error)
}
type backend struct {
	runner cli.Runner
	clock  cli.Clock
}

func New(r cli.Runner, clock cli.Clock) Backend { return &backend{runner: r, clock: clock} }
func (b *backend) Handle(ctx context.Context, r Request) ([]json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if r.Schema != "surface_request/v0.1" && r.Schema != "surface_request/v0.2" {
		return nil, &cli.Fault{Code: "schema", Detail: "unsupported request schema"}
	}
	switch r.Op {
	case "create", "list", "destroy", "take_control", "release_control", "input", "frame_subscribe", "frame_unsubscribe":
		return nil, cli.Unsupported(r.Op)
	default:
		return nil, &cli.Fault{Code: "unknown_op", Detail: "unknown surface operation"}
	}
}
