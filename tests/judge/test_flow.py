"""doctor / install / run / stop of scripts/judge/metaviewer-judge.sh with fakes only."""

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from judge_sandbox import Sandbox, make_tar  # noqa: E402
import judge_scenarios as sc  # noqa: E402


class FlowCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.sb = Sandbox(tmp.name)
        self.addCleanup(self.sb.cleanup)

    def ok(self, res):
        self.assertEqual(res.rc, 0, res.text)
        return res


class TestDoctor(FlowCase):
    def test_doctor_ok_prints_tier_and_changes_nothing(self):
        before = sorted(p.name for p in self.sb.root.iterdir())
        res = self.ok(self.sb.judge("doctor"))
        self.assertIn("JUDGE_DOCTOR_OK tier=T1", res.out)
        self.assertEqual(sorted(p.name for p in self.sb.root.iterdir()), before)
        self.assertEqual(self.sb.log("sudo.log"), "")
        self.assertFalse(self.sb.jh.exists())

    def test_doctor_capsules_checks_t2(self):
        self.sb.make_t2_ready()
        self.assertIn("JUDGE_DOCTOR_OK tier=T2", self.ok(self.sb.judge("doctor", "--capsules")).out)
        (self.sb.fake / "images").write_text("")
        res = self.sb.judge("doctor", "--capsules")
        self.assertEqual(res.rc, 2)
        self.assertIn("JUDGE_IMAGE", res.codes)

    def test_doctor_failure_prints_every_refusal(self):
        self.sb.drop_tool("zip")
        res = self.sb.judge("doctor", env={"DISPLAY": None})
        self.assertEqual(res.rc, 2)
        self.assertTrue({"JUDGE_SYSDEP", "JUDGE_DISPLAY"} <= res.codes)
        self.assertNotIn("JUDGE_DOCTOR_OK", res.out)

    def test_usage_errors(self):
        for args in ((), ("bogus",), ("doctor", "--bogus")):
            with self.subTest(args=args):
                res = self.sb.judge(*args)
                self.assertEqual(res.rc, 64)
                self.assertIn("JUDGE_USAGE", res.codes)

    def test_judge_home_may_not_be_the_whole_home_directory(self):
        res = self.sb.judge("doctor", env={"MV_JUDGE_HOME": str(self.sb.home)})
        self.assertEqual(res.rc, 2)
        self.assertIn("JUDGE_USAGE", res.codes)


class TestInstallT1(FlowCase):
    def test_clean_install_writes_receipt_without_sudo_or_network(self):
        self.sb.full_kit()
        res = self.ok(self.sb.judge("install"))
        self.assertIn("METAVIEWER_MAIN_SMOKE_OK", res.out)
        self.assertIn("JUDGE_INSTALL_OK tier=T1", res.out)
        self.assertEqual(self.sb.log("sudo.log"), "")
        self.assertEqual(self.sb.log("curl.log"), "")
        self.assertTrue((self.sb.jh / "app" / "MetaViewer-linux-arm64" / "metaviewer").is_file())
        node_log = self.sb.log("node.log")
        self.assertIn("--verify-install", node_log)
        self.assertIn("--smoke", node_log)

    def test_receipt_is_deterministic_json_without_host_paths_or_secrets(self):
        self.sb.full_kit()
        self.ok(self.sb.judge("install"))
        text = (self.sb.jh / "judge_receipt.json").read_text()
        data = json.loads(text)
        self.assertEqual(data["schema"], "metaviewer.judge_receipt/v1")
        self.assertEqual(data["tier"], "T1")
        self.assertEqual(data["arch"], "arm64")
        self.assertEqual(data["measured"]["nproc"], 20)
        self.assertEqual(data["measured"]["mem_total_kib"], 32 * 1024 * 1024)
        self.assertEqual(data["smoke"], "METAVIEWER_MAIN_SMOKE_OK")
        self.assertEqual(list(data["assets"]), ["metaviewer-linux-arm64.tar.gz"])
        self.assertRegex(data["assets"]["metaviewer-linux-arm64.tar.gz"], r"^[0-9a-f]{64}$")
        self.assertNotIn(str(self.sb.home), text)
        self.assertNotIn(str(self.sb.root), text)
        self.assertNotRegex(text, r"\b20\d\d-\d\d-\d\d")
        self.assertEqual((self.sb.jh / "judge_receipt.json").stat().st_mode & 0o777, 0o600)
        self.ok(self.sb.judge("install"))
        self.assertEqual((self.sb.jh / "judge_receipt.json").read_text(), text, "re-install is idempotent")

    def test_receipt_never_touches_the_identity_store(self):
        store = self.sb.home / "store"
        (store / "profiles" / "judge").mkdir(parents=True)
        (store / "profiles" / "judge" / "Cookies").write_text("secret-cookie-bytes")
        self.sb.full_kit()
        self.ok(self.sb.judge("install"))
        self.assertNotIn("secret-cookie-bytes", (self.sb.jh / "judge_receipt.json").read_text())

    def test_declined_sudo_step_never_runs_sudo(self):
        self.sb.full_kit()
        self.sb.put("sysctl_kernel.apparmor_restrict_unprivileged_userns", "1\n")
        for stdin in ("n\n", "\n", ""):
            with self.subTest(stdin=stdin):
                res = self.sb.judge("install", stdin=stdin)
                self.assertEqual(res.rc, 2, res.text)
                self.assertIn("JUDGE_SUDO", res.codes)
                self.assertEqual(self.sb.log("sudo.log"), "")
                self.assertFalse((self.sb.apparmor / "metaviewer-judge").exists())

    def test_confirmed_apparmor_step_prints_command_and_loads_profile(self):
        self.sb.full_kit()
        self.sb.put("sysctl_kernel.apparmor_restrict_unprivileged_userns", "1\n")
        res = self.ok(self.sb.judge("install", stdin="y\n"))
        self.assertIn("Administrator step", res.err)
        self.assertIn("apparmor_parser", res.err)
        self.assertIn("apparmor_parser -r", self.sb.log("apparmor.log"))
        self.assertEqual((self.sb.apparmor / "metaviewer-judge").read_text(),
                         (self.sb.kit / "judge" / "apparmor" / "metaviewer").read_text())
        self.assertEqual(self.sb.log("sudo.log").count("sudo "), 1)

    def test_yes_flag_is_the_only_unattended_consent(self):
        self.sb.full_kit()
        self.sb.put("sysctl_kernel.apparmor_restrict_unprivileged_userns", "1\n")
        res = self.ok(self.sb.judge("install", "--yes"))
        self.assertIn("confirmed by --yes", res.err)
        self.assertIn("sudo ", self.sb.log("sudo.log"))

    def test_missing_sysdeps_are_installed_only_after_confirmation(self):
        self.sb.full_kit()
        self.sb.drop_tool("zip")
        declined = self.sb.judge("install", stdin="n\n")
        self.assertEqual(declined.rc, 2)
        self.assertIn("JUDGE_SUDO", declined.codes)
        self.assertEqual(self.sb.log("apt.log"), "")
        self.ok(self.sb.judge("install", stdin="y\n"))
        self.assertIn("apt-get install -y zip", self.sb.log("apt.log"))

    def test_sudo_missing_is_a_typed_refusal(self):
        self.sb.full_kit()
        self.sb.drop_tool("zip")
        self.sb.drop_tool("sudo")
        res = self.sb.judge("install", "--yes")
        self.assertEqual(res.rc, 2)
        self.assertIn("JUDGE_SUDO", res.codes)

    def test_failing_sudo_command_is_reported_not_ignored(self):
        self.sb.full_kit()
        self.sb.put("sysctl_kernel.apparmor_restrict_unprivileged_userns", "1\n")
        self.sb.put("sudo_rc", "1\n")
        res = self.sb.judge("install", "--yes")
        self.assertEqual(res.rc, 2)
        self.assertIn("failed (rc 1)", res.err)

    def test_static_refusal_stops_before_anything_is_changed(self):
        self.sb.full_kit()
        self.sb.set_df(shm=("tmpfs", 1_000_000), home=500_000_000_000, docker=500_000_000_000)
        res = self.sb.judge("install", "--yes")
        self.assertEqual(res.rc, 2)
        self.assertIn("JUDGE_SHM", res.codes)
        self.assertEqual(self.sb.log("sudo.log"), "")
        self.assertFalse((self.sb.jh / "app").exists())

    def test_kit_node_is_extracted_when_node_is_too_old(self):
        self.sb.full_kit()
        self.sb.put("node_version", "v18.0.0\n")
        self.sb.add_node_asset()
        self.sb.write_sums()
        res = self.ok(self.sb.judge("install"))
        self.assertTrue((self.sb.jh / "node" / "bin" / "node").is_file())
        self.assertIn("JUDGE_INSTALL_OK", res.out)

    def test_smoke_failure_is_typed(self):
        sc.smoke_bad(self.sb)
        res = self.sb.judge("install")
        self.assertEqual(res.rc, 2)
        self.assertIn("JUDGE_SMOKE", res.codes)
        self.assertNotIn("JUDGE_INSTALL_OK", res.out)
        self.assertFalse((self.sb.jh / "judge_receipt.json").exists(), "no receipt for a failed install")

    def test_verify_install_failure_is_typed(self):
        self.sb.full_kit()
        self.sb.put("pkg_verify_rc", "1\n")
        res = self.sb.judge("install")
        self.assertIn("JUDGE_SMOKE", res.codes)
        self.assertNotIn("--smoke", self.sb.log("node.log"), "smoke must not run after a failed verify")

    def test_missing_package_tool_is_typed(self):
        self.sb.full_kit()
        (self.sb.kit / "ui" / "tools" / "package.js").unlink()
        self.assertIn("JUDGE_SMOKE", self.sb.judge("install").codes)


class TestAssets(FlowCase):
    def test_tampered_asset_is_refused(self):
        sc.tamper(self.sb)
        res = self.sb.judge("install")
        self.assertEqual(res.rc, 2)
        self.assertIn("JUDGE_ASSET", res.codes)
        self.assertFalse((self.sb.jh / "app").exists())

    def test_missing_sums_file_is_refused_and_never_downloaded(self):
        self.sb.full_kit()
        (self.sb.assets / "SHA256SUMS").unlink()
        res = self.sb.judge("install", "--yes")
        self.assertIn("JUDGE_ASSET", res.codes)
        self.assertEqual(self.sb.log("curl.log"), "")

    def test_asset_without_a_sums_entry_is_refused(self):
        self.sb.add_app()
        self.sb.write_sums(skip=("metaviewer-linux-arm64.tar.gz",))
        self.assertIn("JUDGE_ASSET", self.sb.judge("install").codes)

    def test_path_traversal_member_is_refused(self):
        members = self.sb.app_members() + [("MetaViewer-linux-arm64/../evil", b"x", 0o644)]
        self.sb.add_app(members)
        self.sb.write_sums()
        res = self.sb.judge("install")
        self.assertIn("JUDGE_ASSET", res.codes)
        self.assertFalse((self.sb.root / "evil").exists())

    def test_absolute_member_is_refused(self):
        self.sb.add_app(self.sb.app_members() + [("/tmp/judge-evil", b"x", 0o644)])
        self.sb.write_sums()
        self.assertIn("JUDGE_ASSET", self.sb.judge("install").codes)

    def test_symlink_member_is_refused(self):
        self.sb.add_app(self.sb.app_members() + [("MetaViewer-linux-arm64/link", ("symlink", "/etc/passwd"), 0o777)])
        self.sb.write_sums()
        self.assertIn("JUDGE_ASSET", self.sb.judge("install").codes)

    def test_foreign_top_level_member_is_refused(self):
        self.sb.add_app(self.sb.app_members() + [("other/file", b"x", 0o644)])
        self.sb.write_sums()
        self.assertIn("JUDGE_ASSET", self.sb.judge("install").codes)

    def _remote(self, tamper=False):
        self.sb.full_kit()
        asset = self.sb.assets / "metaviewer-linux-arm64.tar.gz"
        release = self.sb.fake / "release"
        data = asset.read_bytes()
        (release / asset.name).write_bytes(data + (b"x" if tamper else b""))
        asset.unlink()

    def test_download_needs_confirmation_and_declining_downloads_nothing(self):
        self._remote()
        for stdin in ("n\n", ""):
            res = self.sb.judge("install", stdin=stdin)
            self.assertEqual(res.rc, 2)
            self.assertIn("JUDGE_ASSET", res.codes)
            self.assertEqual(self.sb.log("curl.log"), "")

    def test_confirmed_download_is_verified_and_installed(self):
        self._remote()
        res = self.ok(self.sb.judge("install", stdin="y\n"))
        self.assertIn("example.invalid/release/metaviewer-linux-arm64.tar.gz", self.sb.log("curl.log"))
        self.assertIn("--proto =https", self.sb.log("curl.log"))
        self.assertIn("JUDGE_INSTALL_OK", res.out)

    def test_downloaded_asset_with_wrong_digest_is_deleted(self):
        self._remote(tamper=True)
        res = self.sb.judge("install", "--yes")
        self.assertIn("JUDGE_ASSET", res.codes)
        self.assertFalse((self.sb.assets / "metaviewer-linux-arm64.tar.gz").exists())

    def test_failed_download_is_typed(self):
        self._remote()
        (self.sb.fake / "release" / "metaviewer-linux-arm64.tar.gz").unlink()
        res = self.sb.judge("install", "--yes")
        self.assertIn("JUDGE_ASSET", res.codes)
        self.assertEqual(list(self.sb.assets.glob(".*.part")), [])


class TestInstallT2(FlowCase):
    def _kit(self):
        self.sb.full_kit(t2=True)
        self.sb.put("caps", "net_modes=legacy,open\n")

    def test_confirmed_firewall_gives_open_network_in_one_sudo_step(self):
        self._kit()
        # Prompts in order: profile directory, firewall.
        res = self.ok(self.sb.judge("install", "--capsules", stdin="y\ny\n"))
        sudo = self.sb.log("sudo.log")
        self.assertEqual(sudo.count("sudo "), 2, sudo)
        self.assertIn("install -d -m 0700 -o 10001 -g 10001", sudo)
        self.assertIn("systemctl enable --now srf-open-egress.service", sudo)
        self.assertIn("sha256sum -c -", sudo, "root script re-hashes its inputs")
        self.assertIn("network=open", res.out)
        data = json.loads((self.sb.jh / "judge_receipt.json").read_text())
        self.assertEqual(data["network_mode"], "open")
        self.assertEqual(data["tier"], "T2")
        self.assertEqual(data["profile_id"], "judge")
        self.assertIn("opensuperficies-linux-arm64.tar.gz", data["assets"])
        self.assertEqual(data["docker_server_version"], "27.5.1")
        self.assertIn("| install -m 0755 -o root -g root", res.err + res.out, "the exact script is shown before the prompt")

    def test_declined_firewall_falls_back_to_legacy_network(self):
        self._kit()
        res = self.ok(self.sb.judge("install", "--capsules", stdin="y\nn\n"))
        self.assertNotIn("systemctl", self.sb.log("sudo.log"))
        self.assertIn("falling back to the legacy network", res.err)
        self.assertIn("network=legacy", res.out)
        self.assertIn("docker network create --internal --subnet 172.30.80.0/24 srf-idnet", self.sb.log("docker.log"))

    def test_no_firewall_flag_never_asks(self):
        self._kit()
        res = self.ok(self.sb.judge("install", "--capsules", "--no-firewall", stdin="y\n"))
        self.assertNotIn("firewall", self.sb.log("sudo.log"))
        self.assertIn("network=legacy", res.out)

    def test_failed_firewall_step_falls_back_instead_of_failing(self):
        self._kit()
        self.sb.put("fw_fail", "1\n")
        res = self.ok(self.sb.judge("install", "--capsules", stdin="y\ny\n"))
        self.assertIn("firewall step failed", res.err)
        self.assertIn("falling back to the legacy network", res.err)
        self.assertIn("network=legacy", res.out)

    def test_profile_step_declined_is_a_typed_refusal(self):
        self._kit()
        res = self.sb.judge("install", "--capsules", stdin="n\n")
        self.assertEqual(res.rc, 2)
        self.assertIn("JUDGE_SUDO", res.codes)
        self.assertEqual(self.sb.log("sudo.log"), "")

    def test_images_are_loaded_from_the_kit_only_when_missing(self):
        self._kit()
        self.ok(self.sb.judge("install", "--capsules", "--no-firewall", stdin="y\n"))
        self.assertEqual(self.sb.log("docker.log").count("docker load"), 1)
        self.ok(self.sb.judge("install", "--capsules", "--no-firewall", stdin="y\n"))
        self.assertEqual(self.sb.log("docker.log").count("docker load"), 1)

    def test_rootless_docker_blocks_t2_install_before_any_change(self):
        self._kit()
        self.sb.put("docker_info", "[name=rootless]|Ubuntu|/var/lib/docker\n")
        res = self.sb.judge("install", "--capsules", "--yes")
        self.assertEqual(res.rc, 2)
        self.assertIn("JUDGE_DOCKER", res.codes)
        self.assertEqual(self.sb.log("sudo.log"), "")


class TestRun(FlowCase):
    def test_run_before_install_is_refused(self):
        res = self.sb.judge("run")
        self.assertEqual(res.rc, 2)
        self.assertIn("JUDGE_NOT_INSTALLED", res.codes)

    def test_t1_launch_uses_a_scrubbed_environment(self):
        sc.installed(self.sb)
        self.ok(self.sb.judge("run"))
        env = (self.sb.fake / "app_env.txt").read_text()
        self.assertIn("--ozone-platform=x11", env)
        self.assertIn("DISPLAY=:99", env)
        self.assertIn(f"MV_RECORDING_DESTINATION={self.sb.home}/state/metaviewer/recordings", env)
        self.assertIn("PATH=/usr/local/bin:/usr/bin:/bin", env)
        self.assertNotIn("SECRET_PARENT_VAR", env, "env -i must not leak the parent environment")
        self.assertNotIn("MV_SRF_BIN_DIR", env, "T1 starts the core in its degraded, capsule-free state")
        self.assertNotIn("MV_FAKE_DIR", env)
        self.assertFalse((self.sb.jh / "run" / "metaviewer.pid").exists(), "pidfile removed when the app exits")

    def test_t2_launch_passes_capsule_environment(self):
        sc.installed(self.sb, t2=True)
        self.sb.make_t2_ready()
        self.ok(self.sb.judge("run"))
        env = dict(l.split("=", 1) for l in (self.sb.fake / "app_env.txt").read_text().splitlines() if "=" in l)
        self.assertEqual(env["MV_SRF_LIVE_PROFILE"], "judge")
        self.assertEqual(env["MV_SRF_LIVE_TEXT_INPUT"], "paste")
        self.assertTrue(env["MV_SRF_LIVE_RAM_ROOT"].endswith("/vqa-ramws/opensuperficies/os-cu-0"))
        self.assertEqual(env["MV_SRF_BIN_DIR"], str(self.sb.jh / "deps" / "opensuperficies" / "bin"))
        self.assertEqual(env["SRF_IDENTITY_STORE_ROOT"], str(self.sb.home / "store"))
        self.assertEqual(env["VQA_VE_ROOT"], str(self.sb.jh / "deps" / "vision-engine"))
        self.assertEqual(env["MV_WENDER_ROOT"], str(self.sb.jh / "deps" / "wender-agent"))
        self.assertNotIn("SECRET_PARENT_VAR", env)

    def test_run_refuses_when_preflight_fails_and_does_not_launch(self):
        sc.installed(self.sb)
        (self.sb.fake / "app_env.txt").unlink(missing_ok=True)
        res = self.sb.judge("run", env={"DISPLAY": None})
        self.assertEqual(res.rc, 2)
        self.assertIn("JUDGE_DISPLAY", res.codes)
        self.assertFalse((self.sb.fake / "app_env.txt").exists())

    def test_second_run_while_running_is_refused(self):
        sc.installed(self.sb)
        self.sb.spawn_run()
        res = self.sb.judge("run")
        self.assertEqual(res.rc, 2)
        self.assertIn("JUDGE_RUNNING", res.codes)

    def test_legacy_t2_run_ensures_the_network_first(self):
        sc.installed(self.sb, t2=True, firewall=False)
        self.sb.make_t2_ready()
        (self.sb.fake / "network").unlink()
        (self.sb.fake / "proxy").unlink()
        self.ok(self.sb.judge("run"))
        self.assertIn("docker network create --internal --subnet 172.30.80.0/24 srf-idnet", self.sb.log("docker.log"))


class TestStop(FlowCase):
    def test_stop_without_instance_is_clean(self):
        res = self.ok(self.sb.judge("stop"))
        self.assertIn("JUDGE_STOP_CLEAN", res.out)

    def test_stop_terminates_gracefully_and_reports_clean(self):
        sc.installed(self.sb)
        proc = self.sb.spawn_run()
        res = self.ok(self.sb.judge("stop"))
        self.assertIn("stopped pid", res.out)
        self.assertIn("JUDGE_STOP_CLEAN", res.out)
        proc.communicate(timeout=20)
        self.assertEqual(proc.returncode, 0)
        self.assertFalse((self.sb.jh / "run" / "metaviewer.pid").exists())

    def test_stop_does_not_escalate_to_sigkill(self):
        sc.stop_timeout_bad(self.sb)
        res = self.sb.judge("stop", env={"MV_JUDGE_STOP_WAIT": "1"})
        self.assertEqual(res.rc, 2)
        self.assertIn("JUDGE_STOP_TIMEOUT", res.codes)
        self.assertIn("kill -KILL", res.err)
        self.assertNotIn("JUDGE_STOP_CLEAN", res.out)

    def test_stop_ignores_a_stale_pidfile_of_another_process(self):
        sc.installed(self.sb)
        (self.sb.jh / "run").mkdir(exist_ok=True)
        (self.sb.jh / "run" / "metaviewer.pid").write_text("1\n")
        res = self.ok(self.sb.judge("stop"))
        self.assertIn("no running MetaViewer process", res.out)

    def test_leaks_are_listed_and_refuse_clean(self):
        sc.installed(self.sb)
        self.sb.put("containers", "srf-id-left\nsrf-egress-proxy\n")
        sock = self.sb.home / "state" / "metaviewer" / "srf"
        sock.mkdir(parents=True)
        (sock / "a.sock").write_text("")
        ram = self.sb.shm / "vqa-ramws" / "opensuperficies" / "os-cu-0"
        ram.mkdir(parents=True)
        (ram / "frame0").write_text("")
        adm = self.sb.runuser / str(__import__("os").getuid()) / "metaviewer" / "ram-admission"
        adm.mkdir(parents=True)
        (adm / "rec").write_text("")
        res = self.sb.judge("stop")
        self.assertEqual(res.rc, 2)
        for what in ("container srf-id-left", "socket", "RAM entry", "admission record"):
            self.assertIn("JUDGE_STOP_LEAK: " + what, res.err)
        self.assertNotIn("JUDGE_STOP_CLEAN", res.out)

    def test_stop_stops_scoped_capsules_without_global_net_down(self):
        sc.installed(self.sb, t2=True)
        self.sb.make_t2_ready()
        self.sb.put("containers", "srf-id-judge\nsrf-egress-proxy\n")
        res = self.ok(self.sb.judge("stop"))
        self.assertIn("stop --container srf-id-judge", self.sb.log("srf.log"))
        self.assertNotIn("net down", self.sb.log("srf.log"))
        self.assertIn("JUDGE_STOP_CLEAN", res.out)


if __name__ == "__main__":
    unittest.main()
