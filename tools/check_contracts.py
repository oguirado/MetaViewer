#!/usr/bin/env python3
"""Fail-closed validator for the documented contract schema subset, not full JSON Schema."""
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
DRAFT = 'https://json-schema.org/draft/2020-12/schema'
BASE = 'https://metaviewer.local/contracts/v0.1/'
KEYWORDS = {'$schema', '$id', 'title', 'description', '$defs', '$ref', 'type',
            'properties', 'required', 'additionalProperties', 'enum', 'const',
            'oneOf', 'items', 'minItems', 'minimum', 'maximum', 'minLength',
            'maxLength', 'pattern'}
TYPES = {'object', 'array', 'string', 'integer', 'number', 'boolean', 'null'}

class ValidationError(ValueError):
    pass

class Validator:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.cache = {}

    def load(self, filename):
        path = (self.directory / filename).resolve()
        if path.parent != self.directory or not path.name.endswith('.schema.json'):
            raise ValidationError('reference must name a sibling schema')
        if path not in self.cache:
            self.cache[path] = json.loads(path.read_text())
        return self.cache[path]

    def resolve(self, ref, root):
        filename, separator, fragment = ref.partition('#')
        target = self.load(filename) if filename else root
        if separator:
            if not fragment.startswith('/$defs/'):
                raise ValidationError('only #/$defs references are supported')
            for part in fragment[1:].split('/'):
                try:
                    target = target[part.replace('~1', '/').replace('~0', '~')]
                except (KeyError, TypeError) as exc:
                    raise ValidationError('unresolved reference: ' + ref) from exc
        return target, self.load(filename) if filename else root

    def audit(self, schema, root=None):
        root = schema if root is None else root
        if not isinstance(schema, dict) or set(schema) - KEYWORDS:
            raise ValidationError('bad schema or unsupported keyword')
        typ = schema.get('type')
        if typ is not None and (not isinstance(typ, str) or typ not in TYPES):
            raise ValidationError('unsupported schema type')
        if typ == 'object' or 'properties' in schema:
            if schema.get('additionalProperties') is not False:
                raise ValidationError('every object schema must set additionalProperties false')
            props = schema.get('properties', {})
            if not isinstance(props, dict):
                raise ValidationError('properties must be an object')
            required = schema.get('required', [])
            if not isinstance(required, list) or any(not isinstance(x, str) or x not in props for x in required):
                raise ValidationError('required must name declared properties')
            for child in props.values():
                self.audit(child, root)
        for key in ('minimum', 'maximum'):
            if key in schema and (type(schema[key]) not in (int, float)):
                raise ValidationError(key + ' must be numeric')
        for key in ('minLength', 'maxLength', 'minItems'):
            if key in schema and (type(schema[key]) is not int or schema[key] < 0):
                raise ValidationError(key + ' must be a nonnegative integer')
        if 'pattern' in schema:
            try:
                re.compile(schema['pattern'])
            except (TypeError, re.error) as exc:
                raise ValidationError('invalid pattern') from exc
        if 'enum' in schema and (not isinstance(schema['enum'], list) or not schema['enum']):
            raise ValidationError('enum must be a nonempty array')
        if '$ref' in schema:
            self.resolve(schema['$ref'], root)
        for child in schema.get('$defs', {}).values():
            self.audit(child, root)
        if 'oneOf' in schema:
            if not isinstance(schema['oneOf'], list) or not schema['oneOf']:
                raise ValidationError('oneOf must be a nonempty array')
            for child in schema['oneOf']:
                self.audit(child, root)
        if 'items' in schema:
            self.audit(schema['items'], root)

    def validate(self, value, schema, root=None, path='$', depth=0):
        if depth > 100:
            raise ValidationError(path + ': reference nesting limit')
        root = schema if root is None else root
        def fail(message):
            raise ValidationError(path + ': ' + message)
        if '$ref' in schema:
            target, target_root = self.resolve(schema['$ref'], root)
            self.validate(value, target, target_root, path, depth + 1)
        typ = schema.get('type')
        matches = {'object': isinstance(value, dict), 'array': isinstance(value, list),
                   'string': isinstance(value, str), 'integer': type(value) is int,
                   'number': type(value) in (int, float), 'boolean': type(value) is bool,
                   'null': value is None}
        if typ is not None and not matches[typ]:
            fail('expected ' + typ)
        def equal(a, b):
            # JSON boolean values must never compare equal to numbers.
            if type(a) is bool or type(b) is bool:
                return type(a) is type(b) and a == b
            if isinstance(a, dict) and isinstance(b, dict):
                return a.keys() == b.keys() and all(equal(a[k], b[k]) for k in a)
            if isinstance(a, list) and isinstance(b, list):
                return len(a) == len(b) and all(equal(x, y) for x, y in zip(a, b))
            return a == b
        if 'const' in schema and not equal(value, schema['const']):
            fail('const mismatch')
        if 'enum' in schema and not any(equal(value, x) for x in schema['enum']):
            fail('enum mismatch')
        if 'oneOf' in schema:
            count = 0
            for branch in schema['oneOf']:
                try:
                    self.validate(value, branch, root, path, depth + 1)
                    count += 1
                except ValidationError:
                    pass
            if count != 1:
                fail('oneOf must match exactly one branch')
        if isinstance(value, dict):
            for key in schema.get('required', []):
                if key not in value:
                    fail('missing ' + key)
            props = schema.get('properties', {})
            if schema.get('additionalProperties') is False and value.keys() - props.keys():
                fail('unexpected properties: ' + ', '.join(sorted(value.keys() - props.keys())))
            for key in value.keys() & props.keys():
                self.validate(value[key], props[key], root, path + '.' + key, depth + 1)
        if isinstance(value, list):
            if len(value) < schema.get('minItems', 0):
                fail('too few items')
            if 'items' in schema:
                for index, item in enumerate(value):
                    self.validate(item, schema['items'], root, f'{path}[{index}]', depth + 1)
        if isinstance(value, str):
            if len(value) < schema.get('minLength', 0) or len(value) > schema.get('maxLength', float('inf')):
                fail('string length outside bounds')
            if 'pattern' in schema and not re.search(schema['pattern'], value):
                fail('pattern mismatch')
        if type(value) in (int, float):
            if value < schema.get('minimum', -float('inf')) or value > schema.get('maximum', float('inf')):
                fail('number outside bounds')

def check_repository(root=ROOT):
    directory = root / 'contracts/v0.1'
    validator = Validator(directory)
    errors = []
    schemas = sorted(directory.glob('*.schema.json'))
    if not schemas:
        return ['no schemas found']
    known_examples = set()
    for path in schemas:
        name = path.name.removesuffix('.schema.json')
        try:
            schema = validator.load(path.name)
            if schema.get('$id') != BASE + path.name or schema.get('$schema') != DRAFT or not schema.get('title'):
                raise ValidationError('schema identity, draft or title invalid')
            validator.audit(schema)
            groups = [list((root / 'contracts/examples').glob(name + '.valid.json')),
                      list((root / 'contracts/examples').glob(name + '.invalid.*.json'))]
            if any(not group for group in groups):
                raise ValidationError('valid and invalid examples required')
            for valid, group in zip((True, False), groups):
                for example in group:
                    known_examples.add(example)
                    value = json.loads(example.read_text())
                    try:
                        validator.validate(value, schema)
                        passed = True
                    except ValidationError:
                        passed = False
                    if valid != passed:
                        errors.append(f'{example.name}: expected {"pass" if valid else "failure"}')
        except (OSError, ValueError, TypeError, KeyError) as exc:
            errors.append(f'{path.name}: {exc}')
    for path in (root / 'contracts/examples').glob('*.json'):
        if path not in known_examples:
            errors.append('unrecognized or unchecked example: ' + path.name)
    return errors

def main():
    errors = check_repository()
    for error in errors:
        print('ERROR: ' + error, file=sys.stderr)
    if not errors:
        print('Contracts check: OK (schemas audited; valid examples accepted; invalid examples rejected)')
    return bool(errors)

if __name__ == '__main__':
    sys.exit(main())
