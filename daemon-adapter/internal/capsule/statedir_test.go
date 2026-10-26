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

func stateRunner(t *testing.T, state string, extra ...string) (*ProcessRunner, string) {
	t.Helper()
	bin, err := filepath.Abs("testdata")
	if err != nil {
		t.Fatal(err)
	}
	env := append([]string{"PATH=/usr/bin:/bin", "MV_SRF_STATE_DIR=" + state}, extra...)
	r, err := NewProcessRunner(bin, env, 8192, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	return r, filepath.Join(bin, "srf-identity-surface")
}

func TestIdentityStateDirEveryVerb(t *testing.T) {
	state := filepath.Join(t.TempDir(), "state with spaces")
	logRoot := t.TempDir()
	r, binary := stateRunner(t, state, "SRF_IDENTITY_STORE_ROOT="+logRoot, "SRF_PROXY_REGISTRY=registry-test")
	verbs := []string{"start", "frame", "input", "stop", "capabilities", "observe"}
	for _, verb := range verbs {
		if _, err := r.Run(context.Background(), []string{binary, verb}, nil); err != nil {
			t.Fatalf("%s: %v", verb, err)
		}
	}
	st, err := os.Stat(state)
	if err != nil || st.Mode() != os.ModeDir|0700 {
		t.Fatalf("creation mode: %v %v", st, err)
	}
	data, err := os.ReadFile(filepath.Join(logRoot, "cli-calls.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	for _, verb := range verbs {
		var call struct {
			Argv []string          `json:"argv"`
			Env  map[string]string `json:"env"`
		}
		if err = dec.Decode(&call); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(call.Argv, []string{verb, "--state-dir", state}) {
			t.Fatalf("argv: %v", call.Argv)
		}
		if !reflect.DeepEqual(call.Env, map[string]string{"SRF_IDENTITY_STORE_ROOT": logRoot, "SRF_PROXY_REGISTRY": "registry-test"}) {
			t.Fatalf("environment: %v", call.Env)
		}
	}
	// Validation runs again, including after an earlier successful invocation.
	if err = os.Chmod(state, 0755); err != nil {
		t.Fatal(err)
	}
	if _, err = r.Run(context.Background(), []string{binary, "stop"}, nil); err == nil {
		t.Fatal("changed directory permissions accepted")
	}
	after, err := os.ReadFile(filepath.Join(logRoot, "cli-calls.jsonl"))
	if err != nil || string(after) != string(data) {
		t.Fatal("refused verb reached CLI")
	}
}

type foreignOwnerInfo struct{ os.FileInfo }

func (f foreignOwnerInfo) Sys() any { return &syscall.Stat_t{Uid: uint32(os.Getuid()) ^ 1} }

func TestStateDirRefusalsAreTypedWithoutInvocation(t *testing.T) {
	for _, mode := range []string{"unset", "wide", "foreign", "missing-parent", "file", "symlink", "override"} {
		t.Run(mode, func(t *testing.T) {
			state, logs := t.TempDir(), t.TempDir()
			if err := os.Chmod(state, 0700); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "unset":
				state = ""
			case "wide":
				if err := os.Chmod(state, 0755); err != nil {
					t.Fatal(err)
				}
			case "missing-parent":
				state = filepath.Join(state, "absent", "state")
			case "file":
				state = filepath.Join(state, "file")
				if err := os.WriteFile(state, nil, 0700); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				link := filepath.Join(t.TempDir(), "link")
				if err := os.Symlink(state, link); err != nil {
					t.Fatal(err)
				}
				state = link
			}
			r, binary := stateRunner(t, state, "SRF_IDENTITY_STORE_ROOT="+logs)
			if mode == "foreign" {
				r.stat = func(path string) (os.FileInfo, error) {
					st, err := os.Lstat(path)
					if err != nil {
						return nil, err
					}
					return foreignOwnerInfo{st}, nil
				}
			}
			if mode == "unset" { // Exercise actual absence as well as the empty-value policy.
				var err error
				r, err = NewProcessRunner(filepath.Dir(binary), []string{"PATH=/usr/bin:/bin", "SRF_IDENTITY_STORE_ROOT=" + logs}, 8192, time.Second)
				if err != nil {
					t.Fatal(err)
				}
			}
			// Use the real lifecycle's surface-event conversion, not just the fault helper.
			m := testManager(t, &scriptRunner{})
			m.cfg.BinDir = filepath.Dir(binary)
			m.runner = r
			if mode == "override" {
				_, err := r.Run(context.Background(), []string{binary, "start", "--state-dir", state}, nil)
				var f *cli.Fault
				if !errors.As(err, &f) || f.Code != "configuration" {
					t.Fatalf("override: %v", err)
				}
			} else {
				out, err := m.HandleFor(context.Background(), "reserved-id", req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`))
				if err != nil || len(out) != 1 {
					t.Fatalf("missing typed event: %v", err)
				}
				var ev ErrorEvent
				if err = json.Unmarshal(out[0], &ev); err != nil {
					t.Fatal(err)
				}
				if ev.Event != "error" || ev.Data.Code != "configuration" || ev.Data.SurfaceID != "reserved-id" {
					t.Fatalf("event: %s", out[0])
				}
			}
			if _, err := os.Stat(filepath.Join(logs, "cli-calls.jsonl")); !os.IsNotExist(err) {
				t.Fatalf("CLI invoked: %v", err)
			}
		})
	}
}

func TestIdentityEnvironmentAbsentAndHoldingsUnchanged(t *testing.T) {
	t.Setenv("SRF_IDENTITY_STORE_ROOT", "ambient-must-not-escape")
	t.Setenv("SRF_PROXY_REGISTRY", "ambient-must-not-escape")
	r, binary := stateRunner(t, filepath.Join(t.TempDir(), "state"))
	check := func(binary string, want []string) {
		t.Helper()
		out, err := r.Run(context.Background(), []string{binary, "probe"}, nil)
		if err != nil {
			t.Fatal(err)
		}
		var got struct {
			Argv []string          `json:"argv"`
			Env  map[string]string `json:"env"`
		}
		if err = json.Unmarshal(out, &got); err != nil {
			t.Fatal(err)
		}
		if len(got.Env) != 0 || !reflect.DeepEqual(got.Argv, want) {
			t.Fatalf("unexpected child config: %s", out)
		}
	}
	check(binary, []string{"probe", "--state-dir", r.stateDir})
	// Reuse the fixture under the admitted holdings binary name in a private directory.
	data, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	r.root = t.TempDir()
	holdings := filepath.Join(r.root, "srf-holdings-capsule")
	if err = os.WriteFile(holdings, data, 0700); err != nil {
		t.Fatal(err)
	}
	r.stateDir = ""
	check(holdings, []string{"probe"})
}

func TestRuntimeCapturesStateAndIdentityEnvironment(t *testing.T) {
	cfg := testManager(t, &scriptRunner{}).cfg
	bin, err := filepath.Abs("testdata")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("MV_SRF_BIN_DIR", bin)
	t.Setenv("MV_SRF_STATE_DIR", filepath.Join(t.TempDir(), "state"))
	t.Setenv("SRF_IDENTITY_STORE_ROOT", t.TempDir())
	t.Setenv("SRF_PROXY_REGISTRY", "registry-test")
	m, err := NewRuntime(cfg, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	out, err := m.runner.Run(context.Background(), []string{filepath.Join(bin, "srf-identity-surface"), "probe"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Argv []string          `json:"argv"`
		Env  map[string]string `json:"env"`
	}
	if err = json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.Argv, []string{"probe", "--state-dir", os.Getenv("MV_SRF_STATE_DIR")}) || !reflect.DeepEqual(got.Env, map[string]string{"SRF_IDENTITY_STORE_ROOT": os.Getenv("SRF_IDENTITY_STORE_ROOT"), "SRF_PROXY_REGISTRY": "registry-test"}) {
		t.Fatalf("runtime configuration lost: %s", out)
	}
}

func TestStateDirPathBypassesRefused(t *testing.T) {
	for _, mode := range []string{"relative", "dot", "dotdot", "double-slash", "symlink-slash", "symlink-dot", "ancestor-symlink", "ancestor-symlink-create"} {
		t.Run(mode, func(t *testing.T) {
			root, logs := t.TempDir(), t.TempDir()
			state := filepath.Join(root, "state")
			if err := os.Mkdir(state, 0700); err != nil {
				t.Fatal(err)
			}
			link := filepath.Join(root, "link")
			target := root
			if mode == "symlink-slash" || mode == "symlink-dot" {
				target = state
			}
			if err := os.Symlink(target, link); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "relative":
				cwd, err := os.Getwd()
				if err != nil {
					t.Fatal(err)
				}
				state, err = filepath.Rel(cwd, state)
				if err != nil {
					t.Fatal(err)
				}
			case "dot":
				state += "/."
			case "dotdot":
				state = root + "/state/../state"
			case "double-slash":
				state = root + "//state"
			case "symlink-slash":
				state = link + "/"
			case "symlink-dot":
				state = link + "/."
			case "ancestor-symlink":
				state = link + "/state"
			case "ancestor-symlink-create":
				state = link + "/new-state"
			}
			r, binary := stateRunner(t, state, "SRF_IDENTITY_STORE_ROOT="+logs)
			_, err := r.Run(context.Background(), []string{binary, "start"}, nil)
			var f *cli.Fault
			if !errors.As(err, &f) || f.Code != "configuration" {
				t.Errorf("path bypass accepted: %v", err)
			}
			if _, err := os.Stat(filepath.Join(logs, "cli-calls.jsonl")); !os.IsNotExist(err) {
				t.Error("refused path reached CLI")
			}
			if _, err := os.Stat(filepath.Join(root, "new-state")); !os.IsNotExist(err) {
				t.Error("created state through symlink ancestor")
			}
		})
	}
}

func TestStateDirArgumentBypassesRefused(t *testing.T) {
	for _, args := range [][]string{
		{"--state-dir=/evil"}, {"--state-dir", "/evil"},
		{"-state-dir=/evil"}, {"-state-dir", "/evil"},
		{"start", "--"}, {"start", "--", "--state-dir", "/evil"},
		{"--", "start"},
	} {
		t.Run(args[0]+"/"+strings.Join(args[1:], "_"), func(t *testing.T) {
			logs := t.TempDir()
			r, binary := stateRunner(t, filepath.Join(t.TempDir(), "state"), "SRF_IDENTITY_STORE_ROOT="+logs)
			argv := append([]string{binary}, args...)
			_, err := r.Run(context.Background(), argv, nil)
			var f *cli.Fault
			if !errors.As(err, &f) || f.Code != "configuration" {
				t.Errorf("argument bypass accepted: %v", err)
			}
			if _, err := os.Stat(filepath.Join(logs, "cli-calls.jsonl")); !os.IsNotExist(err) {
				t.Error("refused arguments reached CLI")
			}
		})
	}
}
