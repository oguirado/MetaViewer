"""Unit tests for the perception base plugin and the vcore adapter.

Covers Frame validation, the Fake adapter, the provider registry, C2
subprocess mapping with RAM confinement, vcore exit-code mapping, and
the unknown-version negative control. Every behaviour pairs a positive
control with a negative control that must fail for the stated reason;
no test is skipped under any condition.
"""

import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from metaviewer_agents.observe import build_observation
from metaviewer_agents.perception.base import (
    FakePerceptionAdapter,
    Frame,
    PerceptionAdapter,
    PerceptionError,
    available_perception_adapters,
    check_vision,
    create_perception_adapter,
    register_perception_adapter,
)
from metaviewer_agents.perception.vcore import VCorePerceptionAdapter

_SHA = hashlib.sha256(bytes([7]) * (64 * 48 * 3)).hexdigest()
_CANARY = "VCORE-CANARY-7f3a91c2-never-inherit"


def _frame_ref(**overrides):
    frame = {
        "schema": "frame_ref/v0.1",
        "surface_id": "surface-demo",
        "generation": 1,
        "tick": 7,
        "ts_ns": 1000000,
        "width": 64,
        "height": 48,
        "format": "rgb24",
        "ramws_path": "/dev/shm/mv0vcore-test/frame.rgb",
        "sha256": _SHA,
        "capture_us": 120,
    }
    frame.update(overrides)
    return frame


def _frame(width=64, height=48, fill=7):
    return Frame(width=width, height=height,
                 data=bytes([fill]) * (width * height * 3))


def _region(x=1, y=2, w=8, h=6, score=0.9):
    return {"x": x, "y": y, "w": w, "h": h, "score": score}


def _crop(x=4, y=4, w=16, h=12, reason="changed"):
    return {"x": x, "y": y, "w": w, "h": h, "reason": reason}


def _mark(index, x=2, y=2, w=10, h=8, kind="button", score=0.8,
          **extra):
    mark = {"id": index, "x": x, "y": y, "w": w, "h": h,
            "kind": kind, "score": score}
    mark.update(extra)
    return mark


def _c2(**overrides):
    payload = {
        "schema": "ve.cu_describe/v1",
        "frame_sha256": _SHA,
        "width": 64,
        "height": 48,
        "changed": None,
        "changed_regions": [],
        "crops": [],
        "timing_us": 120,
    }
    payload.update(overrides)
    return payload


def _completed(returncode, payload=None, raw=None, stderr=b""):
    if raw is None:
        if payload is None:
            raw = b""
        else:
            raw = (json.dumps(payload, sort_keys=True,
                              separators=(",", ":")).encode("utf-8")
                   + b"\n")
    return subprocess.CompletedProcess(args=["engine"], returncode=returncode,
                                       stdout=raw, stderr=stderr)


def _tmpdir(case):
    base = "/dev/shm" if os.path.isdir("/dev/shm") else None
    root = tempfile.mkdtemp(prefix="mv0vcore-", dir=base)
    case.addCleanup(shutil.rmtree, root, True)
    return root


def _marks_out():
    return "/dev/shm/vqa-cu/mv0vcore-test-marks.png"


def _adapter(case, **kwargs):
    kwargs.setdefault("ve_root", _tmpdir(case))
    return VCorePerceptionAdapter(**kwargs)


@contextmanager
def _refuse_spawn():
    with mock.patch.object(subprocess, "run") as mocked:
        mocked.side_effect = AssertionError("must not spawn")
        yield mocked


class _CodeMixin:
    def assertCode(self, expected, func, *args, **kwargs):
        with self.assertRaises(PerceptionError) as ctx:
            func(*args, **kwargs)
        self.assertEqual(expected, ctx.exception.code)
        return ctx.exception


class FrameValidationTests(_CodeMixin, unittest.TestCase):
    def test_valid_frame_constructs(self):
        frame = Frame(width=4, height=2, data=b"\x00" * 24)
        self.assertEqual((frame.width, frame.height), (4, 2))
        self.assertEqual(len(frame.data), 24)

    def test_valid_single_pixel_constructs(self):
        frame = Frame(width=1, height=1, data=b"\x01\x02\x03")
        self.assertEqual(len(frame.data), 3)

    def test_rejects_nonpositive_dimensions(self):
        for width, height in ((0, 2), (4, 0), (-1, 2), (4, -3)):
            with self.subTest(width=width, height=height):
                self.assertCode(
                    "bad_shape", Frame, width=width, height=height,
                    data=b"\x00" * 24)

    def test_rejects_bool_dimensions(self):
        self.assertCode("bad_shape", Frame, width=True, height=2,
                        data=b"\x00" * 24)
        self.assertCode("bad_shape", Frame, width=4, height=False,
                        data=b"\x00" * 24)

    def test_rejects_non_integer_dimensions(self):
        for bad in ("4", 4.0, None, [4]):
            with self.subTest(bad=bad):
                self.assertCode("bad_shape", Frame, width=bad, height=2,
                                data=b"\x00" * 24)

    def test_rejects_non_bytes_data(self):
        for bad in (bytearray(24), "x" * 24, None, [0] * 24):
            with self.subTest(kind=type(bad).__name__):
                self.assertCode("bad_shape", Frame, width=4, height=2,
                                data=bad)

    def test_rejects_length_mismatch(self):
        for size in (0, 23, 25, 48):
            with self.subTest(size=size):
                self.assertCode("bad_shape", Frame, width=4, height=2,
                                data=b"\x00" * size)

    def test_frame_is_immutable(self):
        frame = Frame(width=4, height=2, data=b"\x00" * 24)
        with self.assertRaises(AttributeError):
            frame.width = 8  # type: ignore[misc]


class FakeAdapterTests(_CodeMixin, unittest.TestCase):
    def test_fake_returns_closed_vision(self):
        vision = FakePerceptionAdapter().perceive(_frame_ref())
        self.assertEqual({"summary", "changed_regions", "elements"},
                         set(vision))
        check_vision(vision, width=64, height=48)
        observation = build_observation(
            _frame_ref(), surface_id="surface-demo", generation=1,
            vision=vision)
        self.assertEqual("observation/v0.1", observation["schema"])

    def test_fake_accepts_frame_and_prev(self):
        vision = FakePerceptionAdapter().perceive(
            _frame_ref(), _frame(), prev=_frame(fill=9))
        check_vision(vision, width=64, height=48)

    def test_fake_rejects_bad_frame_ref(self):
        fake = FakePerceptionAdapter()
        self.assertCode("bad_shape", fake.perceive,
                        _frame_ref(width=True))
        self.assertCode("bad_shape", fake.perceive,
                        _frame_ref(height=0))
        ref = _frame_ref()
        del ref["width"]
        self.assertCode("bad_shape", fake.perceive, ref)

    def test_fake_rejects_mismatched_frame(self):
        self.assertCode("bad_shape", FakePerceptionAdapter().perceive,
                        _frame_ref(), _frame(width=8, height=8))

    def test_fake_rejects_bad_frame_type(self):
        self.assertCode("bad_shape", FakePerceptionAdapter().perceive,
                        _frame_ref(), 123)


class RegistryTests(_CodeMixin, unittest.TestCase):
    def test_available_lists_three_keys(self):
        self.assertEqual(("fake", "meta_muse", "vcore"),
                         available_perception_adapters())

    def test_create_fake(self):
        adapter = create_perception_adapter("fake")
        self.assertIsInstance(adapter, FakePerceptionAdapter)

    def test_create_vcore(self):
        adapter = create_perception_adapter("vcore",
                                            ve_root=_tmpdir(self))
        self.assertIsInstance(adapter, VCorePerceptionAdapter)

    def test_create_unknown_raises_unavailable(self):
        for name in ("nope", "", "fake2", "VCORE"):
            with self.subTest(name=name):
                self.assertCode("unavailable",
                                create_perception_adapter, name)

    def test_create_vcore_misconfigured_raises(self):
        with mock.patch.dict(os.environ):
            os.environ.pop("VQA_VE_ROOT", None)
            self.assertCode("unavailable",
                            create_perception_adapter, "vcore")

    def test_meta_muse_key_wired(self):
        from metaviewer_agents.perception.meta_muse import (
            MetaMusePerceptionAdapter,
        )
        adapter = create_perception_adapter(
            "meta_muse", transport=lambda request, credential: b"{}")
        self.assertIsInstance(adapter, MetaMusePerceptionAdapter)
        self.assertNotIsInstance(adapter, FakePerceptionAdapter)
        self.assertIsInstance(adapter, PerceptionAdapter)

    def test_meta_muse_misconfigured_no_fallback(self):
        with self.assertRaises(PerceptionError):
            create_perception_adapter("meta_muse", transport=None)

    def test_register_custom_provider(self):
        register_perception_adapter("test_dummy_provider",
                                    FakePerceptionAdapter)
        adapter = create_perception_adapter("test_dummy_provider")
        self.assertIsInstance(adapter, FakePerceptionAdapter)

    def test_register_rejects_bad_name_or_factory(self):
        self.assertCode("bad_shape", register_perception_adapter,
                        "", FakePerceptionAdapter)
        self.assertCode("bad_shape", register_perception_adapter,
                        "broken", "not-callable")


class VCoreConfigTests(_CodeMixin, unittest.TestCase):
    def test_missing_ve_root_refused(self):
        with mock.patch.dict(os.environ):
            os.environ.pop("VQA_VE_ROOT", None)
            self.assertCode("unavailable", VCorePerceptionAdapter)
            self.assertCode("unavailable", VCorePerceptionAdapter,
                            ve_root="")

    def test_nonexistent_ve_root_refused(self):
        missing = os.path.join(_tmpdir(self), "missing")
        self.assertCode("unavailable", VCorePerceptionAdapter,
                        ve_root=missing)

    def test_file_ve_root_refused(self):
        root = _tmpdir(self)
        candidate = os.path.join(root, "file.txt")
        Path(candidate).write_text("x", encoding="utf-8")
        self.assertCode("unavailable", VCorePerceptionAdapter,
                        ve_root=candidate)

    def test_ve_root_from_env(self):
        root = _tmpdir(self)
        with mock.patch.dict(os.environ, {"VQA_VE_ROOT": root}):
            adapter = VCorePerceptionAdapter()
        self.assertEqual(Path(root).resolve(), adapter.ve_root)

    def test_explicit_ve_root_wins_over_env(self):
        first = _tmpdir(self)
        second = _tmpdir(self)
        with mock.patch.dict(os.environ, {"VQA_VE_ROOT": second}):
            adapter = VCorePerceptionAdapter(ve_root=first)
        self.assertEqual(Path(first).resolve(), adapter.ve_root)

    def test_bad_timeout_rejected(self):
        root = _tmpdir(self)
        for bad in (0, -1, True, False, "2", None,
                    math.inf, -math.inf, math.nan):
            with self.subTest(bad=bad):
                self.assertCode("bad_shape", VCorePerceptionAdapter,
                                ve_root=root, timeout=bad)

    def test_good_timeout_accepted(self):
        root = _tmpdir(self)
        for good in (2, 0.5, 30):
            with self.subTest(good=good):
                adapter = VCorePerceptionAdapter(ve_root=root,
                                                 timeout=good)
                self.assertEqual(good, adapter.timeout)

    def test_bad_python_rejected(self):
        root = _tmpdir(self)
        for bad in ("", None, 123):
            with self.subTest(bad=bad):
                self.assertCode("bad_shape", VCorePerceptionAdapter,
                                ve_root=root, python=bad)

    def test_ocr_without_marks_out_rejected(self):
        self.assertCode("bad_shape", VCorePerceptionAdapter,
                        ve_root=_tmpdir(self), ocr_marks=True)

    def test_ocr_marks_must_be_bool(self):
        for bad in ("yes", 1, None):
            with self.subTest(bad=bad):
                self.assertCode("bad_shape", VCorePerceptionAdapter,
                                ve_root=_tmpdir(self), ocr_marks=bad)

    def test_marks_out_outside_ram_rejected(self):
        root = _tmpdir(self)
        for bad in ("/tmp/x.png", "/home/u/x.png",
                    "/dev/shm/other.png", "/dev/shm/vqa-cu-evil/x.png"):
            with self.subTest(bad=bad):
                self.assertCode("bad_shape", VCorePerceptionAdapter,
                                ve_root=root, marks_out=bad)

    def test_marks_out_must_be_path(self):
        root = _tmpdir(self)
        for bad in (123, b"x", "", None.__class__):
            with self.subTest(bad=bad):
                self.assertCode("bad_shape", VCorePerceptionAdapter,
                                ve_root=root, marks_out=bad)

    def test_marks_out_under_vqa_cu_ok(self):
        adapter = VCorePerceptionAdapter(ve_root=_tmpdir(self),
                                         marks_out=_marks_out())
        self.assertEqual(Path(_marks_out()), adapter.marks_out)
        adapter = VCorePerceptionAdapter(
            ve_root=_tmpdir(self), marks_out=Path(_marks_out()),
            ocr_marks=True)
        self.assertTrue(adapter.ocr_marks)

    def test_initial_last_flags(self):
        adapter = _adapter(self)
        self.assertFalse(adapter.last_mark_cap_reached)
        self.assertIsNone(adapter.last_timing_us)


class PerceiveValidationTests(_CodeMixin, unittest.TestCase):
    def test_frame_ref_schema_v99_unknown_version(self):
        adapter = _adapter(self)
        with _refuse_spawn():
            self.assertCode(
                "unknown_version", adapter.perceive,
                _frame_ref(schema="frame_ref/v9.9"), _frame())

    def test_frame_ref_schema_malformed(self):
        adapter = _adapter(self)
        for bad in ("", 123, None):
            with self.subTest(bad=bad):
                with _refuse_spawn():
                    self.assertCode(
                        "bad_shape", adapter.perceive,
                        _frame_ref(schema=bad), _frame())

    def test_frame_ref_v02_schema_accepted_at_binding(self):
        adapter = _adapter(self)
        ref = _frame_ref(schema="frame_ref/v0.2")
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, _c2())):
            vision = adapter.perceive(ref, _frame())
        check_vision(vision, width=64, height=48)

    def test_frame_ref_not_object(self):
        adapter = _adapter(self)
        for bad in ("x", None, [], 5):
            with self.subTest(bad=bad):
                with _refuse_spawn():
                    self.assertCode("bad_shape", adapter.perceive,
                                    bad, _frame())

    def test_frame_ref_dims_malformed(self):
        adapter = _adapter(self)
        cases = ({"width": True}, {"width": 0}, {"height": -1},
                 {"width": "64"}, {"height": None})
        for kwargs in cases:
            with self.subTest(kwargs=kwargs):
                with _refuse_spawn():
                    self.assertCode("bad_shape", adapter.perceive,
                                    _frame_ref(**kwargs), _frame())
        ref = _frame_ref()
        del ref["height"]
        with _refuse_spawn():
            self.assertCode("bad_shape", adapter.perceive, ref,
                            _frame())

    def test_frame_dims_disagree_with_ref(self):
        adapter = _adapter(self)
        with _refuse_spawn():
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame(width=8, height=8))

    def test_prev_dims_disagree(self):
        adapter = _adapter(self)
        with _refuse_spawn():
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame(),
                            prev=_frame(width=8, height=8))

    def test_frame_bytes_rejected(self):
        adapter = _adapter(self)
        with _refuse_spawn():
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), b"rgb")

    def test_frame_int_rejected(self):
        adapter = _adapter(self)
        with _refuse_spawn():
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), 5)

    def test_frame_empty_str_rejected(self):
        adapter = _adapter(self)
        with _refuse_spawn():
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), "")

    def test_frame_path_outside_shm_refused(self):
        adapter = _adapter(self)
        for bad in ("/tmp/f.png", "/home/u/f.png", "/etc/hosts"):
            with self.subTest(bad=bad):
                with _refuse_spawn():
                    self.assertCode("bad_shape", adapter.perceive,
                                    _frame_ref(), bad)

    def test_prev_path_outside_shm_refused(self):
        adapter = _adapter(self)
        with _refuse_spawn():
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame(), prev="/tmp/p.png")

    def test_malformed_fd_path_refused(self):
        adapter = _adapter(self)
        for bad in ("/proc/self/fd/abc", "/proc/self/fd/"):
            with self.subTest(bad=bad):
                with _refuse_spawn():
                    self.assertCode("bad_shape", adapter.perceive,
                                    _frame_ref(), bad)

    def test_frame_none_ramws_outside_shm(self):
        adapter = _adapter(self)
        ref = _frame_ref(ramws_path="/tmp/x.rgb")
        with _refuse_spawn():
            self.assertCode("bad_shape", adapter.perceive, ref, None)

    def test_frame_none_ramws_missing_file(self):
        adapter = _adapter(self)
        missing = "/dev/shm/mv0vcore-absent-%d.rgb" % os.getpid()
        if os.path.exists(missing):
            os.unlink(missing)
        ref = _frame_ref(ramws_path=missing)
        with _refuse_spawn():
            self.assertCode("unavailable", adapter.perceive, ref,
                            None)

    def test_frame_none_ramws_bad_length(self):
        root = _tmpdir(self)
        candidate = os.path.join(root, "frame.rgb")
        Path(candidate).write_bytes(b"\x00" * 10)
        adapter = _adapter(self)
        ref = _frame_ref(ramws_path=candidate)
        with _refuse_spawn():
            self.assertCode("bad_shape", adapter.perceive, ref, None)


class C2MappingTests(_CodeMixin, unittest.TestCase):
    def test_ok_empty_vision(self):
        adapter = _adapter(self)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, _c2())) as run:
            vision = adapter.perceive(_frame_ref(), _frame())
        self.assertEqual({"summary", "changed_regions", "elements"},
                         set(vision))
        self.assertEqual([], vision["changed_regions"])
        self.assertEqual([], vision["elements"])
        self.assertIn("ve.cu_describe/v1", vision["summary"])
        self.assertFalse(adapter.last_mark_cap_reached)
        self.assertEqual(120, adapter.last_timing_us)
        check_vision(vision, width=64, height=48)
        observation = build_observation(
            _frame_ref(), surface_id="surface-demo", generation=1,
            vision=vision)
        self.assertIn("vision", observation)
        run.assert_called_once()
        command = run.call_args.args[0]
        self.assertEqual("vadapt.cu_describe", command[2])
        self.assertEqual("--json", command[-1])

    def test_frame_path_under_shm_ok(self):
        adapter = _adapter(self)
        path = "/dev/shm/mv0vcore-test/fake.png"
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, _c2())) as run:
            vision = adapter.perceive(_frame_ref(), path)
        check_vision(vision, width=64, height=48)
        self.assertIn(path, run.call_args.args[0])

    def test_proc_fd_frame_ok(self):
        adapter = _adapter(self)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, _c2())) as run:
            adapter.perceive(_frame_ref(), "/proc/self/fd/7")
        self.assertIn("/proc/self/fd/7", run.call_args.args[0])

    def test_frame_uses_memfd_and_closes_it(self):
        adapter = _adapter(self)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, _c2())) as run:
            adapter.perceive(_frame_ref(), _frame())
        command = run.call_args.args[0]
        fd_arg = command[command.index("--frame") + 1]
        self.assertTrue(fd_arg.startswith("/proc/self/fd/"))
        fd = int(fd_arg[len("/proc/self/fd/"):])
        with self.assertRaises(OSError):
            os.fstat(fd)

    def test_memfd_failure_unavailable(self):
        adapter = _adapter(self)
        with mock.patch.object(os, "memfd_create",
                               side_effect=OSError("no memfd")):
            with _refuse_spawn():
                self.assertCode("unavailable", adapter.perceive,
                                _frame_ref(), _frame())

    def test_prev_adds_prev_flag(self):
        adapter = _adapter(self)
        payload = _c2(changed=True, changed_regions=[_region()])
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)) as run:
            vision = adapter.perceive(_frame_ref(), _frame(),
                                      prev=_frame(fill=9))
        self.assertEqual([{"x": 1, "y": 2, "w": 8, "h": 6}],
                         vision["changed_regions"])
        command = run.call_args.args[0]
        self.assertIn("--prev", command)

    def test_regions_drop_score_and_keep_order(self):
        adapter = _adapter(self)
        payload = _c2(changed=True, changed_regions=[
            _region(x=0, y=0, score=0.95), _region(x=8, y=8, score=0.9)])
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            vision = adapter.perceive(_frame_ref(), _frame(),
                                      prev=_frame())
        self.assertEqual(
            [{"x": 0, "y": 0, "w": 8, "h": 6},
             {"x": 8, "y": 8, "w": 8, "h": 6}],
            vision["changed_regions"])

    def test_marks_become_elements(self):
        adapter = _adapter(self, marks_out=_marks_out())
        payload = _c2(
            changed_regions=[_region()], crops=[_crop()],
            marks=[_mark(1), _mark(2, x=20, kind="field", score=0.6,
                                   ocr_text="Go")],
            marks_png=_marks_out())
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)) as run:
            vision = adapter.perceive(_frame_ref(), _frame())
        self.assertIn("--marks-out", run.call_args.args[0])
        self.assertEqual(
            [{"bbox": {"x": 2, "y": 2, "w": 10, "h": 8},
              "role": "button", "name": "mark-1", "confidence": 0.8},
             {"bbox": {"x": 20, "y": 2, "w": 10, "h": 8},
              "role": "field", "name": "Go", "confidence": 0.6}],
            vision["elements"])
        check_vision(vision, width=64, height=48)

    def test_crops_fallback_without_marks(self):
        adapter = _adapter(self)
        payload = _c2(crops=[_crop(), _crop(x=30, reason="salient")])
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            vision = adapter.perceive(_frame_ref(), _frame())
        self.assertEqual(
            [{"bbox": {"x": 4, "y": 4, "w": 16, "h": 12},
              "role": "crop", "name": "changed", "confidence": 0.5},
             {"bbox": {"x": 30, "y": 4, "w": 16, "h": 12},
              "role": "crop", "name": "salient", "confidence": 0.5}],
            vision["elements"])

    def test_24_marks_set_cap_flag(self):
        adapter = _adapter(self, marks_out=_marks_out())
        marks = [_mark(i + 1, x=(i % 8) * 8, y=(i // 8) * 8, w=8, h=8)
                 for i in range(24)]
        payload = _c2(marks=marks, marks_png=_marks_out())
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            vision = adapter.perceive(_frame_ref(), _frame())
        self.assertEqual(24, len(vision["elements"]))
        self.assertTrue(adapter.last_mark_cap_reached)
        check_vision(vision, width=64, height=48)

    def test_fewer_marks_clear_cap_flag(self):
        adapter = _adapter(self, marks_out=_marks_out())
        payload = _c2(marks=[_mark(1), _mark(2, x=20), _mark(3, x=40)],
                      marks_png=_marks_out())
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            adapter.perceive(_frame_ref(), _frame())
        self.assertFalse(adapter.last_mark_cap_reached)

    def test_payload_cap_flag_honored(self):
        adapter = _adapter(self, marks_out=_marks_out())
        payload = _c2(marks=[_mark(1)], marks_png=_marks_out(),
                      mark_cap_reached=True)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            adapter.perceive(_frame_ref(), _frame())
        self.assertTrue(adapter.last_mark_cap_reached)

    def test_payload_cap_flag_must_be_bool(self):
        adapter = _adapter(self, marks_out=_marks_out())
        payload = _c2(marks=[_mark(1)], marks_png=_marks_out(),
                      mark_cap_reached="yes")
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame())

    def test_unknown_c2_version(self):
        adapter = _adapter(self)
        payload = _c2(schema="ve.cu_describe/v9.9")
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            self.assertCode("unknown_version", adapter.perceive,
                            _frame_ref(), _frame())

    def test_missing_schema_bad_shape(self):
        adapter = _adapter(self)
        payload = _c2()
        del payload["schema"]
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame())

    def test_schema_nonstring_bad_shape(self):
        adapter = _adapter(self)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(
                                   0, _c2(schema=5))):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame())

    def test_invalid_json_bad_shape(self):
        adapter = _adapter(self)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, raw=b"not json")):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame())

    def test_empty_stdout_bad_shape(self):
        adapter = _adapter(self)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, raw=b"")):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame())

    def test_non_object_json_bad_shape(self):
        adapter = _adapter(self)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, raw=b"[1, 2]")):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame())

    def test_exit_2_refused(self):
        adapter = _adapter(self)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(
                                   2, stderr=b"bad png")):
            exc = self.assertCode("bad_shape", adapter.perceive,
                                  _frame_ref(), _frame())
        self.assertIn("bad png", str(exc))

    def test_exit_2_stderr_truncated(self):
        adapter = _adapter(self)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(
                                   2, stderr=b"x" * 5000)):
            exc = self.assertCode("bad_shape", adapter.perceive,
                                  _frame_ref(), _frame())
        self.assertLessEqual(len(str(exc)), 1100)

    def test_unexpected_exits_bad_shape(self):
        adapter = _adapter(self)
        for code in (1, 3, 4, 5, 6, 9):
            with self.subTest(code=code):
                with mock.patch.object(subprocess, "run",
                                       return_value=_completed(code)):
                    self.assertCode("bad_shape", adapter.perceive,
                                    _frame_ref(), _frame())

    def test_timeout_maps(self):
        adapter = _adapter(self)
        with mock.patch.object(
                subprocess, "run",
                side_effect=subprocess.TimeoutExpired("c2", 2.0)):
            self.assertCode("timeout", adapter.perceive,
                            _frame_ref(), _frame())

    def test_oserror_maps_unavailable(self):
        adapter = _adapter(self)
        with mock.patch.object(subprocess, "run",
                               side_effect=OSError("noexec")):
            self.assertCode("unavailable", adapter.perceive,
                            _frame_ref(), _frame())

    def test_payload_dims_disagree(self):
        adapter = _adapter(self)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(
                                   0, _c2(width=32))):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame())

    def test_payload_dims_must_be_int(self):
        adapter = _adapter(self)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(
                                   0, _c2(width=True))):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame())

    def test_changed_true_without_prev(self):
        adapter = _adapter(self)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(
                                   0, _c2(changed=True))):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame())

    def test_changed_none_with_prev(self):
        adapter = _adapter(self)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, _c2())):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame(), prev=_frame())

    def test_changed_nonbool(self):
        adapter = _adapter(self)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(
                                   0, _c2(changed="yes"))):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame())

    def test_region_out_of_bounds(self):
        adapter = _adapter(self)
        for region in (_region(x=60, w=8), _region(y=46, h=8),
                       _region(x=64, w=1)):
            with self.subTest(region=region):
                payload = _c2(changed=True, changed_regions=[region])
                with mock.patch.object(subprocess, "run",
                                       return_value=_completed(0, payload)):
                    self.assertCode("bad_shape", adapter.perceive,
                                    _frame_ref(), _frame(),
                                    prev=_frame())

    def test_region_bad_score(self):
        adapter = _adapter(self)
        for bad in (1.5, -0.1, True, "x", None, math.nan,
                    math.inf):
            with self.subTest(bad=bad):
                payload = _c2(changed=True,
                              changed_regions=[_region(score=bad)])
                with mock.patch.object(subprocess, "run",
                                       return_value=_completed(0, payload)):
                    self.assertCode("bad_shape", adapter.perceive,
                                    _frame_ref(), _frame(),
                                    prev=_frame())

    def test_regions_out_of_order(self):
        adapter = _adapter(self)
        payload = _c2(changed=True, changed_regions=[
            _region(score=0.5), _region(x=8, score=0.9)])
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame(), prev=_frame())

    def test_region_missing_coordinate(self):
        adapter = _adapter(self)
        region = _region()
        del region["h"]
        payload = _c2(changed=True, changed_regions=[region])
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame(), prev=_frame())

    def test_too_many_regions(self):
        adapter = _adapter(self)
        regions = [_region(x=(i % 8) * 8, y=(i // 8) * 6, w=4, h=4,
                           score=0.9 - i * 0.01)
                   for i in range(17)]
        payload = _c2(changed=True, changed_regions=regions)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame(), prev=_frame())

    def test_too_many_crops(self):
        adapter = _adapter(self)
        crops = [_crop(x=(i % 4) * 16, y=(i // 4) * 12, w=8, h=8)
                 for i in range(9)]
        payload = _c2(crops=crops)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame())

    def test_too_many_marks(self):
        adapter = _adapter(self, marks_out=_marks_out())
        marks = [_mark(i + 1, x=(i % 8) * 8, y=(i // 8) * 4, w=4, h=4)
                 for i in range(25)]
        payload = _c2(marks=marks, marks_png=_marks_out())
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame())

    def test_bad_digest(self):
        adapter = _adapter(self)
        for bad in ("short", "AB" * 32, 123, None, "ab" * 31 + "ag"):
            with self.subTest(bad=bad):
                payload = _c2(frame_sha256=bad)
                with mock.patch.object(subprocess, "run",
                                       return_value=_completed(0, payload)):
                    self.assertCode("bad_shape", adapter.perceive,
                                    _frame_ref(), _frame())

    def test_bad_timing(self):
        adapter = _adapter(self)
        for bad in (-1, True, "120", None):
            with self.subTest(bad=bad):
                payload = _c2(timing_us=bad)
                with mock.patch.object(subprocess, "run",
                                       return_value=_completed(0, payload)):
                    self.assertCode("bad_shape", adapter.perceive,
                                    _frame_ref(), _frame())

    def _marks_case(self, marks, **kwargs):
        kwargs.setdefault("marks_png", _marks_out())
        return _c2(marks=marks, **kwargs)

    def test_mark_bad_kind(self):
        adapter = _adapter(self, marks_out=_marks_out())
        payload = self._marks_case([_mark(1, kind="spaceship")])
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame())

    def test_mark_nonsequential_id(self):
        adapter = _adapter(self, marks_out=_marks_out())
        for ids in ([1, 3], [2], ["1"], [1, 1]):
            with self.subTest(ids=ids):
                marks = [_mark(i, x=(k % 6) * 10)
                         for k, i in enumerate(ids)]
                payload = self._marks_case(marks)
                with mock.patch.object(subprocess, "run",
                                       return_value=_completed(0, payload)):
                    self.assertCode("bad_shape", adapter.perceive,
                                    _frame_ref(), _frame())

    def test_mark_out_of_bounds(self):
        adapter = _adapter(self, marks_out=_marks_out())
        payload = self._marks_case([_mark(1, x=60, w=8)])
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame())

    def test_mark_bad_score(self):
        adapter = _adapter(self, marks_out=_marks_out())
        payload = self._marks_case([_mark(1, score=2.0)])
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame())

    def test_mark_bad_ocr_text(self):
        adapter = _adapter(self, marks_out=_marks_out())
        for bad in ("", 123, "x" * 65):
            with self.subTest(bad=bad):
                payload = self._marks_case(
                    [_mark(1, ocr_text=bad)])
                with mock.patch.object(subprocess, "run",
                                       return_value=_completed(0, payload)):
                    self.assertCode("bad_shape", adapter.perceive,
                                    _frame_ref(), _frame())

    def test_crop_bad_reason(self):
        adapter = _adapter(self)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(
                                   0, _c2(crops=[_crop(reason="weird")]))):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame())

    def test_crop_out_of_bounds(self):
        adapter = _adapter(self)
        payload = _c2(crops=[_crop(x=60, w=8)])
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame())

    def test_marks_png_disagrees_with_flag(self):
        adapter = _adapter(self, marks_out=_marks_out())
        other = "/dev/shm/vqa-cu/other-marks.png"
        payload = _c2(marks=[_mark(1)], marks_png=other)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame())

    def test_marks_png_outside_ram(self):
        adapter = _adapter(self)
        payload = _c2(marks=[_mark(1)], marks_png="/tmp/m.png")
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame())

    def test_marks_without_png(self):
        adapter = _adapter(self)
        payload = _c2(marks=[_mark(1)])
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            self.assertCode("bad_shape", adapter.perceive,
                            _frame_ref(), _frame())

    def test_env_scrubbed_and_cwd(self):
        adapter = _adapter(self)
        with mock.patch.dict(os.environ,
                             {_CANARY: "canary-value",
                              "VQA_VE_ROOT": str(adapter.ve_root)}):
            with mock.patch.object(subprocess, "run",
                                   return_value=_completed(
                                       0, _c2())) as run:
                adapter.perceive(_frame_ref(), _frame())
        env = run.call_args.kwargs["env"]
        self.assertNotIn(_CANARY, env)
        self.assertNotIn("VQA_VE_ROOT", env)
        self.assertLessEqual(set(env), {"PATH", "HOME", "LANG",
                                        "PYTHONPATH"})
        self.assertEqual(str(adapter.ve_root), env["PYTHONPATH"])
        self.assertEqual(str(adapter.ve_root),
                         run.call_args.kwargs["cwd"])

    def test_frame_none_reads_ramws(self):
        root = tempfile.mkdtemp(prefix="mv0vcore-ramws-", dir="/dev/shm")
        self.addCleanup(shutil.rmtree, root, True)
        candidate = os.path.join(root, "frame.rgb")
        Path(candidate).write_bytes(bytes([7]) * (64 * 48 * 3))
        adapter = _adapter(self)
        ref = _frame_ref(ramws_path=candidate)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(
                                   0, _c2())) as run:
            vision = adapter.perceive(ref, None)
        check_vision(vision, width=64, height=48)
        command = run.call_args.args[0]
        fd_arg = command[command.index("--frame") + 1]
        self.assertTrue(fd_arg.startswith("/proc/self/fd/"))


class VCoreCliTests(_CodeMixin, unittest.TestCase):
    def test_unknown_verb_refused(self):
        adapter = _adapter(self)
        for bad in ("frobnicate", "", None, "ANALYZE"):
            with self.subTest(bad=bad):
                with _refuse_spawn():
                    self.assertCode("bad_shape", adapter.run_vcore,
                                    bad)

    def test_args_must_be_sequence(self):
        adapter = _adapter(self)
        for bad in ("--out", 5, {"a": 1}):
            with self.subTest(bad=bad):
                with _refuse_spawn():
                    self.assertCode("bad_shape", adapter.run_vcore,
                                    "selftest", bad)

    def test_args_must_be_strings(self):
        adapter = _adapter(self)
        with _refuse_spawn():
            self.assertCode("bad_shape", adapter.run_vcore,
                            "selftest", ["--out", 5])

    def test_ok_result_obj_passthrough(self):
        adapter = _adapter(self)
        payload = {"code": "OK", "rc": 0,
                   "detail": {"n_frames": 1}}
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)) as run:
            result = adapter.run_vcore("analyze", ["manifest.json"])
        self.assertEqual(payload, result)
        command = run.call_args.args[0]
        self.assertEqual(["python3", "-m", "visioncore.cli", "analyze",
                          "manifest.json"], command)

    def test_ok_vqa_schema_passthrough(self):
        adapter = _adapter(self)
        payload = {"schema": "vqa.vision/v1", "params_sha256": "x"}
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            self.assertEqual(payload,
                             adapter.run_vcore("analyze"))

    def test_all_verbs_accepted(self):
        adapter = _adapter(self)
        for verb in ("selftest", "analyze", "pack", "cite-check",
                     "verify-citations", "rejudge"):
            with self.subTest(verb=verb):
                with mock.patch.object(subprocess, "run",
                                       return_value=_completed(0, {})):
                    self.assertEqual({}, adapter.run_vcore(verb))

    def test_unknown_vqa_version(self):
        adapter = _adapter(self)
        payload = {"schema": "vqa.analyze/v9.9"}
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            self.assertCode("unknown_version", adapter.run_vcore,
                            "analyze")

    def test_vqa_schema_nonstring(self):
        adapter = _adapter(self)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(
                                   0, {"schema": 3})):
            self.assertCode("bad_shape", adapter.run_vcore,
                            "analyze")

    def test_rc_disagrees(self):
        adapter = _adapter(self)
        payload = {"code": "OK", "rc": 3, "detail": {}}
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, payload)):
            self.assertCode("bad_shape", adapter.run_vcore,
                            "analyze")

    def test_rc_mapping(self):
        adapter = _adapter(self)
        cases = ((2, "bad_shape"), (3, "bad_shape"),
                 (4, "STALE_FRAME"), (5, "unavailable"),
                 (6, "BUDGET_EXCEEDED"), (1, "bad_shape"),
                 (7, "bad_shape"))
        for code, expected in cases:
            with self.subTest(code=code):
                with mock.patch.object(
                        subprocess, "run",
                        return_value=_completed(code, stderr=b"boom")):
                    self.assertCode(expected, adapter.run_vcore,
                                    "analyze")

    def test_timeout_maps(self):
        adapter = _adapter(self)
        with mock.patch.object(
                subprocess, "run",
                side_effect=subprocess.TimeoutExpired("vcore", 2.0)):
            self.assertCode("timeout", adapter.run_vcore, "selftest")

    def test_oserror_maps_unavailable(self):
        adapter = _adapter(self)
        with mock.patch.object(subprocess, "run",
                               side_effect=OSError("noexec")):
            self.assertCode("unavailable", adapter.run_vcore,
                            "selftest")

    def test_invalid_json_rc0(self):
        adapter = _adapter(self)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, raw=b"oops")):
            self.assertCode("bad_shape", adapter.run_vcore,
                            "selftest")

    def test_non_object_json_rc0(self):
        adapter = _adapter(self)
        with mock.patch.object(subprocess, "run",
                               return_value=_completed(0, raw=b"[1]")):
            self.assertCode("bad_shape", adapter.run_vcore,
                            "selftest")

    def test_env_scrubbed_and_cwd(self):
        adapter = _adapter(self)
        with mock.patch.dict(os.environ, {_CANARY: "canary-value"}):
            with mock.patch.object(subprocess, "run",
                                   return_value=_completed(
                                       0, {"code": "OK", "rc": 0,
                                           "detail": {}})) as run:
                adapter.run_vcore("selftest")
        env = run.call_args.kwargs["env"]
        self.assertNotIn(_CANARY, env)
        self.assertEqual(str(adapter.ve_root), env["PYTHONPATH"])
        self.assertEqual(str(adapter.ve_root),
                         run.call_args.kwargs["cwd"])


if __name__ == "__main__":
    unittest.main()
