package capsule

import (
	"context"
	"encoding/json"
	"metaviewer/daemon-adapter/internal/cli"
	"testing"
	"time"
)

func TestAutomaticLivenessFakeClock(t *testing.T) {
	for _, mode := range []string{"lost", "healthy", "transient", "unknown", "destroyed", "custom-threshold"} {
		t.Run(mode, func(t *testing.T) {
			m := testManager(t, &scriptRunner{output: []byte(startOK)})
			id := createID(t, m)
			if mode == "custom-threshold" {
				m.cfg.LivenessMisses = 3
			}
			if mode == "destroyed" {
				m.runner = &scriptRunner{output: []byte(`{"stopped":"srf-id-demo","removed_verified":true}`)}
				if _, err := m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`)); err != nil {
					t.Fatal(err)
				}
			}
			calls, reports := 0, 0
			m.runner = a2Runner(func(_ context.Context, args []string, _ []byte) ([]byte, error) {
				calls++
				if args[1] != "frame" || args[3] != "srf-id-demo" || args[5] != "w1" {
					t.Errorf("unbound probe %v", args)
				}
				if mode == "healthy" || mode == "transient" && calls == 2 {
					return []byte(`{}`), nil
				}
				if mode == "unknown" && calls == 2 {
					return nil, &cli.Fault{Code: "uncertain", Detail: "timeout"}
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
						t.Errorf("bad loss event %s", raw)
					}
					return nil
				})
			}()
			for i := 0; i < 3; i++ {
				ticks <- time.Time{}
			}
			close(ticks)
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			wantCalls, wantReports := 3, 0
			switch mode {
			case "lost":
				wantCalls, wantReports = 2, 1
			case "custom-threshold":
				wantReports = 1
			case "destroyed":
				wantCalls = 0
			}
			if calls != wantCalls || reports != wantReports {
				t.Fatalf("calls=%d reports=%d want %d/%d", calls, reports, wantCalls, wantReports)
			}
		})
	}
}

func TestAutomaticLossSettlesPendingInput(t *testing.T) {
	m := testManager(t, &scriptRunner{output: []byte(startOK)})
	id := createID(t, m)
	started := make(chan struct{})
	m.runner = a2Runner(func(ctx context.Context, args []string, _ []byte) ([]byte, error) {
		if args[1] == "input" {
			close(started)
			<-ctx.Done()
			return nil, ctx.Err()
		}
		return nil, cli.ExitFault("srf-identity-surface", 4, "")
	})
	inputDone := make(chan error, 1)
	go func() {
		_, err := m.Handle(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"lost-input","action":{"type":"key","keys":["a"]}}`))
		inputDone <- err
	}()
	awaitSignal(t, started)
	ticks := make(chan time.Time)
	done := make(chan error, 1)
	go func() {
		done <- m.monitorLiveness(context.Background(), ticks, func(context.Context, json.RawMessage) error { return nil })
	}()
	ticks <- time.Time{}
	ticks <- time.Time{}
	close(ticks)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := <-inputDone; err == nil {
		t.Fatal("lost input accepted")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.hasPending(id) {
		t.Fatal("lost input not settled")
	}
}

func TestLivenessCancellationAndDeliveryFailure(t *testing.T) {
	for _, cancelled := range []bool{true, false} {
		m := testManager(t, &scriptRunner{output: []byte(startOK)})
		createID(t, m)
		m.cfg.LivenessMisses = 1
		calls := 0
		m.runner = a2Runner(func(context.Context, []string, []byte) ([]byte, error) {
			calls++
			return nil, cli.ExitFault("srf-identity-surface", 4, "")
		})
		ctx, cancel := context.WithCancel(context.Background())
		ticks := make(chan time.Time, 1)
		ticks <- time.Time{}
		if cancelled {
			cancel()
		}
		err := m.monitorLiveness(ctx, ticks, func(context.Context, json.RawMessage) error { return context.DeadlineExceeded })
		cancel()
		if cancelled && (err != context.Canceled || calls != 0) {
			t.Fatalf("cancelled probe: %v calls=%d", err, calls)
		}
		if !cancelled && (err != context.DeadlineExceeded || calls != 1) {
			t.Fatalf("delivery failure: %v calls=%d", err, calls)
		}
	}
}

func TestLivenessConfiguration(t *testing.T) {
	base := testManager(t, &scriptRunner{}).cfg
	if base.LivenessInterval != 5*time.Second || base.LivenessMisses != 2 || base.LivenessTimeout <= 0 {
		t.Fatal("missing bounded defaults")
	}
	for _, kind := range []string{"interval", "misses", "timeout"} {
		cfg := base
		switch kind {
		case "interval":
			cfg.LivenessInterval = -time.Second
		case "misses":
			cfg.LivenessMisses = -1
		case "timeout":
			cfg.LivenessTimeout = -time.Second
		}
		if _, err := NewManager(cfg, &scriptRunner{}, func() uint64 { return 1 }); err == nil {
			t.Errorf("invalid %s admitted", kind)
		}
	}
}

func TestLivenessStopsAfterDestroy(t *testing.T) {
	m := testManager(t, &scriptRunner{output: []byte(startOK)})
	id := createID(t, m)
	probed := make(chan struct{})
	probes, reports := 0, 0
	m.runner = a2Runner(func(_ context.Context, args []string, _ []byte) ([]byte, error) {
		if args[1] == "stop" {
			return []byte(`{"stopped":"srf-id-demo","removed_verified":true}`), nil
		}
		probes++
		if probes == 1 {
			close(probed)
		}
		return nil, cli.ExitFault("srf-identity-surface", 4, "")
	})
	ticks := make(chan time.Time)
	done := make(chan error, 1)
	go func() {
		done <- m.monitorLiveness(context.Background(), ticks, func(context.Context, json.RawMessage) error { reports++; return nil })
	}()
	ticks <- time.Time{}
	awaitSignal(t, probed)
	if _, err := m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		ticks <- time.Time{}
	}
	close(ticks)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if probes != 1 || reports != 0 {
		t.Fatalf("destroyed capsule probed/reported: %d/%d", probes, reports)
	}
}

func TestLivenessProbeDropsLockAndSkipsDestroyedInFlight(t *testing.T) {
	m := testManager(t, &scriptRunner{output: []byte(startOK)})
	id := createID(t, m)
	m.cfg.LivenessMisses = 1
	probeStarted := make(chan struct{})
	releaseProbe := make(chan struct{})
	reports := 0
	m.runner = a2Runner(func(_ context.Context, args []string, _ []byte) ([]byte, error) {
		if args[1] == "stop" {
			return []byte(`{"stopped":"srf-id-demo","removed_verified":true}`), nil
		}
		close(probeStarted)
		<-releaseProbe
		return nil, cli.ExitFault("srf-identity-surface", 4, "")
	})
	ticks := make(chan time.Time)
	done := make(chan error, 1)
	go func() {
		done <- m.monitorLiveness(context.Background(), ticks, func(context.Context, json.RawMessage) error {
			reports++
			return nil
		})
	}()
	ticks <- time.Time{}
	awaitSignal(t, probeStarted)

	// While the liveness probe is blocked in m.execute, manager operations that
	// require m.mu (take_control, list, destroy) must complete without waiting.
	opDone := make(chan error, 1)
	go func() {
		if _, err := m.Handle(context.Background(), req("take_control", `{"surface_id":"`+id+`","owner":"human"}`)); err != nil {
			opDone <- err
			return
		}
		if _, err := m.Handle(context.Background(), req("list", `{}`)); err != nil {
			opDone <- err
			return
		}
		_, err := m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`))
		opDone <- err
	}()
	select {
	case err := <-opDone:
		if err != nil {
			t.Fatalf("concurrent manager ops during blocked liveness probe failed: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("manager operations blocked on in-flight liveness probe")
	}

	close(releaseProbe)
	close(ticks)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if reports != 0 || m.bindings[id].Surface.State != "destroyed" {
		t.Fatalf("in-flight probe double-transitioned destroyed surface: reports=%d state=%s", reports, m.bindings[id].Surface.State)
	}
}

func TestLivenessProbeUsesLivenessTimeoutAndCountsUnavailableMisses(t *testing.T) {
	m := testManager(t, &scriptRunner{output: []byte(startOK)})
	m.cfg.LivenessTimeout = 50 * time.Millisecond
	m.cfg.Timeout = 10 * time.Second
	m.cfg.LivenessMisses = 2
	id := createID(t, m)

	calls := 0
	reports := 0
	m.runner = a2Runner(func(probeCtx context.Context, args []string, _ []byte) ([]byte, error) {
		calls++
		deadline, ok := probeCtx.Deadline()
		if !ok {
			t.Error("liveness probe context missing deadline")
			return nil, &cli.Fault{Code: "uncertain", Detail: "no deadline"}
		}
		rem := time.Until(deadline)
		if rem <= 0 || rem > m.cfg.LivenessTimeout {
			t.Errorf("probe deadline remaining = %v, want within (0, %v] (Timeout=%v)", rem, m.cfg.LivenessTimeout, m.cfg.Timeout)
		}
		switch calls {
		case 1:
			// First unavailable miss (misses = 1).
			return nil, cli.ExitFault("srf-identity-surface", 4, "")
		case 2:
			// Negative control: non-unavailable error resets consecutive miss counter (misses = 0).
			return nil, &cli.Fault{Code: "uncertain", Detail: "transient non-unavailable"}
		default:
			// Calls 3 and 4: two consecutive unavailable misses declare liveness loss.
			return nil, cli.ExitFault("srf-identity-surface", 4, "")
		}
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

	// After 3 ticks (unavailable, uncertain, unavailable), surface must still be active with 0 loss reports.
	for i := 0; i < 3; i++ {
		ticks <- time.Time{}
	}
	// Tick 4 delivers the second consecutive unavailable fault and triggers loss.
	ticks <- time.Time{}
	close(ticks)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if calls != 4 || reports != 1 || m.bindings[id].Surface.State != "lost" {
		t.Fatalf("calls=%d reports=%d state=%s, want 4/1/lost", calls, reports, m.bindings[id].Surface.State)
	}
}
