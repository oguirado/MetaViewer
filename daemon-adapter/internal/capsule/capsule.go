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

// New retains the skeleton seam. Runtime configuration is explicit in NewManager.
func New(r cli.Runner, clock cli.Clock) Backend { return unconfigured{} }

type unconfigured struct{}

func (unconfigured) Handle(ctx context.Context, r Request) ([]json.RawMessage, error) {
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	return nil, &cli.Fault{Code: "configuration", Detail: "native profile and session configuration required"}
}
