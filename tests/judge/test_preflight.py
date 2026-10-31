"""Behaviour of scripts/judge/preflight.sh against a sandboxed host (no network, no docker)."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from judge_sandbox import Sandbox  # noqa: E402
import judge_scenarios as sc  # noqa: E402


class PreflightCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.sb = Sandbox(tmp.name)
        self.addCleanup(self.sb.cleanup)

    def pf(self, *args, env=None):
        return self.sb.preflight(*args, env=env)


class TestCleanHost(PreflightCase):
    def test_t0_t1_clean(self):
        for tier in ("T0", "T1"):
            res = self.pf("--tier", tier)
            self.assertEqual(res.rc, 0, res.text)
            self.assertIn(f"JUDGE_PREFLIGHT_OK tier={tier}", res.out)
            self.assertEqual(res.codes, set())

    def test_t2_clean_when_ready(self):
        self.sb.make_t2_ready()
        res = self.pf("--tier", "T2")
        self.assertEqual(res.rc, 0, res.text)
        self.assertEqual(res.codes, set())

    def test_x86_64_host_is_supported_with_matching_binaries(self):
        with tempfile.TemporaryDirectory() as tmp:
            sb = Sandbox(tmp, arch="x86_64")
            self.addCleanup(sb.cleanup)
            sc.fake_installed_app(sb, 62)
            res = sb.preflight("--tier", "T1")
            self.assertEqual(res.rc, 0, res.text)

    def test_facts_report_measured_values(self):
        res = self.pf("--facts")
        self.assertEqual(res.rc, 0, res.text)
        facts = dict(line.split("=", 1) for line in res.out.splitlines())
        self.assertEqual(facts["arch"], "arm64")
        self.assertEqual(facts["nproc"], "20")
        self.assertEqual(facts["mem_total_kib"], str(32 * 1024 * 1024))
        self.assertEqual(facts["network"], "legacy")


class TestRefusals(PreflightCase):
    """One bad scenario per code: typed line, fix text, rc 2 (OS is a warning, USAGE is rc 64)."""

    def test_every_code_fires_with_a_fix_and_the_good_case_is_clean(self):
        for code, (args, bad, good) in sc.PREFLIGHT.items():
            with self.subTest(code=code):
                with tempfile.TemporaryDirectory() as tmp:
                    sb = Sandbox(tmp)
                    env = sc.env_of(bad(sb))
                    res = sb.preflight(*args, env=env)
                    sb.cleanup()
                self.assertIn(code, res.codes, res.text)
                line = next(l for l in res.err.splitlines() if l.startswith(code + ":"))
                if code == "JUDGE_OS":
                    self.assertEqual(res.rc, 0, "JUDGE_OS is a warning, never a refusal")
                    self.assertIn("warning", line)
                elif code == "JUDGE_USAGE":
                    self.assertEqual(res.rc, 64)
                else:
                    self.assertEqual(res.rc, 2, res.text)
                    self.assertIn(" -- fix: ", line, "every refusal prints its fix")
                with tempfile.TemporaryDirectory() as tmp:
                    sb = Sandbox(tmp)
                    env = sc.env_of(good(sb))
                    res = sb.preflight(*sc.PREFLIGHT_GOOD_ARGS.get(code, args), env=env)
                    sb.cleanup()
                self.assertNotIn(code, res.codes, res.text)
                self.assertEqual(res.rc, 0, res.text)

    def test_all_refusals_are_listed_not_just_the_first(self):
        self.sb.put("node_version", "v18.0.0\n")
        self.sb.drop_tool("zip")
        res = self.pf("--tier", "T1", env={"DISPLAY": None})
        self.assertEqual(res.rc, 2)
        self.assertTrue({"JUDGE_NODE", "JUDGE_SYSDEP", "JUDGE_DISPLAY"} <= res.codes, res.text)
        self.assertIn("count=3", res.err)

    def test_sysdep_fix_names_exact_apt_line(self):
        self.sb.drop_tool("zip")
        self.sb.drop_tool("Xvfb")
        res = self.pf("--tier", "T1")
        self.assertIn("sudo apt-get install -y xvfb zip", res.err)
        self.assertEqual(self.pf("--sysdep-packages", "--tier", "T1").out.strip(), "xvfb zip")

    def test_docker_is_a_sysdep_only_at_t2(self):
        self.sb.drop_tool("docker")
        self.assertEqual(self.pf("--tier", "T1").rc, 0)
        res = self.pf("--tier", "T2")
        self.assertIn("docker.io", res.err)

    def test_rootless_engine_is_refused(self):
        self.sb.make_t2_ready()
        self.sb.put("docker_info", "[name=seccomp name=rootless]|Ubuntu|/var/lib/docker\n")
        res = self.pf("--tier", "T2")
        self.assertIn("JUDGE_DOCKER", res.codes)
        self.assertIn("rootless", res.err)

    def test_remote_docker_endpoint_is_refused(self):
        self.sb.make_t2_ready()
        self.sb.put("docker_ctx", "tcp://10.0.0.5:2375\n")
        self.assertIn("JUDGE_DOCKER", self.pf("--tier", "T2").codes)

    def test_docker_context_variable_is_refused_like_docker_host(self):
        self.sb.make_t2_ready()
        res = self.pf("--tier", "T2", env={"DOCKER_CONTEXT": "desktop-linux"})
        self.assertIn("JUDGE_DOCKER_HOST", res.codes)

    def test_wayland_only_session_gets_its_own_message(self):
        res = self.pf("--tier", "T1", env={"DISPLAY": None, "WAYLAND_DISPLAY": "wayland-0"})
        self.assertIn("Wayland-only", res.err)

    def test_unreachable_x_server_is_refused(self):
        self.sb.put("xdpyinfo_rc", "1\n")
        self.assertIn("JUDGE_DISPLAY", self.pf("--tier", "T1").codes)

    def test_shm_that_is_not_tmpfs_is_refused(self):
        self.sb.set_df(shm=("ext4", 8_000_000_000), home=500_000_000_000, docker=500_000_000_000)
        self.assertIn("JUDGE_SHM", self.pf("--tier", "T1").codes)

    def test_t2_needs_more_shm_than_t1(self):
        self.sb.make_t2_ready()
        self.sb.set_df(shm=("tmpfs", 1_000_000_000), home=500_000_000_000, docker=500_000_000_000)
        self.assertEqual(self.pf("--tier", "T1").rc, 0)
        self.assertIn("JUDGE_SHM", self.pf("--tier", "T2").codes)

    def test_ram_threshold_is_floor_plus_one_capsule(self):
        self.sb.make_t2_ready()
        # total 32 GiB -> floor 8 GiB, plus 4 GiB per capsule = 12 GiB needed.
        self.sb.set_meminfo(32 * 1024 * 1024, 12 * 1024 * 1024 - 1)
        self.assertIn("JUDGE_RAM", self.pf("--tier", "T2").codes)
        self.sb.set_meminfo(32 * 1024 * 1024, 12 * 1024 * 1024)
        self.assertNotIn("JUDGE_RAM", self.pf("--tier", "T2").codes)

    def test_ram_floor_is_capped_at_20_gib(self):
        self.sb.make_t2_ready()
        self.sb.set_meminfo(512 * 1024 * 1024, 23 * 1024 * 1024)
        self.assertIn("JUDGE_RAM", self.pf("--tier", "T2").codes)
        self.sb.set_meminfo(512 * 1024 * 1024, 24 * 1024 * 1024)
        self.assertNotIn("JUDGE_RAM", self.pf("--tier", "T2").codes)

    def test_cpuset_accepts_lists_and_can_be_switched_off(self):
        self.sb.make_t2_ready()
        self.sb.set_cpuset("0-9,10,11-14,15")
        self.assertNotIn("JUDGE_CPUSET", self.pf("--tier", "T2").codes)
        self.sb.set_cpuset("0-9,11-19")
        res = self.pf("--tier", "T2")
        self.assertIn("JUDGE_CPUSET", res.codes)
        self.assertIn("cpus 10 ", res.err)
        self.assertNotIn("JUDGE_CPUSET", self.pf("--tier", "T2", env={"MV_JUDGE_REQUIRE_CPUSET": "none"}).codes)

    def test_net_overlap_names_the_conflicting_route(self):
        self.sb.make_t2_ready()
        self.sb.put("ip_route", "default via 10.0.0.1 dev eth0\n172.30.80.0/24 dev tun0 scope link\n172.29.4.0/24 dev docker0\n")
        res = self.pf("--tier", "T2")
        self.assertIn("JUDGE_NET", res.codes)
        self.assertIn("172.30.80.0/24(dev tun0)", res.err)
        self.assertNotIn("docker0", res.err.split("JUDGE_NET")[1].split("--")[0])

    def test_net_overlap_with_open_pool_range_is_refused_even_if_wider(self):
        self.sb.make_t2_ready()
        self.sb.put("ip_route", "172.16.0.0/12 dev wg0 scope link\n")
        self.assertIn("JUDGE_NET", self.pf("--tier", "T2").codes)

    def test_net_fix_points_to_scoped_capsule_install(self):
        self.sb.make_t2_ready()
        (self.sb.fake / "proxy").unlink()
        res = self.pf("--tier", "T2")
        self.assertIn("JUDGE_NET", res.codes)
        self.assertIn("metaviewer-judge.sh install --capsules", res.err)

    def test_open_network_skips_legacy_net_checks_but_needs_the_0_2_image(self):
        self.sb.make_t2_ready()
        (self.sb.fake / "network").unlink()
        self.sb.witness.parent.mkdir(parents=True)
        self.sb.witness.write_text("00ff\n")
        bindir = self.sb.jh / "deps" / "opensuperficies" / "bin"
        bindir.mkdir(parents=True)
        from judge_sandbox import SRF_FAKE
        (bindir / "srf-identity-surface").write_text(SRF_FAKE)
        (bindir / "srf-identity-surface").chmod(0o755)
        self.sb.put("caps", "net_modes=legacy,open\n")
        res = self.pf("--tier", "T2")
        self.assertNotIn("JUDGE_NET", res.codes, res.text)
        self.assertIn("JUDGE_IMAGE", res.codes)
        self.assertIn("identity-browser-arm64:0.2.0", res.err)

    def test_profile_wrong_mode_is_refused_and_content_never_read(self):
        self.sb.make_t2_ready()
        prof = self.sb.home / "store" / "profiles" / "judge"
        (prof / "Cookies").write_text("secret-cookie-bytes")
        prof.chmod(0o755)
        res = self.pf("--tier", "T2")
        self.assertIn("JUDGE_PROFILE", res.codes)
        self.assertNotIn("secret-cookie-bytes", res.text)

    def test_stale_admission_check_degrades_loudly_when_tool_absent(self):
        self.sb.make_t2_ready()
        sc._stale(self.sb, '{"action": "would_remove"}')
        (self.sb.kit / "tools" / "mv_ram_admission.py").unlink()
        res = self.pf("--tier", "T2")
        self.assertNotIn("JUDGE_RAM_STALE: the RAM", res.err)
        self.assertIn("warning", res.err)
        self.assertIn("not checked", res.err)

    def test_bundle_arch_detects_kit_with_other_architecture_tarball(self):
        other = "x64" if self.sb.archn == "arm64" else "arm64"
        (self.sb.assets / f"metaviewer-linux-{other}.tar.gz").write_bytes(b"x")
        res = self.pf("--tier", "T1")
        self.assertIn("JUDGE_BUNDLE_ARCH", res.codes)
        self.assertIn(f"metaviewer-linux-{self.sb.archn}.tar.gz", res.err)

    def test_bundle_arch_checks_srf_binaries_too(self):
        from judge_sandbox import elf
        bindir = self.sb.jh / "deps" / "opensuperficies" / "bin"
        bindir.mkdir(parents=True)
        (bindir / "srf").write_bytes(elf(62 if self.sb.arch == "aarch64" else 183))
        self.assertIn("JUDGE_BUNDLE_ARCH", self.pf("--tier", "T1").codes)

    def test_userns_restricted_with_matching_profile_is_accepted_but_stale_profile_is_not(self):
        self.sb.put("sysctl_kernel.apparmor_restrict_unprivileged_userns", "1\n")
        self.sb.install_profile()
        self.assertEqual(self.pf("--tier", "T1").rc, 0)
        (self.sb.apparmor / "metaviewer-judge").write_text("profile other {}\n")
        self.assertIn("JUDGE_USERNS", self.pf("--tier", "T1").codes)

    def test_unknown_options_are_usage_errors(self):
        for args in (("--bogus",), ("--tier",), ("--phase", "x")):
            with self.subTest(args=args):
                res = self.pf(*args)
                self.assertEqual(res.rc, 64)
                self.assertIn("JUDGE_USAGE", res.codes)

    def test_static_phase_skips_what_install_provides(self):
        self.sb.put("node_version", "v18.0.0\n")
        self.sb.drop_tool("zip")
        res = self.pf("--tier", "T1", "--phase", "static")
        self.assertEqual(res.rc, 0, res.text)


if __name__ == "__main__":
    unittest.main()
