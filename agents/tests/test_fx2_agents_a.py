"""Regression tests and negative controls for FX2-AGENTS-A (round-2 findings)."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from metaviewer_agents import tools, vision
from metaviewer_agents.executor import AdmittedExecutor, SurfaceRefused
from metaviewer_agents.perception.base import Frame, PerceptionError, check_vision
from metaviewer_agents.perception.meta_muse import MetaMusePerceptionAdapter
from metaviewer_agents.perception.vcore import (
    VCorePerceptionAdapter,
    _check_unit_ratio,
    _ramws_frame,
)


def _vcore_frame_ref(sha256: str, width: int = 4, height: int = 4,
                     ramws_path: str = "/dev/shm/mv0-fx2-test.rgb") -> dict:
    return {
        "schema": "frame_ref/v0.2",
        "surface_id": "surf-1",
        "generation": 1,
        "tick": 1,
        "ts_ns": 100,
        "width": width,
        "height": height,
        "format": "rgb24",
        "ramws_path": ramws_path,
        "sha256": sha256,
        "capture_us": 10,
    }


def _c2_payload(frame_sha256: str, width: int = 4, height: int = 4) -> dict:
    return {
        "schema": "ve.cu_describe/v1",
        "frame_sha256": frame_sha256,
        "width": width,
        "height": height,
        "changed": None,
        "changed_regions": [],
        "crops": [],
        "timing_us": 5,
    }


class FX2AgentsARegressionTests(unittest.TestCase):
    def test_ag2_01_perceive_binds_c2_digest(self) -> None:
        with tempfile.TemporaryDirectory() as ve_dir:
            adapter = VCorePerceptionAdapter(ve_dir, python=sys.executable)
            pixels = bytes(range(48))
            expected_sha = hashlib.sha256(pixels).hexdigest()
            frame = Frame(width=4, height=4, data=pixels)
            ref = _vcore_frame_ref(expected_sha)

            # Mismatched C2 reply digest against Frame input -> identity_mismatch
            bad_completed = subprocess.CompletedProcess(
                args=["c2"], returncode=0,
                stdout=json.dumps(_c2_payload("cd" * 32)).encode("utf-8"),
                stderr=b"",
            )
            with mock.patch.object(subprocess, "run", return_value=bad_completed):
                with self.assertRaises(PerceptionError) as ctx:
                    adapter.perceive(ref, frame)
                self.assertEqual(ctx.exception.code, "identity_mismatch")

            # Mismatched C2 reply digest against path input (ab*32 vs cd*32) -> identity_mismatch
            path_ref = _vcore_frame_ref("ab" * 32)
            with mock.patch.object(subprocess, "run", return_value=bad_completed):
                with self.assertRaises(PerceptionError) as ctx:
                    adapter.perceive(path_ref, "/dev/shm/mv0-fx2-path.png")
                self.assertEqual(ctx.exception.code, "identity_mismatch")

            # Negative control: matching digests pass on both Frame and path inputs
            ok_frame_completed = subprocess.CompletedProcess(
                args=["c2"], returncode=0,
                stdout=json.dumps(_c2_payload(expected_sha)).encode("utf-8"),
                stderr=b"",
            )
            with mock.patch.object(subprocess, "run", return_value=ok_frame_completed):
                out = adapter.perceive(ref, frame)
                self.assertIn("summary", out)

            ok_path_completed = subprocess.CompletedProcess(
                args=["c2"], returncode=0,
                stdout=json.dumps(_c2_payload("ab" * 32)).encode("utf-8"),
                stderr=b"",
            )
            with mock.patch.object(subprocess, "run", return_value=ok_path_completed):
                out_path = adapter.perceive(path_ref, "/dev/shm/mv0-fx2-path.png")
                self.assertIn("summary", out_path)

    def test_ag2_02_ramws_frame_refuses_symlink_escape(self) -> None:
        with tempfile.TemporaryDirectory() as outside_dir, \
                tempfile.TemporaryDirectory(dir="/dev/shm") as shm_dir:
            outside_target = Path(outside_dir) / "evil.bin"
            outside_target.write_bytes(b"E" * 48)
            shm_link = Path(shm_dir) / "escape.rgb"
            shm_link.symlink_to(outside_target)

            # Exact-size outside target via symlink in /dev/shm must be refused
            with self.assertRaises(PerceptionError) as ctx:
                _ramws_frame({"ramws_path": str(shm_link)}, 4, 4)
            self.assertEqual(ctx.exception.code, "bad_shape")

            # Internal symlink in /dev/shm must also be refused
            real_shm = Path(shm_dir) / "real.rgb"
            real_shm.write_bytes(b"R" * 48)
            internal_link = Path(shm_dir) / "internal_link.rgb"
            internal_link.symlink_to(real_shm)
            with self.assertRaises(PerceptionError) as ctx:
                _ramws_frame({"ramws_path": str(internal_link)}, 4, 4)
            self.assertEqual(ctx.exception.code, "bad_shape")

            # Negative control: regular file in /dev/shm passes
            loaded = _ramws_frame({"ramws_path": str(real_shm)}, 4, 4)
            self.assertEqual(loaded, Frame(width=4, height=4, data=b"R" * 48))

    def test_ag2_03_vcore_subprocess_output_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as ve_dir:
            root = Path(ve_dir)
            vadapt = root / "vadapt"
            vadapt.mkdir()
            (vadapt / "__init__.py").write_text("", encoding="utf-8")
            vcore_pkg = root / "visioncore"
            vcore_pkg.mkdir()
            (vcore_pkg / "__init__.py").write_text("", encoding="utf-8")

            pixels = bytes(48)
            expected_sha = hashlib.sha256(pixels).hexdigest()
            ref = _vcore_frame_ref(expected_sha)
            frame = Frame(width=4, height=4, data=pixels)

            flood_c2_script = (
                "import json, sys\n"
                "sys.stdout.write(' ' * (1024 * 1024 + 64) + "
                + repr(json.dumps(_c2_payload(expected_sha)))
                + ")\n"
                "sys.stdout.flush()\n"
            )
            flood_cli_script = (
                "import json, sys\n"
                "sys.stdout.write(' ' * (1024 * 1024 + 64) + json.dumps({'code': 'OK', 'rc': 0}))\n"
                "sys.stdout.flush()\n"
            )
            (vadapt / "cu_describe.py").write_text(flood_c2_script, encoding="utf-8")
            (vcore_pkg / "cli.py").write_text(flood_cli_script, encoding="utf-8")

            adapter = VCorePerceptionAdapter(root, python=sys.executable, timeout=2.0)

            # Flooding C2 child (>1 MiB stdout) must fail with bounded typed error bad_shape
            with self.assertRaises(PerceptionError) as ctx:
                adapter.perceive(ref, frame)
            self.assertEqual(ctx.exception.code, "bad_shape")
            self.assertIn("exceeds maximum size", str(ctx.exception))

            # Flooding vcore child (>1 MiB stdout) must fail with bounded typed error bad_shape
            with self.assertRaises(PerceptionError) as ctx:
                adapter.run_vcore("selftest")
            self.assertEqual(ctx.exception.code, "bad_shape")
            self.assertIn("exceeds maximum size", str(ctx.exception))

            # Negative control: normal output passes both paths
            (vadapt / "cu_describe.py").write_text(
                "import json\nprint(" + repr(json.dumps(_c2_payload(expected_sha))) + ")\n",
                encoding="utf-8",
            )
            (vcore_pkg / "cli.py").write_text(
                'import json\nprint(json.dumps({"code": "OK", "rc": 0}))\n',
                encoding="utf-8",
            )
            vision_out = adapter.perceive(ref, frame)
            self.assertIn("summary", vision_out)
            vcore_out = adapter.run_vcore("selftest")
            self.assertEqual(vcore_out, {"code": "OK", "rc": 0})

    def test_ag2_05_executor_generation_control_leading_whitespace(self) -> None:
        frame = {"width": 8, "height": 8}
        for bad_name in (" Stop", "  \tStop generating", " Detener x", "Detener x"):
            target = {"id": "a", "name": bad_name, "box": [0, 0, 1, 1]}
            with self.subTest(name=bad_name):
                with self.assertRaises(SurfaceRefused) as ctx:
                    AdmittedExecutor.check_target(target, latest=[target], frame=frame)
                self.assertEqual(ctx.exception.code, "generation_control")

        # Negative control: "Proceed" passes
        ok_target = {"id": "a", "name": "Proceed", "box": [0, 0, 1, 1]}
        AdmittedExecutor.check_target(ok_target, latest=[ok_target], frame=frame)

    def test_ag2_07_vision_summary_cap_aligned_across_layers(self) -> None:
        # 4097-char summary refused at check_vision / perceive with bad_shape
        over_vision = {"summary": "s" * 4097, "changed_regions": [], "elements": []}
        with self.assertRaises(PerceptionError) as ctx:
            check_vision(over_vision, width=8, height=8)
        self.assertEqual(ctx.exception.code, "bad_shape")

        muse_over = MetaMusePerceptionAdapter(
            transport=lambda req, cred: json.dumps(
                {"schema": "muse.vision/v1", "vision": over_vision}
            ).encode("utf-8"),
            credential=b"secret",
        )
        with self.assertRaises(PerceptionError) as ctx:
            muse_over.perceive(_vcore_frame_ref("ab" * 32, width=8, height=8))
        self.assertEqual(ctx.exception.code, "bad_shape")

        # Negative control: 4096-char summary passes perceive and tools.observe() end-to-end
        exact_vision = {"summary": "s" * 4096, "changed_regions": [], "elements": []}
        muse_ok = MetaMusePerceptionAdapter(
            transport=lambda req, cred: json.dumps(
                {"schema": "muse.vision/v1", "vision": exact_vision}
            ).encode("utf-8"),
            credential=b"secret",
        )

        class _Client:
            def request(self, body: dict, expect: str, *, timeout_ms: int) -> dict:
                return {
                    "schema": expect,
                    "request_id": body["request_id"],
                    "op": "observe",
                    "status": "ok",
                    "observation": {
                        "schema": "observation/v0.2",
                        "frame_ref": _vcore_frame_ref("ab" * 32, width=8, height=8),
                    },
                }

        obs = tools.observe(
            "surf-1", client=_Client(), timeout_ms=500, perception_adapter=muse_ok
        )
        self.assertEqual(len(obs["vision"]["summary"]), 4096)

    def test_ag2_09_meta_muse_validates_ram_frame_paths(self) -> None:
        calls = []

        def transport(req: dict, cred: bytes | None) -> bytes:
            calls.append(req)
            return json.dumps({
                "schema": "muse.vision/v1",
                "vision": {"summary": "ok", "changed_regions": [], "elements": []},
            }).encode("utf-8")

        adapter = MetaMusePerceptionAdapter(transport=transport, credential=b"secret")
        ref = _vcore_frame_ref("ab" * 32, width=8, height=8)

        with tempfile.TemporaryDirectory() as outside_dir, \
                tempfile.TemporaryDirectory(dir="/dev/shm") as shm_dir:
            outside_file = Path(outside_dir) / "outside.rgb"
            outside_file.write_bytes(b"x" * 192)
            shm_symlink = Path(shm_dir) / "symlink.rgb"
            shm_symlink.symlink_to(outside_file)

            real_shm = Path(shm_dir) / "real.rgb"
            real_shm.write_bytes(b"x" * 192)
            internal_symlink = Path(shm_dir) / "internal_symlink.rgb"
            internal_symlink.symlink_to(real_shm)

            bad_paths = (
                "/proc/self/fd/not-a-number",
                "/proc/self/fd/01",
                "/proc/self/fd/-1",
                "/dev/shm/does-not-exist-xyz-99999",
                str(shm_symlink),
                str(internal_symlink),
                str(real_shm) + "/",
                "/dev/shm//real.rgb",
            )
            for bad in bad_paths:
                with self.subTest(bad=bad):
                    with self.assertRaises(PerceptionError) as ctx:
                        adapter.perceive(ref, bad)
                    self.assertEqual(ctx.exception.code, "bad_shape")
                    with self.assertRaises(PerceptionError) as ctx:
                        adapter.perceive(ref, prev=bad)
                    self.assertEqual(ctx.exception.code, "bad_shape")
            self.assertEqual(calls, [])

            # Negative control: real shm file and valid /proc/self/fd/0 pass
            out1 = adapter.perceive(ref, str(real_shm), prev=real_shm)
            self.assertEqual(out1["summary"], "ok")
            out2 = adapter.perceive(ref, "/proc/self/fd/0")
            self.assertEqual(out2["summary"], "ok")
            self.assertEqual(len(calls), 2)

    def test_ag2_11_check_unit_ratio_huge_int_raises_perception_error(self) -> None:
        for huge in (10**400, -(10**400)):
            with self.subTest(huge=huge):
                with self.assertRaises(PerceptionError) as ctx:
                    _check_unit_ratio(huge, name="score")
                self.assertEqual(ctx.exception.code, "bad_shape")

        # Negative control: 0.5 passes
        self.assertEqual(_check_unit_ratio(0.5, name="score"), 0.5)

    def test_ag2_12_vision_describe_non_pair_transport_raises_bridge_error(self) -> None:
        frame = _vcore_frame_ref("ab" * 32, width=4, height=4)
        for bad_return in (None, 123, "bad", (0,), (0, 1, 2), (0, None), (True, "{}")):
            with self.subTest(bad_return=bad_return):
                with self.assertRaises(vision.VisionBridgeError):
                    vision.describe(frame, transport=lambda f, r=bad_return: r)

        # Negative control: (0, valid_json) passes
        valid_json = json.dumps(_c2_payload("ab" * 32, width=4, height=4))
        out = vision.describe(frame, transport=lambda f: (0, valid_json))
        self.assertEqual(out["frame_sha256"], "ab" * 32)

    def test_ag2_13_meta_muse_rejects_duplicate_json_keys(self) -> None:
        dup_line = (
            b'{"schema":"bogus","schema":"muse.vision/v1","vision":'
            b'{"summary":"","changed_regions":[],"elements":[]}}'
        )
        adapter = MetaMusePerceptionAdapter(
            transport=lambda req, cred: dup_line,
            credential=b"secret",
        )
        ref = _vcore_frame_ref("ab" * 32, width=8, height=8)
        with self.assertRaises(PerceptionError) as ctx:
            adapter.perceive(ref)
        self.assertEqual(ctx.exception.code, "bad_shape")

        # Negative control: single keys pass
        ok_line = (
            b'{"schema":"muse.vision/v1","vision":'
            b'{"summary":"clean","changed_regions":[],"elements":[]}}'
        )
        ok_adapter = MetaMusePerceptionAdapter(
            transport=lambda req, cred: ok_line,
            credential=b"secret",
        )
        self.assertEqual(ok_adapter.perceive(ref)["summary"], "clean")


if __name__ == "__main__":
    unittest.main()
