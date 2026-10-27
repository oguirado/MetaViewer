"""[TARGET, unit decision] Execute FX2-PACKAGE regression suite under tests/ci unit leg."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from urllib.request import pathname2url

ROOT = Path(__file__).resolve().parents[2]
SUITE = ROOT / 'ui/tools/test_package_clean_install.mjs'


def find_node() -> str:
    env_node = os.environ.get('NODE')
    if env_node and shutil.which(env_node):
        return shutil.which(env_node) or env_node
    node = shutil.which('node')
    if node:
        res = subprocess.run(
            [node, '-p', "process.versions.node.split('.')[0]"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if res.returncode == 0 and res.stdout.strip().isdigit() and int(res.stdout.strip()) >= 24:
            return node
    nvm_base = Path.home() / '.nvm/versions/node'
    if nvm_base.is_dir():
        for cand in sorted(nvm_base.glob('v24*/bin/node'), reverse=True):
            if cand.is_file():
                return str(cand)
    raise RuntimeError('node >= 24 required, none found')


def suite_url() -> str:
    return 'file://' + pathname2url(str(SUITE.resolve()))


class Fx2PackageRegressionTests(unittest.TestCase):
    def test_package_clean_install_and_round2_regressions(self):
        node = find_node()
        probe_script = (
            f"import {{ checkCleanCiReproPrerequisites }} from {json.dumps(suite_url())};\n"
            "const prereq = await checkCleanCiReproPrerequisites(process.env);\n"
            "console.log('PREREQ_JSON:' + JSON.stringify(prereq));\n"
        )
        probe = subprocess.run(
            [node, '--input-type=module', '-e', probe_script],
            cwd=ROOT,
            env=dict(os.environ, MV_CHECK_CLEAN_CI_PREREQ_ONLY='1'),
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(
            probe.returncode,
            0,
            msg=f"checkCleanCiReproPrerequisites probe failed:\nSTDOUT:\n{probe.stdout}\nSTDERR:\n{probe.stderr}",
        )
        json_line = next((line for line in probe.stdout.splitlines() if line.startswith('PREREQ_JSON:')), '')
        self.assertTrue(json_line, f"missing PREREQ_JSON line in:\n{probe.stdout}\n{probe.stderr}")
        prereq = json.loads(json_line[len('PREREQ_JSON:'):])
        self.assertIn(
            prereq.get('code'),
            (
                'PKG_CLEAN_CI_PREREQ_OK',
                'PKG_CLEAN_CI_PREREQ_ELECTRON_MISSING',
                'PKG_CLEAN_CI_PREREQ_NPM_CACHE_MISSING',
            ),
        )
        print(
            f"FX2_CLEAN_CI_PREREQ code={prereq['code']} ok={prereq['ok']} reason={prereq.get('reason', '')}",
            file=sys.stderr,
        )
        if (
            os.environ.get('MV_REQUIRE_CLEAN_CI_REPRO') == '1'
            or os.environ.get('MV_RUN_CLEAN_NPM_CI_REPRO') == '1'
        ):
            self.assertTrue(
                prereq['ok'],
                msg=f"clean CI repro required but prerequisite check returned {prereq}",
            )
        run_env = dict(os.environ)
        if 'MV_RUN_CLEAN_NPM_CI_REPRO' not in run_env:
            run_env['MV_RUN_CLEAN_NPM_CI_REPRO'] = '1' if prereq['ok'] else '0'
        result = subprocess.run(
            [node, '--test', str(SUITE)],
            cwd=ROOT,
            env=run_env,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        self.assertEqual(
            result.returncode,
            0,
            msg=f"ui/tools/test_package_clean_install.mjs failed:\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}",
        )

    def test_fx2_explicit_run_flag_not_clobbered_when_prereq_missing(self):
        with unittest.mock.patch.dict(os.environ, {}, clear=False):
            with tempfile.TemporaryDirectory(prefix='mv-fx2-rv9-') as tmp:
                empty_home = Path(tmp) / 'empty-home'
                empty_home.mkdir()
                base_env = dict(
                    os.environ,
                    HOME=str(empty_home),
                    XDG_CACHE_HOME=str(empty_home / '.cache'),
                    ELECTRON_CACHE=str(empty_home / '.cache/electron'),
                    electron_config_cache=str(empty_home / '.cache/electron'),
                    ELECTRON_OVERRIDE_DIST_PATH=str(empty_home / 'missing-dist'),
                    npm_config_cache=str(empty_home / '.npm'),
                    NODE=find_node(),
                )
                base_env.pop('MV_REQUIRE_CLEAN_CI_REPRO', None)
                base_env.pop('MV_RUN_CLEAN_NPM_CI_REPRO', None)
                base_env.pop('CI', None)

                for flag in ('MV_RUN_CLEAN_NPM_CI_REPRO', 'MV_REQUIRE_CLEAN_CI_REPRO'):
                    with self.subTest(flag=flag):
                        env = dict(base_env, **{flag: '1'})
                        proc = subprocess.run(
                            [
                                sys.executable,
                                '-m',
                                'unittest',
                                'tests.ci.test_fx2_package.Fx2PackageRegressionTests.test_package_clean_install_and_round2_regressions',
                            ],
                            cwd=ROOT,
                            env=env,
                            capture_output=True,
                            text=True,
                            timeout=30,
                        )
                        self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)
                        self.assertIn('PKG_CLEAN_CI_PREREQ_ELECTRON_MISSING', proc.stdout + proc.stderr)

                ci_env = dict(base_env, CI='true')
                ci_proc = subprocess.run(
                    [
                        sys.executable,
                        '-m',
                        'unittest',
                        'tests.ci.test_fx2_package.Fx2PackageRegressionTests.test_package_clean_install_and_round2_regressions',
                    ],
                    cwd=ROOT,
                    env=ci_env,
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                self.assertEqual(ci_proc.returncode, 0, ci_proc.stdout + ci_proc.stderr)
                self.assertIn(
                    'FX2_CLEAN_CI_PREREQ code=PKG_CLEAN_CI_PREREQ_ELECTRON_MISSING ok=False',
                    ci_proc.stdout + ci_proc.stderr,
                )

    def test_find_node_rejects_under_version_node(self):
        with tempfile.TemporaryDirectory(prefix='mv-node20-') as tmp:
            td = Path(tmp)
            stub_node = td / 'node'
            stub_node.write_text('#!/bin/sh\necho 20\n', encoding='utf-8')
            stub_node.chmod(0o755)
            empty_home = td / 'home'
            empty_home.mkdir()
            with unittest.mock.patch.dict(
                os.environ,
                {'PATH': str(td), 'HOME': str(empty_home)},
                clear=False,
            ):
                os.environ.pop('NODE', None)
                with self.assertRaisesRegex(RuntimeError, 'node >= 24 required'):
                    find_node()


if __name__ == '__main__':
    unittest.main()
