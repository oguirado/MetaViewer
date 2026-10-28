package capsule

import (
	"context"
	"encoding/json"
	"testing"
)

const lostSlotCreate = `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`

func TestLostSlotRequiresVerifiedDestroy(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	m.cfg.MaxSurfaces = 1
	id := createID(t, m)
	if _, err := m.MarkLost(id, true); err != nil {
		t.Fatal(err)
	}
	refuseCreate := func(params string) {
		t.Helper()
		n := len(r.calls)
		if _, err := m.Handle(context.Background(), req("create", params)); err == nil {
			t.Fatal("reserved profile or reused ID accepted")
		}
		if len(r.calls) != n {
			t.Fatal("refused create reached native CLI")
		}
	}
	refuseCreate(lostSlotCreate)
	refuseCreate(`{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1},"surface_id":"` + id + `"}`)
	// A different free profile must also be refused while the lost binding
	// occupies the sole capacity slot, independently of profile exclusivity.
	m.cfg.Profiles["other"] = m.cfg.Profiles["demo"]
	if _, err := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"other","geometry":{"w":2,"h":1}}`)); err == nil {
		t.Fatal("lost binding released capacity before destroy")
	} else {
		requireFault(t, err, "uncertain")
	}
	n := len(r.calls)
	if _, _, err := m.Capture(context.Background(), id); err == nil {
		t.Fatal("lost capture accepted")
	}
	if _, err := m.Handle(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"lost-slot","action":{"type":"key","keys":["Escape"]}}`)); err == nil {
		t.Fatal("lost input accepted")
	}
	if len(r.calls) != n {
		t.Fatal("lost access reached native CLI")
	}
	r.output = []byte(`{"stopped":"srf-id-demo","removed_verified":false}`)
	if _, err := m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`)); err == nil {
		t.Fatal("unverified destroy accepted")
	}
	refuseCreate(lostSlotCreate)
	r.output = []byte(`{"stopped":"srf-id-demo","removed_verified":true}`)
	out, err := m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`))
	var destroyed struct{ Data struct{ Surface Surface } }
	if err != nil || len(out) != 1 || json.Unmarshal(out[0], &destroyed) != nil || destroyed.Data.Surface.State != "destroyed" {
		t.Fatalf("destroy lost: %s %v", out, err)
	}
	if len(r.calls) != n+2 || r.calls[n][1] != "stop" || r.calls[n+1][1] != "stop" {
		t.Fatalf("destroy must run native stop: %v", r.calls)
	}
	// Create owns ID generation; even on a free profile the closed request
	// schema rejects an attempt to supply the tombstoned surface ID.
	refuseCreate(`{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1},"surface_id":"` + id + `"}`)
	r.output = []byte(startOK)
	replacement := createID(t, m)
	if replacement == id || m.bindings[id].Surface.State != "destroyed" {
		t.Fatal("replacement reused or erased the tombstone")
	}
	if m.bindings[replacement].Surface.State != "active" {
		t.Fatal("replacement is not active")
	}
}

func TestLostSlotConcurrentCreates(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	id := createID(t, m)
	if _, err := m.MarkLost(id, true); err != nil {
		t.Fatal(err)
	}
	r.output = []byte(`{"stopped":"srf-id-demo","removed_verified":true}`)
	if _, err := m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`)); err != nil {
		t.Fatal(err)
	}
	r.output = []byte(startOK)
	start := make(chan struct{})
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			<-start
			_, err := m.Handle(context.Background(), req("create", lostSlotCreate))
			results <- err
		}()
	}
	close(start)
	successes := 0
	for i := 0; i < 2; i++ {
		if err := <-results; err == nil {
			successes++
		} else {
			requireFault(t, err, "binding")
		}
	}
	if successes != 1 || len(r.calls) != 3 {
		t.Fatalf("successes=%d native calls=%v", successes, r.calls)
	}
}
