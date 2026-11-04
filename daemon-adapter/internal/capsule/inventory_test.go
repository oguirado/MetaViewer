package capsule

import (
	"context"
	"errors"
	"testing"
)

type fakeInventory struct {
	pending, bound, closed, unknown          int
	refusePending, refuseBound, refuseClosed bool
	runner                                   *scriptRunner
}

func (f *fakeInventory) Pending(string, string, string, string) error {
	f.pending++
	if len(f.runner.calls) != 0 {
		panic("effect preceded pending")
	}
	if f.refusePending {
		return errors.New("pending fsync")
	}
	return nil
}
func (f *fakeInventory) Bound(context.Context, string, string, string) error {
	f.bound++
	if len(f.runner.calls) == 0 {
		panic("no native effect")
	}
	if f.refuseBound {
		return errors.New("wrong image")
	}
	return nil
}
func (f *fakeInventory) Closed(context.Context, string) error {
	f.closed++
	if f.refuseClosed {
		return errors.New("CID still live")
	}
	return nil
}
func (f *fakeInventory) Unknown(string) error { f.unknown++; return nil }
func TestInventoryPendingPrecedesNativeEffect(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	f := &fakeInventory{runner: r, refusePending: true}
	m.cfg.Inventory = f
	if _, e := m.Handle(context.Background(), req("create", createDemo)); e == nil {
		t.Fatal("pending refused but created")
	}
	if len(r.calls) != 0 || f.pending != 1 || f.bound != 0 {
		t.Fatal("effect before durable reservation")
	}
}
func TestInventoryBindingRefusalNeverPublishesReady(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	f := &fakeInventory{runner: r, refuseBound: true}
	m.cfg.Inventory = f
	if out, e := m.Handle(context.Background(), req("create", createDemo)); e == nil || len(out) != 0 {
		t.Fatal("wrong image readiness")
	}
	if f.bound != 1 || f.unknown == 0 || len(m.bindings) != 0 {
		t.Fatal("binding not retained uncertain")
	}
}
func TestInventoryClosureGatePreventsDestroyedRelease(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	f := &fakeInventory{runner: r}
	m.cfg.Inventory = f
	id := createID(t, m)
	r.output = []byte(`{"stopped":"srf-id-demo","removed_verified":true}`)
	f.refuseClosed = true
	if out, e := m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`)); e == nil || len(out) != 0 {
		t.Fatal("unverified closure released")
	}
	if f.closed != 1 {
		t.Fatal("closure missing")
	}
}
