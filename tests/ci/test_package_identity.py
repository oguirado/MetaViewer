"""[TARGET, unit decision] Product evidence is verified from aggregator-local bytes.

Exercise the workflow aggregation against independently available product bytes."""
import hashlib
import json
import os
import platform
from pathlib import Path
import re
import subprocess
import tarfile
import io
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / '.github/workflows/ci.yml'


def workflow_aggregate():
    text = CI.read_text()
    f4_head = textwrap.dedent(text[text.index('          RKEYS = '):
                                   text.index('          genuine = ')])
    agg_src = textwrap.dedent(text[text.index('          def aggregate('):
                                   text.index('          req = ')])
    import re
    namespace = dict(re=re, hashlib=hashlib, os=os, distribution_errors=distribution_errors)
    exec(f4_head + '\n' + agg_src, namespace)
    return namespace['aggregate']


class PackageIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='package-Música-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.product = self.root / 'package.tar'
        self.write_product()
        self.evidence = {'artifact': 'package.tar',
            'artifact_sha256': hashlib.sha256(self.product.read_bytes()).hexdigest(),
            'manifest_sha256': hashlib.sha256(self.manifest).hexdigest(),
            'architecture': 'arm64', 'smoke_marker': 'METAVIEWER_MAIN_SMOKE_OK'}
        (self.root / 'product-evidence.json').write_text(json.dumps(self.evidence))
        self.receipt = {'schema': 'gate_receipt/v1', 'gate_id': 'package', 'leg': 'package',
                        'profile': 'W0', 'owner': 'W0-CI-MATRIX', 'issuer': 'CI/package/1 [VM]',
                        'argv': ['python3', 'tests/ci/test_package_identity.py', '--build'],
                        'cwd': '/tmp', 'outcome': 'PASS', 'rc': 0, 'reason': 'ok',
                        'scope': {'unit': 'W0-CI-MATRIX', 'platform': 'arm64',
                                  'feature': 'package', 'artifact': 'package.receipt.json'},
                        'identities': {'gate_revision': 'revision',
                                       'instrument_sha256': 'a' * 64,
                                       'sanitized_log_sha256': 'b' * 64,
                                       'configuration_sha256': hashlib.sha256(CI.read_bytes()).hexdigest(),
                                       'log_sha256': 'd' * 64,
                                       'fixture_sha256': ['a' * 64]},
                        'product_identity': dict(self.evidence),
                        'assertions': [{'id': 'exit-status', 'expected': 'rc 0',
                                        'observed': 'rc 0', 'accepted': True}],
                        'counts': {'passed': None, 'failed': None, 'skipped': None,
                                   'source': 'unparsed:package-smoke'}}

    def write_product(self, machine=183, arch='arm64', extra_members=(), manifest_override=None, omit_members=()):
        binary = bytearray(64)
        binary[:6] = b'\x7fELF\x02\x01'
        binary[18:20] = machine.to_bytes(2, 'little')
        files = [('metaviewer', 0o755, bytes(binary)),
                 ('resources/bin/metaviewer-core', 0o755, bytes(binary)),
                 ('resources/bin/mv-daemon-adapter', 0o755, bytes(binary)),
                 ('INSTALL.md', 0o644, b'# MetaViewer\n')]
        if manifest_override is None:
            self.manifest = ''.join(
                f'{hashlib.sha256(data).hexdigest()} {mode:04o}  {name}\n' for name, mode, data in files
            ).encode()
        else:
            self.manifest = manifest_override
        with tarfile.open(self.product, 'w') as archive:
            for name, mode, data in [(f'MetaViewer-linux-{arch}.sha256', 0o644, self.manifest),
                    *[(f'MetaViewer-linux-{arch}/{name}', mode, data) for name, mode, data in files
                      if name not in omit_members],
                    *[(name, 0o644, data) for name, data in extra_members]]:
                entry = tarfile.TarInfo(name)
                entry.mode = mode
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))

    def test_wrong_architecture_bytes_rejected(self):
        self.write_product(machine=62)
        self.receipt['product_identity']['artifact_sha256'] = hashlib.sha256(self.product.read_bytes()).hexdigest()
        self.receipt['product_identity']['manifest_sha256'] = hashlib.sha256(self.manifest).hexdigest()
        (self.root / 'product-evidence.json').write_text(json.dumps(self.receipt['product_identity']))
        self.assertFalse(self.aggregate(self.receipt))

    def test_missing_or_forged_smoke_and_manifest_rejected(self):
        for key, value in [('smoke_marker', ''), ('manifest_sha256', '0' * 64),
                           ('architecture', 'x64')]:
            with self.subTest(key=key):
                self.receipt['product_identity'] = dict(self.evidence, **{key: value})
                (self.root / 'product-evidence.json').write_text(json.dumps(self.receipt['product_identity']))
                self.assertFalse(self.aggregate(self.receipt))
        (self.root / 'product-evidence.json').unlink()
        self.receipt['product_identity'] = dict(self.evidence)
        self.assertFalse(self.aggregate(self.receipt))

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

    def test_each_architecture_requires_own_bytes_and_evidence(self):
        for arch, machine in [('arm64', 183), ('x64', 62)]:
            with self.subTest(arch=arch):
                self.write_product(machine=machine, arch=arch)
                evidence = dict(self.evidence, architecture=arch,
                    artifact_sha256=hashlib.sha256(self.product.read_bytes()).hexdigest(),
                    manifest_sha256=hashlib.sha256(self.manifest).hexdigest())
                self.receipt.update(scope=dict(self.receipt['scope'], platform=arch), product_identity=evidence)
                (self.root / 'product-evidence.json').write_text(json.dumps(evidence))
                self.assertTrue(self.aggregate(self.receipt))
                other = 'x64' if arch == 'arm64' else 'arm64'
                self.assertTrue(distribution_errors(self.receipt, self.root, 'revision', other))
                self.write_product(machine=62 if machine == 183 else 183, arch=arch)
                evidence['artifact_sha256'] = hashlib.sha256(self.product.read_bytes()).hexdigest()
                evidence['manifest_sha256'] = hashlib.sha256(self.manifest).hexdigest()
                (self.root / 'product-evidence.json').write_text(json.dumps(evidence))
                self.assertIn('wrong product architecture', distribution_errors(
                    self.receipt, self.root, 'revision', arch))
                self.product.write_bytes(b'tampered')
                self.assertFalse(self.aggregate(self.receipt))
                self.product.unlink()
                self.assertFalse(self.aggregate(self.receipt))

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
        # [TARGET, unit decision] Match the CLI's explicit platform contract,
        # including hosted ci-policy's inherited PLATFORM=x64. Exercise both
        # architectures so host defaults cannot hide a mismatched fixture.
        for arch, machine in (('arm64', 183), ('x64', 62)):
            self.write_product(machine=machine, arch=arch)
            evidence = dict(self.evidence, architecture=arch,
                artifact_sha256=hashlib.sha256(self.product.read_bytes()).hexdigest(),
                manifest_sha256=hashlib.sha256(self.manifest).hexdigest())
            (self.root / 'product-evidence.json').write_text(json.dumps(evidence))
            for mode in ('valid', 'forged', 'absent', 'malformed', 'not-applicable', 'wrong-arch', 'forged-config'):
                receipt = json.loads(json.dumps(self.receipt))
                receipt.update(scope=dict(self.receipt['scope'], platform=arch), product_identity=dict(evidence))
                if mode == 'forged':
                    receipt['product_identity']['artifact_sha256'] = '0' * 64
                elif mode == 'forged-config':
                    receipt['identities']['configuration_sha256'] = 'f' * 64
                elif mode == 'absent':
                    receipt['product_identity'] = None
                elif mode == 'not-applicable':
                    receipt.update(outcome='NOT_APPLICABLE', rc=None)
                result = subprocess.run([sys.executable, str(Path(__file__)), '--distribution'],
                    capture_output=True, text=True, env=dict(os.environ,
                        PLATFORM=('x64' if arch == 'arm64' else 'arm64') if mode == 'wrong-arch' else arch,
                        PACKAGE_RECEIPT='{' if mode == 'malformed' else json.dumps(receipt),
                        PRODUCT_ROOT=str(self.root), GITHUB_SHA='revision'))
                with self.subTest(arch=arch, mode=mode):
                    self.assertEqual(result.returncode, 0 if mode == 'valid' else 1,
                                     result.stdout + result.stderr)

    def test_manifest_inventory_and_extra_members_rejected(self):
        import sys
        modeless = ''.join(
            re.sub(r'^([0-9a-f]{64}) [0-7]{4}  ', r'\1  ', line) + '\n'
            for line in self.manifest.decode('utf-8').splitlines()
        ).encode('utf-8')
        self.write_product(manifest_override=modeless)
        evidence = dict(self.evidence,
            artifact_sha256=hashlib.sha256(self.product.read_bytes()).hexdigest(),
            manifest_sha256=hashlib.sha256(self.manifest).hexdigest())
        self.receipt['product_identity'] = evidence
        (self.root / 'product-evidence.json').write_text(json.dumps(evidence))
        self.assertTrue(self.aggregate(self.receipt))
        self.write_product()
        default_manifest = self.manifest.decode('utf-8')
        tampered_mode = default_manifest.replace(' 0755  metaviewer\n', ' 0644  metaviewer\n', 1).encode('utf-8')
        invalid_mode = default_manifest.replace(' 0755  metaviewer\n', ' 0999  metaviewer\n', 1).encode('utf-8')
        for label, extra, omit, override, expected_err in [
            ('extra-root', [('evil-extra', b'evil')], (), None, 'unexpected archive member'),
            ('extra-nested', [('MetaViewer-linux-arm64/evil-extra', b'evil')], (), None,
             "archive member inventory mismatch: ['MetaViewer-linux-arm64/evil-extra']"),
            ('missing-member', (), ('INSTALL.md',), None,
             "archive member inventory mismatch: ['MetaViewer-linux-arm64/INSTALL.md']"),
            ('extra-and-missing', [('MetaViewer-linux-arm64/evil-extra', b'evil')], ('INSTALL.md',), None,
             "archive member inventory mismatch: ['MetaViewer-linux-arm64/INSTALL.md', 'MetaViewer-linux-arm64/evil-extra']"),
            ('garbage-manifest', (), (), b'fixture manifest bytes\n', 'invalid manifest inventory line'),
            ('invalid-mode', (), (), invalid_mode, 'invalid manifest inventory line'),
            ('tampered-mode', (), (), tampered_mode, 'manifest member mode mismatch'),
            ('tampered-line', (), (), f"{'0' * 64}  metaviewer\n".encode(),
             "archive member inventory mismatch: ['MetaViewer-linux-arm64/INSTALL.md', 'MetaViewer-linux-arm64/resources/bin/metaviewer-core', 'MetaViewer-linux-arm64/resources/bin/mv-daemon-adapter']"),
        ]:
            with self.subTest(case=label):
                self.write_product(extra_members=extra, manifest_override=override, omit_members=omit)
                evidence = dict(self.evidence,
                    artifact_sha256=hashlib.sha256(self.product.read_bytes()).hexdigest(),
                    manifest_sha256=hashlib.sha256(self.manifest).hexdigest())
                self.receipt['product_identity'] = evidence
                (self.root / 'product-evidence.json').write_text(json.dumps(evidence))
                self.assertEqual(distribution_errors(self.receipt, self.root, 'revision', 'arm64'), [expected_err])
                self.assertFalse(self.aggregate(self.receipt))
                if label in ('extra-nested', 'missing-member'):
                    cli = subprocess.run([sys.executable, str(Path(__file__)), '--distribution'],
                        capture_output=True, text=True, env=dict(os.environ,
                            PLATFORM='arm64', PACKAGE_RECEIPT=json.dumps(self.receipt),
                            PRODUCT_ROOT=str(self.root), GITHUB_SHA='revision'))
                    self.assertEqual(cli.returncode, 1)
                    self.assertIn(expected_err, cli.stdout)

    def test_hosted_aggregator_checks_receipt(self):
        text = CI.read_text()
        required = text.split('  ci-required:', 1)[1]
        self.assertIn('needs.package.outputs.receipt', required)
        self.assertIn('test_package_identity.py --distribution', required)

    def test_producer_receipt_requires_successful_build(self):
        text = CI.read_text().split('  package:', 1)[1].split('  build-macos:', 1)[0]
        body = textwrap.dedent(text.split('      - name: Build and witness package\n', 1)[1].split('        run: |\n', 1)[1])
        for mode in ('valid', 'valid-x64', 'failed-build', 'wrong-arch', 'failed-setup'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp:
                output = Path(tmp) / 'output'
                expected = dict(self.evidence, architecture='x64' if mode == 'valid-x64' else 'arm64')
                (self.root / 'product-evidence.json').write_text(json.dumps(expected))
                # Stub the external builder only; execute the real receipt writer.
                script = body.replace('python3 tests/ci/test_package_identity.py --build > "$LOG" 2>&1',
                                      '(exit %d) > "$LOG" 2>&1' % (7 if mode == 'failed-build' else 0))
                result = subprocess.run(['bash', '-c', script], cwd=ROOT, capture_output=True,
                    text=True, env=dict(os.environ, RUNNER_TEMP=tmp, JOB_ID='package',
                        PLATFORM='riscv64' if mode == 'wrong-arch' else 'x64' if mode == 'valid-x64' else 'arm64',
                        SETUP_RESULT='failure' if mode == 'failed-setup' else 'success',
                        MV_PKG_OUT=str(self.root), GITHUB_RUN_ID='test', GITHUB_SHA='revision',
                        GITHUB_OUTPUT=str(output), GITHUB_STEP_SUMMARY=tmp + '/summary'))
                receipt = json.loads(next(Path(tmp).rglob('*.receipt.json')).read_text())
                self.assertEqual(result.returncode == 0, mode in ('valid', 'valid-x64'), result.stderr)
                self.assertEqual(receipt['outcome'], 'PASS' if mode in ('valid', 'valid-x64') else 'FAIL')
                self.assertEqual(receipt['product_identity'], expected if mode in ('valid', 'valid-x64') else None)
                self.assertIn('receipt_' , output.read_text())

    def test_build_requires_real_smoke_marker(self):
        from unittest.mock import patch
        for mode in ('valid', 'missing-marker', 'failed-command'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp:
                output = Path(tmp)
                (output / 'MetaViewer-linux-arm64.tar').write_bytes(b'fixture')
                (output / 'MetaViewer-linux-arm64.sha256').write_bytes(b'manifest')
                marker = 'METAVIEWER_MAIN_SMOKE_OK' if mode == 'valid' else ''
                smoke = json.dumps({'marker': marker, 'source_access': False, 'negative_controls': 'PASS'})
                calls = [subprocess.CompletedProcess([], 7 if mode == 'failed-command' else 0, ''),
                         subprocess.CompletedProcess([], 0, ''), subprocess.CompletedProcess([], 0, smoke)]
                with patch.dict(os.environ, MV_PKG_OUT=tmp, PLATFORM='arm64'), patch.object(subprocess, 'run', side_effect=calls) as runner:
                    if mode == 'valid':
                        build_evidence()
                        self.assertEqual(runner.call_count, 3)
                        self.assertIn('--verify-install', runner.call_args_list[1].args[0])
                        self.assertIn('--smoke', runner.call_args_list[2].args[0])
                        self.assertTrue(all(call.args[0][:2] == ['bash', '.github/workflows/offline.sh'] for call in runner.call_args_list))
                    else:
                        with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                            build_evidence()
                    self.assertEqual((output / 'product-evidence.json').exists(), mode == 'valid')

    def test_package_reports_null_product_and_fails(self):
        text = CI.read_text().split('  package:', 1)[1].split('  build-macos:', 1)[0]
        body = textwrap.dedent(text.split('      - name: Build and witness package\n', 1)[1].split('        run: |\n', 1)[1])
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
            self.assertIn('receipt_' , output.read_text())

    def test_aggregate_rejects_package_spoofing_budgets(self):
        text = CI.read_text().split('  ci-required:\n', 1)[1]
        body = textwrap.dedent(text.split('      - name: Aggregate required results\n', 1)[1].split('        run: |\n', 1)[1])
        rendered = re.sub(r'\$\{\{\s*job\.status\s*\}\}', 'success', body)
        rendered = re.sub(r'\$\{\{\s*needs\.[\w-]+\.result\s*\}\}', 'success', rendered)
        spoofed = json.loads(json.dumps(self.receipt))
        spoofed['gate_id'] = 'budgets'
        spoofed['leg'] = 'budgets'
        spoofed['identities']['gate_revision'] = 'a' * 40
        with tempfile.TemporaryDirectory() as tmp:
            summary = Path(tmp) / 'summary.md'
            summary.write_text('')
            env = dict(os.environ, GITHUB_STEP_SUMMARY=str(summary),
                       RUNNER_TEMP='', MV_REQUIRED_RECEIPTS_DIR='',
                       MV_REQUIRED_RECEIPTS='budgets',
                       PACKAGE_RECEIPT=json.dumps(spoofed))
            result = subprocess.run(['bash', '-e', '-u', '-o', 'pipefail', '-c', rendered],
                                    cwd=ROOT, capture_output=True, text=True, env=env, timeout=15)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('mismatched gate_id', result.stdout + result.stderr)
            self.assertIn('FAIL required receipt missing: budgets', result.stdout + result.stderr)

    def test_package_receipt_selector_has_no_cross_arch_fallback(self):
        text = CI.read_text()
        selectors = [line.strip() for line in text.splitlines() if line.strip().startswith('PACKAGE_RECEIPT:')]
        self.assertGreaterEqual(len(selectors), 2)
        for selector in selectors:
            self.assertNotIn('|| needs.package.outputs.receipt_arm64', selector)
            self.assertIn("needs.package.outputs[format('receipt_{0}', matrix.platform)]", selector)


# Defined below the tests so workflow extraction can share the same verifier.
def distribution_errors(receipt, product_root, revision, expected_arch=None):
    if not isinstance(receipt, dict):
        return ['missing receipt']
    if receipt.get('gate_id') != 'package' or receipt.get('outcome') != 'PASS' or type(receipt.get('rc')) is not int or receipt['rc'] != 0:
        return ['package did not pass distribution']
    identities = receipt.get('identities')
    if not revision or not isinstance(identities, dict) or identities.get('gate_revision') != revision:
        return ['package revision mismatch']
    if 'configuration_sha256' in identities and identities.get('configuration_sha256') != hashlib.sha256(CI.read_bytes()).hexdigest():
        return ['package configuration_sha256 mismatch']
    product = receipt.get('product_identity')
    if not isinstance(product, dict) or set(product) != {'artifact', 'artifact_sha256', 'manifest_sha256', 'architecture', 'smoke_marker'}:
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
    if actual != digest:
        return ['artifact_sha256 mismatch']
    arch = expected_arch or receipt.get('scope', {}).get('platform')
    if arch not in ('arm64', 'x64') or product['architecture'] != arch or product['smoke_marker'] != 'METAVIEWER_MAIN_SMOKE_OK':
        return ['architecture or smoke marker mismatch']
    try:
        proof = root / 'product-evidence.json'
        if proof.is_symlink() or json.loads(proof.read_text()) != product:
            return ['local smoke evidence mismatch']
        with tarfile.open(path, 'r:') as archive:
            members = archive.getmembers()
            prefix = f'MetaViewer-linux-{arch}/'
            manifest_member = f'MetaViewer-linux-{arch}.sha256'
            seen_names = set()
            actual_files = {}
            for member in members:
                if member.name in seen_names:
                    return ['duplicate archive member']
                seen_names.add(member.name)
                norm = member.name.rstrip('/')
                if not norm or member.name.startswith('/') or any(p in ('', '.', '..') for p in norm.split('/')):
                    return ['invalid archive member path']
                if member.isdir():
                    if norm != f'MetaViewer-linux-{arch}' and not norm.startswith(prefix):
                        return ['unexpected archive directory']
                    continue
                if not member.isfile():
                    return ['non-regular archive member']
                if member.name == manifest_member:
                    continue
                if not member.name.startswith(prefix) or member.name == prefix:
                    return ['unexpected archive member']
                actual_files[member.name] = member
            manifest_info = archive.getmember(manifest_member)
            if not manifest_info.isfile():
                return ['manifest digest mismatch']
            manifest_bytes = archive.extractfile(manifest_info).read()
            if hashlib.sha256(manifest_bytes).hexdigest() != product['manifest_sha256']:
                return ['manifest digest mismatch']
            manifest_text = manifest_bytes.decode('utf-8')
            if not manifest_text or not manifest_text.endswith('\n'):
                return ['invalid manifest format']
            expected_hashes = {}
            expected_modes = {}
            for line in manifest_text.splitlines():
                m = re.fullmatch(r'([0-9a-f]{64})(?: ([0-7]{4}))?  ([^\r\n\\]+)', line)
                if not m:
                    return ['invalid manifest inventory line']
                digest_hex, mode_oct, rel_path = m.group(1), m.group(2), m.group(3)
                if rel_path.startswith('/') or any(p in ('', '.', '..') for p in rel_path.split('/')):
                    return ['invalid manifest member path']
                full_name = rel_path if rel_path.startswith(prefix) else prefix + rel_path
                if full_name == manifest_member or not full_name.startswith(prefix) or full_name == prefix:
                    return ['invalid manifest member path']
                if full_name in expected_hashes:
                    return ['duplicate manifest entry']
                expected_hashes[full_name] = digest_hex
                if mode_oct is not None:
                    expected_modes[full_name] = int(mode_oct, 8)
            if set(actual_files) != set(expected_hashes):
                diff = sorted(set(actual_files) ^ set(expected_hashes))
                return [f'archive member inventory mismatch: {diff}']
            for full_name, expected_digest in expected_hashes.items():
                if full_name in expected_modes and (actual_files[full_name].mode & 0o777) != expected_modes[full_name]:
                    return ['manifest member mode mismatch']
                with archive.extractfile(actual_files[full_name]) as stream:
                    if hashlib.file_digest(stream, 'sha256').hexdigest() != expected_digest:
                        return ['manifest member digest mismatch']
            for name in ('metaviewer', 'resources/bin/metaviewer-core', 'resources/bin/mv-daemon-adapter'):
                full_name = prefix + name
                if full_name not in actual_files:
                    return ['invalid binary member']
                binary = archive.extractfile(actual_files[full_name]).read(64)
                if binary[:6] != b'\x7fELF\x02\x01' or int.from_bytes(binary[18:20], 'little') != (183 if arch == 'arm64' else 62):
                    return ['wrong product architecture']
    except (OSError, ValueError, KeyError, tarfile.TarError):
        return ['local manifest or smoke evidence absent']
    return []


def build_evidence():
    """[TARGET, unit decision] Path 2B shared producer/reproducer, no transport.

    Run all product operations in the existing offline namespace. A proof is
    published only after the real clean-install smoke returns its exact marker.
    """
    arch = os.environ.get('PLATFORM') or {'aarch64': 'arm64', 'x86_64': 'x64'}.get(platform.machine())
    if arch not in ('arm64', 'x64'):
        raise ValueError('unsupported package architecture')
    output = Path(os.environ['MV_PKG_OUT'])
    proof = output / 'product-evidence.json'
    if proof.exists():
        raise ValueError('refuse stale product evidence')
    offline = ['bash', '.github/workflows/offline.sh']
    def run(argv):
        result = subprocess.run(offline + argv, cwd=ROOT, check=False,
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        print(result.stdout, end='', flush=True)
        result.check_returncode()
        return result.stdout
    run(['bash', 'scripts/bootstrap.sh'])
    installed = output / f'MetaViewer-linux-{arch}'
    artifact = output / f'MetaViewer-linux-{arch}.tar'
    run(['node', 'ui/tools/package.js', '--verify-install', str(installed)])
    smoke = json.loads(run(['node', 'ui/tools/package.js', '--smoke', str(artifact)]))
    if smoke != {'marker': 'METAVIEWER_MAIN_SMOKE_OK', 'source_access': False, 'negative_controls': 'PASS'}:
        raise ValueError('clean-install smoke evidence mismatch')
    def sha(path):
        with path.open('rb') as stream:
            return hashlib.file_digest(stream, 'sha256').hexdigest()
    evidence = {'artifact': artifact.name, 'artifact_sha256': sha(artifact),
                'manifest_sha256': sha(Path(str(installed) + '.sha256')),
                'architecture': arch, 'smoke_marker': smoke['marker']}
    proof.write_text(json.dumps(evidence, sort_keys=True) + '\n')
    print(json.dumps(evidence, sort_keys=True))


if __name__ == '__main__':
    import sys
    if sys.argv[1:] == ['--build']:
        build_evidence()
        sys.exit(0)
    if sys.argv[1:] == ['--distribution']:
        try:
            receipt = json.loads(os.environ.get('PACKAGE_RECEIPT', 'null'))
        except ValueError:
            receipt = None
        errors = distribution_errors(receipt, os.environ.get('PRODUCT_ROOT'), os.environ.get('GITHUB_SHA'), os.environ.get('PLATFORM'))
        print(('FAIL distribution: ' + '; '.join(errors)) if errors else 'PASS distribution')
        sys.exit(1 if errors else 0)
    unittest.main()
