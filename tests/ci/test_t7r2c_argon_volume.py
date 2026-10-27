"""T7 round-2: volume.yml harnesses, budget_gate, check_laws, router_index, and ARG-ci-5 live-main.cjs precondition validation."""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]


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
        for args in (["--version"], []):
            with self.subTest(args=args):
                res = subprocess.run(
                    ["python3", "tools/check_laws.py", *args],
                    cwd=ROOT,
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                self.assertEqual(res.returncode, 0, res.stderr)

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
        vol = yaml.safe_load((ROOT / ".github" / "workflows" / "volume.yml").read_text(encoding="utf-8"))
        jobs = vol["jobs"]
        self.assertEqual(set(jobs), {"volume-property", "volume-mutants", "volume-e2e"})
        expected_timeouts = {"volume-property": 60, "volume-mutants": 60, "volume-e2e": 180}
        for jname, job in jobs.items():
            self.assertEqual(job.get("timeout-minutes"), expected_timeouts[jname], jname)

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
