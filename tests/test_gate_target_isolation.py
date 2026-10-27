"""Exercise real Rust fixtures with a caller-supplied shared target directory."""
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


if __name__ == '__main__':
    unittest.main()
