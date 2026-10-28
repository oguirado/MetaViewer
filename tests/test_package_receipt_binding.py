"""GATES-3: package.yml finish_gate receipt product_identity and configuration_sha256 binding."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_YML = ROOT / '.github/workflows/package.yml'


def extract_gate_script(workflow_text: str) -> str:
    return textwrap.dedent(
        workflow_text.split('      - name: Execute gate and publish receipt\n', 1)[1]
        .split('        run: |\n', 1)[1]
    )


class PackageReceiptBindingTests(unittest.TestCase):
    def run_finish_gate_against_fixture(self, script_text: str):
        build_match = re.search(r'^\(\n  set -e\n.*?^\) > "\$LOG" 2>&1', script_text, re.M | re.S)
        self.assertIsNotNone(build_match, 'build block not found in package.yml gate script')
        build_block = build_match[0]

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            pkg_out = tmp_path / 'pkg-out'
            pkg_out.mkdir(parents=True)
            tarball = pkg_out / 'MetaViewer-linux-x64.tar'
            tarball_bytes = b'fixture-tarball-payload-for-package-receipt-binding\n'
            tarball.write_bytes(tarball_bytes)
            tarball_sha256 = hashlib.sha256(tarball_bytes).hexdigest()

            stub_build = (
                '(\n'
                '  set -e\n'
                '  test -f "$MV_PKG_OUT/MetaViewer-linux-$PLATFORM.tar"\n'
                '  printf \'{"marker":"METAVIEWER_MAIN_SMOKE_OK","tar_sha256":"%s"}\\n\'\n'
                ') > "$LOG" 2>&1'
            ) % tarball_sha256
            runnable = script_text.replace(build_block, stub_build, 1)

            env = dict(
                os.environ,
                RUNNER_TEMP=tmp,
                GITHUB_STEP_SUMMARY=str(tmp_path / 'summary.md'),
                GITHUB_SHA='a' * 40,
                GITHUB_RUN_ID='12345',
                PLATFORM='x64',
                JOB_ID='linux-package',
                SETUP_RESULT='success',
                MV_PKG_OUT=str(pkg_out),
                CARGO_TARGET_DIR=str(tmp_path / 'cargo-target'),
            )
            result = subprocess.run(
                ['bash', '-c', runnable],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            receipt_files = list(tmp_path.rglob('*.receipt.json'))
            self.assertEqual(len(receipt_files), 1)
            receipt = json.loads(receipt_files[0].read_text(encoding='utf-8'))
            return receipt, tarball_sha256

    def verify_receipt_binding(self, receipt: dict, expected_wf_sha: str, expected_tar_sha: str):
        if receipt['identities']['configuration_sha256'] != expected_wf_sha:
            raise AssertionError(
                f"configuration_sha256 mismatch: {receipt['identities']['configuration_sha256']} != {expected_wf_sha}"
            )
        if receipt['identities']['instrument_sha256'] != expected_wf_sha:
            raise AssertionError(
                f"instrument_sha256 mismatch: {receipt['identities']['instrument_sha256']} != {expected_wf_sha}"
            )
        if receipt['identities']['fixture_sha256'] != [expected_wf_sha]:
            raise AssertionError(
                f"fixture_sha256 mismatch: {receipt['identities']['fixture_sha256']} != {[expected_wf_sha]}"
            )
        if receipt['product_identity'] not in (None, expected_tar_sha):
            raise AssertionError(
                f"unexpected product_identity: {receipt['product_identity']!r}"
            )

    def test_finish_gate_binds_configuration_sha256_and_product_identity(self):
        raw_workflow = PACKAGE_YML.read_text(encoding='utf-8')
        expected_wf_sha = hashlib.sha256(PACKAGE_YML.read_bytes()).hexdigest()
        script = extract_gate_script(raw_workflow)

        receipt, tarball_sha256 = self.run_finish_gate_against_fixture(script)
        self.assertEqual(receipt['schema'], 'gate_receipt/v1')
        self.assertEqual(receipt['outcome'], 'PASS')
        self.assertIsNone(receipt['product_identity'])
        self.assertEqual(receipt['identities']['configuration_sha256'], expected_wf_sha)
        self.verify_receipt_binding(receipt, expected_wf_sha, tarball_sha256)

    def test_negative_controls_forged_product_identity_and_corrupted_configuration_sha256(self):
        raw_workflow = PACKAGE_YML.read_text(encoding='utf-8')
        expected_wf_sha = hashlib.sha256(PACKAGE_YML.read_bytes()).hexdigest()
        script = extract_gate_script(raw_workflow)

        # Surviving mutation 1: changing `'product_identity': None,` to `'product_identity': 'forged',`
        anchor_pi = "'product_identity': None,"
        self.assertIn(anchor_pi, script)
        mutated_pi_script = script.replace(anchor_pi, "'product_identity': 'forged',", 1)
        forged_receipt, tarball_sha256 = self.run_finish_gate_against_fixture(mutated_pi_script)
        with self.assertRaisesRegex(AssertionError, 'unexpected product_identity'):
            self.verify_receipt_binding(forged_receipt, expected_wf_sha, tarball_sha256)

        # Surviving mutation 2: corrupting `configuration_sha256` in finish_gate
        anchor_cfg = "'configuration_sha256': e['WF_SHA']"
        self.assertIn(anchor_cfg, script)
        mutated_cfg_script = script.replace(anchor_cfg, "'configuration_sha256': '0' * 64", 1)
        corrupted_receipt, tarball_sha256 = self.run_finish_gate_against_fixture(mutated_cfg_script)
        with self.assertRaisesRegex(AssertionError, 'configuration_sha256 mismatch'):
            self.verify_receipt_binding(corrupted_receipt, expected_wf_sha, tarball_sha256)


if __name__ == '__main__':
    unittest.main()
