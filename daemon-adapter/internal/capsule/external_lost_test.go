package capsule

import (
	"context"
	"encoding/json"
	"testing"

	"metaviewer/daemon-adapter/internal/cli"
)

// The admitted CLI has no liveness/list reply contract. Exercise reconciliation
// after an owner proves absence, and uncertain stop after an external kill.
// Mutation: remove destroy's pre-stop lost assignment; uncertain cases fail.
func TestExternalLossReconciliation(t *testing.T) {
	for _, mode := range []string{"confirmed-absent", "ambiguous-stop", "unavailable-stop", "verified-stop"} {
		t.Run(mode, func(t *testing.T) {
			r := &scriptRunner{output: []byte(startOK)}
			m := testManager(t, r)
			id := createID(t, m)
			if _, err := m.MarkLost(id, false); err == nil {
				t.Fatal("unproven absence admitted")
			}
			if m.bindings[id].Surface.State != "active" || len(r.calls) != 1 {
				t.Fatal("unproven absence mutated state or executed CLI")
			}
			state := "lost"
			if mode == "confirmed-absent" {
				ev, err := m.MarkLost(id, true)
				var changed struct {
					Event string
					Data  struct{ Surface Surface }
				}
				if err != nil || json.Unmarshal(ev, &changed) != nil || changed.Event != "state_changed" || changed.Data.Surface.State != "lost" || changed.Data.Surface.SurfaceID != id {
					t.Fatalf("loss event: %s %v", ev, err)
				}
				if ev, err := m.MarkLost(id, true); err != nil || len(ev) != 0 {
					t.Fatalf("repeated loss: %s %v", ev, err)
				}
			} else {
				r.output = []byte(`{"stopped":"srf-id-demo","removed_verified":true}`)
				if mode == "ambiguous-stop" {
					r.err = &cli.Fault{Code: "uncertain", Detail: "stop outcome unknown"}
				}
				if mode == "unavailable-stop" {
					r.err = cli.ExitFault("srf-identity-surface", 4, "")
				}
				_, err := m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`))
				switch mode {
				case "verified-stop":
					state = "destroyed"
					if err != nil {
						t.Fatal(err)
					}
				case "ambiguous-stop":
					requireFault(t, err, "uncertain")
				case "unavailable-stop":
					requireFault(t, err, "unavailable")
				}
			}
			if m.bindings[id].Surface.State != state {
				t.Fatalf("external loss silently active: %+v", m.bindings[id])
			}
			n := len(r.calls)
			if _, _, err := m.Capture(context.Background(), id); err == nil {
				t.Fatal("capture after loss admitted")
			}
			if _, err := m.Handle(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"loss","action":{"type":"click","x":0,"y":0,"button":"left"}}`)); err == nil {
				t.Fatal("input after loss admitted")
			}
			if len(r.calls) != n {
				t.Fatal("terminal access invoked native CLI")
			}
			out, err := m.Handle(context.Background(), req("list", `{}`))
			if err != nil {
				t.Fatal(err)
			}
			if state == "destroyed" && len(out) != 0 {
				t.Fatalf("destroyed surface listed: %s", out)
			}
			if state == "lost" {
				var listed struct{ Data struct{ Surface Surface } }
				if len(out) != 1 || json.Unmarshal(out[0], &listed) != nil || listed.Data.Surface.State != "lost" {
					t.Fatalf("lost surface hidden: %s", out)
				}
			}
		})
	}
}
