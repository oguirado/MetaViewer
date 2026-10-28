"""Unit and mutation tests for persistent vserve client (MV-VCORE-CLIENT).

Each test states the one-line mutation it catches and exercises real
subprocess pipes (hosted-safe fake vserve process) plus an opt-in real
vision-engine checkout test when ``MV_VE_ROOT`` points at a checkout
containing ``vadapt/vserve.py``.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from metaviewer_agents.perception import vcore
from metaviewer_agents.perception.base import (
    Frame,
    PerceptionError,
    check_vision,
)
from metaviewer_agents.perception.vcore import (
    C2_SCHEMA,
    VSERVE_HELLO_SCHEMA,
    VSERVE_REPLY_SCHEMA,
    VCorePerceptionAdapter,
    _parse_vserve_reply,
    _resolve_pinned_python,
)


_FAKE_VSERVE_SOURCE = textwrap.dedent(
    """\
    import hashlib
    import json
    import os
    import pathlib
    import sys

    MODE = os.path.exists(os.path.join(os.getcwd(), "vserve_mode.json"))
    cfg = {}
    if MODE:
        cfg = json.loads(pathlib.Path("vserve_mode.json").read_text(encoding="utf-8"))

    boot_count_file = pathlib.Path("vserve_boots.txt")
    boots = int(boot_count_file.read_text(encoding="utf-8")) + 1 if boot_count_file.exists() else 1
    boot_count_file.write_text(str(boots), encoding="utf-8")
    pathlib.Path("vserve.pid").write_text(str(os.getpid()), encoding="utf-8")

    def reply(req_id, op, ok, rc, code, detail, result):
        msg = {
            "code": code,
            "detail": detail,
            "ok": ok,
            "op": op,
            "rc": rc,
            "request_id": req_id,
            "result": result,
            "schema": cfg.get("reply_schema", "ve.vserve.reply/v1"),
        }
        sys.stdout.write(json.dumps(msg, separators=(",", ":")) + "\\n")
        sys.stdout.flush()

    hello_payload = {
        "active_sessions": cfg.get("active_sessions", 0),
        "capabilities": cfg.get(
            "capabilities",
            ["describe", "hello", "ping", "capabilities", "open_session",
             "close_session", "reap", "status", "frame_raw", "prev_raw"],
        ),
        "frame_raw": cfg.get("frame_raw", True),
        "max_control_line_bytes": cfg.get("max_control_line_bytes", 65536),
        "max_frame_bytes": cfg.get("max_frame_bytes", 33554432),
        "max_sessions": cfg.get("max_sessions", 16),
        "raw_shm": cfg.get("raw_shm", True),
        "ring": cfg.get("ring", True),
        "schema": cfg.get("hello_schema", "ve.vserve.hello/v1"),
    }

    seen_ops = []
    for raw_line in sys.stdin:
        req = json.loads(raw_line)
        req_id = req.get("request_id")
        op = req.get("op", "describe")
        seen_ops.append(op)
        pathlib.Path("vserve_ops.json").write_text(json.dumps(seen_ops), encoding="utf-8")

        if op in ("hello", "ping", "capabilities"):
            if cfg.get("fail_ping") and op == "ping":
                reply(req_id, op, False, 5, "E_UNAVAILABLE", "ping gate failed", None)
                continue
            reply(req_id, op, True, 0, "OK", "", dict(hello_payload))
            continue

        if op == "status":
            if cfg.get("bad_status"):
                reply(req_id, op, True, 0, "OK", {}, {"active_sessions": 5, "max_sessions": 16, "session_ids": []})
                continue
            reply(req_id, op, True, 0, "OK", {}, {
                "active_sessions": 0,
                "max_control_line_bytes": 65536,
                "max_frame_bytes": 33554432,
                "max_sessions": 16,
                "session_bytes": 0,
                "session_ids": [],
            })
            continue

        if op == "describe":
            if cfg.get("require_hello_before_describe", True) and "hello" not in seen_ops:
                reply(req_id, op, False, 2, "E_REFUSE", "hello required before describe", None)
                continue
            if cfg.get("crash_on_first_describe") and boots == 1:
                sys.exit(1)
            if cfg.get("crash_always_describe"):
                sys.stderr.write("vserve fatal crash\\n")
                sys.stderr.flush()
                sys.exit(1)
            if cfg.get("describe_error_rc"):
                rc = int(cfg["describe_error_rc"])
                code = cfg.get("describe_error_code", "E_ERR")
                detail = cfg.get("describe_error_detail", "forced vserve describe error")
                reply(req_id, op, False, rc, code, detail, None)
                continue

            frame_raw = req.get("frame_raw")
            if not isinstance(frame_raw, str) or "," not in frame_raw:
                reply(req_id, op, False, 2, "E_REFUSE", "expected frame_raw spec", None)
                continue
            parts = frame_raw.rsplit(",", 2)
            raw_path = parts[0]
            width = int(parts[1])
            height = int(parts[2])
            data = pathlib.Path(raw_path).read_bytes()
            if len(data) != width * height * 3:
                reply(req_id, op, False, 2, "E_REFUSE", "raw byte count mismatch", None)
                continue
            stat_mode = os.stat(raw_path).st_mode & 0o777
            pathlib.Path("last_describe_req.json").write_text(
                json.dumps({
                    "frame_raw": frame_raw,
                    "prev_raw": req.get("prev_raw"),
                    "mode": stat_mode,
                    "raw_len": len(data),
                }),
                encoding="utf-8",
            )
            prev_given = req.get("prev_raw") is not None or req.get("prev") is not None
            changed = None
            changed_regions = []
            if prev_given:
                changed = True
                changed_regions = [{"x": 0, "y": 0, "w": min(8, width), "h": min(8, height), "score": 0.9}]
            sha = cfg.get("override_sha256") or hashlib.sha256(data).hexdigest()
            c2 = {
                "schema": "ve.cu_describe/v1",
                "frame_sha256": sha,
                "width": width,
                "height": height,
                "changed": changed,
                "changed_regions": changed_regions,
                "crops": [{"x": 0, "y": 0, "w": min(8, width), "h": min(8, height), "reason": "salient"}],
                "mark_cap_reached": False,
                "timing_us": 42,
            }
            if req.get("marks_out") is not None:
                c2["marks"] = [
                    {
                        "id": 1,
                        "x": 0,
                        "y": 0,
                        "w": min(8, width),
                        "h": min(8, height),
                        "kind": "button",
                        "score": 0.85,
                    }
                ]
                c2["marks_png"] = req["marks_out"]
            reply(req_id, op, True, 0, "OK", "", c2)
    """
)


_FAKE_CU_DESCRIBE_SOURCE = textwrap.dedent(
    """\
    import hashlib
    import json
    import os
    import pathlib
    import struct
    import sys
    import zlib

    cfg = {}
    if os.path.exists("cu_mode.json"):
        cfg = json.loads(pathlib.Path("cu_mode.json").read_text(encoding="utf-8"))

    pathlib.Path("cu_called.txt").write_text("1", encoding="utf-8")

    if "exit_rc" in cfg:
        sys.stderr.write(cfg.get("stderr", "cu_describe forced error"))
        sys.stderr.flush()
        sys.exit(int(cfg["exit_rc"]))

    args = sys.argv[1:]
    frame_path = args[args.index("--frame") + 1]
    prev_given = "--prev" in args
    marks_out = args[args.index("--marks-out") + 1] if "--marks-out" in args else None

    raw_png = pathlib.Path(frame_path).read_bytes()
    if raw_png[:8] != b"\\x89PNG\\r\\n\\x1a\\n":
        sys.stderr.write("not a png")
        sys.exit(2)
    width, height = struct.unpack(">II", raw_png[16:24])
    # Extract IDAT payload to compute exact RGB24 sha256
    pos = 8
    idat = bytearray()
    while pos < len(raw_png):
        length = struct.unpack(">I", raw_png[pos:pos + 4])[0]
        ctype = raw_png[pos + 4:pos + 8]
        chunk = raw_png[pos + 8:pos + 8 + length]
        pos += 12 + length
        if ctype == b"IDAT":
            idat.extend(chunk)
    decompressed = zlib.decompress(bytes(idat))
    row_bytes = width * 3
    rgb = bytearray()
    for row in range(height):
        start = row * (1 + row_bytes) + 1
        rgb.extend(decompressed[start:start + row_bytes])
    sha = cfg.get("override_sha256") or hashlib.sha256(bytes(rgb)).hexdigest()
    c2 = {
        "schema": "ve.cu_describe/v1",
        "frame_sha256": sha,
        "width": width,
        "height": height,
        "changed": True if prev_given else None,
        "changed_regions": (
            [{"x": 0, "y": 0, "w": min(8, width), "h": min(8, height), "score": 0.9}]
            if prev_given else []
        ),
        "crops": [],
        "mark_cap_reached": False,
        "timing_us": 310,
    }
    if marks_out is not None:
        c2["marks"] = []
        c2["marks_png"] = marks_out
    sys.stdout.write(json.dumps(c2))
    sys.stdout.flush()
    """
)


def _make_frame(width: int = 16, height: int = 12, fill: int = 0x2A) -> tuple[dict[str, object], Frame]:
    data = bytes([fill & 0xFF]) * (width * height * 3)
    sha = hashlib.sha256(data).hexdigest()
    ref = {
        "schema": "frame_ref/v0.1",
        "width": width,
        "height": height,
        "sha256": sha,
    }
    return ref, Frame(width=width, height=height, data=data)


def _setup_fake_ve_root(
    test_case: unittest.TestCase,
    *,
    numpy_version: str = "2.4.2",
    with_vserve: bool = True,
    vserve_mode: dict[str, object] | None = None,
    cu_mode: dict[str, object] | None = None,
) -> Path:
    tmp = tempfile.TemporaryDirectory(prefix="mv-vserve-test-")
    test_case.addCleanup(tmp.cleanup)
    root = Path(tmp.name)

    # Provide a local numpy stub on PYTHONPATH=ve_root so hosted CI runners
    # without site-packages numpy still exercise real subprocess probing.
    np_dir = root / "numpy"
    np_dir.mkdir(parents=True, exist_ok=True)
    (np_dir / "__init__.py").write_text(
        f'__version__ = "{numpy_version}"\n',
        encoding="utf-8",
    )

    vadapt_dir = root / "vadapt"
    vadapt_dir.mkdir(parents=True, exist_ok=True)
    (vadapt_dir / "__init__.py").write_text("", encoding="utf-8")
    (vadapt_dir / "cu_describe.py").write_text(_FAKE_CU_DESCRIBE_SOURCE, encoding="utf-8")
    if with_vserve:
        (vadapt_dir / "vserve.py").write_text(_FAKE_VSERVE_SOURCE, encoding="utf-8")
    if vserve_mode is not None:
        (root / "vserve_mode.json").write_text(
            json.dumps(vserve_mode), encoding="utf-8"
        )
    if cu_mode is not None:
        (root / "cu_mode.json").write_text(
            json.dumps(cu_mode), encoding="utf-8"
        )
    return root


class VServeHandshakeAndHealthTests(unittest.TestCase):
    def test_lazy_start_and_hello_caps_echo_catches_mut_vs_no_hello(self) -> None:
        # Mutation caught: MUT-VS-NO-HELLO (_vserve_start returns without hello
        # handshake or accepts an unverified hello payload).
        root = _setup_fake_ve_root(self)
        adapter = VCorePerceptionAdapter(
            root, python=sys.executable, fallback_oneshot=False
        )
        self.addCleanup(adapter.close)

        # Lazy lifecycle: constructing the adapter must not spawn vserve.
        self.assertIsNone(adapter._vserve_proc)
        self.assertIsNone(adapter._vserve_hello_info)
        self.assertFalse((root / "vserve.pid").exists())

        hello = adapter._vserve_start()
        self.assertEqual(hello["schema"], VSERVE_HELLO_SCHEMA)
        self.assertTrue(hello["raw_shm"])
        self.assertTrue(hello["frame_raw"])
        self.assertIn("describe", hello["capabilities"])
        self.assertIn("frame_raw", hello["capabilities"])
        self.assertEqual(hello["max_control_line_bytes"], 65536)
        self.assertEqual(hello["max_frame_bytes"], 33554432)
        self.assertEqual(hello["max_sessions"], 16)
        self.assertEqual(hello["active_sessions"], 0)
        ops = json.loads((root / "vserve_ops.json").read_text(encoding="utf-8"))
        self.assertEqual(ops, ["hello"])

        # Verify that a server advertising missing raw_shm or bad hello schema is rejected.
        bad_root = _setup_fake_ve_root(
            self, vserve_mode={"raw_shm": False}
        )
        bad_adapter = VCorePerceptionAdapter(
            bad_root, python=sys.executable, fallback_oneshot=False
        )
        self.addCleanup(bad_adapter.close)
        with self.assertRaises(PerceptionError) as ctx:
            bad_adapter._vserve_start()
        self.assertEqual(ctx.exception.code, "bad_shape")
        self.assertIsNone(bad_adapter._vserve_proc)

        # Explicit MUT-VS-NO-HELLO one-line mutation simulation:
        # If _vserve_start skips sending hello, the server refuses describe and
        # _vserve_hello_info lacks verified capabilities.
        mut_root = _setup_fake_ve_root(self)
        mut_adapter = VCorePerceptionAdapter(
            mut_root, python=sys.executable, fallback_oneshot=False
        )
        self.addCleanup(mut_adapter.close)
        with mock.patch.object(
            mut_adapter, "_vserve_start", return_value={}
        ):
            ref, frame = _make_frame()
            with self.assertRaises(PerceptionError):
                mut_adapter.perceive(ref, frame)

    def test_health_ping_and_status_checks_fail_closed(self) -> None:
        # Mutation caught: _vserve_health ignores ping/status error or bad session count.
        root = _setup_fake_ve_root(self)
        adapter = VCorePerceptionAdapter(
            root, python=sys.executable, fallback_oneshot=False
        )
        self.addCleanup(adapter.close)

        health = adapter._vserve_health(include_status=True)
        self.assertEqual(health["schema"], VSERVE_HELLO_SCHEMA)
        self.assertEqual(health["status"]["active_sessions"], 0)
        self.assertEqual(health["status"]["max_sessions"], 16)
        ops = json.loads((root / "vserve_ops.json").read_text(encoding="utf-8"))
        self.assertEqual(ops, ["hello", "ping", "status"])

        # Failing ping must close process and raise unavailable.
        fail_ping_root = _setup_fake_ve_root(
            self, vserve_mode={"fail_ping": True}
        )
        fail_ping_adapter = VCorePerceptionAdapter(
            fail_ping_root, python=sys.executable, fallback_oneshot=False
        )
        self.addCleanup(fail_ping_adapter.close)
        with self.assertRaises(PerceptionError) as ctx:
            fail_ping_adapter._vserve_health()
        self.assertEqual(ctx.exception.code, "unavailable")
        self.assertIsNone(fail_ping_adapter._vserve_proc)

        # Inconsistent status session list must fail closed with bad_shape.
        bad_status_root = _setup_fake_ve_root(
            self, vserve_mode={"bad_status": True}
        )
        bad_status_adapter = VCorePerceptionAdapter(
            bad_status_root, python=sys.executable, fallback_oneshot=False
        )
        self.addCleanup(bad_status_adapter.close)
        with self.assertRaises(PerceptionError) as ctx2:
            bad_status_adapter._vserve_health(include_status=True)
        self.assertEqual(ctx2.exception.code, "bad_shape")

    def test_parse_vserve_reply_enforces_closed_schema_and_rc_map(self) -> None:
        # Mutation caught: _parse_vserve_reply accepts rc=1 or foreign schema version.
        good = {
            "code": "OK",
            "detail": "",
            "ok": True,
            "op": "ping",
            "rc": 0,
            "request_id": 7,
            "result": {"schema": VSERVE_HELLO_SCHEMA},
            "schema": VSERVE_REPLY_SCHEMA,
        }
        parsed = _parse_vserve_reply(
            json.dumps(good), expected_id=7, expected_op="ping"
        )
        self.assertEqual(parsed["request_id"], 7)

        # Foreign schema -> unknown_version.
        foreign = dict(good, schema="ve.vserve.reply/v9")
        with self.assertRaises(PerceptionError) as ctx:
            _parse_vserve_reply(json.dumps(foreign), expected_id=7)
        self.assertEqual(ctx.exception.code, "unknown_version")

        # Extra key -> bad_shape.
        extra = dict(good, extra_field=1)
        with self.assertRaises(PerceptionError) as ctx:
            _parse_vserve_reply(json.dumps(extra), expected_id=7)
        self.assertEqual(ctx.exception.code, "bad_shape")

        # rc=1 is never valid in vision-engine -> bad_shape.
        rc1 = dict(good, ok=False, rc=1, code="E_FAIL", detail="boom", result=None)
        with self.assertRaises(PerceptionError) as ctx:
            _parse_vserve_reply(json.dumps(rc1), expected_id=7)
        self.assertEqual(ctx.exception.code, "bad_shape")

        # request_id mismatch -> bad_shape.
        with self.assertRaises(PerceptionError) as ctx:
            _parse_vserve_reply(json.dumps(good), expected_id=8)
        self.assertEqual(ctx.exception.code, "bad_shape")

        # Error rc mappings: 4 -> STALE_FRAME, 5 -> unavailable, 6 -> BUDGET_EXCEEDED, 2/3 -> bad_shape.
        cases = (
            (4, "E_STALE", "STALE_FRAME"),
            (5, "E_GATE", "unavailable"),
            (6, "E_BUDGET", "BUDGET_EXCEEDED"),
            (2, "E_USAGE", "bad_shape"),
            (3, "E_SCHEMA", "bad_shape"),
        )
        for rc, code, expected_err in cases:
            err_msg = {
                "code": code,
                "detail": "err detail",
                "ok": False,
                "op": "describe",
                "rc": rc,
                "request_id": 7,
                "result": None,
                "schema": VSERVE_REPLY_SCHEMA,
            }
            with self.subTest(rc=rc):
                with self.assertRaises(PerceptionError) as err_ctx:
                    _parse_vserve_reply(json.dumps(err_msg), expected_id=7)
                self.assertEqual(err_ctx.exception.code, expected_err)


class PinnedPythonResolverTests(unittest.TestCase):
    def test_pinned_python_requires_numpy_ge_2_catches_mut_pin_system_python(self) -> None:
        # Mutation caught: MUT-PIN-SYSTEM-PYTHON (_resolve_pinned_python accepts
        # numpy 1.26.4 or bare 'python3 -I').
        root_v2 = _setup_fake_ve_root(self, numpy_version="2.4.2")
        resolved = _resolve_pinned_python(
            sys.executable, ve_root=root_v2, timeout=2.0
        )
        self.assertEqual(resolved, sys.executable)

        # Checkout/environment where numpy resolves to 1.26.4 must be rejected as unavailable.
        root_v1 = _setup_fake_ve_root(self, numpy_version="1.26.4")
        with self.assertRaises(PerceptionError) as ctx_v1:
            _resolve_pinned_python(
                sys.executable,
                ve_root=root_v1,
                timeout=2.0,
                candidates=[sys.executable],
            )
        self.assertEqual(ctx_v1.exception.code, "unavailable")

        # Bare 'python3 -I' (isolated flag string) must be rejected as unavailable.
        with self.assertRaises(PerceptionError) as ctx_iso:
            _resolve_pinned_python(
                "python3 -I",
                ve_root=root_v2,
                timeout=2.0,
                candidates=["python3 -I"],
            )
        self.assertEqual(ctx_iso.exception.code, "unavailable")

        # Empty and NUL-containing strings must preserve bad_shape rejection.
        for bad in ("", "python3\x00", None):
            with self.subTest(bad=bad):
                with self.assertRaises(PerceptionError) as ctx_bad:
                    _resolve_pinned_python(bad, ve_root=root_v2)  # type: ignore[arg-type]
                self.assertEqual(ctx_bad.exception.code, "bad_shape")

        # Candidate fallback: first candidate has numpy 1.26.4 (or fails), second has 2.4.2.
        chosen = _resolve_pinned_python(
            "python3 -I",
            ve_root=root_v2,
            timeout=2.0,
            candidates=["python3 -I", sys.executable],
        )
        self.assertEqual(chosen, sys.executable)


class RawShmQueueLifecycleAndFallbackTests(unittest.TestCase):
    def test_raw_rgb24_handoff_skips_png_and_records_latency(self) -> None:
        # Mutation caught: perceive encodes PNG instead of writing raw RGB24 to /dev/shm.
        root = _setup_fake_ve_root(self)
        adapter = VCorePerceptionAdapter(
            root, python=sys.executable, fallback_oneshot=False
        )
        self.addCleanup(adapter.close)

        ref, frame = _make_frame(width=32, height=20, fill=0x55)
        _, prev_frame = _make_frame(width=32, height=20, fill=0x11)
        with mock.patch.object(
            vcore, "_png_bytes", side_effect=AssertionError("PNG encoding must not run on vserve path")
        ):
            vision = adapter.perceive(ref, frame, prev=prev_frame)

        check_vision(vision, width=32, height=20)
        self.assertEqual(adapter.last_transport, "vserve")
        self.assertEqual(adapter.last_timing_us, 42)
        self.assertIsNotNone(adapter.last_latency_us)
        assert adapter.last_latency_us is not None
        self.assertGreater(adapter.last_latency_us, 0)
        self.assertFalse((root / "cu_called.txt").exists())

        req_meta = json.loads(
            (root / "last_describe_req.json").read_text(encoding="utf-8")
        )
        self.assertEqual(req_meta["raw_len"], 32 * 20 * 3)
        self.assertEqual(req_meta["mode"], 0o600)
        raw_path = req_meta["frame_raw"].rsplit(",", 2)[0]
        prev_raw_path = req_meta["prev_raw"].rsplit(",", 2)[0]
        self.assertTrue(raw_path.startswith("/dev/shm/mv-vcore-raw-"))
        self.assertTrue(prev_raw_path.startswith("/dev/shm/mv-vcore-raw-"))
        # Temporary /dev/shm raw files must be unlinked as soon as perceive returns.
        self.assertFalse(os.path.exists(raw_path))
        self.assertFalse(os.path.exists(prev_raw_path))

    def test_bounded_request_queue_enforces_cap_and_abort_policy(self) -> None:
        # Mutation caught: queue_cap allows >4 or unbounded in-flight requests without BUDGET_EXCEEDED.
        root = _setup_fake_ve_root(self)
        for bad_cap in (0, -1, 5, True, "2"):
            with self.subTest(bad_cap=bad_cap):
                with self.assertRaises(PerceptionError) as ctx:
                    VCorePerceptionAdapter(
                        root, python=sys.executable, queue_cap=bad_cap  # type: ignore[arg-type]
                    )
                self.assertEqual(ctx.exception.code, "bad_shape")

        adapter = VCorePerceptionAdapter(
            root, python=sys.executable, queue_cap=2, fallback_oneshot=False
        )
        self.addCleanup(adapter.close)
        self.assertEqual(adapter._vserve_queue.capacity, 2)
        self.assertEqual(adapter._vserve_queue.policy, "abort")

        with adapter._vserve_queue.slot():
            self.assertEqual(len(adapter._vserve_queue), 1)
            with adapter._vserve_queue.slot():
                self.assertEqual(len(adapter._vserve_queue), 2)
                ref, frame = _make_frame()
                with self.assertRaises(PerceptionError) as overflow:
                    adapter.perceive(ref, frame)
                self.assertEqual(overflow.exception.code, "BUDGET_EXCEEDED")
        self.assertEqual(len(adapter._vserve_queue), 0)

    def test_crash_restarts_once_then_exhausts_restart_budget(self) -> None:
        # Mutation caught: _vserve_restart does not cap restarts or fails to re-hello on respawn.
        root = _setup_fake_ve_root(
            self, vserve_mode={"crash_on_first_describe": True}
        )
        adapter = VCorePerceptionAdapter(
            root,
            python=sys.executable,
            max_restarts=1,
            fallback_oneshot=False,
        )
        self.addCleanup(adapter.close)

        ref, frame = _make_frame()
        vision = adapter.perceive(ref, frame)
        check_vision(vision, width=16, height=12)
        self.assertEqual(adapter._vserve_restarts, 1)
        self.assertEqual(adapter.last_transport, "vserve")
        self.assertEqual(
            int((root / "vserve_boots.txt").read_text(encoding="utf-8")), 2
        )

        # Once the 1-restart budget is spent, another forced restart raises unavailable.
        with self.assertRaises(PerceptionError) as exhausted:
            adapter._vserve_restart()
        self.assertEqual(exhausted.exception.code, "unavailable")

    def test_close_terminates_and_reaps_persistent_server(self) -> None:
        # Mutation caught: close() leaves the persistent vserve child running.
        root = _setup_fake_ve_root(self)
        with VCorePerceptionAdapter(
            root, python=sys.executable, fallback_oneshot=False
        ) as adapter:
            ref, frame = _make_frame()
            adapter.perceive(ref, frame)
            pid = int((root / "vserve.pid").read_text(encoding="utf-8"))
            self.assertIsNotNone(adapter._vserve_proc)
        self.assertIsNone(adapter._vserve_proc)
        with self.assertRaises(ChildProcessError):
            os.waitpid(pid, os.WNOHANG)

    def test_oneshot_fallback_and_mut_fb_swallow(self) -> None:
        # Mutation caught: MUT-FB-SWALLOW (fallback failure masks original
        # persistent error code, or fallback fails to truncate stderr / keep identity_mismatch).

        # 1. Persistent server crashes on every describe -> falls back to one-shot cu_describe and succeeds.
        crash_root = _setup_fake_ve_root(
            self, vserve_mode={"crash_always_describe": True}
        )
        adapter = VCorePerceptionAdapter(
            crash_root, python=sys.executable, max_restarts=1
        )
        self.addCleanup(adapter.close)
        ref, frame = _make_frame()
        vision = adapter.perceive(ref, frame)
        check_vision(vision, width=16, height=12)
        self.assertEqual(adapter.last_transport, "oneshot")
        self.assertEqual(adapter.last_timing_us, 310)
        self.assertIsNotNone(adapter.last_latency_us)
        self.assertTrue((crash_root / "cu_called.txt").exists())

        # 2. Persistent server crashes AND fallback exits rc=2 with 5000-byte stderr ->
        # stderr is truncated to <=1000 chars (_STDERR_CAP).
        trunc_root = _setup_fake_ve_root(
            self,
            vserve_mode={"crash_always_describe": True},
            cu_mode={"exit_rc": 2, "stderr": "E" * 5000},
        )
        trunc_adapter = VCorePerceptionAdapter(
            trunc_root, python=sys.executable, max_restarts=0
        )
        self.addCleanup(trunc_adapter.close)
        with self.assertRaises(PerceptionError) as trunc_ctx:
            trunc_adapter.perceive(ref, frame)
        self.assertEqual(trunc_ctx.exception.code, "bad_shape")
        self.assertLessEqual(len(str(trunc_ctx.exception)), 1100)

        # 3. Digest mismatch on vserve or fallback stays identity_mismatch (never swallowed).
        mismatch_root = _setup_fake_ve_root(
            self, vserve_mode={"override_sha256": "0" * 64}
        )
        mismatch_adapter = VCorePerceptionAdapter(
            mismatch_root, python=sys.executable
        )
        self.addCleanup(mismatch_adapter.close)
        with self.assertRaises(PerceptionError) as mm_ctx:
            mismatch_adapter.perceive(ref, frame)
        self.assertEqual(mm_ctx.exception.code, "identity_mismatch")
        # Must not even call cu_describe when vserve returned a mismatched frame digest.
        self.assertFalse((mismatch_root / "cu_called.txt").exists())

        # 4. MUT-FB-SWALLOW: Persistent vserve returns a typed error (STALE_FRAME rc=4
        # or BUDGET_EXCEEDED rc=6) AND fallback cu_describe fails with rc=2 (bad_shape).
        # The original persistent error code must NOT be masked by the fallback failure!
        for rc, err_code, expected_code in (
            (4, "E_STALE", "STALE_FRAME"),
            (6, "E_BUDGET", "BUDGET_EXCEEDED"),
        ):
            with self.subTest(expected_code=expected_code):
                swallow_root = _setup_fake_ve_root(
                    self,
                    vserve_mode={
                        "describe_error_rc": rc,
                        "describe_error_code": err_code,
                        "describe_error_detail": f"persistent {expected_code}",
                    },
                    cu_mode={"exit_rc": 2, "stderr": "fallback refused"},
                )
                swallow_adapter = VCorePerceptionAdapter(
                    swallow_root, python=sys.executable
                )
                self.addCleanup(swallow_adapter.close)
                with self.assertRaises(PerceptionError) as sw_ctx:
                    swallow_adapter.perceive(ref, frame)
                self.assertEqual(sw_ctx.exception.code, expected_code)
                self.assertIn(f"persistent {expected_code}", str(sw_ctx.exception))


class OptInRealVServeBenchmarkTests(unittest.TestCase):
    def test_opt_in_real_vserve_or_fixture_1280x900_latency(self) -> None:
        # Mutation caught: perceive fails to route 1280x900 frames to vserve when
        # vadapt/vserve.py exists in the target checkout.
        mv_ve_root = os.environ.get("MV_VE_ROOT", "").strip()
        if mv_ve_root and (Path(mv_ve_root) / "vadapt" / "vserve.py").is_file():
            target_root = Path(mv_ve_root).resolve()
        else:
            target_root = _setup_fake_ve_root(self)

        ref, frame = _make_frame(width=1280, height=900, fill=0x3C)
        with VCorePerceptionAdapter(
            target_root,
            python="python3",
            timeout=10.0,
            fallback_oneshot=False,
        ) as adapter:
            # Warmup + health check
            health = adapter._vserve_health(include_status=True)
            self.assertEqual(health["schema"], VSERVE_HELLO_SCHEMA)
            vision = adapter.perceive(ref, frame)
            check_vision(vision, width=1280, height=900)
            self.assertEqual(adapter.last_transport, "vserve")
            self.assertIsNotNone(adapter.last_latency_us)
            assert adapter.last_latency_us is not None
            self.assertGreater(adapter.last_latency_us, 0)


if __name__ == "__main__":
    unittest.main()
