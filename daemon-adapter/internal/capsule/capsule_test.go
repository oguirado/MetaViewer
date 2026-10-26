package capsule

import (
	"context"
	"encoding/json"
	"errors"
	"metaviewer/daemon-adapter/internal/cli"
	"testing"
)

type forbiddenRunner struct{ called bool }

func (r *forbiddenRunner) Run(context.Context, []string, []byte) ([]byte, error) {
	r.called = true
	return nil, nil
}
func TestRefusalsHaveNoEffects(t *testing.T) {
	r := &forbiddenRunner{}
	b := New(r, func() uint64 { t.Fatal("stub read clock"); return 0 })
	for _, req := range []Request{
		{Schema: "surface_request/v9.9", Op: "create"},
		{Schema: "surface_request/v0.2", Op: "unknown"},
		{Schema: "surface_request/v0.2", Op: "create", Params: json.RawMessage(`{"kind":"unknown","profile_id":"unknown"}`)},
	} {
		replies, err := b.Handle(context.Background(), req)
		var fault *cli.Fault
		if !errors.As(err, &fault) || len(replies) != 0 || r.called {
			t.Fatal("refused request performed effect")
		}
	}
}
func TestErrorEventShape(t *testing.T) {
	e, err := NewErrorEvent("surface-test", &cli.Fault{Code: "malformed_cli", Detail: "invalid CLI output"})
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	if len(fields) != 3 || fields["data"] == nil || string(fields["schema"]) != `"surface_event/v0.1"` {
		t.Fatal("wrong event shape")
	}
	for _, fault := range []*cli.Fault{nil, {}, {Code: "x"}, {Detail: "x"}} {
		if _, err := NewErrorEvent("surface-test", fault); err == nil {
			t.Fatal("incomplete fault accepted")
		}
	}
}
