package capsule

import (
	"os"
	"path/filepath"
)

// [TARGET, unit decision] Fail closed during opening and uncertain teardown.
// Native evidence: OpenSuperficies src/browserid/surface/viewstop.go:20-31
// registers operator login views at <state-dir>/views/<container>.pid.
// The host tool also reserves .login-pending before launching the native view.
// Registration presence is sufficient; no credential or profile is inspected.
func (m *Manager) refuseLoginInput(container string) error {
	if m.loginLocks[container] {
		return fault("LOGIN_ACTIVE", "operator login blocks agent input")
	}
	if r, ok := m.runner.(interface{ LoginActive(string) (bool, error) }); ok {
		active, err := r.LoginActive(container)
		if err != nil || active {
			return fault("LOGIN_ACTIVE", "operator login registration blocks agent input")
		}
	}
	return nil
}

func (r *ProcessRunner) LoginActive(container string) (bool, error) {
	if !identityContainer.MatchString(container) {
		return false, nil // Holdings does not use identity login views.
	}
	if err := r.validateStateDir(); err != nil {
		return false, err
	}
	for _, suffix := range []string{".pid", ".login-pending"} {
		_, err := os.Lstat(filepath.Join(r.stateDir, "views", container+suffix))
		if err == nil {
			return true, nil
		}
		if !os.IsNotExist(err) {
			return false, err
		}
	}
	return false, nil
}
