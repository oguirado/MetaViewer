package capsule

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type graphicalTestRunner func(context.Context, []string, []byte) ([]byte, error)

func (f graphicalTestRunner) Run(c context.Context, a []string, b []byte) ([]byte, error) {
	return f(c, a, b)
}
func graphicalTestManager(t *testing.T) (*Manager, string) {
	t.Helper()
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	id := createID(t, m)
	b := m.bindings[id]
	b.NativeKind = "vm"
	b.Program = "notepad-rw-vm"
	m.bindings[id] = b
	m.cfg.GraphicalSessions = true
	return m, id
}
func graphicalTestRequest(id, op, request, point string) []byte {
	q := GraphicalRequest{Schema: "graphical_session_request/v0.2", RequestID: "request-" + request, OwnerID: "actor-test", SurfaceID: id, Op: op, Params: json.RawMessage(`{}`)}
	if op != "attach" {
		n := uint64(1)
		q.Generation = &n
		q.AuthorityEpoch = &n
		if op == "mark" {
			q.Params = json.RawMessage(`{"label":"checkpoint"}`)
		} else {
			q.Params, _ = json.Marshal(map[string]string{"point_id": point})
		}
	}
	raw, _ := json.Marshal(q)
	return raw
}
func graphicalTestNative(op, point, status string, gen uint64) []byte {
	var p, h any
	if point != "" {
		p = point
		h = strings.Repeat("a", 64)
	}
	var code any
	if status != "ready" {
		code = 7
	}
	raw, _ := json.Marshal(map[string]any{"schema": "graphical_native/v1", "runtime_id": "runtime-" + strings.Repeat("b", 64), "generation": gen, "op": op, "point_id": p, "manifest_sha256": h, "elapsed_ms": 1, "status": status, "code": code})
	return raw
}
func graphicalTestEvent(t *testing.T, m *Manager, raw []byte, pub func(Binding, NativeFrame) (string, uint64, error)) GraphicalEvent {
	t.Helper()
	out, err := m.HandleGraphicalSession(context.Background(), raw, pub)
	if err != nil {
		t.Fatal(err)
	}
	var e GraphicalEvent
	if err = json.Unmarshal(out, &e); err != nil {
		t.Fatalf("event %s: %v", out, err)
	}
	return e
}
func graphicalTestAttach(t *testing.T, m *Manager, id string) {
	t.Helper()
	m.runner = graphicalTestRunner(func(context.Context, []string, []byte) ([]byte, error) {
		return graphicalTestNative("attach", "", "ready", 1), nil
	})
	e := graphicalTestEvent(t, m, graphicalTestRequest(id, "attach", "attach", ""), nil)
	if e.Event != "completed" {
		t.Fatalf("attach %+v", e)
	}
	m.CompleteGraphicalEmission(id, e.RequestID, true)
}

func TestGraphicalNativeABIPointsRestoreAndEmission(t *testing.T) {
	m, id := graphicalTestManager(t)
	graphicalTestAttach(t, m, id)
	var points []string
	for i := 0; i < 2; i++ {
		m.runner = graphicalTestRunner(func(_ context.Context, a []string, _ []byte) ([]byte, error) {
			point := a[len(a)-1]
			if len(point) > 32 || strings.ContainsAny(point, "._") {
				t.Errorf("native-incompatible point %q", point)
			}
			return graphicalTestNative("mark", point, "ready", 1), nil
		})
		e := graphicalTestEvent(t, m, graphicalTestRequest(id, "mark", fmt.Sprintf("mark-%d", i), ""), nil)
		if e.Event != "completed" || e.PointID == nil {
			t.Fatalf("mark %+v", e)
		}
		points = append(points, *e.PointID)
		if !m.graphical.busy {
			t.Fatal("released before emission")
		}
		m.CompleteGraphicalEmission(id, e.RequestID, true)
	}
	b := m.bindings[id]
	m.runner = graphicalTestRunner(func(_ context.Context, a []string, _ []byte) ([]byte, error) {
		if a[1] == "frame" {
			return json.Marshal(NativeFrame{Path: filepath.Join(b.FramesRoot, "fresh.png"), Seq: 1, Generation: b.Container, Width: 2, Height: 1, SHA256RGB24: strings.Repeat("c", 64), CaptureMonoNS: 200, Window: &Window{ID: b.Window, W: 2, H: 1}})
		}
		return graphicalTestNative("restore", points[0], "ready", 2), nil
	})
	published := false
	e := graphicalTestEvent(t, m, graphicalTestRequest(id, "restore", "restore", points[0]), func(_ Binding, _ NativeFrame) (string, uint64, error) {
		published = true
		if !m.graphical.busy {
			t.Fatal("publisher unguarded")
		}
		return strings.Repeat("d", 64), 3, nil
	})
	if !published || e.Event != "completed" || e.FrameGeneration == nil || *e.FrameGeneration != 3 || e.Generation != 2 {
		t.Fatalf("restore %+v published=%v", e, published)
	}
	if _, _, err := m.Capture(context.Background(), id); err == nil {
		t.Fatal("capture allowed before completion delivery")
	}
	m.CompleteGraphicalEmission(id, e.RequestID, false)
	if !m.graphical.unknown {
		t.Fatal("failed completion delivery not fenced")
	}
}

func TestGraphicalRefusalReplayCapacityAndMalformed(t *testing.T) {
	for _, mode := range []string{"refused", "runtime", "generation", "manifest", "duplicate", "missing-status", "missing-elapsed", "missing-code"} {
		t.Run(mode, func(t *testing.T) {
			m, id := graphicalTestManager(t)
			graphicalTestAttach(t, m, id)
			m.runner = graphicalTestRunner(func(_ context.Context, a []string, _ []byte) ([]byte, error) {
				raw := graphicalTestNative("mark", a[len(a)-1], "ready", 1)
				switch mode {
				case "refused":
					raw = graphicalTestNative("mark", a[len(a)-1], "refused", 1)
				case "runtime":
					raw = []byte(strings.Replace(string(raw), strings.Repeat("b", 64), strings.Repeat("c", 64), 1))
				case "generation":
					raw = []byte(strings.Replace(string(raw), `"generation":1`, `"generation":2`, 1))
				case "manifest":
					raw = []byte(strings.Replace(string(raw), strings.Repeat("a", 64), "bad", 1))
				case "duplicate":
					raw = []byte(strings.Replace(string(raw), `"status":"ready"`, `"status":"ready","status":"ready"`, 1))
				case "missing-status":
					var x map[string]any
					json.Unmarshal(raw, &x)
					delete(x, "status")
					raw, _ = json.Marshal(x)
				case "missing-elapsed", "missing-code":
					var x map[string]any
					json.Unmarshal(raw, &x)
					if mode == "missing-elapsed" {
						delete(x, "elapsed_ms")
					} else {
						delete(x, "code")
					}
					raw, _ = json.Marshal(x)
				}
				return raw, nil
			})
			e := graphicalTestEvent(t, m, graphicalTestRequest(id, "mark", "negative", ""), nil)
			if mode == "refused" {
				if e.Event != "refused" || m.graphical.unknown {
					t.Fatalf("typed refusal lost: %+v", e)
				}
			} else if e.Event != "outcome_unknown" || !m.graphical.unknown {
				t.Fatalf("malformed result not fenced %+v", e)
			}
			if mode != "refused" {
				if _, _, err := m.Capture(context.Background(), id); err == nil {
					t.Fatal("unknown capture admitted")
				}
				params, _ := jsonParams(id, "blocked", "human", map[string]any{"type": "click", "x": 0, "y": 0, "button": "left"})
				if _, err := m.Handle(context.Background(), req("input", params)); err == nil {
					t.Fatal("unknown input admitted")
				}
			}
		})
	}
	m, id := graphicalTestManager(t)
	graphicalTestAttach(t, m, id)
	e := graphicalTestEvent(t, m, graphicalTestRequest(id, "attach", "attach", ""), nil)
	if e.Event != "refused" {
		t.Fatal("replay admitted")
	}
	for i := 0; i < 4; i++ {
		m.graphical.session.Points = append(m.graphical.session.Points, GraphicalPoint{PointID: fmt.Sprint(i)})
	}
	e = graphicalTestEvent(t, m, graphicalTestRequest(id, "mark", "capacity", ""), nil)
	if e.ReasonCode == nil || *e.ReasonCode != "CAPACITY" {
		t.Fatal("point cap")
	}
	m.graphical.session.Points = nil
	for i := 0; i < 128; i++ {
		m.graphical.requests[fmt.Sprint(i)] = true
	}
	e = graphicalTestEvent(t, m, graphicalTestRequest(id, "mark", "requests", ""), nil)
	if e.ReasonCode == nil || *e.ReasonCode != "CAPACITY" {
		t.Fatal("request cap")
	}
}

func TestGraphicalExactVariantOwnerAndCaptureDrain(t *testing.T) {
	for _, mutation := range []string{"disabled", "browser", "legacy-vm", "inactive"} {
		t.Run(mutation, func(t *testing.T) {
			m, id := graphicalTestManager(t)
			b := m.bindings[id]
			switch mutation {
			case "disabled":
				m.cfg.GraphicalSessions = false
			case "browser":
				b.NativeKind = "browser"
			case "legacy-vm":
				b.Program = "notepad-vm"
			case "inactive":
				b.Surface.State = "lost"
			}
			m.bindings[id] = b
			m.runner = graphicalTestRunner(func(context.Context, []string, []byte) ([]byte, error) {
				t.Fatal("ineligible binding executed")
				return nil, nil
			})
			e := graphicalTestEvent(t, m, graphicalTestRequest(id, "attach", "ineligible", ""), nil)
			if e.Event != "refused" {
				t.Fatal("ineligible binding attached")
			}
		})
	}
	m, id := graphicalTestManager(t)
	graphicalTestAttach(t, m, id)
	raw := strings.Replace(string(graphicalTestRequest(id, "mark", "owner", "")), "actor-test", "actor-stranger", 1)
	if e := graphicalTestEvent(t, m, []byte(raw), nil); e.Event != "refused" {
		t.Fatal("owner mismatch accepted")
	}
	m.mu.Lock()
	m.graphicalCaptures = map[string]int{id: 1}
	m.mu.Unlock()
	called := make(chan struct{}, 1)
	done := make(chan struct{})
	m.runner = graphicalTestRunner(func(_ context.Context, a []string, _ []byte) ([]byte, error) {
		called <- struct{}{}
		return graphicalTestNative("mark", a[len(a)-1], "ready", 1), nil
	})
	go func() {
		defer close(done)
		m.HandleGraphicalSession(context.Background(), graphicalTestRequest(id, "mark", "drain", ""), nil)
	}()
	deadline := time.After(time.Second)
	for {
		m.mu.Lock()
		busy := m.graphical.busy
		m.mu.Unlock()
		if busy {
			break
		}
		select {
		case <-deadline:
			t.Fatal("operation never fenced")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	select {
	case <-called:
		t.Fatal("native called before admitted captures drained")
	default:
	}
	m.mu.Lock()
	m.graphicalCaptures[id] = 0
	m.mu.Unlock()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("capture drain did not release operation")
	}
	select {
	case <-called:
	default:
		t.Fatal("native operation missing after drain")
	}
}

func TestGraphicalStopCancelsLateOperationAndAllowsNewBinding(t *testing.T) {
	m, id := graphicalTestManager(t)
	graphicalTestAttach(t, m, id)
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	m.runner = graphicalTestRunner(func(ctx context.Context, a []string, _ []byte) ([]byte, error) {
		if a[1] == "stop" {
			return []byte(`{"stopped":"srf-id-demo","removed_verified":true}`), nil
		}
		close(entered)
		<-ctx.Done()
		<-release
		return graphicalTestNative("mark", a[len(a)-1], "ready", 1), nil
	})
	go func() {
		defer close(done)
		m.HandleGraphicalSession(context.Background(), graphicalTestRequest(id, "mark", "late", ""), nil)
	}()
	<-entered
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := m.Handle(ctx, req("destroy", fmt.Sprintf(`{"surface_id":%q}`, id))); err != nil {
		t.Fatal(err)
	}
	if m.graphical != nil {
		t.Fatal("destroy retained graphical custody")
	}
	old := m.bindings[id]
	old.Surface.SurfaceID = "surface-new"
	old.Surface.State = "active"
	old.RunID = "new-run"
	m.bindings[old.Surface.SurfaceID] = old
	graphicalTestAttach(t, m, old.Surface.SurfaceID)
	newState := m.graphical
	close(release)
	<-done
	if m.graphical != newState || m.graphical.session.SurfaceID != old.Surface.SurfaceID {
		t.Fatal("late old operation replaced fresh custody")
	}
}

func TestGraphicalPublisherFailureHoldsUnknown(t *testing.T) {
	m, id := graphicalTestManager(t)
	graphicalTestAttach(t, m, id)
	p := "point-before"
	m.graphical.session.Points = []GraphicalPoint{{PointID: p, ManifestSHA256: strings.Repeat("a", 64)}}
	b := m.bindings[id]
	m.runner = graphicalTestRunner(func(_ context.Context, a []string, _ []byte) ([]byte, error) {
		if a[1] == "frame" {
			return json.Marshal(NativeFrame{Path: filepath.Join(b.FramesRoot, "fresh.png"), Seq: 1, Generation: b.Container, Width: 2, Height: 1, SHA256RGB24: strings.Repeat("c", 64), CaptureMonoNS: 200, Window: &Window{ID: b.Window, W: 2, H: 1}})
		}
		return graphicalTestNative("restore", p, "ready", 2), nil
	})
	e := graphicalTestEvent(t, m, graphicalTestRequest(id, "restore", "failure", p), func(Binding, NativeFrame) (string, uint64, error) { return "", 0, errors.New("delivery failed") })
	if e.Event != "outcome_unknown" || !m.graphical.unknown {
		t.Fatalf("failed publish escaped fence %+v", e)
	}
}
