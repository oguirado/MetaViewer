package guestcommand

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

type rewindPlan struct {
	Generation, Epoch    int64
	Phase, Point, Victim string
	Order                int64
	Prior                map[string]int64
}
type RewindManager struct {
	*Manager
	families         map[string]string
	plans            map[string]rewindPlan
	epoch            int64
	phase            string
	rewindSession    json.RawMessage
	expectedWorkload string
}

func NewRewindFromEnv() (*RewindManager, error) {
	if os.Getenv("MV_REWIND_ENABLED") != "1" {
		return nil, errors.New("rewind opt-in required")
	}
	path := os.Getenv("MV_REWIND_PROFILE")
	if path == "" {
		return nil, errors.New("rewind profile required")
	}
	p, e := LoadRewind(path)
	if e != nil {
		return nil, e
	}
	if g := os.Getenv("MV_REWIND_GUARDIAN_UNIT"); g != "" && g != p.GuardianUnit {
		return nil, errors.New("rewind guardian conflict")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if e = verifyGuardian(ctx, p); e != nil {
		return nil, e
	}
	marker := filepath.Join(p.StateRoot, "rewind-reservation.json")
	if _, e = os.Lstat(marker); !os.IsNotExist(e) {
		return nil, errors.New("prior rewind requires reconciliation")
	}
	return &RewindManager{Manager: &Manager{profile: p, factory: startService, reservation: marker, pending: map[string]*pending{}, seen: map[string]bool{}}, families: map[string]string{}, plans: map[string]rewindPlan{}, epoch: 1, phase: "new"}, nil
}
func pointID(session, workload, request string) string {
	h := sha256.New()
	for _, value := range []string{session, workload, request} {
		var size [8]byte
		binary.BigEndian.PutUint64(size[:], uint64(len([]byte(value))))
		h.Write(size[:])
		h.Write([]byte(value))
	}
	return "point-" + hex.EncodeToString(h.Sum(nil))
}
func (r *RewindManager) refusal(id, op, code, family, session string) json.RawMessage {
	if family == "guest_command_request/v0.2" {
		return r.Manager.refusal(id, op, code, session)
	}
	b, _ := json.Marshal(map[string]any{"schema": "rewind_event/v0.2", "event_id": "event-" + nonce(), "request_id": id, "owner_id": r.profile.OwnerID, "event": "refused", "session": nil, "data": map[string]any{"op": op, "code": code}})
	return b
}
func (r *RewindManager) Handle(ctx context.Context, body json.RawMessage, session string, validate, emit func(json.RawMessage) error) ([]json.RawMessage, error) {
	var q struct {
		Schema string `json:"schema"`
		ID     string `json:"request_id"`
		Op     string `json:"op"`
		Params struct {
			Workload   string `json:"workload_id"`
			Generation int64  `json:"generation"`
			Epoch      int64  `json:"authority_epoch"`
			Point      string `json:"point_id"`
		} `json:"params"`
	}
	if json.Unmarshal(body, &q) != nil || (q.Schema != "guest_command_request/v0.2" && q.Schema != "rewind_request/v0.2") || q.ID == "" || session == "" || validate == nil || emit == nil {
		return nil, errors.New("authenticated rewind owner request required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	refuse := func(code string) ([]json.RawMessage, error) {
		return []json.RawMessage{r.refusal(q.ID, q.Op, code, q.Schema, session)}, nil
	}
	if r.sessionID != "" && r.sessionID != session {
		return nil, errors.New("foreign core session")
	}
	if r.closing {
		return nil, errors.New("owner closing")
	}
	if _, ok := r.pending[q.ID]; ok {
		return refuse("DUPLICATE")
	}
	// Reserve the last history slot for the existing authenticated Stop path.
	cleanup := q.Schema == "guest_command_request/v0.2" && q.Op == "stop"
	if len(r.pending) >= 256 || (len(r.pending) >= 255 && !cleanup) {
		return refuse("CAPACITY")
	}
	if q.Op == "cancel" {
		return refuse("UNAVAILABLE")
	}
	if r.poisoned {
		if q.Schema == "guest_command_request/v0.2" && q.Op == "stop" && r.child != nil && len(r.session) > 0 {
			return r.reconcileStop(ctx, q.ID, body)
		}
		return nil, errors.New("owner transport uncertain")
	}
	for _, p := range r.pending {
		if !p.done && (q.Op != "stop" || p.op == "stop") {
			return refuse("BUSY")
		}
	}
	plan := rewindPlan{Generation: r.generation, Epoch: r.epoch, Phase: r.phase}
	if q.Schema == "guest_command_request/v0.2" && q.Op == "create" {
		if r.attempted {
			return refuse("BUSY")
		}
		var admitted struct {
			Value bool `json:"runtime_admitted"`
		}
		if json.Unmarshal(r.profile.ConfigTemplate, &admitted) != nil || !admitted.Value {
			return refuse("UNAVAILABLE")
		}
		r.attempted = true
		r.sessionID = session
		r.createID = q.ID
		r.token = reservationID(session, q.ID)
		r.emit = emit
		r.validate = validate
		r.generation = 1
		r.epoch = 1
		r.expectedWorkload = "workload-" + nonce()
		r.phase = "initializing"
		plan = rewindPlan{Generation: 1, Epoch: 1, Phase: "ready"}
		r.pending[q.ID] = &pending{body: append(json.RawMessage(nil), body...), op: q.Op}
		r.families[q.ID] = q.Schema
		r.plans[q.ID] = plan
		attempt, unit, e := r.prepare()
		if e != nil {
			r.poisoned = true
			return nil, e
		}
		factoryCtx := ctx
		if r.inventory != nil {
			if e = r.inventory.ServicePending(unit, unit); e != nil {
				r.poisoned = true
				return nil, e
			}
			factoryCtx = context.WithValue(ctx, inventoryContextKey{}, r.inventory)
		}
		r.child, e = r.factory(factoryCtx, r.profile, attempt, unit)
		if e != nil {
			r.poisoned = true
			return nil, e
		}
		r.readerDone = make(chan struct{})
		go r.receiveRewind(ctx)
	} else {
		if r.child == nil {
			return refuse("UNAVAILABLE")
		}
		if q.Params.Workload != r.workload || q.Params.Generation != r.generation {
			return refuse("STALE")
		}
		if q.Schema == "rewind_request/v0.2" {
			if q.Params.Epoch != r.epoch {
				return refuse("STALE")
			}
			if r.phase != "ready" && r.phase != "paused" && !(r.phase == "recoverable" && q.Op == "restore") {
				return refuse("BUSY")
			}
			switch q.Op {
			case "pause":
				if r.phase != "ready" {
					return refuse("BUSY")
				}
				plan.Phase = "paused"
			case "mark":
				plan.Point = pointID(session, r.workload, q.ID)
				plan.Phase = r.phase
				var old struct {
					Points []struct {
						ID    string `json:"point_id"`
						Order int64  `json:"created_order"`
						Refs  int    `json:"active_references"`
					} `json:"points"`
				}
				if len(r.rewindSession) > 0 && json.Unmarshal(r.rewindSession, &old) != nil {
					return refuse("INVALID")
				}
				plan.Prior = map[string]int64{}
				plan.Order = 1
				var victimOrder int64
				for _, point := range old.Points {
					plan.Prior[point.ID] = point.Order
					if point.Order >= plan.Order {
						plan.Order = point.Order + 1
					}
					if point.Refs == 0 && (plan.Victim == "" || point.Order < victimOrder || point.Order == victimOrder && point.ID < plan.Victim) {
						plan.Victim = point.ID
						victimOrder = point.Order
					}
				}
				if len(old.Points) < 2 {
					plan.Victim = ""
				} else if len(old.Points) != 2 || plan.Victim == "" {
					return refuse("CAPACITY")
				}
				if r.phase == "ready" {
					plan.Generation++
					plan.Epoch++
				}
			case "resume":
				if r.phase != "paused" {
					return refuse("BUSY")
				}
				plan.Generation++
				plan.Epoch++
				plan.Phase = "ready"
			case "restore":
				plan.Generation++
				plan.Epoch++
				plan.Phase = "ready"
				plan.Point = q.Params.Point
			default:
				return refuse("INVALID")
			}
			if plan.Generation > 9007199254740991 || plan.Epoch > 9007199254740991 {
				return refuse("CAPACITY")
			}
			r.generation = plan.Generation
			r.epoch = plan.Epoch
			if len(r.session) > 0 {
				var state map[string]any
				if json.Unmarshal(r.session, &state) == nil {
					state["generation"] = r.generation
					r.session, _ = json.Marshal(state)
				}
			}
		} else if q.Op != "stop" && r.phase != "ready" {
			return refuse("BUSY")
		}
		r.pending[q.ID] = &pending{body: append(json.RawMessage(nil), body...), op: q.Op}
		r.families[q.ID] = q.Schema
		r.plans[q.ID] = plan
	}
	guestWorkload := r.workload
	if guestWorkload == "" {
		guestWorkload = r.expectedWorkload
	}
	sum := sha256.Sum256([]byte(session + "\x00" + q.ID))
	privateBinding := map[string]any{"owner_id": r.profile.OwnerID, "workload_id": guestWorkload, "generation": plan.Generation, "authority_epoch": plan.Epoch, "session_id": "session-" + hex.EncodeToString(sum[:]), "reservation_id": reservationID(session, q.ID)}
	packet, _ := json.Marshal(map[string]any{"request": json.RawMessage(body), "binding": privateBinding, "point_id": plan.Point, "public_reservation": r.token})
	sendCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if e := r.child.Send(sendCtx, packet); e != nil {
		r.poisoned = true
		return nil, e
	}
	return nil, nil
}
func (r *RewindManager) receiveRewind(ctx context.Context) {
	defer close(r.readerDone)
	for {
		body, e := r.child.Read(ctx)
		r.mu.Lock()
		if r.closing {
			r.mu.Unlock()
			return
		}
		if e != nil {
			r.failRewind()
			r.mu.Unlock()
			return
		}
		e = r.consumeRewind(ctx, body)
		if e != nil {
			r.failRewind()
			r.mu.Unlock()
			return
		}
		done := r.child == nil
		r.mu.Unlock()
		if done {
			return
		}
	}
}
func (r *RewindManager) consumeRewind(ctx context.Context, body json.RawMessage) error {
	var e struct {
		Schema, Event string
		ID            string          `json:"request_id"`
		EventID       string          `json:"event_id"`
		Owner         string          `json:"owner_id"`
		Session       json.RawMessage `json:"session"`
		Data          struct {
			Op, Code string
			Point    string `json:"point_id"`
			Absent   bool   `json:"no_active_vmm"`
			Failed   string `json:"failed_request_id"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &e) != nil {
		return errors.New("event JSON")
	}
	if e.Schema == "guest_command_event/v0.2" {
		if string(e.Session) != "null" {
			var target struct {
				Workload   string `json:"workload_id"`
				Generation int64  `json:"generation"`
			}
			if json.Unmarshal(e.Session, &target) != nil || target.Workload != r.expectedWorkload || target.Generation != r.generation {
				return errors.New("guest binding drift")
			}
		}
		if r.families[e.ID] != "guest_command_request/v0.2" {
			return errors.New("cross-family guest event")
		}
		if err := r.Manager.consumeLocked(ctx, body); err != nil {
			return err
		}
		if e.Event == "ready" {
			r.phase = "ready"
		}
		if e.Event == "stopped" {
			r.phase = "stopped"
		}
		if e.Event == "outcome_unknown" {
			r.phase = "uncertain"
		}
		return nil
	}
	if e.Schema != "rewind_event/v0.2" || r.validate(body) != nil || e.Owner != r.profile.OwnerID || r.families[e.ID] != "rewind_request/v0.2" || r.seen[e.EventID] || len(r.seen) >= 8192 {
		return errors.New("rewind event authority")
	}
	p := r.pending[e.ID]
	plan, ok := r.plans[e.ID]
	if p == nil || !ok || p.done && e.Event != "recovery_ready" {
		return errors.New("rewind correlation")
	}
	var s struct {
		Workload   string `json:"workload_id"`
		Owner      string `json:"owner_id"`
		Generation int64  `json:"generation"`
		Epoch      int64  `json:"authority_epoch"`
		Phase      string `json:"phase"`
		Ownership  string `json:"ownership"`
		LastGood   string `json:"last_good_usable"`
		Points     []struct {
			ID    string `json:"point_id"`
			Order int64  `json:"created_order"`
			Refs  int    `json:"active_references"`
		} `json:"points"`
	}
	if string(e.Session) != "null" {
		if json.Unmarshal(e.Session, &s) != nil || s.Workload != r.workload || s.Owner != r.profile.OwnerID || s.Generation != plan.Generation || s.Epoch != plan.Epoch || s.Ownership != "held" {
			return errors.New("rewind binding changed")
		}
	}
	stopPending := false
	for _, pending := range r.pending {
		if pending.op == "stop" && !pending.done {
			stopPending = true
		}
	}
	switch e.Event {
	case "accepted":
		expectedPhase := map[string]string{"pause": "pausing", "resume": "resuming", "mark": "marking", "restore": "restoring"}[p.op]
		if p.accepted || e.Data.Op != p.op || (s.Phase != expectedPhase && !(stopPending && s.Phase == "stopping")) {
			return errors.New("rewind acceptance")
		}
		p.accepted = true
	case "completed":
		if !p.accepted || e.Data.Op != p.op || (s.Phase != plan.Phase && !(stopPending && s.Phase == "stopping")) || ((p.op == "mark" || p.op == "restore") && e.Data.Point != plan.Point) {
			return errors.New("rewind completion")
		}
		if p.op == "mark" {
			expected := map[string]int64{}
			for id, order := range plan.Prior {
				if id != plan.Victim {
					expected[id] = order
				}
			}
			expected[plan.Point] = plan.Order
			if len(s.Points) != len(expected) {
				return errors.New("mark ring shape")
			}
			for _, point := range s.Points {
				if expected[point.ID] != point.Order {
					return errors.New("mark ring changed")
				}
				delete(expected, point.ID)
			}
			if len(expected) != 0 {
				return errors.New("mark point missing")
			}
		}
		if p.op == "restore" {
			if s.LastGood != plan.Point {
				return errors.New("restore last-good")
			}
			for _, point := range s.Points {
				want := 0
				if point.ID == plan.Point {
					want = 1
				}
				if point.Refs != want {
					return errors.New("restore reference")
				}
			}
		}
		p.done = true
		r.phase = s.Phase
	case "refused":
		if p.accepted || e.Data.Op != p.op {
			return errors.New("late rewind refusal")
		}
		p.done = true
	case "outcome_unknown":
		if e.Data.Op != p.op || s.Phase != "uncertain" {
			return errors.New("rewind unknown")
		}
		p.done = true
		r.phase = "uncertain"
	case "recovery_ready":
		if r.phase != "uncertain" || p.op != "restore" || !p.done || !e.Data.Absent || e.Data.Failed != e.ID || e.Data.Point != plan.Point || s.LastGood != plan.Point || s.Phase != "recoverable" {
			return errors.New("unproven recovery")
		}
		for _, point := range s.Points {
			if point.Refs != 0 {
				return errors.New("recovery still mapped")
			}
		}
		r.phase = "recoverable"
	default:
		return errors.New("rewind event kind")
	}
	if string(e.Session) != "null" {
		r.rewindSession = append(json.RawMessage(nil), e.Session...)
	}
	r.seen[e.EventID] = true
	return r.emit(body)
}
func (r *RewindManager) failRewind() {
	r.poisoned = true
	r.phase = "uncertain"
	hasRewindPending := false
	for id, p := range r.pending {
		if !p.done && r.families[id] == "rewind_request/v0.2" {
			hasRewindPending = true
		}
	}
	if len(r.rewindSession) == 0 || !hasRewindPending {
		saved := r.pending
		filtered := map[string]*pending{}
		for id, p := range saved {
			if r.families[id] == "guest_command_request/v0.2" {
				filtered[id] = p
			}
		}
		r.pending = filtered
		r.Manager.failLocked()
		r.pending = saved
		for _, p := range r.pending {
			p.done = true
		}
		return
	}
	for id, p := range r.pending {
		if p.done || r.families[id] != "rewind_request/v0.2" {
			continue
		}
		var state map[string]any
		_ = json.Unmarshal(r.rewindSession, &state)
		state["phase"] = "uncertain"
		state["generation"] = r.generation
		state["authority_epoch"] = r.epoch
		state["pending_request_id"] = id
		b, _ := json.Marshal(map[string]any{"schema": "rewind_event/v0.2", "event_id": "event-" + nonce(), "request_id": id, "owner_id": r.profile.OwnerID, "event": "outcome_unknown", "session": state, "data": map[string]any{"op": p.op, "code": "TRANSPORT"}})
		if r.validate(b) == nil {
			_ = r.emit(b)
		}
		p.done = true
	}
}
