#!/usr/bin/env python3
"""Validate additive role contracts and their positive/negative examples."""
import json
from pathlib import Path
from jsonschema import Draft202012Validator
root=Path(__file__).resolve().parents[1]
for name in ['role_request','role_view_state']:
 schema=json.loads((root/'contracts/v0.3'/f'{name}.schema.json').read_text())
 Draft202012Validator.check_schema(schema)
 validator=Draft202012Validator(schema)
 for example in sorted((root/'contracts/examples/v0.3').glob(name+'.*.json')):
  errors=list(validator.iter_errors(json.loads(example.read_text())))
  expected='.invalid.' in example.name
  assert bool(errors)==expected,example.name
  print(example.name+(' rejected' if errors else ' accepted'))
