package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/capsule/slots"
	"metaviewer/daemon-adapter/internal/ipc"
	"os"
	"sync"
	"testing"
	"time"
)

type slowSlotStore struct {
	entered, release chan struct{}
	reconciled       bool
}

func (s *slowSlotStore) Save(ctx context.Context, r slots.Request) (slots.Manifest, error) {
	close(s.entered)
	select {
	case <-s.release:
		return slots.Manifest{Generation: 1, PayloadSHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, nil
	case <-ctx.Done():
		return slots.Manifest{}, ctx.Err()
	}
}
func (s *slowSlotStore) Load(context.Context, slots.Request) (slots.Manifest, error) {
	return slots.Manifest{}, errors.New("unused")
}
func (s *slowSlotStore) Select(context.Context, string) (slots.Manifest, error) {
	return slots.Manifest{}, errors.New("unused")
}
func (s *slowSlotStore) List(context.Context, string) ([]slots.Entry, error) {
	return []slots.Entry{}, nil
}
func (s *slowSlotStore) Delete(context.Context, slots.Request) error { return nil }
func (s *slowSlotStore) Provision(context.Context, string) error     { return nil }
func (s *slowSlotStore) ReconcileAll(context.Context) error          { s.reconciled = true; return nil }
func TestSlowSlotSaveDoesNotBlockCaptureAndRefusesAgent(t *testing.T) {
	root, e := os.MkdirTemp("/dev/shm", "mv-slots-async-")
	if e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(root)
	store := &slowSlotStore{entered: make(chan struct{}), release: make(chan struct{})}
	m, e := capsule.NewManager(capsule.Config{Slots: store, BinDir: t.TempDir(), Profiles: map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 3, Height: 2}}, MaxSurfaces: 2, MaxOutputBytes: 8192, Timeout: time.Second, OriginNS: 100}, shrinkingWindowRunner{root}, func() uint64 { return 200 })
	if e != nil {
		t.Fatal(e)
	}
	if !store.reconciled {
		t.Fatal("adapter startup missed reconciliation")
	}
	created, e := m.Handle(context.Background(), capsule.Request{Schema: "surface_request/v0.2", Op: "create", Params: json.RawMessage(`{"kind":"browser","profile_id":"demo","geometry":{"w":3,"h":2}}`)})
	if e != nil {
		t.Fatal(e)
	}
	var event struct {
		Data struct {
			Surface capsule.Surface `json:"surface"`
		}
	}
	if e = json.Unmarshal(created[0], &event); e != nil {
		t.Fatal(e)
	}
	envelope := ipc.Envelope{From: ipc.Endpoint{Component: "agent"}, Body: json.RawMessage(`{"schema":"capsule_state_request/v0.2","operation_id":"slot-op","op":"save","profile_id":"other-profile","slot_id":"slot-one","credential_copy_confirmed":true}`)}
	if _, e = dispatchState(context.Background(), m, envelope); e == nil {
		t.Fatal("agent bypassed core")
	}
	envelope.From.Component = "core"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	emitted := make(chan json.RawMessage, 1)
	ctx = context.WithValue(ctx, streamKey{}, streamSession{ctx: ctx, work: &sync.Mutex{}, emit: func(_ context.Context, b json.RawMessage) error { emitted <- b; return nil }})
	if out, e := dispatchState(ctx, m, envelope); e != nil || len(out) != 0 {
		t.Fatal("save blocked dispatch", out, e)
	}
	select {
	case <-store.entered:
	case <-time.After(time.Second):
		t.Fatal("save never started")
	}
	captured := make(chan error, 1)
	go func() { _, _, e := m.Capture(ctx, event.Data.Surface.SurfaceID); captured <- e }()
	select {
	case e := <-captured:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(time.Second):
		t.Fatal("slow save blocked another surface capture")
	}
	close(store.release)
	select {
	case b := <-emitted:
		var result map[string]any
		if json.Unmarshal(b, &result) != nil || result["event"] != "completed" {
			t.Fatal(string(b))
		}
	case <-time.After(time.Second):
		t.Fatal("no completion")
	}
}

func (s *slowSlotStore) AcquireStopped(context.Context, slots.Request) (func(), error) {
	return func() {}, nil
}
