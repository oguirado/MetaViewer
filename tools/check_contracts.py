#!/usr/bin/env python3
"""Fail-closed validator for the documented contract schema subset, not full JSON Schema."""
import json
import math
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
DRAFT = 'https://json-schema.org/draft/2020-12/schema'
BASE = 'https://metaviewer.local/contracts/v0.1/'
SUPPORTED_VERSIONS = ('v0.1', 'v0.2')
KEYWORDS = {'$schema', '$id', 'title', 'description', '$defs', '$ref', 'type',
            'properties', 'required', 'additionalProperties', 'enum', 'const',
            'oneOf', 'items', 'minItems', 'minimum', 'maximum', 'minLength',
            'maxLength', 'maxItems', 'maxProperties', 'pattern'}
TYPES = {'object', 'array', 'string', 'integer', 'number', 'boolean', 'null'}
MAX_SAFE_INTEGER = (1 << 53) - 1

class ValidationError(ValueError):
    pass

def _finite(value, depth=0):
    if depth > 100:
        raise ValidationError('JSON nesting limit')
    if isinstance(value, float) and not math.isfinite(value):
        raise ValidationError('nonfinite number')
    if isinstance(value, dict):
        for child in value.values():
            _finite(child, depth + 1)
    elif isinstance(value, list):
        for child in value:
            _finite(child, depth + 1)


def loads_strict(raw):
    def pairs(entries):
        result = {}
        for key, value in entries:
            if key in result:
                raise ValidationError('duplicate JSON key: ' + key)
            result[key] = value
        return result

    def constant(value):
        raise ValidationError('invalid JSON constant: ' + value)

    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, RecursionError) as exc:
        raise ValidationError(str(exc)) from exc
    _finite(value)
    return value

class Validator:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.cache = {}

    def load(self, filename):
        if (not isinstance(filename, str) or not filename.endswith('.schema.json')
                or '/' in filename or '\\' in filename or '..' in filename):
            raise ValidationError('reference must name a sibling schema')
        path = (self.directory / filename).resolve()
        if path.parent != self.directory or not path.name.endswith('.schema.json'):
            raise ValidationError('reference must name a sibling schema')
        if path not in self.cache:
            schema = loads_strict(path.read_text())
            if not isinstance(schema, dict):
                raise ValidationError('schema must be an object')
            self.cache[path] = schema
        return self.cache[path]

    def resolve(self, ref, root):
        if not isinstance(ref, str) or not ref:
            raise ValidationError('reference must be a nonempty string')
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
        _finite(schema)
        self._audit(schema, schema if root is None else root, set(), 0)

    def _audit(self, schema, root, active, depth):
        if depth > 100 or id(schema) in active:
            raise ValidationError('cyclic schema or schema nesting limit')
        if not isinstance(schema, dict) or set(schema) - KEYWORDS:
            raise ValidationError('bad schema or unsupported keyword')
        active = active | {id(schema)}
        def child(value, child_root=root):
            self._audit(value, child_root, active, depth + 1)

        typ = schema.get('type')
        if 'type' in schema and (not isinstance(typ, str) or typ not in TYPES):
            raise ValidationError('unsupported schema type')
        for key in ('$schema', '$id', 'title', 'description'):
            if key in schema and not isinstance(schema[key], str):
                raise ValidationError(key + ' must be a string')
        if 'additionalProperties' in schema and schema['additionalProperties'] is not False:
            raise ValidationError('additionalProperties must be false')
        if typ == 'object' or 'properties' in schema or 'required' in schema or 'additionalProperties' in schema:
            if schema.get('additionalProperties') is not False:
                raise ValidationError('every object schema must set additionalProperties false')
            props = schema.get('properties')
            if not isinstance(props, dict):
                raise ValidationError('properties must be an object')
            required = schema.get('required', [])
            if (not isinstance(required, list)
                    or any(not isinstance(x, str) or x not in props for x in required)
                    or len(set(required)) != len(required)):
                raise ValidationError('required must name unique declared properties')
            for value in props.values():
                child(value)
        for key in ('minimum', 'maximum'):
            if key in schema and type(schema[key]) not in (int, float):
                raise ValidationError(key + ' must be numeric')
        for key in ('minLength', 'maxLength', 'minItems', 'maxItems', 'maxProperties'):
            if key in schema and (type(schema[key]) is not int or schema[key] < 0):
                raise ValidationError(key + ' must be a nonnegative integer')
        for low, high in (('minimum', 'maximum'), ('minLength', 'maxLength'), ('minItems', 'maxItems')):
            if low in schema and high in schema and schema[low] > schema[high]:
                raise ValidationError('inverted bounds')
        if 'pattern' in schema:
            try:
                re.compile(schema['pattern'])
            except (TypeError, re.error) as exc:
                raise ValidationError('invalid pattern') from exc
        if 'enum' in schema and (not isinstance(schema['enum'], list) or not schema['enum']):
            raise ValidationError('enum must be a nonempty array')
        if '$ref' in schema:
            target, target_root = self.resolve(schema['$ref'], root)
            child(target, target_root)
        if '$defs' in schema:
            if not isinstance(schema['$defs'], dict):
                raise ValidationError('$defs must be an object')
            for value in schema['$defs'].values():
                child(value)
        if 'oneOf' in schema:
            if not isinstance(schema['oneOf'], list) or not schema['oneOf']:
                raise ValidationError('oneOf must be a nonempty array')
            for value in schema['oneOf']:
                child(value)
        if 'items' in schema:
            child(schema['items'])

    def validate(self, value, schema, root=None, path='$', depth=0):
        if depth == 0:
            _finite(value)
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
            if len(value) > schema.get('maxProperties', float('inf')):
                fail('too many properties')
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
            if len(value) > schema.get('maxItems', float('inf')):
                fail('too many items')
            if 'items' in schema:
                for index, item in enumerate(value):
                    self.validate(item, schema['items'], root, f'{path}[{index}]', depth + 1)
        if isinstance(value, str):
            if len(value) < schema.get('minLength', 0) or len(value) > schema.get('maxLength', float('inf')):
                fail('string length outside bounds')
            if 'pattern' in schema:
                pattern = schema['pattern']
                # Wire patterns use exact end anchors, as the Rust decoder does.
                if pattern.endswith('$') and not pattern.endswith(r'\$'):
                    pattern = pattern[:-1] + r'\Z'
                if (not re.search(pattern, value)
                        or (pattern.startswith('^/') and any(c in value for c in '\r\n'))):
                    fail('pattern mismatch')
        if type(value) in (int, float):
            if value < schema.get('minimum', -float('inf')) or value > schema.get('maximum', float('inf')):
                fail('number outside bounds')

def positive_examples(directory, name):
    """Include the original positive and explicitly named positive variants."""
    directory = Path(directory)
    return sorted([*directory.glob(name + '.valid.json'),
                   *directory.glob(name + '.valid.*.json')])


def variant_coverage(validator, schema, values):
    """Return unwitnessed enum members / oneOf branches reachable from schema.

    [TARGET, unit decision] v0.2 positive fixtures must cover each reachable
    schema alternative, including optional properties and referenced definitions.
    Only whole-document valid values can witness an alternative. Node identity
    shares referenced obligations without requiring a Cartesian product.
    """
    required, witnessed, visited = {}, set(), set()

    def discover(node, root, path):
        if id(node) in visited:
            return
        visited.add(id(node))
        for keyword in ('enum', 'oneOf'):
            for index, _ in enumerate(node.get(keyword, [])):
                required[(id(node), keyword, index)] = f'{path}/{keyword}/{index}'
        if '$ref' in node:
            target, target_root = validator.resolve(node['$ref'], root)
            discover(target, target_root, path + '/$ref:' + node['$ref'])
        for key, child in node.get('properties', {}).items():
            discover(child, root, path + '/properties/' + key)
        if 'items' in node:
            discover(node['items'], root, path + '/items')
        for index, child in enumerate(node.get('oneOf', [])):
            discover(child, root, f'{path}/oneOf/{index}')

    def observe(value, node, root):
        for index, member in enumerate(node.get('enum', [])):
            try:
                validator.validate(value, {'const': member})
            except ValidationError:
                continue
            witnessed.add((id(node), 'enum', index))
        if '$ref' in node:
            target, target_root = validator.resolve(node['$ref'], root)
            observe(value, target, target_root)
        for index, branch in enumerate(node.get('oneOf', [])):
            try:
                validator.validate(value, branch, root)
            except ValidationError:
                continue
            witnessed.add((id(node), 'oneOf', index))
            observe(value, branch, root)
        if isinstance(value, dict):
            for key, child in node.get('properties', {}).items():
                if key in value:
                    observe(value[key], child, root)
        if isinstance(value, list) and 'items' in node:
            for child in value:
                observe(child, node['items'], root)

    discover(schema, schema, '$')
    for value in values:
        validator.validate(value, schema)
        observe(value, schema, schema)
    return sorted(label for key, label in required.items() if key not in witnessed)


def check_repository(root=ROOT, *, versions=SUPPORTED_VERSIONS):
    if (not isinstance(versions, tuple) or not versions
            or any(not isinstance(v, str) or v not in SUPPORTED_VERSIONS for v in versions)
            or len(set(versions)) != len(versions)):
        return ['unsupported, empty or duplicate version selection']
    root = Path(root)
    errors = []
    for version in versions:
        directory = root / 'contracts' / version
        examples = root / 'contracts/examples'
        if version != 'v0.1':
            examples /= version
        validator = Validator(directory)
        schemas = sorted(directory.glob('*.schema.json'))
        if not schemas:
            errors.append(f'{version}: {directory}: no schemas found')
        if not examples.is_dir():
            errors.append(f'{version}: {examples}: example directory missing')
        known_examples = set()
        for path in schemas:
            name = path.name.removesuffix('.schema.json')
            groups = [positive_examples(examples, name),
                      sorted(examples.glob(name + '.invalid.*.json'))]
            known_examples.update(example for group in groups for example in group)
            try:
                schema = validator.load(path.name)
                prefix = f'https://metaviewer.local/contracts/{version}/'
                if (schema.get('$id') != prefix + path.name or schema.get('$schema') != DRAFT
                        or not isinstance(schema.get('title'), str) or not schema['title']):
                    raise ValidationError('schema identity, draft or title invalid')
                validator.audit(schema)
            except (OSError, ValueError, TypeError, KeyError, RecursionError) as exc:
                errors.append(f'{version}: {path}: {exc}')
                continue
            if any(not group for group in groups):
                errors.append(f'{version}: {path}: valid and invalid examples required')
            positives = []
            for valid, group in zip((True, False), groups):
                for example in group:
                    try:
                        value = loads_strict(example.read_text())
                    except (OSError, ValueError, RecursionError) as exc:
                        errors.append(f'{version}: {example}: {exc}')
                        continue
                    try:
                        validator.validate(value, schema)
                        passed = True
                    except ValidationError:
                        passed = False
                    if valid != passed:
                        errors.append(f'{version}: {example}: expected {"pass" if valid else "failure"}')
                    if valid and passed:
                        positives.append(value)
            if version == 'v0.2':
                for missing in variant_coverage(validator, schema, positives):
                    errors.append(f'{version}: {path}: unwitnessed alternative {missing}')
        for path in sorted(examples.glob('*.json')):
            if path not in known_examples:
                errors.append(f'{version}: {path}: unrecognized or unchecked example')
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
