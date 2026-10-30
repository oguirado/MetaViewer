package capsule

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"metaviewer/daemon-adapter/internal/cli"
)

func TestLoginBlocksAgentButAllowsHumanInput(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	ctx := context.Background()
	if _, err := m.Handle(ctx, req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`)); err != nil {
		t.Fatal(err)
	}
	var id string
	for key := range m.bindings {
		id = key
		binding := m.bindings[key]
		binding.Surface.Control = "agent"
		m.bindings[key] = binding
	}
	m.cfg.View = &gatedViewBackend{}
	if _, err := m.Handle(ctx, req("login", `{"surface_id":"`+id+`"}`)); err != nil {
		t.Fatal(err)
	}
	calls := len(r.calls)
	for _, origin := range []string{``, `,"origin":"agent"`} {
		_, err := m.Handle(ctx, req("input", `{"surface_id":"`+id+`","proposal_id":"blocked"`+origin+`,"action":{"type":"type","text":"fixture"}}`))
		var f *cli.Fault
		if !errors.As(err, &f) || f.Code != "LOGIN_ACTIVE" || len(r.calls) != calls {
			t.Fatalf("agent typing escaped login lock: %v", err)
		}
	}
	if _, err := m.Handle(ctx, req("take_control", `{"surface_id":"`+id+`","owner":"human"}`)); err != nil {
		t.Fatal(err)
	}
	r.output = []byte(`{"surface_id":"w1","kind":"text","input_mono_ns":200,"focus_verified":true,"result":"ok"}`)
	if _, err := m.Handle(ctx, req("input", `{"surface_id":"`+id+`","proposal_id":"human-input","origin":"human","action":{"type":"type","text":"fixture"}}`)); err != nil {
		t.Fatalf("operator input refused: %v", err)
	}
	if _, err := m.Handle(ctx, req("view-stop", `{"surface_id":"`+id+`"}`)); err != nil {
		t.Fatal(err)
	}
	if err := m.refuseLoginInput("srf-id-demo"); err != nil {
		t.Fatal("verified view stop did not unlock", err)
	}
}

func TestLoginLockExistsBeforeOpenReturns(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	ctx := context.Background()
	if _, err := m.Handle(ctx, req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`)); err != nil {
		t.Fatal(err)
	}
	var id string
	for key := range m.bindings {
		id = key
	}
	v := &gatedViewBackend{openStarted: make(chan struct{}), releaseOpen: make(chan struct{})}
	m.cfg.View = v
	done := make(chan error, 1)
	go func() {
		_, err := m.Handle(ctx, req("login", `{"surface_id":"`+id+`"}`))
		done <- err
	}()
	<-v.openStarted
	_, err := m.Handle(ctx, req("input", `{"surface_id":"`+id+`","proposal_id":"opening","action":{"type":"type","text":"fixture"}}`))
	close(v.releaseOpen)
	if openErr := <-done; openErr != nil {
		t.Fatal(openErr)
	}
	var f *cli.Fault
	if !errors.As(err, &f) || f.Code != "LOGIN_ACTIVE" {
		t.Fatalf("opening race admitted agent: %v", err)
	}
}

func TestNativeLoginRegistrationAndPendingLock(t *testing.T) {
	state := t.TempDir()
	if err := os.Chmod(state, 0700); err != nil {
		t.Fatal(err)
	}
	views := filepath.Join(state, "views")
	if err := os.Mkdir(views, 0700); err != nil {
		t.Fatal(err)
	}
	r := &ProcessRunner{stateDir: state, stat: stateDirInfo}
	m := testManager(t, &scriptRunner{})
	m.runner = r
	for _, suffix := range []string{".pid", ".login-pending"} {
		path := filepath.Join(views, "srf-id-demo"+suffix)
		if err := os.WriteFile(path, []byte("123\n"), 0600); err != nil {
			t.Fatal(err)
		}
		if active, err := r.LoginActive("srf-id-demo"); err != nil || !active {
			t.Fatalf("native login unobserved: %v", err)
		}
		if err := m.refuseLoginInput("srf-id-demo"); err == nil {
			t.Fatal("manager ignored native login registration")
		}
		if active, err := r.LoginActive("srf-id-other"); err != nil || active {
			t.Fatalf("another container was locked: %v", err)
		}
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
	}
	if active, err := r.LoginActive("srf-id-demo"); err != nil || active {
		t.Fatalf("absent registration locked input: %v", err)
	}
}

func TestLoginLocksClearedAfterDestroyAndBindingMismatch(t *testing.T) {
	for _, transition := range []string{"destroy-open", "destroy-opening", "lost-opening", "binding-change"} {
		t.Run(transition, func(t *testing.T) {
			r := &scriptRunner{output: []byte(startOK)}
			m := testManager(t, r)
			id := createID(t, m)
			v := &gatedViewBackend{}
			m.cfg.View = v
			if transition == "destroy-open" {
				if _, err := m.Handle(context.Background(), req("login", `{"surface_id":"`+id+`"}`)); err != nil {
					t.Fatal(err)
				}
				if !m.loginLocks["srf-id-demo"] {
					t.Fatal("login did not lock agent admission")
				}
				r.output = []byte(`{"stopped":"srf-id-demo","removed_verified":true}`)
				if _, err := m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`)); err != nil {
					t.Fatal(err)
				}
			} else {
				v.openStarted, v.releaseOpen = make(chan struct{}), make(chan struct{})
				done := make(chan error, 1)
				go func() {
					_, err := m.Handle(context.Background(), req("login", `{"surface_id":"`+id+`"}`))
					done <- err
				}()
				awaitSignal(t, v.openStarted)
				if transition == "destroy-opening" {
					r.output = []byte(`{"stopped":"srf-id-demo","removed_verified":true}`)
					if _, err := m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`)); err != nil {
						t.Fatal(err)
					}
				} else if transition == "lost-opening" {
					if _, err := m.MarkLost(id, true); err != nil {
						t.Fatal(err)
					}
				} else {
					m.mu.Lock()
					b := m.bindings[id]
					b.RunID = "replacement"
					m.bindings[id] = b
					m.mu.Unlock()
				}
				close(v.releaseOpen)
				requireFault(t, <-done, "surface")
			}
			if m.loginLocks["srf-id-demo"] || m.views["srf-id-demo"] {
				t.Fatalf("terminal binding retained login/view state: locks=%v views=%v", m.loginLocks, m.views)
			}
		})
	}
}

type uncertainLoginStop struct{ gatedViewBackend }

func (v *uncertainLoginStop) Stop(context.Context, string) error {
	return errors.New("unverified teardown")
}

func TestLoginBindingMismatchKeepsLockOnUncertainStop(t *testing.T) {
	m := testManager(t, &scriptRunner{output: []byte(startOK)})
	id := createID(t, m)
	v := &uncertainLoginStop{gatedViewBackend{openStarted: make(chan struct{}), releaseOpen: make(chan struct{})}}
	m.cfg.View = v
	done := make(chan error, 1)
	go func() {
		_, err := m.Handle(context.Background(), req("login", `{"surface_id":"`+id+`"}`))
		done <- err
	}()
	awaitSignal(t, v.openStarted)
	if _, err := m.MarkLost(id, true); err != nil {
		t.Fatal(err)
	}
	close(v.releaseOpen)
	requireFault(t, <-done, "surface")
	if !m.loginLocks["srf-id-demo"] {
		t.Fatal("uncertain native stop released login lock")
	}
}
