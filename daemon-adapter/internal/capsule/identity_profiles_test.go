package capsule

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/cli"
)

type identityProfileRunner struct {
	known          map[string]bool
	checks, starts int
	stopVerified   bool
}

func (r *identityProfileRunner) IdentityExists(_ context.Context, id string) error {
	r.checks++
	if !r.known[id] {
		return fmt.Errorf("unknown identity")
	}
	return nil
}

func (r *identityProfileRunner) Run(_ context.Context, argv []string, _ []byte) ([]byte, error) {
	switch argv[1] {
	case "start":
		r.starts++
		return []byte(fmt.Sprintf(`{"container":"srf-id-test-%d","run_id":"run-%d","windows":[{"id":"w1","x":0,"y":0,"w":1280,"h":900,"title":"","url":""}]}`, r.starts, r.starts)), nil
	case "stop":
		return []byte(fmt.Sprintf(`{"stopped":%q,"removed_verified":%t}`, argv[3], r.stopVerified)), nil
	}
	return nil, fmt.Errorf("unexpected command %q", argv)
}

func identityProfileManager(t *testing.T, count int) (*Manager, *identityProfileRunner) {
	t.Helper()
	profiles := map[string]Profile{}
	for i := 1; i <= count; i++ {
		profiles[fmt.Sprintf("mv-live-%d", i)] = Profile{Kind: "browser", NativeKind: "browser", Width: 1280, Height: 900, RAMRoot: "/dev/shm", Display: fmt.Sprintf(":%d", 110+i), TextInput: "paste"}
	}
	// Protected IDs deliberately exist in this adversarial store. Otherwise an
	// existence refusal could mask a broken protected-name admission gate.
	r := &identityProfileRunner{known: map[string]bool{"p18d-a": true, "p18d-b": true, "p18d-c": true,
		"cuentas-9": true, "perplexity-7": true, "srf-id-cuentas-2": true, "srf-pg-editor": true}, stopVerified: true}
	m, err := NewManager(Config{BinDir: t.TempDir(), Profiles: profiles, MaxSurfaces: count, MaxOutputBytes: 4096, Timeout: time.Second, OriginNS: 100}, r, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	return m, r
}

func identityCreate(t *testing.T, m *Manager, id string) (Surface, error) {
	t.Helper()
	params, _ := json.Marshal(map[string]any{"kind": "browser", "profile_id": id, "geometry": Geometry{1280, 900}})
	events, err := m.Handle(context.Background(), req("create", string(params)))
	if err != nil {
		return Surface{}, err
	}
	var result struct {
		Data struct {
			Surface Surface `json:"surface"`
		} `json:"data"`
	}
	if err = json.Unmarshal(events[0], &result); err != nil {
		t.Fatal(err)
	}
	return result.Data.Surface, nil
}

func identityStop(t *testing.T, m *Manager, id string) error {
	t.Helper()
	_, err := m.Handle(context.Background(), req("destroy", fmt.Sprintf(`{"surface_id":%q}`, id)))
	return err
}

func TestIdentityRuntimeAdmissionAndNegativeControls(t *testing.T) {
	m, r := identityProfileManager(t, 4)
	for _, id := range []string{"missing-id", "cuentas-9", "perplexity-7", "srf-id-cuentas-2", "srf-pg-editor", "../p18d-a"} {
		if _, err := identityCreate(t, m, id); err == nil {
			t.Fatalf("unproven identity admitted: %s", id)
		}
	}
	if r.starts != 0 {
		t.Fatal("refusal performed native start")
	}
	s, err := identityCreate(t, m, "p18d-a")
	if err != nil {
		t.Fatal(err)
	}
	p := m.cfg.Profiles["p18d-a"]
	if s.ProfileID != "p18d-a" || s.Kind != "browser" || s.Geometry != (Geometry{1280, 900}) || p.TextInput != "paste" || p.RAMRoot != "/dev/shm" {
		t.Fatalf("template not inherited: %#v %#v", s, p)
	}
	if r.checks != 2 {
		t.Fatalf("existence gate bypassed: %d", r.checks)
	}
}

func TestIdentityDisplayPoolDistinctReleaseAndUncertainStop(t *testing.T) {
	m, r := identityProfileManager(t, 2)
	a, err := identityCreate(t, m, "p18d-a")
	if err != nil {
		t.Fatal(err)
	}
	b, err := identityCreate(t, m, "p18d-b")
	if err != nil {
		t.Fatal(err)
	}
	if a.Display == b.Display {
		t.Fatal("display collision")
	}
	if _, err = identityCreate(t, m, "p18d-c"); err == nil {
		t.Fatal("capacity bypassed")
	}
	r.stopVerified = false
	if identityStop(t, m, a.SurfaceID) == nil {
		t.Fatal("unverified removal released pool")
	}
	if _, err = identityCreate(t, m, "p18d-c"); err == nil {
		t.Fatal("lost binding released capacity")
	}
	r.stopVerified = true
	if err = identityStop(t, m, a.SurfaceID); err != nil {
		t.Fatal(err)
	}
	c, err := identityCreate(t, m, "p18d-c")
	if err != nil {
		t.Fatal(err)
	}
	if c.Display != a.Display {
		t.Fatalf("display was not recycled: %s != %s", c.Display, a.Display)
	}
	if _, present := m.cfg.Profiles["p18d-a"]; present {
		t.Fatal("idle dynamic profile retained")
	}
	if err = identityStop(t, m, b.SurfaceID); err != nil {
		t.Fatal(err)
	}
	if err = identityStop(t, m, c.SurfaceID); err != nil {
		t.Fatal(err)
	}
	if len(m.dynamicProfiles) != 0 {
		t.Fatal("dynamic pool allocation leaked")
	}
}

func TestIdentityStaticProfilesRemainFixedAndSharePool(t *testing.T) {
	m, _ := identityProfileManager(t, 4)
	for i := 1; i <= 4; i++ {
		id := fmt.Sprintf("mv-live-%d", i)
		s, err := identityCreate(t, m, id)
		if err != nil {
			t.Fatal(err)
		}
		if s.Display != fmt.Sprintf(":%d", 110+i) {
			t.Fatal("static profile changed")
		}
		if err = identityStop(t, m, s.SurfaceID); err != nil {
			t.Fatal(err)
		}
	}
	a, err := identityCreate(t, m, "p18d-a")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = identityCreate(t, m, "mv-live-1"); err == nil {
		t.Fatal("static/dynamic display collision admitted")
	}
	if err = identityStop(t, m, a.SurfaceID); err != nil {
		t.Fatal(err)
	}
	if _, err = identityCreate(t, m, "mv-live-1"); err != nil {
		t.Fatal(err)
	}
}

func TestIdentityTemplateAbsentAndExistenceGateAbsentRefuse(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	if _, err := identityCreate(t, m, "p18d-a"); err == nil {
		t.Fatal("invented a template")
	}
	m.identityTemplate = &Profile{Kind: "browser", NativeKind: "browser", Width: 1280, Height: 900, RAMRoot: "/dev/shm", Display: ":111"}
	m.identityDisplays = []string{":111"}
	if _, err := identityCreate(t, m, "p18d-a"); err == nil {
		t.Fatal("absent store witness admitted")
	}
	if len(r.calls) != 0 {
		t.Fatal("missing witness started native process")
	}
}

func TestIdentityProcessWitnessUsesOnlyConfiguredAdminShow(t *testing.T) {
	dir := t.TempDir()
	admin := filepath.Join(dir, "srf-identity-admin")
	script := "#!/bin/sh\n" +
		"[ \"$#\" = 3 ] && [ \"$1\" = show ] && [ \"$2\" = --id ] || exit 9\n" +
		"case \"$3\" in\n" +
		"p18d-a) printf '%s\\n' '{\"profile_id\":\"p18d-a\"}';;\n" +
		"p18d-wrong) printf '%s\\n' '{\"profile_id\":\"another-id\"}';;\n" +
		"p18d-malformed) printf '%s\\n' 'invalid';;\n" +
		"*) exit 4;;\nesac\n"
	if err := os.WriteFile(admin, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	r, err := NewProcessRunner(dir, []string{"PATH=/usr/bin:/bin"}, 4096, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err = r.IdentityExists(context.Background(), "p18d-a"); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"p18d-unknown", "p18d-wrong", "p18d-malformed", "srf-id-cuentas-1", "../p18d-a"} {
		if err = r.IdentityExists(context.Background(), id); err == nil {
			t.Fatalf("unproven metadata accepted: %s", id)
		}
	}
	for _, args := range [][]string{
		{admin, "create", "--id", "p18d-a"},
		{admin, "show", "--id", "p18d-a", "--store-root", "/tmp"},
		{filepath.Join(t.TempDir(), "srf-identity-admin"), "show", "--id", "p18d-a"},
	} {
		if _, err = r.Run(context.Background(), args, nil); err == nil {
			t.Fatalf("broadened admin authority: %q", args)
		}
	}
}

type hostExecRunner struct {
	binaries     map[string]string
	modes        map[string]string
	searchPath   string
	starts       int
	lastStart    []string
	stopVerified bool
}

func (r *hostExecRunner) SearchPath() string { return r.searchPath }

func (r *hostExecRunner) ConsumeOpeningProgram(id string) (string, error) {
	bin, _, err := r.ConsumeOpeningProgramMode(id)
	return bin, err
}

func (r *hostExecRunner) ConsumeOpeningProgramMode(id string) (string, string, error) {
	bin := r.binaries[id]
	mode := ""
	if r.modes != nil {
		mode = r.modes[id]
		delete(r.modes, id)
	}
	delete(r.binaries, id)
	return bin, mode, nil
}

func (r *hostExecRunner) Run(_ context.Context, argv []string, _ []byte) ([]byte, error) {
	switch argv[1] {
	case "start":
		r.starts++
		r.lastStart = append([]string(nil), argv...)
		id := argv[5]
		return []byte(fmt.Sprintf(`{"kind":"program","container":"srf-pg-%s","run_id":"run-pg-%d","windows":[{"id":"w1","x":0,"y":0,"w":1280,"h":900,"title":%q,"url":""}]}`, id, r.starts, id)), nil
	case "stop":
		return []byte(fmt.Sprintf(`{"stopped":%q,"removed_verified":%t}`, argv[3], r.stopVerified)), nil
	}
	return nil, fmt.Errorf("unexpected command %q", argv)
}

func TestHostExecProgramAdmissionAndBinaryResolution(t *testing.T) {
	if !admittedProgram("host-exec", 0) || admittedProgram("host-exec", 1) {
		t.Fatal("unexpected host-exec nested_depth admission")
	}
	binDir := t.TempDir()
	geditPath := filepath.Join(binDir, "gedit")
	if err := os.WriteFile(geditPath, []byte("#!/bin/sh\nexit 0\n"), 0755); err != nil {
		t.Fatal(err)
	}
	xtermPath := filepath.Join(binDir, "xterm")
	if err := os.WriteFile(xtermPath, []byte("#!/bin/sh\nexit 0\n"), 0755); err != nil {
		t.Fatal(err)
	}
	nonExecPath := filepath.Join(binDir, "not-exec")
	if err := os.WriteFile(nonExecPath, []byte("plain"), 0644); err != nil {
		t.Fatal(err)
	}

	// Static host-exec profile is refused by NewManager.
	r := &hostExecRunner{binaries: map[string]string{}, searchPath: binDir, stopVerified: true}
	if _, err := NewManager(Config{
		BinDir: t.TempDir(),
		Profiles: map[string]Profile{
			"static-prog": {Kind: "desktop_capsule", NativeKind: "program", Program: "host-exec", Width: 1280, Height: 900, RAMRoot: "/dev/shm", Display: ":111"},
		},
		MaxSurfaces: 4, MaxOutputBytes: 4096, Timeout: time.Second, OriginNS: 100,
	}, r, func() uint64 { return 200 }); err == nil {
		t.Fatal("static host-exec profile admitted by NewManager")
	}

	profiles := map[string]Profile{
		"mv-live-1": {Kind: "browser", NativeKind: "browser", Width: 1280, Height: 900, RAMRoot: "/dev/shm", Display: ":111", TextInput: "paste"},
		"mv-live-2": {Kind: "browser", NativeKind: "browser", Width: 1280, Height: 900, RAMRoot: "/dev/shm", Display: ":112", TextInput: "paste"},
		"mv-live-3": {Kind: "browser", NativeKind: "browser", Width: 1280, Height: 900, RAMRoot: "/dev/shm", Display: ":113", TextInput: "paste"},
	}
	m, err := NewManager(Config{BinDir: t.TempDir(), Profiles: profiles, MaxSurfaces: 3, MaxOutputBytes: 4096, Timeout: time.Second, OriginNS: 100}, r, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}

	// Mutant check: static host-exec injected after NewManager without per-create binary is refused at manager.go:616.
	m.cfg.Profiles["injected-static"] = Profile{Kind: "desktop_capsule", NativeKind: "program", Program: "host-exec", Width: 1280, Height: 900, RAMRoot: "/dev/shm", Display: ":119"}
	if _, err := m.Handle(context.Background(), req("create", `{"kind":"desktop_capsule","profile_id":"injected-static","geometry":{"w":1280,"h":900}}`)); err == nil {
		t.Fatal("injected static host-exec admitted without per-create binary")
	}
	delete(m.cfg.Profiles, "injected-static")

	// Static browser profile cannot be hijacked by staging a per-create binary.
	r.binaries["mv-live-1"] = "gedit"
	if _, err := m.Handle(context.Background(), req("create", `{"kind":"desktop_capsule","profile_id":"mv-live-1","geometry":{"w":1280,"h":900}}`)); err == nil {
		t.Fatal("static browser profile admitted as host-exec program")
	}

	// Protected identities stay refused even with a valid binary.
	for _, id := range []string{"cuentas-1", "perplexity-2", "srf-pg-gedit", "notepad-1", "metaviewer-1"} {
		r.binaries[id] = "gedit"
		if _, err := m.Handle(context.Background(), req("create", fmt.Sprintf(`{"kind":"desktop_capsule","profile_id":%q,"geometry":{"w":1280,"h":900}}`, id))); err == nil {
			t.Fatalf("protected identity admitted for program: %s", id)
		}
	}

	// Invalid, relative, non-executable, or missing binaries return HOST_PROGRAM_UNAVAILABLE naming the binary.
	for _, bad := range []string{"missing-bin", "./gedit", "../gedit", "gedit;id", "gedit|sh", nonExecPath, binDir} {
		r.binaries["prog-bad"] = bad
		_, err := m.Handle(context.Background(), req("create", `{"kind":"desktop_capsule","profile_id":"prog-bad","geometry":{"w":1280,"h":900}}`))
		if err == nil || WireCode(err) != "HOST_PROGRAM_UNAVAILABLE" {
			t.Fatalf("expected HOST_PROGRAM_UNAVAILABLE for %q, got %v (wire=%s)", bad, err, WireCode(err))
		}
	}
	if r.starts != 0 {
		t.Fatalf("refusals performed %d native starts", r.starts)
	}

	// Bare binary name resolved via PATH + explicit absolute path + multiple concurrent program capsules.
	r.binaries["gedit"] = "gedit"
	events1, err := m.Handle(context.Background(), req("create", `{"kind":"desktop_capsule","profile_id":"gedit","geometry":{"w":1280,"h":900}}`))
	if err != nil {
		t.Fatalf("create gedit failed: %v", err)
	}
	wantArgv := []string{
		filepath.Join(m.cfg.BinDir, "srf-identity-surface"),
		"start", "--kind", "program", "--identity", "gedit", "--windows", "1", "--program", "host-exec", "--host-binary", geditPath,
	}
	if fmt.Sprintf("%q", r.lastStart) != fmt.Sprintf("%q", wantArgv) {
		t.Fatalf("unexpected start argv:\ngot:  %q\nwant: %q", r.lastStart, wantArgv)
	}

	r.binaries["xterm"] = xtermPath
	events2, err := m.Handle(context.Background(), req("create", `{"kind":"desktop_capsule","profile_id":"xterm","geometry":{"w":1280,"h":900}}`))
	if err != nil {
		t.Fatalf("create xterm failed: %v", err)
	}

	var s1, s2 struct {
		Data struct {
			Surface Surface `json:"surface"`
		} `json:"data"`
	}
	_ = json.Unmarshal(events1[0], &s1)
	_ = json.Unmarshal(events2[0], &s2)
	if s1.Data.Surface.Display == s2.Data.Surface.Display {
		t.Fatalf("concurrent program capsules shared display %s", s1.Data.Surface.Display)
	}
	if err := identityStop(t, m, s1.Data.Surface.SurfaceID); err != nil {
		t.Fatal(err)
	}
	if err := identityStop(t, m, s2.Data.Surface.SurfaceID); err != nil {
		t.Fatal(err)
	}
	if len(m.dynamicProfiles) != 0 {
		t.Fatalf("dynamic program profiles leaked: %v", m.dynamicProfiles)
	}
}

func TestProcessRunnerHostProgramUnavailableExit2ClearsQuarantine(t *testing.T) {
	binDir := t.TempDir()
	stateDir := t.TempDir()
	if err := os.Chmod(stateDir, 0700); err != nil {
		t.Fatal(err)
	}
	surfaceBin := filepath.Join(binDir, "srf-identity-surface")
	script := "#!/bin/sh\n" +
		"echo '{\"error\":{\"code\":2,\"detail\":\"host_program_unavailable: gedit rejected by surface\"}}' >&2\n" +
		"exit 2\n"
	if err := os.WriteFile(surfaceBin, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	geditPath := filepath.Join(binDir, "gedit")
	if err := os.WriteFile(geditPath, []byte("#!/bin/sh\nexit 0\n"), 0755); err != nil {
		t.Fatal(err)
	}
	r, err := NewProcessRunner(binDir, []string{"PATH=" + binDir, "MV_SRF_STATE_DIR=" + stateDir}, 4096, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	modesDir := filepath.Join(stateDir, "opening-modes")
	if err := os.Mkdir(modesDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(modesDir, "gedit.json"), []byte(`{"schema":"metaviewer.opening_mode/v0.3","profile_id":"gedit","mode":"agent","host_binary":"gedit"}`), 0600); err != nil {
		t.Fatal(err)
	}
	m, err := NewManager(Config{
		BinDir: binDir,
		Profiles: map[string]Profile{
			"mv-live-1": {Kind: "browser", NativeKind: "browser", Width: 1280, Height: 900, RAMRoot: "/dev/shm", Display: ":111"},
		},
		MaxSurfaces: 2, MaxOutputBytes: 4096, Timeout: time.Second, OriginNS: 100,
	}, r, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	_, err = m.Handle(context.Background(), req("create", `{"kind":"desktop_capsule","profile_id":"gedit","geometry":{"w":1280,"h":900}}`))
	if err == nil || WireCode(err) != "HOST_PROGRAM_UNAVAILABLE" || err.Error() != "host_program_unavailable: host_program_unavailable: gedit rejected by surface" {
		t.Fatalf("expected clean HOST_PROGRAM_UNAVAILABLE detail, got %v (wire=%s)", err, WireCode(err))
	}
	if m.quarantined["gedit"] || m.dynamicProfiles["gedit"] {
		t.Fatalf("exit-2 pre-spawn refusal left profile quarantined or allocated: quarantined=%v dynamic=%v", m.quarantined, m.dynamicProfiles)
	}
}

func TestProcessRunnerPreservesBoundedStderrReasonOnNonZeroExit(t *testing.T) {
	binDir := t.TempDir()
	stateDir := t.TempDir()
	if err := os.Chmod(stateDir, 0700); err != nil {
		t.Fatal(err)
	}
	surfaceBin := filepath.Join(binDir, "srf-identity-surface")
	longReason := "surface-setup-rejected-" + strings.Repeat("x", 300)
	script := "#!/bin/sh\n" +
		"if [ \"$1\" = \"long\" ]; then\n" +
		"  printf '%s\\nsecond-line\\n' " + fmt.Sprintf("%q", longReason) + " >&2\n" +
		"  exit 3\n" +
		"fi\n" +
		"echo 'display :111 Xpra socket failed to bind' >&2\n" +
		"exit 6\n"
	if err := os.WriteFile(surfaceBin, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	r, err := NewProcessRunner(binDir, []string{"PATH=" + binDir, "MV_SRF_STATE_DIR=" + stateDir}, 4096, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_, err = r.Run(context.Background(), []string{surfaceBin, "start"}, nil)
	var f *cli.Fault
	if !errors.As(err, &f) || f.Code != "refused" || !strings.Contains(f.Detail, "display :111 Xpra socket failed to bind") {
		t.Fatalf("expected refused fault preserving stderr reason, got %v", err)
	}

	_, err = r.Run(context.Background(), []string{surfaceBin, "long"}, nil)
	if !errors.As(err, &f) || f.Code != "setup" {
		t.Fatalf("expected setup fault, got %v", err)
	}
	wantBounded := longReason[:256]
	if !strings.HasSuffix(f.Detail, ": "+wantBounded) || strings.Contains(f.Detail, "second-line") {
		t.Fatalf("expected bounded 256-byte single-line reason, got %q", f.Detail)
	}

	// Mutant guard: stripping extractExitReason loses the surface stderr reason.
	bare := cli.ExitFault("srf-identity-surface", 6, "")
	if strings.Contains(bare.Error(), "display :111 Xpra socket failed to bind") {
		t.Fatal("mutant guard failed: bare ExitFault unexpectedly contained stderr reason")
	}
}

func TestRunnerEmptySearchPathNeverFallsBackToAmbientPATH(t *testing.T) {
	ambientDir := t.TempDir()
	geditPath := filepath.Join(ambientDir, "gedit")
	if err := os.WriteFile(geditPath, []byte("#!/bin/sh\nexit 0\n"), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", ambientDir)

	r := &hostExecRunner{
		binaries:     map[string]string{"gedit": "gedit"},
		searchPath:   "",
		stopVerified: true,
	}
	m, err := NewManager(Config{
		BinDir: t.TempDir(),
		Profiles: map[string]Profile{
			"mv-live-1": {Kind: "browser", NativeKind: "browser", Width: 1280, Height: 900, RAMRoot: "/dev/shm", Display: ":111", TextInput: "paste"},
		},
		MaxSurfaces: 2, MaxOutputBytes: 4096, Timeout: time.Second, OriginNS: 100,
	}, r, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	if got := m.runnerSearchPath(); got != "" {
		t.Fatalf("runner with empty SearchPath fell back to %q", got)
	}
	_, err = m.Handle(context.Background(), req("create", `{"kind":"desktop_capsule","profile_id":"gedit","geometry":{"w":1280,"h":900}}`))
	if err == nil || WireCode(err) != "HOST_PROGRAM_UNAVAILABLE" || r.starts != 0 {
		t.Fatalf("empty runner SearchPath resolved binary from daemon PATH: err=%v starts=%d", err, r.starts)
	}

	// Mutant guard: if runnerSearchPath fell back to os.Getenv("PATH"), ResolveHostBinary would succeed.
	if resolved, mErr := ResolveHostBinary("gedit", os.Getenv("PATH")); mErr != nil || resolved != geditPath {
		t.Fatalf("mutant setup invalid: ambient PATH should resolve gedit, got %q (%v)", resolved, mErr)
	}
}

func TestHostExecProgramHumanModeAndBinding(t *testing.T) {
	binDir := t.TempDir()
	stateDir := t.TempDir()
	if err := os.Chmod(stateDir, 0700); err != nil {
		t.Fatal(err)
	}
	surfaceBin := filepath.Join(binDir, "srf-identity-surface")
	if err := os.WriteFile(surfaceBin, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	geditPath := filepath.Join(binDir, "gedit")
	if err := os.WriteFile(geditPath, []byte("#!/bin/sh\nexit 0\n"), 0755); err != nil {
		t.Fatal(err)
	}

	pr, err := NewProcessRunner(binDir, []string{"PATH=" + binDir, "MV_SRF_STATE_DIR=" + stateDir}, 4096, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	modesDir := filepath.Join(stateDir, "opening-modes")
	if err := os.Mkdir(modesDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(modesDir, "gedit.json"), []byte(`{"schema":"metaviewer.opening_mode/v0.3","profile_id":"gedit","mode":"human","host_binary":"`+geditPath+`"}`), 0600); err != nil {
		t.Fatal(err)
	}
	gotBin, gotMode, err := pr.ConsumeOpeningProgramMode("gedit")
	if err != nil || gotBin != geditPath || gotMode != "human" {
		t.Fatalf("expected (%q, \"human\", nil), got (%q, %q, %v)", geditPath, gotBin, gotMode, err)
	}
	if err := os.WriteFile(filepath.Join(modesDir, "gedit.json"), []byte(`{"schema":"metaviewer.opening_mode/v0.3","profile_id":"gedit","mode":"invalid","host_binary":"`+geditPath+`"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := pr.ConsumeOpeningProgramMode("gedit"); err == nil {
		t.Fatal("expected invalid mode to be refused by ConsumeOpeningProgramMode")
	}

	r := &hostExecRunner{
		binaries:     map[string]string{"gedit": geditPath},
		modes:        map[string]string{"gedit": "human"},
		searchPath:   binDir,
		stopVerified: true,
	}
	profiles := map[string]Profile{
		"mv-live-1": {Kind: "browser", NativeKind: "browser", Width: 1280, Height: 900, RAMRoot: "/dev/shm", Display: ":111", TextInput: "paste"},
		"mv-live-2": {Kind: "browser", NativeKind: "browser", Width: 1280, Height: 900, RAMRoot: "/dev/shm", Display: ":112", TextInput: "paste"},
	}
	m, err := NewManager(Config{BinDir: binDir, Profiles: profiles, MaxSurfaces: 2, MaxOutputBytes: 4096, Timeout: time.Second, OriginNS: 100}, r, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}

	events1, err := m.Handle(context.Background(), req("create", `{"kind":"desktop_capsule","profile_id":"gedit","geometry":{"w":1280,"h":900}}`))
	if err != nil {
		t.Fatalf("human host-exec program create failed: %v", err)
	}
	var created struct {
		Data struct {
			Surface Surface `json:"surface"`
		} `json:"data"`
	}
	if err := json.Unmarshal(events1[0], &created); err != nil {
		t.Fatal(err)
	}
	if created.Data.Surface.Control != "human" || created.Data.Surface.ProfileID != "gedit" {
		t.Fatalf("expected human control on gedit surface, got %+v", created.Data.Surface)
	}

	binding, ok := m.bindings[created.Data.Surface.SurfaceID]
	if !ok || binding.Role != "human" || binding.NativeKind != "program" || binding.Program != "host-exec" || binding.Container != "srf-pg-gedit" {
		t.Fatalf("unexpected Binding for host-exec program: ok=%t binding=%+v", ok, binding)
	}
	if err := os.Mkdir(filepath.Join(stateDir, "human-bindings"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := pr.PublishHumanBinding(binding, true, 0); err != nil {
		t.Fatalf("PublishHumanBinding failed for host-exec program: %v", err)
	}
	rawBinding, err := os.ReadFile(filepath.Join(stateDir, "human-bindings", created.Data.Surface.SurfaceID+".json"))
	if err != nil {
		t.Fatalf("expected human binding file on disk: %v", err)
	}
	if !strings.Contains(string(rawBinding), `"container":"srf-pg-gedit"`) || !strings.Contains(string(rawBinding), `"role":"human"`) {
		t.Fatalf("unexpected binding JSON: %s", string(rawBinding))
	}

	// Non-host-exec programs (notepad, metaviewer-nested) stay refused for human mode and ignored by PublishHumanBinding.
	if err := pr.PublishHumanBinding(Binding{
		Role:       "human",
		Surface:    Surface{SurfaceID: "surface_notepad", ProfileID: "notepad-1", Geometry: Geometry{W: 1280, H: 900}},
		NativeKind: "program", Program: "notepad", Container: "srf-pg-notepad-1", RunID: "run-1",
	}, true, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "human-bindings", "surface_notepad.json")); !os.IsNotExist(err) {
		t.Fatalf("expected non-host-exec program binding to be skipped, stat err=%v", err)
	}

	// Stop frees dynamic profile and display so a subsequent create reuses the profile and display.
	firstDisplay := created.Data.Surface.Display
	if err := identityStop(t, m, created.Data.Surface.SurfaceID); err != nil {
		t.Fatal(err)
	}
	if len(m.dynamicProfiles) != 0 {
		t.Fatalf("dynamic profile leaked after stop: %v", m.dynamicProfiles)
	}
	r.binaries["gedit"] = geditPath
	r.modes["gedit"] = "human"
	events2, err := m.Handle(context.Background(), req("create", `{"kind":"desktop_capsule","profile_id":"gedit","geometry":{"w":1280,"h":900}}`))
	if err != nil {
		t.Fatalf("re-create gedit after stop failed: %v", err)
	}
	var created2 struct {
		Data struct {
			Surface Surface `json:"surface"`
		} `json:"data"`
	}
	_ = json.Unmarshal(events2[0], &created2)
	if created2.Data.Surface.Display != firstDisplay || created2.Data.Surface.Control != "human" {
		t.Fatalf("expected reused display %s and human control, got %+v", firstDisplay, created2.Data.Surface)
	}
	if err := identityStop(t, m, created2.Data.Surface.SurfaceID); err != nil {
		t.Fatal(err)
	}
}
