package view

import (
	"context"
	"metaviewer/daemon-adapter/internal/cli"
)

type Backend interface {
	Open(context.Context, string, bool) error
	Stop(context.Context, string) error
}
type backend struct{}

func New() Backend                                       { return backend{} }
func (backend) Open(context.Context, string, bool) error { return cli.Unsupported("view") }
func (backend) Stop(context.Context, string) error       { return cli.Unsupported("view-stop") }
