"""Mutation and unit tests for persistent vserve client (mut_vcore lane).

Covers the 6 briefs of lane mut_vcore:
1. Handshake and reply validation strictness (MUT-VS-CAPS-AND and edge cases)
2. Bounded queue edges (MUT-VS-QMAX2 and slot/release edges)
3. Restart-once gate (MUT-VS-RETRY-TYPED and restart budget bounds)
4. Fallback mapping and healing (MUT-VS-FB-RC4, healing, swallow, mismatch, fallback_oneshot=False)
5. Interpreter pinning boundary (MUT-VS-PIN-GT, isolated skip, whitespace skip, pin_python caching)
6. Raw RGB handoff and identity gate (MUT-VS-PRECHECK, frame budget, procfd/shm path, marks_out/ocr, failure shm hygiene)
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest import mock
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from metaviewer_agents.perception import vcore
from metaviewer_agents.perception.base import (
    Frame,
    PerceptionError,
    check_vision,
)
from metaviewer_agents.perception.vcore import (
    VSERVE_HELLO_SCHEMA,
    VSERVE_REPLY_SCHEMA,
    VCorePerceptionAdapter,
    _BoundedRequestQueue,
    _parse_vserve_reply,
    _resolve_pinned_python,
)


_FAKE_VSERVE_SOURCE = textwrap.dedent(
    """\
    import hashlib
    import json
    import os
    import pathlib
    import struct
    import sys
    import zlib

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

    def decode_png_rgb(raw_png):
        width, height = struct.unpack(">II", raw_png[16:24])
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
        return width, height, bytes(rgb)

    seen_ops = []
    seen_req_ids = []
    if pathlib.Path("vserve_req_ids.json").exists():
        seen_req_ids = json.loads(pathlib.Path("vserve_req_ids.json").read_text(encoding="utf-8"))

    for raw_line in sys.stdin:
        req = json.loads(raw_line)
        req_id = req.get("request_id")
        op = req.get("op", "describe")
        seen_ops.append(op)
        seen_req_ids.append(req_id)
        pathlib.Path("vserve_ops.json").write_text(json.dumps(seen_ops), encoding="utf-8")
        pathlib.Path("vserve_req_ids.json").write_text(json.dumps(seen_req_ids), encoding="utf-8")

        if op in ("hello", "ping", "capabilities"):
            if cfg.get("fail_ping") and op == "ping":
                reply(req_id, op, False, 5, "E_UNAVAILABLE", "ping gate failed", None)
                continue
            detail_val = cfg.get("hello_detail", "")
            reply(req_id, op, True, 0, "OK", detail_val, dict(hello_payload))
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
            if cfg.get("reject_duplicate_req_id") and seen_req_ids.count(req_id) > 1:
                reply(req_id, op, False, 2, "E_DUP_ID", "duplicate request_id", None)
                continue
            if cfg.get("crash_on_first_describe") and boots == 1:
                sys.exit(1)
            if cfg.get("crash_always_describe"):
                sys.stderr.write("vserve fatal crash\\n")
                sys.stderr.flush()
                sys.exit(1)
            if cfg.get("describe_error_rc") is not None:
                rc = int(cfg["describe_error_rc"])
                code = cfg.get("describe_error_code", "E_ERR")
                detail = cfg.get("describe_error_detail", "forced vserve describe error")
                reply(req_id, op, False, rc, code, detail, None)
                continue

            frame_raw = req.get("frame_raw")
            frame_path = req.get("frame")
            if isinstance(frame_raw, str) and "," in frame_raw:
                parts = frame_raw.rsplit(",", 2)
                raw_path = parts[0]
                width = int(parts[1])
                height = int(parts[2])
                data = pathlib.Path(raw_path).read_bytes()
                if len(data) != width * height * 3:
                    reply(req_id, op, False, 2, "E_REFUSE", "raw byte count mismatch", None)
                    continue
                stat_mode = os.stat(raw_path).st_mode & 0o777
            elif isinstance(frame_path, str):
                raw_png = pathlib.Path(frame_path).read_bytes()
                width, height, data = decode_png_rgb(raw_png)
                stat_mode = os.stat(frame_path).st_mode & 0o777
            else:
                reply(req_id, op, False, 2, "E_REFUSE", "expected frame_raw or frame", None)
                continue

            pathlib.Path("last_describe_req.json").write_text(
                json.dumps({
                    "frame_raw": frame_raw,
                    "frame": frame_path,
                    "prev_raw": req.get("prev_raw"),
                    "prev": req.get("prev"),
                    "marks_out": req.get("marks_out"),
                    "ocr_marks": req.get("ocr_marks"),
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
                mark_entry = {
                    "id": 1,
                    "x": 0,
                    "y": 0,
                    "w": min(8, width),
                    "h": min(8, height),
                    "kind": "button",
                    "score": 0.85,
                }
                if req.get("ocr_marks"):
                    mark_entry["ocr_text"] = "Submit"
                c2["marks"] = [mark_entry]
                c2["marks_png"] = req["marks_out"]
            reply(req_id, op, True, 0, "OK", cfg.get("describe_ok_detail", ""), c2)
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

    if frame_path.startswith("/proc/self/fd/") and "procfd_sha256" in cfg:
        width = int(cfg.get("procfd_width", 16))
        height = int(cfg.get("procfd_height", 12))
        sha = cfg["procfd_sha256"]
    else:
        raw_png = pathlib.Path(frame_path).read_bytes()
        if raw_png[:8] != b"\\x89PNG\\r\\n\\x1a\\n":
            sys.stderr.write("not a png")
            sys.exit(2)
        width, height = struct.unpack(">II", raw_png[16:24])
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


def _setup_isolated_shm(test_case: unittest.TestCase) -> Path:
    existing = getattr(test_case, "_isolated_shm_root", None)
    if isinstance(existing, Path):
        return existing
    shm_tmp = tempfile.TemporaryDirectory(prefix="mv-mut-shm-")
    test_case.addCleanup(shm_tmp.cleanup)
    shm_root = Path(shm_tmp.name).resolve()
    marks_root = shm_root / "vqa-cu"
    marks_root.mkdir(parents=True, exist_ok=True)
    patcher = mock.patch.multiple(
        vcore,
        _SHM_ROOT=str(shm_root),
        _MARKS_ROOT=str(marks_root),
        _RAMWS_PREFIX=str(shm_root) + "/",
    )
    patcher.start()
    test_case.addCleanup(patcher.stop)
    setattr(test_case, "_isolated_shm_root", shm_root)
    return shm_root


def _setup_fake_ve_root(
    test_case: unittest.TestCase,
    *,
    numpy_version: str = "2.4.2",
    with_vserve: bool = True,
    vserve_mode: dict[str, object] | None = None,
    cu_mode: dict[str, object] | None = None,
) -> Path:
    _setup_isolated_shm(test_case)
    tmp = tempfile.TemporaryDirectory(prefix="mv-mut-vserve-")
    test_case.addCleanup(tmp.cleanup)
    root = Path(tmp.name)

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


class MutVServeHandshakeAndReplyTests(unittest.TestCase):
    """Brief 1: Handshake and reply validation strictness (MUT-VS-CAPS-AND)."""

    def test_crossed_error_arms_and_ok_detail_dict(self) -> None:
        # Crossed code arms: rc=2/code=E_STALE -> STALE_FRAME, rc=4/code=E_X -> STALE_FRAME,
        # rc=2/code=E_BUDGET -> BUDGET_EXCEEDED, rc=6/code=E_X -> BUDGET_EXCEEDED.
        crossed_cases = (
            (2, "E_STALE", "STALE_FRAME"),
            (4, "E_X", "STALE_FRAME"),
            (2, "E_BUDGET", "BUDGET_EXCEEDED"),
            (6, "E_X", "BUDGET_EXCEEDED"),
        )
        for rc, code, expected in crossed_cases:
            msg = {
                "code": code,
                "detail": {"reason": "crossed-arm"},
                "ok": False,
                "op": "describe",
                "rc": rc,
                "request_id": 11,
                "result": None,
                "schema": VSERVE_REPLY_SCHEMA,
            }
            with self.subTest(rc=rc, code=code):
                with self.assertRaises(PerceptionError) as ctx:
                    _parse_vserve_reply(json.dumps(msg), expected_id=11)
                self.assertEqual(ctx.exception.code, expected)
                self.assertIn("crossed-arm", str(ctx.exception))

        # Ok-reply with detail={} must be accepted, while non-empty detail is rejected.
        ok_dict_detail = {
            "code": "OK",
            "detail": {},
            "ok": True,
            "op": "ping",
            "rc": 0,
            "request_id": 12,
            "result": {"schema": VSERVE_HELLO_SCHEMA},
            "schema": VSERVE_REPLY_SCHEMA,
        }
        parsed = _parse_vserve_reply(
            json.dumps(ok_dict_detail), expected_id=12, expected_op="ping"
        )
        self.assertEqual(parsed["detail"], {})

        for bad_detail in ("non-empty", {"k": "v"}):
            with self.subTest(bad_detail=bad_detail):
                bad_ok = dict(ok_dict_detail, detail=bad_detail)
                with self.assertRaises(PerceptionError) as ctx_bad:
                    _parse_vserve_reply(json.dumps(bad_ok), expected_id=12)
                self.assertEqual(ctx_bad.exception.code, "bad_shape")

        # Live describe with rc=2 and code=E_STALE must raise STALE_FRAME.
        root = _setup_fake_ve_root(
            self,
            vserve_mode={
                "describe_error_rc": 2,
                "describe_error_code": "E_STALE",
                "describe_error_detail": "crossed live stale",
            },
        )
        adapter = VCorePerceptionAdapter(
            root, python=sys.executable, fallback_oneshot=False
        )
        self.addCleanup(adapter.close)
        ref, frame = _make_frame()
        with self.assertRaises(PerceptionError) as live_ctx:
            adapter.perceive(ref, frame)
        self.assertEqual(live_ctx.exception.code, "STALE_FRAME")

    def test_single_cap_missing_hellos_rejected_catches_mut_vs_caps_and(self) -> None:
        # MUT-VS-CAPS-AND: required-capabilities `or`->`and` at vcore.py:869,
        # or checking only raw_shm at vcore.py:871.
        cases = (
            {"capabilities": ["describe", "hello", "ping", "status"]},  # missing frame_raw
            {"capabilities": ["frame_raw", "hello", "ping", "status"]},  # missing describe
            {"frame_raw": False, "raw_shm": True},  # frame_raw flag False alone
        )
        for mode in cases:
            with self.subTest(mode=mode):
                root = _setup_fake_ve_root(self, vserve_mode=mode)
                adapter = VCorePerceptionAdapter(
                    root, python=sys.executable, fallback_oneshot=False
                )
                self.addCleanup(adapter.close)
                with self.assertRaises(PerceptionError) as ctx:
                    adapter._vserve_start()
                self.assertEqual(ctx.exception.code, "bad_shape")
                self.assertIsNone(adapter._vserve_proc)

    def test_start_twice_idempotence_and_health_without_status(self) -> None:
        # Calling _vserve_start twice must not respawn; include_status=False skips status op.
        root = _setup_fake_ve_root(self, vserve_mode={"hello_detail": {}})
        adapter = VCorePerceptionAdapter(
            root, python=sys.executable, fallback_oneshot=False
        )
        self.addCleanup(adapter.close)

        first = adapter._vserve_start()
        second = adapter._vserve_start()
        self.assertEqual(first["schema"], VSERVE_HELLO_SCHEMA)
        self.assertEqual(second["schema"], VSERVE_HELLO_SCHEMA)
        boots = int((root / "vserve_boots.txt").read_text(encoding="utf-8"))
        self.assertEqual(boots, 1)
        ops = json.loads((root / "vserve_ops.json").read_text(encoding="utf-8"))
        self.assertEqual(ops, ["hello"])

        health = adapter._vserve_health(include_status=False)
        self.assertNotIn("status", health)
        ops_after = json.loads((root / "vserve_ops.json").read_text(encoding="utf-8"))
        self.assertEqual(ops_after, ["hello", "ping"])

    def test_missing_or_symlinked_vserve_falls_back_or_unavailable(self) -> None:
        # 1. with_vserve=False -> perceive succeeds via oneshot with no vserve.pid.
        root_no_vs = _setup_fake_ve_root(self, with_vserve=False)
        adapter = VCorePerceptionAdapter(root_no_vs, python=sys.executable)
        self.addCleanup(adapter.close)
        ref, frame = _make_frame()
        vision = adapter.perceive(ref, frame)
        check_vision(vision, width=16, height=12)
        self.assertEqual(adapter.last_transport, "oneshot")
        self.assertFalse((root_no_vs / "vserve.pid").exists())
        self.assertTrue((root_no_vs / "cu_called.txt").exists())

        # 2. symlink vadapt/vserve.py is treated as unavailable by _vserve_available() and _vserve_start().
        root_sym = _setup_fake_ve_root(self, with_vserve=False)
        target_file = root_sym / "real_vserve.py"
        target_file.write_text(_FAKE_VSERVE_SOURCE, encoding="utf-8")
        (root_sym / "vadapt" / "vserve.py").symlink_to(target_file)
        sym_adapter = VCorePerceptionAdapter(
            root_sym, python=sys.executable, fallback_oneshot=False
        )
        self.addCleanup(sym_adapter.close)
        self.assertFalse(sym_adapter._vserve_available())
        with self.assertRaises(PerceptionError) as ctx:
            sym_adapter._vserve_start()
        self.assertEqual(ctx.exception.code, "unavailable")
        self.assertFalse((root_sym / "vserve.pid").exists())


class MutVServeBoundedQueueTests(unittest.TestCase):
    """Brief 2: Bounded queue edges (MUT-VS-QMAX2)."""

    def test_caps_3_and_4_accepted_and_enforced_catches_mut_vs_qmax2(self) -> None:
        # MUT-VS-QMAX2: queue maximum 4->2 at vcore.py:931-932.
        root = _setup_fake_ve_root(self)
        for cap in (3, 4):
            with self.subTest(cap=cap):
                adapter = VCorePerceptionAdapter(
                    root, python=sys.executable, queue_cap=cap, fallback_oneshot=False
                )
                self.addCleanup(adapter.close)
                q = adapter._vserve_queue
                self.assertEqual(q.capacity, cap)
                self.assertEqual(q.policy, "abort")
                for expected_inflight in range(1, cap + 1):
                    q.acquire()
                    self.assertEqual(len(q), expected_inflight)
                    self.assertEqual(q.in_flight, expected_inflight)
                with self.assertRaises(PerceptionError) as ctx:
                    q.acquire()
                self.assertEqual(ctx.exception.code, "BUDGET_EXCEEDED")
                for _ in range(cap):
                    q.release()
                self.assertEqual(len(q), 0)

    def test_release_on_empty_slot_yield_and_exception_cleanup(self) -> None:
        q = _BoundedRequestQueue(capacity=2)
        # MUT-VS-EMPTY-RELEASE: clamping at zero masks an unmatched release.
        # slot() acquires before its try/finally, so cleanup owns a slot.
        with self.assertRaises(PerceptionError) as ctx:
            q.release()
        self.assertEqual(ctx.exception.code, "bad_shape")
        self.assertEqual(len(q), 0)
        self.assertEqual(q.in_flight, 0)

        # Nested slots yield live in-flight count 1 then 2.
        with q.slot() as s1:
            self.assertEqual(s1, 1)
            with q.slot() as s2:
                self.assertEqual(s2, 2)
                # A failed acquire never enters slot()'s cleanup block.
                with self.assertRaises(PerceptionError) as full:
                    with q.slot():
                        self.fail("over-capacity slot admitted")
                self.assertEqual(full.exception.code, "BUDGET_EXCEEDED")
                self.assertEqual(q.in_flight, 2)
            self.assertEqual(len(q), 1)
        self.assertEqual(len(q), 0)

        # Exception inside slot releases the slot so a subsequent perceive succeeds.
        root = _setup_fake_ve_root(self)
        adapter = VCorePerceptionAdapter(
            root, python=sys.executable, queue_cap=1, fallback_oneshot=False
        )
        self.addCleanup(adapter.close)
        with self.assertRaises(RuntimeError):
            with adapter._vserve_queue.slot() as count:
                self.assertEqual(count, 1)
                raise RuntimeError("boom inside slot")
        self.assertEqual(len(adapter._vserve_queue), 0)
        ref, frame = _make_frame()
        vision = adapter.perceive(ref, frame)
        check_vision(vision, width=16, height=12)


class MutVServeRestartGateTests(unittest.TestCase):
    """Brief 3: Restart-once gate (MUT-VS-RETRY-TYPED)."""

    def test_no_retry_on_typed_errors_and_distinct_request_ids_catches_mut_vs_retry_typed(self) -> None:
        # MUT-VS-RETRY-TYPED: retry gate drops unavailable/proc-is-None check,
        # respawning on STALE_FRAME (boots==2).
        root = _setup_fake_ve_root(
            self,
            vserve_mode={
                "describe_error_rc": 4,
                "describe_error_code": "E_STALE",
                "describe_error_detail": "stale frame input",
            },
        )
        adapter = VCorePerceptionAdapter(
            root, python=sys.executable, max_restarts=2, fallback_oneshot=True
        )
        self.addCleanup(adapter.close)
        ref, frame = _make_frame()
        vision = adapter.perceive(ref, frame)
        check_vision(vision, width=16, height=12)
        self.assertEqual(adapter.last_transport, "oneshot")
        self.assertEqual(adapter._vserve_restarts, 0)
        boots = int((root / "vserve_boots.txt").read_text(encoding="utf-8"))
        self.assertEqual(boots, 1)
        req_ids = json.loads((root / "vserve_req_ids.json").read_text(encoding="utf-8"))
        self.assertEqual(len(req_ids), len(set(req_ids)))

        # Also verify retry after crash uses a fresh request_id (never reuses the crashed describe req_id).
        crash_root = _setup_fake_ve_root(
            self,
            vserve_mode={
                "crash_on_first_describe": True,
                "reject_duplicate_req_id": True,
            },
        )
        crash_adapter = VCorePerceptionAdapter(
            crash_root, python=sys.executable, max_restarts=1, fallback_oneshot=False
        )
        self.addCleanup(crash_adapter.close)
        vision2 = crash_adapter.perceive(ref, frame)
        check_vision(vision2, width=16, height=12)
        crash_req_ids = json.loads(
            (crash_root / "vserve_req_ids.json").read_text(encoding="utf-8")
        )
        self.assertEqual(crash_req_ids, [1, 2, 3, 4])

    def test_zero_restart_budget_and_max_restarts_bounds_and_failed_restart(self) -> None:
        # 1. crash_always with max_restarts=0 falls back with boots==1.
        root0 = _setup_fake_ve_root(
            self, vserve_mode={"crash_always_describe": True}
        )
        adapter0 = VCorePerceptionAdapter(
            root0, python=sys.executable, max_restarts=0, fallback_oneshot=True
        )
        self.addCleanup(adapter0.close)
        ref, frame = _make_frame()
        vision = adapter0.perceive(ref, frame)
        check_vision(vision, width=16, height=12)
        self.assertEqual(adapter0.last_transport, "oneshot")
        self.assertEqual(
            int((root0 / "vserve_boots.txt").read_text(encoding="utf-8")), 1
        )

        # 2. max_restarts bounds: 2, 3, 4 accepted; 5, -1, True rejected with bad_shape.
        for valid_max in (0, 1, 2, 3, 4):
            with self.subTest(valid_max=valid_max):
                a = VCorePerceptionAdapter(
                    root0, python=sys.executable, max_restarts=valid_max
                )
                self.addCleanup(a.close)
                self.assertEqual(a._max_restarts, valid_max)

        for bad_max in (-1, 5, True, "1"):
            with self.subTest(bad_max=bad_max):
                with self.assertRaises(PerceptionError) as ctx:
                    VCorePerceptionAdapter(
                        root0, python=sys.executable, max_restarts=bad_max  # type: ignore[arg-type]
                    )
                self.assertEqual(ctx.exception.code, "bad_shape")

        # 3. Failed restart against a bad-hello server consumes budget:
        # first restart raises bad_shape (restarts==1, boots==1), second raises unavailable without spawning.
        bad_hello_root = _setup_fake_ve_root(
            self, vserve_mode={"raw_shm": False}
        )
        bad_adapter = VCorePerceptionAdapter(
            bad_hello_root, python=sys.executable, max_restarts=1, fallback_oneshot=False
        )
        self.addCleanup(bad_adapter.close)
        with self.assertRaises(PerceptionError) as ctx1:
            bad_adapter._vserve_restart()
        self.assertEqual(ctx1.exception.code, "bad_shape")
        self.assertEqual(bad_adapter._vserve_restarts, 1)
        self.assertEqual(
            int((bad_hello_root / "vserve_boots.txt").read_text(encoding="utf-8")), 1
        )
        with self.assertRaises(PerceptionError) as ctx2:
            bad_adapter._vserve_restart()
        self.assertEqual(ctx2.exception.code, "unavailable")
        self.assertEqual(
            int((bad_hello_root / "vserve_boots.txt").read_text(encoding="utf-8")), 1
        )


class MutVServeFallbackMappingAndHealingTests(unittest.TestCase):
    """Brief 4: Fallback mapping and healing (MUT-VS-FB-RC4)."""

    def test_fallback_rc_mapping_with_pending_vserve_error_catches_mut_vs_fb_rc4(self) -> None:
        # MUT-VS-FB-RC4: vserve crash (unavailable) + cu exit 4/5/6 maps to
        # STALE_FRAME / unavailable / BUDGET_EXCEEDED respectively.
        ref, frame = _make_frame()
        cases = (
            (4, "STALE_FRAME"),
            (5, "unavailable"),
            (6, "BUDGET_EXCEEDED"),
        )
        for cu_rc, expected_code in cases:
            with self.subTest(cu_rc=cu_rc):
                root = _setup_fake_ve_root(
                    self,
                    vserve_mode={"crash_always_describe": True},
                    cu_mode={"exit_rc": cu_rc, "stderr": f"cu exit {cu_rc}"},
                )
                adapter = VCorePerceptionAdapter(
                    root, python=sys.executable, max_restarts=0
                )
                self.addCleanup(adapter.close)
                with self.assertRaises(PerceptionError) as ctx:
                    adapter.perceive(ref, frame)
                self.assertEqual(ctx.exception.code, expected_code)

    def test_healing_unavailable_swallow_mismatch_and_no_fallback(self) -> None:
        ref, frame = _make_frame()

        # 1. Healing: vserve describe rc=4 (STALE_FRAME) + healthy fallback -> returns vision (oneshot).
        heal_root = _setup_fake_ve_root(
            self,
            vserve_mode={
                "describe_error_rc": 4,
                "describe_error_code": "E_STALE",
                "describe_error_detail": "stale on vserve",
            },
        )
        heal_adapter = VCorePerceptionAdapter(heal_root, python=sys.executable)
        self.addCleanup(heal_adapter.close)
        vision = heal_adapter.perceive(ref, frame)
        check_vision(vision, width=16, height=12)
        self.assertEqual(heal_adapter.last_transport, "oneshot")

        # 2. Unavailable-arm swallow: vserve STALE_FRAME + cu exit 5 (unavailable) ->
        # raises STALE_FRAME naming the persistent detail.
        swallow5_root = _setup_fake_ve_root(
            self,
            vserve_mode={
                "describe_error_rc": 4,
                "describe_error_code": "E_STALE",
                "describe_error_detail": "persistent stale detail",
            },
            cu_mode={"exit_rc": 5, "stderr": "cu gate unavailable"},
        )
        swallow5_adapter = VCorePerceptionAdapter(
            swallow5_root, python=sys.executable
        )
        self.addCleanup(swallow5_adapter.close)
        with self.assertRaises(PerceptionError) as sw_ctx:
            swallow5_adapter.perceive(ref, frame)
        self.assertEqual(sw_ctx.exception.code, "STALE_FRAME")
        self.assertIn("persistent stale detail", str(sw_ctx.exception))

        # 3. Fallback digest mismatch wins even when vserve had a typed STALE_FRAME error.
        fb_mm_root = _setup_fake_ve_root(
            self,
            vserve_mode={
                "describe_error_rc": 4,
                "describe_error_code": "E_STALE",
                "describe_error_detail": "stale before mismatch",
            },
            cu_mode={"override_sha256": "f" * 64},
        )
        fb_mm_adapter = VCorePerceptionAdapter(fb_mm_root, python=sys.executable)
        self.addCleanup(fb_mm_adapter.close)
        with self.assertRaises(PerceptionError) as mm_ctx:
            fb_mm_adapter.perceive(ref, frame)
        self.assertEqual(mm_ctx.exception.code, "identity_mismatch")

        # 4. fallback_oneshot=False + hard vserve failure raises unavailable without calling cu_describe.
        no_fb_root = _setup_fake_ve_root(
            self, vserve_mode={"crash_always_describe": True}
        )
        no_fb_adapter = VCorePerceptionAdapter(
            no_fb_root,
            python=sys.executable,
            max_restarts=0,
            fallback_oneshot=False,
        )
        self.addCleanup(no_fb_adapter.close)
        with self.assertRaises(PerceptionError) as no_fb_ctx:
            no_fb_adapter.perceive(ref, frame)
        self.assertEqual(no_fb_ctx.exception.code, "unavailable")
        self.assertFalse((no_fb_root / "cu_called.txt").exists())


class MutVServePinnedPythonBoundaryTests(unittest.TestCase):
    """Brief 5: Interpreter pinning boundary (MUT-VS-PIN-GT)."""

    def test_exact_2_0_0_boundary_catches_mut_vs_pin_gt(self) -> None:
        # MUT-VS-PIN-GT: `>= (2, 0, 0)` -> `> (2, 0, 0)` at vcore.py:739.
        root_200 = _setup_fake_ve_root(self, numpy_version="2.0.0")
        resolved = _resolve_pinned_python(
            sys.executable,
            ve_root=root_200,
            timeout=2.0,
            candidates=[sys.executable],
        )
        self.assertEqual(resolved, sys.executable)

        root_199 = _setup_fake_ve_root(self, numpy_version="1.99.9")
        with self.assertRaises(PerceptionError) as ctx:
            _resolve_pinned_python(
                sys.executable,
                ve_root=root_199,
                timeout=2.0,
                candidates=[sys.executable],
            )
        self.assertEqual(ctx.exception.code, "unavailable")

    def test_isolated_probe_skip_and_tab_candidate_and_pin_once_caching(self) -> None:
        root = _setup_fake_ve_root(self, numpy_version="2.4.2")

        # 1. MUT-VS-NONCANONICAL-PROBE: nonexistent candidates never reach probe.
        canonical = vcore._canonicalize_python_candidate(sys.executable)
        self.assertIsNotNone(canonical)
        calls: list[str] = []

        def fake_probe(argv, *, cwd, env, stdin, timeout):
            cand = argv[0]
            calls.append(cand)
            if cand == "/fake/iso-python":
                out = json.dumps({"version": "2.4.2", "isolated": True}).encode("utf-8")
            else:
                out = json.dumps({"version": "2.4.2", "isolated": False}).encode("utf-8")
            return subprocess.CompletedProcess(argv, 0, out, b"")

        with mock.patch.object(vcore, "_bounded_probe", side_effect=fake_probe):
            chosen = _resolve_pinned_python(
                "/fake/iso-python",
                ve_root=root,
                candidates=["/fake/iso-python", sys.executable],
            )
        self.assertEqual(chosen, canonical)
        self.assertEqual(calls, [canonical])

        # MUT-VS-ISOLATED-ACCEPT: retain the isolated-result rejection oracle
        # independently of filesystem candidate admission.
        calls.clear()
        with mock.patch.object(vcore, "_canonicalize_python_candidate", side_effect=lambda c: c), \
                mock.patch.object(vcore, "_bounded_probe", side_effect=fake_probe):
            isolated_chosen = _resolve_pinned_python(
                "/fake/iso-python", ve_root=root,
                candidates=["/fake/iso-python", sys.executable],
            )
        self.assertEqual(isolated_chosen, sys.executable)
        self.assertEqual(calls, ["/fake/iso-python", sys.executable])

        # 2. Tab-bearing candidate skipped without invoking subprocess probe.
        tab_calls: list[str] = []

        def fake_tab_probe(argv, *, cwd, env, stdin, timeout):
            tab_calls.append(argv[0])
            out = json.dumps({"version": "2.4.2", "isolated": False}).encode("utf-8")
            return subprocess.CompletedProcess(argv, 0, out, b"")

        with mock.patch.object(vcore, "_bounded_probe", side_effect=fake_tab_probe):
            chosen_tab = _resolve_pinned_python(
                "python3\t-I",
                ve_root=root,
                candidates=["python3\t-I", sys.executable],
            )
        self.assertEqual(chosen_tab, canonical)
        self.assertEqual(tab_calls, [canonical])

        # 3. Bare python3 is resolved before probing; no PATH lookup in child.
        def fail_bare_python3(argv, *, cwd, env, stdin, timeout):
            if argv[0] == "python3":
                return subprocess.CompletedProcess(argv, 1, b"", b"no numpy")
            out = json.dumps({"version": "2.0.0", "isolated": False}).encode("utf-8")
            return subprocess.CompletedProcess(argv, 0, out, b"")

        with mock.patch.object(vcore, "_bounded_probe", side_effect=fail_bare_python3):
            auto_chosen = _resolve_pinned_python("python3", ve_root=root)
        self.assertEqual(auto_chosen, vcore._canonicalize_python_candidate("python3"))

        # 4. pin_python=True resolves once at init and caches across two perceives.
        with mock.patch.object(
            vcore, "_resolve_pinned_python", wraps=_resolve_pinned_python
        ) as spy_resolve:
            adapter = VCorePerceptionAdapter(
                root,
                python=sys.executable,
                pin_python=True,
                fallback_oneshot=False,
            )
            self.addCleanup(adapter.close)
            self.assertEqual(adapter.python, sys.executable)
            self.assertEqual(spy_resolve.call_count, 1)
            ref, frame = _make_frame()
            adapter.perceive(ref, frame)
            adapter.perceive(ref, frame)
            self.assertEqual(spy_resolve.call_count, 1)


class MutVServeRawShmAndIdentityGateTests(unittest.TestCase):
    """Brief 6: Raw RGB handoff and identity gate (MUT-VS-PRECHECK)."""

    def test_frame_budget_enforced_pre_contact(self) -> None:
        # Patched tiny _VSERVE_MAX_FRAME_BYTES makes a normal Frame raise BUDGET_EXCEEDED with no vserve.pid.
        root = _setup_fake_ve_root(self)
        adapter = VCorePerceptionAdapter(
            root, python=sys.executable, fallback_oneshot=False
        )
        self.addCleanup(adapter.close)
        ref, frame = _make_frame(width=16, height=12)
        with mock.patch.object(vcore, "_VSERVE_MAX_FRAME_BYTES", 100):
            with self.assertRaises(PerceptionError) as ctx:
                adapter.perceive(ref, frame)
        self.assertEqual(ctx.exception.code, "BUDGET_EXCEEDED")
        self.assertFalse((root / "vserve.pid").exists())

    def test_procfd_refused_by_vserve_and_shm_path_and_ramws_and_marks_forwarded(self) -> None:
        ref, frame = _make_frame(width=16, height=12)
        png_data = vcore._png_bytes(frame)
        root = _setup_fake_ve_root(
            self,
            cu_mode={
                "procfd_sha256": str(ref["sha256"]),
                "procfd_width": 16,
                "procfd_height": 12,
            },
        )

        # 1. /proc/self/fd/N frame (and prev) is refused by vserve path (unavailable)
        # and falls back to oneshot cu_describe without spawning vserve.
        adapter_fd = VCorePerceptionAdapter(
            root, python=sys.executable, fallback_oneshot=True
        )
        self.addCleanup(adapter_fd.close)
        vision_fd = adapter_fd.perceive(ref, "/proc/self/fd/7")
        check_vision(vision_fd, width=16, height=12)
        self.assertEqual(adapter_fd.last_transport, "oneshot")
        self.assertTrue((root / "cu_called.txt").exists())
        self.assertFalse((root / "vserve.pid").exists())

        # Also check prev="/proc/self/fd/8" with Frame main is refused by vserve and falls back.
        (root / "cu_called.txt").unlink()
        vision_prev_fd = adapter_fd.perceive(
            ref, frame, prev="/proc/self/fd/8"
        )
        check_vision(vision_prev_fd, width=16, height=12)
        self.assertEqual(adapter_fd.last_transport, "oneshot")
        self.assertTrue((root / "cu_called.txt").exists())
        self.assertFalse((root / "vserve.pid").exists())

        # 2. Per-test isolated shm PNG path + marks_out + ocr_marks=True + frame=None (ramws) on vserve path.
        shm_dir = _setup_isolated_shm(self)
        marks_dir = shm_dir / "vqa-cu"
        marks_dir.mkdir(parents=True, exist_ok=True)
        marks_file = marks_dir / "mv-mut-marks.png"
        shm_png = shm_dir / "mv-mut-frame.png"
        shm_raw = shm_dir / "mv-mut-ramws.rgb"
        shm_png.write_bytes(png_data)
        shm_raw.write_bytes(frame.data)

        vserve_root = _setup_fake_ve_root(self)
        adapter_vs = VCorePerceptionAdapter(
            vserve_root,
            python=sys.executable,
            marks_out=marks_file,
            ocr_marks=True,
            fallback_oneshot=False,
        )
        self.addCleanup(adapter_vs.close)
        vision_path = adapter_vs.perceive(ref, shm_png, prev=shm_png)
        check_vision(vision_path, width=16, height=12)
        self.assertEqual(adapter_vs.last_transport, "vserve")
        last_req = json.loads(
            (vserve_root / "last_describe_req.json").read_text(encoding="utf-8")
        )
        # MUT-VS-CALLER-PATH: both inputs must be separate private snapshots,
        # cleaned after the roundtrip; forwarding the caller path fails here.
        for key in ("frame", "prev"):
            pinned = Path(last_req[key])
            self.assertEqual(pinned.parent, shm_dir)
            self.assertTrue(pinned.name.startswith("mv-vcore-frame-"))
            self.assertEqual(pinned.suffix, ".png")
            self.assertNotEqual(pinned, shm_png.resolve())
            self.assertFalse(pinned.exists())
        self.assertNotEqual(last_req["frame"], last_req["prev"])
        self.assertEqual(last_req["marks_out"], str(marks_file.resolve()))
        self.assertIs(last_req["ocr_marks"], True)

        # frame=None loads ramws_path and sends raw_shm to vserve.
        ref_ramws = dict(ref, ramws_path=str(shm_raw))
        vision_ramws = adapter_vs.perceive(ref_ramws, None)
        check_vision(vision_ramws, width=16, height=12)
        self.assertEqual(adapter_vs.last_transport, "vserve")

    def test_pixel_precheck_blocks_spawn_and_failure_shm_hygiene_catches_mut_vs_precheck(self) -> None:
        # 1. MUT-VS-PRECHECK: Frame whose sha256 disagrees with frame_ref raises identity_mismatch
        # BEFORE spawning vserve (no vserve.pid / vserve_boots.txt).
        shm_dir = _setup_isolated_shm(self)
        root = _setup_fake_ve_root(self)
        adapter = VCorePerceptionAdapter(
            root, python=sys.executable, fallback_oneshot=True
        )
        self.addCleanup(adapter.close)
        ref, _ = _make_frame(width=16, height=12, fill=0x10)
        _, bad_frame = _make_frame(width=16, height=12, fill=0x99)
        with self.assertRaises(PerceptionError) as ctx:
            adapter.perceive(ref, bad_frame)
        self.assertEqual(ctx.exception.code, "identity_mismatch")
        self.assertFalse((root / "vserve.pid").exists())
        self.assertFalse((root / "vserve_boots.txt").exists())
        self.assertFalse((root / "cu_called.txt").exists())
        self.assertEqual(list(shm_dir.glob("mv-vcore-raw-*.rgb")), [])

        # 2. Failure-path shm hygiene: forced describe error leaves zero raw shm files
        # created by this call in the per-test shm directory.
        # Also test that if _vserve_roundtrip fails after _write_raw_shm_frame
        # already allocated the raw shm files, the ExitStack still unlinks them.
        err_root = _setup_fake_ve_root(
            self,
            vserve_mode={
                "describe_error_rc": 4,
                "describe_error_code": "E_STALE",
                "describe_error_detail": "forced stale",
            },
        )
        err_adapter = VCorePerceptionAdapter(
            err_root, python=sys.executable, fallback_oneshot=False
        )
        self.addCleanup(err_adapter.close)
        good_ref, good_frame = _make_frame(width=16, height=12, fill=0x44)
        _, prev_frame = _make_frame(width=16, height=12, fill=0x22)
        created_raw: list[Path] = []
        real_mkstemp = tempfile.mkstemp

        def tracking_mkstemp(*args: object, **kwargs: object) -> tuple[int, str]:
            fd, path = real_mkstemp(*args, **kwargs)
            created_raw.append(Path(path))
            return fd, path

        with mock.patch.object(vcore.tempfile, "mkstemp", side_effect=tracking_mkstemp):
            with self.assertRaises(PerceptionError) as err_ctx:
                err_adapter.perceive(good_ref, good_frame, prev=prev_frame)
            self.assertEqual(err_ctx.exception.code, "STALE_FRAME")
            self.assertEqual(len(created_raw), 2)
            for raw_path in created_raw:
                self.assertEqual(raw_path.parent, shm_dir)
                self.assertFalse(raw_path.exists())
            self.assertEqual(list(shm_dir.glob("mv-vcore-raw-*.rgb")), [])

            # Verify ExitStack callback runs even when _vserve_roundtrip raises before returning.
            created_raw.clear()
            with mock.patch.object(
                err_adapter,
                "_vserve_roundtrip",
                side_effect=PerceptionError("STALE_FRAME", "abort before reply"),
            ):
                with self.assertRaises(PerceptionError):
                    err_adapter.perceive(good_ref, good_frame, prev=prev_frame)
            self.assertEqual(len(created_raw), 2)
            for raw_path in created_raw:
                self.assertEqual(raw_path.parent, shm_dir)
                self.assertFalse(raw_path.exists())
            self.assertEqual(list(shm_dir.glob("mv-vcore-raw-*.rgb")), [])


if __name__ == "__main__":
    unittest.main()
