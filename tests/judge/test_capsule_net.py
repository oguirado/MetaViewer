"""Supported proxy setup, with disposable fakes only."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from judge_sandbox import Sandbox


class TestCapsuleNet(unittest.TestCase):
    def run_install(self, failure=False, mutant=None):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        sb = Sandbox(tmp.name, arch="x86_64", mutant=mutant)
        self.addCleanup(sb.cleanup)
        sb.full_kit(t2=True)
        if failure:
            sb.put("net_up_fail", "1")
        return sb, sb.judge("install", "--capsules", "--no-firewall")

    def test_launcher_paths_and_private_metadata(self):
        sb, res = self.run_install()
        self.assertEqual(res.rc, 0, res.text)
        self.assertIn("JUDGE_INSTALL_OK", res.out)
        root = sb.jh / "network"
        log = sb.log("srf.log")
        self.assertIn("net up --proxy-bin " + str(sb.jh / "deps/opensuperficies/bin/srf-egress-proxy"), log)
        for flag, path in (("--policy", root / "policy/policy.json"),
                           ("--registry", root / "registry/registry.json"),
                           ("--audit-dir", root / "audit")):
            self.assertIn(flag + " " + str(path), log)
        for path in (root, root / "policy", root / "registry", root / "audit"):
            self.assertEqual(path.stat().st_mode & 0o777, 0o700)
        policy = root / "policy/policy.json"
        self.assertEqual(policy.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(policy.read_text()), {
            "schema": "browserid.proxy-policy/v1", "approved": {}, "denied": [], "connect_ports": {}})
        self.assertEqual(sb.log("sudo.log"), "")
        self.assertNotIn("docker run -d --name srf-egress-proxy", sb.log("docker.log"))

    def test_failed_launcher_stops_install_before_receipt(self):
        sb, res = self.run_install(failure=True)
        self.assertEqual(res.rc, 2, res.text)
        self.assertIn("JUDGE_NET", res.codes)
        self.assertFalse((sb.jh / "judge_receipt.json").exists())

    def test_deciding_launcher_mutant_is_killed(self):
        _, res = self.run_install(mutant="JUDGE_PROXY_UP")
        self.assertNotEqual(res.rc, 0, res.text)
        self.assertNotIn("JUDGE_INSTALL_OK", res.out)

    def test_x64_open_firewall_still_requires_missing_new_image(self):
        sb, res = self.run_install()
        self.assertEqual(res.rc, 0, res.text)
        sb.put("caps", "net_modes=legacy,open\n")
        sb.witness.parent.mkdir(parents=True, exist_ok=True)
        sb.witness.write_text("witness")
        sb.put("images", "opensuperficies-identity-browser-x64:0.1.1\n"
               "opensuperficies-program-host-x64:0.1.0\n"
               "opensuperficies-desktop-x64:1.1.0\n")
        res = sb.judge("doctor", "--capsules")
        self.assertIn("JUDGE_IMAGE", res.codes)
        self.assertIn("opensuperficies-identity-browser-x64:0.2.0", res.text)
