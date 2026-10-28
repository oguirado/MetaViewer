"""Unit tests for the Muse Spark perception adapter.

Covers the injected-transport protocol, runtime-only credential
hygiene, wire bounds, closed vision mapping, and unknown-version
refusals. Every behaviour pairs a positive control with a negative
control that must fail for the stated reason; no test is skipped
under any condition. The SECRET canary below is a fake fixture
value, never a real credential.
"""

import contextlib
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parent.parent))

from metaviewer_agents.observe import (
    _check_vision,
    build_observation,
)
from metaviewer_agents.perception.base import (
    Frame,
    PerceptionError,
)
from metaviewer_agents.perception.meta_muse import (
    MetaMusePerceptionAdapter,
)

SECRET = "muse-secret-canary-98765"
CREDENTIAL = SECRET.encode("utf-8")
RESPONSE_SCHEMA = "muse.vision/v1"
REQUEST_SCHEMA = "muse.vision.request/v1"
_PIXELS = b"\x00" * (800 * 600 * 3)
_SHA = hashlib.sha256(_PIXELS).hexdigest()
_DEFAULT_RAMWS_PATH = "/dev/shm/ramws/demo.rgb"


def _frame_ref(**overrides):
    frame = {
        "schema": "frame_ref/v0.1",
        "surface_id": "surface-demo",
        "generation": 1,
        "tick": 7,
        "ts_ns": 1000000,
        "width": 800,
        "height": 600,
        "format": "rgb24",
        "ramws_path": _DEFAULT_RAMWS_PATH,
        "sha256": _SHA,
        "capture_us": 120,
    }
    frame.update(overrides)
    return frame


def _element(**overrides):
    element = {
        "bbox": {"x": 10, "y": 20, "w": 80, "h": 30},
        "role": "button",
        "name": "Ready",
        "confidence": 0.95,
    }
    element.update(overrides)
    return element


def _vision(**overrides):
    vision = {
        "summary": "Ready button visible",
        "changed_regions": [{"x": 0, "y": 0, "w": 800, "h": 600}],
        "elements": [_element()],
    }
    vision.update(overrides)
    return vision


def _response(vision=None, **overrides):
    payload = {
        "schema": RESPONSE_SCHEMA,
        "vision": _vision() if vision is None else vision,
    }
    payload.update(overrides)
    return payload


def _raw(payload):
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


class _Recorder:
    """Injectable transport double recording every call."""

    def __init__(self, payload=_response(), error=None):
        self.calls = []
        self._payload = payload
        self._error = error

    def __call__(self, request, credential):
        self.calls.append((request, credential))
        if self._error is not None:
            raise self._error
        return self._payload


class MetaMusePerceptionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        global _DEFAULT_RAMWS_PATH
        cls._shm = tempfile.TemporaryDirectory(prefix="mv-muse-", dir="/dev/shm")
        cls.addClassCleanup(cls._shm.cleanup)
        demo_path = Path(cls._shm.name) / "demo.rgb"
        demo_path.write_bytes(_PIXELS)
        _DEFAULT_RAMWS_PATH = str(demo_path)

    def assertCode(self, code, call, *args, **kwargs):
        with self.assertRaises(PerceptionError) as caught:
            call(*args, **kwargs)
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def assertNoCanary(self, *values):
        for value in values:
            self.assertNotIn(SECRET, str(value))

    def make(self, transport=None, **kwargs):
        if transport is None:
            transport = _Recorder(_raw(_response()))
        kwargs.setdefault("credential", CREDENTIAL)
        return MetaMusePerceptionAdapter(transport=transport, **kwargs)

    def test_valid_perception_returns_closed_vision(self):
        transport = _Recorder(_raw(_response()))
        adapter = self.make(transport)
        frame_ref = _frame_ref()
        vision = adapter.perceive(frame_ref)
        self.assertEqual(vision, _vision())
        _check_vision(vision, width=800, height=600)
        build_observation(frame_ref, surface_id="surface-demo",
                          generation=1, vision=vision)
        self.assertEqual(len(transport.calls), 1)
        request, credential = transport.calls[0]
        self.assertEqual(request["schema"], REQUEST_SCHEMA)
        self.assertEqual(set(request),
                         {"schema", "frame_ref", "frame", "prev"})
        self.assertEqual(request["frame_ref"], frame_ref)
        self.assertIsNot(request["frame_ref"], frame_ref)
        self.assertIsNone(request["frame"])
        self.assertIsNone(request["prev"])
        self.assertEqual(credential, CREDENTIAL)
        self.assertIs(type(credential), bytes)

    def test_frame_ref_v02_accepted(self):
        adapter = self.make()
        vision = adapter.perceive(_frame_ref(schema="frame_ref/v0.2"))
        self.assertEqual(vision, _vision())

    def test_frame_ref_extra_keys_ignored(self):
        # Only schema generation and dimensions bind the adapter;
        # full frame binding stays with the core observation check.
        adapter = self.make()
        vision = adapter.perceive(_frame_ref(debug_probe=True))
        self.assertEqual(vision, _vision())

    def test_missing_credential_refuses_before_transport(self):
        calls = []

        def boom(request, credential):
            calls.append((request, credential))
            raise AssertionError("transport must not run")

        adapter = MetaMusePerceptionAdapter(transport=boom,
                                           credential=None)
        self.assertCode("unavailable", adapter.perceive, _frame_ref())
        self.assertEqual(calls, [])

    def test_constructor_rejects_bad_arguments(self):
        transport = _Recorder(b"{}")
        self.assertCode("bad_shape", MetaMusePerceptionAdapter,
                        transport=None, credential=CREDENTIAL)
        self.assertCode("bad_shape", MetaMusePerceptionAdapter,
                        transport="x", credential=CREDENTIAL)
        self.assertCode("bad_shape", MetaMusePerceptionAdapter,
                        transport=transport, credential=SECRET)
        self.assertCode("bad_shape", MetaMusePerceptionAdapter,
                        transport=transport, credential=b"")
        self.assertCode("bad_shape", MetaMusePerceptionAdapter,
                        transport=transport, credential=12345)
        self.assertCode("bad_shape", MetaMusePerceptionAdapter,
                        transport=transport, credential=CREDENTIAL,
                        max_line=True)
        self.assertCode("bad_shape", MetaMusePerceptionAdapter,
                        transport=transport, credential=CREDENTIAL,
                        max_line=0)
        self.assertCode("bad_shape", MetaMusePerceptionAdapter,
                        transport=transport, credential=CREDENTIAL,
                        max_line="16384")
        # Positive pair: bytearray credentials normalize to bytes.
        transport = _Recorder(_raw(_response()))
        adapter = MetaMusePerceptionAdapter(
            transport=transport, credential=bytearray(CREDENTIAL))
        adapter.perceive(_frame_ref())
        self.assertIs(type(transport.calls[0][1]), bytes)
        self.assertEqual(transport.calls[0][1], CREDENTIAL)

    def test_repr_and_str_never_carry_credential(self):
        adapter = self.make()
        self.assertNoCanary(repr(adapter), str(adapter))
        self.assertIn("credential_set=True", repr(adapter))
        adapter.clear_credential()
        self.assertIn("credential_set=False", repr(adapter))
        self.assertNoCanary(repr(adapter), str(adapter))

    def test_clear_credential_disables_adapter(self):
        transport = _Recorder(_raw(_response()))
        adapter = self.make(transport)
        adapter.perceive(_frame_ref())
        adapter.clear_credential()
        self.assertCode("unavailable", adapter.perceive, _frame_ref())
        self.assertEqual(len(transport.calls), 1)

    def test_transport_errors_map_to_unavailable_without_leak(self):
        errors = [
            ValueError(SECRET),
            RuntimeError("auth failed for " + SECRET),
            OSError(SECRET),
            TimeoutError(),
        ]
        for error in errors:
            with self.subTest(error=type(error).__name__):
                adapter = self.make(_Recorder(b"{}", error=error))
                caught = self.assertCode("unavailable", adapter.perceive,
                                         _frame_ref())
                self.assertNoCanary(str(caught),
                                    " ".join(str(a) for a in caught.args))
                self.assertIn(type(error).__name__, str(caught))

    def test_non_bytes_response_refused(self):
        for payload in ("{}", {}, None, ["x"], 5, 16384):
            with self.subTest(payload=repr(payload)[:24]):
                adapter = self.make(_Recorder(payload))
                self.assertCode("bad_shape", adapter.perceive,
                                _frame_ref())
        # Positive pair: bytearray responses are accepted as bytes.
        adapter = self.make(_Recorder(bytearray(_raw(_response()))))
        self.assertEqual(adapter.perceive(_frame_ref()), _vision())

    def _sized_response(self, size):
        base = _raw(_response(_vision(summary="")))
        pad = size - len(base)
        self.assertGreaterEqual(pad, 0)
        if pad <= 4096:
            return _raw(_response(_vision(summary="x" * pad)))
        with_el = _raw(_response(_vision(
            summary="x" * 4096, elements=[_element(name="")])))
        rem = size - len(with_el)
        self.assertGreaterEqual(rem, 0)
        return _raw(_response(_vision(
            summary="x" * 4096, elements=[_element(name="x" * rem)])))

    def test_response_line_bound_enforced(self):
        exact = self._sized_response(256)
        self.assertEqual(len(exact), 256)
        adapter = self.make(_Recorder(exact), max_line=256)
        self.assertEqual(len(adapter.perceive(_frame_ref())["summary"]),
                         256 - len(_raw(_response(_vision(summary="")))))
        adapter = self.make(_Recorder(exact + b"x"), max_line=256)
        self.assertCode("bad_shape", adapter.perceive, _frame_ref())

    def test_default_line_bound_is_16384(self):
        exact = self._sized_response(16384)
        self.assertEqual(len(exact), 16384)
        adapter = self.make(_Recorder(exact))
        self.assertTrue(adapter.perceive(_frame_ref())["summary"])
        adapter = self.make(_Recorder(exact + b"x"))
        self.assertCode("bad_shape", adapter.perceive, _frame_ref())

    def test_unknown_response_version_refused(self):
        adapter = self.make(_Recorder(_raw(_response(
            schema="muse.vision/v9.9"))))
        self.assertCode("unknown_version", adapter.perceive, _frame_ref())
        # Positive pair: the known version is accepted.
        self.assertEqual(self.make().perceive(_frame_ref()), _vision())

    def test_unknown_frame_ref_version_refused(self):
        adapter = self.make()
        self.assertCode("unknown_version", adapter.perceive,
                        _frame_ref(schema="frame_ref/v9.9"))

    def test_malformed_frame_ref_refused(self):
        adapter = self.make()
        bad_refs = [
            None, [], "frame_ref/v0.1", {},
            _frame_ref(schema="observation/v0.1"),
            _frame_ref(schema=""),
            _frame_ref(schema=None),
            _frame_ref(schema=5),
            {"schema": "frame_ref/v0.1"},
            _frame_ref(width=True),
            _frame_ref(width=0),
            _frame_ref(width="800"),
            _frame_ref(height=False),
            _frame_ref(height=-1),
        ]
        for index, frame_ref in enumerate(bad_refs):
            with self.subTest(index=index):
                self.assertCode("bad_shape", adapter.perceive, frame_ref)

    def test_malformed_response_envelope_refused(self):
        bad_raws = [
            b"not json{",
            b"",
            b"[1, 2]",
            b"null",
            b"5",
            b"\xff\xfe binary",
            b'{"schema": "muse.vision/v1", "vision": {"summary": NaN,'
            b' "changed_regions": [], "elements": []}}',
            b'{"schema": "muse.vision/v1", "vision": {"summary": "s",'
            b' "changed_regions": [], "elements": [{"bbox": {"x": 0,'
            b' "y": 0, "w": 1, "h": 1}, "role": "r", "name": "n",'
            b' "confidence": Infinity}]}}',
            _raw(_response(extra="nope")),
            _raw({"vision": _vision()}),
            _raw(_response(schema=None)),
            _raw(_response(schema=5)),
            _raw(_response(schema="")),
            _raw(_response(vision=[])),
            _raw({"schema": RESPONSE_SCHEMA, "vision": None}),
        ]
        for index, raw in enumerate(bad_raws):
            with self.subTest(index=index):
                adapter = self.make(_Recorder(raw))
                self.assertCode("bad_shape", adapter.perceive,
                                _frame_ref())

    def test_malformed_vision_fields_refused(self):
        full = {"x": 0, "y": 0, "w": 800, "h": 600}
        tiny = {"x": 0, "y": 0, "w": 1, "h": 1}
        bad_visions = [
            _vision(extra=1),
            _vision(summary=None),
            _vision(summary=5),
            _vision(summary="x" * 4097),
            _vision(summary="x" * 65537),
            _vision(changed_regions={}),
            _vision(changed_regions=[dict(full, x=True)]),
            _vision(changed_regions=[dict(full, w=0)]),
            _vision(changed_regions=[{"x": 700, "y": 0,
                                      "w": 101, "h": 600}]),
            _vision(changed_regions=[dict(tiny, extra=0)]),
            _vision(changed_regions=[tiny] * 4097),
            _vision(elements={}),
            _vision(elements=[dict(_element(), extra=0)]),
            _vision(elements=[{k: v for k, v in _element().items()
                               if k != "name"}]),
            _vision(elements=[_element(role="")]),
            _vision(elements=[_element(role="r" * 129)]),
            _vision(elements=[_element(role=None)]),
            _vision(elements=[_element(name=5)]),
            _vision(elements=[_element(name="n" * 65537)]),
            _vision(elements=[_element(confidence=True)]),
            _vision(elements=[_element(confidence=1.5)]),
            _vision(elements=[_element(confidence=-0.1)]),
            _vision(elements=[_element(confidence="0.9")]),
            _vision(elements=[_element(confidence=None)]),
            _vision(elements=[_element(
                bbox={"x": 799, "y": 599, "w": 2, "h": 2})]),
            _vision(elements=[_element()] * 4097),
        ]
        for index, vision in enumerate(bad_visions):
            with self.subTest(index=index):
                adapter = self.make(_Recorder(_raw(_response(vision))),
                                    max_line=8_000_000)
                self.assertCode("bad_shape", adapter.perceive,
                                _frame_ref())

    def test_vision_caps_boundary_accepted(self):
        vision = _vision(
            summary="s" * 4096,
            changed_regions=[{"x": 0, "y": 0, "w": 800, "h": 600}],
            elements=[
                _element(role="r" * 128, name="n" * 65536,
                         confidence=0),
                _element(confidence=1),
                _element(confidence=1.0),
            ],
        )
        adapter = self.make(_Recorder(_raw(_response(vision))),
                            max_line=8_000_000)
        self.assertEqual(adapter.perceive(_frame_ref()), vision)
        # Empty arrays and extreme-but-valid geometry are accepted.
        vision = _vision(summary="", changed_regions=[], elements=[])
        adapter = self.make(_Recorder(_raw(_response(vision))))
        self.assertEqual(adapter.perceive(_frame_ref()), vision)

    def test_array_caps_boundary_accepted(self):
        tiny = {"x": 0, "y": 0, "w": 1, "h": 1}
        vision = _vision(changed_regions=[dict(tiny)] * 4096,
                         elements=[_element()] * 4096)
        adapter = self.make(_Recorder(_raw(_response(vision))),
                            max_line=8_000_000)
        self.assertEqual(len(adapter.perceive(_frame_ref())["elements"]),
                         4096)

    def test_frame_dimension_agreement(self):
        frame = Frame(width=800, height=600, data=b"\x00" * 800 * 600 * 3)
        prev = Frame(width=800, height=600, data=b"\x00" * 800 * 600 * 3)
        transport = _Recorder(_raw(_response()))
        adapter = self.make(transport)
        self.assertEqual(adapter.perceive(_frame_ref(), frame, prev=prev),
                         _vision())
        self.assertIs(transport.calls[0][0]["frame"], frame)
        self.assertIs(transport.calls[0][0]["prev"], prev)
        small = Frame(width=4, height=2, data=b"\x00" * 24)
        self.assertCode("bad_shape", adapter.perceive, _frame_ref(),
                        small)
        self.assertCode("bad_shape", adapter.perceive, _frame_ref(),
                        frame, prev=small)
        for bad in (5, b"bytes", ["x"], {"w": 1}):
            with self.subTest(bad=repr(bad)):
                self.assertCode("bad_shape", adapter.perceive,
                                _frame_ref(), bad)

    def test_ram_path_containment(self):
        adapter = self.make()
        with tempfile.TemporaryDirectory(dir="/dev/shm") as shm_dir:
            shm_root = Path(shm_dir)
            demo_rgb = shm_root / "demo.rgb"
            demo_rgb.write_bytes(_PIXELS)
            marks_json = shm_root / "marks.json"
            marks_json.write_bytes(_PIXELS)
            symlink_rgb = shm_root / "symlink.rgb"
            symlink_rgb.symlink_to(demo_rgb)
            with demo_rgb.open("rb") as fd_handle:
                fd_path = "/proc/self/fd/%d" % fd_handle.fileno()
                for good in (str(demo_rgb), fd_path, marks_json):
                    with self.subTest(path=str(good)):
                        self.assertEqual(adapter.perceive(_frame_ref(), good),
                                         _vision())
                        self.assertEqual(
                            adapter.perceive(_frame_ref(), prev=good), _vision())
            for bad in ("", "/tmp/x.rgb", "relative/x.rgb", "/home/u/x.rgb",
                        "/dev/shm", "/dev/shm/../etc/x", "/dev/shm/a\x00b",
                        "/dev/shm/nonexistent-ramws-demo.rgb",
                        str(symlink_rgb), "/proc/self/fd",
                        "/proc/self/fd/not-a-number", ".", "/"):
                with self.subTest(path=repr(bad)):
                    self.assertCode("bad_shape", adapter.perceive,
                                    _frame_ref(), bad)
                    self.assertCode("bad_shape", adapter.perceive,
                                    _frame_ref(), prev=bad)

    def test_returned_vision_isolated_from_transport_payload(self):
        payload = _response()
        adapter = self.make(_Recorder(_raw(payload)))
        vision = adapter.perceive(_frame_ref())
        self.assertEqual(vision, payload["vision"])
        self.assertIsNot(vision, payload["vision"])
        vision["summary"] = "mutated"
        vision["elements"].append(_element())
        vision["changed_regions"].clear()
        self.assertEqual(payload["vision"], _vision())

    def test_request_frame_ref_isolated_from_caller(self):
        transport = _Recorder(_raw(_response()))
        adapter = self.make(transport)
        frame_ref = _frame_ref()
        adapter.perceive(frame_ref)
        captured = transport.calls[0][0]["frame_ref"]
        self.assertIsNot(captured, frame_ref)
        captured["width"] = 1
        captured["surface_id"] = "mutated"
        self.assertEqual(frame_ref, _frame_ref())

    def test_failures_emit_no_output_and_no_leak(self):
        adapters = [
            self.make(_Recorder(b"{}", error=ValueError(SECRET))),
            self.make(_Recorder(b"not json")),
            self.make(_Recorder(_raw(_response())), credential=None),
        ]
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), \
                contextlib.redirect_stderr(stderr):
            for adapter in adapters:
                with self.assertRaises(PerceptionError):
                    adapter.perceive(_frame_ref())
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "")
        self.assertNoCanary(stdout.getvalue(), stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
