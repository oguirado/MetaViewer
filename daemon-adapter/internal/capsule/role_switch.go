package capsule

import "context"

// SwitchRole is the explicit host-only opening-role conversion. It does not
// extend legacy take/release control: native lifetime and saved identity remain
// bound, and old input/capture work cannot cross the new authority epoch.
func (m *Manager) SwitchRole(ctx context.Context, id, role string) (Surface, error) {
	if err := ctx.Err(); err != nil {
		return Surface{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if role != "human" && role != "agent" {
		return Surface{}, fault("POLICY", "invalid opening role")
	}
	b, ok := m.bindings[id]
	if !ok || b.Surface.State != "active" || b.recoveryProbe != nil || m.destroying[id] || m.hasPending(id) {
		return Surface{}, fault("POLICY", "role switch requires active drained surface")
	}
	if b.Surface.Kind == "vm" || (b.NativeKind != "browser" && !(b.NativeKind == "program" && b.Program == "host-exec")) {
		return Surface{}, fault("POLICY", "native role switch unsupported")
	}
	if b.Role != "human" && b.Role != "agent" {
		return Surface{}, fault("POLICY", "opening role unproven")
	}
	if b.Role == role && b.Surface.Control == role {
		return b.Surface, nil
	}
	oldEpoch := m.inputEpochs[id]
	if oldEpoch == ^uint64(0) || b.FrameRefreshEpoch == ^uint64(0) {
		return Surface{}, fault("POLICY", "role epoch exhausted")
	}
	b.Role = role
	b.Surface.Control = role
	b.FrameRefreshEpoch++
	m.inputEpochs[id] = oldEpoch + 1
	if err := m.publishHumanBinding(b); err != nil {
		m.inputEpochs[id] = oldEpoch
		return Surface{}, err
	}
	m.bindings[id] = b
	m.refresh[id] = true
	return b.Surface, nil
}
