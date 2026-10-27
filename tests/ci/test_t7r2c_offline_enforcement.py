"""T7 round-2: offline.sh network isolation, env lockdown, fail-closed, and workflow enforcement."""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
OFFLINE_SH = ROOT / ".github" / "workflows" / "offline.sh"


class TestT7R2COfflineEnforcement(unittest.TestCase):
    def test_o3_offline_sh_userns_egress_blocked_loopback_kept(self):
        if not shutil.which("unshare") or not shutil.which("ip"):
            return
        probe_netlink = subprocess.run(
            ["unshare", "--user", "--map-current-user", "--keep-caps", "--net", "--", "ip", "link", "set", "lo", "up"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if probe_netlink.returncode != 0:
            marker = pathlib.Path(tempfile.mkdtemp(prefix="t7r2c-netlink-")) / "ran"
            try:
                res = subprocess.run(
                    ["bash", str(OFFLINE_SH), "python3", "-c", f"open({str(marker)!r}, 'w').write('1')"],
                    cwd=ROOT,
                    capture_output=True,
                    text=True,
                    timeout=15,
                )
                self.assertNotEqual(res.returncode, 0)
                self.assertFalse(marker.exists(), "offline.sh must fail closed when ip link set lo up is denied")
            finally:
                shutil.rmtree(marker.parent, ignore_errors=True)
            return

        probe = """
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(('127.0.0.1', 0))
s.listen(1)
port = s.getsockname()[1]
c = socket.create_connection(('127.0.0.1', port), timeout=2)
c.close()
s.close()
print('LOOPBACK_OK')
try:
    u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    u.connect(('198.51.100.1', 53))
    print('EGRESS_UNEXPECTED_OK')
    sys.exit(2)
except OSError:
    print('EGRESS_BLOCKED')
"""
        res = subprocess.run(
            ["bash", str(OFFLINE_SH), "python3", "-c", probe],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(res.returncode, 0, res.stderr + res.stdout)
        self.assertIn("LOOPBACK_OK", res.stdout)
        self.assertIn("EGRESS_BLOCKED", res.stdout)

    def test_o3_offline_sh_exports_offline_toolchain_vars_and_invokes_unshare(self):
        with tempfile.TemporaryDirectory(prefix="t7r2c-unshare-") as tmp:
            unshare_shim = pathlib.Path(tmp) / "unshare"
            unshare_shim.write_text(
                "#!/usr/bin/env bash\n"
                "while [[ $# -gt 0 && $1 != -- ]]; do shift; done\n"
                "shift\n"
                'exec "$@"\n',
                encoding="utf-8",
            )
            unshare_shim.chmod(0o755)
            ip_shim = pathlib.Path(tmp) / "ip"
            ip_shim.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
            ip_shim.chmod(0o755)
            env = dict(os.environ, PATH=f"{tmp}:{os.environ['PATH']}")
            res = subprocess.run(
                [
                    "bash",
                    str(OFFLINE_SH),
                    "python3",
                    "-c",
                    "import json, os; print(json.dumps({k: os.environ.get(k) for k in "
                    "('CARGO_NET_OFFLINE', 'GOPROXY', 'GOSUMDB', 'GOTOOLCHAIN', 'GOFLAGS', 'npm_config_offline')}))",
                ],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            observed = json.loads(res.stdout.strip())
            self.assertEqual(
                observed,
                {
                    "CARGO_NET_OFFLINE": "true",
                    "GOPROXY": "off",
                    "GOSUMDB": "off",
                    "GOTOOLCHAIN": "local",
                    "GOFLAGS": "-mod=readonly",
                    "npm_config_offline": "true",
                },
            )

    def test_o3_offline_sh_fails_closed_no_fallback_to_host_netns(self):
        with tempfile.TemporaryDirectory(prefix="t7r2c-unshare-fail-") as tmp:
            marker = pathlib.Path(tmp) / "executed"
            shim = pathlib.Path(tmp) / "unshare"
            shim.write_text(
                "#!/usr/bin/env bash\n"
                "echo 'unshare: Operation not permitted' >&2\n"
                "exit 1\n",
                encoding="utf-8",
            )
            shim.chmod(0o755)
            env = dict(os.environ, PATH=f"{tmp}:{os.environ['PATH']}")
            res = subprocess.run(
                ["bash", str(OFFLINE_SH), "python3", "-c", f"open('{marker}', 'w').write('ran')"],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertNotEqual(res.returncode, 0)
            self.assertFalse(marker.exists(), "Payload executed despite unshare failure!")

    def test_o3_offline_sh_timeout_inside_namespace_propagates_124(self):
        with tempfile.TemporaryDirectory(prefix="t7r2c-unshare-to-") as tmp:
            shim = pathlib.Path(tmp) / "unshare"
            shim.write_text(
                "#!/usr/bin/env bash\n"
                "while [[ $# -gt 0 && $1 != -- ]]; do shift; done\n"
                "shift\n"
                'exec "$@"\n',
                encoding="utf-8",
            )
            shim.chmod(0o755)
            ip_shim = pathlib.Path(tmp) / "ip"
            ip_shim.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
            ip_shim.chmod(0o755)
            env = dict(os.environ, PATH=f"{tmp}:{os.environ['PATH']}")
            res = subprocess.run(
                ["bash", str(OFFLINE_SH), "timeout", "0.1", "python3", "-c", "import time; time.sleep(10)"],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(res.returncode, 124, res.stderr + res.stdout)

    def test_o3_workflow_build_test_steps_use_offline_wrapper_and_offline_flags(self):
        ci_text = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        self.assertIn("cargo clippy --locked --offline", ci_text)
        self.assertIn("cargo test --locked --offline", ci_text)
        self.assertIn('GOPROXY: "off"', ci_text)
        self.assertIn('GOSUMDB: "off"', ci_text)
        self.assertIn("npm --prefix ui ci --offline", ci_text)

        vol_text = (ROOT / ".github" / "workflows" / "volume.yml").read_text(encoding="utf-8")
        self.assertIn("bash .github/workflows/offline.sh true", vol_text)
        self.assertIn('bash "$GITHUB_WORKSPACE/.github/workflows/offline.sh" npm ci --offline', vol_text)


if __name__ == "__main__":
    unittest.main()
