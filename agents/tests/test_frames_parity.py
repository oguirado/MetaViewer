"""Cross-language parity tests for frame_ref, surface_event, and observation v0.2."""

from __future__ import annotations

import copy
import json
from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "agents") not in sys.path:
    sys.path.insert(0, str(ROOT / "agents"))

from metaviewer_agents import envelope as envelope_mod
from metaviewer_agents import observe as observe_mod

FIXTURE_PATH = ROOT / "tests" / "fixtures" / "frames_parity.json"

FINDINGS = {
    ("py_envelope", "observation_invalid_escape_changed_region"): "FINDING D8",
    ("py_envelope", "observation_invalid_escape_element_bbox"): "FINDING D8",
}


def _load_fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _trusted_binding_for_payload(family: str, payload: dict) -> tuple[str, int]:
    frame = payload.get("frame_ref") if family == "observation" else payload
    if isinstance(frame, dict):
        sid = frame.get("surface_id")
        gen = frame.get("generation")
        trusted_sid = sid if isinstance(sid, str) and 1 <= len(sid) <= 128 else "surface-demo"
        trusted_gen = gen if type(gen) is int and gen >= 1 else 1
        return trusted_sid, trusted_gen
    return "surface-demo", 1


def _decode_with_envelope(template: dict, payload: dict) -> bool:
    env = copy.deepcopy(template)
    env["body"] = copy.deepcopy(payload)
    try:
        envelope_mod.validate_envelope(env)
        raw = (json.dumps(env, separators=(",", ":")) + "\n").encode("utf-8")
        envelope_mod.loads_envelope(raw, max_bytes=1048576)
        return True
    except envelope_mod.EnvelopeError:
        return False


def _decode_with_observe(family: str, payload: dict) -> bool:
    sid, gen = _trusted_binding_for_payload(family, payload)
    if family == "observation":
        obs = copy.deepcopy(payload)
    elif family == "frame_ref":
        obs = {"schema": "observation/v0.2", "frame_ref": copy.deepcopy(payload)}
    else:
        raise ValueError(f"unsupported family for observe decoder: {family}")
    try:
        observe_mod.validate_observation(
            obs,
            surface_id=sid,
            generation=gen,
            contract_version="v0.2",
        )
        return True
    except observe_mod.ObservationError:
        return False


def _run_python_parity_suite(fixture: dict) -> tuple[dict[tuple[str, str], str], list[str]]:
    skipped: dict[tuple[str, str], str] = {}
    failures: list[str] = []
    template = fixture["envelope_template"]

    for vec in fixture["vectors"]:
        vec_id = vec["id"]
        family = vec["family"]
        expected_accept = vec["contract_verdict"] == "accept"
        payload = vec["payload"]

        env_accept = _decode_with_envelope(template, payload)
        finding = vec["findings"].get("py_envelope")
        if finding is not None:
            if env_accept == expected_accept:
                failures.append(
                    f"py_envelope/{vec_id}: marked skipped with {finding}, "
                    f"but decoder now matches contract_verdict={vec['contract_verdict']}"
                )
            else:
                skipped[("py_envelope", vec_id)] = finding
        elif env_accept != expected_accept:
            failures.append(
                f"py_envelope/{vec_id}: expected {vec['contract_verdict']}, got accept={env_accept}"
            )

        if family in ("frame_ref", "observation"):
            obs_accept = _decode_with_observe(family, payload)
            obs_finding = vec["findings"].get("py_observe")
            if obs_finding is not None:
                if obs_accept == expected_accept:
                    failures.append(
                        f"py_observe/{vec_id}: marked skipped with {obs_finding}, "
                        f"but decoder now matches contract_verdict={vec['contract_verdict']}"
                    )
                else:
                    skipped[("py_observe", vec_id)] = obs_finding
            elif obs_accept != expected_accept:
                failures.append(
                    f"py_observe/{vec_id}: expected {vec['contract_verdict']}, got accept={obs_accept}"
                )

    return skipped, failures


class TestFramesParity(unittest.TestCase):
    def test_frames_parity_vectors(self) -> None:
        fixture = _load_fixture()
        self.assertEqual(fixture["schema"], "metaviewer.frames_parity/v1")
        self.assertEqual(fixture["contract_version"], "v0.2")
        self.assertEqual(len(fixture["vectors"]), 26)

        skipped, failures = _run_python_parity_suite(fixture)
        self.assertEqual(failures, [])
        self.assertEqual(skipped, FINDINGS)

    def test_kills_mutated_python_decoder(self) -> None:
        fixture = _load_fixture()

        # Mutation 1 in agents/metaviewer_agents/observe.py:131:
        # omitting the `x + w > width or y + h > height` frame containment check in _check_box.
        orig_check_box = observe_mod._check_box

        def lax_check_box(box: object, *, width: int, height: int, name: str) -> None:
            if not isinstance(box, dict) or set(box) != observe_mod._BBOX_KEYS:
                observe_mod._fail("bad_shape", "%s keys are not exact" % name)
            assert isinstance(box, dict)
            observe_mod._check_int(box["x"], minimum=0, name=name + ".x")
            observe_mod._check_int(box["y"], minimum=0, name=name + ".y")
            observe_mod._check_int(box["w"], minimum=1, name=name + ".w")
            observe_mod._check_int(box["h"], minimum=1, name=name + ".h")

        observe_mod._check_box = lax_check_box
        try:
            _skipped, failures = _run_python_parity_suite(fixture)
        finally:
            observe_mod._check_box = orig_check_box

        self.assertTrue(
            any("py_observe/observation_invalid_escape_changed_region:" in f for f in failures),
            f"expected escaping changed_region mutation to be killed, got {failures}",
        )
        self.assertTrue(
            any("py_observe/observation_invalid_escape_element_bbox:" in f for f in failures),
            f"expected escaping element bbox mutation to be killed, got {failures}",
        )

        # Mutation 2 in agents/metaviewer_agents/observe.py:50:
        # case-insensitive _HEX64 allowing uppercase SHA-256 digests.
        orig_hex64 = observe_mod._HEX64
        observe_mod._HEX64 = re.compile(r"[0-9a-fA-F]{64}")
        try:
            _skipped, hex_failures = _run_python_parity_suite(fixture)
        finally:
            observe_mod._HEX64 = orig_hex64

        self.assertTrue(
            any("py_observe/frame_ref_invalid_sha256_upper:" in f for f in hex_failures),
            f"expected uppercase sha256 mutation to be killed, got {hex_failures}",
        )


if __name__ == "__main__":
    unittest.main()
