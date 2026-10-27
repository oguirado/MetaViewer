"""Mutant rejection tests for every versioned contract schema (L2).

For each schema in every supported contract version, the valid example is
mutated five ways -- a required key dropped, an unknown key added, a value
given the wrong type, a value pushed out of range, a const/enum value
flipped -- and the validator must reject every mutant. The unmutated valid
example must pass (positive control).
"""

import copy
import json
import unittest

from tools.check_contracts import (ROOT, SUPPORTED_VERSIONS, ValidationError, Validator,
                                   positive_examples, variant_coverage)

MIN_MUTANTS_PER_SCHEMA = 10
UNKNOWN_KEY = "zz_mutant_unexpected"
MAX_ARRAY_FANOUT = 32
MAX_DEPTH = 100

_MISSING = object()

_ALL_KINDS = frozenset({"object", "array", "string", "integer", "number", "boolean", "null"})
_TYPE_KINDS = {
    "object": {"object"},
    "array": {"array"},
    "string": {"string"},
    "integer": {"integer"},
    "number": {"integer", "number"},
    "boolean": {"boolean"},
    "null": {"null"},
}
_WRONG_TYPE_CANDIDATES = (
    ("string", "zz_mutant_unexpected"),
    ("integer", 7),
    ("boolean", True),
    ("null", None),
    ("array", ["zz_mutant_unexpected"]),
    ("object", {"zz_mutant_unexpected": True}),
)
_PURE_REF_KEYS = frozenset({"$ref", "description", "title"})


def _kind(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    return "object"


def _accepted_kinds(validator, schema, root, seen):
    """JSON kinds the node schema may accept, over-approximated."""
    if not isinstance(schema, dict) or id(schema) in seen:
        return set(_ALL_KINDS)
    seen = seen | {id(schema)}
    kinds = None

    def narrow(other):
        nonlocal kinds
        kinds = set(other) if kinds is None else kinds & other

    if "type" in schema:
        narrow(_TYPE_KINDS.get(schema["type"], _ALL_KINDS))
    if "const" in schema:
        narrow({_kind(schema["const"])})
    if "enum" in schema:
        members = schema["enum"]
        narrow({_kind(item) for item in members} if isinstance(members, list) else _ALL_KINDS)
    branches = schema.get("oneOf")
    if isinstance(branches, list) and branches:
        union = set()
        for branch in branches:
            union |= _accepted_kinds(validator, branch, root, seen)
        narrow(union)
    if "$ref" in schema:
        try:
            target, target_root = validator.resolve(schema["$ref"], root)
        except ValidationError:
            return set(_ALL_KINDS)
        narrow(_accepted_kinds(validator, target, target_root, seen))
    if kinds is None:
        return set(_ALL_KINDS)
    if kinds & {"integer", "number"}:
        kinds |= {"integer", "number"}  # JSON 1 == 1.0 across the int/float line
    return kinds


def _wrong_type_value(kinds, value):
    original = _kind(value)
    for kind, candidate in _WRONG_TYPE_CANDIDATES:
        if kind != original and kind not in kinds:
            return copy.deepcopy(candidate)
    return _MISSING


def _matched_branch(validator, schema, root, value):
    branches = schema.get("oneOf")
    if not isinstance(branches, list) or not branches:
        return _MISSING
    hit = _MISSING
    for branch in branches:
        try:
            validator.validate(value, branch, root)
        except ValidationError:
            continue
        if hit is not _MISSING:
            return _MISSING
        hit = branch
    return hit


def _resolve_node(validator, schema, root, value):
    """Follow pure $refs and the uniquely matched oneOf branch."""
    depth = 0
    while depth < MAX_DEPTH and isinstance(schema, dict):
        if "$ref" in schema and set(schema) <= _PURE_REF_KEYS:
            try:
                schema, root = validator.resolve(schema["$ref"], root)
            except ValidationError:
                break
        elif isinstance(schema.get("oneOf"), list) and schema["oneOf"]:
            branch = _matched_branch(validator, schema, root, value)
            if branch is _MISSING:
                break
            schema = branch
        else:
            break
        depth += 1
    return schema, root


def _flip_const(value, const):
    if isinstance(value, str):
        candidate = "zz_mutant_other"
        while candidate == const:
            candidate += "_x"
        return candidate
    if type(value) in (int, float):
        step = 1 if type(value) is int else 1.0
        candidate = value + step
        while candidate == const:
            candidate += step
        return candidate
    if type(value) is bool:
        return not value
    if value is None:
        return False
    if isinstance(value, dict):
        candidate = dict(value)
        extra = UNKNOWN_KEY
        while extra in candidate:
            extra += "_x"
        candidate[extra] = True
        while candidate == const:
            extra += "_x"
            candidate[extra] = True
        return candidate
    if isinstance(value, list):
        candidate = list(value) + ["zz_mutant_other"]
        while candidate == const:
            candidate.append("zz_mutant_other")
        return candidate
    return _MISSING


def _flip_enum(value, members):
    if not isinstance(members, list):
        return _MISSING
    if isinstance(value, str):
        candidate = "zz_mutant_not_in_enum"
        while any(type(item) is str and item == candidate for item in members):
            candidate += "_x"
        return candidate
    if type(value) in (int, float):
        step = 1 if type(value) is int else 1.0
        candidate = value + step
        while any(type(item) in (int, float) and item == candidate for item in members):
            candidate += step
        return candidate
    if type(value) is bool:
        candidate = not value
        if any(type(item) is bool and item == candidate for item in members):
            return _MISSING
        return candidate
    if value is None:
        if any(type(item) is bool and item is False for item in members):
            return _MISSING
        return False
    if isinstance(value, dict):
        candidate = dict(value)
        extra = UNKNOWN_KEY
        while extra in candidate:
            extra += "_x"
        candidate[extra] = True
        while any(type(item) is dict and item == candidate for item in members):
            extra += "_x"
            candidate[extra] = True
        return candidate
    if isinstance(value, list):
        candidate = list(value) + ["zz_mutant_not_in_enum"]
        while any(type(item) is list and item == candidate for item in members):
            candidate.append("zz_mutant_not_in_enum")
        return candidate
    return _MISSING


def _emit_ops(validator, schema, root, resolved, value, path, ops):
    kinds = _accepted_kinds(validator, schema, root, frozenset())
    if isinstance(value, dict):
        ops.append(("add_unknown", path))
        required = resolved.get("required") if isinstance(resolved, dict) else None
        if isinstance(required, list):
            for key in sorted(set(required) & value.keys()):
                ops.append(("drop", path, key))
    candidate = _wrong_type_value(kinds, value)
    if candidate is not _MISSING:
        ops.append(("wrong_type", path, candidate))
    if not isinstance(resolved, dict):
        return
    if type(value) in (int, float) and resolved.get("type") in ("integer", "number"):
        minimum, maximum = resolved.get("minimum"), resolved.get("maximum")
        if type(minimum) in (int, float):
            ops.append(("range_min", path, minimum - 1))
        if type(maximum) in (int, float):
            ops.append(("range_max", path, maximum + 1))
    if isinstance(value, str) and resolved.get("type") == "string":
        min_length, max_length = resolved.get("minLength"), resolved.get("maxLength")
        if type(min_length) is int and min_length >= 1:
            ops.append(("range_minlen", path, "q" * (min_length - 1)))
        if type(max_length) is int:
            ops.append(("range_maxlen", path, value + "q" * (max_length - len(value) + 1)))
    if isinstance(value, list) and resolved.get("type") == "array":
        min_items, max_items = resolved.get("minItems"), resolved.get("maxItems")
        if type(min_items) is int and min_items >= 1:
            ops.append(("range_minitems", path, value[:min_items - 1]))
        if type(max_items) is int:
            padding = copy.deepcopy(value[:1]) or [None]
            need = max_items - len(value) + 1
            ops.append(("range_maxitems", path, value + padding * need))
    if "const" in resolved:
        flipped = _flip_const(value, resolved["const"])
        if flipped is not _MISSING:
            ops.append(("flip_const", path, flipped))
    if "enum" in resolved:
        flipped = _flip_enum(value, resolved["enum"])
        if flipped is not _MISSING:
            ops.append(("flip_enum", path, flipped))


def _collect_ops(validator, schema, root, value, path, ops, depth=0):
    if depth > MAX_DEPTH:
        return
    resolved, new_root = _resolve_node(validator, schema, root, value)
    _emit_ops(validator, schema, root, resolved, value, path, ops)
    if not isinstance(resolved, dict):
        return
    if isinstance(value, dict):
        props = resolved.get("properties")
        if isinstance(props, dict):
            for key in sorted(value.keys() & props.keys()):
                _collect_ops(validator, props[key], new_root, value[key], path + (key,), ops, depth + 1)
    elif isinstance(value, list):
        items = resolved.get("items")
        if isinstance(items, dict):
            for index, item in enumerate(value[:MAX_ARRAY_FANOUT]):
                _collect_ops(validator, items, new_root, item, path + (index,), ops, depth + 1)


def _locate(mutant, path):
    node = mutant
    for step in path:
        node = node[step]
    return node


def _apply_op(valid, op):
    tag = op[0]
    if tag == "add_unknown":
        mutant = copy.deepcopy(valid)
        _locate(mutant, op[1])[UNKNOWN_KEY] = True
        return mutant
    if tag == "drop":
        mutant = copy.deepcopy(valid)
        del _locate(mutant, op[1])[op[2]]
        return mutant
    if not op[1]:
        return copy.deepcopy(op[2])
    mutant = copy.deepcopy(valid)
    _locate(mutant, op[1][:-1])[op[1][-1]] = copy.deepcopy(op[2])
    return mutant


def _format_path(path):
    out = "$"
    for step in path:
        out += f"[{step}]" if isinstance(step, int) else f".{step}"
    return out


def _describe(op):
    if op[0] == "drop":
        return f"drop {op[2]!r} at {_format_path(op[1])}"
    return f"{op[0]} at {_format_path(op[1])}"


def generate_mutants(validator, schema, valid):
    ops = []
    _collect_ops(validator, schema, schema, valid, (), ops)
    seen = set()
    mutants = []
    for op in ops:
        mutant = _apply_op(valid, op)
        frozen = json.dumps(mutant, sort_keys=True)
        if frozen in seen:
            continue
        seen.add(frozen)
        mutants.append((op[0], _describe(op), mutant))
    mutants.sort(key=lambda item: (json.dumps(item[2], sort_keys=True), item[0]))
    return mutants


def _examples_dir(version):
    examples = ROOT / "contracts" / "examples"
    return examples if version == "v0.1" else examples / version


class ContractMutantTests(unittest.TestCase):
    def test_every_schema_rejects_its_mutants(self):
        for version in SUPPORTED_VERSIONS:
            validator = Validator(ROOT / "contracts" / version)
            schemas = sorted((ROOT / "contracts" / version).glob("*.schema.json"))
            self.assertTrue(schemas, f"no schemas for {version}")
            for schema_path in schemas:
                name = schema_path.name.removesuffix(".schema.json")
                with self.subTest(version=version, schema=name):
                    schema = validator.load(schema_path.name)
                    validator.audit(schema)
                    fixtures = positive_examples(_examples_dir(version), name)
                    self.assertTrue(fixtures, name)
                    values = [json.loads(path.read_text()) for path in fixtures]
                    if version == 'v0.2':
                        self.assertEqual(variant_coverage(validator, schema, values), [],
                                         f'{name}: missing per-variant positive witnesses')
                    for fixture, valid in zip(fixtures, values):
                        with self.subTest(fixture=fixture.name):
                            validator.validate(valid, schema)
                            mutants = generate_mutants(validator, schema, valid)
                            self.assertGreaterEqual(
                                len(mutants), MIN_MUTANTS_PER_SCHEMA,
                                f"only {len(mutants)} mutants for {fixture.name}"
                            )
                            # Designated oracles for every variant: closed shape,
                            # required fields, and const/enum discriminator rails.
                            tags = {tag for tag, _, _ in mutants}
                            self.assertTrue({'drop', 'add_unknown', 'flip_const'} <= tags, tags)
                            for _tag, description, mutant in mutants:
                                with self.subTest(mutant=description):
                                    with self.assertRaises(ValidationError):
                                        validator.validate(mutant, schema)

    def test_boundary_mutants_and_named_oracles(self):
        """SW-0244 / SW-0064 named boundary mutants (exact-at vs 1-over) must be killed by validator."""
        validator = Validator(ROOT / "contracts/v0.2")

        # 1. maxProperties boundary mutant
        schema_props = {
            "type": "object",
            "additionalProperties": False,
            "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
            "maxProperties": 1
        }
        validator.validate({"a": 1}, schema_props)  # exact-at passes
        with self.assertRaises(ValidationError):
            validator.validate({"a": 1, "b": 2}, schema_props)  # 1-over fails

        # 2. maxItems boundary mutant
        schema_items = {
            "type": "array",
            "items": {"type": "integer"},
            "maxItems": 2
        }
        validator.validate([1, 2], schema_items)  # exact-at passes
        with self.assertRaises(ValidationError):
            validator.validate([1, 2, 3], schema_items)  # 1-over fails

        # 3. maxLength boundary mutant
        schema_len = {
            "type": "string",
            "maxLength": 3
        }
        validator.validate("abc", schema_len)  # exact-at passes
        with self.assertRaises(ValidationError):
            validator.validate("abcd", schema_len)  # 1-over fails

        # 4. minimum/maximum boundary mutant
        schema_num = {
            "type": "integer",
            "minimum": 10,
            "maximum": 20
        }
        validator.validate(10, schema_num)
        validator.validate(20, schema_num)
        with self.assertRaises(ValidationError):
            validator.validate(9, schema_num)
        with self.assertRaises(ValidationError):
            validator.validate(21, schema_num)


if __name__ == "__main__":
    unittest.main()
