"""[TARGET, unit decision] Product evidence is verified from aggregator-local bytes.

Exercise the workflow aggregation against independently available product bytes."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / '.github/workflows/ci.yml'


def workflow_aggregate():
    text = CI.read_text()
    source = textwrap.dedent(text[text.index('          def aggregate('):
                                  text.index('          req = ')])
    namespace = dict(distribution_errors=distribution_errors)
    exec(source, namespace)
    return namespace['aggregate']


class PackageIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='package-Música-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.product = self.root / 'package.tar'
        self.product.write_bytes(b'independent package bytes')
        self.receipt = {'gate_id': 'package', 'outcome': 'PASS', 'rc': 0,
                        'identities': {'gate_revision': 'revision',
                                       'artifact_sha256': 'a' * 64},
                        'product_identity': {'artifact': 'package.tar',
                            'artifact_sha256': hashlib.sha256(self.product.read_bytes()).hexdigest()}}

    def aggregate(self, receipt):
        # The actual workflow function, rather than a second policy implementation.
        aggregate = workflow_aggregate()
        import inspect
        kwargs = ({'product_root': self.root, 'revision': 'revision'}
                  if 'product_root' in inspect.signature(aggregate).parameters else {})
        return aggregate({'package': {'PASS'}}, [receipt],
                         {'package': 'success'}, **kwargs)[0]

    def test_independent_bytes_accepted(self):
        self.assertTrue(self.aggregate(self.receipt))

    def test_self_attested_only_rejected(self):
        del self.receipt['product_identity']
        self.assertFalse(self.aggregate(self.receipt))

    def test_not_applicable_package_rejected(self):
        self.receipt.update(outcome='NOT_APPLICABLE', rc=None, product_identity=None)
        self.assertFalse(self.aggregate(self.receipt))

    def test_forged_artifact_sha256_rejected(self):
        self.receipt['product_identity']['artifact_sha256'] = '0' * 64
        self.assertFalse(self.aggregate(self.receipt))

    def test_changed_bytes_rejected(self):
        self.product.write_bytes(b'tampered')
        self.assertFalse(self.aggregate(self.receipt))

    def test_missing_bytes_rejected(self):
        self.product.unlink()
        self.assertFalse(self.aggregate(self.receipt))

    def test_wrong_revision_rejected(self):
        self.receipt['identities']['gate_revision'] = 'another revision'
        self.assertFalse(self.aggregate(self.receipt))

    def test_path_escape_and_symlink_rejected(self):
        for artifact in ('../package.tar', str(self.product)):
            with self.subTest(artifact=artifact):
                self.receipt['product_identity']['artifact'] = artifact
                self.assertFalse(self.aggregate(self.receipt))
        (self.root / 'link.tar').symlink_to(self.product)
        self.receipt['product_identity']['artifact'] = 'link.tar'
        self.assertFalse(self.aggregate(self.receipt))

    def test_distribution_cli_verifies_bytes_and_fails_closed(self):
        import sys
        for mode in ('valid', 'forged', 'absent', 'malformed', 'not-applicable'):
            receipt = json.loads(json.dumps(self.receipt))
            if mode == 'forged':
                receipt['product_identity']['artifact_sha256'] = '0' * 64
            elif mode == 'absent':
                receipt['product_identity'] = None
            elif mode == 'not-applicable':
                receipt.update(outcome='NOT_APPLICABLE', rc=None)
            result = subprocess.run([sys.executable, str(Path(__file__)), '--distribution'],
                capture_output=True, text=True, env=dict(os.environ,
                    PACKAGE_RECEIPT='{' if mode == 'malformed' else json.dumps(receipt),
                    PRODUCT_ROOT=str(self.root), GITHUB_SHA='revision'))
            with self.subTest(mode=mode):
                self.assertEqual(result.returncode, 0 if mode == 'valid' else 1,
                                 result.stdout + result.stderr)

    def test_hosted_aggregator_checks_receipt(self):
        text = CI.read_text()
        required = text.split('  ci-required:', 1)[1]
        self.assertIn('needs.package.outputs.receipt', required)
        self.assertIn('test_package_identity.py --distribution', required)

    def test_package_reports_null_product_and_fails(self):
        text = CI.read_text().split('  package:', 1)[1].split('  build-macos:', 1)[0]
        body = textwrap.dedent(text.split('        run: |\n', 1)[1])
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'output'
            result = subprocess.run(['bash', '-c', body], cwd=ROOT, capture_output=True,
                text=True, env=dict(os.environ, RUNNER_TEMP=tmp, JOB_ID='package', PLATFORM='x64',
                    GITHUB_RUN_ID='test', GITHUB_SHA='revision', GITHUB_OUTPUT=str(output),
                    GITHUB_STEP_SUMMARY=str(Path(tmp) / 'summary')))
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            receipt = json.loads(next(Path(tmp).rglob('*.receipt.json')).read_text())
            self.assertIsNone(receipt['product_identity'])
            self.assertTrue(receipt['reason'])
            self.assertIn('receipt=', output.read_text())


# Defined below the tests so workflow extraction can share the same verifier.
def distribution_errors(receipt, product_root, revision):
    if not isinstance(receipt, dict):
        return ['missing receipt']
    if receipt.get('gate_id') != 'package' or receipt.get('outcome') != 'PASS' or type(receipt.get('rc')) is not int or receipt['rc'] != 0:
        return ['package did not pass distribution']
    identities = receipt.get('identities')
    if not revision or not isinstance(identities, dict) or identities.get('gate_revision') != revision:
        return ['package revision mismatch']
    product = receipt.get('product_identity')
    if not isinstance(product, dict) or set(product) != {'artifact', 'artifact_sha256'}:
        return ['independent product evidence absent']
    import re
    artifact, digest = product['artifact'], product['artifact_sha256']
    if not isinstance(artifact, str) or not artifact or not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
        return ['invalid product identity']
    relative = Path(artifact)
    if relative.is_absolute() or '..' in relative.parts or product_root is None:
        return ['invalid product path']
    try:
        root = Path(product_root).resolve(strict=True)
        path = root
        for part in relative.parts:
            path = path / part
            if path.is_symlink():
                return ['symlink product path']
        path.resolve(strict=True).relative_to(root)
        if not path.is_file():
            return ['product is not a file']
        # Only bytes present on this runner count; producer log hashes never do.
        with path.open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    except (OSError, ValueError):
        return ['independent product bytes absent']
    return [] if actual == digest else ['artifact_sha256 mismatch']


if __name__ == '__main__':
    import sys
    if sys.argv[1:] == ['--distribution']:
        try:
            receipt = json.loads(os.environ.get('PACKAGE_RECEIPT', 'null'))
        except ValueError:
            receipt = None
        errors = distribution_errors(receipt, os.environ.get('PRODUCT_ROOT'), os.environ.get('GITHUB_SHA'))
        print(('FAIL distribution: ' + '; '.join(errors)) if errors else 'PASS distribution')
        sys.exit(1 if errors else 0)
    unittest.main()
