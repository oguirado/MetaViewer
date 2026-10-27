package capsule

// [TARGET, unit decision] Adapter input permits are session-local and single-use
// (bounded to 100000 attempts). Takeover cancels in-flight input; the owner must
// acknowledge DrainInput after native completion before release. ControlReady is
// a local seam, not a new wire event. Release requires a fresh validated capture.
import (
	"context"
	"encoding/json"
	"metaviewer/daemon-adapter/internal/cli"
)

type pendingInput struct {
	surface         string
	epoch           uint64
	cancel          context.CancelFunc
	cancelled, done bool
}

func (m *Manager) nextInputEpoch(id string) uint64 {
	m.inputEpochs[id]++
	return m.inputEpochs[id]
}

func (m *Manager) beginCapture(id string) uint64 {
	return m.inputEpochs[id]
}

func (m *Manager) hasPending(id string) bool {
	for _, p := range m.pending {
		if p.surface == id {
			return true
		}
	}
	return false
}
func (m *Manager) control(r Request, version string) ([]json.RawMessage, error) {
	var q struct {
		SurfaceID string `json:"surface_id"`
		Owner     string `json:"owner,omitempty"`
	}
	if r.Op == "release_control" {
		var p struct {
			SurfaceID string `json:"surface_id"`
		}
		if e := cli.ParseLine(r.Params, m.cfg.MaxOutputBytes, &p); e != nil {
			return nil, e
		}
		q.SurfaceID = p.SurfaceID
	} else if e := cli.ParseLine(r.Params, m.cfg.MaxOutputBytes, &q); e != nil {
		return nil, e
	}
	b, ok := m.bindings[q.SurfaceID]
	if !ok || b.Surface.State != "active" {
		return nil, fault("surface", "active surface required")
	}
	if m.destroying[q.SurfaceID] {
		return nil, fault("POLICY", "surface is draining")
	}
	if r.Op == "take_control" {
		if q.Owner != "human" || b.Surface.Control != "agent" {
			return nil, fault("POLICY", "human takeover requires agent ownership")
		}
		b.Surface.Control = "human"
		for _, p := range m.pending {
			if p.surface == q.SurfaceID {
				p.cancelled = true
				p.cancel()
			}
		}
	} else {
		if b.Surface.Control != "human" || m.hasPending(q.SurfaceID) {
			return nil, fault("POLICY", "takeover input must be drained before release")
		}
		b.Surface.Control = "agent"
		m.refresh[q.SurfaceID] = true
	}
	m.bindings[q.SurfaceID] = b
	return []json.RawMessage{surfaceEvent(version, "state_changed", b.Surface)}, nil
}
func (m *Manager) ControlReady(id string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.bindings[id]
	if !ok || b.Surface.State != "active" {
		return false, fault("surface", "active surface required")
	}
	return b.Surface.Control == "human" && !m.hasPending(id), nil
}
func (m *Manager) DrainInput(id, proposal string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.pending[proposal]
	if !ok || p.surface != id || !p.cancelled || !p.done {
		return fault("POLICY", "completed cancelled input required")
	}
	delete(m.pending, proposal)
	return nil
}
