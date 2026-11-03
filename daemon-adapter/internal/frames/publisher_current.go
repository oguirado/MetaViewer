package frames

// Current returns a value copy of the latest successfully published frame.
// It performs no capture/publication and acquires only this publisher's mutex;
// callers must not treat missing or retired state as a usable baseline.
func (p *Publisher) Current(id string) (Ref, error) {
	if p == nil {
		return Ref{}, frameError()
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	s, ok := p.surfaces[id]
	if p.closed || p.output == nil || !ok || len(s.refs) == 0 {
		return Ref{}, frameError()
	}
	r := s.refs[len(s.refs)-1]
	if r.SurfaceID != id || r.Generation == 0 || r.SHA256 == "" {
		return Ref{}, frameError()
	}
	return r, nil
}
