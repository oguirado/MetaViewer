import copy
import json
from pathlib import Path
import tempfile
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
            self.assertEqual(check_repository(root), [])
            (examples / 'surface.valid.json').write_text(json.dumps(bad))
            self.assertTrue(check_repository(root))
            (examples / 'surface.valid.json').write_text(json.dumps(good))
            (examples / 'surface.invalid.width.json').write_text(json.dumps(good))
            self.assertTrue(check_repository(root))
            (examples / 'surface.invalid.width.json').unlink()
            self.assertTrue(check_repository(root))

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
