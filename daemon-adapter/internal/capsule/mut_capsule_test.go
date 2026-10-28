package capsule

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// Kills M5: Capture validation conjunct dropped (daemon-adapter/internal/capsule/manager.go:675-684).
func TestMutantM5CaptureRejectsSingleFieldForgeries(t *testing.T) {
	t.Run("windowed surface single-field forgeries", func(t *testing.T) {
		r := &scriptRunner{output: []byte(`{"container":"srf-id-demo","run_id":"demo-run","windows":[{"id":"w1","x":0,"y":0,"w":4,"h":3,"title":"","url":""}]}`)}
		m := testManager(t, r)
		p := m.cfg.Profiles["demo"]
		p.Width, p.Height = 4, 3
		m.cfg.Profiles["demo"] = p

		if _, err := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":4,"h":3}}`)); err != nil {
			t.Fatal(err)
		}
		var id string
		var b Binding
		for k, v := range m.bindings {
			id = k
			b = v
		}

		validFrame := func() NativeFrame {
			return NativeFrame{
				Path:          b.FramesRoot + "/f.png",
				Seq:           1,
				SHA256RGB24:   strings.Repeat("a", 64),
				Width:         4,
				Height:        3,
				CaptureMonoNS: 200,
				Generation:    b.Container,
				Window:        &Window{ID: "w1", W: 4, H: 3},
			}
		}

		// Negative control: valid windowed capture succeeds.
		r.output, _ = json.Marshal(validFrame())
		if _, got, err := m.Capture(context.Background(), id); err != nil || got.Seq != 1 || got.TSNS != 100 {
			t.Fatalf("negative control failed: valid windowed capture rejected: got=%+v err=%v", got, err)
		}

		cases := []struct {
			name   string
			mutate func(*NativeFrame)
		}{
			{
				name:   "Seq == 0 refused",
				mutate: func(f *NativeFrame) { f.Seq = 0 },
			},
			{
				name:   "Generation != b.Container refused",
				mutate: func(f *NativeFrame) { f.Generation = "srf-id-other" },
			},
			{
				name:   "Width < 1 refused",
				mutate: func(f *NativeFrame) { f.Width = 0; f.Window.W = 0 },
			},
			{
				name:   "Height < 1 refused",
				mutate: func(f *NativeFrame) { f.Height = 0; f.Window.H = 0 },
			},
			{
				name:   "Width > Geometry.W refused",
				mutate: func(f *NativeFrame) { f.Width = 5; f.Window.W = 5 },
			},
			{
				name:   "Height > Geometry.H refused",
				mutate: func(f *NativeFrame) { f.Height = 4; f.Window.H = 4 },
			},
			{
				name:   "non-hex digest refused",
				mutate: func(f *NativeFrame) { f.SHA256RGB24 = strings.Repeat("g", 64) },
			},
			{
				name:   "short digest refused",
				mutate: func(f *NativeFrame) { f.SHA256RGB24 = strings.Repeat("a", 63) },
			},
			{
				name:   "path outside FramesRoot refused",
				mutate: func(f *NativeFrame) { f.Path = "/dev/shm/other/f.png" },
			},
			{
				name:   "CaptureMonoNS < OriginNS refused",
				mutate: func(f *NativeFrame) { f.CaptureMonoNS = 99 },
			},
			{
				name:   "CaptureMonoNS < before refused",
				mutate: func(f *NativeFrame) { f.CaptureMonoNS = 150 },
			},
			{
				name:   "CaptureMonoNS > after refused",
				mutate: func(f *NativeFrame) { f.CaptureMonoNS = 201 },
			},
			{
				name:   "windowed binding with nil Window refused",
				mutate: func(f *NativeFrame) { f.Window = nil },
			},
			{
				name:   "windowed binding with wrong Window.ID refused",
				mutate: func(f *NativeFrame) { f.Window.ID = "w2" },
			},
			{
				name:   "windowed binding with Window.W != Width within bounds refused",
				mutate: func(f *NativeFrame) { f.Width = 3; f.Window.W = 4 },
			},
			{
				name:   "windowed binding with Window.H != Height within bounds refused",
				mutate: func(f *NativeFrame) { f.Height = 2; f.Window.H = 3 },
			},
		}

		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				m.clock = func() uint64 { return 200 }
				f := validFrame()
				winCopy := *f.Window
				f.Window = &winCopy
				tc.mutate(&f)
				r.output, _ = json.Marshal(f)
				if _, _, err := m.Capture(context.Background(), id); err == nil {
					t.Fatalf("expected Capture to refuse %s, but it succeeded", tc.name)
				}
				// Verify failed capture did not corrupt stored geometry.
				if gotGeom := m.bindings[id].Surface.Geometry; gotGeom != (Geometry{W: 4, H: 3}) {
					t.Fatalf("failed capture mutated binding geometry to %+v", gotGeom)
				}
			})
		}

		// Dedicated test for `after < before` clock-rewind conjunct when `CaptureMonoNS`
		// would otherwise satisfy `CaptureMonoNS >= before` and `CaptureMonoNS <= after`?
		// Note: if after < before, no uint64 can satisfy both CaptureMonoNS >= before AND CaptureMonoNS <= after.
		//Wait: what if `CaptureMonoNS < before` or `CaptureMonoNS > after` is dropped, or we test clock rewind directly?
		t.Run("clock rewind after < before refused", func(t *testing.T) {
			calls := 0
			m.clock = func() uint64 {
				calls++
				if calls == 1 {
					return 300 // before
				}
				return 250 // after < before
			}
			f := validFrame()
			f.CaptureMonoNS = 275
			r.output, _ = json.Marshal(f)
			if _, _, err := m.Capture(context.Background(), id); err == nil {
				t.Fatal("expected clock rewind (after < before) to be refused")
			}
		})
	})

	t.Run("windowless binding single-field forgeries", func(t *testing.T) {
		r := &scriptRunner{}
		m := testManager(t, r)
		id := holdingsBinding(m)
		b := m.bindings[id]
		b.FramesRoot = "/dev/shm/holdings/frames"
		b.Surface.Geometry = Geometry{W: 4, H: 3}
		m.bindings[id] = b

		validWindowless := func() NativeFrame {
			return NativeFrame{
				Path:          b.FramesRoot + "/f.png",
				Seq:           1,
				SHA256RGB24:   strings.Repeat("b", 64),
				Width:         4,
				Height:        3,
				CaptureMonoNS: 200,
				Generation:    b.Container,
				Window:        nil,
			}
		}

		// Negative control: exact windowless capture succeeds.
		r.output, _ = json.Marshal(validWindowless())
		if _, got, err := m.Capture(context.Background(), id); err != nil || got.Width != 4 || got.Height != 3 {
			t.Fatalf("negative control failed: valid windowless capture rejected: got=%+v err=%v", got, err)
		}

		for _, tc := range []struct {
			name   string
			mutate func(*NativeFrame)
		}{
			{
				name:   "windowless binding with non-nil stray Window refused",
				mutate: func(f *NativeFrame) { f.Window = &Window{ID: "w1", W: 4, H: 3} },
			},
			{
				name:   "windowless binding with Width < Geometry.W refused",
				mutate: func(f *NativeFrame) { f.Width = 3 },
			},
			{
				name:   "windowless binding with Height < Geometry.H refused",
				mutate: func(f *NativeFrame) { f.Height = 2 },
			},
		} {
			t.Run(tc.name, func(t *testing.T) {
				f := validWindowless()
				tc.mutate(&f)
				r.output, _ = json.Marshal(f)
				if _, _, err := m.Capture(context.Background(), id); err == nil {
					t.Fatalf("expected windowless Capture to refuse %s, but it succeeded", tc.name)
				}
			})
		}
	})
}

// Kills M6: Lost rollback ignores destroying & WaitLostDelivered timeout (daemon-adapter/internal/capsule/manager.go:732-760).
func TestMutantM6CompleteLostHonorsDestroyingAndWaitLostDeliveredTimeout(t *testing.T) {
	t.Run("CompleteLost undelivered outside destroying rolls back to active (negative control)", func(t *testing.T) {
		m := testManager(t, &scriptRunner{output: []byte(startOK)})
		id := createID(t, m)

		ev, err := m.BeginMarkLost(id)
		if err != nil || len(ev) == 0 {
			t.Fatalf("BeginMarkLost failed: ev=%s err=%v", ev, err)
		}
		m.CompleteLost(id, false)

		m.mu.Lock()
		b := m.bindings[id]
		m.mu.Unlock()
		if b.Surface.State != "active" || b.ConfirmedAbsent {
			t.Fatalf("negative control failed: expected rollback to active/false outside destroying, got state=%s confirmedAbsent=%v", b.Surface.State, b.ConfirmedAbsent)
		}
	})

	t.Run("CompleteLost undelivered during destroying keeps surface lost with ConfirmedAbsent", func(t *testing.T) {
		m := testManager(t, &scriptRunner{output: []byte(startOK)})
		id := createID(t, m)

		ev, err := m.BeginMarkLost(id)
		if err != nil || len(ev) == 0 {
			t.Fatalf("BeginMarkLost failed: ev=%s err=%v", ev, err)
		}

		// Simulate surface entering destroy while lost delivery is in flight.
		m.mu.Lock()
		m.destroying[id] = true
		m.mu.Unlock()

		waitDone := make(chan struct{})
		go func() {
			m.WaitLostDelivered(context.Background(), id)
			close(waitDone)
		}()

		m.CompleteLost(id, false)
		select {
		case <-waitDone:
		case <-time.After(time.Second):
			t.Fatal("CompleteLost did not close lostDone channel")
		}

		m.mu.Lock()
		b := m.bindings[id]
		m.mu.Unlock()
		if b.Surface.State != "lost" || !b.ConfirmedAbsent {
			t.Fatalf("CompleteLost during destroying revived surface: state=%s confirmedAbsent=%v, want lost/true", b.Surface.State, b.ConfirmedAbsent)
		}
	})

	t.Run("WaitLostDelivered returns on context expiry when lost delivery never completes", func(t *testing.T) {
		m := testManager(t, &scriptRunner{output: []byte(startOK)})
		id := createID(t, m)

		// When no lost delivery is tracked, WaitLostDelivered returns immediately.
		m.WaitLostDelivered(context.Background(), id)

		// Start tracked lost delivery and never call CompleteLost; expired ctx must unblock WaitLostDelivered.
		if _, err := m.BeginMarkLost(id); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()

		done := make(chan struct{})
		go func() {
			m.WaitLostDelivered(ctx, id)
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("WaitLostDelivered hung after context cancellation")
		}

		// Clean up in-flight lost tracking.
		m.CompleteLost(id, true)
	})
}
