package capsule

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/ipc"
)

type noopAuthority struct{}

func (noopAuthority) Authenticate(context.Context, ipc.PeerCredentials, ipc.Envelope) error {
	return nil
}
func (noopAuthority) Reserve(context.Context, ipc.SenderKey, uint64, string) error { return nil }
func (noopAuthority) Wrap(_ context.Context, e ipc.Envelope, body json.RawMessage) (ipc.Envelope, error) {
	e.Body = body
	return e, nil
}

func testIPCPolicy(t *testing.T) *ipc.SchemaPolicy {
	t.Helper()
	cfg := ipc.Config{
		SocketPath:       filepath.Join(t.TempDir(), "core.sock"),
		UID:              uint32(os.Getuid()),
		MaxFrameBytes:    1 << 20,
		MaxDepth:         32,
		MaxStringBytes:   65536,
		MaxKeys:          256,
		MaxArrayItems:    4096,
		MaxReplayEntries: 100,
		MaxConnections:   1,
		HelloTimeout:     time.Second,
		ReadTimeout:      time.Second,
		WriteTimeout:     time.Second,
		ProbeTimeout:     time.Second,
		ShutdownTimeout:  time.Second,
	}
	policy, err := ipc.NewPolicy(cfg, os.DirFS(filepath.Join("..", "..", "..", "contracts", "v0.2")), noopAuthority{})
	if err != nil {
		t.Fatalf("NewPolicy: %v", err)
	}
	return policy
}

func wrapEnvelopeBytes(t *testing.T, bodyJSON string) []byte {
	t.Helper()
	raw := `{"schema":"envelope/v0.2","msg_id":"msg-1","ts_ns":1,"from":{"component":"core","instance":"core-1"},"to":{"component":"daemon","instance":"daemon-1"},"session_id":"sess-1","seq":1,"nonce":"0123456789abcdef0123456789abcdef","body":` + bodyJSON + `}`
	return []byte(raw)
}

const innerStartOK = `{"kind":"program","container":"srf-pg-inner-host-1","run_id":"run-inner-1","windows":[{"id":"w1","x":0,"y":0,"w":1280,"h":720,"title":"MetaViewer Inner","url":""}]}`

func testInnerProfile(ramRoot string) Profile {
	return Profile{
		Kind:        "desktop_capsule",
		NativeKind:  "program",
		Program:     "metaviewer-nested",
		Width:       1280,
		Height:      720,
		Display:     ":100",
		RAMRoot:     ramRoot,
		NestedDepth: 1,
	}
}

func TestProgramInnerTable(t *testing.T) {
	t.Run("admitted_create_and_first_frame", func(t *testing.T) {
		r := &scriptRunner{output: []byte(innerStartOK)}
		m, err := NewManager(Config{
			BinDir:         t.TempDir(),
			MaxSurfaces:    4,
			MaxOutputBytes: 4096,
			Timeout:        time.Second,
			OriginNS:       100,
			Profiles: map[string]Profile{
				"inner-host-1": testInnerProfile("/dev/shm"),
			},
		}, r, func() uint64 { return 200 })
		if err != nil {
			t.Fatalf("NewManager: %v", err)
		}

		policy := testIPCPolicy(t)
		for _, badBody := range []string{
			`{"schema":"surface_request/v0.2","op":"create","params":{"kind":"desktop_capsule","profile_id":"inner-host-1","geometry":{"w":1280,"h":720},"nested_depth":2}}`,
			`{"schema":"surface_request/v0.2","op":"create","params":{"kind":"desktop_capsule","profile_id":"inner-host-1","geometry":{"w":1280,"h":720},"nested_depth":-1}}`,
		} {
			if _, err := policy.ValidateEnvelope(wrapEnvelopeBytes(t, badBody)); err == nil {
				t.Fatalf("expected IPC policy to refuse invalid nested_depth body: %s", badBody)
			}
		}

		env1, err := policy.ValidateEnvelope(wrapEnvelopeBytes(t, `{"schema":"surface_request/v0.2","op":"create","params":{"kind":"desktop_capsule","profile_id":"inner-host-1","geometry":{"w":1280,"h":720},"nested_depth":1}}`))
		if err != nil {
			t.Fatalf("ValidateEnvelope depth 1 failed: %v", err)
		}
		var req1 Request
		if err := json.Unmarshal(env1.Body, &req1); err != nil {
			t.Fatalf("unmarshal req1: %v", err)
		}
		out, err := m.Handle(context.Background(), req1)
		if err != nil || len(out) != 1 {
			t.Fatalf("create failed: events=%v err=%v", out, err)
		}

		var created struct {
			Schema string `json:"schema"`
			Event  string `json:"event"`
			Data   struct {
				Surface Surface `json:"surface"`
			} `json:"data"`
		}
		if err := json.Unmarshal(out[0], &created); err != nil {
			t.Fatalf("unmarshal created: %v", err)
		}
		s := created.Data.Surface
		if created.Schema != "surface_event/v0.2" || created.Event != "created" || s.Kind != "desktop_capsule" || s.State != "active" || s.ProfileID != "inner-host-1" || s.Geometry != (Geometry{W: 1280, H: 720}) {
			t.Fatalf("unexpected created surface: %+v", created)
		}
		if len(m.bindings) != 1 || m.bindings[s.SurfaceID].Container != "srf-pg-inner-host-1" {
			t.Fatalf("expected 1 owned container binding, got: %+v", m.bindings)
		}
		wantStart := []string{
			filepath.Join(m.cfg.BinDir, "srf-identity-surface"),
			"start", "--kind", "program", "--identity", "inner-host-1", "--windows", "1", "--program", "metaviewer-nested",
		}
		if len(r.calls) != 1 || !reflect.DeepEqual(r.calls[0], wantStart) {
			t.Fatalf("unexpected start argv: %v", r.calls)
		}

		b := m.bindings[s.SurfaceID]
		frameReply := NativeFrame{
			Path:          b.FramesRoot + "/f000001.png",
			Seq:           1,
			SHA256RGB24:   strings.Repeat("a", 64),
			Width:         1280,
			Height:        720,
			CaptureMonoNS: 200,
			Generation:    b.Container,
			Window:        &Window{ID: "w1", W: 1280, H: 720, Title: "MetaViewer Inner"},
		}
		r.output, _ = json.Marshal(frameReply)
		gotBinding, gotFrame, err := m.Capture(context.Background(), s.SurfaceID)
		if err != nil {
			t.Fatalf("Capture: %v", err)
		}
		if gotBinding.Container != "srf-pg-inner-host-1" || gotFrame.Width != 1280 || gotFrame.Height != 720 || gotFrame.Seq != 1 || gotFrame.TSNS != 100 {
			t.Fatalf("unexpected first frame: binding=%+v frame=%+v", gotBinding, gotFrame)
		}

		r.output = []byte(`{"stopped":"srf-pg-inner-host-1","removed_verified":true}`)
		if _, err := m.Handle(context.Background(), req("destroy", `{"surface_id":"`+s.SurfaceID+`"}`)); err != nil {
			t.Fatalf("destroy: %v", err)
		}
	})

	t.Run("admitted_create_depth_0_programs", func(t *testing.T) {
		policy := testIPCPolicy(t)
		for _, prog := range []string{"notepad", "metaviewer-nested"} {
			r := &scriptRunner{output: []byte(`{"kind":"program","container":"srf-pg-depth0","run_id":"run-d0","windows":[{"id":"w1","x":0,"y":0,"w":1280,"h":720,"title":"Prog","url":""}]}`)}
			p := testInnerProfile("/dev/shm")
			p.Program = prog
			p.NestedDepth = 0
			m, err := NewManager(Config{
				BinDir:         t.TempDir(),
				MaxSurfaces:    4,
				MaxOutputBytes: 4096,
				Timeout:        time.Second,
				OriginNS:       100,
				Profiles:       map[string]Profile{"depth0-prof": p},
			}, r, func() uint64 { return 200 })
			if err != nil {
				t.Fatalf("NewManager(%s): %v", prog, err)
			}
			env0, err := policy.ValidateEnvelope(wrapEnvelopeBytes(t, `{"schema":"surface_request/v0.2","op":"create","params":{"kind":"desktop_capsule","profile_id":"depth0-prof","geometry":{"w":1280,"h":720},"nested_depth":0}}`))
			if err != nil {
				t.Fatalf("ValidateEnvelope(%s): %v", prog, err)
			}
			var req0 Request
			if err := json.Unmarshal(env0.Body, &req0); err != nil {
				t.Fatalf("unmarshal req0: %v", err)
			}
			out, err := m.Handle(context.Background(), req0)
			if err != nil || len(out) != 1 {
				t.Fatalf("Handle(%s): events=%v err=%v", prog, out, err)
			}
		}
	})

	t.Run("negative_controls_create", func(t *testing.T) {
		cases := []struct {
			name    string
			mutate  func(*Profile)
			payload string
			code    string
		}{
			{
				name:    "nested_depth_2_refused_before_container",
				payload: `{"kind":"desktop_capsule","profile_id":"inner-host-1","geometry":{"w":1280,"h":720},"nested_depth":2}`,
				code:    "nested_depth",
			},
			{
				name:    "nested_depth_negative_refused_before_container",
				payload: `{"kind":"desktop_capsule","profile_id":"inner-host-1","geometry":{"w":1280,"h":720},"nested_depth":-1}`,
				code:    "nested_depth",
			},
			{
				name:    "nested_depth_mismatch_zero_on_depth1_profile",
				payload: `{"kind":"desktop_capsule","profile_id":"inner-host-1","geometry":{"w":1280,"h":720},"nested_depth":0}`,
				code:    "nested_depth",
			},
			{
				name: "nested_depth_mismatch_one_on_depth0_profile",
				mutate: func(p *Profile) {
					p.NestedDepth = 0
					p.Program = "notepad"
				},
				payload: `{"kind":"desktop_capsule","profile_id":"inner-host-1","geometry":{"w":1280,"h":720},"nested_depth":1}`,
				code:    "nested_depth",
			},
			{
				name: "unknown_program_refused_before_container",
				mutate: func(p *Profile) {
					p.Program = "unknown-inner"
				},
				payload: `{"kind":"desktop_capsule","profile_id":"inner-host-1","geometry":{"w":1280,"h":720},"nested_depth":1}`,
				code:    "profile",
			},
			{
				name: "notepad_at_nested_depth_1_refused",
				mutate: func(p *Profile) {
					p.Program = "notepad"
				},
				payload: `{"kind":"desktop_capsule","profile_id":"inner-host-1","geometry":{"w":1280,"h":720},"nested_depth":1}`,
				code:    "profile",
			},
			{
				name:    "nested_depth_omitted_on_depth1_profile_refused",
				payload: `{"kind":"desktop_capsule","profile_id":"inner-host-1","geometry":{"w":1280,"h":720}}`,
				code:    "nested_depth",
			},
			{
				name: "browser_kind_with_nested_depth_0_refused",
				mutate: func(p *Profile) {
					p.Kind = "browser"
					p.NativeKind = "browser"
					p.Program = ""
					p.NestedDepth = 0
				},
				payload: `{"kind":"browser","profile_id":"inner-host-1","geometry":{"w":1280,"h":720},"nested_depth":0}`,
				code:    "nested_depth",
			},
			{
				name: "browser_kind_with_nested_depth_1_refused",
				mutate: func(p *Profile) {
					p.Kind = "browser"
					p.NativeKind = "browser"
					p.Program = ""
					p.NestedDepth = 0
				},
				payload: `{"kind":"browser","profile_id":"inner-host-1","geometry":{"w":1280,"h":720},"nested_depth":1}`,
				code:    "nested_depth",
			},
			{
				name: "vm_kind_with_nested_depth_0_refused",
				mutate: func(p *Profile) {
					p.Kind = "vm"
					p.NativeKind = "vm"
					p.Program = "notepad-vm"
					p.NestedDepth = 0
				},
				payload: `{"kind":"vm","profile_id":"inner-host-1","geometry":{"w":1280,"h":720},"nested_depth":0}`,
				code:    "nested_depth",
			},
			{
				name: "game_capsule_kind_with_nested_depth_0_refused",
				mutate: func(p *Profile) {
					p.Kind = "game_capsule"
					p.NativeKind = "holdings"
					p.Program = ""
					p.AppDir = "/tmp"
					p.NestedDepth = 0
				},
				payload: `{"kind":"game_capsule","profile_id":"inner-host-1","geometry":{"w":1280,"h":720},"nested_depth":0}`,
				code:    "nested_depth",
			},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				r := &scriptRunner{output: []byte(innerStartOK)}
				m, err := NewManager(Config{
					BinDir:         t.TempDir(),
					MaxSurfaces:    4,
					MaxOutputBytes: 4096,
					Timeout:        time.Second,
					OriginNS:       100,
					Profiles: map[string]Profile{
						"inner-host-1": testInnerProfile("/dev/shm"),
					},
				}, r, func() uint64 { return 200 })
				if err != nil {
					t.Fatalf("NewManager: %v", err)
				}
				if tc.mutate != nil {
					p := m.cfg.Profiles["inner-host-1"]
					tc.mutate(&p)
					m.cfg.Profiles["inner-host-1"] = p
				}
				events, err := m.Handle(context.Background(), req("create", tc.payload))
				requireFault(t, err, tc.code)
				if len(events) != 0 {
					t.Fatalf("unexpected events on refusal: %s", events)
				}
				if len(r.calls) != 0 {
					t.Fatalf("refused create invoked native CLI: %v", r.calls)
				}
				if len(m.bindings) != 0 || len(m.quarantined) != 0 {
					t.Fatalf("refused create mutated bindings=%v or quarantined=%v", m.bindings, m.quarantined)
				}
			})
		}
	})

	t.Run("negative_controls_new_manager", func(t *testing.T) {
		badProfiles := []struct {
			name   string
			mutate func(*Profile)
		}{
			{
				name:   "unknown_program",
				mutate: func(p *Profile) { p.Program = "unknown-program" },
			},
			{
				name:   "notepad_with_nested_depth_1",
				mutate: func(p *Profile) { p.Program = "notepad" },
			},
			{
				name:   "nested_depth_2",
				mutate: func(p *Profile) { p.NestedDepth = 2 },
			},
			{
				name:   "nested_depth_negative",
				mutate: func(p *Profile) { p.NestedDepth = -1 },
			},
			{
				name:   "nested_depth_1_wrong_geometry",
				mutate: func(p *Profile) { p.Width = 800; p.Height = 600 },
			},
			{
				name: "browser_with_nested_depth_1",
				mutate: func(p *Profile) {
					p.Kind = "browser"
					p.NativeKind = "browser"
					p.Program = ""
					p.NestedDepth = 1
				},
			},
		}
		for _, tc := range badProfiles {
			t.Run(tc.name, func(t *testing.T) {
				p := testInnerProfile("/dev/shm")
				tc.mutate(&p)
				_, err := NewManager(Config{
					BinDir:         t.TempDir(),
					MaxSurfaces:    4,
					MaxOutputBytes: 4096,
					Timeout:        time.Second,
					OriginNS:       100,
					Profiles:       map[string]Profile{"inner-host-1": p},
				}, &scriptRunner{}, func() uint64 { return 200 })
				requireFault(t, err, "configuration")
			})
		}
	})
}

func TestProgramInnerLive(t *testing.T) {
	if os.Getenv("MV_E2E_LIVE") == "1" {
		runProgramInnerLiveMode(t)
		return
	}
	runProgramInnerFixtureMode(t)
}

func runProgramInnerLiveMode(t *testing.T) {
	profileID := os.Getenv("MV_SRF_NESTED_LIVE_PROFILE")
	binDir := os.Getenv("MV_SRF_BIN_DIR")
	stateDir := os.Getenv("MV_SRF_STATE_DIR")
	if profileID == "" || profileID == "mv-live-1" || !filepath.IsAbs(binDir) || !filepath.IsAbs(stateDir) {
		t.Fatalf("MV_E2E_LIVE=1 requires explicit non-mv-live-1 MV_SRF_NESTED_LIVE_PROFILE, MV_SRF_BIN_DIR, and MV_SRF_STATE_DIR")
	}
	ramRoot, err := os.MkdirTemp("/dev/shm", "mv-inner-live-")
	if err != nil {
		t.Fatalf("MkdirTemp /dev/shm: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(ramRoot) })

	var tick uint64 = 100
	m, err := NewRuntime(Config{
		BinDir:         binDir,
		MaxSurfaces:    2,
		MaxOutputBytes: 65536,
		Timeout:        15 * time.Second,
		OriginNS:       100,
		Profiles: map[string]Profile{
			profileID: testInnerProfile(ramRoot),
		},
	}, func() uint64 { return atomic.AddUint64(&tick, 100) })
	if err != nil {
		t.Fatalf("NewRuntime: %v", err)
	}
	_, err = m.Handle(context.Background(), req(
		"create",
		`{"kind":"desktop_capsule","profile_id":"`+profileID+`","geometry":{"w":1280,"h":720},"nested_depth":2}`,
	))
	requireFault(t, err, "nested_depth")
}

func runProgramInnerFixtureMode(t *testing.T) {
	if _, err := exec.LookPath("xvfb-run"); err != nil {
		t.Fatalf("xvfb-run required for fixture Xvfb verification: %v", err)
	}
	if _, err := exec.LookPath("python3"); err != nil {
		t.Fatalf("python3 required for e2e1_slice/live.py verification: %v", err)
	}

	repoRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("repoRoot: %v", err)
	}
	sliceDir := filepath.Join(repoRoot, "tests", "e2e", "e2e1_slice")

	scratch := t.TempDir()
	binDir := filepath.Join(scratch, "bin")
	stateDir := filepath.Join(scratch, "state")
	witnessFile := filepath.Join(stateDir, "inner-entry-witness.json")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		t.Fatalf("mkdir bin: %v", err)
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatalf("mkdir state: %v", err)
	}
	if err := os.Chmod(stateDir, 0o700); err != nil {
		t.Fatalf("chmod state: %v", err)
	}

	ramRoot, err := os.MkdirTemp("/dev/shm", "mv-u-router-1-")
	if err != nil {
		t.Fatalf("MkdirTemp /dev/shm: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(ramRoot) })

	stubInnerPath := filepath.Join(binDir, "metaviewer-nested-stub")
	stubInnerScript := `#!/usr/bin/env python3
import json
import os
import sys

payload = {
    "argv": sys.argv[1:],
    "display": os.environ.get("DISPLAY", ""),
    "env": {
        "MV_NESTED_DEPTH": os.environ.get("MV_NESTED_DEPTH", ""),
        "MV_PROFILE_ID": os.environ.get("MV_PROFILE_ID", ""),
        "MV_PROGRAM": os.environ.get("MV_PROGRAM", ""),
    },
}
with open(os.environ["MV_INNER_WITNESS_FILE"], "w", encoding="utf-8") as handle:
    json.dump(payload, handle, sort_keys=True)
`
	if err := os.WriteFile(stubInnerPath, []byte(stubInnerScript), 0o700); err != nil {
		t.Fatalf("write stub inner entry: %v", err)
	}

	fakeConfigPath := filepath.Join(stateDir, "fixture-config.json")
	fakeCfgBytes, err := json.Marshal(struct {
		RAMRoot     string `json:"ram_root"`
		StubInner   string `json:"stub_inner"`
		WitnessFile string `json:"witness_file"`
	}{
		RAMRoot:     ramRoot,
		StubInner:   stubInnerPath,
		WitnessFile: witnessFile,
	})
	if err != nil {
		t.Fatalf("marshal fixture config: %v", err)
	}
	if err := os.WriteFile(fakeConfigPath, fakeCfgBytes, 0o600); err != nil {
		t.Fatalf("write fixture config: %v", err)
	}

	fakeSurfacePath := filepath.Join(binDir, "srf-identity-surface")
	fakeSurfaceScript := `#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import zlib

args = sys.argv[1:]
if not args:
    sys.exit(2)


def flag(name, default=""):
    if name in args:
        idx = args.index(name)
        if idx + 1 < len(args):
            return args[idx + 1]
    return default


op = args[0]
state_dir = Path(flag("--state-dir"))
cfg = json.loads((state_dir / "fixture-config.json").read_text(encoding="utf-8"))
ram_root = Path(cfg["ram_root"])
stub_inner = cfg["stub_inner"]
witness_file = cfg["witness_file"]


def write_png(path, width, height):
    raw = bytearray()
    row = b"\x00" + (b"\x12\x34\x56" * width)
    for _ in range(height):
        raw.extend(row)

    def chunk(tag, data):
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return len(data).to_bytes(4, "big") + tag + data + crc.to_bytes(4, "big")

    ihdr = (
        width.to_bytes(4, "big")
        + height.to_bytes(4, "big")
        + b"\x08\x02\x00\x00\x00"
    )
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw)))
        + chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)
    rgb = b"\x12\x34\x56" * (width * height)
    return hashlib.sha256(rgb).hexdigest()


if op == "start":
    kind = flag("--kind")
    identity = flag("--identity")
    program = flag("--program")
    if kind != "program" or program != "metaviewer-nested":
        sys.stderr.write("unadmitted start arguments\n")
        sys.exit(1)
    container = f"srf-pg-{identity}"
    run_id = f"run-{identity}"
    child_env = dict(
        os.environ,
        MV_NESTED_DEPTH="1",
        MV_PROFILE_ID=identity,
        MV_PROGRAM=program,
        MV_INNER_WITNESS_FILE=witness_file,
    )
    subprocess.run(
        [
            "xvfb-run",
            "-a",
            stub_inner,
            "--nested-depth=1",
            f"--profile-id={identity}",
        ],
        check=True,
        env=child_env,
        timeout=10,
    )
    receipt = {
        "Lease": {"ProfileID": identity},
        "Capsule": {
            "container": container,
            "run_id": run_id,
            "kind": "program",
            "program": program,
        },
    }
    (state_dir / f"{container}.json").write_text(
        json.dumps(receipt, separators=(",", ":")),
        encoding="utf-8",
    )
    frame_path = ram_root / run_id / "frames" / "w1" / "f000001.png"
    digest_hex = write_png(frame_path, 1280, 720)
    (state_dir / f"{container}.frame.txt").write_text(
        f"{frame_path}\n{digest_hex}\n",
        encoding="utf-8",
    )
    out = {
        "kind": "program",
        "container": container,
        "run_id": run_id,
        "windows": [
            {
                "id": "w1",
                "x": 0,
                "y": 0,
                "w": 1280,
                "h": 720,
                "title": "MetaViewer Inner",
                "url": "",
            }
        ],
    }
    sys.stdout.write(json.dumps(out, separators=(",", ":")) + "\n")
elif op == "frame":
    container = flag("--container")
    window = flag("--window", "w1")
    lines = (state_dir / f"{container}.frame.txt").read_text(encoding="utf-8").splitlines()
    out = {
        "path": lines[0],
        "seq": 1,
        "sha256_rgb24": lines[1],
        "width": 1280,
        "height": 720,
        "capture_mono_ns": 250,
        "generation": container,
        "window": {
            "id": window,
            "x": 0,
            "y": 0,
            "w": 1280,
            "h": 720,
            "title": "MetaViewer Inner",
            "url": "",
        },
    }
    sys.stdout.write(json.dumps(out, separators=(",", ":")) + "\n")
elif op == "stop":
    container = flag("--container")
    for suffix in (".json", ".frame.txt"):
        target = state_dir / f"{container}{suffix}"
        if target.exists():
            target.unlink()
    sys.stdout.write(
        json.dumps(
            {"stopped": container, "removed_verified": True},
            separators=(",", ":"),
        )
        + "\n"
    )
else:
    sys.exit(2)
`
	if err := os.WriteFile(fakeSurfacePath, []byte(fakeSurfaceScript), 0o700); err != nil {
		t.Fatalf("write fake srf-identity-surface: %v", err)
	}

	t.Setenv("MV_SRF_BIN_DIR", binDir)
	t.Setenv("MV_SRF_STATE_DIR", stateDir)

	pyCmd := exec.Command(
		"python3",
		"-c",
		`import json, sys
sys.path.insert(0, sys.argv[1])
import live

prof = live.inner_host_profile(sys.argv[2], display=":100", program="metaviewer-nested", nested_depth=1)
req = live.inner_host_create_request("inner-host-1", nested_depth=1)
env = live.make_envelope(
    msg_id="inner-create-1",
    from_component="core",
    from_instance="core-1",
    to_component="daemon",
    to_instance="daemon-1",
    session_id="sess-inner-1",
    seq=1,
    ts_ns=1,
    body=req,
)
for bad in (
    lambda: live.inner_host_create_params("mv-live-1", nested_depth=1),
    lambda: live.inner_host_create_params("inner-host-1", nested_depth=2),
    lambda: live.inner_host_create_params("inner-host-1", nested_depth=-1),
    lambda: live.inner_host_profile(sys.argv[2], program="unknown-prog", nested_depth=1),
    lambda: live.inner_host_profile(sys.argv[2], program="notepad", nested_depth=1),
):
    try:
        bad()
    except ValueError:
        pass
    else:
        raise SystemExit("expected ValueError from negative control")
print(json.dumps({"profile": prof, "request": req, "envelope": env}, separators=(",", ":")))
`,
		sliceDir,
		ramRoot,
	)
	pyOut, err := pyCmd.CombinedOutput()
	if err != nil {
		t.Fatalf("live.py inner_host helper check failed: %v (%s)", err, pyOut)
	}
	var helperBundle struct {
		Profile struct {
			Kind        string `json:"kind"`
			NativeKind  string `json:"native_kind"`
			Program     string `json:"program"`
			Width       int    `json:"width"`
			Height      int    `json:"height"`
			Display     string `json:"display"`
			RAMRoot     string `json:"ram_root"`
			NestedDepth int    `json:"nested_depth"`
		} `json:"profile"`
		Request  Request         `json:"request"`
		Envelope json.RawMessage `json:"envelope"`
	}
	if err := json.Unmarshal(pyOut, &helperBundle); err != nil {
		t.Fatalf("unmarshal helperBundle: %v", err)
	}
	validatedEnv, err := testIPCPolicy(t).ValidateEnvelope(helperBundle.Envelope)
	if err != nil {
		t.Fatalf("ValidateEnvelope on helperBundle.Envelope: %v", err)
	}
	if err := json.Unmarshal(validatedEnv.Body, &helperBundle.Request); err != nil {
		t.Fatalf("unmarshal validatedEnv.Body: %v", err)
	}

	var tick uint64 = 100
	m, err := NewRuntime(Config{
		BinDir:         binDir,
		MaxSurfaces:    4,
		MaxOutputBytes: 65536,
		Timeout:        15 * time.Second,
		OriginNS:       100,
		Profiles: map[string]Profile{
			"inner-host-1": {
				Kind:        helperBundle.Profile.Kind,
				NativeKind:  helperBundle.Profile.NativeKind,
				Program:     helperBundle.Profile.Program,
				Width:       helperBundle.Profile.Width,
				Height:      helperBundle.Profile.Height,
				Display:     helperBundle.Profile.Display,
				RAMRoot:     helperBundle.Profile.RAMRoot,
				NestedDepth: helperBundle.Profile.NestedDepth,
			},
		},
	}, func() uint64 { return atomic.AddUint64(&tick, 100) })
	if err != nil {
		t.Fatalf("NewRuntime: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Negative control 1: nested_depth:2 refuses with a typed fault before any container exists.
	_, err = m.Handle(ctx, req(
		"create",
		`{"kind":"desktop_capsule","profile_id":"inner-host-1","geometry":{"w":1280,"h":720},"nested_depth":2}`,
	))
	requireFault(t, err, "nested_depth")
	if _, statErr := os.Stat(witnessFile); !os.IsNotExist(statErr) {
		t.Fatalf("nested_depth:2 invoked inner entry stub: %v", statErr)
	}

	// Negative control 2: unknown Program refuses with a typed fault, creating no surface/container.
	savedProfile := m.cfg.Profiles["inner-host-1"]
	badProfile := savedProfile
	badProfile.Program = "unknown-inner"
	m.cfg.Profiles["inner-host-1"] = badProfile
	_, err = m.Handle(ctx, helperBundle.Request)
	requireFault(t, err, "profile")
	if _, statErr := os.Stat(witnessFile); !os.IsNotExist(statErr) {
		t.Fatalf("unknown Program invoked inner entry stub: %v", statErr)
	}
	if len(m.bindings) != 0 || len(m.quarantined) != 0 {
		t.Fatalf("unknown Program left bindings=%v or quarantined=%v", m.bindings, m.quarantined)
	}
	m.cfg.Profiles["inner-host-1"] = savedProfile

	// Positive step (2) & (3): send surface_request/v0.2 op=create {kind:desktop_capsule, profile_id, geometry 1280x720, nested_depth:1}.
	events, err := m.Handle(ctx, helperBundle.Request)
	if err != nil || len(events) != 1 {
		t.Fatalf("Handle create: events=%s err=%v", events, err)
	}
	var created struct {
		Schema string `json:"schema"`
		Event  string `json:"event"`
		Data   struct {
			Surface Surface `json:"surface"`
		} `json:"data"`
	}
	if err := json.Unmarshal(events[0], &created); err != nil {
		t.Fatalf("unmarshal created: %v", err)
	}
	surfaceID := created.Data.Surface.SurfaceID
	if created.Event != "created" || created.Data.Surface.Kind != "desktop_capsule" || created.Data.Surface.Geometry != (Geometry{W: 1280, H: 720}) || created.Data.Surface.State != "active" {
		t.Fatalf("unexpected created event: %+v", created)
	}

	// Verify 1 owned container via live.py profile_program_containers and stub inner witness.
	containersOut, err := exec.Command(
		"python3",
		"-c",
		`import json, sys
sys.path.insert(0, sys.argv[1])
import live
print(json.dumps(sorted(live.profile_program_containers("inner-host-1"))))
`,
		sliceDir,
	).CombinedOutput()
	if err != nil {
		t.Fatalf("profile_program_containers failed: %v (%s)", err, containersOut)
	}
	var ownedContainers []string
	if err := json.Unmarshal(containersOut, &ownedContainers); err != nil {
		t.Fatalf("unmarshal ownedContainers: %v", err)
	}
	if !reflect.DeepEqual(ownedContainers, []string{"srf-pg-inner-host-1"}) {
		t.Fatalf("expected 1 owned container [srf-pg-inner-host-1], got %v", ownedContainers)
	}

	witnessBytes, err := os.ReadFile(witnessFile)
	if err != nil {
		t.Fatalf("read inner witness: %v", err)
	}
	var witness struct {
		Argv    []string          `json:"argv"`
		Display string            `json:"display"`
		Env     map[string]string `json:"env"`
	}
	if err := json.Unmarshal(witnessBytes, &witness); err != nil {
		t.Fatalf("unmarshal inner witness: %v", err)
	}
	if !reflect.DeepEqual(witness.Argv, []string{"--nested-depth=1", "--profile-id=inner-host-1"}) {
		t.Fatalf("unexpected stub inner argv: %v", witness.Argv)
	}
	if !displayID.MatchString(witness.Display) {
		t.Fatalf("expected Xvfb display (:N) in stub inner witness, got %q", witness.Display)
	}
	if witness.Env["MV_NESTED_DEPTH"] != "1" || witness.Env["MV_PROFILE_ID"] != "inner-host-1" || witness.Env["MV_PROGRAM"] != "metaviewer-nested" {
		t.Fatalf("unexpected stub inner env: %+v", witness.Env)
	}

	// Verify first frame_ready capture from the real adapter.
	binding, frame, err := m.Capture(ctx, surfaceID)
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	if binding.Container != "srf-pg-inner-host-1" || frame.Width != 1280 || frame.Height != 720 || frame.Seq != 1 || frame.Generation != "srf-pg-inner-host-1" {
		t.Fatalf("unexpected first frame: binding=%+v frame=%+v", binding, frame)
	}
	frameReadyEvent := event("v0.2", "frame_ready", struct {
		SurfaceID string `json:"surface_id"`
		FrameRef  struct {
			Generation string `json:"generation"`
			Seq        uint64 `json:"seq"`
			SHA256     string `json:"sha256"`
			RAMWSPath  string `json:"ramws_path"`
			Width      int    `json:"width"`
			Height     int    `json:"height"`
		} `json:"frame_ref"`
	}{
		SurfaceID: surfaceID,
		FrameRef: struct {
			Generation string `json:"generation"`
			Seq        uint64 `json:"seq"`
			SHA256     string `json:"sha256"`
			RAMWSPath  string `json:"ramws_path"`
			Width      int    `json:"width"`
			Height     int    `json:"height"`
		}{
			Generation: frame.Generation,
			Seq:        frame.Seq,
			SHA256:     frame.SHA256RGB24,
			RAMWSPath:  frame.Path,
			Width:      frame.Width,
			Height:     frame.Height,
		},
	})
	if !strings.Contains(string(frameReadyEvent), `"event":"frame_ready"`) {
		t.Fatalf("missing frame_ready event: %s", frameReadyEvent)
	}

	// Clean teardown.
	destroyEvents, err := m.Handle(ctx, req("destroy", `{"surface_id":"`+surfaceID+`"}`))
	if err != nil || len(destroyEvents) != 1 {
		t.Fatalf("destroy: events=%s err=%v", destroyEvents, err)
	}
}
