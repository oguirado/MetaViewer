"""Keep canonical tool results aligned with the effective agent wire contract."""
import copy
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "agents"))

from metaviewer_agents import envelope
from tools.check_contracts import Validator, ValidationError


def inline_local_refs(value, root):
    """Expand canonical local definitions without rewriting version pins."""
    if isinstance(value, dict):
        if "$ref" in value:
            ref = value["$ref"]
            if not ref.startswith("#/$defs/"):
                raise AssertionError(f"unexpected nonlocal reference: {ref}")
            return inline_local_refs(root["$defs"][ref.removeprefix("#/$defs/")], root)
        return {key: inline_local_refs(child, root) for key, child in value.items()}
    if isinstance(value, list):
        return [inline_local_refs(child, root) for child in value]
    return value


def nested_pins(value, path=()):
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "schema" and path:
                yield path + (key,), child
            else:
                yield from nested_pins(child, path + (key,))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from nested_pins(child, path + (index,))


class CanonicalPinTests(unittest.TestCase):
    def setUp(self):
        self.validator = Validator(ROOT / "contracts/v0.2")

    def test_embedded_tool_result_equals_canonical(self):
        canonical = self.validator.load("mv_tool_result.schema.json")
        self.assertEqual(
            envelope._FILES["v0.2/mv_tool_result.schema.json"]["oneOf"],
            inline_local_refs(canonical["oneOf"], canonical),
        )

    def test_versioned_json_contains_no_legacy_pins(self):
        for directory in (ROOT / "contracts/v0.2", ROOT / "contracts/examples/v0.2"):
            paths = sorted(directory.glob("*.json"))
            self.assertTrue(paths)
            for path in paths:
                with self.subTest(path=path.name):
                    self.assertNotIn("/v0.1", path.read_text(encoding="utf-8"))

    def test_each_nested_legacy_pin_is_rejected(self):
        seen = set()
        for name in ("mv_tool_result", "envelope"):
            schema = self.validator.load(name + ".schema.json")
            paths = sorted((ROOT / "contracts/examples/v0.2").glob(name + ".valid*.json"))
            self.assertTrue(paths)
            for path in paths:
                value = json.loads(path.read_text(encoding="utf-8"))
                body = value["body"] if name == "envelope" else value
                if body["schema"] != "mv_tool_result/v0.2":
                    continue
                self.validator.validate(value, schema)
                for location, pin in nested_pins(value):
                    if pin == "mv_tool_result/v0.2":
                        continue
                    with self.subTest(fixture=path.name, location=location):
                        self.assertTrue(pin.endswith("/v0.2"), pin)
                        mutant = copy.deepcopy(value)
                        parent = mutant
                        for key in location[:-1]:
                            parent = parent[key]
                        parent[location[-1]] = pin.removesuffix("/v0.2") + "/v0.1"
                        with self.assertRaises(ValidationError):
                            self.validator.validate(mutant, schema)
                        seen.add(pin)
        self.assertEqual(seen, {"frame_ref/v0.2", "observation/v0.2", "surface/v0.2",
                                "action_verdict/v0.2", "action_receipt/v0.2"})


if __name__ == "__main__":
    unittest.main()
