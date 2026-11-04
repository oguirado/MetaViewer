package guestcommand

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type fakeInventory struct {
	actor           string
	pending, sealed int
	fail            bool
}

func (f *fakeInventory) Actor() string { return f.actor }
func (f *fakeInventory) ServicePending(string, string) error {
	f.pending++
	if f.fail {
		return errors.New("fsync failure")
	}
	return nil
}
func (f *fakeInventory) ServiceBound(string, string, string, string, uint64, uint64, int, string) error {
	return nil
}
func (f *fakeInventory) ServiceClosed(string) error { return nil }
func (f *fakeInventory) Unknown(string) error       { return nil }
func (f *fakeInventory) Seal() error                { f.sealed++; return nil }
func TestInventoryOwnerAndFirstCreateFence(t *testing.T) {
	m, _, _ := fixture(t)
	wrong := &fakeInventory{actor: "foreign"}
	if m.SetInventory(wrong) == nil {
		t.Fatal("foreign owner")
	}
	f := &fakeInventory{actor: m.profile.OwnerID, fail: true}
	if e := m.SetInventory(f); e != nil {
		t.Fatal(e)
	}
	m.child = nil
	m.profile.RuntimeRoot = t.TempDir()
	os.Chmod(m.profile.StateRoot, 0700)
	os.Chmod(m.profile.RuntimeRoot, 0700)
	path := filepath.Join(m.profile.StateRoot, "fixture-executable")
	os.WriteFile(path, []byte("inert fixture"), 0700)
	h := sha256.Sum256([]byte("inert fixture"))
	pin := Pin{path, hex.EncodeToString(h[:])}
	m.profile.Python = pin
	m.profile.Runner = pin

	m.profile.ConfigTemplate = json.RawMessage(`{"runtime_admitted":true}`)
	calls := 0
	m.factory = func(context.Context, *Profile, string, string) (process, error) {
		calls++
		return nil, errors.New("must not execute")
	}
	_, e := m.Handle(context.Background(), json.RawMessage(`{"schema":"guest_command_request/v0.2","request_id":"create-one","op":"create","params":{"profile_id":"guest-command-arm64-v1"}}`), m.sessionID, m.validate, m.emit)
	if e == nil || f.pending != 1 || calls != 0 {
		t.Fatalf("effect without journal: %v pending=%d calls=%d", e, f.pending, calls)
	}
	if e = m.Close(); e != nil {
		t.Fatal(e)
	}
	if f.sealed != 1 {
		t.Fatal("producer not sealed")
	}
}
