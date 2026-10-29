package capsule

// [TARGET, unit decision] No native liveness reply is admitted. Use the existing
// bounded frame verb without publishing or reading pixels. Only its typed
// absence result (unavailable/refused) counts as a miss; deadlines, cli_failed,
// malformed output and setup/usage errors are unknown, break the consecutive-miss
// sequence and never prove loss.
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

// IsAbsenceFault reports whether err is a native CLI fault proving the
// capsule process or container is gone (unavailable or refused), as opposed
// to a deadline, contention, execution (cli_failed), malformed, or setup/usage fault.
func IsAbsenceFault(err error) bool {
	var f *cli.Fault
	return errors.As(err, &f) && (f.Code == "unavailable" || f.Code == "refused")
}

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
			// Snapshot active binding identity under mu, then run the native probe
			// outside mu so manager operations are not blocked across LivenessTimeout.
			m.mu.Lock()
			current, ok := m.bindings[id]
			if !ok || current.Surface.State != "active" || m.destroying[id] || current.Container != b.Container || current.RunID != b.RunID {
				delete(misses, id)
				m.mu.Unlock()
				continue
			}
			profile := m.cfg.Profiles[current.Surface.ProfileID]
			args := []string{"frame", "--container", current.Container}
			if current.Window != "" {
				args = append(args, "--window", current.Window)
			}
			m.mu.Unlock()

			before := m.clock()
			probeCtx, cancel := context.WithTimeout(ctx, m.cfg.LivenessTimeout)
			out, err := m.execute(probeCtx, profile, args, nil)
			finished := m.clock()
			probeErr := probeCtx.Err()
			cancel()

			m.mu.Lock()
			after, ok := m.bindings[id]
			if !ok || after.Surface.State != "active" || m.destroying[id] || after.Container != current.Container || after.RunID != current.RunID || after.recoveryProbe != current.recoveryProbe {
				delete(misses, id)
				m.mu.Unlock()
				continue
			}
			if IsAbsenceFault(err) && probeErr == nil && ctx.Err() == nil {
				misses[id]++
			} else {
				delete(misses, id)
			}
			// A successful, bound frame is positive evidence only for the recovery
			// token captured before this probe; unknown or malformed replies stay closed.
			if after.recoveryProbe != nil && err == nil && probeErr == nil && ctx.Err() == nil {
				var f NativeFrame
				if cli.ParseLine(out, m.cfg.MaxOutputBytes, &f) == nil && f.Seq > 0 && f.Generation == after.Container && f.Width > 0 && f.Height > 0 && f.Width <= after.Surface.Geometry.W && f.Height <= after.Surface.Geometry.H && digest.MatchString(f.SHA256RGB24) && under(after.FramesRoot, f.Path) && f.CaptureMonoNS >= m.cfg.OriginNS && f.CaptureMonoNS >= before && f.CaptureMonoNS <= finished && finished >= before && ((after.Window == "" && f.Window == nil && f.Width == after.Surface.Geometry.W && f.Height == after.Surface.Geometry.H) || (f.Window != nil && f.Window.ID == after.Window && f.Window.W == f.Width && f.Window.H == f.Height)) {
					after.recoveryProbe = nil
					m.bindings[id] = after
				}
			}
			var ev json.RawMessage
			if misses[id] >= m.cfg.LivenessMisses {
				ev, _ = m.markLostLocked(id, true, true)
				delete(misses, id)
			}
			m.mu.Unlock()
			if len(ev) != 0 {
				err := emit(ctx, ev)
				m.CompleteLost(id, err == nil && ctx.Err() == nil)
				if err != nil {
					return err
				}
			}
		}
	}
}
