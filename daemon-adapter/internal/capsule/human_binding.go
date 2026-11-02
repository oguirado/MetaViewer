package capsule

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
)

// Host-only v0.3 binding witness. It contains no profile payload or lease token.
// The real process runner exports only a binding selected by the manager; renderer
// names never select a container or socket. Fake runners need not export files.
func (m *Manager) publishHumanBinding(b Binding) error {
	exporter, ok := m.runner.(interface {
		PublishHumanBinding(Binding, bool, uint64) error
	})
	if !ok {
		return nil
	}
	id := b.Surface.SurfaceID
	return exporter.PublishHumanBinding(b, b.Surface.State == "active" && !m.hasPending(id), m.inputEpochs[id])
}

var humanSurfaceID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

func (r *ProcessRunner) PublishHumanBinding(b Binding, ready bool, epoch uint64) error {
	if b.NativeKind != "" && b.NativeKind != "browser" && (b.NativeKind != "program" || b.Program != "host-exec") {
		return nil
	}
	if !humanSurfaceID.MatchString(b.Surface.SurfaceID) || !identityContainer.MatchString(b.Container) {
		return nil
	}
	if err := r.validateStateDir(); err != nil {
		return err
	}
	dir := filepath.Join(r.stateDir, "human-bindings")
	if _, err := stateDirInfo(dir); err != nil {
		return fault("binding", "human binding directory unavailable")
	}
	st, err := os.Lstat(dir)
	if err != nil || !st.IsDir() || st.Mode() != os.ModeDir|0700 {
		return fault("binding", "private human binding directory required")
	}
	raw, err := json.Marshal(struct {
		Schema    string `json:"schema"`
		SurfaceID string `json:"surface_id"`
		Container string `json:"container"`
		RunID     string `json:"run_id"`
		Ready     bool   `json:"control_ready"`
		Epoch     uint64 `json:"input_epoch"`
		Width     int    `json:"width"`
		Height    int    `json:"height"`
		Role      string `json:"role"`
		ProfileID string `json:"profile_id"`
	}{"metaviewer.human_binding/v0.3", b.Surface.SurfaceID, b.Container, b.RunID, ready, epoch, b.Surface.Geometry.W, b.Surface.Geometry.H, b.Role, b.Surface.ProfileID})
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".human-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(raw); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), filepath.Join(dir, b.Surface.SurfaceID+".json"))
}
