package headless

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeProcess struct {
	lines                          [][]byte
	writes                         int
	failWrite, failRead, failClose bool
	closed                         bool
}

func (f *fakeProcess) Send(context.Context, []byte) error {
	f.writes++
	if f.failWrite {
		return errors.New("partial send")
	}
	return nil
}
func (f *fakeProcess) Read(context.Context) ([]byte, error) {
	if f.failRead || len(f.lines) == 0 {
		return nil, errors.New("deadline")
	}
	b := f.lines[0]
	f.lines = f.lines[1:]
	return b, nil
}
func (f *fakeProcess) Close(context.Context) error {
	f.closed = true
	if f.failClose {
		return errors.New("cgroup populated")
	}
	return nil
}
func event(id, kind, phase, op string) []byte {
	s := map[string]any{"owner_id": "actor-" + strings.Repeat("a", 64), "phase": phase, "ownership": "held", "workload_id": "workload-test", "generation": 1}
	if phase == "stopped" {
		s["ownership"] = "released"
	}
	b, _ := json.Marshal(map[string]any{"schema": "headless_event/v0.2", "request_id": id, "event_id": "event-test", "event": kind, "data": map[string]any{"session": s, "op": op}})
	return b
}
func validateFake(b json.RawMessage) error {
	var e struct{ Schema string }
	if json.Unmarshal(b, &e) != nil || e.Schema != "headless_event/v0.2" {
		return errors.New("contract")
	}
	return nil
}
func fixture(t *testing.T, f *fakeProcess) *Manager {
	t.Helper()
	root := t.TempDir()
	state := filepath.Join(root, "state")
	run := filepath.Join(root, "run")
	os.Mkdir(state, 0700)
	os.Mkdir(run, 0700)
	script := filepath.Join(root, "runner.py")
	os.WriteFile(script, []byte("# synthetic\n"), 0700)
	h := sha256.Sum256([]byte("# synthetic\n"))
	return &Manager{profile: &Profile{OwnerID: "actor-" + strings.Repeat("a", 64), StateRoot: state, RuntimeRoot: run, Python: Pin{script, hex.EncodeToString(h[:])}, Runner: Pin{script, hex.EncodeToString(h[:])}, ConfigTemplate: json.RawMessage(`{"runtime_admitted":true}`)}, reservation: filepath.Join(state, "headless-reservation.json"), seen: map[string]bool{}, factory: func(context.Context, *Profile, string, string) (process, error) { return f, nil }}
}
func request(id, op string) json.RawMessage {
	return json.RawMessage(`{"schema":"headless_request/v0.2","request_id":"` + id + `","op":"` + op + `","params":{}}`)
}
func TestPersistentLifecycleAndClosure(t *testing.T) {
	f := &fakeProcess{lines: [][]byte{event("request-1", "accepted", "starting", "create"), event("request-1", "state_changed", "ready", ""), event("request-2", "accepted", "running", "run"), event("request-2", "completed", "completed", ""), event("request-3", "accepted", "stopping", "stop"), event("request-3", "state_changed", "stopped", "")}}
	m := fixture(t, f)
	for i, op := range []string{"create", "run", "stop"} {
		id := []string{"request-1", "request-2", "request-3"}[i]
		out, e := m.Handle(context.Background(), request(id, op), validateFake)
		if e != nil || len(out) != 2 {
			t.Fatalf("%s: %s %v", op, out, e)
		}
	}
	if f.writes != 3 || !f.closed {
		t.Fatal("persistent transport/closure absent")
	}
	if _, e := os.Stat(m.reservation + ".closed"); e != nil {
		t.Fatal(e)
	}
	if _, e := m.Handle(context.Background(), request("request-4", "create"), validateFake); e != nil || f.writes != 3 {
		t.Fatal("second create effect")
	}
}
func TestUnknownCreateNeverInventsIdentityOrRetries(t *testing.T) {
	f := &fakeProcess{failWrite: true}
	m := fixture(t, f)
	out, e := m.Handle(context.Background(), request("request-1", "create"), validateFake)
	if e == nil || len(out) != 0 {
		t.Fatal("unacknowledged create fabricated result")
	}
	if _, e = os.Stat(m.reservation); e != nil {
		t.Fatal("lost reservation")
	}
	m.Handle(context.Background(), request("request-1", "create"), validateFake)
	if f.writes != 1 {
		t.Fatal("replayed uncertain create")
	}
}
func TestStopCannotReleaseWithoutServiceClosure(t *testing.T) {
	f := &fakeProcess{failClose: true, lines: [][]byte{event("request-1", "accepted", "starting", "create"), event("request-1", "state_changed", "ready", ""), event("request-2", "accepted", "stopping", "stop"), event("request-2", "state_changed", "stopped", "")}}
	m := fixture(t, f)
	m.Handle(context.Background(), request("request-1", "create"), validateFake)
	out, e := m.Handle(context.Background(), request("request-2", "stop"), validateFake)
	if e != nil || len(out) != 2 || !strings.Contains(string(out[1]), "outcome_unknown") || strings.Contains(string(out[1]), `"ownership":"released"`) {
		t.Fatalf("false release: %s %v", out, e)
	}
	if _, e = os.Stat(m.reservation + ".closed"); !os.IsNotExist(e) {
		t.Fatal("false closure record")
	}
}

func TestControllerUnknownAllowsOnlyDistinctStop(t *testing.T) {
	f := &fakeProcess{lines: [][]byte{event("request-1", "accepted", "starting", "create"), event("request-1", "outcome_unknown", "uncertain", "create"), event("request-3", "accepted", "stopping", "stop"), event("request-3", "state_changed", "stopped", "")}}
	m := fixture(t, f)
	if _, e := m.Handle(context.Background(), request("request-1", "create"), validateFake); e != nil {
		t.Fatal(e)
	}
	out, e := m.Handle(context.Background(), request("request-2", "run"), validateFake)
	if e != nil || len(out) != 1 || !strings.Contains(string(out[0]), "OUT_OF_ORDER") || f.writes != 1 {
		t.Fatal("unknown allowed run")
	}
	if _, e = m.Handle(context.Background(), request("request-3", "stop"), validateFake); e != nil || !f.closed || f.writes != 2 {
		t.Fatal("distinct stop refused", e)
	}
}
func TestRejectsFrameAndWrongCorrelation(t *testing.T) {
	for _, b := range [][]byte{[]byte(`{"schema":"frame/v0.2"}`), event("request-other", "accepted", "starting", "create")} {
		f := &fakeProcess{lines: [][]byte{b}}
		m := fixture(t, f)
		if _, e := m.Handle(context.Background(), request("request-1", "create"), validateFake); e == nil {
			t.Fatal("foreign event accepted")
		}
	}
}
func TestAbsentProfileAndDisabledRefusal(t *testing.T) {
	t.Setenv("MV_HEADLESS_PROFILE", "")
	m, e := NewFromEnv()
	if e != nil || m != nil {
		t.Fatal("default changed")
	}
	out, e := m.Handle(context.Background(), request("request-1", "create"), validateFake)
	if e != nil || !strings.Contains(string(out[0]), "UNAVAILABLE") {
		t.Fatal("disabled route")
	}
}

func TestUnadmittedProfileCannotStartProcess(t *testing.T) {
	f := &fakeProcess{}
	m := fixture(t, f)
	m.profile.ConfigTemplate = json.RawMessage(`{"runtime_admitted":false}`)
	out, e := m.Handle(context.Background(), request("request-1", "create"), validateFake)
	if e != nil || len(out) != 1 || !strings.Contains(string(out[0]), "UNAVAILABLE") || m.attempted || f.writes != 0 {
		t.Fatal("unadmitted process effect")
	}
	if _, e = os.Lstat(m.reservation); !os.IsNotExist(e) {
		t.Fatal("unadmitted reservation")
	}
}
func TestServiceArgvCapsAndGuardian(t *testing.T) {
	p := &Profile{Python: Pin{Path: "/usr/bin/python3"}, GuardianUnit: "owned.service"}
	a := strings.Join(serviceArgs(p, "/private/attempt", "mv-headless-test.service"), " ")
	for _, v := range []string{"--property=MemoryMax=512M", "--property=MemorySwapMax=0", "--property=CPUQuota=100%", "--property=TasksMax=64", "--property=BindsTo=owned.service", "--property=After=owned.service", "--property=KillMode=control-group", "--slice=newton-ia.slice", "-I -B"} {
		if !strings.Contains(a, v) {
			t.Fatal("missing", v)
		}
	}
}
func TestPinnedFileMutationAndAliasRefused(t *testing.T) {
	p := filepath.Join(t.TempDir(), "source")
	os.WriteFile(p, []byte("before"), 0600)
	h := sha256.Sum256([]byte("before"))
	pin := Pin{p, hex.EncodeToString(h[:])}
	if _, e := pinned(pin, 100); e != nil {
		t.Fatal(e)
	}
	os.WriteFile(p, []byte("after"), 0600)
	if _, e := pinned(pin, 100); e == nil {
		t.Fatal("mutation accepted")
	}
	alias := p + "-alias"
	os.Symlink(p, alias)
	if _, e := readRegular(alias, false, 100); e == nil {
		t.Fatal("symlink accepted")
	}
}
