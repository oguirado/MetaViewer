"""Layout v0.2 closed shapes, including bounds and negative controls."""
import copy
import unittest

from tools.check_contracts import ROOT, Validator, ValidationError


CASES = {
    'hide': {'slot_id': 'cuk-ai-slot-capsule'},
    'show': {'slot_id': 'capsule'},
    'move': {'slot_id': 'capsule', 'group_id': 'destination', 'index': 0},
    'tab': {'slot_id': 'capsule', 'group_id': 'tabs', 'index': 255},
    'float': {'slot_id': 'capsule', 'x_px': 0, 'y_px': 16383,
              'width_px': 16384, 'height_px': 1},
}


class LayoutIntentContracts(unittest.TestCase):
    def test_closed_shapes_and_numeric_bounds(self):
        validator = Validator(ROOT / 'contracts/v0.2')
        schema = validator.load('ui_intent.schema.json')
        for op, params in CASES.items():
            good = {'schema': 'ui_intent/v0.2', 'request_id': 'layout',
                    'op': op, 'params': params}
            validator.validate(good, schema)
            bad = [{**good, 'extra': True}, {**good, 'params': {**params, 'extra': True}}]
            for key in good:
                mutant = copy.deepcopy(good)
                del mutant[key]
                bad.append(mutant)
            for key, value in params.items():
                mutant = copy.deepcopy(good)
                del mutant['params'][key]
                bad.append(mutant)
                for invalid in ([None, '', 'bad id'] if isinstance(value, str)
                                else [None, -1, 0.5, True, '1', 16385]):
                    bad.append({**good, 'params': {**params, key: invalid}})
            for mutant in bad:
                with self.subTest(op=op, mutant=mutant), self.assertRaises(ValidationError):
                    validator.validate(mutant, schema)
