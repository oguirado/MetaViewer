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
    """Classify request-narrowing field changes according to lattice subsumption rules."""
    changes = []
    t_old = old_prop.get("type")
    t_new = new_prop.get("type")

    if t_old and t_new and not is_subset_type(t_old, t_new):
        changes.append("type_incompatible")
    elif not t_old and t_new:
        changes.append("type_narrowed")

    if "minimum" in new_prop:
        if "minimum" not in old_prop or new_prop["minimum"] > old_prop["minimum"]:
            changes.append("minimum_narrowed")
    if "maximum" in new_prop:
        if "maximum" not in old_prop or new_prop["maximum"] < old_prop["maximum"]:
            changes.append("maximum_narrowed")

    for lower_key in ("minLength", "minItems"):
        if lower_key in new_prop:
            if lower_key not in old_prop:
                if new_prop[lower_key] > 0:
                    changes.append(f"{lower_key}_narrowed")
            elif new_prop[lower_key] > old_prop[lower_key]:
                changes.append(f"{lower_key}_narrowed")

    for upper_key in ("maxLength", "maxItems", "maxProperties"):
        if upper_key in new_prop:
            if upper_key not in old_prop or new_prop[upper_key] < old_prop[upper_key]:
                changes.append(f"{upper_key}_narrowed")

    if "pattern" in new_prop:
        if "pattern" not in old_prop or new_prop["pattern"] != old_prop["pattern"]:
            changes.append("pattern_narrowed")

    if "const" in new_prop:
        if "const" not in old_prop or new_prop["const"] != old_prop["const"]:
            changes.append("const_narrowed")

    if "enum" in new_prop:
        if "enum" not in old_prop or not set(new_prop["enum"]).issuperset(set(old_prop["enum"])):
            changes.append("enum_shrunk")

    old_req = set(old_prop.get("required", []))
    new_req = set(new_prop.get("required", []))
    if not new_req.issubset(old_req):
        changes.append("required_narrowed")

    old_subprops = old_prop.get("properties", {})
    new_subprops = new_prop.get("properties", {})
    if new_prop.get("additionalProperties") is False:
        if old_prop.get("additionalProperties", True) is not False:
            changes.append("closed_narrowed")
        if not set(old_subprops).issubset(set(new_subprops)):
            changes.append("properties_removed")
    for sub_name, sub_old in old_subprops.items():
        if sub_name in new_subprops and classify_field_diff(sub_old, new_subprops[sub_name]):
            changes.append(f"property_{sub_name}_narrowed")

    if "items" in new_prop:
        if "items" not in old_prop or classify_field_diff(old_prop["items"], new_prop["items"]):
            changes.append("items_narrowed")

    return changes


def classify_response_field_diff(old_prop, new_prop):
    """Classify response-widening field changes independently of classify_field_diff."""
    changes = []
    t_old = old_prop.get("type")
    t_new = new_prop.get("type")

    if t_old and t_new and not is_subset_type(t_new, t_old):
        changes.append("type_widened")
    elif t_old and not t_new:
        changes.append("type_widened")

    if "minimum" in old_prop:
        if "minimum" not in new_prop or new_prop["minimum"] < old_prop["minimum"]:
            changes.append("minimum_widened")
    if "maximum" in old_prop:
        if "maximum" not in new_prop or new_prop["maximum"] > old_prop["maximum"]:
            changes.append("maximum_widened")

    for lower_key in ("minLength", "minItems"):
        if lower_key in old_prop:
            if lower_key not in new_prop:
                if old_prop[lower_key] > 0:
                    changes.append(f"{lower_key}_widened")
            elif new_prop[lower_key] < old_prop[lower_key]:
                changes.append(f"{lower_key}_widened")

    for upper_key in ("maxLength", "maxItems", "maxProperties"):
        if upper_key in old_prop:
            if upper_key not in new_prop or new_prop[upper_key] > old_prop[upper_key]:
                changes.append(f"{upper_key}_widened")

    if "pattern" in old_prop:
        if "pattern" not in new_prop or new_prop["pattern"] != old_prop["pattern"]:
            changes.append("pattern_widened")

    if "const" in old_prop:
        if "const" not in new_prop or new_prop["const"] != old_prop["const"]:
            changes.append("const_widened")

    if "enum" in old_prop:
        if "enum" not in new_prop or not set(old_prop["enum"]).issuperset(set(new_prop["enum"])):
            changes.append("enum_expanded")

    old_req = set(old_prop.get("required", []))
    new_req = set(new_prop.get("required", []))
    if not old_req.issubset(new_req):
        changes.append("required_dropped")

    old_subprops = old_prop.get("properties", {})
    new_subprops = new_prop.get("properties", {})
    if old_prop.get("additionalProperties") is False:
        if new_prop.get("additionalProperties", True) is not False:
            changes.append("closed_widened")
        if not set(new_subprops).issubset(set(old_subprops)):
            changes.append("properties_added")
    for sub_name, sub_new in new_subprops.items():
        if sub_name in old_subprops and classify_response_field_diff(old_subprops[sub_name], sub_new):
            changes.append(f"property_{sub_name}_widened")

    if "items" in old_prop:
        if "items" not in new_prop or classify_response_field_diff(old_prop["items"], new_prop["items"]):
            changes.append("items_widened")

    return changes


def is_request_breaking(old_schema, new_schema):
    """Request change is breaking when den(old) not in den(new), or a new required field is added.

    SW-0244 / SW-0139 rule:
    Request consumer keeps working when every value it sends is accepted by new schema (old <= new).
    """
    old_req = set(old_schema.get("required", []))
    new_req = set(new_schema.get("required", []))
    if not new_req.issubset(old_req):
        return True

    old_props = old_schema.get("properties", {})
    new_props = new_schema.get("properties", {})

    if new_schema.get("additionalProperties") is False:
        if old_schema.get("additionalProperties", True) is not False:
            return True
        if not set(old_props).issubset(set(new_props)):
            return True

    for name, old_p in old_props.items():
        if name in new_props:
            diffs = classify_field_diff(old_p, new_props[name])
            if diffs:
                return True
    return False


def is_response_breaking(old_schema, new_schema):
    """Response change is breaking when den(new) not in den(old), or a required field is dropped.

    Evaluated directly from response-widening rules (independent of is_request_breaking)
    so the SW-0244 mirror theorem can be tested without tautology.
    """
    old_req = set(old_schema.get("required", []))
    new_req = set(new_schema.get("required", []))
    if not old_req.issubset(new_req):
        return True

    old_props = old_schema.get("properties", {})
    new_props = new_schema.get("properties", {})

    if old_schema.get("additionalProperties") is False:
        if new_schema.get("additionalProperties", True) is not False:
            return True
        if not set(new_props).issubset(set(old_props)):
            return True

    for name, new_p in new_props.items():
        if name in old_props:
            diffs = classify_response_field_diff(old_props[name], new_p)
            if diffs:
                return True
    return False


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

                req_break_reverse = is_request_breaking(s2, s1)
                resp_break_forward = is_response_breaking(s1, s2)
                self.assertEqual(
                    req_break_reverse, resp_break_forward,
                    f"Reverse mirror property failed for {name}: req_reverse={req_break_reverse}, resp_forward={resp_break_forward}"
                )

    def test_added_constraints_classified_as_request_breaking_with_negative_controls(self):
        """T6R2-012 regression: added bound/pattern/enum/required must be classified as narrowing."""
        safe_max = (1 << 53) - 1
        old_int = {
            "type": "object",
            "properties": {"ts_ns": {"type": "integer", "minimum": 0}},
            "required": ["ts_ns"],
            "additionalProperties": False,
        }
        new_int = {
            "type": "object",
            "properties": {"ts_ns": {"type": "integer", "minimum": 0, "maximum": safe_max}},
            "required": ["ts_ns"],
            "additionalProperties": False,
        }
        self.assertIn(
            "maximum_narrowed",
            classify_field_diff(old_int["properties"]["ts_ns"], new_int["properties"]["ts_ns"]),
        )
        self.assertTrue(is_request_breaking(old_int, new_int))
        self.assertTrue(is_response_breaking(new_int, old_int))
        # Negative control: narrowing a response or widening a request is not breaking.
        self.assertFalse(is_response_breaking(old_int, new_int))
        self.assertFalse(is_request_breaking(new_int, old_int))
        self.assertFalse(is_request_breaking(new_int, copy.deepcopy(new_int)))

        cases = [
            ("minimum", {"type": "integer"}, {"type": "integer", "minimum": 0}, "minimum_narrowed"),
            ("maxLength", {"type": "string"}, {"type": "string", "maxLength": 128}, "maxLength_narrowed"),
            ("minLength", {"type": "string"}, {"type": "string", "minLength": 1}, "minLength_narrowed"),
            ("maxItems", {"type": "array"}, {"type": "array", "maxItems": 16}, "maxItems_narrowed"),
            ("pattern", {"type": "string"}, {"type": "string", "pattern": "^[a-z]+$"}, "pattern_narrowed"),
            ("enum", {"type": "string"}, {"type": "string", "enum": ["a", "b"]}, "enum_shrunk"),
            (
                "required",
                {"type": "object", "properties": {"k": {"type": "string"}}, "required": [], "additionalProperties": False},
                {"type": "object", "properties": {"k": {"type": "string"}}, "required": ["k"], "additionalProperties": False},
                "required_narrowed",
            ),
        ]
        for label, old_prop, new_prop, expected_tag in cases:
            with self.subTest(constraint=label):
                diffs = classify_field_diff(old_prop, new_prop)
                self.assertIn(expected_tag, diffs)
                s_old = {"type": "object", "properties": {"f": old_prop}, "required": ["f"], "additionalProperties": False}
                s_new = {"type": "object", "properties": {"f": new_prop}, "required": ["f"], "additionalProperties": False}
                self.assertTrue(is_request_breaking(s_old, s_new))
                self.assertTrue(is_response_breaking(s_new, s_old))
                self.assertFalse(is_response_breaking(s_old, s_new))
                self.assertFalse(is_request_breaking(s_new, s_old))

    def test_mutant_harness_exits_nonzero_on_surviving_mutant(self):
        """T6-OPEN-02 regression: surviving mutant (dead oracle) exits with code 1."""
        import io
        from contextlib import redirect_stdout
        from agents.tests import run_mutant_harness as rmh

        orig_mutants = rmh.MUTANTS
        orig_run = rmh._run_suite
        try:
            rmh.MUTANTS = [("M-dead: surviving mutant", lambda: (lambda: None))]
            rmh._run_suite = lambda: 0
            with redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as cm:
                rmh.main()
            self.assertEqual(cm.exception.code, 1)

            # Negative control: when the mutant is killed (fails > 0 after baseline 0), main returns normally.
            calls = iter([0, 3])
            rmh.MUTANTS = [("M-killed: detected mutant", lambda: (lambda: None))]
            rmh._run_suite = lambda: next(calls)
            with redirect_stdout(io.StringIO()):
                self.assertIsNone(rmh.main())
        finally:
            rmh.MUTANTS = orig_mutants
            rmh._run_suite = orig_run

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
        """Rule on ui_intent oneOf branches and native_evidence optionality under SW-0244 / SW-0139."""
        ui_v2 = self.v02.load("ui_intent.schema.json")

        ui_v1_synth = copy.deepcopy(ui_v2)
        ui_v1_synth["oneOf"] = [
            b
            for b in ui_v2["oneOf"]
            if b.get("properties", {}).get("op", {}).get("const") not in ("take_control", "release_control")
        ]

        # Adding 2 oneOf branches to ui_intent is backward-compatible for stored data/requests (den(v1) <= den(v2))
        self.assertFalse(is_request_breaking(ui_v1_synth, ui_v2))

        # Positive control: take_control validates under ui_v2, but fails under the 10-branch ui_v1_synth
        take_control_msg = {
            "schema": "ui_intent/v0.2",
            "request_id": "req1",
            "op": "take_control",
            "params": {"surface_id": "s1"},
        }
        self.v02.validate(take_control_msg, ui_v2)
        with self.assertRaises(ValidationError):
            self.v02.validate(take_control_msg, ui_v1_synth)

        # Optional native_evidence in action_receipt:
        receipt_v2 = self.v02.load("action_receipt.schema.json")
        receipt_example = json.loads((ROOT / "contracts/examples/v0.2/action_receipt.valid.json").read_text())
        receipt_native = json.loads(
            (ROOT / "contracts/examples/v0.2/action_receipt.valid.native-click.json").read_text()
        )

        no_evidence = {k: v for k, v in receipt_example.items() if k != "native_evidence"}
        self.v02.validate(no_evidence, receipt_v2)
        self.v02.validate(receipt_native, receipt_v2)

        bad_evidence = dict(receipt_native["native_evidence"])
        del bad_evidence["input_ts_ns"]
        with self.assertRaises(ValidationError):
            self.v02.validate({**receipt_native, "native_evidence": bad_evidence}, receipt_v2)


if __name__ == "__main__":
    unittest.main()
