package capsule

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"reflect"
	"testing"
)

// Mutation: omit the removed_verified condition in stopNative; unverified cases fail.
func TestProgramAndVmDestroy(t *testing.T) {
	for _, kind := range []string{"desktop_capsule", "vm"} {
		for _, proof := range []string{"true", "false", "missing", "foreign"} {
			t.Run(kind+"/"+proof, func(t *testing.T) {
				r := &scriptRunner{}
				m := testManager(t, r)
				p := m.cfg.Profiles["demo"]
				p.Kind, p.NativeKind, p.Program = kind, "program", "notepad"
				container := "srf-pg-demo"
				if kind == "vm" {
					p.NativeKind, p.Program, container = "vm", "notepad-vm", "srf-vm-demo"
				}
				m.cfg.Profiles["demo"] = p
				r.output = []byte(fmt.Sprintf(`{"kind":%q,"container":%q,"run_id":"demo-run","windows":[{"id":"w1","x":0,"y":0,"w":2,"h":1,"title":"","url":""}]}`, p.NativeKind, container))
				events, err := m.Handle(context.Background(), req("create", fmt.Sprintf(`{"kind":%q,"profile_id":"demo","geometry":{"w":2,"h":1}}`, kind)))
				if err != nil || len(events) != 1 || len(m.bindings) != 1 {
					t.Fatalf("create: %s %v", events, err)
				}
				var id string
				for key := range m.bindings {
					id = key
				}
				want := []string{filepath.Join(m.cfg.BinDir, "srf-identity-surface"), "start", "--kind", p.NativeKind, "--identity", "demo", "--windows", "1", "--program", p.Program}
				if len(r.calls) != 1 || !reflect.DeepEqual(r.calls[0], want) {
					t.Fatalf("start argv: %v", r.calls)
				}
				r.output = []byte(fmt.Sprintf(`{"stopped":%q,"removed_verified":%s}`, container, proof))
				if proof == "missing" {
					r.output = []byte(fmt.Sprintf(`{"stopped":%q}`, container))
				}
				if proof == "foreign" {
					r.output = []byte(`{"stopped":"srf-id-foreign","removed_verified":true}`)
				}
				params := `{"surface_id":"` + id + `"}`
				events, err = m.Handle(context.Background(), req("destroy", params))
				if len(r.calls) != 2 || !reflect.DeepEqual(r.calls[1], []string{want[0], "stop", "--container", container}) {
					t.Fatalf("stop argv: %v", r.calls)
				}
				state := "lost"
				if proof == "true" {
					state = "destroyed"
					var ev struct {
						Event string
						Data  struct{ Surface Surface }
					}
					if err != nil || len(events) != 1 {
						t.Fatalf("destroy: %s %v", events, err)
					}
					if err := json.Unmarshal(events[0], &ev); err != nil || ev.Event != "state_changed" || ev.Data.Surface.State != state || ev.Data.Surface.SurfaceID != id {
						t.Fatalf("terminal event: %s %v", events, err)
					}
				} else {
					requireFault(t, err, "malformed_cli")
					if len(events) != 0 {
						t.Fatalf("unverified removal published: %s", events)
					}
				}
				if m.bindings[id].Surface.State != state {
					t.Fatalf("state: %+v", m.bindings[id])
				}
				if _, _, err := m.Capture(context.Background(), id); err == nil {
					t.Fatal("terminal capture accepted")
				}
				if _, err := m.Handle(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"p","action":{"type":"click","x":1,"y":0,"button":"left"}}`)); err == nil {
					t.Fatal("terminal input accepted")
				}
				if len(r.calls) != 2 {
					t.Fatal("terminal access executed CLI")
				}
				if proof == "true" {
					_, err = m.Handle(context.Background(), req("destroy", params))
					requireFault(t, err, "surface")
					if len(r.calls) != 2 {
						t.Fatal("re-destroy executed CLI")
					}
				}
			})
		}
	}
}
