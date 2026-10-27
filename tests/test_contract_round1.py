"""Round-one parity rails and branch-liveness regression oracles."""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from tools.check_contracts import ROOT, Validator, ValidationError, check_repository

SAFE = (1 << 53) - 1


class RoundOneContracts(unittest.TestCase):
    def setUp(self):
        self.validator = Validator(ROOT / 'contracts/v0.2')

    def test_digest_and_path_reject_lf_cr_and_crlf(self):
        schema = self.validator.load('frame_ref.schema.json')
        good = json.loads((ROOT / 'contracts/examples/v0.2/frame_ref.valid.json').read_text())
        self.validator.validate(good, schema)
        for field in ('sha256', 'ramws_path'):
            for ending in ('\n', '\r', '\r\n'):
                with self.subTest(field=field, ending=repr(ending)):
                    with self.assertRaises(ValidationError):
                        self.validator.validate({**good, field: good[field] + ending}, schema)
        for bad_path in ('/dev/shm/a\nb', '/dev/shm/a\rb'):
            with self.assertRaises(ValidationError):
                self.validator.validate({**good, 'ramws_path': bad_path}, schema)
        # Prefix patterns retain their documented search semantics.
        self.validator.validate('abc', {'type': 'string', 'pattern': '^a'})

    def test_envelope_safe_integer_boundary(self):
        schema = self.validator.load('envelope.schema.json')
        good = json.loads((ROOT / 'contracts/examples/v0.2/envelope.valid.json').read_text())
        self.validator.validate({**good, 'seq': SAFE}, schema)
        with self.assertRaises(ValidationError):
            self.validator.validate({**good, 'seq': SAFE + 1}, schema)

    def test_all_v02_integer_nodes_have_exact_rails(self):
        def visit(node):
            if isinstance(node, dict):
                if node.get('type') == 'integer':
                    self.assertLessEqual(node.get('maximum', SAFE + 1), SAFE, node)
                    self.assertGreaterEqual(node.get('minimum', -SAFE - 1), -SAFE, node)
                    self.validator.validate(node['maximum'], node)
                    with self.assertRaises(ValidationError):
                        self.validator.validate(node['maximum'] + 1, node)
                for child in node.values():
                    visit(child)
            elif isinstance(node, list):
                for child in node:
                    visit(child)
        for path in (ROOT / 'contracts/v0.2').glob('*.schema.json'):
            with self.subTest(schema=path.name):
                visit(json.loads(path.read_text()))

    def test_named_positive_variants_and_coverage_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            schemas = root / 'contracts/v0.2'
            examples = root / 'contracts/examples/v0.2'
            schemas.mkdir(parents=True)
            examples.mkdir(parents=True)
            schema = {
                '$schema': 'https://json-schema.org/draft/2020-12/schema',
                '$id': 'https://metaviewer.local/contracts/v0.2/sample.schema.json',
                'title': 'Coverage', 'oneOf': [
                    {'type': 'string', 'enum': ['a', 'b']},
                    {'type': 'integer', 'minimum': 0, 'maximum': SAFE}]}
            (schemas / 'sample.schema.json').write_text(json.dumps(schema))
            for name, value in [('valid', 'a'), ('valid.b', 'b'), ('valid.int', 1), ('invalid.type', None)]:
                (examples / f'sample.{name}.json').write_text(json.dumps(value))
            self.assertEqual(check_repository(root, versions=('v0.2',)), [])
            for name in ('b', 'int'):
                path = examples / f'sample.valid.{name}.json'
                raw = path.read_text()
                path.unlink()
                errors = check_repository(root, versions=('v0.2',))
                self.assertTrue(any('unwitnessed' in error for error in errors), errors)
                path.write_text(raw)
            # A mislabeled positive and a duplicate cannot stand in for a missing branch.
            (examples / 'sample.valid.int.json').write_text('"a"')
            self.assertTrue(check_repository(root, versions=('v0.2',)))
            (examples / 'sample.valid.int.json').write_text('null')
            self.assertTrue(check_repository(root, versions=('v0.2',)))

    def test_mutant_gate_has_per_variant_witness_oracle(self):
        from tools import check_contracts
        self.assertTrue(callable(getattr(check_contracts, 'variant_coverage', None)))
        schema = {'oneOf': [{'enum': ['a', 'b']}, {'type': 'integer'}]}
        coverage = check_contracts.variant_coverage
        self.assertEqual(coverage(self.validator, schema, ['a', 'b', 0]), [])
        for incomplete in (['a', 0], ['a', 'b'], ['a'] * 20):
            self.assertTrue(coverage(self.validator, schema, incomplete))
        # Refs and array items must be reached, including optional properties.
        nested = {'$defs': {'choice': schema}, 'type': 'object',
                  'properties': {'items': {'type': 'array', 'items': {'$ref': '#/$defs/choice'}}},
                  'additionalProperties': False}
        self.assertEqual(coverage(self.validator, nested, [{'items': ['a', 'b', 0]}]), [])
        self.assertTrue(coverage(self.validator, nested, [{}, {'items': ['a']}]))

    def test_runtime_decodes_named_positives_and_boundary_controls(self):
        """Exercise the real Rust decoder through a disposable offline probe."""
        from tools.check_contracts import positive_examples
        cargo = shutil.which(os.environ.get('CARGO', 'cargo'))
        self.assertIsNotNone(cargo, 'cargo must be supplied by PATH or CARGO')
        base = json.loads((ROOT / 'contracts/examples/v0.2/envelope.valid.json').read_text())
        cases = []
        examples = ROOT / 'contracts/examples/v0.2'
        for path in sorted((ROOT / 'contracts/v0.2').glob('*.schema.json')):
            name = path.name.removesuffix('.schema.json')
            for fixture in positive_examples(examples, name):
                value = json.loads(fixture.read_text())
                envelope = value if name == 'envelope' else {**base, 'body': value}
                cases.append((fixture.name, envelope, True))
        for seq, expected in ((SAFE, True), (SAFE + 1, False)):
            cases.append((f'seq={seq}', {**base, 'seq': seq}, expected))
        frame = json.loads((examples / 'frame_ref.valid.json').read_text())
        for key in ('sha256', 'ramws_path'):
            for suffix in ('\n', '\r', '\r\n'):
                cases.append((key + repr(suffix),
                              {**base, 'body': {**frame, key: frame[key] + suffix}}, False))
        with tempfile.TemporaryDirectory(prefix='contract-probe-') as temp:
            directory = Path(temp)
            (directory / 'src').mkdir()
            (directory / 'Cargo.toml').write_text(
                '[package]\nname = "contract-round1-probe"\nversion = "0.0.0"\n'
                'edition = "2021"\n[workspace]\n[dependencies]\n'
                'metaviewer-core = { path = ' + json.dumps(str(ROOT / 'core')) + ' }\n')
            (directory / 'src/main.rs').write_text(
                'use std::io::{self, BufRead};\nfn main() {\n'
                'for line in io::stdin().lock().lines() {\n'
                'println!("{}", metaviewer_core::decode_envelope(&line.unwrap()).is_ok());\n'
                '}\n}\n')
            environment = dict(os.environ)
            environment.setdefault('CARGO_TARGET_DIR', str(directory / 'target'))
            result = subprocess.run(
                [cargo, 'run', '--offline', '--ignore-rust-version', '--quiet', '--manifest-path', str(directory / 'Cargo.toml')],
                input=''.join(json.dumps(value) + '\n' for _, value, _ in cases),
                text=True, capture_output=True, env=environment, timeout=180)
            self.assertEqual(result.returncode, 0, result.stderr)
            answers = result.stdout.splitlines()
            self.assertEqual(len(answers), len(cases), result.stdout)
            for (name, _, expected), answer in zip(cases, answers):
                with self.subTest(fixture=name):
                    self.assertEqual(answer, str(expected).lower())
