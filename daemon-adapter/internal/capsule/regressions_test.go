package capsule

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"metaviewer/daemon-adapter/internal/cli"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const createDemo = `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`

func createID(t *testing.T, m *Manager) string {
	t.Helper()
	out, e := m.Handle(context.Background(), req("create", createDemo))
	if e != nil {
		t.Fatal(e)
	}
	var ev struct {
		Data struct {
			Surface Surface `json:"surface"`
		} `json:"data"`
	}
	if e = json.Unmarshal(out[0], &ev); e != nil {
		t.Fatal(e)
	}
	return ev.Data.Surface.SurfaceID
}
func requireFault(t *testing.T, e error, code string) {
	t.Helper()
	var f *cli.Fault
	if !errors.As(e, &f) || f.Code != code {
		t.Fatalf("expected %s, got %v", code, e)
	}
}
func TestCapacityReusedAfterVerifiedDestroy(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	m.cfg.MaxSurfaces = 1
	first := createID(t, m)
	if _, e := m.Handle(context.Background(), req("create", createDemo)); e == nil {
		t.Fatal("active capacity bypassed")
	}
	r.output = []byte(`{"stopped":"srf-id-demo","removed_verified":true}`)
	if _, e := m.Handle(context.Background(), req("destroy", `{"surface_id":"`+first+`"}`)); e != nil {
		t.Fatal(e)
	}
	r.output = []byte(startOK)
	second := createID(t, m)
	if first == second {
		t.Fatal("identity reused")
	}
}
func holdingsBinding(m *Manager) string {
	const id = "holdings"
	p := m.cfg.Profiles["demo"]
	p.NativeKind = "holdings"
	p.Kind = "game_capsule"
	m.cfg.Profiles["demo"] = p
	m.bindings[id] = Binding{Surface: Surface{SurfaceID: id, ProfileID: "demo", State: "active", Control: "agent", Geometry: Geometry{2, 1}}, NativeKind: "holdings", Container: "srf-ng-hcap-hc-0123456789ab-1"}
	return id
}
func TestHoldingsRefusedReceipt(t *testing.T) {
	r := &scriptRunner{output: []byte(`{"input_mono_ns":200,"result":"refused"}`)}
	m := testManager(t, r)
	id := holdingsBinding(m)
	out, e := m.Handle(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"p1","action":{"type":"key","keys":["a"]}}`))
	requireFault(t, e, "refused")
	if len(out) != 0 {
		t.Fatal("refusal emitted input_applied")
	}
}
func TestHoldingsRemovalRequiresProof(t *testing.T) {
	r := &scriptRunner{output: []byte(`{"stopped":"srf-ng-hcap-hc-0123456789ab-1","removed_verified":false}`)}
	m := testManager(t, r)
	id := holdingsBinding(m)
	out, e := m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`))
	if e == nil || len(out) != 0 || m.bindings[id].Surface.State == "destroyed" {
		t.Fatal("unverified holdings removal committed")
	}
}
func TestPreSpawnPermissionRetry(t *testing.T) {
	state, logs := t.TempDir(), t.TempDir()
	if e := os.Chmod(state, 0755); e != nil {
		t.Fatal(e)
	}
	r, binary := stateRunner(t, state, "SRF_IDENTITY_STORE_ROOT="+logs)
	m := testManager(t, &scriptRunner{})
	m.runner = r
	m.cfg.BinDir = filepath.Dir(binary)
	_, e := m.Handle(context.Background(), req("create", createDemo))
	requireFault(t, e, "configuration")
	if _, e = os.Stat(filepath.Join(logs, "cli-calls.jsonl")); !os.IsNotExist(e) {
		t.Fatal("pre-spawn refusal invoked CLI")
	}
	if e = os.Chmod(state, 0700); e != nil {
		t.Fatal(e)
	}
	createID(t, m)
	data, e := os.ReadFile(filepath.Join(logs, "cli-calls.jsonl"))
	if e != nil || bytes.Count(data, []byte("\n")) != 1 {
		t.Fatalf("expected exactly one start: %s %v", data, e)
	}
}
func TestDestroyValidatesBeforeDrain(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	calls := 0
	m.cfg.BeforeDestroy = func(context.Context, string) error { calls++; return nil }
	_, e := m.Handle(context.Background(), req("destroy", `{"surface_id":"unknown"}`))
	requireFault(t, e, "surface")
	if calls != 0 {
		t.Fatal("unknown destroy drained subscriptions")
	}
	id := createID(t, m)
	r.output = []byte(`{"stopped":"srf-id-demo","removed_verified":true}`)
	if _, e = m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`)); e != nil || calls != 1 {
		t.Fatalf("valid drain: %v", e)
	}
}
func TestTakeControlSupported(t *testing.T) {
	m := testManager(t, &scriptRunner{output: []byte(startOK)})
	id := createID(t, m)
	out, e := m.Handle(context.Background(), req("take_control", `{"surface_id":"`+id+`","owner":"human"}`))
	if e != nil || len(out) != 1 {
		t.Fatalf("take_control: %v", e)
	}
	_, e = m.Handle(context.Background(), req("take_control", `{"surface_id":"`+id+`","owner":"human"}`))
	requireFault(t, e, "POLICY")
}

func TestConfigurationFaultAloneDoesNotProveNoSpawn(t *testing.T) {
	r := &scriptRunner{err: fault("configuration", "runner has not proved no native effects")}
	m := testManager(t, r)
	_, e := m.Handle(context.Background(), req("create", createDemo))
	requireFault(t, e, "configuration")
	r.err = nil
	r.output = []byte(startOK)
	_, e = m.Handle(context.Background(), req("create", createDemo))
	requireFault(t, e, "uncertain")
	if len(r.calls) != 1 {
		t.Fatal("unproven pre-spawn error retried")
	}
}

func TestPreSpawnMissingAndNonExecutableBinaryRetry(t *testing.T) {
	binDir, stateDir := t.TempDir(), t.TempDir()
	if e := os.Chmod(stateDir, 0700); e != nil {
		t.Fatal(e)
	}
	r, e := NewProcessRunner(binDir, []string{"PATH=/usr/bin:/bin", "MV_SRF_STATE_DIR=" + stateDir}, 8192, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	m := testManager(t, &scriptRunner{})
	m.runner = r
	m.cfg.BinDir = binDir

	// 1. Missing binary (ENOENT before fork/exec) clears quarantine.
	_, e = m.Handle(context.Background(), req("create", createDemo))
	requireFault(t, e, "execution")
	if m.quarantined["demo"] {
		t.Fatal("missing binary latched profile quarantine")
	}

	// 2. Non-executable binary (EACCES before fork/exec) also clears quarantine.
	binPath := filepath.Join(binDir, "srf-identity-surface")
	script := "#!/bin/sh\necho '" + startOK + "'\n"
	if e = os.WriteFile(binPath, []byte(script), 0600); e != nil {
		t.Fatal(e)
	}
	_, e = m.Handle(context.Background(), req("create", createDemo))
	requireFault(t, e, "execution")
	if m.quarantined["demo"] {
		t.Fatal("non-executable binary latched profile quarantine")
	}

	// 3. Repairing permissions allows the retry to succeed once.
	if e = os.Chmod(binPath, 0700); e != nil {
		t.Fatal(e)
	}
	id := createID(t, m)
	if m.bindings[id].Surface.State != "active" || m.quarantined["demo"] {
		t.Fatalf("repaired binary create failed: %+v", m.bindings[id])
	}

	// 4. Negative control: a post-start child failure (process spawned and exited non-zero)
	// must NOT be classified as preSpawnRefusal and must keep the profile quarantined.
	m.cfg.Profiles["crash"] = m.cfg.Profiles["demo"]
	crashScript := "#!/bin/sh\nexit 1\n"
	if e = os.WriteFile(binPath, []byte(crashScript), 0700); e != nil {
		t.Fatal(e)
	}
	_, e = m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"crash","geometry":{"w":2,"h":1}}`))
	requireFault(t, e, "invalid_exit")
	if !m.quarantined["crash"] {
		t.Fatal("post-start crash cleared quarantine")
	}
	if e = os.WriteFile(binPath, []byte(script), 0700); e != nil {
		t.Fatal(e)
	}
	_, e = m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"crash","geometry":{"w":2,"h":1}}`))
	requireFault(t, e, "uncertain")
}
