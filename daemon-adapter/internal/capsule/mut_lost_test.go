package capsule

import (
	"context"
	"encoding/json"
	"errors"
	"metaviewer/daemon-adapter/internal/cli"
	"testing"
	"time"
)

func TestProbeTimeoutAbsenceIsUnknownNeverMiss(t *testing.T) {
	// Mutation: daemon-adapter/internal/capsule/liveness.go:95 drop the
	// `probeErr == nil` conjunct so deadline-expired probes count absence as misses.
	m := testManager(t, &scriptRunner{output: []byte(startOK)})
	m.cfg.LivenessMisses = 2
	m.cfg.LivenessTimeout = 15 * time.Millisecond
	id := createID(t, m)

	calls := 0
	reports := 0
	proceedTick3 := make(chan struct{})
	m.runner = a2Runner(func(_ context.Context, _ []string, _ []byte) ([]byte, error) {
		calls++
		if calls <= 2 {
			time.Sleep(50 * time.Millisecond)
		} else if calls == 3 {
			<-proceedTick3
		}
		return nil, cli.ExitFault("srf-identity-surface", 4, "")
	})

	ticks := make(chan time.Time)
	done := make(chan error, 1)
	go func() {
		done <- m.monitorLiveness(context.Background(), ticks, func(_ context.Context, raw json.RawMessage) error {
			reports++
			var ev struct {
				Event string
				Data  struct{ Surface Surface }
			}
			if json.Unmarshal(raw, &ev) != nil || ev.Event != "state_changed" || ev.Data.Surface.State != "lost" || ev.Data.Surface.SurfaceID != id {
				t.Errorf("unexpected loss event: %s", raw)
			}
			return nil
		})
	}()

	// Two deadline-expired ticks: expect zero reports, binding still active.
	// Because ticks is unbuffered, the 3rd send only completes after tick 2 has fully finished.
	ticks <- time.Time{}
	ticks <- time.Time{}
	ticks <- time.Time{}

	m.mu.Lock()
	stateAfterTwo := m.bindings[id].Surface.State
	m.mu.Unlock()
	if reports != 0 || stateAfterTwo != "active" {
		close(proceedTick3)
		close(ticks)
		<-done
		t.Fatalf("after 2 timed-out absence probes: reports=%d state=%s, want 0/active", reports, stateAfterTwo)
	}

	// Follow with two immediate unavailable faults (tick 3 already in flight, then tick 4):
	// expect exactly one state_changed(lost).
	close(proceedTick3)
	ticks <- time.Time{}
	close(ticks)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	finalState := m.bindings[id].Surface.State
	m.mu.Unlock()
	if calls != 4 || reports != 1 || finalState != "lost" {
		t.Fatalf("calls=%d reports=%d state=%s, want 4/1/lost", calls, reports, finalState)
	}
}

func TestFailedLostDeliveryRollsRealBindingBackToActive(t *testing.T) {
	// Mutation: daemon-adapter/internal/capsule/liveness.go:108 pass `true` to
	// CompleteLost unconditionally so failed deliveries never roll back.
	m := testManager(t, &scriptRunner{output: []byte(startOK)})
	id := createID(t, m)
	m.cfg.LivenessMisses = 1

	m.runner = a2Runner(func(_ context.Context, _ []string, _ []byte) ([]byte, error) {
		return nil, cli.ExitFault("srf-identity-surface", 4, "")
	})

	emitErr := errors.New("simulated transport failure")
	waitEntered := make(chan struct{})
	waitUnblocked := make(chan error, 1)

	ticks1 := make(chan time.Time, 1)
	ticks1 <- time.Time{}
	err := m.monitorLiveness(context.Background(), ticks1, func(_ context.Context, _ json.RawMessage) error {
		go func() {
			waitCtx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			close(waitEntered)
			m.WaitLostDelivered(waitCtx, id)
			waitUnblocked <- waitCtx.Err()
		}()
		<-waitEntered
		return emitErr
	})
	if !errors.Is(err, emitErr) {
		t.Fatalf("monitorLiveness err = %v, want %v", err, emitErr)
	}
	if wErr := <-waitUnblocked; wErr != nil {
		t.Fatalf("WaitLostDelivered did not unblock cleanly: %v", wErr)
	}

	m.mu.Lock()
	b := m.bindings[id]
	m.mu.Unlock()
	if b.Surface.State != "active" || b.ConfirmedAbsent {
		t.Fatalf("binding after failed delivery: state=%s confirmedAbsent=%v, want active/false", b.Surface.State, b.ConfirmedAbsent)
	}

	// Next two [CITED] immediate unavailable ticks re-declare loss with one fresh event.
	m.cfg.LivenessMisses = 2
	reports := 0
	ticks2 := make(chan time.Time)
	done2 := make(chan error, 1)
	go func() {
		done2 <- m.monitorLiveness(context.Background(), ticks2, func(_ context.Context, raw json.RawMessage) error {
			reports++
			var ev struct {
				Event string
				Data  struct{ Surface Surface }
			}
			if json.Unmarshal(raw, &ev) != nil || ev.Event != "state_changed" || ev.Data.Surface.State != "lost" || ev.Data.Surface.SurfaceID != id {
				t.Errorf("unexpected loss event: %s", raw)
			}
			return nil
		})
	}()
	ticks2 <- time.Time{}
	ticks2 <- time.Time{}
	close(ticks2)
	if err := <-done2; err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	after := m.bindings[id]
	m.mu.Unlock()
	if reports != 1 || after.Surface.State != "lost" || !after.ConfirmedAbsent {
		t.Fatalf("after 2 unavailable ticks: reports=%d state=%s confirmedAbsent=%v, want 1/lost/true", reports, after.Surface.State, after.ConfirmedAbsent)
	}
}
