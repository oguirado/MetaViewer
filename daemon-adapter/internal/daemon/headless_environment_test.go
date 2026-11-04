package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"metaviewer/daemon-adapter/internal/ipc"
)

type bootstrapOwner struct {
	root          string
	calls, closed int
}

func (o *bootstrapOwner) StateRoot() string { return o.root }
func (o *bootstrapOwner) Close() error      { o.closed++; return nil }
func (o *bootstrapOwner) Handle(_ context.Context, _ json.RawMessage, validate func(json.RawMessage) error) ([]json.RawMessage, error) {
	o.calls++
	b := json.RawMessage(`{"schema":"headless_event/v0.2","event_id":"event-test","request_id":"request-test","event":"refused","data":{"workload_id":null,"generation":null,"code":"UNAVAILABLE","effect":"not_dispatched"}}`)
	if e := validate(b); e != nil {
		return nil, e
	}
	return []json.RawMessage{b}, nil
}
func bootstrapEnvironment(t *testing.T) {
	t.Helper()
	for _, key := range []string{"MV_SRF_BIN_DIR", "MV_SRF_STATE_DIR", "SRF_IDENTITY_STORE_ROOT", "SRF_PROXY_REGISTRY", "MV_SRF_PROFILES", "MV_HEADLESS_PROFILE", "MV_HEADLESS_ONLY", "MV_EXPECTED_CORE_COMMIT"} {
		t.Setenv(key, "")
	}
	t.Setenv("MV_SESSION_ID", "session-test")
	t.Setenv("MV_CORE_INSTANCE", "core-test")
	t.Setenv("MV_DAEMON_INSTANCE", "daemon-test")
	t.Setenv("MV_COMPONENT_COMMIT", strings.Repeat("a", 40))
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	root, e := filepath.Abs("../../../contracts/v0.2")
	if e != nil {
		t.Fatal(e)
	}
	t.Setenv("MV_CONTRACT_DIR", root)
}
func TestHeadlessOnlyBootstrapNoGraphicalDependencies(t *testing.T) {
	bootstrapEnvironment(t)
	owner := &bootstrapOwner{root: t.TempDir()}
	os.Chmod(owner.root, 0700)
	runtime, e := headlessOnlyRuntimeFromEnv(func() (headlessOwner, error) { return owner, nil })
	if e != nil {
		t.Fatal(e)
	}
	defer runtime.Close()
	if !runtime.Client || !runtime.Streaming {
		t.Fatal("authenticated client missing")
	}
	if _, e = runtime.Handler(context.Background(), runtime.Registration); e != nil {
		t.Fatal(e)
	}
	call := func(body string) []json.RawMessage {
		t.Helper()
		in := runtime.Registration
		in.Body = json.RawMessage(body)
		out, e := runtime.Handler(context.Background(), in)
		if e != nil {
			t.Fatal(e)
		}
		for _, b := range out {
			frame := in
			frame.From, frame.To = frame.To, frame.From
			frame.Body = b
			frame.Schema = ipc.EnvelopeSchema(b)
			raw, _ := json.Marshal(frame)
			if _, e = runtime.Policy.ValidateEnvelope(raw); e != nil {
				t.Fatal(e)
			}
		}
		return out
	}
	if out := call(`{"schema":"surface_request/v0.2","op":"list","params":{}}`); len(out) != 0 {
		t.Fatal("fake surface list")
	}
	out := call(`{"schema":"surface_request/v0.2","op":"create","params":{"kind":"vm"}}`)
	if len(out) != 1 || !strings.Contains(string(out[0]), `"code":"POLICY"`) {
		t.Fatal("graphical create not refused", out)
	}
	out = call(`{"schema":"record_request/v0.2","request_id":"rec-test","op":"screenshot","params":{"surface_id":"surface-test","capture_id":"capture-test"}}`)
	if len(out) != 1 || !strings.Contains(string(out[0]), `"event":"refused"`) {
		t.Fatal("record not refused", out)
	}
	out = call(`{"schema":"headless_request/v0.2","request_id":"request-test","op":"create","params":{"template":"headless-sumsq"}}`)
	if len(out) != 1 || owner.calls != 1 {
		t.Fatal("headless dispatch absent")
	}
	runtime.Close()
	if owner.closed != 1 {
		t.Fatal("cleanup not idempotent")
	}
}
func TestHeadlessOnlyMissingProfileCannotFallBackToSRF(t *testing.T) {
	bootstrapEnvironment(t)
	t.Setenv("MV_HEADLESS_ONLY", "1")
	if _, e := RuntimeFromEnv(); e == nil || !strings.Contains(e.Error(), "valid host profile") {
		t.Fatal("missing profile not rejected", e)
	}
	t.Setenv("MV_HEADLESS_ONLY", "yes")
	if _, e := RuntimeFromEnv(); e == nil {
		t.Fatal("unknown mode accepted")
	}
	if _, e := headlessOnlyRuntimeFromEnv(func() (headlessOwner, error) { return nil, errors.New("profile pin changed") }); e == nil {
		t.Fatal("loader failure hidden")
	}
}
func TestHeadlessOnlyStillAuthenticatesPinnedCore(t *testing.T) {
	bootstrapEnvironment(t)
	t.Setenv("MV_EXPECTED_CORE_COMMIT", strings.Repeat("b", 40))
	owner := &bootstrapOwner{root: t.TempDir()}
	os.Chmod(owner.root, 0700)
	runtime, e := headlessOnlyRuntimeFromEnv(func() (headlessOwner, error) { return owner, nil })
	if e != nil {
		t.Fatal(e)
	}
	defer runtime.Close()
	in := runtime.Registration
	in.Body = json.RawMessage(`{"schema":"hello/v0.2","component":"core","component_commit":"` + strings.Repeat("a", 40) + `"}`)
	cred := ipc.PeerCredentials{UID: uint32(os.Getuid())}
	if e = runtime.Policy.Authenticate(context.Background(), cred, in); e == nil {
		t.Fatal("wrong core pin accepted")
	}
	in.Body = json.RawMessage(`{"schema":"hello/v0.2","component":"core","component_commit":"` + strings.Repeat("b", 40) + `"}`)
	if e = runtime.Policy.Authenticate(context.Background(), cred, in); e != nil {
		t.Fatal(e)
	}
	in.From.Instance = "foreign"
	if e = runtime.Policy.Authenticate(context.Background(), cred, in); e == nil {
		t.Fatal("foreign core route accepted")
	}
}
