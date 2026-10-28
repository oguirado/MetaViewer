"""Regression tests for R3-AGENTS-CODEC (Part A and Part B)."""

from __future__ import annotations

import copy
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parent.parent))

from metaviewer_agents.envelope import (
    EnvelopeError,
    dumps_envelope,
    loads_envelope,
    make_envelope,
    validate_envelope,
)
from metaviewer_agents.observe import (
    ObservationError,
    build_observation,
    compute_battery_state_sha256,
    validate_observation,
)
from metaviewer_agents.wender_bridge import (
    WenderSubprocessAdapter,
    _run_bounded,
    validate_state,
)

_SHA = "ab" * 32
_STATE_SHA = "cd" * 32
_MAX_SAFE_INT = (1 << 53) - 1
_MAX_BYTES = 262144


def _frame(version: str = "v0.2", **overrides) -> dict:
    frame = {
        "schema": f"frame_ref/{version}",
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


def _vision(**overrides) -> dict:
    vision = {
        "summary": "Ready button visible",
        "changed_regions": [{"x": 0, "y": 0, "w": 800, "h": 600}],
        "elements": [
            {
                "bbox": {"x": 10, "y": 20, "w": 80, "h": 30},
                "role": "button",
                "name": "Ready",
                "confidence": 0.95,
            }
        ],
    }
    vision.update(overrides)
    return vision


def _truth(**overrides) -> dict:
    truth = {
        "source": "holdings_lane",
        "state_sha256": _STATE_SHA,
        "tick": 7,
    }
    truth.update(overrides)
    return truth


def _table(frame_sha256: str = _SHA, width: int = 800, height: int = 600) -> dict:
    return {
        "schema": "vqa.element-table/v1",
        "frame_sha256": frame_sha256,
        "width": width,
        "height": height,
        "elements": [
            {
                "bbox": {"x": 10, "y": 20, "w": 80, "h": 30},
                "role": "button",
                "name": "Ready",
                "score_ppm": 950000,
            }
        ],
    }


def _wender_state() -> dict:
    node = {
        "id": "0123456789abcdef",
        "role": "button",
        "name": "Continue",
        "depth": 0,
        "parent": None,
        "ordinal": 0,
        "states": {"status": "ready"},
        "actionable": True,
        "box": [10, 20, 30, 20],
    }
    return {
        "schema": "wender.state/v1",
        "source": {"kind": "vision", "url": None, "title": "café"},
        "prune": {"name": "test", "version": 1},
        "ax_sha256": "b" * 64,
        "ax_stable_sha256": "c" * 64,
        "viewport": {"w": 800, "h": 600},
        "nodes": [node],
        "actionable": [node["id"]],
        "counts": {"raw": 1, "nodes": 1, "actionable": 1},
    }


def _nested_list(depth: int) -> list:
    root: list = []
    cur = root
    for _ in range(depth - 1):
        nxt: list = []
        cur.append(nxt)
        cur = nxt
    return root


class R3CodecTests(unittest.TestCase):
    def test_wender_surrogate_inputs_are_typed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mv-r3codec-") as tmp:
            root = Path(tmp).resolve()
            adapter = WenderSubprocessAdapter(
                wender_root=root,
                command=[sys.executable, "-c", "raise SystemExit(1)"],
                timeout=2,
            )
            obs = build_observation(_frame(), surface_id="surface-demo", generation=1)
            tbl = _table()

            with patch(
                "metaviewer_agents.wender_bridge.subprocess.Popen",
                side_effect=AssertionError("subprocess must never spawn on surrogate input"),
            ):
                # 1. Surrogate goals refused with typed ObservationError("bad_shape") before spawn
                for bad_goal in ("\ud800", "\udfff", "Continue \ud800", "ok\udfffbad"):
                    with self.subTest(goal=repr(bad_goal)):
                        with self.assertRaises(ObservationError) as ctx:
                            adapter.plan_step(obs, tbl, bad_goal)
                        self.assertEqual(ctx.exception.code, "bad_shape")

                # 2. Surrogate element_table fields and keys refused before spawn
                for mutate_tbl in (
                    lambda t: t["elements"][0].__setitem__("name", "bad\ud800name"),
                    lambda t: t["elements"][0].__setitem__("role", "bad\udfffrole"),
                    lambda t: t.__setitem__("bad\ud800key", "v"),
                ):
                    bad_tbl = copy.deepcopy(tbl)
                    mutate_tbl(bad_tbl)
                    with self.assertRaises(ObservationError) as ctx:
                        adapter.plan_step(obs, bad_tbl, "Continue")
                    self.assertEqual(ctx.exception.code, "bad_shape")

                # 3. Surrogate command argv refused at adapter construction
                with self.assertRaises(ObservationError) as ctx:
                    WenderSubprocessAdapter(
                        wender_root=root,
                        command=[sys.executable, "arg-\ud800"],
                        timeout=2,
                    )
                self.assertEqual(ctx.exception.code, "bad_shape")

            # 4. Surrogates in validate_state and compute_battery_state_sha256 refused with bad_shape
            for mutate_state in (
                lambda s: s["nodes"][0].__setitem__("name", "bad\ud800"),
                lambda s: s["nodes"][0].__setitem__("role", "bad\udfff"),
                lambda s: s["nodes"][0]["states"].__setitem__("status", "bad\ud800"),
                lambda s: s["nodes"][0]["states"].__setitem__("k\ud800", "ok"),
                lambda s: s["source"].__setitem__("title", "bad\ud800"),
                lambda s: s["source"].__setitem__("url", "http://example.invalid/\udfff"),
                lambda s: s["prune"].__setitem__("name", "bad\ud800"),
            ):
                bad_state = _wender_state()
                mutate_state(bad_state)
                with self.assertRaises(ObservationError) as ctx:
                    validate_state(bad_state)
                self.assertEqual(ctx.exception.code, "bad_shape")
                with self.assertRaises(ObservationError) as ctx:
                    compute_battery_state_sha256(bad_state)
                self.assertEqual(ctx.exception.code, "bad_shape")

            # Positive control: valid Unicode state and astral codepoints pass
            good_state = _wender_state()
            good_state["nodes"][0]["name"] = "Continue café \U0001f600"
            digest = validate_state(good_state)
            self.assertEqual(digest, compute_battery_state_sha256(good_state))
            self.assertEqual(len(digest), 64)

    def test_builders_validate_before_deepcopy(self) -> None:
        # 1. Prove validation runs before copy.deepcopy by failing if deepcopy is called on invalid input
        bad_body = {"schema": "observation/v0.2", "frame_ref": "not-a-dict"}
        with patch(
            "metaviewer_agents.envelope.copy.deepcopy",
            side_effect=AssertionError("deepcopy called before validate_envelope"),
        ):
            with self.assertRaises(EnvelopeError) as env_ctx:
                make_envelope(
                    msg_id="m-1",
                    from_component="agent",
                    from_instance="agent-1",
                    to_component="core",
                    to_instance="core-1",
                    session_id="sess-1",
                    seq=1,
                    ts_ns=1,
                    body=bad_body,
                )
            self.assertEqual(env_ctx.exception.code, "bad_shape")

        with patch(
            "metaviewer_agents.observe.copy.deepcopy",
            side_effect=AssertionError("deepcopy called before validate_observation"),
        ):
            with self.assertRaises(ObservationError) as obs_ctx:
                build_observation(
                    _frame(ts_ns=_MAX_SAFE_INT + 1),
                    surface_id="surface-demo",
                    generation=1,
                )
            self.assertEqual(obs_ctx.exception.code, "bad_shape")

        # 2. Test depth > 32 (33) and depth = 2000 with pinned recursion limit -> typed error, never RecursionError
        for depth in (33, 2000):
            deep = _nested_list(depth)
            hostile_body = {
                "schema": "observation/v0.2",
                "frame_ref": _frame(),
                "vision": {
                    "summary": "ok",
                    "changed_regions": deep,
                    "elements": [],
                },
            }
            for call_env in (
                lambda: make_envelope(
                    msg_id="m-deep",
                    from_component="agent",
                    from_instance="agent-1",
                    to_component="core",
                    to_instance="core-1",
                    session_id="sess-1",
                    seq=1,
                    ts_ns=1,
                    body=hostile_body,
                ),
                lambda: validate_envelope(
                    {
                        "schema": "envelope/v0.2",
                        "msg_id": "m-deep",
                        "ts_ns": 1,
                        "from": {"component": "agent", "instance": "agent-1"},
                        "to": {"component": "core", "instance": "core-1"},
                        "session_id": "sess-1",
                        "seq": 1,
                        "nonce": "a" * 32,
                        "body": hostile_body,
                    }
                ),
            ):
                with self.assertRaises(EnvelopeError) as env_ctx:
                    call_env()
                self.assertEqual(env_ctx.exception.code, "bad_shape")

            for call_obs in (
                lambda: build_observation(
                    _frame(),
                    surface_id="surface-demo",
                    generation=1,
                    vision={"summary": "ok", "changed_regions": deep, "elements": []},
                ),
                lambda: validate_observation(
                    hostile_body,
                    surface_id="surface-demo",
                    generation=1,
                ),
                lambda: compute_battery_state_sha256(
                    {"nodes": [{"id": "a", "box": None, "nested": deep}]}
                ),
            ):
                with self.assertRaises(ObservationError) as obs_ctx:
                    call_obs()
                self.assertEqual(obs_ctx.exception.code, "bad_shape")

        # 3. Negative control: valid observations and envelopes remain deep-copy isolated against caller mutation
        caller_frame = _frame()
        caller_vision = _vision()
        caller_truth = _truth()
        built_obs = build_observation(
            caller_frame,
            surface_id="surface-demo",
            generation=1,
            vision=caller_vision,
            ground_truth=caller_truth,
        )
        caller_frame["tick"] = 9999
        caller_vision["summary"] = "mutated-summary"
        caller_vision["elements"][0]["bbox"]["x"] = 777
        caller_truth["tick"] = 8888
        self.assertEqual(built_obs["frame_ref"]["tick"], 7)
        self.assertEqual(built_obs["vision"]["summary"], "Ready button visible")
        self.assertEqual(built_obs["vision"]["elements"][0]["bbox"]["x"], 10)
        self.assertEqual(built_obs["ground_truth"]["tick"], 7)

        caller_body = copy.deepcopy(built_obs)
        built_env = make_envelope(
            msg_id="m-iso",
            from_component="agent",
            from_instance="agent-1",
            to_component="core",
            to_instance="core-1",
            session_id="sess-1",
            seq=1,
            ts_ns=1,
            body=caller_body,
        )
        caller_body["vision"]["summary"] = "corrupted-after-make"
        self.assertEqual(built_env["body"]["vision"]["summary"], "Ready button visible")

    def test_observation_output_roundtrips_wire_rails(self) -> None:
        # 1. Off-rail integers (ts_ns=2**53, tick=2**53, generation=2**53, capture_us=2**53) refused
        for field in ("ts_ns", "tick", "generation", "capture_us"):
            bad_frame = _frame(**{field: 1 << 53})
            gen = (1 << 53) if field == "generation" else 1
            with self.subTest(field=field):
                with self.assertRaises(ObservationError) as ctx:
                    build_observation(bad_frame, surface_id="surface-demo", generation=gen)
                self.assertEqual(ctx.exception.code, "bad_shape")

        with self.assertRaises(ObservationError) as ctx:
            build_observation(
                _frame(),
                surface_id="surface-demo",
                generation=1,
                ground_truth=_truth(tick=1 << 53),
            )
        self.assertEqual(ctx.exception.code, "bad_shape")

        # 2. Surrogate summary, element name, element role refused
        for bad_vision in (
            _vision(summary="surrogate-\ud800-summary"),
            _vision(summary="\udfff"),
            _vision(
                elements=[
                    {
                        "bbox": {"x": 10, "y": 20, "w": 80, "h": 30},
                        "role": "button",
                        "name": "bad-\ud800-name",
                        "confidence": 0.5,
                    }
                ]
            ),
            _vision(
                elements=[
                    {
                        "bbox": {"x": 10, "y": 20, "w": 80, "h": 30},
                        "role": "bad-\udfff-role",
                        "name": "ok",
                        "confidence": 0.5,
                    }
                ]
            ),
        ):
            with self.assertRaises(ObservationError) as ctx:
                build_observation(
                    _frame(),
                    surface_id="surface-demo",
                    generation=1,
                    vision=bad_vision,
                )
            self.assertEqual(ctx.exception.code, "bad_shape")

        # 3. Positive control: boundary-valid observations (ts_ns=2**53-1, valid astral Unicode)
        # round-trip cleanly through make_envelope, dumps_envelope, and loads_envelope for v0.2 and explicit v0.1
        for version in ("v0.2", "v0.1"):
            frame_max = _frame(
                version=version,
                generation=_MAX_SAFE_INT,
                tick=_MAX_SAFE_INT,
                ts_ns=_MAX_SAFE_INT,
                capture_us=_MAX_SAFE_INT,
            )
            vision_unicode = _vision(summary="Ready café \U0001f600")
            truth_max = _truth(tick=_MAX_SAFE_INT)
            if version == "v0.2":
                obs = build_observation(
                    frame_max,
                    surface_id="surface-demo",
                    generation=_MAX_SAFE_INT,
                    vision=vision_unicode,
                    ground_truth=truth_max,
                )
                validate_observation(
                    obs, surface_id="surface-demo", generation=_MAX_SAFE_INT
                )
            else:
                obs = build_observation(
                    frame_max,
                    surface_id="surface-demo",
                    generation=_MAX_SAFE_INT,
                    vision=vision_unicode,
                    ground_truth=truth_max,
                    contract_version="v0.1",
                )
                validate_observation(
                    obs,
                    surface_id="surface-demo",
                    generation=_MAX_SAFE_INT,
                    contract_version="v0.1",
                )
            env = make_envelope(
                msg_id="m-rt",
                from_component="agent",
                from_instance="agent-1",
                to_component="core",
                to_instance="core-1",
                session_id="sess-1",
                seq=1,
                ts_ns=_MAX_SAFE_INT,
                body=obs,
            )
            encoded = dumps_envelope(env, max_bytes=_MAX_BYTES)
            decoded = loads_envelope(encoded, max_bytes=_MAX_BYTES)
            self.assertEqual(decoded, env)

    def test_wender_timeout_refusal_without_subprocess_spawn(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mv-r3timeout-") as tmp:
            root = Path(tmp).resolve()
            obs = build_observation(_frame(), surface_id="surface-demo", generation=1)
            tbl = _table()

            with patch(
                "metaviewer_agents.wender_bridge.subprocess.Popen",
                side_effect=AssertionError("subprocess must never spawn on invalid timeout"),
            ):
                for bad_timeout in (10**400, -(10**400), 1e20, 1e100, float("inf"), float("nan"), 0, -1, True):
                    with self.subTest(timeout=bad_timeout):
                        with self.assertRaises(ObservationError) as ctx:
                            WenderSubprocessAdapter(
                                wender_root=root,
                                command=[sys.executable],
                                timeout=bad_timeout,
                            )
                        self.assertEqual(ctx.exception.code, "bad_shape")

                        adapter = WenderSubprocessAdapter(
                            wender_root=root,
                            command=[sys.executable],
                            timeout=2,
                        )
                        adapter.timeout = bad_timeout
                        with self.assertRaises(ObservationError) as ctx2:
                            adapter.plan_step(obs, tbl, "Continue")
                        self.assertEqual(ctx2.exception.code, "bad_shape")

                        with self.assertRaises(ObservationError) as ctx3:
                            _run_bounded(
                                [sys.executable],
                                cwd=root,
                                env={},
                                request=b"{}",
                                timeout=bad_timeout,
                            )
                        self.assertEqual(ctx3.exception.code, "bad_shape")


if __name__ == "__main__":
    unittest.main()
