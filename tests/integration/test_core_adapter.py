#!/usr/bin/env python3
"""Integration: core <-> daemon-adapter contract surface (W1-T-INTEG).

Exercises the shared surface with the standard library only: the fake
capsule CLIs behave like the real ones (exits, one-line JSON, stream
split), CLI lines obey the adapter parse rule, surface messages validate
against the versioned contracts, and NDJSON envelopes cross owner-only
Unix sockets. Behavioural expectations cite the Go/Rust sources.
"""

import json
import os
import re
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

CMD_TIMEOUT = 15
FRAME_CAP = 1 << 20
SO_PEERCRED = getattr(socket, "SO_PEERCRED", 17)


def repo_root():
    override = os.environ.get("MV_TEST_REPO_ROOT")
    if override:
        return Path(override)
    here = Path(__file__).resolve()
    for base in here.parents:
        if (base / "tools" / "check_contracts.py").is_file() \
                and (base / "contracts").is_dir():
            return base
    return here.parents[2]


REPO = repo_root()
sys.path.insert(0, str(REPO))
from tools.check_contracts import ValidationError, Validator  # noqa: E402

try:
    from integration import fake_capsule
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import fake_capsule

FAKE = Path(fake_capsule.__file__).resolve()

IDENTITY_CAPSULE_RE = re.compile(r"^srf-(id|pg|vm)-[a-z0-9][a-z0-9-]{0,39}$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
REFUSALS = ("STALE_FRAME", "SURFACE_NOT_AGENT_CONTROLLED", "LOCKED_BY_OTHER",
            "BUDGET_EXCEEDED", "OUT_OF_BOUNDS", "POLICY")
# Adapter capsule allowlist (daemon-adapter/internal/capsule/capsule.go).
ADAPTER_OPS = ("create", "list", "destroy", "take_control",
               "release_control", "input", "frame_subscribe",
               "frame_unsubscribe")


class MalformedLine(ValueError):
    pass


def parse_line(raw, cap):
    """One bounded closed JSON object per line (adapter CLI rule)."""
    if not isinstance(raw, (bytes, bytearray)) or cap < 1 or len(raw) > cap:
        raise MalformedLine("over cap")
    line = bytes(raw)
    if line.endswith(b"\n"):
        line = line[:-1]
    if not line.strip() or b"\r" in line or b"\n" in line:
        raise MalformedLine("not one line")
    if line.strip()[:1] != b"{":
        raise MalformedLine("not an object")

    def pairs(entries):
        result = {}
        for key, value in entries:
            if key in result:
                raise MalformedLine("duplicate key " + key)
            result[key] = value
        return result

    try:
        value = json.loads(line.decode("utf-8"), object_pairs_hook=pairs)
    except (UnicodeDecodeError, ValueError) as exc:
        raise MalformedLine(str(exc)) from exc
    if not isinstance(value, dict):
        raise MalformedLine("not an object")
    return value


def run_fake(argv, stdin=None):
    return subprocess.run([sys.executable, str(FAKE), *argv], input=stdin,
                          capture_output=True, timeout=CMD_TIMEOUT)


def peer_admitted(peer_uid, expected_uid):
    return type(peer_uid) is int and type(expected_uid) is int \
        and peer_uid == expected_uid


def peer_uid(conn):
    raw = conn.getsockopt(socket.SOL_SOCKET, SO_PEERCRED,
                          struct.calcsize("3i"))
    _pid, uid, _gid = struct.unpack("3i", raw)
    return uid


def check_owner_dir(path):
    info = os.stat(path)
    if not stat.S_ISDIR(info.st_mode) \
            or stat.S_IMODE(info.st_mode) != 0o700 \
            or info.st_uid != os.getuid():
        raise ValueError("owner-only directory required")


def prepare_socket_path(path):
    # Owner-only directory plus a free path; the listener then binds the
    # socket itself with mode 0600. Mirrors the adapter socket rule.
    check_owner_dir(os.path.dirname(path))
    if os.path.lexists(path):
        raise ValueError("socket path is occupied")


def read_frame(reader, cap):
    raw = reader.readline(cap + 2)
    if not raw:
        raise MalformedLine("closed without a frame")
    if len(raw) > cap + 1 or not raw.endswith(b"\n"):
        raise MalformedLine("over cap or unterminated")
    return raw


class FakeIdentityTests(unittest.TestCase):
    def setUp(self):
        self.stores = ["--store-root", "store", "--registry", "reg"]

    def run_identity(self, *argv, stdin=None):
        return run_fake(["--family", "identity", *argv], stdin=stdin)

    def test_capabilities_contract(self):
        proc = self.run_identity("capabilities")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stderr, b"")
        lines = proc.stdout.decode().splitlines()
        self.assertEqual(lines[0], "srf-identity-surface capabilities v1")
        self.assertIn("--paste --type-stdin --scroll --drag downloads",
                      lines[1])
        self.assertEqual(len(lines), 2)

    def test_start_ok(self):
        proc = self.run_identity("start", "--identity", "wall",
                                 "--windows", "2", *self.stores)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stderr, b"")
        body = parse_line(proc.stdout, 65536)
        self.assertTrue(IDENTITY_CAPSULE_RE.fullmatch(body["container"]))
        self.assertEqual(body["kind"], "browser")
        self.assertTrue(body["run_id"].startswith("run-"))
        self.assertEqual([w["id"] for w in body["windows"]], ["w1", "w2"])
        self.assertEqual(body["windows"][0]["w"], 1280)

    def test_start_deterministic(self):
        argv = ["start", "--identity", "wall", *self.stores]
        first = parse_line(self.run_identity(*argv).stdout, 65536)
        second = parse_line(self.run_identity(*argv).stdout, 65536)
        self.assertEqual(first["run_id"], second["run_id"])
        self.assertEqual(first["container"], second["container"])

    def test_start_requires_identity(self):
        proc = self.run_identity("start", *self.stores)
        self.assertEqual(proc.returncode, 2)

    def test_start_rejects_windows(self):
        for count in ("0", "17"):
            with self.subTest(count=count):
                proc = self.run_identity("start", "--identity", "wall",
                                         "--windows", count, *self.stores)
                self.assertEqual(proc.returncode, 2)

    def test_start_requires_stores(self):
        proc = self.run_identity("start", "--identity", "wall")
        self.assertEqual(proc.returncode, 3)
        body = parse_line(proc.stdout, 65536)
        self.assertEqual(body["error"]["code"], 3)

    def test_start_program_needs_program(self):
        proc = self.run_identity("start", "--identity", "wall",
                                 "--kind", "program", *self.stores)
        self.assertEqual(proc.returncode, 2)

    def test_start_unknown_program(self):
        proc = self.run_identity("start", "--identity", "wall",
                                 "--kind", "program", "--program", "mousepad",
                                 *self.stores)
        self.assertEqual(proc.returncode, 4)

    def test_frame_ok(self):
        proc = self.run_identity("frame", "--container", "srf-id-wall",
                                 "--window", "w1", *self.stores)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        body = parse_line(proc.stdout, 65536)
        self.assertEqual(set(body),
                         {"path", "seq", "sha256_rgb24", "width", "height",
                          "capture_mono_ns", "generation", "window"})
        self.assertTrue(HEX64_RE.fullmatch(body["sha256_rgb24"]))
        self.assertIs(type(body["capture_mono_ns"]), int)
        self.assertGreater(body["capture_mono_ns"], 0)
        self.assertTrue(body["path"].endswith(".png"))
        self.assertIn("srf-id-wall", body["path"])

    def test_frame_requires_window(self):
        proc = self.run_identity("frame", "--container", "srf-id-wall",
                                 *self.stores)
        self.assertEqual(proc.returncode, 2)

    def test_frame_seq_exhausted(self):
        proc = self.run_identity("frame", "--container", "srf-id-wall",
                                 "--window", "w1", "--seq", "1000000",
                                 *self.stores)
        self.assertEqual(proc.returncode, 4)

    def test_ax_ok(self):
        proc = self.run_identity("ax", "--container", "srf-id-wall",
                                 "--window", "w1", *self.stores)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        body = parse_line(proc.stdout, 65536)
        self.assertEqual(set(body),
                         {"window", "frame_seq", "scroll", "elements",
                          "truncated", "skipped_frames"})
        element = body["elements"][0]
        self.assertLessEqual(len(element["name"]), 120)
        self.assertEqual(set(element),
                         {"id", "role", "name", "box", "region", "actionable",
                          "focused", "states", "container", "value_len"})

    def test_ax_program_refuses(self):
        proc = self.run_identity("ax", "--container", "srf-pg-wall",
                                 "--window", "w1", "--kind", "program",
                                 *self.stores)
        self.assertEqual(proc.returncode, 4)
        body = parse_line(proc.stdout, 65536)
        self.assertEqual(body["error"]["code"], 4)

    def test_input_click_ok(self):
        proc = self.run_identity("input", "--container", "srf-id-wall",
                                 "--window", "w1", "--click", "10,20",
                                 *self.stores)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        body = parse_line(proc.stdout, 65536)
        self.assertEqual(body["kind"], "click")
        self.assertEqual(body["surface_id"], "srf-id-wall/w1")
        self.assertIs(type(body["input_mono_ns"]), int)
        self.assertGreater(body["input_mono_ns"], 0)
        self.assertIs(body["focus_verified"], True)
        self.assertEqual(body["result"], {"applied": True})

    def test_input_single_action(self):
        proc = self.run_identity("input", "--container", "c", "--window",
                                 "w1", "--key", "Return", "--click", "1,2",
                                 *self.stores)
        self.assertEqual(proc.returncode, 2)

    def test_input_focus_mismatch(self):
        proc = self.run_identity("input", "--container", "c", "--window",
                                 "w1", "--click", "1,2", "--expect-focus",
                                 "w1", "--have-focus", "w2", *self.stores)
        self.assertEqual(proc.returncode, 6)

    def test_input_type_stdin(self):
        proc = self.run_identity("input", "--container", "c", "--window",
                                 "w1", "--type-stdin", *self.stores,
                                 stdin=b"hello\n")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        body = parse_line(proc.stdout, 65536)
        self.assertEqual(body["kind"], "text")
        big = self.run_identity("input", "--container", "c", "--window",
                                "w1", "--type-stdin", *self.stores,
                                stdin=b"x" * (fake_capsule.TYPE_STDIN_CAP + 2))
        self.assertEqual(big.returncode, 5)

    def test_stop_ok(self):
        proc = self.run_identity("stop", "--container", "srf-id-wall",
                                 *self.stores)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        body = parse_line(proc.stdout, 65536)
        self.assertEqual(body["stopped"], "srf-id-wall")
        self.assertIs(body["removed_verified"], True)

    def test_unknown_verb(self):
        proc = self.run_identity("frobnicate")
        self.assertEqual(proc.returncode, 2)

    def test_wrong_family_verb(self):
        proc = self.run_identity("observe", "--container", "c")
        self.assertEqual(proc.returncode, 2)

    def test_failure_envelope_on_stdout(self):
        proc = self.run_identity("ax", "--container", "srf-pg-wall",
                                 "--window", "w1", "--kind", "program",
                                 *self.stores)
        self.assertEqual(proc.returncode, 4)
        self.assertEqual(proc.stderr, b"")
        body = parse_line(proc.stdout, 65536)
        self.assertIn("error", body)
        self.assertIn("result", body)

    def test_fault_seam_exits(self):
        for code in (2, 3, 4, 5, 6, 7):
            with self.subTest(code=code):
                proc = run_fake(["--fault", str(code), "--family",
                                 "identity", "stop", "--container", "c"])
                self.assertEqual(proc.returncode, code, proc.stderr)
                body = parse_line(proc.stdout, 65536)
                self.assertEqual(body["error"]["code"], code)

    def test_never_exits_one(self):
        cases = [
            ["start", "--identity", "wall"],
            ["start", "--windows", "99", *self.stores],
            ["frame", "--container", "c", *self.stores],
            ["ax", "--container", "c", "--window", "w1", "--kind",
             "program", *self.stores],
            ["input", "--container", "c", *self.stores],
            ["frobnicate"],
        ]
        for argv in cases:
            with self.subTest(argv=argv):
                self.assertNotEqual(self.run_identity(*argv).returncode, 1)
        proc = run_fake(["--fault", "1", "--family", "identity", "stop",
                         "--container", "c"])
        self.assertEqual(proc.returncode, 2)


class FakeHoldingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = Path(self.temp.name) / "app"
        self.app.mkdir()

    def run_holdings(self, *argv):
        return run_fake(["--family", "holdings", *argv])

    def test_start_ok(self):
        proc = self.run_holdings("start", "--app", str(self.app),
                                 "--slots", "2")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stderr, b"")
        self.assertEqual(proc.stdout.count(b"\n"), 1)
        bodies = json.loads(proc.stdout.decode())
        self.assertEqual(len(bodies), 2)
        first = bodies[0]
        self.assertEqual(set(first),
                         {"slot", "container", "run_id", "display", "width",
                          "height", "lane_socket", "ready_line", "ready_ms",
                          "frames_dir"})
        self.assertTrue(first["container"].startswith("srf-ng-hcap-"))
        self.assertEqual(first["lane_socket"], "/workspace/holdings/agent.sock")
        self.assertEqual(first["ready_line"], "HOLDINGS_READY 4242 0")
        self.assertEqual((first["width"], first["height"]), (1280, 900))

    def test_start_requires_app(self):
        proc = self.run_holdings("start")
        self.assertEqual(proc.returncode, 2)

    def test_start_refuses_file_app(self):
        target = Path(self.temp.name) / "file"
        target.write_text("x")
        proc = self.run_holdings("start", "--app", str(target))
        self.assertEqual(proc.returncode, 4)

    def test_start_rejects_slots(self):
        proc = self.run_holdings("start", "--app", str(self.app),
                                 "--slots", "5")
        self.assertEqual(proc.returncode, 2)

    def test_frame_ok(self):
        proc = self.run_holdings("frame", "--container", "srf-ng-hcap-x-1",
                                 "--state", "ready")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        body = parse_line(proc.stdout, 65536)
        self.assertEqual(body["generation"], "srf-ng-hcap-x-1")
        self.assertEqual(body["state"], "ready")
        self.assertTrue(HEX64_RE.fullmatch(body["sha256_rgb24"]))

    def test_observe_ok(self):
        proc = self.run_holdings("observe", "--container", "srf-ng-hcap-x-1")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        body = parse_line(proc.stdout, 65536)
        self.assertEqual(set(body),
                         {"tick", "revision", "state_sha256", "elements",
                          "frame_state_sha256"})
        self.assertTrue(HEX64_RE.fullmatch(body["state_sha256"]))

    def test_input_key_ok(self):
        proc = self.run_holdings("input", "--key", "Return")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        body = parse_line(proc.stdout, 65536)
        self.assertIs(type(body["input_mono_ns"]), int)
        self.assertGreater(body["input_mono_ns"], 0)

    def test_input_needs_one(self):
        proc = self.run_holdings("input")
        self.assertEqual(proc.returncode, 2)
        proc = self.run_holdings("input", "--key", "a", "--click", "1,2")
        self.assertEqual(proc.returncode, 2)

    def test_input_bad_keysym(self):
        proc = self.run_holdings("input", "--key", "has space")
        self.assertEqual(proc.returncode, 2)

    def test_input_out_of_bounds(self):
        proc = self.run_holdings("input", "--click", "2000,10")
        self.assertEqual(proc.returncode, 2)

    def test_stop_ok(self):
        proc = self.run_holdings("stop", "--container", "srf-ng-hcap-x-1")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        body = parse_line(proc.stdout, 65536)
        self.assertEqual(body, {"stopped": "srf-ng-hcap-x-1"})

    def test_never_exits_one(self):
        cases = [
            ["start"],
            ["start", "--app", str(self.temp.name), "--slots", "9"],
            ["frame", "--container", "c"],
            ["input"],
            ["input", "--key", "bad keysym!!"],
        ]
        for argv in cases:
            with self.subTest(argv=argv):
                self.assertNotEqual(self.run_holdings(*argv).returncode, 1)


class FakeSrfTests(unittest.TestCase):
    def run_srf(self, *argv):
        return run_fake(["--family", "srf", *argv])

    def test_estado_json_ok(self):
        proc = self.run_srf("estado", "--json")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        body = parse_line(proc.stdout, 65536)
        self.assertEqual(set(body),
                         {"estado", "parada", "vivas", "reservado_mib",
                          "disponible_mib", "soberana_mib"})

    def test_estado_text_ok(self):
        proc = self.run_srf("estado")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(proc.stdout.startswith(b"srfd:"))

    def test_estado_refused_json_stays_on_stderr(self):
        proc = self.run_srf("estado", "--json", "--refuse", "9")
        self.assertEqual(proc.returncode, 9)
        self.assertEqual(proc.stdout, b"")
        self.assertIn(b"srf: estado:", proc.stderr)

    def test_iniciar_refused_json(self):
        proc = self.run_srf("capsula", "iniciar", "--slot", "2", "--json",
                            "--refuse", "9")
        self.assertEqual(proc.returncode, 9)
        body = parse_line(proc.stdout, 65536)
        self.assertEqual(body, {"error": "refused", "ok": False, "rc": 9})

    def test_detener_json_ok(self):
        proc = self.run_srf("capsula", "detener", "--slot", "2", "--json")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        body = parse_line(proc.stdout, 65536)
        self.assertEqual(body, {"estado": "detenido", "ok": True, "rc": 0,
                                "slot": 2})

    def test_listar_ok(self):
        proc = self.run_srf("listar", "--json")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        bodies = json.loads(proc.stdout.decode())
        self.assertIs(type(bodies), list)
        self.assertEqual(bodies[0]["slot"], 1)

    def test_unreachable_exits_one(self):
        proc = self.run_srf("estado", "--unreachable", "--socket", "down.sock")
        self.assertEqual(proc.returncode, 1)
        self.assertIn(b"down.sock", proc.stderr)

    def test_usage(self):
        proc = self.run_srf("estado", "--clase", "nope")
        self.assertEqual(proc.returncode, 2)


class CliLineContractTests(unittest.TestCase):
    def test_go_valid_fixture_parses(self):
        raw = (REPO / "daemon-adapter/testdata/cli_identity_valid.json"
               ).read_bytes()
        body = parse_line(raw, len(raw))
        self.assertTrue(body["container"])
        self.assertTrue(body["run_id"])
        self.assertTrue(body["windows"][0]["id"])

    def test_go_malformed_fixture_rejected(self):
        raw = (REPO / "daemon-adapter/testdata/cli_malformed.txt"
               ).read_bytes()
        with self.assertRaises(MalformedLine):
            parse_line(raw, 65536)

    def test_rejects_controls(self):
        vectors = [b"{}\n{}\n", b"{} {}", b'{"x":1,"x":2}', b"[]", b"null",
                   b"{}\n\n", b'"\xff"', b"not json\n", b"{}\r\n", b"\n",
                   b'{"a":1} trailing\n']
        for raw in vectors:
            with self.subTest(raw=raw):
                with self.assertRaises(MalformedLine):
                    parse_line(raw, 128)

    def test_cap_enforced(self):
        self.assertEqual(parse_line(b"{}\n", 3), {})
        with self.assertRaises(MalformedLine):
            parse_line(b"{}\n", 2)

    def test_fake_object_outputs_are_single_lines(self):
        stores = ["--store-root", "s", "--registry", "r"]
        with tempfile.TemporaryDirectory() as temp:
            cases = [
                ["--family", "identity", "start", "--identity", "wall",
                 *stores],
                ["--family", "identity", "frame", "--container", "c",
                 "--window", "w1", *stores],
                ["--family", "identity", "ax", "--container", "c",
                 "--window", "w1", *stores],
                ["--family", "identity", "input", "--container", "c",
                 "--window", "w1", "--key", "a", *stores],
                ["--family", "identity", "stop", "--container", "c", *stores],
                ["--family", "holdings", "frame", "--container", "c",
                 "--state", "s"],
                ["--family", "holdings", "observe", "--container", "c"],
                ["--family", "holdings", "input", "--key", "a"],
                ["--family", "holdings", "stop", "--container", "c"],
                ["--family", "srf", "estado", "--json"],
                ["--family", "srf", "capsula", "iniciar", "--json"],
                ["--family", "srf", "capsula", "detener", "--json"],
            ]
            for argv in cases:
                with self.subTest(argv=argv):
                    proc = run_fake(argv)
                    self.assertEqual(proc.returncode, 0, proc.stderr)
                    self.assertEqual(proc.stdout.count(b"\n"), 1)
                    parse_line(proc.stdout, FRAME_CAP)
            proc = run_fake(["--family", "holdings", "start", "--app", temp])
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(proc.stdout.count(b"\n"), 1)
            self.assertIs(type(json.loads(proc.stdout.decode())), list)


class SurfaceContractTests(unittest.TestCase):
    def setUp(self):
        self.v1 = Validator(REPO / "contracts/v0.1")
        self.v2 = Validator(REPO / "contracts/v0.2")

    def assertInvalid(self, validator, value, name):
        with self.assertRaises(ValidationError):
            validator.validate(value, {"$ref": name})

    def request(self, op):
        params = {
            "create": {"kind": "browser",
                       "geometry": {"w": 800, "h": 600},
                       "profile_id": "profile-test"},
            "list": {},
            "destroy": {"surface_id": "surface-test"},
            "take_control": {"surface_id": "surface-test", "owner": "agent"},
            "release_control": {"surface_id": "surface-test"},
            "input": {"surface_id": "surface-test",
                      "proposal_id": "proposal-test",
                      "action": {"type": "click", "x": 1, "y": 2,
                                 "button": "left"}},
            "frame_subscribe": {"surface_id": "surface-test"},
            "frame_unsubscribe": {"surface_id": "surface-test"},
        }[op]
        return {"schema": "surface_request/v0.2", "op": op, "params": params}

    def test_examples_validate(self):
        for name in ("envelope", "surface_request", "surface_event",
                     "hello"):
            with self.subTest(name=name):
                good = json.loads(
                    (REPO / ("contracts/examples/v0.2/%s.valid.json" % name)
                     ).read_text())
                self.v2.validate(good, {"$ref": "%s.schema.json" % name})
                bad = json.loads(
                    (REPO / ("contracts/examples/v0.2/%s.invalid.schema.json"
                             % name)).read_text())
                self.assertInvalid(self.v2, bad, "%s.schema.json" % name)

    def test_adapter_op_set_covered(self):
        for op in ADAPTER_OPS:
            with self.subTest(op=op):
                self.v2.validate(self.request(op),
                                 {"$ref": "surface_request.schema.json"})
        self.assertInvalid(self.v2,
                           {"schema": "surface_request/v0.2", "op": "warp",
                            "params": {}}, "surface_request.schema.json")

    def test_error_event_matches_adapter_shape(self):
        for version, validator in (("v0.1", self.v1), ("v0.2", self.v2)):
            with self.subTest(version=version):
                event = {"schema": "surface_event/%s" % version,
                         "event": "error",
                         "data": {"surface_id": "surface-test",
                                  "code": "malformed_cli",
                                  "detail": "bad line"}}
                validator.validate(event, {"$ref": "surface_event.schema.json"})
                bad = {"schema": "surface_event/%s" % version,
                       "event": "error",
                       "data": {"surface_id": "", "code": "x",
                                "detail": "y"}}
                self.assertInvalid(validator, bad, "surface_event.schema.json")

    def test_verdict_reasons_are_six(self):
        schema = self.v2.load("action_verdict.schema.json")
        reasons = None
        for branch in schema["oneOf"]:
            props = branch["properties"]
            if props["decision"] == {"const": "refused"} \
                    and "reason_code" in props:
                reasons = props["reason_code"]["enum"]
        self.assertIsNotNone(reasons)
        self.assertEqual(tuple(reasons), REFUSALS)

    def test_core_refusal_taxonomy_matches(self):
        text = (REPO / "core/src/wire/mod.rs").read_text()
        text += "\n" + (REPO / "core/src/admission/mod.rs").read_text()
        self.assertIn("SCREAMING_SNAKE_CASE", text)
        for code in REFUSALS:
            with self.subTest(code=code):
                self.assertIn(code, text)

    def test_envelope_carries_surface_request(self):
        envelope = {"schema": "envelope/v0.2", "msg_id": "message-test",
                    "ts_ns": 1,
                    "from": {"component": "daemon",
                             "instance": "daemon-test"},
                    "to": {"component": "core", "instance": "core-test"},
                    "session_id": "session-test", "seq": 1,
                    "nonce": "nonce-test", "body": self.request("create")}
        self.v2.validate(envelope, {"$ref": "envelope.schema.json"})

    def test_hello_handshake_shape(self):
        hello = json.loads(
            (REPO / "contracts/examples/v0.2/hello.valid.json").read_text())
        self.v2.validate(hello, {"$ref": "hello.schema.json"})
        bad = dict(hello, contract_version="v9.9")
        self.assertInvalid(self.v2, bad, "hello.schema.json")


class SocketFramingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name) / "run"
        self.dir.mkdir(mode=0o700)
        self.sockets = []
        self.files = []
        self.addCleanup(self.close_all)

    def close_all(self):
        for item in self.files + self.sockets:
            try:
                item.close()
            except OSError:
                pass

    def _pair(self):
        client, server = socket.socketpair(socket.AF_UNIX)
        self.sockets.extend((client, server))
        client.settimeout(5)
        server.settimeout(5)
        reader = server.makefile("rb")
        self.files.append(reader)
        return client, server, reader

    def test_envelope_round_trip(self):
        client, server, reader = self._pair()
        self.assertTrue(peer_admitted(peer_uid(server), os.getuid()))
        envelope = json.loads(
            (REPO / "contracts/examples/v0.2/envelope.valid.json"
             ).read_text())
        validator = Validator(REPO / "contracts/v0.2")
        validator.validate(envelope, {"$ref": "envelope.schema.json"})
        client.sendall((json.dumps(envelope, sort_keys=True) + "\n").encode())
        raw = read_frame(reader, FRAME_CAP)
        body = parse_line(raw, FRAME_CAP)
        validator.validate(body, {"$ref": "envelope.schema.json"})
        self.assertEqual(body, envelope)

    def test_socket_path_accepted(self):
        self.assertIsNone(prepare_socket_path(str(self.dir / "core.sock")))

    def test_public_dir_refused(self):
        os.chmod(self.dir, 0o777)
        with self.assertRaises(ValueError):
            prepare_socket_path(str(self.dir / "core.sock"))

    def test_occupied_path_refused(self):
        target = self.dir / "core.sock"
        target.write_text("keep")
        with self.assertRaises(ValueError):
            prepare_socket_path(str(target))
        self.assertEqual(target.read_text(), "keep")

    def test_peer_admission_is_uid_equality(self):
        uid = os.getuid()
        self.assertTrue(peer_admitted(uid, uid))
        self.assertFalse(peer_admitted(uid + 1, uid))
        self.assertFalse(peer_admitted(0, 1))

    def test_unterminated_frame_rejected(self):
        client, _server, reader = self._pair()
        client.sendall(b"{}")
        client.shutdown(socket.SHUT_WR)
        with self.assertRaises(MalformedLine):
            read_frame(reader, FRAME_CAP)

    def test_oversize_frame_rejected(self):
        client, _server, reader = self._pair()
        client.sendall(b"{" + b"x" * 100 + b"}\n")
        with self.assertRaises(MalformedLine):
            read_frame(reader, 10)

    def test_invalid_envelope_rejected_after_framing(self):
        client, _server, reader = self._pair()
        invalid = json.loads(
            (REPO / "contracts/examples/v0.2/envelope.invalid.schema.json"
             ).read_text())
        client.sendall((json.dumps(invalid) + "\n").encode())
        raw = read_frame(reader, FRAME_CAP)
        body = parse_line(raw, FRAME_CAP)
        with self.assertRaises(ValidationError):
            Validator(REPO / "contracts/v0.2").validate(
                body, {"$ref": "envelope.schema.json"})


if __name__ == "__main__":
    unittest.main()
