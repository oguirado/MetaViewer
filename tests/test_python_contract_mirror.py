"""Keep every canonical contract aligned with the effective Python decoder.

The old agent fixture glob, *.valid.json, omitted named variants such as
*.valid.native-click.json. Contract checker tests used the disk schemas only.
Compare schemas directly so optional fields cannot escape through fixture gaps.
"""

import copy
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agents"))

from metaviewer_agents.envelope import _V02_FILES


def normalized(node, root):
    """Inline local definitions and account for the decoder's global bounds."""
    if isinstance(node, list):
        return [normalized(value, root) for value in node]
    if not isinstance(node, dict):
        return node
    ref = node.get("$ref", "")
    if ref.startswith("#/"):
        target = root
        for part in ref[2:].split("/"):
            target = target[part.replace("~1", "/").replace("~0", "~")]
        return normalized(target, root)
    result = {}
    for key, value in node.items():
        if key in ("$schema", "$id", "title", "description", "$defs"):
            continue
        # validate_envelope applies these bounds to every JSON integer.
        if (key == "maximum" and value == (1 << 53) - 1
                or key == "minimum" and value == -((1 << 53) - 1)):
            continue
        if key == "$ref":
            value = value.removeprefix("v0.2/")
        if key == "properties":
            # Property names are data, even when named like schema metadata.
            result[key] = {name: normalized(child, root) for name, child in value.items()}
        else:
            result[key] = normalized(value, root)
    for key in ("oneOf", "required", "enum"):
        if key in result:
            result[key] = sorted(result[key], key=lambda value: json.dumps(value, sort_keys=True))
    return result


class PythonContractMirrorTests(unittest.TestCase):
    def test_every_canonical_schema_matches_python(self):
        paths = sorted((ROOT / "contracts/v0.2").glob("*.schema.json"))
        self.assertTrue(paths, "canonical contracts must exist")
        self.assertEqual({path.name for path in paths}, set(_V02_FILES))
        for path in paths:
            with self.subTest(schema=path.name):
                canonical = json.loads(path.read_text(encoding="utf-8"))
                mirror = _V02_FILES[path.name]
                self.assertEqual(normalized(canonical, canonical), normalized(mirror, mirror))

    def test_nested_optional_property_drift_is_detected_in_every_schema(self):
        for name, mirror in _V02_FILES.items():
            with self.subTest(schema=name):
                mutant = copy.deepcopy(mirror)

                def add_property(node):
                    if isinstance(node, dict):
                        if "properties" in node:
                            node["properties"]["unmirrored_optional"] = {
                                "type": "object",
                                "properties": {"description": {"type": "string"}},
                                "additionalProperties": False,
                            }
                            return True
                        return any(add_property(value) for value in node.values())
                    if isinstance(node, list):
                        return any(add_property(value) for value in node)
                    return False

                self.assertTrue(add_property(mutant), "schema must contain an object")
                self.assertNotEqual(normalized(mutant, mutant), normalized(mirror, mirror))

    def test_metadata_named_properties_are_preserved(self):
        schema = {"type": "object", "properties": {
            "description": {"type": "string"}, "title": {"type": "boolean"}}}
        self.assertEqual(normalized(schema, schema), schema)


if __name__ == "__main__":
    unittest.main()
