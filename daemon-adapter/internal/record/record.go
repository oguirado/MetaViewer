package record

import (
	"context"
	"metaviewer/daemon-adapter/internal/cli"
)

type Backend interface {
	Start(context.Context, string, string) error
	Stop(context.Context, string, string) error
	Screenshot(context.Context, string) error
}
type backend struct{}

func New() Backend                                          { return backend{} }
func (backend) Start(context.Context, string, string) error { return cli.Unsupported("record_start") }
func (backend) Stop(context.Context, string, string) error  { return cli.Unsupported("record_stop") }
func (backend) Screenshot(context.Context, string) error    { return cli.Unsupported("screenshot") }
