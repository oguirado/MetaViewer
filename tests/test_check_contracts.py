import copy
import json
from pathlib import Path
import tempfile
import subprocess
import shutil
from unittest.mock import patch
import unittest
from tools.check_contracts import Validator, ValidationError, check_repository, ROOT

class ContractTests(unittest.TestCase):
    def setUp(self):
        self.validator = Validator(ROOT / 'contracts/v0.1')

    def assertInvalid(self, value, schema):
        with self.assertRaises(ValidationError):
            self.validator.validate(value, schema)

    def test_repository(self):
        self.assertEqual(check_repository(), [])

    def test_types_and_boolean_number_separation(self):
        samples = [('string', 'x', 1), ('integer', 1, True), ('number', 1.5, False),
                   ('boolean', True, 1), ('array', [], {}), ('object', {}, []), ('null', None, '')]
        for typ, good, bad in samples:
            with self.subTest(typ=typ):
                self.validator.validate(good, {'type': typ})
                self.assertInvalid(bad, {'type': typ})
        self.assertInvalid(True, {'enum': [1]})
        self.assertInvalid({'a': True}, {'const': {'a': 1}})

    def test_object_rules(self):
        schema = {'type':'object', 'properties':{'x':{'type':'integer'}}, 'required':['x'], 'additionalProperties':False}
        self.validator.audit(schema)
        self.validator.validate({'x':1}, schema)
        for value in ({}, {'x':1,'extra':0}, {'x':'one'}):
            self.assertInvalid(value, schema)

    def test_bounds_pattern_items_and_choices(self):
        schema = {'type':'array','minItems':1,'items':{'type':'string','minLength':2,'maxLength':3,'pattern':'^a'}}
        self.validator.validate(['ab'], schema)
        for bad in ([], ['a'], ['abcd'], ['bb'], [2]):
            self.assertInvalid(bad, schema)
        numeric = {'type':'number','minimum':1,'maximum':2}
        for good in (1, 1.5, 2): self.validator.validate(good, numeric)
        for bad in (0, 3, True): self.assertInvalid(bad, numeric)
        self.assertInvalid('x', {'const':'y'})
        self.assertInvalid('x', {'enum':['y']})
        choice = {'oneOf':[{'type':'integer'},{'type':'string'}]}
        self.validator.validate('x', choice)
        self.assertInvalid([], choice)
        self.assertInvalid(1, {'oneOf':[{'type':'integer'},{'type':'number'}]})

    def test_references(self):
        schema = {'$defs':{'text':{'type':'string'}}, '$ref':'#/$defs/text'}
        self.validator.audit(schema)
        self.validator.validate('hello', schema)
        self.assertInvalid(1, schema)
        frame = json.loads((ROOT / 'contracts/examples/frame_ref.valid.json').read_text())
        self.validator.validate(frame, {'$ref':'frame_ref.schema.json'})
        self.assertInvalid({}, {'$ref':'frame_ref.schema.json'})
        for ref in ('#/$defs/missing', '../escape.schema.json', '#/properties/x'):
            with self.assertRaises(ValidationError):
                self.validator.audit({'$ref':ref})

    def test_hand_made_bad_schemas(self):
        for schema in ({'type':'object'}, {'type':'object','properties':{},'additionalProperties':True},
                       {'type':'mystery'}, {'unknown':True}, {'oneOf':[]},
                       {'type':'string','pattern':'['}, {'type':'array','minItems':-1}):
            with self.subTest(schema=schema):
                with self.assertRaises(ValidationError): self.validator.audit(schema)

    def test_bad_fixture_and_missing_coverage(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); schemas = root / 'contracts/v0.1'; examples = root / 'contracts/examples'
            schemas.mkdir(parents=True); examples.mkdir()
            schema = self.validator.load('surface.schema.json')
            (schemas / 'surface.schema.json').write_text(json.dumps(schema))
            good = json.loads((ROOT / 'contracts/examples/surface.valid.json').read_text())
            (examples / 'surface.valid.json').write_text(json.dumps(good))
            bad = copy.deepcopy(good); bad['geometry']['w'] = 0
            (examples / 'surface.invalid.width.json').write_text(json.dumps(bad))
            self.assertEqual(check_repository(root, versions=('v0.1',)), [])
            (examples / 'surface.valid.json').write_text(json.dumps(bad))
            self.assertTrue(check_repository(root, versions=('v0.1',)))
            (examples / 'surface.valid.json').write_text(json.dumps(good))
            (examples / 'surface.invalid.width.json').write_text(json.dumps(good))
            self.assertTrue(check_repository(root, versions=('v0.1',)))
            (examples / 'surface.invalid.width.json').unlink()
            self.assertTrue(check_repository(root, versions=('v0.1',)))

    def test_every_operation_and_action(self):
        schema = self.validator.load('surface_request.schema.json')
        self.assertEqual(len(schema['oneOf']), 10)
        for branch in schema['oneOf']:
            self.validator.audit(branch)
            self.assertInvalid({'schema':'surface_request/v0.1','op':branch['properties']['op']['const'],'params':{'unexpected':True}}, branch)
        verdict = self.validator.load('action_verdict.schema.json')
        self.validator.validate({'schema':'action_verdict/v0.1','proposal_id':'p','decision':'admitted','core_seq':1}, verdict)
        self.assertInvalid({'schema':'action_verdict/v0.1','proposal_id':'p','decision':'refused','core_seq':1}, verdict)

    def test_all_operation_and_action_variants_accept_valid_parameters(self):
        surface = {'surface_id':'s'}
        params = {
            'create':{'kind':'game_capsule','geometry':{'w':800,'h':600},'profile_id':'p'},
            'list':{}, 'destroy':surface, 'frame_subscribe':surface, 'frame_unsubscribe':surface,
            'record_start':{**surface,'recording_id':'r'}, 'record_stop':{**surface,'recording_id':'r'},
            'take_control':{**surface,'owner':'human'}, 'release_control':surface,
            'input':{**surface,'proposal_id':'p','action':{'type':'wait','ms':1}}}
        schema = self.validator.load('surface_request.schema.json')
        for op, value in params.items():
            with self.subTest(op=op):
                self.validator.validate({'schema':'surface_request/v0.1','op':op,'params':value}, schema)
        proposal = json.loads((ROOT / 'contracts/examples/action_proposal.valid.json').read_text())
        schema = self.validator.load('action_proposal.schema.json')
        actions = [
            {'type':'click','x':0,'y':0,'button':'left'}, {'type':'key','keys':['CTRL','A']},
            {'type':'type','text':'hello'}, {'type':'scroll','dx':-1,'dy':2}, {'type':'wait','ms':1},
            {'type':'lane_submit','verb':'submit','payload':{'nonce':'n','seq':1,'command':'move','args':['left']}}]
        for action in actions:
            with self.subTest(action=action['type']):
                self.validator.validate({**proposal,'action':action}, schema)
                self.assertInvalid({**proposal,'action':{**action,'unexpected':True}}, schema)


class VersionedContractTests(unittest.TestCase):
    names = ('surface', 'frame_ref', 'surface_request', 'surface_event',
             'observation', 'action_proposal', 'action_verdict', 'action_receipt',
             'hello', 'capsule_meta', 'ui_intent', 'catalog_entry', 'terminal_session',
             'record_request', 'record_event', 'settings', 'mv_tool_call', 'mv_tool_result',
             'session_record')

    def test_ui_control_fixtures(self):
        validator = Validator(ROOT / 'contracts/v0.2')
        schema = validator.load('ui_intent.schema.json')
        fixture = json.loads((ROOT / 'contracts/examples/v0.2/ui_intent.valid.json').read_text())
        for op in ('take_control', 'release_control'):
            with self.subTest(op=op):
                validator.validate({**fixture, 'op': op}, schema)
                for params in ({}, {'surface_id': ''}, {'surface_id': 's', 'owner': 'human'}):
                    with self.assertRaises(ValidationError):
                        validator.validate({**fixture, 'op': op, 'params': params}, schema)

    def make_repository(self, root, versions=('v0.1', 'v0.2')):
        for version in versions:
            directory = root / 'contracts' / version
            examples = root / 'contracts/examples'
            if version != 'v0.1':
                examples /= version
            directory.mkdir(parents=True)
            examples.mkdir(parents=True, exist_ok=True)
            schema = {
                '$schema': 'https://json-schema.org/draft/2020-12/schema',
                '$id': f'https://metaviewer.local/contracts/{version}/sample.schema.json',
                'title': 'Sample', 'type': 'object', 'additionalProperties': False,
                'required': ['schema', 'count', 'text', 'items'],
                'properties': {'schema': {'const': 'sample/' + version},
                               'count': {'type': 'integer', 'minimum': 1, 'maximum': 3},
                               'text': {'type': 'string', 'minLength': 1, 'maxLength': 3},
                               'items': {'type': 'array', 'minItems': 1, 'maxItems': 2,
                                         'items': {'type': 'boolean'}}}}
            good = {'schema': 'sample/' + version, 'count': 2, 'text': 'ok', 'items': [True]}
            (directory / 'sample.schema.json').write_text(json.dumps(schema))
            (examples / 'sample.valid.json').write_text(json.dumps(good))
            (examples / 'sample.invalid.count.json').write_text(json.dumps({**good, 'count': 0}))
        return root

    def test_version_matrix_and_cli_default(self):
        with tempfile.TemporaryDirectory() as temp:
            root = self.make_repository(Path(temp))
            self.assertEqual(check_repository(root), [])
            for versions in ((), ('v9',), ('v0.1', 'v0.1')):
                self.assertTrue(check_repository(root, versions=versions))
            shutil.rmtree(root / 'contracts/v0.2')
            self.assertTrue(check_repository(root))
            self.assertEqual(check_repository(root, versions=('v0.1',)), [])
            (root / 'contracts/v0.2').mkdir()
            self.assertTrue(check_repository(root))

    def test_envelope_v02_union_manifest(self):
        legacy = json.loads((ROOT / 'contracts/v0.1/envelope.schema.json').read_text())
        actual = json.loads((ROOT / 'contracts/v0.2/envelope.schema.json').read_text())
        expected = copy.deepcopy(legacy)
        expected['$id'] = expected['$id'].replace('v0.1', 'v0.2')
        expected['properties']['schema']['const'] = 'envelope/v0.2'
        expected['properties']['body']['oneOf'] = [{'$ref': name + '.schema.json'} for name in self.names]
        expected['maxProperties'] = 256
        for name in ('from', 'to'):
            expected['properties'][name]['maxProperties'] = 256
            expected['properties'][name]['properties']['component']['maxLength'] = 65536
        self.assertEqual(actual, expected)
        for mutation in ('missing', 'duplicate', 'journal', 'version'):
            bad = copy.deepcopy(actual)
            branches = bad['properties']['body']['oneOf']
            if mutation == 'missing': branches.pop()
            if mutation == 'duplicate': branches.append(branches[0])
            if mutation == 'journal': branches.remove({'$ref': 'session_record.schema.json'})
            if mutation == 'version': bad['properties']['schema']['const'] = 'envelope/v0.1'
            self.assertNotEqual(bad, expected)

    def test_bad_fixture_and_missing_coverage_v02(self):
        with tempfile.TemporaryDirectory() as temp:
            root = self.make_repository(Path(temp))
            examples = root / 'contracts/examples/v0.2'
            valid = examples / 'sample.valid.json'
            invalid = examples / 'sample.invalid.count.json'
            good, bad = valid.read_text(), invalid.read_text()
            for path, raw in ((valid, bad), (invalid, good), (invalid, '{'),
                              (examples / 'stray.valid.json', good)):
                with self.subTest(path=path.name, raw=raw):
                    path.write_text(raw)
                    errors = check_repository(root)
                    self.assertTrue(errors)
                    self.assertTrue(any('v0.2' in error and path.name in error for error in errors))
                    valid.write_text(good); invalid.write_text(bad)
                    if path.name.startswith('stray'): path.unlink()
            for path, raw in ((valid, good), (invalid, bad)):
                path.unlink()
                self.assertTrue(check_repository(root))
                path.write_text(raw)
            shutil.rmtree(examples)
            self.assertTrue(check_repository(root))

    def test_strict_json_ingestion(self):
        from tools.check_contracts import loads_strict
        self.assertEqual(loads_strict('{"x": 1}'), {'x': 1})
        for raw in ('{"x":1,"x":2}', '{"x":{"a":1,"a":2}}', '{',
                    'NaN', 'Infinity', '-Infinity', '1e999'):
            with self.subTest(raw=raw), self.assertRaises(ValidationError):
                loads_strict(raw)
        with tempfile.TemporaryDirectory() as temp:
            root = self.make_repository(Path(temp))
            files = [root / 'contracts/v0.2/sample.schema.json',
                     root / 'contracts/examples/v0.2/sample.valid.json',
                     root / 'contracts/examples/v0.2/sample.invalid.count.json']
            for path in files:
                original = path.read_text()
                for raw in ('{"x":1,"x":2}', '{"x":{"a":1,"a":2}}', 'NaN', '{'):
                    path.write_text(raw)
                    self.assertTrue(check_repository(root))
                path.write_text(original)

    def test_schema_metadata_and_subset(self):
        with tempfile.TemporaryDirectory() as temp:
            root = self.make_repository(Path(temp))
            path = root / 'contracts/v0.2/sample.schema.json'
            original = json.loads(path.read_text())
            for key, bad in (('$id', 'wrong'), ('$schema', 'wrong'), ('title', 1)):
                path.write_text(json.dumps({**original, key: bad}))
                self.assertTrue(check_repository(root))
            path.write_text(json.dumps(original))
            validator = Validator(path.parent)
            for schema in ({'type': 'object', 'additionalProperties': False},
                           {'required': 'x'}, {'$defs': []}, {'$ref': 1},
                           {'maxItems': True}, {'maxItems': -1},
                           {'minimum': float('nan')}, {'enum': [float('inf')]},
                           {'type': 'object', 'properties': {}, 'additionalProperties': False, 'required': ['x']},
                           {'minItems': 3, 'maxItems': 2}, {'unknown': True}):
                with self.subTest(schema=schema), self.assertRaises(ValidationError):
                    validator.audit(schema)
            schema = {'type': 'array', 'maxItems': 2}
            validator.audit(schema)
            validator.validate([1, 2], schema)
            with self.assertRaises(ValidationError): validator.validate([1, 2, 3], schema)
            for value in (float('nan'), float('inf'), {'x': float('nan')}):
                with self.assertRaises(ValidationError): validator.validate(value, {})

    def test_ref_version_and_path_isolation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = self.make_repository(Path(temp))
            directory = root / 'contracts/v0.2'
            validator = Validator(directory)
            defs = {'$defs': {'text': {'type': 'string'}}, '$ref': '#/$defs/text'}
            (directory / 'defs.schema.json').write_text(json.dumps(defs))
            validator.audit({'$ref': 'defs.schema.json#/$defs/text'})
            validator.validate('ok', {'$ref': 'defs.schema.json#/$defs/text'})
            (directory / 'escape.schema.json').symlink_to(root / 'contracts/v0.1/sample.schema.json')
            for ref in ('../v0.1/sample.schema.json', './sample.schema.json',
                        str(directory / 'sample.schema.json'), 'sub/sample.schema.json',
                        'sub\\sample.schema.json', 'missing.schema.json', 'escape.schema.json',
                        '#/properties/x', '#/$defs/missing', 1):
                with self.subTest(ref=ref), self.assertRaises((ValidationError, OSError)):
                    validator.audit({'$ref': ref})
            (directory / 'cycle.schema.json').write_text('{"$ref":"cycle.schema.json"}')
            with self.assertRaises(ValidationError): validator.audit({'$ref': 'cycle.schema.json'})
            with self.assertRaises(ValidationError): validator.validate({}, {'$ref': 'cycle.schema.json'})
            first = Validator(root / 'contracts/v0.1')
            second = Validator(directory)
            good = json.loads((root / 'contracts/examples/sample.valid.json').read_text())
            first.validate(good, first.load('sample.schema.json'))
            with self.assertRaises(ValidationError): second.validate(good, second.load('sample.schema.json'))
            good['schema'] = 'sample/v0.2'
            second.validate(good, second.load('sample.schema.json'))
            with self.assertRaises(ValidationError): first.validate(good, first.load('sample.schema.json'))

    def test_oracle_constant_controls(self):
        with tempfile.TemporaryDirectory() as temp:
            root = self.make_repository(Path(temp))
            self.assertEqual(check_repository(root), [])
            with patch.object(Validator, 'validate', return_value=None):
                self.assertTrue(check_repository(root))
            with patch.object(Validator, 'validate', side_effect=ValidationError('refused')):
                self.assertTrue(check_repository(root))

    def test_cli_success_and_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            root = self.make_repository(Path(temp))
            (root / 'tools').mkdir()
            script = root / 'tools/check_contracts.py'
            shutil.copyfile(ROOT / 'tools/check_contracts.py', script)
            def run():
                return subprocess.run(['python3', str(script)], capture_output=True, text=True, timeout=10)
            result = run()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('OK', result.stdout)
            self.assertEqual(result.stderr, '')
            (root / 'contracts/examples/v0.2/sample.valid.json').write_text('{}')
            result = run()
            self.assertEqual(result.returncode, 1)
            self.assertIn('ERROR:', result.stderr)
            self.assertNotIn('OK', result.stdout)

    def structural_mutants(self, value, schema, validator, root=None):
        root = schema if root is None else root
        if '$ref' in schema:
            target, target_root = validator.resolve(schema['$ref'], root)
            yield from self.structural_mutants(value, target, validator, target_root)
        for branch in schema.get('oneOf', []):
            try:
                validator.validate(value, branch, root)
            except ValidationError:
                continue
            for bad in self.structural_mutants(value, branch, validator, root):
                # A nullable union's alternate value is valid, not a negative control.
                alternate_matches = 0
                for alternate in schema['oneOf']:
                    if alternate is branch:
                        continue
                    try:
                        validator.validate(bad, alternate, root)
                        alternate_matches += 1
                    except ValidationError:
                        pass
                if not alternate_matches:
                    yield bad
        typ = schema.get('type')
        wrong_types = {
            'object': [None, [], '', True, 0], 'array': [None, {}, '', True, 0],
            'string': [None, {}, [], True, 0], 'integer': [None, {}, [], '', True, 1.5],
            'number': [None, {}, [], '', True], 'boolean': [None, {}, [], '', 0],
            'null': [{}, [], '', True, 0]}
        yield from wrong_types.get(typ, [])
        if 'const' in schema or 'enum' in schema:
            yield '__unknown_contract_value__'
        if type(value) in (int, float):
            if 'minimum' in schema: yield schema['minimum'] - 1
            if 'maximum' in schema: yield schema['maximum'] + 1
        if isinstance(value, str):
            if schema.get('minLength', 0): yield ''
            if 'maxLength' in schema: yield 'x' * (schema['maxLength'] + 1)
        if isinstance(value, dict):
            if schema.get('additionalProperties') is False:
                yield {**value, 'unexpected': True}
            for key in schema.get('required', []):
                bad = copy.deepcopy(value); del bad[key]; yield bad
            for key, child in schema.get('properties', {}).items():
                if key in value:
                    for bad in self.structural_mutants(value[key], child, validator, root):
                        yield {**value, key: bad}
        if isinstance(value, list):
            if schema.get('minItems', 0): yield []
            if 'maxItems' in schema:
                yield [None] * (schema['maxItems'] + 1)
            if 'items' in schema:
                for index, item in enumerate(value):
                    for bad in self.structural_mutants(item, schema['items'], validator, root):
                        yield value[:index] + [bad] + value[index + 1:]

    def assert_mutants(self, value, schema, validator):
        validator.validate(value, schema)
        seen = {json.dumps(value, sort_keys=True)}
        count = 0
        for bad in self.structural_mutants(value, schema, validator):
            encoded = json.dumps(bad, sort_keys=True)
            if encoded in seen:
                continue
            seen.add(encoded)
            with self.subTest(mutant=encoded):
                with self.assertRaises(ValidationError): validator.validate(bad, schema)
            count += 1
        self.assertGreaterEqual(count, 10, 'insufficient distinct applicable mutants')

    def test_structural_mutation_generator(self):
        with tempfile.TemporaryDirectory() as temp:
            root = self.make_repository(Path(temp))
            validator = Validator(root / 'contracts/v0.2')
            schema = validator.load('sample.schema.json')
            good = json.loads((root / 'contracts/examples/v0.2/sample.valid.json').read_text())
            self.assert_mutants(good, schema, validator)

    def test_union_oracle_with_isolated_bodies(self):
        # Synthetic bodies exercise union wiring without qualifying absent producers.
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            schema = json.loads((ROOT / 'contracts/v0.2/envelope.schema.json').read_text())
            for name in self.names:
                body_schema = {'type': 'object', 'additionalProperties': False,
                               'properties': {'schema': {'const': name + '/v0.2'}},
                               'required': ['schema']}
                (directory / (name + '.schema.json')).write_text(json.dumps(body_schema))
            validator = Validator(directory)
            validator.audit(schema)
            header = json.loads((ROOT / 'contracts/examples/envelope.valid.json').read_text())
            for name in self.names:
                good = {**header, 'schema': 'envelope/v0.2', 'body': {'schema': name + '/v0.2'}}
                self.assert_mutants(good, schema, validator)
                for bad in ({**good, 'schema': 'envelope/v0.1'},
                            {**good, 'body': {'schema': name + '/v0.1'}},
                            {**good, 'body': {'schema': 'envelope/v0.2'}},
                            {**good, 'body': {'schema': 'unknown/v0.2'}}):
                    with self.assertRaises(ValidationError): validator.validate(bad, schema)

    def test_every_v02_body_roundtrip_and_mutants(self):
        validator = Validator(ROOT / 'contracts/v0.2')
        envelope = validator.load('envelope.schema.json')
        header = json.loads((ROOT / 'contracts/examples/envelope.valid.json').read_text())
        header['schema'] = 'envelope/v0.2'
        missing = [name for name in self.names
                   if not (ROOT / 'contracts/v0.2' / (name + '.schema.json')).is_file()
                   or not (ROOT / 'contracts/examples/v0.2' / (name + '.valid.json')).is_file()]
        self.assertEqual(missing, [], 'body schemas or valid fixtures missing')
        for path in sorted((ROOT / 'contracts/v0.2').glob('*.schema.json')):
            with self.subTest(schema=path.name):
                fixture = ROOT / 'contracts/examples/v0.2' / (path.name.removesuffix('.schema.json') + '.valid.json')
                good = json.loads(fixture.read_text())
                self.assert_mutants(good, validator.load(path.name), validator)
        for name in self.names:
            with self.subTest(body=name):
                body = json.loads((ROOT / 'contracts/examples/v0.2' / (name + '.valid.json')).read_text())
                value = {**header, 'body': body}
                validator.validate(value, envelope)
                mutants = [{**value, 'schema': 'envelope/v0.1'}, {**value, 'unexpected': True},
                           {**value, 'body': {**body, 'unexpected': True}},
                           {**value, 'body': {**body, 'schema': name + '/v0.1'}},
                           {**value, 'body': {'schema': 'envelope/v0.2'}}]
                for field in envelope['required']:
                    bad = copy.deepcopy(value); del bad[field]; mutants.append(bad)
                for field, bad_field in (('seq', True), ('seq', 0), ('ts_ns', -1),
                                         ('nonce', ''), ('msg_id', 'x' * 129),
                                         ('from', {**value['from'], 'unexpected': True})):
                    mutants.append({**value, field: bad_field})
                self.assertGreaterEqual(len(mutants), 10)
                for bad in mutants:
                    with self.assertRaises(ValidationError): validator.validate(bad, envelope)


class TransportCapTests(unittest.TestCase):
    def test_max_properties_boundaries_and_bad_keyword_values(self):
        validator = Validator(ROOT / 'contracts/v0.2')
        schema = {'type': 'object', 'additionalProperties': False,
                  'properties': {str(i): {'type': 'null'} for i in range(257)},
                  'maxProperties': 256}
        validator.audit(schema)
        for count in (0, 255, 256):
            validator.validate({str(i): None for i in range(count)}, schema)
        with self.assertRaisesRegex(ValidationError, 'too many properties'):
            validator.validate({str(i): None for i in range(257)}, schema)
        for bad in (-1, True, 1.5, '256', None):
            with self.subTest(bad=bad), self.assertRaises(ValidationError):
                validator.audit({**schema, 'maxProperties': bad})
        validator.audit({**schema, 'maxProperties': 0})
        validator.validate({}, {**schema, 'maxProperties': 0})
        with self.assertRaises(ValidationError):
            validator.validate({'0': None}, {**schema, 'maxProperties': 0})

    def test_transport_array_and_string_boundaries(self):
        validator = Validator(ROOT / 'contracts/v0.2')
        for schema, good, bad in (
                ({'type': 'string', 'maxLength': 65536}, 'a' * 65536, 'a' * 65537),
                ({'type': 'array', 'maxItems': 4096, 'items': {'type': 'null'}},
                 [None] * 4096, [None] * 4097)):
            validator.audit(schema)
            validator.validate(good, schema)
            with self.assertRaises(ValidationError): validator.validate(bad, schema)
        # JSON Schema length counts code points; UTF-8 byte enforcement belongs to IPC.
        validator.validate('éé', {'type': 'string', 'maxLength': 2})
        b64 = validator.load('terminal_session.schema.json')['$defs']['b64']
        validator.validate('A' * 65536, b64)
        with self.assertRaises(ValidationError): validator.validate('A' * 65540, b64)

    def test_every_v02_schema_node_has_transport_caps(self):
        def walk(schema):
            typ = schema.get('type')
            for kind, keyword, limit in (('string', 'maxLength', 65536),
                                         ('array', 'maxItems', 4096),
                                         ('object', 'maxProperties', 256)):
                if typ == kind:
                    self.assertIn(keyword, schema)
                    self.assertLessEqual(schema[keyword], limit)
            for keyword in ('properties', '$defs'):
                for child in schema.get(keyword, {}).values(): walk(child)
            for child in schema.get('oneOf', []): walk(child)
            if 'items' in schema: walk(schema['items'])
        for path in (ROOT / 'contracts/v0.2').glob('*.schema.json'):
            with self.subTest(path=path.name): walk(json.loads(path.read_text()))

    def test_nullable_alternatives_are_not_negative_controls(self):
        schema = {'oneOf': [{'type': 'string', 'minLength': 1}, {'type': 'null'}]}
        validator = Validator(ROOT / 'contracts/v0.2')
        generator = VersionedContractTests()
        mutants = list(generator.structural_mutants('text', schema, validator))
        self.assertNotIn(None, mutants)
        for bad in mutants:
            with self.assertRaises(ValidationError): validator.validate(bad, schema)
