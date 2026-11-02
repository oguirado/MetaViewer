package capsule

import (
	"context"
	"encoding/json"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Identity IDs follow the existing public identity-store contract, which is
// narrower than the generic surface profile pattern.
var storedIdentityID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,39}$`)

func protectedIdentity(id string) bool {
	return strings.HasPrefix(id, "cuentas-") || strings.HasPrefix(id, "perplexity-") ||
		strings.HasPrefix(id, "srf-id-cuentas-") || strings.HasPrefix(id, "srf-id-perplexity-") || strings.HasPrefix(id, "srf-pg-")
}

func displayBaseNumber(display string) int {
	rest := strings.TrimPrefix(display, ":")
	if dot := strings.IndexByte(rest, '.'); dot >= 0 {
		rest = rest[:dot]
	}
	if n, err := strconv.Atoi(rest); err == nil && n >= 0 {
		return n
	}
	return 100
}

// The template comes exclusively from trusted startup profiles; logical display
// slots expand up to MaxSurfaces so the display pool never caps admission below
// the adapter ceiling. Sorted selection is stable across map iteration and
// renderer calls. Static profiles retain their configuration and fixed displays.
func (m *Manager) configureIdentityTemplate() {
	ids := make([]string, 0, len(m.cfg.Profiles))
	for id, p := range m.cfg.Profiles {
		if p.Kind == "browser" && p.NativeKind == "browser" && p.Width == 1280 && p.Height == 900 && !protectedIdentity(id) {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	if len(ids) == 0 {
		return
	}
	p := m.cfg.Profiles[ids[0]]
	m.identityTemplate = &p
	seen := make(map[string]bool, m.cfg.MaxSurfaces)
	for _, existing := range m.cfg.Profiles {
		if existing.RAMRoot == p.RAMRoot && existing.Display != "" {
			seen[existing.Display] = true
		}
	}
	for _, id := range ids {
		candidate := m.cfg.Profiles[id]
		if candidate.RAMRoot == p.RAMRoot {
			m.identityDisplays = append(m.identityDisplays, candidate.Display)
		}
	}
	for next := displayBaseNumber(p.Display); len(m.identityDisplays) < m.cfg.MaxSurfaces; next++ {
		candidate := ":" + strconv.Itoa(next)
		if seen[candidate] {
			continue
		}
		seen[candidate] = true
		m.identityDisplays = append(m.identityDisplays, candidate)
	}
}

func (m *Manager) staticDisplayReserved(root, display string) bool {
	for id, p := range m.cfg.Profiles {
		if !m.dynamicProfiles[id] && p.RAMRoot == root && p.Display == display {
			return true
		}
	}
	return false
}

func (m *Manager) allocateIdentityDisplay(root, except string) (string, bool) {
	for _, display := range m.identityDisplays {
		if !m.staticDisplayReserved(root, display) && !m.displayOccupied(root, display, except) {
			return display, true
		}
	}
	for _, display := range m.identityDisplays {
		if !m.displayOccupied(root, display, except) {
			return display, true
		}
	}
	return "", false
}

// ProfileFor supplies publisher routing information, never admission authority.
// Create independently checks store existence before any native side effect.
func (m *Manager) ProfileFor(id string) (Profile, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	// The daemon retains its own static publisher-admission map. Never let
	// this dynamic fallback bypass a missing static entry in that map.
	if _, static := m.cfg.Profiles[id]; static && !m.dynamicProfiles[id] {
		return Profile{}, false
	}
	return m.profileFor(id)
}

func (m *Manager) profileFor(id string) (Profile, bool) {
	if p, ok := m.cfg.Profiles[id]; ok {
		return p, true
	}
	if m.identityTemplate == nil || !storedIdentityID.MatchString(id) || protectedIdentity(id) {
		return Profile{}, false
	}
	return *m.identityTemplate, true
}

func (m *Manager) programProfileFor(id string) (Profile, bool) {
	if existing, ok := m.cfg.Profiles[id]; ok {
		if !m.dynamicProfiles[id] || existing.Kind != "desktop_capsule" || existing.Program != "host-exec" {
			return Profile{}, false
		}
		return existing, true
	}
	if m.identityTemplate == nil || !storedIdentityID.MatchString(id) || protectedIdentity(id) {
		return Profile{}, false
	}
	p := *m.identityTemplate
	p.Kind = "desktop_capsule"
	p.NativeKind = "program"
	p.Program = "host-exec"
	p.Role = "agent"
	p.NestedDepth = 0
	p.Display = ""
	return p, true
}

func (m *Manager) admitProgramProfile(id string, p *Profile) error {
	if _, static := m.cfg.Profiles[id]; static && !m.dynamicProfiles[id] {
		return fault("profile", "host-exec requires dynamic program profile")
	}
	if !storedIdentityID.MatchString(id) || protectedIdentity(id) {
		return fault("profile", "program profile refused")
	}
	if display, ok := m.allocateIdentityDisplay(p.RAMRoot, id); ok {
		p.Display = display
		m.cfg.Profiles[id] = *p
		m.dynamicProfiles[id] = true
		return nil
	}
	return fault("profile", "identity display pool exhausted; stop a capsule first")
}

func (m *Manager) runnerSearchPath() string {
	if sp, ok := m.runner.(interface{ SearchPath() string }); ok {
		return sp.SearchPath()
	}
	return ""
}

func (m *Manager) displayOccupied(root, display, except string) bool {
	for id, p := range m.cfg.Profiles {
		if id == except || p.RAMRoot != root || p.Display != display {
			continue
		}
		if m.quarantined[id] {
			return true
		}
		for _, b := range m.bindings {
			if b.Surface.ProfileID == id && b.Surface.State != "destroyed" {
				return true
			}
		}
	}
	return false
}

func (m *Manager) admitIdentityProfile(ctx context.Context, id string, p *Profile) error {
	_, static := m.cfg.Profiles[id]
	static = static && !m.dynamicProfiles[id]
	if static {
		// Static/static uniqueness was checked at startup. Only a temporary
		// identity allocation can now occupy a static profile's reserved display.
		for dynamic := range m.dynamicProfiles {
			allocated := m.cfg.Profiles[dynamic]
			if allocated.RAMRoot == p.RAMRoot && allocated.Display == p.Display {
				return fault("profile", "configured display is in use; stop its capsule first")
			}
		}
		return nil
	}
	if !storedIdentityID.MatchString(id) || protectedIdentity(id) {
		return fault("profile", "identity refused")
	}
	checker, ok := m.runner.(interface {
		IdentityExists(context.Context, string) error
	})
	if !ok || checker.IdentityExists(ctx, id) != nil {
		return fault("identity_unavailable", "identity must exist in the configured store")
	}
	if display, ok := m.allocateIdentityDisplay(p.RAMRoot, id); ok {
		p.Display = display
		m.cfg.Profiles[id] = *p
		m.dynamicProfiles[id] = true
		return nil
	}
	return fault("profile", "identity display pool exhausted; stop a capsule first")
}

func (m *Manager) releaseIdleIdentityProfile(id string) {
	if !m.dynamicProfiles[id] || m.quarantined[id] {
		return
	}
	for _, b := range m.bindings {
		if b.Surface.ProfileID == id && b.Surface.State != "destroyed" {
			return
		}
	}
	delete(m.dynamicProfiles, id)
	delete(m.cfg.Profiles, id)
}

// Only public admin metadata is queried; browser profile files are never opened.
func (r *ProcessRunner) IdentityExists(ctx context.Context, id string) error {
	if !storedIdentityID.MatchString(id) || protectedIdentity(id) {
		return fault("profile", "identity refused")
	}
	out, err := r.Run(ctx, []string{filepath.Join(r.root, "srf-identity-admin"), "show", "--id", id}, nil)
	if err != nil {
		return err
	}
	var metadata struct {
		ProfileID string `json:"profile_id"`
	}
	if json.Unmarshal(out, &metadata) != nil || metadata.ProfileID != id {
		return fault("profile", "identity metadata mismatch")
	}
	return nil
}
