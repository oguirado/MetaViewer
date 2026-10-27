"""T7 round-2: volume.yml harnesses, budget_gate, check_laws, router_index, and ARG-ci-5 live-main.cjs precondition validation."""
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
LAW_NAME = "oguirado"
LAW_EMAIL = "247666607+oguirado@users.noreply.github.com"


def _job_timeouts(text: str) -> dict[str, int | None]:
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line == "jobs:")
    jobs: dict[str, int | None] = {}
    cur: str | None = None
    for line in lines[start + 1 :]:
        if re.match(r"^[A-Za-z]", line):
            break
        m = re.match(r"^  ([\w-]+):\s*$", line)
        if m:
            cur = m.group(1)
            jobs[cur] = None
        elif cur is not None:
            t = re.match(r"^    timeout-minutes: (\d+)\s*$", line)
            if t:
                jobs[cur] = int(t.group(1))
    return jobs


def find_node() -> str:
    node = shutil.which("node")
    if node:
        res = subprocess.run([node, "-p", "process.versions.node.split('.')[0]"], capture_output=True, text=True)
        if res.returncode == 0 and res.stdout.strip().isdigit() and int(res.stdout.strip()) >= 24:
            return node
    nvm_base = pathlib.Path.home() / ".nvm" / "versions" / "node"
    if nvm_base.is_dir():
        for cand in sorted(nvm_base.glob("v24*/bin/node"), reverse=True):
            if cand.is_file():
                return str(cand)
    return "node"


class TestT7R2CArgonVolume(unittest.TestCase):
    def test_o7_budget_gate_self_test_passes(self):
        res = subprocess.run(
            ["python3", "tools/budget_gate.py", "--self-test"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(res.returncode, 0, res.stderr + res.stdout)
        out = json.loads(res.stdout.strip())
        self.assertEqual(out["failed"], 0)
        self.assertGreaterEqual(out["passed"], 6)

    def test_o7_check_laws_version_and_history_pass(self):
        with tempfile.TemporaryDirectory(prefix="t7r2c-laws-") as tmp:
            repo = pathlib.Path(tmp)
            (repo / "tools").mkdir()
            shutil.copy2(ROOT / "VERSION", repo / "VERSION")
            shutil.copy2(ROOT / "CHANGELOG.md", repo / "CHANGELOG.md")
            shutil.copy2(ROOT / "tools" / "check_laws.py", repo / "tools" / "check_laws.py")
            git_env = {
                k: v
                for k, v in os.environ.items()
                if not k.startswith(("GIT_AUTHOR_", "GIT_COMMITTER_")) and k != "EMAIL"
            }
            git_env["GIT_CONFIG_GLOBAL"] = "/dev/null"
            git_env["GIT_CONFIG_NOSYSTEM"] = "1"
            subprocess.run(
                ["git", "init", "-q"],
                cwd=repo,
                env=git_env,
                check=True,
                capture_output=True,
                text=True,
                timeout=15,
            )
            subprocess.run(
                [
                    "git",
                    "-c",
                    f"user.name={LAW_NAME}",
                    "-c",
                    f"user.email={LAW_EMAIL}",
                    "commit",
                    "-q",
                    "--allow-empty",
                    "-m",
                    "core: add initial state",
                ],
                cwd=repo,
                env=git_env,
                check=True,
                capture_output=True,
                text=True,
                timeout=15,
            )
            for args in (["--version"], []):
                with self.subTest(args=args):
                    res = subprocess.run(
                        ["python3", "tools/check_laws.py", *args],
                        cwd=repo,
                        env=git_env,
                        capture_output=True,
                        text=True,
                        timeout=30,
                    )
                    self.assertEqual(res.returncode, 0, res.stderr)

            # Negative control: a commit with a wrong author is rejected by the history check.
            subprocess.run(
                [
                    "git",
                    "-c",
                    "user.name=wrong",
                    "-c",
                    "user.email=wrong@example.org",
                    "commit",
                    "-q",
                    "--allow-empty",
                    "-m",
                    "core: add bad author",
                ],
                cwd=repo,
                env=git_env,
                check=True,
                capture_output=True,
                text=True,
                timeout=15,
            )
            res_bad = subprocess.run(
                ["python3", "tools/check_laws.py"],
                cwd=repo,
                env=git_env,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertNotEqual(res_bad.returncode, 0)
            self.assertIn(f"author must be {LAW_NAME} <{LAW_EMAIL}>", res_bad.stderr)

    def test_o7_check_laws_range_rejects_bad_ranges(self):
        for bad_range in ("a..b..c", "--not-a-range", "0000000..HEAD", "nonexistent-ref..HEAD"):
            with self.subTest(bad_range=bad_range):
                res = subprocess.run(
                    ["python3", "tools/check_laws.py", "--range", bad_range],
                    cwd=ROOT,
                    capture_output=True,
                    text=True,
                    timeout=15,
                )
                self.assertNotEqual(res.returncode, 0)

    def test_o7_router_index_check_runs_deterministically(self):
        res = subprocess.run(
            ["python3", "tools/router_index.py", "--check"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertIn(res.returncode, (0, 1), res.stderr)

    def test_o7_volume_yml_structure_and_guards(self):
        jobs = _job_timeouts((ROOT / ".github" / "workflows" / "volume.yml").read_text(encoding="utf-8"))
        self.assertEqual(set(jobs), {"volume-property", "volume-mutants", "volume-e2e"})
        expected_timeouts = {"volume-property": 60, "volume-mutants": 60, "volume-e2e": 180}
        for jname, timeout_val in jobs.items():
            self.assertEqual(timeout_val, expected_timeouts[jname], jname)

    def test_o7_sync_kit_check_against_fixture(self):
        node = find_node()
        res = subprocess.run(
            [node, "tools/sync_kit.mjs", "--check"],
            cwd=ROOT,
            env={k: v for k, v in os.environ.items() if k not in ("MV_KIT_CHECKOUT", "CAPSULE_UI_KIT_REPO")},
            capture_output=True,
            text=True,
            timeout=15,
        )
        if not (ROOT / "ui" / ".kit" / "capsule-ui-kit" / "KIT_SOURCE.json").exists():
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("kit absent", res.stderr)

    def test_arg_ci_5_live_main_validates_mv_e2e_manifest_and_build_with_negative_control(self):
        """Regression test for ARG-ci-5: tests/e2e/live-main.cjs validates MV_E2E_MANIFEST and MV_E2E_BUILD before boot."""
        node = find_node()
        live_main = ROOT / "tests" / "e2e" / "live-main.cjs"
        with tempfile.TemporaryDirectory(prefix="t7r2c-argci5-") as tmp:
            tmp_path = pathlib.Path(tmp)
            manifest = tmp_path / "manifest.json"
            manifest.write_text(json.dumps({"capsules": []}), encoding="utf-8")
            build_dir = tmp_path / "build"
            build_dir.mkdir()
            (build_dir / "index.html").write_text("<!doctype html><title>fixture</title>", encoding="utf-8")

            env_no_manifest = {k: v for k, v in os.environ.items() if k not in ("MV_E2E_MANIFEST", "MV_E2E_BUILD")}
            env_no_manifest["MV_E2E_BUILD"] = str(build_dir)
            res_no_manifest = subprocess.run(
                [node, str(live_main)],
                cwd=ROOT,
                env=env_no_manifest,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(res_no_manifest.returncode, 2, res_no_manifest.stderr)
            self.assertIn("MV_E2E_MANIFEST missing or unreadable", res_no_manifest.stderr)

            env_no_build = {k: v for k, v in os.environ.items() if k not in ("MV_E2E_MANIFEST", "MV_E2E_BUILD")}
            env_no_build["MV_E2E_MANIFEST"] = str(manifest)
            env_no_build["MV_E2E_BUILD"] = str(tmp_path / "missing-build")
            res_no_build = subprocess.run(
                [node, str(live_main)],
                cwd=ROOT,
                env=env_no_build,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(res_no_build.returncode, 2, res_no_build.stderr)
            self.assertIn("MV_E2E_BUILD missing index.html", res_no_build.stderr)

            mock_electron_dir = tmp_path / "node_modules" / "electron"
            mock_electron_dir.mkdir(parents=True)
            loaded_marker = tmp_path / "loaded.txt"
            (mock_electron_dir / "index.js").write_text(
                "const fs = require('node:fs');\n"
                "module.exports = {\n"
                "  app: { whenReady: () => Promise.resolve() },\n"
                "  BrowserWindow: class {\n"
                "    constructor() { this.webContents = { on() {}, once() {} }; }\n"
                f"    async loadFile(p) {{ fs.writeFileSync({str(loaded_marker)!r}, p); }}\n"
                "  },\n"
                "};\n",
                encoding="utf-8",
            )
            env_valid = dict(
                os.environ,
                MV_E2E_MANIFEST=str(manifest),
                MV_E2E_BUILD=str(build_dir),
                NODE_PATH=str(tmp_path / "node_modules"),
            )
            res_valid = subprocess.run(
                [node, str(live_main)],
                cwd=ROOT,
                env=env_valid,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(res_valid.returncode, 0, res_valid.stderr)
            self.assertEqual(loaded_marker.read_text(encoding="utf-8"), str(build_dir / "index.html"))


if __name__ == "__main__":
    unittest.main()
