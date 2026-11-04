package daemon

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

func TestRoleSwitchDispatchCorrelatesAndKeepsSurface(t *testing.T) {
	m, _, root := programSubscriptionFixture(t, "human")
	id := subscriptionSurface(t, m, "browser", "static-browser")
	before, err := m.SubscriptionBinding(id)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 1280 * 900 * 4, MaxPixels: 1280 * 900, MaxSurfaces: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer pub.Close()
	h, err := NewHandler(m, pub)
	if err != nil {
		t.Fatal(err)
	}
	for _, role := range []string{"agent", "human"} {
		raw, _ := json.Marshal(roleSwitchRequest{Schema: roleSwitchSchema, RequestID: "switch-" + role, SurfaceID: id, Role: role})
		out, err := h(context.Background(), ipc.Envelope{From: ipc.Endpoint{Component: "core", Instance: "core-test"}, Body: raw})
		if err != nil || len(out) != 2 {
			t.Fatalf("role switch failed: %v %s", err, out)
		}
		var state map[string]any
		var result struct {
			Schema    string `json:"schema"`
			RequestID string `json:"request_id"`
			SurfaceID string `json:"surface_id"`
			Role      string `json:"role"`
			OK        bool   `json:"ok"`
		}
		if json.Unmarshal(out[0], &state) != nil || state["event"] != "state_changed" {
			t.Fatal("state must precede correlated result")
		}
		if json.Unmarshal(out[1], &result) != nil || result.Schema != "metaviewer.role_switch_result/v0.3" || !result.OK || result.RequestID != "switch-"+role || result.SurfaceID != id || result.Role != role {
			t.Fatalf("invalid correlation: %s", out[1])
		}
		after, err := m.SubscriptionBinding(id)
		if err != nil {
			t.Fatal(err)
		}
		if after.Container != before.Container || after.RunID != before.RunID || after.Role != role || after.Surface.Control != role {
			t.Fatal("native lifetime changed")
		}
	}
	for _, from := range []string{"ui", "agent", ""} {
		raw, _ := json.Marshal(roleSwitchRequest{Schema: roleSwitchSchema, RequestID: "forbidden", SurfaceID: id, Role: "agent"})
		if _, err := h(context.Background(), ipc.Envelope{From: ipc.Endpoint{Component: from}, Body: raw}); err == nil {
			t.Fatal("non-core role request admitted")
		}
	}
	raw := json.RawMessage(`{"schema":"metaviewer.role_switch/v0.3","request_id":"bad","surface_id":"` + id + `","role":"agent","extra":true}`)
	if _, err := h(context.Background(), ipc.Envelope{From: ipc.Endpoint{Component: "core"}, Body: raw}); err == nil {
		t.Fatal("unknown key admitted")
	}
}

func TestRoleSwitchDrainsQueuedCaptureBeforeConversion(t *testing.T) {
	m, profiles, root := programSubscriptionFixture(t, "human")
	id := subscriptionSurface(t, m, "browser", "static-browser")
	pub, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 1280 * 900 * 4, MaxPixels: 1280 * 900, MaxSurfaces: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer pub.Close()
	source := &programSubscriptionSource{entered: make(chan string, 2)}
	sub, err := frames.NewSubscriptions(context.Background(), frames.SubscriptionConfig{MaxSubscriptions: 2, PollInterval: time.Millisecond, CaptureTimeout: time.Second, ShutdownTimeout: time.Second}, source, pub, func(context.Context, json.RawMessage) error { t.Error("cancelled old capture emitted"); return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Close(context.Background())
	if err = sub.Subscribe(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	select {
	case <-source.entered:
	case <-time.After(time.Second):
		t.Fatal("capture absent")
	}
	next := func(ctx context.Context, e ipc.Envelope) ([]json.RawMessage, error) {
		if sub.IsSubscribed(id) {
			t.Error("old capture was not drained before conversion")
		}
		return dispatchRoleSwitch(ctx, m, e)
	}
	h := subscriptionHandler(m, profiles, map[string]*frames.Subscriptions{root: sub}, next)
	raw, _ := json.Marshal(roleSwitchRequest{Schema: roleSwitchSchema, RequestID: "drain", SurfaceID: id, Role: "agent"})
	if _, err = h(context.Background(), ipc.Envelope{From: ipc.Endpoint{Component: "core"}, Body: raw}); err != nil {
		t.Fatal(err)
	}
	if !sub.IsSubscribed(id) {
		t.Fatal("capture ownership not restored")
	}
	select {
	case <-source.entered:
	case <-time.After(time.Second):
		t.Fatal("replacement capture absent")
	}
}

func TestRoleSwitchDispatchRefusalDoesNotReportSuccess(t *testing.T) {
	m, _, _ := programSubscriptionFixture(t, "human")
	q := roleSwitchRequest{Schema: roleSwitchSchema, RequestID: "unknown", SurfaceID: "missing", Role: "agent"}
	raw, _ := json.Marshal(q)
	out, err := dispatchRoleSwitch(context.Background(), m, ipc.Envelope{From: ipc.Endpoint{Component: "core"}, Body: raw})
	if err != nil || len(out) != 1 {
		t.Fatal("missing refusal result")
	}
	var result map[string]any
	_ = json.Unmarshal(out[0], &result)
	if result["ok"] != false || result["code"] != "POLICY" || result["request_id"] != "unknown" || result["surface_id"] != "missing" {
		t.Fatalf("invalid refusal %s", out[0])
	}
}

func TestRoleSwitchWireRequiresPublisherBeforeChangingRole(t *testing.T) {
	m, profiles, _ := programSubscriptionFixture(t, "human")
	id := subscriptionSurface(t, m, "browser", "static-browser")
	h := wireHandlerWithoutAdmission(m, profiles, map[string]*frames.Publisher{}, 100)
	raw, _ := json.Marshal(roleSwitchRequest{Schema: roleSwitchSchema, RequestID: "no-publisher", SurfaceID: id, Role: "agent"})
	out, err := h(context.Background(), ipc.Envelope{From: ipc.Endpoint{Component: "core"}, Body: raw})
	if err != nil || len(out) != 1 {
		t.Fatal("expected correlated publisher refusal")
	}
	var result map[string]any
	_ = json.Unmarshal(out[0], &result)
	if result["ok"] != false || result["request_id"] != "no-publisher" {
		t.Fatal("publisher refusal lost correlation")
	}
	b, err := m.SubscriptionBinding(id)
	if err != nil || b.Role != "human" || b.Surface.Control != "human" {
		t.Fatal("publisher refusal changed role")
	}
}
