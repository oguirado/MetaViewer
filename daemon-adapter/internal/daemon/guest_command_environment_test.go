package daemon

import (
	"context"
	"encoding/json"
	"metaviewer/daemon-adapter/internal/ipc"
	"os"
	"strings"
	"sync"
	"testing"
)

type commandBootstrapOwner struct {
	root  string
	calls int
}

func (o *commandBootstrapOwner) StateRoot() string { return o.root }
func (o *commandBootstrapOwner) Close() error      { return nil }
func (o *commandBootstrapOwner) Handle(_ context.Context, _ json.RawMessage, sid string, validate, emit func(json.RawMessage) error) ([]json.RawMessage, error) {
	if sid != "session-test" {
		panic("session not propagated")
	}
	o.calls++
	body := json.RawMessage(`{"schema":"guest_command_event/v0.2","event_id":"event-unit","request_id":"request-unit","reservation_id":"reservation-unit","owner_id":"actor-unit","session":null,"event":"refused","data":{"op":"create","code":"UNAVAILABLE"}}`)
	if e := validate(body); e != nil {
		return nil, e
	}
	return nil, emit(body)
}
func TestGuestCommandOnlyRequiresExactExclusiveMode(t *testing.T) {
	bootstrapEnvironment(t)
	for _, value := range []string{"0", "true", "yes"} {
		t.Setenv("MV_GUEST_COMMAND_ONLY", value)
		if _, e := RuntimeFromEnv(); e == nil {
			t.Fatal("accepted invalid mode")
		}
	}
	t.Setenv("MV_GUEST_COMMAND_ONLY", "1")
	for _, value := range []string{"1", "0", "false"} {
		t.Setenv("MV_HEADLESS_ONLY", value)
		if _, e := RuntimeFromEnv(); e == nil {
			t.Fatal("accepted overlapping mode")
		}
	}
}
func TestGuestCommandBootstrapUsesExistingAuthenticatedStream(t *testing.T) {
	bootstrapEnvironment(t)
	t.Setenv("MV_GUEST_COMMAND_ONLY", "1")
	owner := &commandBootstrapOwner{root: t.TempDir()}
	os.Chmod(owner.root, 0700)
	r, e := guestCommandOnlyRuntimeFromEnv(func() (guestCommandOwner, error) { return owner, nil })
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	if !r.Client || !r.Streaming {
		t.Fatal("missing authenticated stream")
	}
	if _, e = r.Handler(context.Background(), r.Registration); e != nil {
		t.Fatal(e)
	}
	in := r.Registration
	in.Body = json.RawMessage(`{"schema":"guest_command_request/v0.2","request_id":"request-unit","op":"create","params":{"profile_id":"guest-command-arm64-v1"}}`)
	in.Schema = ipc.EnvelopeSchema(in.Body)
	if _, e = r.Handler(context.Background(), in); e == nil {
		t.Fatal("missing stream should fail")
	}
	var emitted json.RawMessage
	ctx := context.WithValue(context.Background(), streamKey{}, streamSession{ctx: context.Background(), work: &sync.Mutex{}, emit: func(_ context.Context, b json.RawMessage) error {
		emitted = append(json.RawMessage(nil), b...)
		return nil
	}})
	out, e := r.Handler(ctx, in)
	if e != nil {
		t.Fatal(e)
	}
	if len(out) != 0 || owner.calls != 1 || !strings.Contains(string(emitted), "guest_command_event/v0.2") {
		t.Fatal("not emitted through stream")
	}
}
