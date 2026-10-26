package frames

import (
	"context"
	"metaviewer/daemon-adapter/internal/cli"
)

type Ref struct {
	Schema     string `json:"schema"`
	SurfaceID  string `json:"surface_id"`
	Generation uint64 `json:"generation"`
	Tick       uint64 `json:"tick"`
	TsNS       uint64 `json:"ts_ns"`
	Width      uint32 `json:"width"`
	Height     uint32 `json:"height"`
	Format     string `json:"format"`
	RAMWSPath  string `json:"ramws_path"`
	SHA256     string `json:"sha256"`
	CaptureUS  uint64 `json:"capture_us"`
}
type Backend interface {
	Subscribe(context.Context, string) error
	Unsubscribe(context.Context, string) error
}
type backend struct{}

func New() Backend                                      { return backend{} }
func (backend) Subscribe(context.Context, string) error { return cli.Unsupported("frame_subscribe") }
func (backend) Unsubscribe(context.Context, string) error {
	return cli.Unsupported("frame_unsubscribe")
}
