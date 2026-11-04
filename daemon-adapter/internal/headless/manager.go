package headless

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"syscall"
	"time"
)

type Manager struct {
	mu                  sync.Mutex
	profile             *Profile
	factory             factory
	child               process
	reservation         string
	attempted, poisoned bool
	uncertain           bool
	session             json.RawMessage
	workload            string
	generation          int64
	pendingRun          json.RawMessage
	seen                map[string]bool
}

// StateRoot is the already validated host-owned directory, never wire input.
func (m *Manager) StateRoot() string {
	if m == nil {
		return ""
	}
	return m.profile.StateRoot
}

func NewFromEnv() (*Manager, error) {
	path := os.Getenv("MV_HEADLESS_PROFILE")
	if path == "" {
		return nil, nil
	}
	p, e := Load(path)
	if e != nil {
		return nil, e
	}
	if v := os.Getenv("MV_HEADLESS_GUARDIAN_UNIT"); v != "" && v != p.GuardianUnit {
		return nil, errors.New("guardian conflict")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if e = verifyGuardian(ctx, p); e != nil {
		return nil, e
	}
	reservation := filepath.Join(p.StateRoot, "headless-reservation.json")
	if _, e = os.Lstat(reservation); !os.IsNotExist(e) {
		return nil, errors.New("previous reservation requires reconciliation")
	}
	return &Manager{profile: p, factory: startService, reservation: reservation, seen: map[string]bool{}}, nil
}
func nonce() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func refuse(id, code string) []json.RawMessage {
	b, _ := json.Marshal(map[string]any{"schema": "headless_event/v0.2", "event_id": "event-" + nonce(), "request_id": id, "event": "refused", "data": map[string]any{"workload_id": nil, "generation": nil, "code": code, "effect": "not_dispatched"}})
	return []json.RawMessage{b}
}
func writeNew(path string, value any) error {
	b, e := json.Marshal(value)
	if e != nil {
		return e
	}
	f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	_, e = f.Write(b)
	if e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e == nil {
		e = closeErr
	}
	if e != nil {
		return e
	}
	d, e := os.Open(filepath.Dir(path))
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
func (m *Manager) prepare() (string, string, error) {
	if e := privateDir(m.profile.StateRoot); e != nil {
		return "", "", e
	}
	if e := privateDir(m.profile.RuntimeRoot); e != nil {
		return "", "", e
	}
	unit := "mv-headless-" + nonce() + ".service"
	// Durable conservative responsibility precedes process creation, including uncertain Start.
	if e := writeNew(m.reservation, map[string]any{"schema": "headless-reservation/v1", "unit": unit, "owner_id": m.profile.OwnerID, "status": "pending"}); e != nil {
		return "", "", e
	}
	attempt, e := os.MkdirTemp(m.profile.StateRoot, "attempt-")
	if e != nil {
		return "", "", e
	}
	runtime, e := os.MkdirTemp(m.profile.RuntimeRoot, "headless-")
	if e != nil {
		return "", "", e
	}
	state := filepath.Join(attempt, "state")
	if e = os.Mkdir(state, 0700); e != nil {
		return "", "", e
	}
	for _, f := range m.profile.Files {
		b, e := pinned(Pin{f.Path, f.SHA256}, 2<<20)
		if e != nil {
			return "", "", e
		}
		dest := filepath.Join(attempt, "bundle", f.Relative)
		if e = os.MkdirAll(filepath.Dir(dest), 0700); e != nil {
			return "", "", e
		}
		if e = os.WriteFile(dest, b, 0600); e != nil {
			return "", "", e
		}
	}
	b, e := pinned(m.profile.Runner, 1<<20)
	if e != nil {
		return "", "", e
	}
	if e = os.WriteFile(filepath.Join(attempt, "runner.py"), b, 0600); e != nil {
		return "", "", e
	}
	python, e := pinnedExecutable(m.profile.Python)
	if e != nil {
		return "", "", e
	}
	if e = os.WriteFile(filepath.Join(attempt, "python"), python, 0500); e != nil {
		return "", "", e
	}
	var config map[string]any
	if e = json.Unmarshal(m.profile.ConfigTemplate, &config); e != nil {
		return "", "", e
	}
	if e = writeNew(filepath.Join(attempt, "launch.json"), map[string]any{"files": m.profile.Files, "config": config, "state_dir": state, "runtime_root": runtime, "unit": unit}); e != nil {
		return "", "", e
	}
	identities := map[string]any{}
	for _, path := range []string{attempt, state, runtime} {
		st, e := os.Lstat(path)
		if e != nil {
			return "", "", e
		}
		s := st.Sys().(*syscall.Stat_t)
		identities[path] = map[string]any{"device": s.Dev, "inode": s.Ino}
	}
	if e = writeNew(m.reservation+".prepared", map[string]any{"unit": unit, "paths": identities}); e != nil {
		return "", "", e
	}
	return attempt, unit, nil
}
func (m *Manager) Handle(ctx context.Context, body json.RawMessage, validate func(json.RawMessage) error) ([]json.RawMessage, error) {
	var r struct {
		Schema string          `json:"schema"`
		ID     string          `json:"request_id"`
		Op     string          `json:"op"`
		Params json.RawMessage `json:"params"`
	}
	if e := json.Unmarshal(body, &r); e != nil {
		return nil, e
	}
	if r.Schema != "headless_request/v0.2" || r.ID == "" {
		return nil, errors.New("headless request required")
	}
	if m == nil {
		return refuse(r.ID, "UNAVAILABLE"), nil
	}
	var admission struct {
		Admitted bool `json:"runtime_admitted"`
	}
	if json.Unmarshal(m.profile.ConfigTemplate, &admission) != nil || !admission.Admitted {
		return refuse(r.ID, "UNAVAILABLE"), nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.poisoned {
		return nil, errors.New("headless responsibility uncertain; no replay")
	}
	if m.uncertain && r.Op != "stop" {
		return refuse(r.ID, "OUT_OF_ORDER"), nil
	}
	if m.seen[r.ID] {
		return refuse(r.ID, "DUPLICATE_REQUEST"), nil
	}
	if len(m.seen) >= 128 {
		return nil, errors.New("headless request bound")
	}
	m.seen[r.ID] = true
	if r.Op == "create" {
		if m.attempted {
			return refuse(r.ID, "BUSY"), nil
		}
		m.attempted = true
		attempt, unit, e := m.prepare()
		if e != nil {
			m.poisoned = true
			return nil, e
		}
		m.child, e = m.factory(ctx, m.profile, attempt, unit)
		if e != nil {
			m.poisoned = true
			return nil, e
		}
	} else if m.child == nil {
		return refuse(r.ID, "UNKNOWN_WORKLOAD"), nil
	}
	if r.Op == "run" {
		m.pendingRun = append(json.RawMessage(nil), r.Params...)
	}
	deadline, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	// Any attempted write is uncertain on failure. Never retry even a short write.
	if e := m.child.Send(deadline, body); e != nil {
		return m.failure(r.ID, r.Op, nil, validate, fmt.Errorf("headless send uncertain: %w", e))
	}
	var out []json.RawMessage
	for n := 0; n < 2; n++ {
		b, e := m.child.Read(deadline)
		if e != nil {
			return m.failure(r.ID, r.Op, out, validate, e)
		}
		if validate == nil || validate(b) != nil {
			m.poisoned = true
			return nil, errors.New("invalid controller event contract")
		}
		var event struct {
			Schema    string `json:"schema"`
			RequestID string `json:"request_id"`
			Event     string `json:"event"`
			Data      struct {
				Session json.RawMessage `json:"session"`
				Op      string          `json:"op"`
			} `json:"data"`
		}
		if json.Unmarshal(b, &event) != nil || event.Schema != "headless_event/v0.2" || event.RequestID != r.ID {
			m.poisoned = true
			return out, errors.New("uncorrelated headless event")
		}
		if (n == 0 && event.Event != "accepted" && event.Event != "refused") || (n == 1 && event.Event == "accepted") || (event.Event == "accepted" && event.Data.Op != r.Op) {
			m.poisoned = true
			return nil, errors.New("controller event order")
		}
		if len(event.Data.Session) > 0 {
			var s struct {
				Owner      string `json:"owner_id"`
				Phase      string `json:"phase"`
				Ownership  string `json:"ownership"`
				Workload   string `json:"workload_id"`
				Generation int64  `json:"generation"`
			}
			if json.Unmarshal(event.Data.Session, &s) != nil || s.Owner != m.profile.OwnerID {
				m.poisoned = true
				return out, errors.New("controller owner mismatch")
			}
			if m.workload == "" {
				if r.Op != "create" || event.Event != "accepted" {
					m.poisoned = true
					return nil, errors.New("unbound controller identity")
				}
				m.workload = s.Workload
				m.generation = s.Generation
				if e = writeNew(m.reservation+".bound", map[string]any{"request_id": r.ID, "session": json.RawMessage(event.Data.Session)}); e != nil {
					m.poisoned = true
					return nil, e
				}
			} else if s.Workload != m.workload || s.Generation != m.generation {
				m.poisoned = true
				return nil, errors.New("controller identity changed")
			}
			m.session = append(json.RawMessage(nil), event.Data.Session...)
			if s.Phase == "stopped" {
				if r.Op != "stop" || s.Ownership != "released" {
					m.poisoned = true
					return out, errors.New("unexpected release")
				}
				if e = m.child.Close(deadline); e != nil {
					return m.failure(r.ID, r.Op, out, validate, e)
				}
				m.child = nil
				if e = writeNew(m.reservation+".closed", map[string]any{"status": "closed", "request_id": r.ID}); e != nil {
					m.poisoned = true
					return out, e
				}
			}
		}
		out = append(out, json.RawMessage(b))
		if event.Event == "refused" || event.Event == "completed" || event.Event == "state_changed" || event.Event == "outcome_unknown" {
			if event.Event == "outcome_unknown" {
				m.uncertain = true
			}
			return out, nil
		}
		if event.Event != "accepted" || n != 0 {
			m.poisoned = true
			return out, errors.New("event sequence")
		}
	}
	m.poisoned = true
	return out, errors.New("missing terminal event")
}
func (m *Manager) failure(id, op string, out []json.RawMessage, validate func(json.RawMessage) error, cause error) ([]json.RawMessage, error) {
	m.poisoned = true
	unknown := m.unknown(id, op)
	if len(unknown) == 1 && validate != nil && validate(unknown[0]) == nil {
		return append(out, unknown...), nil
	}
	// No invented workload/session when the controller never acknowledged create.
	return nil, fmt.Errorf("headless unknown without a valid session: %w", cause)
}
func (m *Manager) unknown(id, op string) []json.RawMessage {
	if len(m.session) == 0 {
		return nil
	} // Never invent a session after unacknowledged create.
	var s map[string]any
	if json.Unmarshal(m.session, &s) != nil {
		return nil
	}
	s["phase"] = "uncertain"
	s["ownership"] = "held"
	if op == "run" {
		var job struct {
			ID         string `json:"job_id"`
			Operation  string `json:"operation"`
			N          int    `json:"n"`
			Workload   string `json:"workload_id"`
			Generation int64  `json:"generation"`
		}
		if json.Unmarshal(m.pendingRun, &job) != nil || !regexp.MustCompile(`^job-[a-z0-9][a-z0-9._-]{0,63}$`).MatchString(job.ID) || job.Operation != "sumsq" || job.N < 0 || job.N > 10000 || job.Workload != m.workload || job.Generation != m.generation {
			return nil
		}
		s["job"] = map[string]any{"job_id": job.ID, "operation": job.Operation, "n": job.N, "status": "unknown", "value": nil}
	}
	b, _ := json.Marshal(map[string]any{"schema": "headless_event/v0.2", "event_id": "event-" + nonce(), "request_id": id, "event": "outcome_unknown", "data": map[string]any{"session": s, "op": op, "code": "OUTCOME_UNKNOWN"}})
	return []json.RawMessage{b}
}
func (m *Manager) Close() error {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.child == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return m.child.Close(ctx)
}
