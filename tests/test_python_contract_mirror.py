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

from metaviewer_agents._contracts_v02 import FILES as _RAW_V02_FILES
from metaviewer_agents.envelope import _V02_FILES


def _conjoin_normalized(base, sibling):
    """Conjoin a resolved local $ref schema with normalized sibling constraints."""
    if not isinstance(base, dict) or not isinstance(sibling, dict):
        return sibling
    merged = copy.deepcopy(base)
    for key, value in sibling.items():
        if key not in merged:
            merged[key] = copy.deepcopy(value)
        elif key in ("maximum", "maxLength", "maxItems", "maxProperties"):
            merged[key] = min(merged[key], value)
        elif key in ("minimum", "minLength", "minItems", "minProperties"):
            merged[key] = max(merged[key], value)
        elif key == "required":
            merged[key] = sorted(
                {json.dumps(item, sort_keys=True): item for item in (*merged[key], *value)}.values(),
                key=lambda item: json.dumps(item, sort_keys=True),
            )
        elif key == "enum":
            allowed = {json.dumps(item, sort_keys=True) for item in value}
            merged[key] = sorted(
                [item for item in merged[key] if json.dumps(item, sort_keys=True) in allowed],
                key=lambda item: json.dumps(item, sort_keys=True),
            )
        elif key == "additionalProperties":
            merged[key] = False if (merged[key] is False or value is False) else value
        elif key == "properties":
            props = copy.deepcopy(merged[key])
            for prop_name, prop_schema in value.items():
                if prop_name in props:
                    props[prop_name] = _conjoin_normalized(props[prop_name], prop_schema)
                else:
                    props[prop_name] = copy.deepcopy(prop_schema)
            merged[key] = props
        elif key == "items" and isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = _conjoin_normalized(merged[key], value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


def normalized(node, root):
    """Inline local definitions and account for the decoder's global bounds."""
    if isinstance(node, list):
        return [normalized(value, root) for value in node]
    if not isinstance(node, dict):
        return node
    ref = node.get("$ref", "")
    local_target = None
    if ref.startswith("#/"):
        target = root
        for part in ref[2:].split("/"):
            target = target[part.replace("~1", "/").replace("~0", "~")]
        local_target = normalized(target, root)
    result = {}
    for key, value in node.items():
        if key in ("$schema", "$id", "title", "description", "$defs"):
            continue
        if key == "$ref" and ref.startswith("#/"):
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
    if local_target is not None:
        return _conjoin_normalized(local_target, result) if result else local_target
    return result


class PythonContractMirrorTests(unittest.TestCase):
    def test_raw_snapshot_contains_no_v01_consts(self):
        def collect_v01_consts(node, path=""):
            found = []
            if isinstance(node, dict):
                for key, value in node.items():
                    if key == "const" and isinstance(value, str) and value.endswith("/v0.1"):
                        found.append(f"{path}:{value}")
                    else:
                        found.extend(collect_v01_consts(value, f"{path}/{key}"))
            elif isinstance(node, list):
                for idx, item in enumerate(node):
                    found.extend(collect_v01_consts(item, f"{path}[{idx}]"))
            return found

        stale = collect_v01_consts(_RAW_V02_FILES)
        self.assertEqual(stale, [], f"raw v0.2 snapshot still contains /v0.1 consts: {stale}")

    def test_every_canonical_schema_matches_python(self):
        paths = sorted((ROOT / "contracts/v0.2").glob("*.schema.json"))
        self.assertTrue(paths, "canonical contracts must exist")
        ipc_only = {"surface_input.schema.json"}
        envelope_paths = [path for path in paths if path.name not in ipc_only]
        self.assertEqual({path.name for path in paths}, set(_RAW_V02_FILES) | ipc_only)
        self.assertEqual({path.name for path in envelope_paths}, set(_RAW_V02_FILES))
        self.assertEqual({path.name for path in envelope_paths}, set(_V02_FILES))
        for path in envelope_paths:
            with self.subTest(schema=path.name):
                canonical = json.loads(path.read_text(encoding="utf-8"))
                raw_mirror = _RAW_V02_FILES[path.name]
                effective_mirror = _V02_FILES[path.name]
                self.assertEqual(normalized(canonical, canonical), normalized(raw_mirror, raw_mirror))
                self.assertEqual(normalized(canonical, canonical), normalized(effective_mirror, effective_mirror))

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

    def test_inlined_frame_blocks_match_canonical_frame_ref(self):
        canonical_frame = _RAW_V02_FILES["frame_ref.schema.json"]
        tool_result = _RAW_V02_FILES["mv_tool_result.schema.json"]
        inlined_frames = []
        for branch in tool_result["oneOf"]:
            props = branch.get("properties", {})
            obs_props = props.get("observation", {}).get("properties", {})
            if "frame_ref" in obs_props:
                inlined_frames.append(obs_props["frame_ref"])
            receipt_props = props.get("receipt", {}).get("properties", {})
            if "after_frame" in receipt_props:
                inlined_frames.append(receipt_props["after_frame"])
        self.assertEqual(len(inlined_frames), 2)
        for frame_block in inlined_frames:
            self.assertEqual(frame_block, canonical_frame)

    def test_local_ref_sibling_constraint_drift_is_detected(self):
        terminal_path = ROOT / "contracts/v0.2/terminal_session.schema.json"
        canonical = json.loads(terminal_path.read_text(encoding="utf-8"))
        mirror = _V02_FILES["terminal_session.schema.json"]
        self.assertEqual(normalized(canonical, canonical), normalized(mirror, mirror))

        # Mutate local $ref in nullable_id (where target #/$defs/id has maxLength 128)
        # by adding a stricter sibling maxLength 127.
        mutant = copy.deepcopy(canonical)
        mutant["$defs"]["nullable_id"]["oneOf"][0]["maxLength"] = 127
        norm_mutant = normalized(mutant, mutant)
        self.assertNotEqual(norm_mutant, normalized(mirror, mirror))

        # Neither target (128) nor sibling (128) may overwrite a stricter 127 bound.
        stricter_sibling = {
            "$defs": {"id": {"type": "string", "minLength": 1, "maxLength": 128}},
            "type": "object",
            "properties": {"sid": {"$ref": "#/$defs/id", "maxLength": 127}},
        }
        stricter_target = {
            "$defs": {"id": {"type": "string", "minLength": 1, "maxLength": 127}},
            "type": "object",
            "properties": {"sid": {"$ref": "#/$defs/id", "maxLength": 128}},
        }
        self.assertEqual(
            normalized(stricter_sibling, stricter_sibling)["properties"]["sid"]["maxLength"],
            127,
        )
        self.assertEqual(
            normalized(stricter_target, stricter_target)["properties"]["sid"]["maxLength"],
            127,
        )


if __name__ == "__main__":
    unittest.main()
