//go:build live

package capsule

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestLiveHostXpraPrivateDisplay(t *testing.T) {
	bin := os.Getenv("MV_HOST_XPRA_BIN_DIR")
	if bin == "" {
		t.Fatal("MV_HOST_XPRA_BIN_DIR is required")
	}
	state, err := os.MkdirTemp("", "hx-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(state)
	r, err := NewProcessRunner(bin, []string{"PATH=" + os.Getenv("PATH"), "MV_SRF_STATE_DIR=" + state}, 1<<20, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	appName := os.Getenv("MV_HOST_XPRA_LIVE_APP")
	if appName == "" {
		appName = "xclock"
	}
	app, err := exec.LookPath(appName)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	p, err := startHostXpra(ctx, r, app, "srf-pg-hx-live", "human")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if p != nil {
			if e := p.stop(); e != nil {
				t.Error(e)
			}
		}
	}()
	if p.display == ":0" || p.display == ":97" || p.display == ":98" {
		t.Fatal("excluded display", p.display)
	}
	t.Logf("private display=%s anchor=%d port=127.0.0.1:%d", p.display, p.anchor.Process.Pid, p.port)
	tcp, err := os.ReadFile("/proc/net/tcp")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, line := range strings.Split(string(tcp), "\n") {
		f := strings.Fields(line)
		if len(f) > 3 && f[3] == "0A" && strings.HasSuffix(f[1], fmt.Sprintf(":%04X", p.port)) {
			if f[1] != fmt.Sprintf("0100007F:%04X", p.port) {
				t.Fatal("listener is not loopback only", f[1])
			}
			found = true
		}
	}
	if !found {
		t.Fatal("loopback listener ownership absent")
	}
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/", p.port))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	t.Logf("HTTP status=%d", response.StatusCode)
	var rows struct {
		Windows []struct {
			XID     uint32 `json:"xid"`
			PID     int    `json:"pid"`
			Witness string `json:"witness"`
		} `json:"windows"`
	}
	var output []byte
	for i := 0; i < 50; i++ {
		cmd := exec.CommandContext(ctx, filepath.Join(bin, "srf-host-window"), append([]string{"list"}, HostWindowSessionArgs(p.display, p.authority)...)...)
		output, err = cmd.Output()
		if err == nil {
			err = json.Unmarshal(output, &rows)
			if err == nil {
				owned := rows.Windows[:0]
				for _, w := range rows.Windows {
					_, group, state, e := processWitness(w.PID)
					if e == nil && group == p.anchor.Process.Pid && state != "Z" {
						owned = append(owned, w)
					}
				}
				rows.Windows = owned
				if len(rows.Windows) > 0 {
					break
				}
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil || len(rows.Windows) == 0 {
		t.Fatalf("list: %s %v diagnostics=%s", output, err, p.log.String())
	}
	t.Logf("real list output=%s", strings.TrimSpace(string(output)))
	if dir := os.Getenv("MV_HOST_XPRA_RECORD_FIXTURES"); dir != "" {
		if err = os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, "list.json"), output, 0600); err != nil {
			t.Fatal(err)
		}
	}
	w := rows.Windows[0]
	if strings.Contains(strings.ToLower(filepath.Base(app)), "chrome") || strings.Contains(strings.ToLower(filepath.Base(app)), "chromium") {
		cmdline, e := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", w.PID))
		if e != nil {
			t.Fatal(e)
		}
		if !strings.Contains(string(cmdline), "--user-data-dir="+filepath.Join(p.root, "browser")) {
			t.Fatal("fresh RAM browser profile not witnessed")
		}
		t.Log("fresh RAM browser profile witnessed in owned browser argv")
	}
	args := []string{"capture", "--xid", fmt.Sprint(w.XID), "--witness", w.Witness, "--max-frames", "1"}
	args = append(args, HostWindowSessionArgs(p.display, p.authority)...)
	output, err = exec.CommandContext(ctx, filepath.Join(bin, "srf-host-window"), args...).Output()
	if err != nil {
		t.Fatal("capture", err)
	}
	if dir := os.Getenv("MV_HOST_XPRA_RECORD_FIXTURES"); dir != "" {
		if err = os.WriteFile(filepath.Join(dir, "capture.xwd"), output, 0600); err != nil {
			t.Fatal(err)
		}
	}
	rgb, width, height, err := DecodeHostWindowXWD(output)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("XWD bytes=%d RGB=%d dimensions=%dx%d", len(output), len(rgb), width, height)
	args = []string{"input", "--xid", fmt.Sprint(w.XID), "--witness", w.Witness, "--key", "Return"}
	args = append(args, HostWindowSessionArgs(p.display, p.authority)...)
	output, err = exec.CommandContext(ctx, filepath.Join(bin, "srf-host-window"), args...).CombinedOutput()
	if err != nil {
		t.Fatalf("input: %s %v", output, err)
	}
	t.Logf("real input output=%s", strings.TrimSpace(string(output)))
	if dir := os.Getenv("MV_HOST_XPRA_RECORD_FIXTURES"); dir != "" {
		if err = os.WriteFile(filepath.Join(dir, "input.json"), output, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if electron := os.Getenv("MV_HOST_XPRA_ELECTRON"); electron != "" {
		sleep, e := exec.LookPath("sleep")
		if e != nil {
			t.Fatal(e)
		}
		anchor := exec.Command(sleep, "120")
		anchor.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if e = anchor.Start(); e != nil {
			t.Fatal(e)
		}
		start, _, _, e := processWitness(anchor.Process.Pid)
		if e != nil {
			t.Fatal(e)
		}
		owned := &hostXpraProcess{anchor: anchor, start: start, root: t.TempDir(), view: t.TempDir()}
		defer func() {
			if e := owned.stop(); e != nil {
				t.Error(e)
			}
		}()
		xvfb, e := exec.LookPath("xvfb-run")
		if e != nil {
			t.Fatal(e)
		}
		script, e := filepath.Abs(filepath.Join("..", "..", "..", "ui", "test", "live-host-xpra.mjs"))
		if e != nil {
			t.Fatal(e)
		}
		cmd := exec.CommandContext(ctx, xvfb, "-a", electron, script, "--user-data-dir="+owned.root, "--js-flags=--max-old-space-size=256")
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pgid: anchor.Process.Pid}
		cmd.WaitDelay = time.Second
		for _, item := range os.Environ() {
			if !strings.HasPrefix(item, "ELECTRON_RUN_AS_NODE=") && !strings.HasPrefix(item, "DISPLAY=") && !strings.HasPrefix(item, "XAUTHORITY=") {
				cmd.Env = append(cmd.Env, item)
			}
		}
		cmd.Env = append(cmd.Env, "MV_HOST_XPRA_VIEW_ROOT="+filepath.Dir(p.view), "MV_HOST_XPRA_CONTAINER="+filepath.Base(p.view), "HOME="+owned.root)
		out, e := cmd.CombinedOutput()
		if e != nil || !strings.Contains(string(out), "HOST_XPRA_HUMAN_TILE_READY_MAXIMIZE_NAVIGATION") {
			t.Fatalf("human tile: %v %s", e, out)
		}
		t.Log("HOST_XPRA_HUMAN_TILE_READY_MAXIMIZE_NAVIGATION")
	}
	if err = p.stop(); err != nil {
		t.Fatal(err)
	}
	p = nil
}

func TestLiveHostXpraManagerHumanAndAgent(t *testing.T) {
	bin := os.Getenv("MV_HOST_XPRA_BIN_DIR")
	if bin == "" {
		t.Fatal("MV_HOST_XPRA_BIN_DIR is required")
	}
	for _, role := range []string{"human", "agent"} {
		t.Run(role, func(t *testing.T) {
			state, err := os.MkdirTemp("", "hxm-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(state)
			ram, err := os.MkdirTemp("/dev/shm", "hxm-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(ram)
			for _, name := range []string{"opening-modes", "human-bindings"} {
				if err = os.Mkdir(filepath.Join(state, name), 0700); err != nil {
					t.Fatal(err)
				}
			}
			r, err := NewProcessRunner(bin, []string{"PATH=" + os.Getenv("PATH"), "MV_SRF_STATE_DIR=" + state}, 1<<20, 30*time.Second)
			if err != nil {
				t.Fatal(err)
			}
			m, err := NewManager(Config{BinDir: bin, MaxSurfaces: 16, MaxOutputBytes: 1 << 20, Timeout: 30 * time.Second, OriginNS: 1, Profiles: map[string]Profile{"template": {Kind: "browser", NativeKind: "browser", Width: 1280, Height: 900, Display: ":100", RAMRoot: ram}}}, r, func() uint64 { return uint64(time.Now().UnixNano()) })
			if err != nil {
				t.Fatal(err)
			}
			app, err := exec.LookPath("xclock")
			if err != nil {
				t.Fatal(err)
			}
			request, _ := json.Marshal(map[string]any{"schema": "metaviewer.opening_mode/v0.3", "profile_id": "hx-live", "mode": role, "host_binary": app, "host_xpra": true})
			if err = os.WriteFile(filepath.Join(state, "opening-modes", "hx-live.json"), request, 0600); err != nil {
				t.Fatal(err)
			}
			events, err := m.Handle(context.Background(), Request{Schema: "surface_request/v0.2", Op: "create", Params: json.RawMessage(`{"kind":"desktop_capsule","profile_id":"hx-live","geometry":{"w":1280,"h":900}}`)})
			if err != nil {
				t.Fatal(err)
			}
			var ev struct {
				Data struct {
					Surface Surface `json:"surface"`
				} `json:"data"`
			}
			if err = json.Unmarshal(events[0], &ev); err != nil {
				t.Fatal(err)
			}
			id := ev.Data.Surface.SurfaceID
			b, err := m.SubscriptionBinding(id)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if b.HostXpra != nil {
					_ = b.HostXpra.stop()
				}
			}()
			if b.NativeKind != "host-xpra" || b.Role != role || b.Surface.Control != role {
				t.Fatalf("wrong binding: %+v", b)
			}
			raw, err := os.ReadFile(filepath.Join(state, "human-bindings", id+".json"))
			if err != nil {
				t.Fatal(err)
			}
			var binding map[string]any
			if err = json.Unmarshal(raw, &binding); err != nil || binding["host_xpra"] != true {
				t.Fatalf("%s %v", raw, err)
			}
			t.Logf("manager role=%s kind=%s display=%s", role, b.NativeKind, b.HostDisplay)
			if role == "agent" {
				_, frame, e := m.Capture(context.Background(), id)
				if e != nil {
					t.Fatal(e)
				}
				t.Logf("agent frame=%dx%d", frame.Width, frame.Height)
				inputParams, _ := json.Marshal(map[string]any{"surface_id": id, "proposal_id": "private-key", "action": map[string]any{"type": "key", "keys": []string{"Return"}}})
				if _, e = m.Handle(context.Background(), Request{Schema: "surface_request/v0.2", Op: "input", Params: inputParams}); e != nil {
					t.Fatal("adapter input", e)
				}
				t.Log("adapter private-display input receipt verified")
			}
			params, _ := json.Marshal(map[string]string{"surface_id": id})
			_, err = m.Handle(context.Background(), Request{Schema: "surface_request/v0.2", Op: "destroy", Params: params})
			if err != nil {
				t.Fatal(err)
			}
			b.HostXpra = nil
		})
	}
}
