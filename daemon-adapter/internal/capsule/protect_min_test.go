package capsule

import (
	"context"
	"strings"
	"testing"
)

func TestProtectMinCleanupRecord(t *testing.T) {
	for _, recorded := range []bool{false, true} {
		t.Run(map[bool]string{false: "unrecorded", true: "recorded"}[recorded], func(t *testing.T) {
			m := testManager(t, &scriptRunner{})
			starts, stops := 0, 0
			m.runner = a2Runner(func(_ context.Context, args []string, _ []byte) ([]byte, error) {
				switch args[1] {
				case "start":
					starts++
					pending, ok := m.creates["demo"]
					if !ok || pending.Container != "srf-id-demo" || pending.Generation == "" {
						t.Fatal("missing pre-dispatch pending create")
					}
					if !recorded {
						delete(m.creates, "demo")
					}
					return []byte(strings.Replace(startOK, `"w":2`, `"w":0`, 1)), nil
				case "stop":
					stops++
					return []byte(`{"stopped":"srf-id-demo","removed_verified":true}`), nil
				default:
					t.Fatalf("unexpected command: %v", args)
					return nil, nil
				}
			})
			out, err := m.Handle(context.Background(), req("create", createDemo))
			if len(out) != 0 || starts != 1 {
				t.Fatalf("invalid readiness published or start count incorrect: %s, %d", out, starts)
			}
			if recorded {
				requireFault(t, err, "malformed_cli")
				if stops != 1 || m.quarantined["demo"] {
					t.Fatalf("recorded cleanup: stops=%d quarantine=%v", stops, m.quarantined["demo"])
				}
			} else {
				requireFault(t, err, "uncertain")
				if stops != 0 || !m.quarantined["demo"] {
					t.Fatalf("unrecorded cleanup: stops=%d quarantine=%v", stops, m.quarantined["demo"])
				}
			}
		})
	}
}

func TestProtectMinAllVerbs(t *testing.T) {
	// Keep the expected list independent of the implementation: deleting any
	// compiled name must fail this matrix. Unknown verbs test the common guard.
	names := []string{"srf-id-cuentas-1", "srf-id-perplexity-1", "srf-pg-notepad-1", "srf-pg-metaviewer-1", "srf-egress-proxy", "n8n", "distil-box"}
	verbs := []string{"stop", "destroy", "capture", "frame", "input", "observe", "ax", "net", "start", "future-verb"}
	for _, kind := range []string{"browser", "holdings"} {
		for _, verb := range verbs {
			for _, name := range names {
				t.Run(kind+"/"+verb+"/"+name, func(t *testing.T) {
					r := &scriptRunner{}
					m := testManager(t, r)
					for _, tail := range [][]string{{"--container", name}, {"--container=" + name}, {"--container", "srf-id-demo", "--container", name}} {
						_, err := m.execute(context.Background(), Profile{NativeKind: kind}, append([]string{verb}, tail...), nil)
						requireFault(t, err, "protected_container")
						if len(r.calls) != 0 {
							t.Fatal("protected command reached native runner")
						}
					}
				})
			}
		}
	}
}

func TestProtectMinExactNamesOnly(t *testing.T) {
	r := &scriptRunner{}
	m := testManager(t, r)
	for _, name := range []string{"srf-id-demo", "srf-pg-demo", "srf-id-cuentas-10", "srf-pg-notepad-1-extra", "n8n-extra", "distil-box-extra"} {
		if _, err := m.execute(context.Background(), Profile{}, []string{"frame", "--container", name}, nil); err != nil {
			t.Fatal(err)
		}
	}
	if len(r.calls) != 6 {
		t.Fatalf("exact-name peers blocked: %v", r.calls)
	}
}

func TestProtectMinHoldingsPendingRecord(t *testing.T) {
	for _, mode := range []string{"pending", "absent", "stale", "wrong-slot", "multiple", "bound", "protected", "failed-create"} {
		t.Run(mode, func(t *testing.T) {
			m := testManager(t, &scriptRunner{})
			delete(m.bindings, holdingsBinding(m))
			stops := 0
			m.cfg.VerifyHoldingsRemoval = func(context.Context, Binding) error { return nil }
			m.runner = a2Runner(func(_ context.Context, args []string, _ []byte) ([]byte, error) {
				if args[1] == "stop" {
					stops++
					return []byte(`{"stopped":"srf-ng-hcap-hc-0123456789ab-1"}`), nil
				}
				pending, ok := m.creates["demo"]
				if !ok || pending.Generation == "" || pending.NativeKind != "holdings" || pending.Slot != 1 {
					t.Fatal("Holdings started without pending slot/generation")
				}
				reply := `[{"slot":1,"container":"srf-ng-hcap-hc-0123456789ab-1","run_id":"hc-0123456789ab","ready_line":""}]`
				switch mode {
				case "absent":
					delete(m.creates, "demo")
				case "stale":
					pending.Generation = "stale"
					m.creates["demo"] = pending
				case "wrong-slot":
					reply = strings.Replace(reply, `"slot":1`, `"slot":2`, 1)
				case "multiple":
					reply = "[" + reply[1:len(reply)-1] + "," + reply[1:len(reply)-1] + "]"
				case "bound":
					m.bindings["other"] = Binding{Container: "srf-ng-hcap-hc-0123456789ab-1", Surface: Surface{State: "active", ProfileID: "other"}}
				case "protected":
					reply = strings.ReplaceAll(reply, "srf-ng-hcap-hc-0123456789ab-1", "srf-pg-notepad-1")
				case "failed-create":
					return []byte(reply), fault("native", "failed after create")
				}
				return []byte(reply), nil
			})
			out, err := m.Handle(context.Background(), req("create", `{"kind":"game_capsule","profile_id":"demo","geometry":{"w":2,"h":1}}`))
			wantStop := mode == "pending" || mode == "failed-create"
			if err == nil || len(out) != 0 || (stops == 1) != wantStop || m.quarantined["demo"] == wantStop || len(m.creates) != 0 {
				t.Fatalf("stops=%d quarantine=%v pending=%v events=%s err=%v", stops, m.quarantined["demo"], m.creates, out, err)
			}
		})
	}
}

func TestR3Variants(t *testing.T) {
	for _, kind := range []string{"browser", "program", "vm", "holdings"} {
		for _, name := range []string{"srf-id-cuentas-1", "srf-id-perplexity-1", "srf-pg-notepad-1", "srf-pg-metaviewer-1", "srf-egress-proxy", "n8n", "distil-box"} {
			r := &scriptRunner{}
			m := testManager(t, r)
			for _, flag := range []string{"--container", "-container", "--capsule", "-capsule"} {
				for _, tail := range [][]string{{flag, " \t" + name + "\n"}, {flag + "= " + name + " "}} {
					_, err := m.execute(context.Background(), Profile{NativeKind: kind}, append([]string{"future"}, tail...), nil)
					requireFault(t, err, "protected_container")
				}
			}
			if len(r.calls) != 0 {
				t.Fatal("protected dispatch")
			}
			if _, err := m.execute(context.Background(), Profile{NativeKind: kind}, []string{"frame", "--container", name + "-peer"}, nil); err != nil || len(r.calls) != 1 {
				t.Fatal("peer refused", err)
			}
		}
	}
	if err := RefuseProtectedContainer([]string{"--container", "N8N"}); err != nil {
		t.Fatal("CLI is case sensitive", err)
	}
}
func TestR3StartCollisions(t *testing.T) {
	for _, tc := range []struct{ id, kind string }{{"cuentas-1", "browser"}, {"perplexity-1", "browser"}, {"notepad-1", "program"}, {"metaviewer-1", "program"}} {
		r := &scriptRunner{}
		m := testManager(t, r)
		p := m.cfg.Profiles["demo"]
		p.NativeKind = tc.kind
		p.Program = "demo"
		m.cfg.Profiles[tc.id] = p
		_, err := m.Handle(context.Background(), req("create", strings.Replace(createDemo, "demo", tc.id, 1)))
		requireFault(t, err, "protected_container")
		if len(r.calls) != 0 || len(m.bindings) != 0 || len(m.creates) != 0 || m.quarantined[tc.id] {
			t.Fatal("profile dispatched or retained")
		}
	}
}
func TestR3Admission(t *testing.T) {
	for _, kind := range []string{"browser", "holdings"} {
		for _, mode := range []string{"valid", "protected", "unrelated", "absent", "stale", "wrong-slot"} {
			if kind == "browser" && mode == "wrong-slot" {
				continue
			}
			m := testManager(t, &scriptRunner{})
			params := createDemo
			if kind == "holdings" {
				delete(m.bindings, holdingsBinding(m))
				params = `{"kind":"game_capsule","profile_id":"demo","geometry":{"w":2,"h":1}}`
			}
			stops := 0
			m.runner = a2Runner(func(_ context.Context, args []string, _ []byte) ([]byte, error) {
				if args[1] == "stop" {
					stops++
					return nil, nil
				}
				reply := startOK
				name := "srf-id-demo"
				if kind == "holdings" {
					name = "srf-ng-hcap-hc-0123456789ab-1"
					reply = `[{"slot":1,"container":"srf-ng-hcap-hc-0123456789ab-1","run_id":"hc-0123456789ab","display":":100","width":2,"height":1,"ready_line":"READY","ready_ms":0,"frames_dir":"/dev/shm/test/frames"}]`
				}
				switch mode {
				case "protected":
					reply = strings.Replace(reply, name, "srf-pg-notepad-1", 1)
				case "unrelated":
					if kind == "browser" {
						reply = strings.Replace(reply, name, "srf-id-victim", 1)
					} else {
						delete(m.creates, "demo")
					}
				case "absent":
					delete(m.creates, "demo")
				case "stale":
					p := m.creates["demo"]
					p.Generation = "stale"
					m.creates["demo"] = p
				case "wrong-slot":
					p := m.creates["demo"]
					p.Slot = 2
					m.creates["demo"] = p
				}
				return []byte(reply), nil
			})
			out, err := m.Handle(context.Background(), req("create", params))
			// Pending records authorize compensation, not successful admission.
			// Valid readiness may return an unrelated, unprotected native name.
			if mode != "protected" {
				if err != nil || len(out) != 1 || len(m.bindings) != 1 || stops != 0 || m.quarantined["demo"] {
					t.Fatalf("%s/%s readiness refused: %v", kind, mode, err)
				}
				if kind == "browser" && mode == "unrelated" {
					for _, binding := range m.bindings {
						if binding.Container != "srf-id-victim" {
							t.Fatalf("native name replaced: %s", binding.Container)
						}
					}
				}
			} else if err == nil || len(out) != 0 || len(m.bindings) != 0 || stops != 0 || !m.quarantined["demo"] {
				t.Fatalf("%s/%s admitted or stopped: %v", kind, mode, err)
			}
		}
	}
}
