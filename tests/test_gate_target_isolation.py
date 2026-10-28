"""Exercise real Rust fixtures with a caller-supplied shared target directory."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def gate_namespace():
    source = (ROOT / 'tools/gate.sh').read_text().split("<<'PY'\n", 1)[1]
    source = source.rsplit('\nsys.exit(main())', 1)[0]
    namespace = {'__name__': 'gate_target_isolation'}
    with patch.object(sys, 'argv', ['gate.sh', str(ROOT), 'self-test']):
        exec(compile(source, str(ROOT / 'tools/gate.sh'), 'exec'), namespace)
    return namespace


class TargetIsolationTests(unittest.TestCase):
    def test_planted_then_nominal_use_private_targets(self):
        namespace = gate_namespace()
        with tempfile.TemporaryDirectory(prefix='gate-target-') as temporary:
            shared = Path(temporary) / 'shared-target'
            environment = dict(os.environ, CARGO_TARGET_DIR=str(shared))
            with patch.dict(os.environ, environment, clear=True):
                # Identical package identities must not share Cargo artifacts.
                for planted in (True, False, True, False):
                    fixture = namespace['GateTests']()
                    fixture.setUp()
                    try:
                        child = fixture.prepare_build_fixture()
                        if planted:
                            fixture.write('core/src/lib.rs',
                                          '#[test]\nfn fails() {\n'
                                          '    panic!("planted");\n}\n')
                        output = fixture.call('--leg', 'rust',
                                              expected=1 if planted else 0, env=child)
                        self.assertIn('FAIL rust' if planted else 'PASS rust', output)
                        if planted:
                            self.assertIn('planted', output)
                    finally:
                        fixture.doCleanups()
                self.assertFalse(shared.exists(),
                                 'self-test fixture wrote inherited target directory')

    def test_normal_rust_leg_honours_inherited_target(self):
        namespace = gate_namespace()
        fixture = namespace['GateTests']()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        environment = fixture.prepare_build_fixture()
        target = Path(fixture.temp.name) / 'caller-target'
        environment['CARGO_TARGET_DIR'] = str(target)
        result = subprocess.run(['bash', str(fixture.fixture / 'tools/gate.sh'),
                                 '--leg', 'rust'], env=environment,
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('PASS rust', result.stdout)
        self.assertTrue((target / 'debug').is_dir())

    def test_poisoned_ambient_env_scrubbed_in_frozen_and_rust_legs(self):
        namespace = gate_namespace()
        fixture = namespace['GateTests']()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        bin_dir = Path(fixture.temp.name) / 'env-probe-bin'
        bin_dir.mkdir()
        log_path = Path(fixture.temp.name) / 'probe-env.jsonl'
        for tool in ('rustc', 'cargo', 'npm'):
            wrapper = bin_dir / tool
            wrapper.write_text(
                '#!' + sys.executable + '\n'
                'import json, os, sys\n'
                f'entry = {{"tool": {tool!r}, '
                '"NODE_OPTIONS": os.environ.get("NODE_OPTIONS"), '
                '"RUSTFLAGS": os.environ.get("RUSTFLAGS"), '
                '"CARGO_ENCODED_RUSTFLAGS": os.environ.get("CARGO_ENCODED_RUSTFLAGS")}\n'
                f'with open({str(log_path)!r}, "a", encoding="utf-8") as f:\n'
                '    f.write(json.dumps(entry) + "\\n")\n'
                'if "-vV" in sys.argv:\n'
                '    print("rustc 1.97.0\\nhost: aarch64-unknown-linux-gnu")\n'
            )
            wrapper.chmod(0o700)
        poisoned = dict(
            os.environ,
            NODE_OPTIONS='--invalid-poison-node-option',
            RUSTFLAGS='-C invalid-poison-rustflag',
            CARGO_ENCODED_RUSTFLAGS='-C invalid-poison-encoded',
        )
        with patch.dict(os.environ, poisoned, clear=True):
            with namespace['private_environment']() as (_, scrubbed):
                self.assertNotIn('NODE_OPTIONS', scrubbed)
                self.assertNotIn('RUSTFLAGS', scrubbed)
                self.assertNotIn('CARGO_ENCODED_RUSTFLAGS', scrubbed)
                probe_env = dict(
                    scrubbed,
                    PATH=str(bin_dir) + os.pathsep + scrubbed.get('PATH', ''),
                    RUSTC=str(bin_dir / 'rustc'),
                    CARGO=str(bin_dir / 'cargo'),
                    NPM=str(bin_dir / 'npm'),
                )
                namespace['validate_frozen_dependencies'](fixture.fixture, probe_env)
        records = [json.loads(line) for line in log_path.read_text().splitlines()]
        self.assertEqual([r['tool'] for r in records], ['rustc', 'cargo', 'npm'])
        for rec in records:
            self.assertIsNone(rec['NODE_OPTIONS'])
            self.assertIsNone(rec['RUSTFLAGS'])
            self.assertIsNone(rec['CARGO_ENCODED_RUSTFLAGS'])
        # Real Rust leg must also succeed despite poisoned ambient RUSTFLAGS.
        environment = fixture.prepare_build_fixture()
        environment['RUSTFLAGS'] = '-C invalid-poison-rustflag'
        environment['CARGO_ENCODED_RUSTFLAGS'] = '-C invalid-poison-encoded'
        output = fixture.call('--leg', 'rust', expected=0, env=environment)
        self.assertIn('PASS rust', output)


if __name__ == '__main__':
    unittest.main()
