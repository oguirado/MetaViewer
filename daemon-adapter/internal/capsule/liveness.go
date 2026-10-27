package capsule

// [TARGET, unit decision] No native liveness reply is admitted. Use the existing
// bounded frame verb without publishing or reading pixels. Only its typed
// unavailable result counts as a miss; deadlines/malformed/setup errors are
// unknown, break the consecutive-miss sequence and never prove loss.
// Defaults [TARGET]: interval 5s, consecutive misses 2; one serial probe per
// active capsule per tick, no overlapping sweeps or catch-up loop. Terminal
// bindings are not probed. The session owns cancellation and event delivery.
import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"metaviewer/daemon-adapter/internal/cli"
)

// MonitorLiveness runs until session cancellation or delivery failure. emit must
// preserve transport ordering. A failed delivery ends the session, not a retry
// that could announce the same transition twice.
func (m *Manager) MonitorLiveness(ctx context.Context, emit func(context.Context, json.RawMessage) error) error {
	if m.cfg.LivenessInterval <= 0 || emit == nil {
		return fault("configuration", "configured liveness monitor required")
	}
	ticker := time.NewTicker(m.cfg.LivenessInterval)
	defer ticker.Stop()
	return m.monitorLiveness(ctx, ticker.C, emit)
}

// The tick channel is the fake-clock seam; production owns a stopped ticker.
func (m *Manager) monitorLiveness(ctx context.Context, ticks <-chan time.Time, emit func(context.Context, json.RawMessage) error) error {
	misses := map[string]int{}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case _, ok := <-ticks:
			if !ok {
				return nil
			}
		}
		m.mu.Lock()
		active := make([]Binding, 0, len(m.bindings))
		for id, b := range m.bindings {
			if b.Surface.State == "active" && !m.destroying[id] {
				active = append(active, b)
			} else {
				delete(misses, id)
			}
		}
		m.mu.Unlock()
		for _, b := range active {
			if err := ctx.Err(); err != nil {
				return err
			}
			id := b.Surface.SurfaceID
			// Serialize native start/stop with probe dispatch. Input releases mu during
			// execution, so confirmed loss can cancel it without waiting for its reply.
			m.mu.Lock()
			current := m.bindings[id]
			if current.Surface.State != "active" || m.destroying[id] {
				delete(misses, id)
				m.mu.Unlock()
				continue
			}
			args := []string{"frame", "--container", b.Container}
			if b.Window != "" {
				args = append(args, "--window", b.Window)
			}
			probeCtx, cancel := context.WithTimeout(ctx, m.cfg.LivenessTimeout)
			_, err := m.execute(probeCtx, m.cfg.Profiles[b.Surface.ProfileID], args, nil)
			probeErr := probeCtx.Err()
			cancel()
			var f *cli.Fault
			if errors.As(err, &f) && f.Code == "unavailable" && probeErr == nil && ctx.Err() == nil {
				misses[id]++
			} else {
				delete(misses, id)
			}
			var ev json.RawMessage
			if misses[id] >= m.cfg.LivenessMisses {
				ev, _ = m.markLostLocked(id, true)
				delete(misses, id)
			}
			m.mu.Unlock()
			if len(ev) != 0 {
				if err := emit(ctx, ev); err != nil {
					return err
				}
			}
		}
	}
}
