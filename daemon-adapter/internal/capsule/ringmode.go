package capsule

// [TARGET, unit decision] Resident capture shares input exclusion and session
// clock mapping with CLI capture, but allows a fresh frame predating the read.
import (
	"context"
	"metaviewer/daemon-adapter/internal/cli"
)

const CaptureModeRing = "resident-ring"
const CaptureModeLegacy = "legacy-pair"

func (m *Manager) CaptureResident(ctx context.Context, id string, read func(Binding) (NativeFrame, error)) (Binding, NativeFrame, error) {
	if err := ctx.Err(); err != nil {
		return Binding{}, NativeFrame{}, err
	}
	m.mu.Lock()
	b, ok := m.bindings[id]
	if !ok || b.Surface.State != "active" || m.destroying[id] || m.hasPending(id) {
		m.mu.Unlock()
		return Binding{}, NativeFrame{}, fault("surface", "resident capture requires active drained surface")
	}
	epoch := m.beginCapture(id)
	m.mu.Unlock()
	f, err := read(b)
	after := m.clock()
	m.mu.Lock()
	defer m.mu.Unlock()
	current, ok := m.bindings[id]
	if !ok || current.Container != b.Container || current.RunID != b.RunID || current.Surface.State != "active" || m.destroying[id] || m.hasPending(id) || m.inputEpochs[id] != epoch {
		return b, NativeFrame{}, fault("POLICY", "resident capture binding changed")
	}
	if err != nil {
		return b, NativeFrame{}, err
	}
	if err := ctx.Err(); err != nil {
		return b, NativeFrame{}, err
	}
	if f.CaptureMonoNS < m.cfg.OriginNS || f.CaptureMonoNS > after {
		return b, NativeFrame{}, &cli.Fault{Code: "ring_wire", Detail: "resident capture clock outside session"}
	}
	f.TSNS = f.CaptureMonoNS - m.cfg.OriginNS
	delete(m.refresh, id)
	return b, f, nil
}

// RefuseResident stops the hostile writer without calling subscription teardown
// from its own capture goroutine. Quarantine prevents subsequent input/capture.
func (m *Manager) RefuseResident(ctx context.Context, b Binding) error {
	m.mu.Lock()
	m.quarantined[b.Surface.ProfileID] = true
	if current, ok := m.bindings[b.Surface.SurfaceID]; ok {
		current.Surface.State = "lost"
		m.bindings[b.Surface.SurfaceID] = current
	}
	defer m.mu.Unlock()
	if err := m.stopNative(ctx, b); err != nil {
		return err
	}
	delete(m.quarantined, b.Surface.ProfileID)
	current := m.bindings[b.Surface.SurfaceID]
	current.Surface.State = "destroyed"
	m.bindings[b.Surface.SurfaceID] = current
	delete(m.inputEpochs, b.Surface.SurfaceID)
	delete(m.refresh, b.Surface.SurfaceID)
	return nil
}
