package capsule

import (
	"context"
	"encoding/json"
	"errors"
	"metaviewer/daemon-adapter/internal/cli"
	"testing"
)

func TestHumanRoleCreatedWithoutAgentWindow(t *testing.T) {
	r := &scriptRunner{output: []byte(`{"container":"srf-id-demo","run_id":"demo-run","windows":[{"id":"w1","x":0,"y":0,"w":1280,"h":900,"title":"","url":""}]}`)}
	m := testManager(t, r)
	p := m.cfg.Profiles["demo"]
	p.Role = "human"
	p.Width = 1280
	p.Height = 900
	m.cfg.Profiles["demo"] = p
	events, err := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":1280,"h":900}}`))
	if err != nil {
		t.Fatal(err)
	}
	var event struct {
		Data struct {
			Surface Surface `json:"surface"`
		} `json:"data"`
	}
	if err = json.Unmarshal(events[0], &event); err != nil {
		t.Fatal(err)
	}
	id := event.Data.Surface.SurfaceID
	if event.Data.Surface.Control != "human" || m.bindings[id].Role != "human" {
		t.Fatal("human role was exposed to agent")
	}
	before := len(r.calls)
	for _, origin := range []string{"agent", "human"} {
		params, _ := jsonParams(id, "proposal-"+origin, origin, map[string]any{"type": "key", "keys": []string{"Tab"}})
		_, err = m.Handle(context.Background(), req("input", params))
		var f *cli.Fault
		if !errors.As(err, &f) || f.Code != "POLICY" {
			t.Fatalf("native %s input admitted: %v", origin, err)
		}
	}
	for _, op := range []string{"release_control", "take_control"} {
		params := `{"surface_id":"` + id + `"}`
		if op == "take_control" {
			params = `{"surface_id":"` + id + `","owner":"human"}`
		}
		_, err = m.Handle(context.Background(), req(op, params))
		var f *cli.Fault
		if !errors.As(err, &f) || f.Code != "POLICY" {
			t.Fatalf("role switch admitted: %v", err)
		}
	}
	if len(r.calls) != before {
		t.Fatal("refused role input reached native runner")
	}
}
