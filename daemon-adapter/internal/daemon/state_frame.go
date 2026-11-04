package daemon

// [TARGET, unit decision] A successful active agent state update publishes a
// forced current frame after its reply. Capture/publication failure is diagnostic
// only; the next validated subscription capture must satisfy the refresh fence
// even when its pixels match the previous publication.
import (
	"context"
	"errors"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/frames"
)

func captureStateFrame(ctx context.Context, m *capsule.Manager, profiles map[string]capsule.Profile, pubs map[string]*frames.Publisher, id string) (frames.Ref, error) {
	binding, err := m.RequireFrameRefresh(id)
	if err != nil {
		return frames.Ref{}, err
	}
	if binding.Role == "human" || binding.Surface.Control != "agent" {
		return frames.Ref{}, errors.New("state refresh requires agent control")
	}
	profile, ok := profiles[binding.Surface.ProfileID]
	if !ok {
		profile, ok = m.ProfileFor(binding.Surface.ProfileID)
	}
	pub := pubs[profile.RAMRoot]
	if !ok || pub == nil {
		return frames.Ref{}, errors.New("state refresh publisher required")
	}
	binding, native, err := m.Capture(ctx, id)
	if err != nil {
		return frames.Ref{}, err
	}
	return pub.PublishForced(id, binding, native)
}
