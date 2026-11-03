package capsule

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestV027DestroyObservesResidentFinalization(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	id := createID(t, m)
	b := m.bindings[id]
	r.output = []byte(`{"stopped":"srf-id-demo","removed_verified":true}`)
	m.cfg.BeforeDestroy = func(ctx context.Context, _ string) error {
		return m.RefuseResident(ctx, b)
	}
	before := len(r.calls)
	if _, err := m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`)); err != nil {
		t.Fatal(err)
	}
	if got := len(r.calls) - before; got != 1 {
		t.Fatalf("native stops=%d; finalized resident must not be stopped twice", got)
	}
	if m.bindings[id].Surface.State != "destroyed" {
		t.Fatal("terminal binding overwritten")
	}
}

func v027ReadyHost(t *testing.T, failPublication bool) (*Manager, Profile, *hostXpraProcess) {
	t.Helper()
	ram, err := os.MkdirTemp("/dev/shm", "mv-v027-host-frames-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(ram) })
	bin, state := t.TempDir(), t.TempDir()
	if err = os.Chmod(state, 0700); err != nil {
		t.Fatal(err)
	}
	if failPublication {
		if err = os.WriteFile(filepath.Join(state, "human-bindings"), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	sleep, err := exec.LookPath("sleep")
	if err != nil {
		t.Fatal(err)
	}
	anchor := exec.Command(sleep, "30")
	anchor.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err = anchor.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = anchor.Process.Kill(); _ = anchor.Wait() })
	stamp, _, _, err := processWitness(anchor.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	process := &hostXpraProcess{anchor: anchor, start: stamp, root: t.TempDir(), view: t.TempDir(), display: ":12345", log: &hostXpraLog{}}
	for name, script := range map[string]string{
		"xdotool":         "#!/bin/sh\nexit 0\n",
		"srf-host-window": fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' '{\"windows\":[{\"xid\":42,\"witness\":\"%s\",\"pid\":%d,\"window_type\":\"normal\",\"visible\":true}]}'\n", strings.Repeat("a", 64), anchor.Process.Pid),
	} {
		if err = os.WriteFile(filepath.Join(bin, name), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	r, err := NewProcessRunner(bin, []string{"PATH=" + bin, "MV_SRF_STATE_DIR=" + state}, 4096, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	m := testManager(t, &scriptRunner{})
	m.runner = r
	m.cfg.BinDir = bin
	p := Profile{Kind: "desktop_capsule", NativeKind: "host-xpra", Program: "host-exec", RAMRoot: ram, Width: 1280, Height: 900, Role: "agent"}
	m.cfg.Profiles["demo"] = p
	m.hostXpraStart = func(context.Context, *ProcessRunner, string, string, string) (*hostXpraProcess, error) {
		return process, nil
	}
	return m, p, process
}

func TestV027FailedHostBindingPublicationReleasesFrameTree(t *testing.T) {
	m, p, _ := v027ReadyHost(t, true)
	ram := p.RAMRoot
	var err error
	m.mu.Lock()
	_, err = m.createHostXpra(context.Background(), "demo", "surface-v027", "v0.2", p, "fake-program", Geometry{W: 1280, H: 900})
	m.mu.Unlock()
	if err == nil {
		t.Fatal("invalid human-binding directory accepted")
	}
	entries, err := os.ReadDir(ram)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("failed publication retained owned frame tree: %v", entries)
	}
}

func TestV027XvfbEarlyExitReportsChildFailure(t *testing.T) {
	bin, state := t.TempDir(), t.TempDir()
	if err := os.Chmod(state, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"xpra", "Xvfb", "xauth", "xdotool", "srf-host-window"} {
		script := "#!/bin/sh\nexit 0\n"
		if name == "Xvfb" {
			script = "#!/bin/sh\necho startup-failed >&2\nexit 7\n"
		}
		if err := os.WriteFile(filepath.Join(bin, name), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	r, err := NewProcessRunner(bin, []string{"PATH=" + bin, "MV_SRF_STATE_DIR=" + state}, 4096, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err = startHostXpra(ctx, r, filepath.Join(bin, "app"), "srf-pg-hx-test", "agent")
	if err == nil || !strings.Contains(err.Error(), "Xvfb exited") {
		t.Fatalf("child failure was hidden by socket timeout: %v", err)
	}
}

type v027View struct{ stops int }

func (v *v027View) Open(context.Context, string, bool) error { return nil }
func (v *v027View) Stop(context.Context, string) error {
	v.stops++
	if v.stops == 1 {
		return errors.New("view still alive")
	}
	return nil
}

func TestV027DestroyRetriesFailedView(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	id := createID(t, m)
	v := &v027View{}
	m.cfg.View = v
	m.views["srf-id-demo"] = true
	r.err = errors.New("native stop failed")
	if _, err := m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`)); err == nil {
		t.Fatal("failed teardown accepted")
	}
	r.err = nil
	r.output = []byte(`{"stopped":"srf-id-demo","removed_verified":true}`)
	if _, err := m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`)); err != nil {
		t.Fatal(err)
	}
	if v.stops != 2 {
		t.Fatalf("view stop attempts=%d; failed view was forgotten", v.stops)
	}
	if m.views["srf-id-demo"] {
		t.Fatal("closed view retained")
	}
}

func TestV027HostStartupDoesNotBlockEmergencyControl(t *testing.T) {
	bin, state := t.TempDir(), t.TempDir()
	sleepBinary, err := exec.LookPath("sleep")
	if err != nil {
		t.Fatal(err)
	}
	shellSleep := "'" + strings.ReplaceAll(sleepBinary, "'", "'\"'\"'") + "'"
	if err := os.Chmod(state, 0700); err != nil {
		t.Fatal(err)
	}
	marker, release := filepath.Join(bin, "entered"), filepath.Join(bin, "release")
	for _, name := range []string{"xpra", "Xvfb", "xdotool", "srf-host-window", "app", "xauth"} {
		script := "#!/bin/sh\nexit 1\n"
		if name == "xauth" {
			script = "#!/bin/sh\n: > '" + marker + "'\nwhile [ ! -f '" + release + "' ]; do " + shellSleep + " 0.01; done\nexit 1\n"
		}
		if err := os.WriteFile(filepath.Join(bin, name), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(state, "opening-modes"), 0700); err != nil {
		t.Fatal(err)
	}
	opening, _ := json.Marshal(map[string]any{"schema": "metaviewer.opening_mode/v0.3", "profile_id": "hx-test", "mode": "agent", "host_binary": filepath.Join(bin, "app"), "host_xpra": true})
	if err := os.WriteFile(filepath.Join(state, "opening-modes", "hx-test.json"), opening, 0600); err != nil {
		t.Fatal(err)
	}
	m := testManager(t, &scriptRunner{output: []byte(startOK)})
	id := createID(t, m)
	r, err := NewProcessRunner(bin, []string{"PATH=" + bin, "MV_SRF_STATE_DIR=" + state}, 4096, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	m.runner = r
	// A browser template admits the dynamic host program's fixed geometry.
	p := m.cfg.Profiles["demo"]
	p.Width, p.Height = 1280, 900
	m.identityTemplate = &p
	done := make(chan error, 1)
	go func() {
		_, e := m.Handle(context.Background(), req("create", `{"kind":"desktop_capsule","profile_id":"hx-test","geometry":{"w":1280,"h":900}}`))
		done <- e
	}()
	defer func() {
		_ = os.WriteFile(release, nil, 0600)
		<-done
		if m.AdmissionProfiles()["hx-test"] {
			t.Error("proven pre-spawn failure retained the startup reservation")
		}
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		select {
		case e := <-done:
			done <- e
			t.Fatalf("startup exited: %v", e)
		default:
		}
		if _, e := os.Stat(marker); e == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("startup did not enter xauth")
		}
		time.Sleep(time.Millisecond)
	}
	controlled := make(chan error, 1)
	go func() {
		_, e := m.Handle(context.Background(), req("take_control", `{"surface_id":"`+id+`","owner":"human"}`))
		controlled <- e
	}()
	select {
	case e := <-controlled:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("emergency control blocked behind native startup")
	}
	if !m.AdmissionProfiles()["hx-test"] {
		t.Fatal("in-flight startup has no reservation")
	}
	if _, e := m.Handle(context.Background(), req("create", `{"kind":"desktop_capsule","profile_id":"hx-test","geometry":{"w":1280,"h":900}}`)); e == nil {
		t.Fatal("duplicate opening admitted")
	}
}

func TestV027HostPreflightIncludesLateHelpers(t *testing.T) {
	for _, missing := range []string{"xdotool", "srf-host-window"} {
		t.Run(missing, func(t *testing.T) {
			bin, state := t.TempDir(), t.TempDir()
			if err := os.Chmod(state, 0700); err != nil {
				t.Fatal(err)
			}
			marker := filepath.Join(bin, "spawned")
			for _, name := range []string{"xpra", "Xvfb", "xauth", "xdotool", "srf-host-window"} {
				if name == missing {
					continue
				}
				if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n: > '"+marker+"'\nexit 1\n"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			r, err := NewProcessRunner(bin, []string{"PATH=" + bin, "MV_SRF_STATE_DIR=" + state}, 4096, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = startHostXpra(context.Background(), r, filepath.Join(bin, "app"), "srf-pg-hx-test", "agent"); err == nil {
				t.Fatal("missing helper admitted")
			}
			if _, err = os.Stat(marker); !os.IsNotExist(err) {
				t.Fatal("native command ran before helper preflight")
			}
		})
	}
}

func TestV027HostStartupWaitsForStableMainWindow(t *testing.T) {
	for _, c := range []struct {
		name, kind     string
		transientPolls int
	}{{"replaced-normal", "normal", 1}, {"repeated-splash", "splash", 2}} {
		t.Run(c.name, func(t *testing.T) {
			m, p, process := v027ReadyHost(t, false)
			marker := filepath.Join(m.cfg.BinDir, "listed")
			script := fmt.Sprintf(`#!/bin/sh
n=0
if [ -f '%s' ]; then read n < '%s'; fi
n=$((n+1))
printf '%%s\n' "$n" > '%s'
xid=42
kind=normal
if [ "$n" -le %d ]; then xid=41; kind=%s; fi
printf '{"windows":[{"xid":%%s,"witness":"%s","pid":%d,"window_type":"%%s","visible":true}]}\n' "$xid" "$kind"
`, marker, marker, marker, c.transientPolls, c.kind, strings.Repeat("a", 64), process.anchor.Process.Pid)
			if err := os.WriteFile(filepath.Join(m.cfg.BinDir, "srf-host-window"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			m.mu.Lock()
			_, err := m.createHostXpra(context.Background(), "demo", "surface-v027", "v0.2", p, "fake-program", Geometry{W: 1280, H: 900})
			m.mu.Unlock()
			if err != nil {
				t.Fatal(err)
			}
			if got := m.bindings["surface-v027"].HostXID; got != 42 {
				t.Fatalf("bound transient startup window %d instead of stable main window", got)
			}
		})
	}
}
