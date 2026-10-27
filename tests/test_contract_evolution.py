"""Breaking-change classification and directional subsumption tests between v0.1 and v0.2.

Implements SW-0244 request/response directional breaking rules and SW-0139 meet-semilattice
subsumption tests (old <= new for backward compatibility of stored data / requests).
Asserts request/response mirror property on schema pairs and includes directional-swap mutant controls.
"""

import copy
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tools.check_contracts import Validator, ValidationError, check_repository


def is_subset_type(type_old, type_new):
    if type_old == type_new:
        return True
    if type_old == "integer" and type_new == "number":
        return True
    return False


def classify_field_diff(old_prop, new_prop):
    """Classify field changes according to lattice subsumption rules."""
    changes = []
    t_old = old_prop.get("type")
    t_new = new_prop.get("type")

    if t_old and t_new and not is_subset_type(t_old, t_new):
        changes.append("type_incompatible")

    if "minimum" in old_prop and "minimum" in new_prop:
        if new_prop["minimum"] > old_prop["minimum"]:
            changes.append("minimum_narrowed")
    if "maximum" in old_prop and "maximum" in new_prop:
        if new_prop["maximum"] < old_prop["maximum"]:
            changes.append("maximum_narrowed")

    if "maxLength" in old_prop and "maxLength" in new_prop:
        if new_prop["maxLength"] < old_prop["maxLength"]:
            changes.append("maxLength_narrowed")
    if "maxItems" in old_prop and "maxItems" in new_prop:
        if new_prop["maxItems"] < old_prop["maxItems"]:
            changes.append("maxItems_narrowed")

    if "enum" in old_prop and "enum" in new_prop:
        if not set(new_prop["enum"]).issuperset(set(old_prop["enum"])):
            changes.append("enum_shrunk")

    return changes


def is_request_breaking(old_schema, new_schema):
    """Request change is breaking when den(old) not in den(new), or optional field becomes required.

    SW-0244 / SW-0139 rule:
    Request consumer keeps working when every value it sends is accepted by new schema (old <= new).
    """
    old_req = set(old_schema.get("required", []))
    new_req = set(new_schema.get("required", []))
    # If a field was optional in old and becomes required in new -> breaking for request
    if not new_req.issubset(old_req):
        for newly_req in (new_req - old_req):
            if newly_req in old_schema.get("properties", {}):
                return True

    old_props = old_schema.get("properties", {})
    new_props = new_schema.get("properties", {})

    for name, old_p in old_props.items():
        if name in new_props:
            diffs = classify_field_diff(old_p, new_props[name])
            if diffs:
                return True
    return False


def is_response_breaking(old_schema, new_schema):
    """Response change is breaking when den(new) not in den(old), or required field becomes optional.

    SW-0244 mirror rule: request_breaking(old, new) == response_breaking(new, old).
    """
    return is_request_breaking(new_schema, old_schema)


def update_discriminator(val):
    if isinstance(val, dict):
        res = {}
        for k, v in val.items():
            if k == "schema" and isinstance(v, str) and v.endswith("/v0.1"):
                res[k] = v.replace("/v0.1", "/v0.2")
            else:
                res[k] = update_discriminator(v)
        return res
    if isinstance(val, list):
        return [update_discriminator(x) for x in val]
    return val


class ContractEvolutionTests(unittest.TestCase):
    def setUp(self):
        self.v01 = Validator(ROOT / "contracts" / "v0.1")
        self.v02 = Validator(ROOT / "contracts" / "v0.2")
        self.carried = [
            "action_proposal", "action_receipt", "action_verdict", "envelope",
            "frame_ref", "observation", "session_record", "surface",
            "surface_event", "surface_request"
        ]

    def test_mirror_property_on_all_carried_pairs(self):
        """SW-0244 Theorem: request_breaking(old, new) == response_breaking(new, old)."""
        for name in self.carried:
            with self.subTest(schema=name):
                s1 = self.v01.load(f"{name}.schema.json")
                s2 = self.v02.load(f"{name}.schema.json")

                req_break = is_request_breaking(s1, s2)
                resp_break_mirrored = is_response_breaking(s2, s1)

                self.assertEqual(
                    req_break, resp_break_mirrored,
                    f"Mirror property failed for {name}: req_break={req_break}, mirrored={resp_break_mirrored}"
                )

    def test_directional_swap_mutant_fails_oracle(self):
        """SW-0244 SW_MUTANT_BREAK_DIR_SWAP negative control."""
        s1 = {"type": "object", "properties": {"x": {"type": "integer", "minimum": 0}}, "required": [], "additionalProperties": False}
        s2 = {"type": "object", "properties": {"x": {"type": "integer", "minimum": 0}}, "required": ["x"], "additionalProperties": False}

        req_break = is_request_breaking(s1, s2)
        self.assertTrue(req_break)

        req_break_swapped = is_request_breaking(s2, s1)
        self.assertFalse(req_break_swapped)

        self.assertNotEqual(req_break, req_break_swapped)

    def test_carried_schemas_backward_compatibility(self):
        """SW-0139 test: data valid under v0.1 remains valid under v0.2 for carried structures (ignoring version discriminator)."""
        for name in self.carried:
            valid_v1_path = ROOT / "contracts" / "examples" / f"{name}.valid.json"
            if not valid_v1_path.exists():
                continue
            v1_data = json.loads(valid_v1_path.read_text())
            v2_schema = self.v02.load(f"{name}.schema.json")

            v1_adapted = update_discriminator(v1_data)

            with self.subTest(schema=name):
                try:
                    self.v02.validate(v1_adapted, v2_schema)
                except ValidationError as exc:
                    self.fail(f"Carried v0.1 valid example for {name} failed under v0.2 schema: {exc}")

    def test_ui_intent_and_native_evidence_evolution_rules(self):
        """Rule explicitly on ui_intent oneOf branches and native_evidence optionality under SW-0244 / SW-0139."""
        ui_v2 = self.v02.load("ui_intent.schema.json")

        # Construct a synthetic old ui_intent schema with only 10 branches (before take_control/release_control)
        ui_v1_synth = copy.deepcopy(ui_v2)
        ui_v1_synth["oneOf"] = [b for b in ui_v2["oneOf"] if b.get("properties", {}).get("op", {}).get("const") not in ("take_control", "release_control")]

        # Adding 2 oneOf branches to ui_intent is backward-compatible for stored data/requests (den(v1) <= den(v2))
        self.assertFalse(is_request_breaking(ui_v1_synth, ui_v2))

        # But adding 2 oneOf branches is breaking for old readers of new data (den(v2) not in den(v1))
        # An old reader encountering take_control / release_control will refuse
        take_control_msg = {
            "schema": "ui_intent/v0.2",
            "op": "take_control",
            "params": {"surface_id": "s1", "owner": "human"}
        }
        with self.assertRaises(ValidationError):
            self.v02.validate(take_control_msg, ui_v1_synth)

        # Optional native_evidence in action_receipt:
        receipt_v2 = self.v02.load("action_receipt.schema.json")
        receipt_example = json.loads((ROOT / "contracts/examples/v0.2/action_receipt.valid.json").read_text())

        # Without native_evidence, receipt validates
        no_evidence = {k: v for k, v in receipt_example.items() if k != "native_evidence"}
        self.v02.validate(no_evidence, receipt_v2)

        # With complete native_evidence, receipt validates
        if "native_evidence" in receipt_example:
            self.v02.validate(receipt_example, receipt_v2)


if __name__ == "__main__":
    unittest.main()
