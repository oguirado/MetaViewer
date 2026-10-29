package capsule

import "strings"

// [TARGET, unit decision] One policy shared by each package's dispatch seam.
// OpenSuperficies a9ac1ac8543872b428990ea23fa2629cd0a6d1d5:
// cmd/srf-identity-surface/main.go:150-157 uses Go flag parsing (one/two
// dashes and equals); src/browserid/surface/surface.go:182,486-505 and
// src/holdingscap/holdingscap.go:249-253 validate case-sensitively.
// Trim defensively, without folding case or changing the dispatched argv.
func RefuseProtectedContainer(args []string) error {
	for i, arg := range args {
		flag, value, equals := strings.Cut(arg, "=")
		if flag != "--container" && flag != "-container" && flag != "--capsule" && flag != "-capsule" {
			continue
		}
		if !equals && i+1 < len(args) {
			value = args[i+1]
		}
		container := strings.TrimSpace(value)
		switch container {
		case "srf-id-cuentas-1", "srf-id-perplexity-1", "srf-pg-notepad-1",
			"srf-pg-metaviewer-1", "srf-egress-proxy", "n8n", "distil-box":
			return fault("protected_container", "native operation refused for protected container "+container)
		}
	}
	return nil
}

func refuseProtectedContainer(args []string) error { return RefuseProtectedContainer(args) }

// pendingCreate is process-local authority, separate from native reply data.
// Holdings reserves a slot until its single returned container can be correlated.
type pendingCreate struct {
	Generation, NativeKind, Container string
	Slot                              int
}

func (m *Manager) pendingCleanup(profile, generation, kind string, slot int, container string) bool {
	pending, ok := m.creates[profile]
	if !ok || pending.Generation != generation || pending.NativeKind != kind {
		return false
	}
	if refuseProtectedContainer([]string{"--container", container}) != nil {
		return false
	}
	for _, old := range m.bindings {
		if old.Container == container && old.Surface.State != "destroyed" {
			return false
		}
	}
	if kind == "holdings" {
		return slot == pending.Slot && holdingsContainer.MatchString(container)
	}
	// Native identity starts generate random container names; cleanup authority
	// comes from the pending generation, not a profile-derived name prediction.
	return identityContainer.MatchString(container)
}
