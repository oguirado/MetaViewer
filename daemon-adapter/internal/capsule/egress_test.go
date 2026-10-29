package capsule

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/cli"
)

func TestEgressDomains(t *testing.T) {
	for _, domains := range [][]string{nil, {}, {"*.example.com"}, {"Example.com"}, {"127.0.0.1"}, {"::1"}, {"example.com:443"}, {"https://example.com"}, {"a..com"}, {"é.com"}, {"a.com."}, {"-a.com"}, {"a_.com"}, {"a.com", "a.com"}, {"0x7f000001"}} {
		if err := (Egress{egressSchema, "allowlisted", domains}).Validate(); err == nil {
			t.Fatalf("admitted %q", domains)
		}
	}
	for _, domain := range []string{"example.com", "xn--bcher-kva.example", "sub.example.com"} {
		if err := (Egress{egressSchema, "allowlisted", []string{domain}}).Validate(); err != nil {
			t.Fatal(err)
		}
	}
	tooMany := make([]string, 257)
	if (Egress{egressSchema, "allowlisted", tooMany}).Validate() == nil {
		t.Fatal("domain cap")
	}
	if (Egress{egressSchema, "open", []string{"example.com"}}).Validate() == nil {
		t.Fatal("open domains")
	}
}

func TestEgressFilesAndPolicy(t *testing.T) {
	state := privateEgressState(t)
	e, err := LoadEgress(state, "demo")
	if err != nil || e.Mode != "open" {
		t.Fatal(e, err)
	}
	e = Egress{egressSchema, "allowlisted", []string{"example.com"}}
	if err = StoreEgress(state, "demo", e); err != nil {
		t.Fatal(err)
	}
	got, err := LoadEgress(state, "demo")
	if err != nil || !reflect.DeepEqual(e, got) {
		t.Fatal(got, err)
	}
	path, err := WriteEgressPolicy(state, "demo", "srf-id-demo", e)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"schema":"browserid.proxy-policy/v1","approved":{"srf-id-demo":["example.com"]},"denied":[]}` {
		t.Fatalf("policy %s", b)
	}
	for _, p := range []string{filepath.Dir(path), path, filepath.Join(state, "egress", "demo.json")} {
		st, err := os.Lstat(p)
		if err != nil {
			t.Fatal(err)
		}
		want := os.FileMode(0600)
		if st.IsDir() {
			want = 0700
		}
		if st.Mode().Perm() != want {
			t.Fatal(st.Mode())
		}
	}
	if _, err = networkStartArgs([]string{"start"}, "proxied", ""); err == nil {
		t.Fatal("missing policy accepted")
	}
}

func TestEgressUnsafeFiles(t *testing.T) {
	for _, kind := range []string{"symlink", "directory-link", "ancestor-link", "wide", "oversize", "invalid", "trailing", "unknown", "fifo"} {
		t.Run(kind, func(t *testing.T) {
			state := privateEgressState(t)
			dir := filepath.Join(state, "egress")
			if err := os.Mkdir(dir, 0700); err != nil {
				t.Fatal(err)
			}
			record := filepath.Join(dir, "demo.json")
			switch kind {
			case "symlink":
				if err := os.Symlink(filepath.Join(t.TempDir(), "missing"), record); err != nil {
					t.Fatal(err)
				}
			case "directory-link":
				os.Remove(dir)
				if err := os.Symlink(t.TempDir(), dir); err != nil {
					t.Fatal(err)
				}
			case "ancestor-link":
				alias := filepath.Join(t.TempDir(), "alias")
				if err := os.Symlink(state, alias); err != nil {
					t.Fatal(err)
				}
				state = alias
			case "wide":
				if err := os.WriteFile(record, []byte(`{}`), 0644); err != nil {
					t.Fatal(err)
				}
			case "oversize":
				if err := os.WriteFile(record, []byte(strings.Repeat(" ", egressLimit+1)), 0600); err != nil {
					t.Fatal(err)
				}
			case "invalid":
				if err := os.WriteFile(record, []byte(`{"schema":"metaviewer.capsule_egress/v1","mode":"allowlisted","domains":[]}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "trailing":
				if err := os.WriteFile(record, []byte(`{"schema":"metaviewer.capsule_egress/v1","mode":"open","domains":[]} {}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "unknown":
				if err := os.WriteFile(record, []byte(`{"schema":"metaviewer.capsule_egress/v1","mode":"open","domains":[],"extra":1}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "fifo":
				if err := syscall.Mkfifo(record, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := LoadEgress(state, "demo"); err == nil {
				t.Fatal("unsafe record admitted")
			}
		})
	}
}

// Real hosted executable captures both argv and environment: no Docker/network.
func networkTestManager(t *testing.T, modes string, configuredProxy bool) (*Manager, string, string) {
	t.Helper()
	bin := t.TempDir()
	state := privateEgressState(t)
	log := filepath.Join(t.TempDir(), "calls")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*|proxy=${SRF_EGRESS_PROXY-unset}\" >> '" + log + "'\ncase \"$1\" in\ncapabilities) printf '%s\\n' '" + modes + "';;\nstart) printf '%s\\n' '" + startOK + "';;\nesac\n"
	if err := os.WriteFile(filepath.Join(bin, "srf-identity-surface"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	env := []string{"PATH=" + os.Getenv("PATH"), "MV_SRF_STATE_DIR=" + state}
	if configuredProxy {
		env = append(env, "SRF_EGRESS_PROXY=http://legacy.example:3128")
	}
	r, err := NewProcessRunner(bin, env, 4096, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var knowledge struct {
		NetModes []string `json:"net_modes"`
	}
	if err := json.Unmarshal([]byte(modes), &knowledge); err != nil {
		t.Fatal(err)
	}
	m, err := NewManager(Config{NetModes: knowledge.NetModes, BinDir: bin, MaxSurfaces: 4, MaxOutputBytes: 4096, Timeout: time.Second, OriginNS: 100, Profiles: map[string]Profile{"demo": {Kind: "browser", NativeKind: "browser", Width: 2, Height: 1, Display: ":100", RAMRoot: "/dev/shm"}}}, r, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	return m, state, log
}

func TestNetworkCreateModes(t *testing.T) {
	for _, tc := range []struct {
		name, modes, record, want string
		proxy                     bool
	}{
		{"default-open", `{"net_modes":["open","proxied"]}`, "", "open", true},
		{"opt-in", `{"net_modes":["open","proxied"]}`, "allowlisted", "proxied", true},
		{"legacy", `{"schema":"capabilities/v1"}`, "", "legacy", true},
		{"silent-open-refused", `{}`, "allowlisted", "NET_PROXIED_UNSUPPORTED", false},
		{"empty-refused", `{"net_modes":["open","proxied"]}`, "invalid", "NET_EGRESS_INVALID", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, state, log := networkTestManager(t, tc.modes, tc.proxy)
			if tc.name == "opt-in" {
				if err := os.WriteFile(filepath.Join(m.cfg.BinDir, "srf-egress-proxy"), []byte("#!/bin/sh\nexit 99\n"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			if tc.record == "allowlisted" {
				if err := StoreEgress(state, "demo", Egress{egressSchema, "allowlisted", []string{"example.com"}}); err != nil {
					t.Fatal(err)
				}
			}
			if tc.record == "invalid" {
				if err := os.Mkdir(filepath.Join(state, "egress"), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(state, "egress", "demo.json"), []byte(`{"schema":"metaviewer.capsule_egress/v1","mode":"allowlisted","domains":[]}`), 0600); err != nil {
					t.Fatal(err)
				}
			}
			events, err := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`))
			b, _ := os.ReadFile(log)
			calls := string(b)
			if strings.HasPrefix(tc.want, "NET_") {
				var f *cli.Fault
				if !errors.As(err, &f) || f.Code != tc.want {
					t.Fatalf("got %v want %s", err, tc.want)
				}
				if strings.Contains(calls, "start ") {
					t.Fatal("refusal spawned capsule")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			// Frozen base 9ec2d37e8 shape: data contains only surface, in this order.
			var ev struct {
				Data struct {
					Surface Surface `json:"surface"`
				} `json:"data"`
			}
			if err := json.Unmarshal(events[0], &ev); err != nil {
				t.Fatal(err)
			}
			surface, err := json.Marshal(ev.Data.Surface)
			if err != nil {
				t.Fatal(err)
			}
			wantEvent := append([]byte(`{"schema":"surface_event/v0.2","event":"created","data":{"surface":`), surface...)
			wantEvent = append(wantEvent, []byte(`}}`)...)
			if !bytes.Equal(events[0], wantEvent) {
				t.Fatalf("created event drift: %s", events[0])
			}

			if hasForbiddenNetworkFlag(strings.Fields(strings.SplitN(calls, "|", 2)[0])) {
				t.Fatal(calls)
			}
			lines := strings.Split(strings.TrimSpace(calls), "\n")
			if len(lines) != 1 {
				t.Fatal(calls)
			}
			start := lines[0]
			switch tc.want {
			case "open":
				if !strings.Contains(start, "--net open") || !strings.HasSuffix(start, "|proxy=unset") {
					t.Fatal(start)
				}
			case "proxied":
				if !strings.Contains(start, "--net proxied --policy "+filepath.Join(state, "egress", "demo.policy.json")) || !strings.HasSuffix(start, "|proxy=unset") {
					t.Fatal(start)
				}
			case "legacy":
				want := "start --kind browser --identity demo --windows 1 --state-dir " + state + "|proxy=http://legacy.example:3128"
				if start != want {
					t.Fatalf("legacy drift: %s", start)
				}
			}
			// Startup knowledge must require no native capability calls on either create.
			delete(m.bindings, firstBindingID(m))
			m.quarantined = map[string]bool{}
			if _, err := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`)); err != nil {
				t.Fatal(err)
			}
			b, _ = os.ReadFile(log)
			if strings.Contains(string(b), "capabilities|") || strings.Count(string(b), "start ") != 2 {
				t.Fatal(string(b))
			}
		})
	}
}

func hasForbiddenNetworkFlag(argv []string) bool {
	for _, arg := range argv {
		if arg == "--proxy" || arg == "--audit" {
			return true
		}
	}
	return false
}

func TestForbiddenNetworkFlagTokens(t *testing.T) {
	for _, flag := range []string{"--proxy", "--audit"} {
		t.Run(flag, func(t *testing.T) {
			if !hasForbiddenNetworkFlag([]string{"start", "--proxy-bin", "srf-egress-proxy", flag}) {
				t.Fatalf("forbidden token %q was not caught", flag)
			}
		})
	}
	if hasForbiddenNetworkFlag([]string{"start", "--proxy-bin", "srf-egress-proxy"}) {
		t.Fatal("mandatory --proxy-bin rejected")
	}
}

func firstBindingID(m *Manager) string {
	for id := range m.bindings {
		return id
	}
	return ""
}

func privateEgressState(t *testing.T) string {
	t.Helper()
	p := t.TempDir()
	if err := os.Chmod(p, 0700); err != nil {
		t.Fatal(err)
	}
	return p
}

// MUT-PROGRAM-NET: browser capability knowledge must not affect program/vm argv.
func TestNetworkNonBrowserKeepsLegacy(t *testing.T) {
	for _, kind := range []string{"program", "vm"} {
		t.Run(kind, func(t *testing.T) {
			m, state, log := networkTestManager(t, `{"net_modes":["legacy","open","proxied"]}`, true)
			if err := StoreEgress(state, "demo", Egress{egressSchema, "open", []string{}}); err != nil {
				t.Fatal(err)
			}
			p := m.cfg.Profiles["demo"]
			p.NativeKind, p.Program, p.Kind = kind, "notepad", "desktop_capsule"
			if kind == "vm" {
				p.Kind = "vm"
			}
			m.cfg.Profiles["demo"] = p
			// Readiness is deliberately browser-shaped; the start argv is the oracle.
			_, _ = m.Handle(context.Background(), req("create", `{"kind":"`+p.Kind+`","profile_id":"demo","geometry":{"w":2,"h":1}}`))
			b, err := os.ReadFile(log)
			if err != nil {
				t.Fatal(err)
			}
			want := "start --kind " + kind + " --identity demo --windows 1 --program notepad --state-dir " + state + "|proxy=http://legacy.example:3128"
			if strings.Split(strings.TrimSpace(string(b)), "\n")[0] != want {
				t.Fatalf("program/vm legacy drift: %s", b)
			}
		})
	}
}

func TestEgressLocalNamesRefused(t *testing.T) {
	for _, h := range []string{"localhost", "intranet", "a.localhost", "a.local", "a.internal", "a.lan", "a.home.arpa", "home.arpa"} {
		t.Run(h, func(t *testing.T) {
			if exactHostname(h) {
				t.Fatalf("local name admitted: %s", h)
			}
		})
	}
}

func TestNetworkInjectedAllowlistRefused(t *testing.T) {
	state := privateEgressState(t)
	t.Setenv("MV_SRF_STATE_DIR", state)
	r := &forbiddenRunner{}
	m, _, _ := networkTestManager(t, `{}`, false)
	m.runner = r
	if _, _, _, err := m.browserNetwork("demo", "srf-id-demo"); err != nil {
		t.Fatal(err)
	}
	if err := StoreEgress(state, "demo", Egress{egressSchema, "allowlisted", []string{"example.com"}}); err != nil {
		t.Fatal(err)
	}
	_, err := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`))
	var f *cli.Fault
	if !errors.As(err, &f) || f.Code != "NET_PROXIED_UNSUPPORTED" || r.called {
		t.Fatalf("allowlisted injected start: called=%v err=%v", r.called, err)
	}
}

func TestEgressPolicyRecordChanged(t *testing.T) {
	state := privateEgressState(t)
	before := Egress{egressSchema, "allowlisted", []string{"example.com"}}
	for _, current := range []Egress{before, {egressSchema, "open", []string{}}, {egressSchema, "allowlisted", []string{"other.example"}}} {
		if err := StoreEgress(state, "demo", current); err != nil {
			t.Fatal(err)
		}
		_, err := WriteEgressPolicy(state, "demo", "srf-id-demo", before)
		if reflect.DeepEqual(before, current) {
			if err != nil {
				t.Fatal(err)
			}
			continue
		}
		var f *cli.Fault
		if !errors.As(err, &f) || f.Code != "NET_EGRESS_CHANGED" {
			t.Fatalf("changed record accepted: %v", err)
		}
	}
}

func TestNetworkOpenNativeRefusal(t *testing.T) {
	m, _, _ := networkTestManager(t, `{"net_modes":["open"]}`, false)
	script := "#!/bin/sh\nexit 2\n"
	if err := os.WriteFile(filepath.Join(m.cfg.BinDir, "srf-identity-surface"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	_, err := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`))
	want := cli.ExitFault("srf-identity-surface", 2, "")
	if !reflect.DeepEqual(err, want) {
		t.Fatalf("native fault changed: got %#v want %#v", err, want)
	}
}

// MUT-NO-PROXY-BIN: enforce the executable and exact absolute argv before start.
func TestNetworkProxyBinContract(t *testing.T) {
	for _, kind := range []string{"missing", "non-executable", "directory", "executable"} {
		t.Run(kind, func(t *testing.T) {
			m, state, log := networkTestManager(t, `{"net_modes":["open","proxied"]}`, true)
			proxy := filepath.Join(m.cfg.BinDir, "srf-egress-proxy")
			switch kind {
			case "non-executable", "executable":
				mode := os.FileMode(0600)
				if kind == "executable" {
					mode = 0700
				}
				if err := os.WriteFile(proxy, []byte("#!/bin/sh\nexit 99\n"), mode); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(proxy, 0700); err != nil {
					t.Fatal(err)
				}
			}
			if err := StoreEgress(state, "demo", Egress{egressSchema, "allowlisted", []string{"example.com"}}); err != nil {
				t.Fatal(err)
			}
			out, err := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`))
			calls, readErr := os.ReadFile(log)
			if kind != "executable" {
				var f *cli.Fault
				if !errors.As(err, &f) || f.Code != "NET_EGRESS_INVALID" || len(out) != 0 || len(m.quarantined) != 0 || len(m.bindings) != 0 || len(m.creates) != 0 {
					t.Fatalf("unsafe proxy admitted or mutated state: err=%v calls=%s quarantine=%v", err, calls, m.quarantined)
				}
				if !os.IsNotExist(readErr) {
					t.Fatalf("native invocation before proxy refusal: %s (%v)", calls, readErr)
				}
				if _, err := os.Stat(filepath.Join(state, "egress", "demo.policy.json")); !os.IsNotExist(err) {
					t.Fatalf("policy published before proxy refusal: %v", err)
				}
				return
			}
			want := "start --kind browser --identity demo --windows 1 --net proxied --policy " + filepath.Join(state, "egress", "demo.policy.json") + " --proxy-bin " + proxy + " --state-dir " + state + "|proxy=unset\n"
			if err != nil || readErr != nil || len(out) != 1 || !filepath.IsAbs(proxy) || string(calls) != want {
				t.Fatalf("proxied argv: got %q want %q err=%v read=%v", calls, want, err, readErr)
			}
		})
	}
}

// MUT-SILENT-DOWNGRADE: a setup refusal must remain typed, with one start only.
func TestNetworkOpenPrerequisiteContract(t *testing.T) {
	for _, mode := range []string{"open", "proxied", "legacy"} {
		t.Run(mode, func(t *testing.T) {
			modes := `{"net_modes":["open","proxied"]}`
			if mode == "legacy" {
				modes = `{}`
			}
			m, state, log := networkTestManager(t, modes, true)
			if mode == "proxied" {
				if err := StoreEgress(state, "demo", Egress{egressSchema, "allowlisted", []string{"example.com"}}); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(m.cfg.BinDir, "srf-egress-proxy"), []byte("#!/bin/sh\nexit 99\n"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '" + log + "'\nexit 3\n"
			if err := os.WriteFile(filepath.Join(m.cfg.BinDir, "srf-identity-surface"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			out, err := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`))
			var f *cli.Fault
			if !errors.As(err, &f) || len(out) != 0 || len(m.bindings) != 0 {
				t.Fatalf("native refusal lost: out=%s err=%v", out, err)
			}
			if mode == "open" {
				for _, required := range []string{"image rebuild", "SRF_NET_MODE=open", "firewall witness", "DOCKER-USER/INPUT", "exit code 3"} {
					if f.Code != "NET_OPEN_PREREQ" || !strings.Contains(f.Detail, required) {
						t.Fatalf("prerequisite fault missing %q: %v", required, err)
					}
				}
			} else if !reflect.DeepEqual(err, cli.ExitFault("srf-identity-surface", 3, "")) {
				t.Fatalf("non-open setup fault changed: %v", err)
			}
			calls, readErr := os.ReadFile(log)
			if readErr != nil || strings.Count(string(calls), "\n") != 1 || !strings.HasPrefix(string(calls), "start ") {
				t.Fatalf("refusal retried or spawned cleanup: calls=%s err=%v", calls, readErr)
			}
			if mode == "open" && (!strings.Contains(string(calls), "--net open") || strings.Contains(string(calls), "--policy") || strings.Contains(string(calls), "--proxy-bin")) {
				t.Fatalf("open downgraded: %s", calls)
			}
		})
	}
}
