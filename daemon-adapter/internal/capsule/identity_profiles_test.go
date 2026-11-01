package capsule

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
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
