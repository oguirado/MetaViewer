"""Regression tests for verified round-2 T7 CI and supply-chain findings."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import unittest
import yaml

import tests.ci.test_package_identity as pkg_id

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / '.github/workflows'
CI = WORKFLOWS / 'ci.yml'
VOLUME = WORKFLOWS / 'volume.yml'
PACKAGE = WORKFLOWS / 'package.yml'
GATE = ROOT / 'tools/gate.sh'


def load_ci_f4_namespace():
    text = CI.read_text(encoding='utf-8')
    source = textwrap.dedent(text[text.index('          RKEYS = '):
                                  text.index('          product_tests = ')])
    namespace = {
        're': re,
        'json': json,
        'os': os,
        'hashlib': hashlib,
        'check': lambda *args, **kwargs: None,
    }
    exec(source, namespace)
    return namespace


class Round2T7RegressionTests(unittest.TestCase):
    def test_r1_092_receipt_errors_semantic_validation(self):
        ns = load_ci_f4_namespace()
        receipt_errors = ns['receipt_errors']
        genuine = ns['genuine']
        reg = ns['reg']
        blocked = ns['blocked']

        # Negative controls: genuine PASS and genuine BLOCKED receipts are accepted.
        self.assertEqual(receipt_errors(genuine, reg), [])
        self.assertEqual(receipt_errors(blocked, reg), [])

        # 1. PASS receipt with non-zero rc must be rejected.
        bad_rc = json.loads(json.dumps(genuine))
        bad_rc['rc'] = 7
        self.assertNotEqual(receipt_errors(bad_rc, reg), [], 'PASS with rc=7 must be rejected')

        # 2. PASS receipt with accepted=False assertion must be rejected.
        bad_assert = json.loads(json.dumps(genuine))
        bad_assert['assertions'][0]['accepted'] = False
        self.assertNotEqual(receipt_errors(bad_assert, reg), [], 'PASS with accepted=False must be rejected')

        # 3. PASS receipt with failed > 0 count must be rejected.
        bad_failed = json.loads(json.dumps(genuine))
        bad_failed['counts']['failed'] = 1
        self.assertNotEqual(receipt_errors(bad_failed, reg), [], 'PASS with failed=1 must be rejected')

        # 4. Negative counts must be rejected.
        for field in ('passed', 'failed', 'skipped'):
            with self.subTest(negative_field=field):
                bad_neg = json.loads(json.dumps(genuine))
                bad_neg['counts'][field] = -1
                self.assertNotEqual(receipt_errors(bad_neg, reg), [], f'negative {field} must be rejected')

        # 5. Partially populated counts (inconsistent passed/failed/skipped) must be rejected.
        bad_partial = json.loads(json.dumps(genuine))
        bad_partial['counts']['skipped'] = None
        self.assertNotEqual(receipt_errors(bad_partial, reg), [], 'inconsistent partial counts must be rejected')

    def test_r1_093_and_r1_098_aggregate_validates_receipts_and_configuration_oracle(self):
        ns = load_ci_f4_namespace()
        aggregate = ns['aggregate']
        genuine = ns['genuine']
        req = {'rust': {'PASS'}, 'novac': {'PASS', 'NOT_APPLICABLE'}}
        results = {'rust': 'success', 'novac': 'success'}

        rpass = json.loads(json.dumps(genuine))
        rpass['gate_id'] = 'rust'
        rna = json.loads(json.dumps(genuine))
        rna.update({
            'gate_id': 'novac',
            'rc': None,
            'outcome': 'NOT_APPLICABLE',
            'reason': 'w1',
            'assertions': [{'id': 'exit-status', 'expected': 'rc 0', 'observed': 'unexecuted', 'accepted': False}],
            'counts': {'passed': None, 'failed': None, 'skipped': None, 'source': 'unexecuted'},
        })

        # Negative control: genuine set with real workflow SHA passes aggregation.
        ok, detail = aggregate(req, [rpass, rna], results)
        self.assertTrue(ok, detail)

        # R1-093 / R1-098: tampered rust receipts must fail aggregation.
        mutations = [
            ('rc=7', lambda r: r.update(rc=7)),
            ('accepted=false', lambda r: r['assertions'][0].update(accepted=False)),
            ('failed=1', lambda r: r['counts'].update(failed=1)),
            ('negative-count', lambda r: r['counts'].update(passed=-1)),
            ('tampered-config-sha', lambda r: r['identities'].update(configuration_sha256='f' * 64)),
        ]
        for label, mutate in mutations:
            with self.subTest(mutation=label):
                tampered = json.loads(json.dumps(rpass))
                mutate(tampered)
                ok, _ = aggregate(req, [tampered, rna], results)
                self.assertFalse(ok, f'aggregate accepted tampered receipt ({label})')

    def test_t7r2c_003_distribution_manifest_inventory_and_extra_members(self):
        with tempfile.TemporaryDirectory(prefix='t7r2c-003-') as tmp:
            root = Path(tmp)
            product = root / 'package.tar'
            arch = 'arm64'
            binary = bytearray(64)
            binary[:6] = b'\x7fELF\x02\x01'
            binary[18:20] = (183).to_bytes(2, 'little')
            required_files = [
                (name, bytes(binary))
                for name in ('metaviewer', 'resources/bin/metaviewer-core', 'resources/bin/mv-daemon-adapter')
            ]
            valid_manifest = ''.join(
                f'{hashlib.sha256(data).hexdigest()}  {name}\n' for name, data in required_files
            ).encode('utf-8')

            def build_case(manifest_bytes, extra_entries=()):
                with tarfile.open(product, 'w') as archive:
                    entries = [
                        (f'MetaViewer-linux-{arch}.sha256', manifest_bytes),
                        *[(f'MetaViewer-linux-{arch}/{name}', data) for name, data in required_files],
                        *extra_entries,
                    ]
                    for name, data in entries:
                        info = tarfile.TarInfo(name)
                        info.size = len(data)
                        archive.addfile(info, io.BytesIO(data))
                evidence = {
                    'artifact': 'package.tar',
                    'artifact_sha256': hashlib.sha256(product.read_bytes()).hexdigest(),
                    'manifest_sha256': hashlib.sha256(manifest_bytes).hexdigest(),
                    'architecture': arch,
                    'smoke_marker': 'METAVIEWER_MAIN_SMOKE_OK',
                }
                (root / 'product-evidence.json').write_text(json.dumps(evidence), encoding='utf-8')
                receipt = {
                    'schema': 'gate_receipt/v1',
                    'gate_id': 'package',
                    'leg': 'package',
                    'profile': 'W0',
                    'owner': 'W0-CI-MATRIX',
                    'issuer': 'CI/package/1 [VM]',
                    'argv': ['python3', 'tests/ci/test_package_identity.py', '--build'],
                    'cwd': '/tmp',
                    'rc': 0,
                    'outcome': 'PASS',
                    'reason': 'ok',
                    'scope': {
                        'unit': 'W0-CI-MATRIX',
                        'platform': arch,
                        'feature': 'package',
                        'artifact': 'package.receipt.json',
                    },
                    'identities': {
                        'gate_revision': 'revision',
                        'instrument_sha256': 'a' * 64,
                        'sanitized_log_sha256': 'b' * 64,
                        'configuration_sha256': hashlib.sha256(CI.read_bytes()).hexdigest(),
                        'log_sha256': 'd' * 64,
                        'fixture_sha256': ['a' * 64],
                    },
                    'product_identity': dict(evidence),
                    'assertions': [{'id': 'exit-status', 'expected': 'rc 0', 'observed': 'rc 0', 'accepted': True}],
                    'counts': {'passed': None, 'failed': None, 'skipped': None, 'source': 'unparsed:package-smoke'},
                }
                return receipt

            # Negative control: valid inventory and exact member set is accepted.
            valid_receipt = build_case(valid_manifest)
            self.assertEqual(pkg_id.distribution_errors(valid_receipt, root, 'revision', arch), [])

            # 1. Garbage non-inventory manifest must be rejected even when manifest_sha256 matches.
            garbage_receipt = build_case(b'fixture manifest bytes\n')
            self.assertNotEqual(pkg_id.distribution_errors(garbage_receipt, root, 'revision', arch), [])

            # 2. Extra unindexed member inside or outside package dir must be rejected.
            for extra_name in ('evil-extra', f'MetaViewer-linux-{arch}/evil-extra'):
                with self.subTest(extra=extra_name):
                    extra_receipt = build_case(valid_manifest, extra_entries=[(extra_name, b'evil')])
                    self.assertNotEqual(pkg_id.distribution_errors(extra_receipt, root, 'revision', arch), [])

            # 3. Tampered member hash in manifest inventory must be rejected.
            tampered_manifest = valid_manifest.replace(
                hashlib.sha256(bytes(binary)).hexdigest().encode('utf-8'),
                b'0' * 64,
                1,
            )
            tampered_receipt = build_case(tampered_manifest)
            self.assertNotEqual(pkg_id.distribution_errors(tampered_receipt, root, 'revision', arch), [])

            # 4. Missing member listed in manifest must be rejected.
            extra_manifest_line = valid_manifest + f"{'f' * 64}  resources/missing.bin\n".encode('utf-8')
            missing_member_receipt = build_case(extra_manifest_line)
            self.assertNotEqual(pkg_id.distribution_errors(missing_member_receipt, root, 'revision', arch), [])

    def test_r1_014_volume_and_ci_f6_sanitizers_redact_all_github_token_prefixes(self):
        vol_text = VOLUME.read_text(encoding='utf-8')
        bodies = re.findall(r"python3 - \"\$1\" \"\$2\" <<'PYEOF'\n(.*?)\n          PYEOF", vol_text, re.S)
        self.assertEqual(len(bodies), 3)
        prefixes = ('ghp_', 'ghs_', 'gho_', 'ghu_', 'ghr_', 'github_pat_', 'AKIA', 'xoxb-')
        for idx, body in enumerate(bodies):
            with tempfile.TemporaryDirectory() as tmp:
                raw = Path(tmp) / 'raw'
                sane = Path(tmp) / 'sane'
                lines = []
                for pfx in prefixes:
                    lines.append(pfx + 'A1b2C3d4E5f6')
                    lines.append(pfx.upper() + 'A1b2C3d4E5f6')
                    if '_' in pfx:
                        lines.append(pfx.replace('_', '%5F') + 'A1b2C3d4E5f6')
                        lines.append(pfx.replace('_', '%5f') + 'A1b2C3d4E5f6')
                raw.write_text('\n'.join(lines) + '\nclean line 42\n', encoding='utf-8')
                res = subprocess.run([sys.executable, '-c', textwrap.dedent(body), str(raw), str(sane)],
                                     capture_output=True, text=True)
                self.assertEqual(res.returncode, 0, res.stderr)
                self.assertEqual(sane.read_text(encoding='utf-8'),
                                 '[REDACTED]\n' * len(lines) + 'clean line 42\n',
                                 f'volume.yml sanitizer copy {idx} leaked token')

        # Also check F6 redact() in ci.yml.
        ci_text = CI.read_text(encoding='utf-8')
        f6_src = textwrap.dedent(ci_text[ci_text.index('          def redact('):
                                         ci_text.index('          synth = ')])
        ns = {'re': re}
        exec(f6_src, ns)
        redact = ns['redact']
        for pfx in prefixes:
            self.assertEqual(redact(f'token={pfx}A1b2C3d4E5f6'), 'token=[REDACTED]')
        self.assertEqual(redact('clean line 42'), 'clean line 42')

    def test_t7r2c_004_go_prime_steps_enforce_offline_build_and_test(self):
        workflow = yaml.safe_load(CI.read_text(encoding='utf-8'))
        target_jobs = ('laws-contracts', 'rust', 'go', 'e2e')
        for job in target_jobs:
            steps = [s for s in workflow['jobs'][job]['steps']
                     if s.get('name') == 'Prime Go module and build caches']
            self.assertEqual(len(steps), 1, job)
            step = steps[0]
            with tempfile.TemporaryDirectory() as tmp:
                bin_dir = Path(tmp) / 'bin'
                bin_dir.mkdir()
                log_file = Path(tmp) / 'go-calls.jsonl'
                fake_go = bin_dir / 'go'
                fake_go.write_text(
                    '#!' + sys.executable + '\n'
                    'import json, os, sys\n'
                    'entry = {\n'
                    '    "argv": sys.argv[1:],\n'
                    '    "GOPROXY": os.environ.get("GOPROXY"),\n'
                    '    "GOSUMDB": os.environ.get("GOSUMDB"),\n'
                    '    "GOTOOLCHAIN": os.environ.get("GOTOOLCHAIN"),\n'
                    '    "GOFLAGS": os.environ.get("GOFLAGS"),\n'
                    '}\n'
                    f'open({str(log_file)!r}, "a").write(json.dumps(entry) + "\\n")\n'
                    'if os.environ.get("FAIL_IF_ONLINE") == "1" and sys.argv[1:2] in (["build"], ["test"]):\n'
                    '    if os.environ.get("GOPROXY") != "off" or os.environ.get("GOSUMDB") != "off" or "-mod=readonly" not in (os.environ.get("GOFLAGS") or ""):\n'
                    '        sys.exit(99)\n',
                    encoding='utf-8',
                )
                fake_go.chmod(0o755)
                env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ['PATH'],
                           FAIL_IF_ONLINE='1')
                for k, v in (step.get('env') or {}).items():
                    env[k] = str(v)
                res = subprocess.run(['bash', '-c', step['run']], cwd=ROOT / 'daemon-adapter',
                                     env=env, capture_output=True, text=True)
                self.assertEqual(res.returncode, 0, f'{job} prime step ran build/test online: {res.stderr}')
                calls = [json.loads(line) for line in log_file.read_text(encoding='utf-8').splitlines()]
                self.assertEqual([c['argv'] for c in calls], [
                    ['mod', 'download'],
                    ['build', './...'],
                    ['test', '-race', '-run', '^$', './...'],
                ])
                for c in calls[1:]:
                    self.assertEqual(c['GOPROXY'], 'off')
                    self.assertEqual(c['GOSUMDB'], 'off')
                    self.assertEqual(c['GOTOOLCHAIN'], 'local')
                    self.assertIn('-mod=readonly', c['GOFLAGS'] or '')

    def test_t7r2c_005_volume_and_package_receipts_conform_to_receipt_errors_schema(self):
        ns = load_ci_f4_namespace()
        receipt_errors = ns['receipt_errors']

        for wf_path in (VOLUME, PACKAGE):
            text = wf_path.read_text(encoding='utf-8')
            blocks = re.findall(
                r'          finish_gate\(\) \{\n(.*?\n          \})',
                text,
                re.S,
            )
            self.assertGreaterEqual(len(blocks), 1, wf_path.name)
            wf_sha = hashlib.sha256(wf_path.read_bytes()).hexdigest()
            for idx, block in enumerate(blocks):
                sanitize_match = re.search(r'          sanitize\(\) \{\n.*?\n          \}', text, re.S)
                script = textwrap.dedent(sanitize_match[0]) + '\n' + textwrap.dedent('          finish_gate() {\n' + block)
                with tempfile.TemporaryDirectory() as tmp:
                    raw = Path(tmp) / 'gate.log'
                    raw.write_text('Ran 1 test in 0.01s\n\nOK\n', encoding='utf-8')
                    summary = Path(tmp) / 'summary'
                    env = dict(
                        os.environ,
                        EVDIR=tmp,
                        PLATFORM='x64',
                        ISSUER='Test/1 [VM]',
                        WF_SHA=wf_sha,
                        GITHUB_SHA='revision',
                        GITHUB_STEP_SUMMARY=str(summary),
                    )
                    cmd = script + f'\nfinish_gate test-gate 0 PASS "ok" "{raw}" "{wf_path.relative_to(ROOT)}" "parsed:unittest" 1 -- python3 -m unittest\n'
                    res = subprocess.run(['bash', '-c', cmd], cwd=ROOT, env=env, capture_output=True, text=True)
                    self.assertEqual(res.returncode, 0, res.stderr)
                    receipt = json.loads((Path(tmp) / 'test-gate.receipt.json').read_text(encoding='utf-8'))
                    reg = {'configuration_sha256': wf_sha}
                    self.assertEqual(
                        receipt_errors(receipt, reg),
                        [],
                        f'{wf_path.name} block {idx} receipt failed schema check: {receipt_errors(receipt, reg)}',
                    )

    def test_t7r2c_007_f2_mutant_caught_uses_real_weakened_checker(self):
        text = CI.read_text(encoding='utf-8')
        f2_src = textwrap.dedent(text[text.index('          def pin_errors('):
                                      text.index('          # F3')])
        checks = {}
        ns = {
            'os': os,
            're': re,
            'glob': __import__('glob'),
            'json': json,
            'subprocess': subprocess,
            'sys': sys,
            'check': lambda name, cond, *args: checks.update({name: cond}),
        }
        exec(f2_src, ns)
        self.assertTrue(checks.get('f2-mutant-caught'))
        broken = ns['broken']
        # A real weakened checker must not be a trivial lambda returning [] on everything:
        # it must still reject invalid YAML or unpinned tags while missing the mutated rule.
        self.assertNotEqual(broken('steps: [broken', '.'), [],
                            'broken checker must be a real weakened checker, not a constant [] stub')

    def test_r1_095_gate_sh_rust_leg_uses_locked_and_rejects_lock_drift(self):
        gate_text = GATE.read_text(encoding='utf-8').replace("tools['cargo'], ", '')
        self.assertEqual("['clippy', '--locked', '--offline'" in gate_text, True, 'cargo clippy missing --locked')
        self.assertEqual("['test', '--locked', '--offline'" in gate_text, True, 'cargo test missing --locked')
        self.assertNotIn("['clippy', '--offline'", gate_text, 'cargo clippy must not omit --locked')
        self.assertNotIn("['test', '--offline'", gate_text, 'cargo test must not omit --locked')

        # Hosted js job runs tests/ci discovery and must provision the pinned Rust
        # toolchains (1.97.0 clippy default + 1.92.0 rustfmt) before offline tests.
        ci_jobs = yaml.safe_load(CI.read_text(encoding='utf-8'))['jobs']
        js_steps = ci_jobs['js']['steps']
        prep_idx = next(
            (
                idx for idx, step in enumerate(js_steps)
                if 'rustup toolchain install 1.97.0 --profile minimal --component clippy' in step.get('run', '')
                and 'rustup toolchain install 1.92.0 --profile minimal --component rustfmt' in step.get('run', '')
                and 'rustup default 1.97.0' in step.get('run', '')
                and not step.get('if')
            ),
            None,
        )
        offline_idx = next(
            (idx for idx, step in enumerate(js_steps) if '.github/workflows/offline.sh' in step.get('run', '')),
            None,
        )
        reg_idx = next(
            (idx for idx, step in enumerate(js_steps) if 'unittest discover -s tests/ci' in step.get('run', '')),
            None,
        )
        self.assertIsNotNone(prep_idx, 'js job must provision 1.97.0 clippy and 1.92.0 rustfmt for R1-095')
        self.assertIsNotNone(offline_idx)
        self.assertIsNotNone(reg_idx)
        self.assertLess(prep_idx, offline_idx, 'Rust toolchain provisioning in js job must precede offline namespace')
        self.assertLess(prep_idx, reg_idx, 'Rust toolchain provisioning in js job must precede tests/ci regressions')

        # Explicit prerequisite check: never silently skip when cargo/rustup are absent.
        cargo_bin = shutil.which(os.environ.get('CARGO', 'cargo'))
        rustup_bin = shutil.which(os.environ.get('RUSTUP', 'rustup'))
        self.assertIsNotNone(cargo_bin, 'R1_095_PREREQ: cargo executable required on PATH or via CARGO')
        self.assertIsNotNone(rustup_bin, 'R1_095_PREREQ: rustup executable required on PATH or via RUSTUP')
        fmt_probe = subprocess.run(
            [rustup_bin, 'run', '1.92.0', 'cargo', 'fmt', '--version'],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(
            fmt_probe.returncode, 0,
            f'R1_095_PREREQ: pinned 1.92.0 rustfmt required: {fmt_probe.stdout}{fmt_probe.stderr}',
        )
        clippy_probe = subprocess.run(
            [cargo_bin, 'clippy', '--version'],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(
            clippy_probe.returncode, 0,
            f'R1_095_PREREQ: cargo clippy required: {clippy_probe.stdout}{clippy_probe.stderr}',
        )

        with tempfile.TemporaryDirectory(prefix='r1-095-') as tmp:
            repo = Path(tmp) / 'repo'
            target = Path(tmp) / 'cargo-target'
            (repo / 'tools').mkdir(parents=True)
            (repo / 'core/src').mkdir(parents=True)
            shutil.copyfile(GATE, repo / 'tools/gate.sh')
            (repo / 'Cargo.toml').write_text('[workspace]\nmembers = ["core"]\nresolver = "2"\n', encoding='utf-8')
            (repo / 'core/Cargo.toml').write_text(
                '[package]\nname = "gate-fixture"\nversion = "0.1.0"\nedition = "2021"\n',
                encoding='utf-8',
            )
            (repo / 'core/src/lib.rs').write_text('pub fn value() -> u32 {\n    1\n}\n', encoding='utf-8')
            valid_lock = 'version = 4\n\n[[package]]\nname = "gate-fixture"\nversion = "0.1.0"\n'
            (repo / 'Cargo.lock').write_text(valid_lock, encoding='utf-8')
            env = dict(os.environ, CARGO_TARGET_DIR=str(target), CARGO=cargo_bin, RUSTUP=rustup_bin)

            # Negative control: matching Cargo.lock succeeds.
            ok_run = subprocess.run(['bash', str(repo / 'tools/gate.sh'), '--leg', 'rust'],
                                    cwd=tmp, env=env, capture_output=True, text=True, timeout=60)
            self.assertEqual(ok_run.returncode, 0, ok_run.stdout + ok_run.stderr)
            self.assertIn('PASS rust', ok_run.stdout)

            # R1-095: mismatched Cargo.lock must fail fast instead of resolving/rewriting lockfile.
            stale_lock = valid_lock.replace('0.1.0', '0.2.0')
            (repo / 'Cargo.lock').write_text(stale_lock, encoding='utf-8')
            bad_run = subprocess.run(['bash', str(repo / 'tools/gate.sh'), '--leg', 'rust'],
                                     cwd=tmp, env=env, capture_output=True, text=True, timeout=60)
            self.assertEqual(bad_run.returncode, 1, bad_run.stdout + bad_run.stderr)
            self.assertIn('FAIL rust', bad_run.stdout)
            self.assertEqual((repo / 'Cargo.lock').read_text(encoding='utf-8'), stale_lock)


if __name__ == '__main__':
    unittest.main()
