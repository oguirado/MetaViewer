"""Strict validator for the frozen command schema subset, with no I/O."""
import re
from ._schemas import SCHEMAS
from .wire import scalar_safe, WireError


class Invalid(ValueError):
    pass


class Contracts:
    def validate(self, name, value):
        if name not in SCHEMAS:
            raise Invalid('unknown contract')
        scalar_safe(value)
        self._check(SCHEMAS[name], value, SCHEMAS[name])

    def _check(self, schema, value, document, depth=0):
        if depth > 64:
            raise Invalid('schema recursion')
        allowed = {'$schema', '$id', 'title', 'description', '$defs', '$ref', 'oneOf',
                   'type', 'properties', 'required', 'additionalProperties', 'const',
                   'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern'}
        if type(schema) is not dict or set(schema)-allowed:
            raise Invalid('unsupported schema keyword')
        if '$ref' in schema:
            filename, _, fragment = schema['$ref'].partition('#')
            target_document = SCHEMAS[filename] if filename else document
            target = target_document
            for part in fragment.split('/')[1:]:
                target = target[part.replace('~1','/').replace('~0','~')]
            self._check(target, value, target_document, depth+1)
        if 'oneOf' in schema:
            matches = 0
            for variant in schema['oneOf']:
                try:
                    self._check(variant, value, document, depth+1)
                    matches += 1
                except Invalid:
                    pass
            if matches != 1:
                raise Invalid('oneOf mismatch')
        if 'const' in schema and (type(value) is not type(schema['const']) or value != schema['const']):
            raise Invalid('const mismatch')
        if 'enum' in schema and not any(type(value) is type(item) and value == item for item in schema['enum']):
            raise Invalid('enum mismatch')
        kind = schema.get('type')
        if kind == 'object':
            if type(value) is not dict or not set(schema.get('required',[])) <= set(value):
                raise Invalid('object or required fields')
            properties = schema.get('properties',{})
            if schema.get('additionalProperties') is not False or set(value)-set(properties):
                raise Invalid('open or extra object fields')
            for key, item in value.items():
                self._check(properties[key], item, document, depth+1)
        elif kind == 'integer':
            if type(value) is not int or not schema.get('minimum',-(2**53-1)) <= value <= schema.get('maximum',2**53-1):
                raise Invalid('integer range/type')
        elif kind == 'string':
            if type(value) is not str or not schema.get('minLength',0) <= len(value) <= schema.get('maxLength',65536):
                raise Invalid('string range/type')
            if 'pattern' in schema and re.fullmatch(schema['pattern'],value) is None:
                raise Invalid('string pattern')
        elif kind == 'boolean':
            if type(value) is not bool:
                raise Invalid('boolean type')
        elif kind == 'null':
            if value is not None:
                raise Invalid('null type')
        elif kind is not None:
            raise Invalid('unsupported schema type')

    def wire(self, kind, metadata, payload_length):
        self.validate('guest_transport_metadata.schema.json', metadata)
        expected = {'hello':1, 'exec':2, 'cancel':3, 'stop':4,
                    'ready':5, 'accepted':5, 'output':5, 'job_finished':5,
                    'stopping':5, 'error':5}
        if expected[metadata['kind']] != kind:
            raise Invalid('header/metadata type mismatch')
        if metadata['kind'] == 'exec':
            length = metadata['command_bytes'] + metadata['stdin_bytes']
            self.cwd(metadata['cwd'])
            if payload_length != length:
                raise Invalid('exec byte lengths')
        elif metadata['kind'] == 'output':
            if not 1 <= payload_length <= 16384:
                raise Invalid('output byte length')
        elif payload_length != 0:
            raise Invalid('unexpected payload')

    @staticmethod
    def cwd(value):
        if (type(value) is not str or len(value.encode('utf-8')) > 1024 or
                any(ord(char) < 32 or ord(char) == 127 for char in value) or
                (value and (value.startswith('/') or any(
                    part in ('','.','..') or len(part.encode('utf-8')) > 255
                    for part in value.split('/'))))):
            raise Invalid('relative workspace path required')
