"""Unit tests for agent-side observation/v0.1 construction.

Covers trusted frame binding, closed vision and ground_truth shapes,
in-frame geometry, confidence bounds, builder isolation and the
geometry-free battery digest. Every behaviour pairs a positive control
with a negative control that must fail for the stated reason; no test
is skipped under any condition.
"""

import copy
import hashlib
import math
import sys
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parent.parent))

from metaviewer_agents.observe import (
    ObservationError,
    build_observation,
    compute_battery_state_sha256,
    validate_observation,
)

_SHA = "ab" * 32
_STATE_SHA = "cd" * 32


def _frame(**overrides):
    frame = {
        "schema": "frame_ref/v0.1",
        "surface_id": "surface-demo",
        "generation": 1,
        "tick": 7,
        "ts_ns": 1000000,
        "width": 800,
        "height": 600,
        "format": "rgb24",
        "ramws_path": "/dev/shm/ramws/demo.rgb",
        "sha256": _SHA,
        "capture_us": 120,
    }
    frame.update(overrides)
    return frame


def _element(**overrides):
    element = {
        "bbox": {"x": 10, "y": 20, "w": 80, "h": 30},
        "role": "button",
        "name": "Ready",
        "confidence": 0.95,
    }
    element.update(overrides)
    return element


def _vision(**overrides):
    vision = {
        "summary": "Ready button visible",
        "changed_regions": [{"x": 0, "y": 0, "w": 800, "h": 600}],
        "elements": [_element()],
    }
    vision.update(overrides)
    return vision


def _truth(**overrides):
    truth = {
        "source": "holdings_lane",
        "state_sha256": _STATE_SHA,
        "tick": 7,
    }
    truth.update(overrides)
    return truth


def _observation(**overrides):
    observation = {
        "schema": "observation/v0.1",
        "frame_ref": _frame(),
        "vision": _vision(),
        "ground_truth": _truth(),
    }
    observation.update(overrides)
    return observation


class ObservationValidationTests(unittest.TestCase):
    def assertCode(self, code, call, *args, **kwargs):
        with self.assertRaises(ObservationError) as caught:
            call(*args, **kwargs)
        self.assertEqual(caught.exception.code, code)

    def test_full_observation_validates(self):
        validate_observation(_observation(), surface_id="surface-demo",
                             generation=1)

    def test_minimal_frame_only_observation_validates(self):
        validate_observation(
            {"schema": "observation/v0.1", "frame_ref": _frame()},
            surface_id="surface-demo", generation=1)

    def test_vision_without_ground_truth_validates(self):
        observation = _observation()
        del observation["ground_truth"]
        validate_observation(observation, surface_id="surface-demo",
                             generation=1)

    def test_frozen_example_values_validate(self):
        observation = _observation()
        observation["frame_ref"]["sha256"] = "00" * 32
        observation["ground_truth"]["state_sha256"] = "11" * 32
        validate_observation(observation, surface_id="surface-demo",
                             generation=1)

    def test_unknown_observation_version_refused(self):
        self.assertCode("unknown_version", validate_observation,
                        _observation(schema="observation/v9.9"),
                        surface_id="surface-demo", generation=1)

    def test_unknown_frame_version_refused(self):
        observation = _observation()
        observation["frame_ref"]["schema"] = "frame_ref/v9.9"
        self.assertCode("unknown_version", validate_observation,
                        observation, surface_id="surface-demo",
                        generation=1)

    def test_extra_top_level_key_refused(self):
        observation = _observation()
        observation["producer"] = "native"
        self.assertCode("bad_shape", validate_observation, observation,
                        surface_id="surface-demo", generation=1)

    def test_missing_frame_ref_refused(self):
        observation = _observation()
        del observation["frame_ref"]
        self.assertCode("bad_shape", validate_observation, observation,
                        surface_id="surface-demo", generation=1)

    def test_non_object_observation_refused(self):
        self.assertCode("bad_shape", validate_observation, [],
                        surface_id="surface-demo", generation=1)

    def test_missing_frame_tick_refused(self):
        observation = _observation()
        del observation["frame_ref"]["tick"]
        self.assertCode("bad_shape", validate_observation, observation,
                        surface_id="surface-demo", generation=1)

    def test_missing_frame_capture_refused(self):
        observation = _observation()
        del observation["frame_ref"]["capture_us"]
        self.assertCode("bad_shape", validate_observation, observation,
                        surface_id="surface-demo", generation=1)

    def test_invented_frame_seq_refused(self):
        observation = _observation()
        observation["frame_ref"]["frame_seq"] = 3
        self.assertCode("bad_shape", validate_observation, observation,
                        surface_id="surface-demo", generation=1)

    def test_surface_mismatch_refused(self):
        self.assertCode("identity_mismatch", validate_observation,
                        _observation(), surface_id="surface-other",
                        generation=1)

    def test_generation_mismatch_refused(self):
        self.assertCode("identity_mismatch", validate_observation,
                        _observation(), surface_id="surface-demo",
                        generation=2)

    def test_malformed_trusted_arguments_refused(self):
        for surface_id, generation in (
                ("", 1), (None, 1), ("x" * 129, 1), ("surface-demo", 0),
                ("surface-demo", True), ("surface-demo", "1"),
                ("surface-demo", 1.0)):
            with self.subTest(surface_id=surface_id,
                              generation=generation):
                self.assertCode("identity_mismatch", validate_observation,
                                _observation(), surface_id=surface_id,
                                generation=generation)

    def test_ramws_path_outside_shared_memory_refused(self):
        for path in ("/tmp/demo.rgb", "/dev/shm/", "/dev/shm",
                     "/dev/shm/../etc/x", "/dev/shm/a//b", "/dev/shm/.x",
                     "/dev/shm/a\nb", "/dev/shm/" + ("a" * 250),
                     "/dev/shm/a" + chr(0), 42, None):
            with self.subTest(path=path):
                observation = _observation()
                observation["frame_ref"]["ramws_path"] = path
                self.assertCode("bad_shape", validate_observation,
                                observation, surface_id="surface-demo",
                                generation=1)
        for good_path in (
            "/dev/shm/ramws/demo.rgb",
            "/dev/shm/mv-adapter-1/frames-123456/0123456789abcdef0123456789abcdef.rgb",
        ):
            observation = _observation(frame_ref=_frame(ramws_path=good_path))
            validate_observation(observation, surface_id="surface-demo", generation=1)

    def test_frame_dimensions_above_16384_refused(self):
        for key, value in (("width", 16385), ("height", 16385)):
            with self.subTest(key=key, value=value):
                observation = _observation()
                observation["frame_ref"][key] = value
                self.assertCode("bad_shape", validate_observation,
                                observation, surface_id="surface-demo",
                                generation=1)
        boundary = _observation(
            frame_ref=_frame(width=16384, height=16384),
            vision=_vision(
                changed_regions=[{"x": 0, "y": 0, "w": 16384, "h": 16384}],
                elements=[_element(bbox={"x": 0, "y": 0, "w": 16384, "h": 16384})],
            ),
        )
        validate_observation(boundary, surface_id="surface-demo", generation=1)

    def test_non_rgb24_format_refused(self):
        observation = _observation()
        observation["frame_ref"]["format"] = "rgba32"
        self.assertCode("bad_shape", validate_observation, observation,
                        surface_id="surface-demo", generation=1)

    def test_malformed_frame_hash_refused(self):
        for digest in ("AB" * 32, "ab" * 31, "ab" * 32 + "ab", "zz" * 32,
                       "", None, 0):
            with self.subTest(digest=digest):
                observation = _observation()
                observation["frame_ref"]["sha256"] = digest
                self.assertCode("bad_shape", validate_observation,
                                observation, surface_id="surface-demo",
                                generation=1)

    def test_frame_integer_slots_reject_bool_float_and_range(self):
        cases = [("generation", 0), ("generation", True),
                 ("generation", 1.0), ("tick", -1), ("tick", False),
                 ("ts_ns", -1), ("width", 0), ("height", 0),
                 ("width", 800.0), ("capture_us", -1)]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                observation = _observation()
                observation["frame_ref"][key] = value
                self.assertCode("bad_shape", validate_observation,
                                observation, surface_id="surface-demo",
                                generation=1)

    def test_vision_requires_closed_shape(self):
        for vision in ({"summary": "s", "changed_regions": []},
                       _vision(extra=True), "vision", None, [],
                       _vision(summary=7)):
            with self.subTest(vision=vision):
                observation = _observation()
                observation["vision"] = vision
                self.assertCode("bad_shape", validate_observation,
                                observation, surface_id="surface-demo",
                                generation=1)

    def test_null_and_nullable_bboxes_refused(self):
        for bbox in (None, "box", {"x": 1, "y": 2},
                     {"x": 1, "y": 2, "w": 3, "h": 4, "d": 1}):
            with self.subTest(bbox=bbox):
                observation = _observation()
                observation["vision"]["elements"] = [
                    _element(bbox=bbox)]
                self.assertCode("bad_shape", validate_observation,
                                observation, surface_id="surface-demo",
                                generation=1)

    def test_bbox_integer_slots_reject_bool_and_float(self):
        for key, value in (("x", True), ("y", 1.5), ("w", 80.0),
                           ("h", False), ("w", 0), ("h", 0),
                           ("x", -1), ("y", -2)):
            with self.subTest(key=key, value=value):
                bbox = {"x": 10, "y": 20, "w": 80, "h": 30}
                bbox[key] = value
                observation = _observation()
                observation["vision"]["elements"] = [
                    _element(bbox=bbox)]
                self.assertCode("bad_shape", validate_observation,
                                observation, surface_id="surface-demo",
                                generation=1)

    def test_out_of_frame_bbox_refused(self):
        for bbox in ({"x": 750, "y": 20, "w": 80, "h": 30},
                     {"x": 10, "y": 590, "w": 80, "h": 30},
                     {"x": 0, "y": 0, "w": 801, "h": 600}):
            with self.subTest(bbox=bbox):
                observation = _observation()
                observation["vision"]["elements"] = [
                    _element(bbox=bbox)]
                self.assertCode("bad_shape", validate_observation,
                                observation, surface_id="surface-demo",
                                generation=1)

    def test_frame_edge_bbox_accepted(self):
        observation = _observation()
        observation["vision"]["elements"] = [
            _element(bbox={"x": 720, "y": 570, "w": 80, "h": 30})]
        validate_observation(observation, surface_id="surface-demo",
                             generation=1)

    def test_out_of_frame_changed_region_refused(self):
        observation = _observation()
        observation["vision"]["changed_regions"] = [
            {"x": 0, "y": 0, "w": 800, "h": 601}]
        self.assertCode("bad_shape", validate_observation, observation,
                        surface_id="surface-demo", generation=1)

    def test_confidence_rejects_bool_nonfinite_and_range(self):
        for confidence in (True, False, math.nan, math.inf, -math.inf,
                           -0.1, 1.5, "0.9", None):
            with self.subTest(confidence=confidence):
                observation = _observation()
                observation["vision"]["elements"] = [
                    _element(confidence=confidence)]
                self.assertCode("bad_shape", validate_observation,
                                observation, surface_id="surface-demo",
                                generation=1)

    def test_confidence_accepts_bounds_and_integers(self):
        for confidence in (0.0, 1.0, 0, 1, 0.5):
            with self.subTest(confidence=confidence):
                observation = _observation()
                observation["vision"]["elements"] = [
                    _element(confidence=confidence)]
                validate_observation(observation,
                                     surface_id="surface-demo",
                                     generation=1)

    def test_element_role_name_shape(self):
        for role in ("", "r" * 129, None, 7):
            with self.subTest(role=role):
                observation = _observation()
                observation["vision"]["elements"] = [
                    _element(role=role)]
                self.assertCode("bad_shape", validate_observation,
                                observation, surface_id="surface-demo",
                                generation=1)
        observation = _observation()
        observation["vision"]["elements"] = [_element(name=7)]
        self.assertCode("bad_shape", validate_observation, observation,
                        surface_id="surface-demo", generation=1)
        observation = _observation()
        observation["vision"]["elements"] = [_element(name="")]
        validate_observation(observation, surface_id="surface-demo",
                             generation=1)

    def test_ground_truth_closed_shape(self):
        for truth in (_truth(source="electron"), _truth(tick=-1),
                      _truth(tick=True), _truth(state_sha256="AB" * 32),
                      _truth(state_sha256="cd" * 31),
                      _truth(origin="native"), "truth", None):
            with self.subTest(truth=truth):
                observation = _observation()
                observation["ground_truth"] = truth
                self.assertCode("bad_shape", validate_observation,
                                observation, surface_id="surface-demo",
                                generation=1)

    def test_shape_valid_ground_truth_passes_shape_gate(self):
        # Shape validation cannot authenticate provenance: a forged but
        # well-formed witness must reach the downstream provenance gate,
        # which lives outside this module.
        observation = _observation()
        observation["ground_truth"] = _truth(tick=999999)
        validate_observation(observation, surface_id="surface-demo",
                             generation=1)

    def test_observation_error_is_value_error(self):
        self.assertTrue(issubclass(ObservationError, ValueError))


class BuildObservationTests(unittest.TestCase):
    def test_builds_minimal_observation(self):
        self.assertEqual(
            build_observation(_frame(), surface_id="surface-demo",
                              generation=1),
            {"schema": "observation/v0.1", "frame_ref": _frame()})

    def test_builds_full_observation(self):
        self.assertEqual(
            build_observation(_frame(), surface_id="surface-demo",
                              generation=1, vision=_vision(),
                              ground_truth=_truth()),
            _observation())

    def test_build_isolated_from_later_caller_mutation(self):
        frame = _frame()
        vision = _vision()
        built = build_observation(frame, surface_id="surface-demo",
                                  generation=1, vision=vision)
        frame["tick"] = 999
        vision["summary"] = "mutated"
        vision["elements"][0]["role"] = "mutated"
        self.assertEqual(built["frame_ref"]["tick"], 7)
        self.assertEqual(built["vision"]["summary"],
                         "Ready button visible")
        self.assertEqual(built["vision"]["elements"][0]["role"],
                         "button")

    def test_build_does_not_mutate_inputs(self):
        frame = _frame()
        vision = _vision()
        truth = _truth()
        snapshot = (copy.deepcopy(frame), copy.deepcopy(vision),
                    copy.deepcopy(truth))
        build_observation(frame, surface_id="surface-demo", generation=1,
                          vision=vision, ground_truth=truth)
        self.assertEqual((frame, vision, truth), snapshot)

    def test_build_refuses_identity_mismatch(self):
        with self.assertRaises(ObservationError) as caught:
            build_observation(_frame(), surface_id="surface-other",
                              generation=1)
        self.assertEqual(caught.exception.code, "identity_mismatch")

    def test_build_refuses_non_object_parts(self):
        for frame, vision, truth in (([], None, None),
                                     (_frame(), [], None),
                                     (_frame(), None, [])):
            with self.subTest(frame=frame, vision=vision, truth=truth):
                with self.assertRaises(ObservationError) as caught:
                    build_observation(frame, surface_id="surface-demo",
                                      generation=1, vision=vision,
                                      ground_truth=truth)
                self.assertEqual(caught.exception.code, "bad_shape")


def _state():
    return {
        "schema": "wender.state/v1",
        "tick": 7,
        "viewport": {"w": 800, "h": 600},
        "nodes": [
            {"id": "a", "role": "button", "name": "Ready",
             "depth": 1, "parent": None, "ordinal": 0,
             "states": {"focused": True}, "actionable": True,
             "box": [10, 20, 80, 30]},
            {"id": "b", "role": "label", "name": "café",
             "depth": 1, "parent": None, "ordinal": 1,
             "states": {}, "actionable": False, "box": None},
        ],
        "actionable": ["a"],
    }


class BatteryDigestTests(unittest.TestCase):
    def test_deterministic_across_runs_and_key_order(self):
        first = compute_battery_state_sha256(_state())
        second = compute_battery_state_sha256(_state())
        shuffled = {"actionable": ["a"], "tick": 7, "nodes": [
            {"box": None, "actionable": False, "states": {},
             "ordinal": 1, "parent": None, "depth": 1, "name": "café",
             "role": "label", "id": "b"},
            {"box": [10, 20, 80, 30], "actionable": True,
             "states": {"focused": True}, "ordinal": 0,
             "parent": None, "depth": 1, "name": "Ready",
             "role": "button", "id": "a"}][::-1],
            "viewport": {"h": 600, "w": 800},
            "schema": "wender.state/v1"}
        self.assertEqual(first, second)
        self.assertEqual(first, compute_battery_state_sha256(shuffled))
        self.assertEqual(len(first), 64)

    def test_geometry_change_preserves_digest(self):
        before = compute_battery_state_sha256(_state())
        moved = _state()
        moved["nodes"][0]["box"] = [400, 300, 10, 10]
        moved["nodes"][1]["box"] = [0, 0, 800, 600]
        self.assertEqual(before, compute_battery_state_sha256(moved))

    def test_missing_box_matches_nulled_box(self):
        nulled = {"nodes": [{"id": "a", "box": None}]}
        missing = {"nodes": [{"id": "a"}]}
        self.assertEqual(compute_battery_state_sha256(nulled),
                         compute_battery_state_sha256(missing))

    def test_role_name_value_change_changes_digest(self):
        before = compute_battery_state_sha256(_state())
        for mutate in (lambda s: s["nodes"][0].__setitem__("role", "link"),
                       lambda s: s["nodes"][0].__setitem__("name", "Go"),
                       lambda s: s["nodes"][0]["states"].__setitem__(
                           "focused", False),
                       lambda s: s["nodes"].append({"id": "c"}),
                       lambda s: s.__setitem__("tick", 8)):
            state = _state()
            mutate(state)
            with self.subTest(mutate=mutate):
                self.assertNotEqual(
                    before, compute_battery_state_sha256(state))

    def test_booleans_preserved_distinct_from_integers(self):
        with_bool = {"nodes": [{"id": "a", "on": True, "box": None}]}
        with_int = {"nodes": [{"id": "a", "on": 1, "box": None}]}
        self.assertNotEqual(compute_battery_state_sha256(with_bool),
                            compute_battery_state_sha256(with_int))

    def test_canonical_form_matches_independent_bytes(self):
        state = {"nodes": [{"box": [1, 2, 3, 4], "id": "a"}]}
        expected = hashlib.sha256(
            b'{"nodes":[{"box":null,"id":"a"}]}').hexdigest()
        self.assertEqual(compute_battery_state_sha256(state), expected)

    def test_unicode_kept_as_utf8(self):
        state = {"tag": "café", "nodes": []}
        expected = hashlib.sha256(
            '{"nodes":[],"tag":"café"}'.encode("utf-8")).hexdigest()
        self.assertEqual(compute_battery_state_sha256(state), expected)

    def test_does_not_mutate_input(self):
        state = _state()
        snapshot = copy.deepcopy(state)
        compute_battery_state_sha256(state)
        self.assertEqual(state, snapshot)

    def test_floats_refused_even_when_integral(self):
        for bad in (1.0, 0.0, math.nan, math.inf):
            with self.subTest(bad=bad):
                state = {"nodes": [{"id": "a", "score": bad}]}
                with self.assertRaises(ObservationError) as caught:
                    compute_battery_state_sha256(state)
                self.assertEqual(caught.exception.code, "bad_shape")

    def test_box_content_never_inspected(self):
        # Stripped before canonicalization, so even non-JSON box
        # content digests exactly like a nulled box.
        weird = {"nodes": [{"id": "a", "box": (1, 2, 3.5)}]}
        plain = {"nodes": [{"id": "a", "box": None}]}
        self.assertEqual(compute_battery_state_sha256(weird),
                         compute_battery_state_sha256(plain))

    def test_malformed_states_refused(self):
        for bad in ([], "state", None, {}, {"nodes": {}},
                    {"nodes": ["a"]}, {"nodes": [{"id": "a"}],
                                       7: "non-string-key"},
                    {"nodes": [{"id": ("a",)}]},
                    {"nodes": [{"id": "a", "extra": (1, 2)}]}):
            with self.subTest(bad=bad):
                with self.assertRaises(ObservationError):
                    compute_battery_state_sha256(bad)

    def test_arbitrary_precision_integers_accepted(self):
        # Python-domain behaviour; equality with the fixed-width native
        # encoder additionally needs its golden fixture and integer
        # rails, which are absent here.
        state = {"nodes": [{"id": "a", "big": 2 ** 70}]}
        digest = compute_battery_state_sha256(state)
        self.assertEqual(len(digest), 64)


def _always_accept(*args, **kwargs):
    return None


class AntiVacuityTests(unittest.TestCase):
    def _negative_fixtures(self):
        mismatched = (_observation(), {"surface_id": "surface-other",
                                       "generation": 1})
        bad_confidence = _observation()
        bad_confidence["vision"]["elements"] = [
            _element(confidence=True)]
        return [
            (_observation(spy=True),
             {"surface_id": "surface-demo", "generation": 1}),
            (mismatched[0], mismatched[1]),
            (bad_confidence,
             {"surface_id": "surface-demo", "generation": 1}),
        ]

    def test_negatives_pass_a_noop_but_fail_the_validator(self):
        for observation, trusted in self._negative_fixtures():
            with self.subTest(trusted=trusted):
                self.assertIsNone(_always_accept(observation, **trusted))
                with self.assertRaises(ObservationError):
                    validate_observation(observation, **trusted)


if __name__ == "__main__":
    unittest.main()
