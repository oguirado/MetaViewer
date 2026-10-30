package capsule

// AdmissionProfiles returns a read-only snapshot of possible native incumbents.
// [TARGET, unit decision] Unbound quarantine consumes the same reservation as a
// live binding. Only verified destruction releases it; lost bindings still count.
func (m *Manager) AdmissionProfiles() map[string]bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	profiles := make(map[string]bool)
	for id, quarantined := range m.quarantined {
		if quarantined {
			profiles[id] = true
		}
	}
	for _, b := range m.bindings {
		if b.Surface.State != "destroyed" {
			profiles[b.Surface.ProfileID] = true
		}
	}
	return profiles
}
