"""Hosted live-stack profile allocation tests; no native processes or Docker."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

live = load("multicap_live", "tests/e2e/e2e1_slice/live.py")
stack = load("multicap_stack", "tests/e2e/e2e1_slice/stack.py")

class MultiCapsuleStackTests(unittest.TestCase):
    def test_separate_stack_state_and_explicit_profile_binding(self):
        with tempfile.TemporaryDirectory() as runtime, tempfile.TemporaryDirectory(dir="/dev/shm") as ram:
            os.chmod(runtime, 0o700)
            roots = [Path(ram) / name for name in ("a", "b")]
            for root in roots:
                root.mkdir()
            profiles = {name: {"RAMRoot": str(root)} for name, root in zip(("pair-a", "pair-b"), roots)}
            env = dict(XDG_RUNTIME_DIR=runtime, MV_SRF_PROFILES=json.dumps(profiles))
            states = []
            for name, root in zip(profiles, roots):
                with patch.dict(os.environ, dict(env, MV_SRF_LIVE_PROFILE=name, MV_SRF_LIVE_RAM_ROOT=str(root))):
                    self.assertEqual(live.validate_live_profile(), name)
                    states.append(stack.state_root())
            self.assertNotEqual(*states)
            self.assertTrue(all(path.is_dir() for path in states))
            # MUT-SHARED-PROFILE: same profile must map to the same exclusive lock.
            with patch.dict(os.environ, dict(env, MV_SRF_LIVE_PROFILE="pair-a", MV_SRF_LIVE_RAM_ROOT=str(roots[0]))):
                self.assertEqual(stack.state_root(), states[0])
                with patch.dict(os.environ, MV_SRF_LIVE_RAM_ROOT=str(roots[1])):
                    with self.assertRaisesRegex(RuntimeError, "mismatch"):
                        live.validate_live_profile()
                profiles["pair-b"]["RAMRoot"] = str(roots[0])
                with patch.dict(os.environ, MV_SRF_PROFILES=json.dumps(profiles)):
                    with self.assertRaisesRegex(RuntimeError, "disjoint"):
                        live.validate_live_profile()

    def test_h3_ram_cleanup_removes_only_destroyed_capsule(self):
        with tempfile.TemporaryDirectory(dir="/dev/shm") as ram:
            root_a, root_b = Path(ram) / "a", Path(ram) / "b"
            a, b = "srf-id-abcdef01", "srf-id-abcdef02"
            allocation_a, allocation_b = root_a / a, root_b / b
            allocation_a.mkdir(parents=True)
            allocation_b.mkdir(parents=True)
            sibling = allocation_b / "frame.rgb"
            sibling.write_bytes(b"sibling-frame")
            receipt = live.cleanup_capsule_ram(root_a, [a], active_containers=[b])
            self.assertEqual(receipt["status"], "PASS")
            self.assertTrue(receipt["ram_absent"])
            self.assertFalse(allocation_a.exists())
            self.assertEqual(sibling.read_bytes(), b"sibling-frame")
            # A still-live sibling is never eligible for removal.
            refused = live.cleanup_capsule_ram(root_b, [b], active_containers=[b])
            self.assertEqual(refused["status"], "FAIL")
            self.assertTrue(sibling.exists())

    def test_identity_receipts_never_cross_profiles(self):
        receipt = {"Lease": {"ProfileID": "pair-a"}, "Capsule": {"container": "srf-id-abcdef01"}}
        self.assertEqual(live.capsule_from_receipt(receipt, "pair-a"), "srf-id-abcdef01")
        self.assertIsNone(live.capsule_from_receipt(receipt, "pair-b"))
        for profile in ("../escape", "UPPER", "", "a/b"):
            with self.assertRaises(RuntimeError):
                live.selected_profile({"MV_SRF_LIVE_PROFILE": profile})

    def test_explicit_profiles_without_live_ram_root_raise_typed_error(self):
        with tempfile.TemporaryDirectory(dir="/dev/shm") as ram:
            env = {"MV_SRF_LIVE_PROFILE": "pair-a", "MV_SRF_PROFILES": json.dumps({"pair-a": {"RAMRoot": ram}})}
            with self.assertRaisesRegex(RuntimeError, "MV_SRF_LIVE_RAM_ROOT"):
                live.validate_live_profile(env)
