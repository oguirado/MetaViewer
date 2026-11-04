package daemon

import (
	"context"
	"encoding/json"
	"os"
	"sync"
	"testing"

	"metaviewer/daemon-adapter/internal/ipc"
)

func TestNormalGuestCommandModeIsExplicitAndFailClosed(t *testing.T) {
	t.Setenv("MV_ARM64_CAPSULES", "")
	t.Setenv("MV_GUEST_COMMAND_PROFILE", "/not-an-admitted-profile")
	owner, err := normalGuestCommandFromEnv()
	if err != nil || owner != nil {
		t.Fatal("ordinary launch consumed capsule setup")
	}
	for _, value := range []string{"0", "true", "yes"} {
		t.Setenv("MV_ARM64_CAPSULES", value)
		if _, err := normalGuestCommandFromEnv(); err == nil {
			t.Fatal("invalid mode admitted")
		}
	}
	t.Setenv("MV_ARM64_CAPSULES", "1")
	t.Setenv("MV_GUEST_COMMAND_PROFILE", "")
	if _, err := normalGuestCommandFromEnv(); err == nil {
		t.Fatal("normal capsule mode fell back without profile")
	}
}

func TestNormalGuestCommandRouteRetainsStreamingAndContractGate(t *testing.T) {
	bootstrapEnvironment(t)
	owner := &commandBootstrapOwner{root: t.TempDir()}
	if err := os.Chmod(owner.root, 0700); err != nil {
		t.Fatal(err)
	}
	r, err := guestCommandOnlyRuntimeFromEnv(func() (guestCommandOwner, error) { return owner, nil })
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	in := r.Registration
	in.Body = json.RawMessage(`{"schema":"guest_command_request/v0.2","request_id":"request-unit","op":"create","params":{"profile_id":"guest-command-arm64-v1"}}`)
	in.Schema = ipc.EnvelopeSchema(in.Body)
	if _, err := routeGuestCommand(context.Background(), owner, r.Policy, in); err == nil {
		t.Fatal("missing authenticated stream admitted")
	}
	if _, err := routeGuestCommand(context.Background(), nil, r.Policy, in); err == nil {
		t.Fatal("missing owner admitted")
	}
	var emitted json.RawMessage
	ctx := context.WithValue(context.Background(), streamKey{}, streamSession{ctx: context.Background(), work: &sync.Mutex{}, emit: func(_ context.Context, b json.RawMessage) error {
		emitted = append(json.RawMessage(nil), b...)
		return nil
	}})
	if _, err := routeGuestCommand(ctx, owner, r.Policy, in); err != nil {
		t.Fatal(err)
	}
	if owner.calls != 1 || len(emitted) == 0 {
		t.Fatal("normal route lost same-session event")
	}
	out := in
	out.From, out.To = out.To, out.From
	out.Body = emitted
	raw, _ := json.Marshal(out)
	if _, err := r.Policy.ValidateEnvelope(raw); err != nil {
		t.Fatal(err)
	}
	out.Schema = "envelope/v0.2"
	raw, _ = json.Marshal(out)
	if _, err := r.Policy.ValidateEnvelope(raw); err == nil {
		t.Fatal("legacy root widened by normal mode")
	}
}
