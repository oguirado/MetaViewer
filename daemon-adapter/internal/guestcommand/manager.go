package guestcommand

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type pending struct {
	body           json.RawMessage
	op             string
	accepted, done bool
}
type inventoryContextKey struct{}
type serviceInventory interface {
	Actor() string
	ServicePending(string, string) error
	ServiceBound(string, string, string, string, uint64, uint64, int, string) error
	ServiceClosed(string) error
	Unknown(string) error
	Seal() error
}

type Manager struct {
	inventory                               serviceInventory
	mu                                      sync.Mutex
	profile                                 *Profile
	factory                                 factory
	child                                   process
	reservation, token, sessionID, createID string
	attempted, poisoned, closing            bool
	session                                 json.RawMessage
	workload                                string
	generation                              int64
	pending                                 map[string]*pending
	seen                                    map[string]bool
	emit                                    func(json.RawMessage) error
	validate                                func(json.RawMessage) error
	readerDone                              chan struct{}
}

func nonce() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func reservationID(session, id string) string {
	h := sha256.New()
	h.Write([]byte("MetaViewer/guest-command/reservation/v1\x00"))
	for _, s := range []string{session, id} {
		var n [4]byte
		binary.BigEndian.PutUint32(n[:], uint32(len([]byte(s))))
		h.Write(n[:])
		h.Write([]byte(s))
	}
	return "reservation-" + hex.EncodeToString(h.Sum(nil))
}
func (m *Manager) StateRoot() string {
	if m == nil {
		return ""
	}
	return m.profile.StateRoot
}
func NewFromEnv() (*Manager, error) {
	path := os.Getenv("MV_GUEST_COMMAND_PROFILE")
	if path == "" {
		return nil, nil
	}
	p, e := Load(path)
	if e != nil {
		return nil, e
	}
	if os.Getenv("MV_GUEST_COMMAND_GUARDIAN_UNIT") != "" && os.Getenv("MV_GUEST_COMMAND_GUARDIAN_UNIT") != p.GuardianUnit {
		return nil, errors.New("guardian conflict")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if e = verifyGuardian(ctx, p); e != nil {
		return nil, e
	}
	marker := filepath.Join(p.StateRoot, "guest-command-reservation.json")
	if _, e = os.Lstat(marker); !os.IsNotExist(e) {
		return nil, errors.New("previous reservation requires reconciliation")
	}
	return &Manager{profile: p, factory: startService, reservation: marker, pending: map[string]*pending{}, seen: map[string]bool{}}, nil
}
func (m *Manager) refusal(id, op, code, sessionID string) json.RawMessage {
	token := m.token
	if token == "" {
		token = reservationID(sessionID, id)
	}
	b, _ := json.Marshal(map[string]any{"schema": "guest_command_event/v0.2", "event_id": "event-" + nonce(), "request_id": id, "reservation_id": token, "owner_id": m.profile.OwnerID, "session": nil, "event": "refused", "data": map[string]any{"op": op, "code": code}})
	return b
}

// Handle queues bounded work. Its reader publishes on the existing authenticated
// session, so a pending run never occupies the core receive/control lane.
func (m *Manager) Handle(ctx context.Context, body json.RawMessage, sessionID string, validate, emit func(json.RawMessage) error) ([]json.RawMessage, error) {
	var r struct {
		Schema string `json:"schema"`
		ID     string `json:"request_id"`
		Op     string `json:"op"`
	}
	if json.Unmarshal(body, &r) != nil || r.Schema != "guest_command_request/v0.2" || r.ID == "" || sessionID == "" || validate == nil || emit == nil {
		return nil, errors.New("complete authenticated guest request required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sessionID != "" && m.sessionID != sessionID {
		return nil, errors.New("session changed")
	}
	if m.closing {
		return nil, errors.New("guest owner unavailable")
	}
	if m.poisoned {
		if r.Op == "stop" && m.child != nil && len(m.session) > 0 {
			return m.reconcileStop(ctx, r.ID, body)
		}
		return nil, errors.New("guest owner uncertain")
	}
	if _, ok := m.pending[r.ID]; ok {
		return []json.RawMessage{m.refusal(r.ID, r.Op, "DUPLICATE", sessionID)}, nil
	}
	if len(m.pending) >= 256 {
		return []json.RawMessage{m.refusal(r.ID, r.Op, "CAPACITY", sessionID)}, nil
	}
	if r.Op == "create" {
		if m.attempted {
			return []json.RawMessage{m.refusal(r.ID, r.Op, "BUSY", sessionID)}, nil
		}
		var admitted struct {
			Admitted bool `json:"runtime_admitted"`
		}
		if json.Unmarshal(m.profile.ConfigTemplate, &admitted) != nil || !admitted.Admitted {
			return []json.RawMessage{m.refusal(r.ID, r.Op, "UNAVAILABLE", sessionID)}, nil
		}
		m.attempted = true
		m.sessionID = sessionID
		m.createID = r.ID
		m.token = reservationID(sessionID, r.ID)
		m.emit = emit
		m.validate = validate
		m.pending[r.ID] = &pending{body: append(json.RawMessage(nil), body...), op: r.Op}
		attempt, unit, e := m.prepare()
		if e != nil {
			m.poisoned = true
			return nil, e
		}
		factoryContext := ctx
		if m.inventory != nil {
			if e = m.inventory.ServicePending(unit, unit); e != nil {
				m.poisoned = true
				return nil, e
			}
			factoryContext = context.WithValue(ctx, inventoryContextKey{}, m.inventory)
		}
		m.child, e = m.factory(factoryContext, m.profile, attempt, unit)
		if e != nil {
			m.poisoned = true
			return nil, e
		}
		m.readerDone = make(chan struct{})
		go m.receive(ctx)
	} else {
		if m.child == nil {
			return []json.RawMessage{m.refusal(r.ID, r.Op, "UNAVAILABLE", sessionID)}, nil
		}
		m.pending[r.ID] = &pending{body: append(json.RawMessage(nil), body...), op: r.Op}
	}
	sendCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if e := m.child.Send(sendCtx, body); e != nil {
		m.poisoned = true
		return nil, fmt.Errorf("guest send uncertain: %w", e)
	}
	return nil, nil
}
func (m *Manager) receive(ctx context.Context) {
	defer close(m.readerDone)
	for {
		readCtx, cancel := context.WithTimeout(ctx, 180*time.Second)
		b, e := m.child.Read(readCtx)
		cancel()
		m.mu.Lock()
		if m.closing {
			m.mu.Unlock()
			return
		}
		if e != nil {
			m.failLocked()
			m.mu.Unlock()
			return
		}
		e = m.consumeLocked(ctx, b)
		if e != nil {
			m.poisoned = true
			m.failLocked()
			m.mu.Unlock()
			return
		}
		done := m.child == nil
		m.mu.Unlock()
		if done {
			return
		}
	}
}
func (m *Manager) consumeLocked(ctx context.Context, b json.RawMessage) error {
	if m.validate(b) != nil {
		return errors.New("guest event schema")
	}
	var e struct {
		Schema, Event string
		ID            string          `json:"request_id"`
		EventID       string          `json:"event_id"`
		Token         string          `json:"reservation_id"`
		Owner         string          `json:"owner_id"`
		Session       json.RawMessage `json:"session"`
		Data          struct {
			Op     string `json:"op"`
			Absent bool   `json:"native_absent"`
		} `json:"data"`
	}
	if json.Unmarshal(b, &e) != nil || e.Schema != "guest_command_event/v0.2" || e.Owner != m.profile.OwnerID || e.Token != m.token {
		return errors.New("guest authority mismatch")
	}
	if m.seen[e.EventID] || len(m.seen) >= 8192 {
		return errors.New("guest event replay/capacity")
	}
	p := m.pending[e.ID]
	if p == nil || p.done && !(e.Event == "outcome_unknown" && e.ID == m.createID && e.Data.Op == "create") {
		return errors.New("uncorrelated guest event")
	}
	var s struct {
		Owner      string `json:"owner_id"`
		Workload   string `json:"workload_id"`
		Generation int64  `json:"generation"`
		Phase      string `json:"phase"`
		Ownership  string `json:"ownership"`
	}
	if string(e.Session) != "null" {
		if json.Unmarshal(e.Session, &s) != nil || s.Owner != m.profile.OwnerID {
			return errors.New("guest session owner")
		}
		if m.workload == "" {
			if p.op != "create" || e.Event != "accepted" {
				return errors.New("unbound guest")
			}
			m.workload = s.Workload
			m.generation = s.Generation
			if err := writeNew(m.reservation+".bound", map[string]any{"request_id": e.ID, "reservation_id": m.token, "session": e.Session}); err != nil {
				return err
			}
		} else if m.workload != s.Workload || m.generation != s.Generation {
			return errors.New("guest identity changed")
		}
	}
	switch e.Event {
	case "accepted":
		if p.accepted || e.Data.Op != p.op {
			return errors.New("duplicate/wrong acceptance")
		}
		p.accepted = true
		if p.op == "cancel" {
			p.done = true
		}
	case "output":
		if p.op != "run" || !p.accepted {
			return errors.New("unaccepted output")
		}
	case "ready":
		if p.op != "create" || !p.accepted {
			return errors.New("unaccepted ready")
		}
		p.done = true
	case "job_finished":
		if p.op != "run" || !p.accepted {
			return errors.New("unaccepted job terminal")
		}
		p.done = true
	case "refused":
		if p.accepted || e.Data.Op != p.op {
			return errors.New("refusal after effect")
		}
		p.done = true
	case "outcome_unknown":
		if e.Data.Op != p.op {
			return errors.New("unknown operation")
		}
		for _, item := range m.pending {
			item.done = true
		}
	case "stopped":
		if p.op != "stop" || !p.accepted || !e.Data.Absent || s.Phase != "stopped" || s.Ownership != "released" {
			return errors.New("unverified stop")
		}
		closeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := m.child.Close(closeCtx)
		cancel()
		if err != nil {
			return err
		}
		m.child = nil
		if err = writeNew(m.reservation+".closed", map[string]any{"request_id": e.ID, "reservation_id": m.token, "status": "closed"}); err != nil {
			return err
		}
		p.done = true
	default:
		return errors.New("unknown event")
	}
	if string(e.Session) != "null" {
		m.session = append(json.RawMessage(nil), e.Session...)
	}
	m.seen[e.EventID] = true
	return m.emit(b)
}

// If the service transport dies, one global uncertain projection fences every
// pending operation. Completed job evidence is retained in the session.
func (m *Manager) failLocked() {
	if m.emit == nil || m.validate == nil {
		return
	}
	id := m.createID
	var active *pending
	for key, p := range m.pending {
		if !p.done && (active == nil || p.op == "run") {
			id = key
			active = p
		}
	}
	if active == nil {
		active = m.pending[id]
	}
	if active == nil {
		return
	}
	var state map[string]any
	if len(m.session) > 0 && json.Unmarshal(m.session, &state) == nil {
		state["phase"] = "uncertain"
		state["ownership"] = "held"
		for _, p := range m.pending {
			if p.done {
				continue
			}
			var r struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal(p.body, &r)
			if p.op == "run" {
				job, _ := state["job"].(map[string]any)
				if job == nil || job["job_id"] != r.Params["job_id"] {
					state["job"] = map[string]any{"job_id": r.Params["job_id"], "state": "unknown", "exit_code": nil, "signal": nil, "stdout_bytes": 0, "stderr_bytes": 0, "output_complete": false}
					state["controls"] = map[string]any{"cancel": nil, "stop": nil}
					if n, ok := state["jobs_started"].(float64); ok {
						state["jobs_started"] = n + 1
					}
				}
			}
		}
		for _, p := range m.pending {
			if !p.done && (p.op == "cancel" || p.op == "stop") {
				controls, _ := state["controls"].(map[string]any)
				if controls != nil && controls[p.op] == nil {
					var q struct {
						ID string `json:"request_id"`
					}
					_ = json.Unmarshal(p.body, &q)
					controls[p.op] = map[string]any{"request_id": q.ID, "ack": "pending"}
				}
			}
		}
		if job, ok := state["job"].(map[string]any); ok && (job["state"] == "running" || job["state"] == "cancelling") {
			job["state"] = "unknown"
			job["output_complete"] = false
		}
	}
	b, _ := json.Marshal(map[string]any{"schema": "guest_command_event/v0.2", "event_id": "event-" + nonce(), "request_id": id, "reservation_id": m.token, "owner_id": m.profile.OwnerID, "session": state, "event": "outcome_unknown", "data": map[string]any{"op": active.op, "code": "TRANSPORT"}})
	if m.validate(b) == nil {
		_ = m.emit(b)
	}
	if state != nil {
		m.session, _ = json.Marshal(state)
	}
	for _, item := range m.pending {
		item.done = true
	}
	m.poisoned = true
}

// Reconciliation never sends another guest command. It terminates only the
// already-bound private service using its retained process/cgroup identity.
func (m *Manager) reconcileStop(ctx context.Context, id string, body json.RawMessage) ([]json.RawMessage, error) {
	if _, exists := m.pending[id]; exists {
		return nil, errors.New("stop replay")
	}
	var request struct {
		Params struct {
			Workload   string `json:"workload_id"`
			Generation int64  `json:"generation"`
		} `json:"params"`
	}
	if json.Unmarshal(body, &request) != nil || request.Params.Workload != m.workload || request.Params.Generation != m.generation {
		return nil, errors.New("stop target mismatch")
	}
	if e := writeNew(m.reservation+".reconcile", map[string]any{"request_id": id, "reservation_id": m.token}); e != nil {
		return nil, e
	}
	var state map[string]any
	if json.Unmarshal(m.session, &state) != nil {
		return nil, errors.New("missing uncertain state")
	}
	state["phase"] = "stopping"
	controls, ok := state["controls"].(map[string]any)
	if !ok {
		return nil, errors.New("missing controls")
	}
	controls["stop"] = map[string]any{"request_id": id, "ack": "accepted"}
	makeEvent := func(kind string, data map[string]any) json.RawMessage {
		b, _ := json.Marshal(map[string]any{"schema": "guest_command_event/v0.2", "event_id": "event-" + nonce(), "request_id": id, "reservation_id": m.token, "owner_id": m.profile.OwnerID, "session": state, "event": kind, "data": data})
		return b
	}
	accepted := makeEvent("accepted", map[string]any{"op": "stop"})
	if e := m.validate(accepted); e != nil {
		return nil, e
	}
	m.pending[id] = &pending{op: "stop", accepted: true}
	if e := m.emit(accepted); e != nil {
		return nil, e
	}
	closeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if e := m.child.Close(closeCtx); e != nil {
		return nil, e
	}
	m.child = nil
	if e := writeNew(m.reservation+".closed", map[string]any{"request_id": id, "reservation_id": m.token, "status": "closed"}); e != nil {
		return nil, e
	}
	state["phase"] = "stopped"
	state["ownership"] = "released"
	stopped := makeEvent("stopped", map[string]any{"native_absent": true})
	if e := m.validate(stopped); e != nil {
		return nil, e
	}
	m.session, _ = json.Marshal(state)
	m.pending[id].done = true
	return []json.RawMessage{stopped}, nil
}
func (m *Manager) Close() (result error) {
	if m == nil {
		return nil
	}
	defer func() {
		if m.inventory != nil {
			result = errors.Join(result, m.inventory.Seal())
		}
	}()
	m.mu.Lock()
	m.closing = true
	child := m.child
	m.mu.Unlock()
	if child == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	e := child.Close(ctx)
	if m.readerDone != nil {
		select {
		case <-m.readerDone:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return e
}

// SetInventory is a host-only normal-session binding, installed before Handle.
func (m *Manager) SetInventory(p serviceInventory) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if p == nil || m.attempted || m.closing || m.inventory != nil || p.Actor() != m.profile.OwnerID {
		return errors.New("inventory owner binding")
	}
	m.inventory = p
	return nil
}
