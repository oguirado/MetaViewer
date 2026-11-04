package resourceinventory

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func fixture(t *testing.T) (Config, syscall.Stat_t) {
	t.Helper()
	root := t.TempDir()
	if e := os.Chmod(root, 0700); e != nil {
		t.Fatal(e)
	}
	s, _ := os.Stat(root)
	st := *s.Sys().(*syscall.Stat_t)
	pin := Pin{filepath.Join(root, "producer"), strings.Repeat("a", 64)}
	c := Config{Root: root, Journal: filepath.Join(root, "allocations.jsonl"), RunID: strings.Repeat("a", 24), Actor: "actor-" + strings.Repeat("b", 64), SourceCommit: strings.Repeat("c", 40), ASAR: strings.Repeat("d", 64), SessionHelper: pin.SHA256, SetupHelper: pin.SHA256, Registry: pin.SHA256, ProducerPins: map[string]Pin{"setup": pin, "graphical": pin, "guestcommand": pin}, Manifest: pin, Images: map[string]string{"vm": "sha256:" + strings.Repeat("a", 64), "program": "sha256:" + strings.Repeat("b", 64)}}
	group := "/user.slice/user-" + itoa(os.Getuid()) + ".slice/user@" + itoa(os.Getuid()) + ".service/newton-ia.slice/" + c.unit()
	bodies := []map[string]any{c.header(st), {"stage": "guardian_bound", "producer": "setup", "id": "guardian", "unit": c.unit(), "invocation": strings.Repeat("a", 32), "cgroup": group, "device": st.Dev, "inode": st.Ino}, {"stage": "app_pending", "producer": "setup", "id": "app"}, {"stage": "app_bound", "producer": "setup", "id": "app", "pid": 12, "start_ticks": 13, "cgroup": group}}
	raw := rows(bodies)
	if _, e := parseHistory(c, raw, st); e != nil {
		t.Fatal(e)
	}
	for name, data := range map[string][]byte{"allocations.lock": nil, "allocations.jsonl": raw} {
		if e := os.WriteFile(filepath.Join(root, name), data, 0600); e != nil {
			t.Fatal(e)
		}
	}
	return c, st
}
func itoa(n int) string            { return stringNumber(uint64(n)) }
func stringNumber(n uint64) string { b, _ := json.Marshal(n); return string(b) }
func rows(bodies []map[string]any) []byte {
	var raw []byte
	prev := strings.Repeat("0", 64)
	for i, b := range bodies {
		payload, _ := json.Marshal(b)
		r := Row{Schema: "capsule_resource_inventory/v0.2", Seq: uint64(i + 1), Prev: prev, Payload: string(payload)}
		r.SHA256 = rowHash(r.Seq, r.Prev, r.Payload)
		line, _ := json.Marshal(r)
		raw = append(raw, append(line, '\n')...)
		prev = r.SHA256
	}
	return raw
}
func mustOpen(t *testing.T, c Config, name string) *Producer {
	t.Helper()
	p, e := open(c, name, false)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = p.Seal() })
	return p
}
func TestInventoryDurableServiceLifecycleAndSeals(t *testing.T) {
	c, st := fixture(t)
	p := mustOpen(t, c, "guestcommand")
	unit := "mv-guest-command-" + strings.Repeat("a", 16) + ".service"
	group := "/user.slice/user-" + itoa(os.Getuid()) + ".slice/user@" + itoa(os.Getuid()) + ".service/newton-ia.slice/" + unit
	if e := p.ServicePending(unit, unit); e != nil {
		t.Fatal(e)
	}
	if e := p.ServiceBound(unit, unit, strings.Repeat("b", 32), group, st.Dev, st.Ino, 123, "456"); e != nil {
		t.Fatal(e)
	}
	if e := p.ServiceClosed(unit); e != nil {
		t.Fatal(e)
	}
	if e := p.Seal(); e != nil {
		t.Fatal(e)
	}
	raw, _ := os.ReadFile(c.Journal)
	h, e := parseHistory(c, raw, st)
	if e != nil || !h.Sealed["guestcommand"] || h.Resources["guestcommand:"+unit]["closed"] == nil {
		t.Fatal(h, e)
	}
	if e := p.ServicePending("other", unit); e == nil {
		t.Fatal("post seal write")
	}
	if _, e := open(c, "guestcommand", false); e == nil {
		t.Fatal("sealed producer reopened")
	}
}
func TestInventoryFailurePoisonsBeforeNextEffect(t *testing.T) {
	c, _ := fixture(t)
	p := mustOpen(t, c, "guestcommand")
	p.syncFile = func(*os.File) error { return errors.New("fsync fault") }
	unit := "mv-guest-command-" + strings.Repeat("a", 16) + ".service"
	if e := p.ServicePending(unit, unit); e == nil {
		t.Fatal("fsync accepted")
	}
	if !p.poisoned {
		t.Fatal("not fenced")
	}
	before, _ := os.ReadFile(c.Journal)
	if e := p.ServicePending("next", unit); e == nil {
		t.Fatal("poison bypass")
	}
	after, _ := os.ReadFile(c.Journal)
	if string(before) != string(after) {
		t.Fatal("write after poison")
	}
}
func TestInventorySingleProducerAndChangedPaths(t *testing.T) {
	for _, kind := range []string{"reopen", "journal-alias", "root-replaced", "hardlink"} {
		t.Run(kind, func(t *testing.T) {
			c, _ := fixture(t)
			p := mustOpen(t, c, "graphical")
			switch kind {
			case "reopen":
				if _, e := open(c, "graphical", false); e == nil {
					t.Fatal("second owner")
				}
				return
			case "journal-alias":
				os.Rename(c.Journal, c.Journal+".old")
				os.Symlink(c.Journal+".old", c.Journal)
			case "hardlink":
				os.Link(c.Journal, c.Journal+".alias")
			case "root-replaced":
				os.Rename(c.Root, c.Root+".old")
				os.Mkdir(c.Root, 0700)
				t.Cleanup(func() { os.RemoveAll(c.Root + ".old") })
			}
			if e := p.Unknown("x"); e == nil {
				t.Fatal("changed custody accepted")
			}
		})
	}
}
func TestInventoryMalformedChainAndStrictTypes(t *testing.T) {
	c, st := fixture(t)
	raw, _ := os.ReadFile(c.Journal)
	for _, bad := range [][]byte{raw[:len(raw)-1], append(append([]byte(nil), raw...), []byte("{}\n")...), []byte(strings.Replace(string(raw), `"seq":1`, `"seq":true`, 1)), []byte(strings.Replace(string(raw), `capsule_resource_inventory/v0.2`, `foreign/v0.2`, 1))} {
		if _, e := parseHistory(c, bad, st); e == nil {
			t.Fatal("invalid chain")
		}
	}
	for _, v := range []any{true, nil, "1", json.Number("1.0"), json.Number("9007199254740992")} {
		if _, e := number(v); e == nil {
			t.Fatal("bad integer", v)
		}
	}
}
func TestInventoryClosedStageRequiresExactBoundIdentity(t *testing.T) {
	c, _ := fixture(t)
	p := mustOpen(t, c, "guestcommand")
	if e := p.ServiceClosed("missing"); e == nil {
		t.Fatal("unbound closed")
	}
	if e := p.ServicePending("one", "foreign.service"); e == nil {
		t.Fatal("foreign unit")
	}
	if e := p.Append("app_pending", "app", nil); e == nil {
		t.Fatal("foreign producer stage")
	}
}
func TestInventoryProgramTupleAdmission(t *testing.T) {
	for _, tc := range []struct {
		profile, container, image, payload string
		ok                                 bool
	}{{"xterm", "srf-pg-xterm", "program", "", true}, {"xterm-2", "srf-pg-xterm-2", "program", "", true}, {"srf-pg-foreign", "srf-pg-srf-pg-foreign", "program", "", false}, {"../other", "srf-pg-../other", "program", "", false}, {"xterm", "srf-pg-other", "program", "", false}, {"xterm", "srf-pg-xterm", "vm", "", false}, {"xterm", "srf-pg-xterm", "program", "/foreign", false}} {
		t.Run(tc.profile+tc.container+tc.image+tc.payload, func(t *testing.T) {
			c, st := fixture(t)
			p := mustOpen(t, c, "graphical")
			payload := filepath.Join(c.Root, "store", "profiles", tc.profile)
			if tc.payload != "" {
				payload = tc.payload
			}
			e := p.Append("native_pending", "surface-1", map[string]any{"generation": "surface-1", "profile_id": tc.profile, "native_kind": "program", "container_name": tc.container, "image_id": c.Images[tc.image], "payload": payload, "payload_device": st.Dev, "payload_inode": st.Ino})
			if (e == nil) != tc.ok {
				t.Fatal(e)
			}
		})
	}
}
func TestInventoryProtectedFileRefusesFIFOAliasHardlink(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "file")
	os.WriteFile(path, []byte("ok"), 0600)
	if _, e := readProtected(path, 20, true); e != nil {
		t.Fatal(e)
	}
	for _, mode := range []os.FileMode{0400, 0700, 0640} {
		os.Chmod(path, mode)
		if _, e := readProtected(path, 20, true); e == nil {
			t.Fatal("non0600 private mode", mode)
		}
	}
	os.Chmod(path, 0600)
	os.Symlink(path, path+".link")
	if _, e := readProtected(path+".link", 20, true); e == nil {
		t.Fatal("symlink")
	}
	os.Link(path, path+".hard")
	if _, e := readProtected(path, 20, true); e == nil {
		t.Fatal("hardlink")
	}
	fifo := filepath.Join(dir, "fifo")
	if e := syscall.Mkfifo(fifo, 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := readProtected(fifo, 20, true); e == nil {
		t.Fatal("FIFO")
	}
}

type fakeObserver struct {
	snapshot NativeSnapshot
	pid      *NativePID
	err      error
	absent   bool
	calls    int
}

func (f *fakeObserver) Inspect(context.Context, string) (NativeSnapshot, error) {
	f.calls++
	return f.snapshot, f.err
}
func (f *fakeObserver) Absent(context.Context, string) (bool, error) { return f.absent, f.err }
func (f *fakeObserver) PID(uint64) (*NativePID, error)               { return f.pid, f.err }
func TestInventoryNativeClosureNeedsCIDPIDAndStateAbsence(t *testing.T) {
	for _, mode := range []string{"closed", "cid-live", "pid-live", "pid-unknown", "state-present"} {
		t.Run(mode, func(t *testing.T) {
			c, st := fixture(t)
			p := mustOpen(t, c, "graphical")
			profile := c.profile("vm")
			name := "srf-vm-" + profile
			state := filepath.Join(c.Root, "native-state", name+".json")
			if e := p.Append("native_pending", "one", map[string]any{"generation": "one", "profile_id": profile, "native_kind": "vm", "container_name": name, "image_id": c.Images["vm"], "payload": filepath.Join(c.Root, "store", "profiles", profile), "payload_device": st.Dev, "payload_inode": st.Ino}); e != nil {
				t.Fatal(e)
			}
			if e := p.Append("native_bound", "one", map[string]any{"container_name": name, "run_id": name, "cid": strings.Repeat("c", 64), "native_pid": NativePID{123, 456}, "native_state_path": state, "native_state_sha256": strings.Repeat("d", 64)}); e != nil {
				t.Fatal(e)
			}
			f := &fakeObserver{absent: true}
			switch mode {
			case "cid-live":
				f.absent = false
			case "pid-live":
				f.pid = &NativePID{123, 456}
			case "pid-unknown":
				f.err = errors.New("permission")
			case "state-present":
				os.MkdirAll(filepath.Dir(state), 0700)
				os.WriteFile(state, []byte("{}"), 0600)
			}
			g := Graphical{producer: p, observer: f}
			e := g.Closed(context.Background(), "one")
			if (e == nil) != (mode == "closed") {
				t.Fatal(e)
			}
		})
	}
}

type ownerInfo struct {
	os.FileInfo
	st syscall.Stat_t
}

func (s ownerInfo) Sys() any { return &s.st }
func TestInventoryNativeBindingUsesObservedImagePIDLeaseAndInode(t *testing.T) {
	for _, mode := range []string{"valid", "wrong-image", "foreign-mount", "wrong-lease", "missing-pid", "pid-io", "state-alias", "payload-inode"} {
		t.Run(mode, func(t *testing.T) {
			c, _ := fixture(t)
			p := mustOpen(t, c, "graphical")
			profile := c.profile("vm")
			name := "srf-vm-" + profile
			payload := filepath.Join(c.Root, "store", "profiles", profile)
			os.MkdirAll(payload, 0700)
			os.MkdirAll(filepath.Join(c.Root, "native-state"), 0700)
			statePath := filepath.Join(c.Root, "native-state", name+".json")
			state := map[string]any{"kind": "vm", "Capsule": map[string]any{"kind": "vm", "container": name, "run_id": name}, "Lease": map[string]any{"ProfileID": profile, "Holder": name}}
			if mode == "wrong-lease" {
				state["Lease"].(map[string]any)["Holder"] = "foreign"
			}
			raw, _ := json.Marshal(state)
			os.WriteFile(statePath, raw, 0600)
			f := &fakeObserver{snapshot: NativeSnapshot{CID: strings.Repeat("c", 64), Name: "/" + name, Image: c.Images["vm"], PID: 123, Running: true, Memory: 8 << 30, Swap: 8 << 30, Mounts: []Mount{{payload, "/profile"}}}, pid: &NativePID{123, 456}}
			calls := 0
			g := Graphical{producer: p, observer: f, payloadStat: func(path string) (os.FileInfo, error) {
				calls++
				s, e := os.Stat(path)
				if e != nil {
					return nil, e
				}
				st := *s.Sys().(*syscall.Stat_t)
				st.Uid = 10001
				st.Gid = 10001
				if mode == "payload-inode" && calls > 1 {
					st.Ino++
				}
				return ownerInfo{s, st}, nil
			}}
			if e := g.Pending("one", profile, "vm", name); e != nil {
				t.Fatal(e)
			}
			switch mode {
			case "wrong-image":
				f.snapshot.Image = "sha256:" + strings.Repeat("b", 64)
			case "foreign-mount":
				f.snapshot.Mounts[0].Source = "/foreign"
			case "missing-pid":
				f.pid = nil
			case "pid-io":
				f.err = errors.New("permission")
			case "state-alias":
				os.Rename(statePath, statePath+".real")
				os.Symlink(statePath+".real", statePath)
			}
			e := g.Bound(context.Background(), "one", name, name)
			if (e == nil) != (mode == "valid") {
				t.Fatal(e)
			}
			h, e := p.history()
			if e != nil {
				t.Fatal(e)
			}
			bound := h.Resources["graphical:one"]["bound"] != nil
			if bound != (mode == "valid") {
				t.Fatal("invalid actual binding")
			}
			if mode != "valid" && len(h.Resources) < 2 {
				t.Fatal("capture failure missing unknown")
			}
		})
	}
}

func TestInventoryAuxiliaryHelperTupleParity(t *testing.T) {
	for _, mode := range []string{"valid", "wrong-image", "wrong-root", "wrong-id", "no-aux"} {
		t.Run(mode, func(t *testing.T) {
			c, st := fixture(t)
			c.Images["browser"] = "sha256:" + strings.Repeat("e", 64)
			c.IdentityProvisioner = &Pin{filepath.Join(c.Root, "mv_identity.py"), strings.Repeat("a", 64)}
			if mode == "no-aux" {
				c.IdentityProvisioner = nil
			}
			p := mustOpen(t, c, "setup")
			name := "mv-provision-xterm-" + strings.Repeat("a", 12)
			id := name
			image := c.Images["browser"]
			payload := filepath.Join(c.Root, "store", "profiles", "xterm")
			switch mode {
			case "wrong-image":
				image = c.Images["vm"]
			case "wrong-root":
				payload = "/foreign"
			case "wrong-id":
				id = "foreign"
			}
			e := p.Append("helper_pending", id, map[string]any{"name": name, "image_id": image, "payload": payload, "payload_device": st.Dev, "payload_inode": st.Ino})
			if (e == nil) != (mode == "valid") {
				t.Fatal(e)
			}
		})
	}
}

func TestInventoryPythonRowParityFixture(t *testing.T) {
	output := os.Getenv("MV_INVENTORY_PARITY_OUT")
	c, st := fixture(t)
	p := mustOpen(t, c, "guestcommand")
	unit := "mv-guest-command-" + strings.Repeat("a", 16) + ".service"
	group := "/user.slice/user-" + itoa(os.Getuid()) + ".slice/user@" + itoa(os.Getuid()) + ".service/newton-ia.slice/" + unit
	for _, e := range []error{p.ServicePending(unit, unit), p.ServiceBound(unit, unit, strings.Repeat("b", 32), group, st.Dev, st.Ino, 123, "456"), p.ServiceClosed(unit), p.Seal()} {
		if e != nil {
			t.Fatal(e)
		}
	}
	raw, e := os.ReadFile(c.Journal)
	if e != nil {
		t.Fatal(e)
	}
	h, e := parseHistory(c, raw, st)
	if e != nil {
		t.Fatal(e)
	}
	if output == "" {
		return
	}
	encoded, e := json.Marshal(map[string]any{"config": c, "root_device": st.Dev, "root_inode": st.Ino, "raw": string(raw), "expected_rows": len(h.Rows), "expected_guestcommand_sealed": true})
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(output, append(encoded, '\n'), 0600); e != nil {
		t.Fatal(e)
	}
}
