"""Unit tests for the mvctl tool verbs (standard library only)."""

import copy
import io
import re
import sys
import time
import unittest
from pathlib import Path
from unittest import runner

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from metaviewer_agents import tools
from metaviewer_agents.tools import (
    ToolClient,
    ToolRefusal,
    ToolValidationError,
    VerificationFailed,
)

_DIGEST = "0123456789abcdef" * 4
_DIGEST2 = "fedcba9876543210" * 4
_CANARY = "TOOLS-CANARY-9d4e2b71-never-echo"
_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]*")
_REASONS = (
    "STALE_FRAME",
    "SURFACE_NOT_AGENT_CONTROLLED",
    "LOCKED_BY_OTHER",
    "BUDGET_EXCEEDED",
    "OUT_OF_BOUNDS",
    "POLICY",
)
_ERROR_CODES = ("PROTOCOL", "UNAVAILABLE", "NOT_FOUND")


def _frame(**over):
    frame = {
        "schema": "frame_ref/v0.1",
        "surface_id": "surf-1",
        "generation": 2,
        "tick": 11,
        "ts_ns": 55,
        "width": 8,
        "height": 8,
        "format": "rgb24",
        "ramws_path": "/dev/shm/mv-test-frame",
        "sha256": _DIGEST,
        "capture_us": 9,
    }
    frame.update(over)
    return frame


def _vision(**over):
    vision = {
        "summary": "one button",
        "changed_regions": [{"x": 0, "y": 0, "w": 8, "h": 8}],
        "elements": [
            {
                "bbox": {"x": 1, "y": 2, "w": 3, "h": 4},
                "role": "button",
                "name": "ok",
                "confidence": 0.75,
            }
        ],
    }
    vision.update(over)
    return vision


def _ground_truth(**over):
    witness = {
        "source": "holdings_lane",
        "state_sha256": _DIGEST2,
        "tick": 11,
    }
    witness.update(over)
    return witness


def _observation(*, full=False, **over):
    observation = {"schema": "observation/v0.1", "frame_ref": _frame()}
    if full:
        observation["vision"] = _vision()
        observation["ground_truth"] = _ground_truth()
    observation.update(over)
    return observation


def _surface(**over):
    surface = {
        "schema": "surface/v0.1",
        "surface_id": "surf-1",
        "kind": "browser",
        "display": ":99",
        "geometry": {"w": 800, "h": 600},
        "state": "active",
        "visibility": "unfolded",
        "control": "agent",
        "profile_id": "profile-1",
    }
    surface.update(over)
    return surface


def _verdict(**over):
    verdict = {
        "schema": "action_verdict/v0.1",
        "proposal_id": "p-1",
        "decision": "admitted",
        "core_seq": 7,
    }
    verdict.update(over)
    return verdict


def _receipt(**over):
    receipt = {
        "schema": "action_receipt/v0.1",
        "proposal_id": "p-1",
        "executed_at_ns": 2000000,
        "after_frame": _frame(),
        "verified": True,
        "verification": {"method": "pixel", "detail": "region changed"},
        "error": "",
    }
    receipt.update(over)
    return receipt


def _proposal(**over):
    proposal = {
        "schema": "action_proposal/v0.2",
        "proposal_id": "p-1",
        "surface_id": "surf-1",
        "based_on_frame": {"sha256": _DIGEST, "generation": 3},
        "action": {"type": "click", "x": 4, "y": 5, "button": "left"},
        "expectation": {"type": "text_present", "text": "done"},
        "budget": {"max_ms": 500, "max_retries": 1},
    }
    proposal.update(over)
    return proposal


def _expectation():
    return {"type": "changed_region",
            "bbox": {"x": 10, "y": 20, "w": 80, "h": 30}}


def _ok_observe(request_id, **over):
    result = {
        "schema": "mv_tool_result/v0.2",
        "request_id": request_id,
        "op": "observe",
        "status": "ok",
        "observation": _observation(full=True),
    }
    result.update(over)
    return result


def _ok_list(request_id, surfaces=(), next_cursor=None):
    return {
        "schema": "mv_tool_result/v0.2",
        "request_id": request_id,
        "op": "list",
        "status": "ok",
        "surfaces": list(surfaces),
        "next_cursor": next_cursor,
    }


def _admitted(request_id, **over):
    return {
        "schema": "mv_tool_result/v0.2",
        "request_id": request_id,
        "op": "propose",
        "status": "admitted",
        "verdict": _verdict(**over),
    }


def _refused(request_id, op, reason):
    return {
        "schema": "mv_tool_result/v0.2",
        "request_id": request_id,
        "op": op,
        "status": "refused",
        "reason_code": reason,
        "detail": "core says no",
    }


def _pending(request_id, proposal_id="p-1", retry_after_ms=1):
    return {
        "schema": "mv_tool_result/v0.2",
        "request_id": request_id,
        "op": "wait_verify",
        "status": "pending",
        "proposal_id": proposal_id,
        "retry_after_ms": retry_after_ms,
    }


def _verified(request_id, **over):
    return {
        "schema": "mv_tool_result/v0.2",
        "request_id": request_id,
        "op": "wait_verify",
        "status": "verified",
        "receipt": _receipt(),
        "focus_verified": True,
        "input_mono_ns": 1995000,
        "frame_sha256": _DIGEST,
    } | over


def _timeout_result(request_id, proposal_id="p-1"):
    return {
        "schema": "mv_tool_result/v0.2",
        "request_id": request_id,
        "op": "wait_verify",
        "status": "timeout",
        "proposal_id": proposal_id,
        "verified": False,
    }


def _error(request_id, op, code):
    return {
        "schema": "mv_tool_result/v0.2",
        "request_id": request_id,
        "op": op,
        "status": "error",
        "code": code,
        "detail": "core error detail",
    }


class _FakeClient:
    """Recording scripted client; builders receive the live call."""

    def __init__(self, builders):
        self._builders = list(builders)
        self.calls = []

    def request(self, body, expect, *, timeout_ms):
        self.calls.append((body, expect, timeout_ms))
        index = min(len(self.calls) - 1, len(self._builders) - 1)
        made = self._builders[index](body)
        if isinstance(made, Exception):
            raise made
        return made


def _reply(payload):
    return lambda call: payload | {"request_id": call["request_id"]}


class SurfaceTests(unittest.TestCase):
    def test_public_names(self):
        self.assertEqual(
            set(tools.__all__),
            {"ToolClient", "ToolRefusal", "ToolValidationError",
             "VerificationFailed", "list_surfaces", "observe", "propose",
             "wait_verify"})
        for name in tools.__all__:
            self.assertTrue(hasattr(tools, name), name)

    def test_error_taxonomy(self):
        self.assertTrue(issubclass(ToolValidationError, ValueError))
        err = ToolValidationError("bad shape")
        self.assertEqual(str(err), "bad shape")
        self.assertTrue(hasattr(ToolClient, "request"))
        refusal = ToolRefusal("POLICY", None)
        self.assertEqual(refusal.reason_code, "POLICY")
        self.assertIsNone(refusal.core_seq)
        self.assertEqual(str(refusal), "POLICY")
        kept = {"verified": False}
        failed = VerificationFailed(kept)
        self.assertIs(failed.receipt, kept)


class ObserveTests(unittest.TestCase):
    def test_ok_returns_full_observation(self):
        fake = _FakeClient([lambda call: _ok_observe(call["request_id"])])
        out = tools.observe("surf-1", client=fake, timeout_ms=500)
        self.assertEqual(out["schema"], "observation/v0.1")
        self.assertEqual(out["frame_ref"]["surface_id"], "surf-1")
        self.assertIn("vision", out)
        self.assertIn("ground_truth", out)
        self.assertEqual(len(fake.calls), 1)
        body, expect, timeout = fake.calls[0]
        self.assertEqual(body["schema"], "mv_tool_call/v0.2")
        self.assertEqual(body["op"], "observe")
        self.assertEqual(body["args"], {"surface_id": "surf-1"})
        self.assertEqual(expect, "mv_tool_result/v0.2")
        self.assertEqual(timeout, 500)
        self.assertIsNotNone(
            _ID_PATTERN.fullmatch(body["request_id"]))
        self.assertLessEqual(len(body["request_id"]), 128)

    def test_ok_minimal_observation(self):
        sent = _ok_observe("placeholder",
                           observation=_observation(full=False))
        fake = _FakeClient([_reply(sent)])
        out = tools.observe("surf-1", client=fake, timeout_ms=500)
        self.assertEqual(set(out), {"schema", "frame_ref"})

    def test_bad_surface_id_refuses_without_dispatch(self):
        for bad in ("", "has space", "x" * 129, 123, None, True, b"surf-1"):
            with self.subTest(bad=bad):
                fake = _FakeClient([lambda call: {}])
                with self.assertRaises(ToolValidationError):
                    tools.observe(bad, client=fake, timeout_ms=500)
                self.assertEqual(fake.calls, [])

    def test_bad_timeout_refuses_without_dispatch(self):
        for bad in (0, -1, True, False, 1.5, "500", None):
            with self.subTest(bad=bad):
                fake = _FakeClient([lambda call: {}])
                with self.assertRaises(ToolValidationError):
                    tools.observe("surf-1", client=fake, timeout_ms=bad)
                self.assertEqual(fake.calls, [])

    def test_bad_client_refuses_without_dispatch(self):
        for bad in (None, object(), {}, "client"):
            with self.subTest(bad=bad):
                with self.assertRaises(ToolValidationError):
                    tools.observe("surf-1", client=bad, timeout_ms=500)

    def test_unknown_result_version_refuses(self):
        for schema in ("mv_tool_result/v9.9", "mv_tool_result/v0.0",
                       "mv_tool_result/v0.1"):
            with self.subTest(schema=schema):
                sent = _ok_observe("placeholder")
                sent["schema"] = schema
                fake = _FakeClient([_reply(sent)])
                with self.assertRaisesRegex(ToolValidationError,
                                            "unknown result version"):
                    tools.observe("surf-1", client=fake, timeout_ms=500)

    def test_malformed_result_refuses(self):
        for bad in (None, [], "x", 42,
                    {"schema": "mv_tool_result/v0.2"},
                    {"schema": "other/v1.0", "request_id": "r", "op": "x"},
                    {"request_id": "r", "op": "observe", "status": "ok"}):
            with self.subTest(bad=bad):
                fake = _FakeClient([lambda call: copy.deepcopy(bad)])
                with self.assertRaises(ToolValidationError):
                    tools.observe("surf-1", client=fake, timeout_ms=500)

    def test_uncorrelated_reply_refuses(self):
        sent = _ok_observe("other-request")
        fake = _FakeClient([lambda call: sent])
        with self.assertRaisesRegex(ToolValidationError,
                                    "uncorrelated request_id"):
            tools.observe("surf-1", client=fake, timeout_ms=500)
        sent = _ok_observe("placeholder")
        sent["op"] = "list"
        fake = _FakeClient([_reply(sent)])
        with self.assertRaisesRegex(ToolValidationError, "uncorrelated op"):
            tools.observe("surf-1", client=fake, timeout_ms=500)

    def test_wrong_status_refuses(self):
        for status in ("admitted", "verified", "timeout", "pending",
                       "bogus", None, 0):
            with self.subTest(status=status):
                sent = _ok_observe("placeholder")
                sent["status"] = status
                fake = _FakeClient([_reply(sent)])
                with self.assertRaises(ToolValidationError):
                    tools.observe("surf-1", client=fake, timeout_ms=500)

    def test_extra_keys_refuse(self):
        base = _ok_observe("placeholder")
        variants = []
        top = copy.deepcopy(base)
        top["zzz"] = 1
        variants.append(top)
        nested = copy.deepcopy(base)
        nested["observation"]["zzz"] = 1
        variants.append(nested)
        frame = copy.deepcopy(base)
        frame["observation"]["frame_ref"]["zzz"] = 1
        variants.append(frame)
        element = copy.deepcopy(base)
        element["observation"]["vision"]["elements"][0]["zzz"] = 1
        variants.append(element)
        for index, sent in enumerate(variants):
            with self.subTest(index=index):
                fake = _FakeClient([_reply(sent)])
                with self.assertRaises(ToolValidationError):
                    tools.observe("surf-1", client=fake, timeout_ms=500)

    def test_surface_mismatch_refuses(self):
        sent = _ok_observe("placeholder")
        sent["observation"]["frame_ref"]["surface_id"] = "surf-2"
        fake = _FakeClient([_reply(sent)])
        with self.assertRaisesRegex(ToolValidationError,
                                    "uncorrelated surface_id"):
            tools.observe("surf-1", client=fake, timeout_ms=500)

    def test_frame_violations_refuse(self):
        def mutate(frame):
            sent = _ok_observe("placeholder")
            sent["observation"]["frame_ref"] = frame
            return sent

        good = _frame()
        cases = []
        for key in ("tick", "ts_ns", "capture_us"):
            bad = copy.deepcopy(good)
            del bad[key]
            cases.append(bad)
        bad = copy.deepcopy(good)
        bad["frame_seq"] = 1
        cases.append(bad)
        for key, value in (("format", "rgba8"), ("format", "RGB24"),
                           ("ramws_path", "/tmp/frame.rgb"),
                           ("ramws_path", "/dev/shm/"),
                           ("ramws_path", "/dev/shm/a\x00b"),
                           ("sha256", "xyz"), ("sha256", _DIGEST.upper()),
                           ("sha256", _DIGEST[:63]),
                           ("generation", 0), ("generation", True),
                           ("generation", "2"), ("tick", -1),
                           ("width", 0), ("width", 16385),
                           ("height", 16385), ("capture_us", -1),
                           ("surface_id", ""), ("schema", "frame_ref/v0.2")):
            bad = copy.deepcopy(good)
            bad[key] = value
            cases.append(bad)
        for index, frame in enumerate(cases):
            with self.subTest(index=index):
                fake = _FakeClient([_reply(mutate(frame))])
                with self.assertRaises(ToolValidationError):
                    tools.observe("surf-1", client=fake, timeout_ms=500)

    def test_all_zero_digest_is_accepted(self):
        sent = _ok_observe("placeholder")
        sent["observation"]["frame_ref"]["sha256"] = "0" * 64
        fake = _FakeClient([_reply(sent)])
        out = tools.observe("surf-1", client=fake, timeout_ms=500)
        self.assertEqual(out["frame_ref"]["sha256"], "0" * 64)

    def test_vision_violations_refuse(self):
        def mutate(vision):
            sent = _ok_observe("placeholder")
            sent["observation"]["vision"] = vision
            return sent

        cases = []
        for confidence in (True, False, float("nan"), float("inf"),
                           float("-inf"), -0.1, 1.5, "0.5", None):
            bad = _vision()
            bad["elements"][0]["confidence"] = confidence
            cases.append(bad)
        bad = _vision()
        bad["elements"][0]["bbox"] = None
        cases.append(bad)
        bad = _vision()
        bad["elements"][0]["bbox"]["w"] = 0
        cases.append(bad)
        bad = _vision()
        bad["elements"][0]["bbox"]["x"] = 16384
        cases.append(bad)
        bad = _vision()
        bad["elements"][0]["role"] = ""
        cases.append(bad)
        bad = _vision()
        bad["elements"] = [_vision()["elements"][0]] * 257
        cases.append(bad)
        bad = _vision()
        del bad["summary"]
        cases.append(bad)
        for index, vision in enumerate(cases):
            with self.subTest(index=index):
                fake = _FakeClient([_reply(mutate(vision))])
                with self.assertRaises(ToolValidationError):
                    tools.observe("surf-1", client=fake, timeout_ms=500)

    def test_integer_confidence_bounds_accepted(self):
        for confidence in (0, 1, 0.0, 1.0):
            with self.subTest(confidence=confidence):
                sent = _ok_observe("placeholder")
                sent["observation"]["vision"]["elements"][0][
                    "confidence"] = confidence
                fake = _FakeClient([_reply(sent)])
                out = tools.observe("surf-1", client=fake, timeout_ms=500)
                self.assertEqual(
                    out["vision"]["elements"][0]["confidence"], confidence)

    def test_ground_truth_violations_refuse(self):
        def mutate(witness):
            sent = _ok_observe("placeholder")
            sent["observation"]["ground_truth"] = witness
            return sent

        cases = []
        for key, value in (("source", "electron"), ("source", "HOLDINGS"),
                           ("state_sha256", "zz"), ("tick", -1),
                           ("tick", True)):
            bad = _ground_truth()
            bad[key] = value
            cases.append(bad)
        bad = _ground_truth()
        del bad["tick"]
        cases.append(bad)
        for index, witness in enumerate(cases):
            with self.subTest(index=index):
                fake = _FakeClient([_reply(mutate(witness))])
                with self.assertRaises(ToolValidationError):
                    tools.observe("surf-1", client=fake, timeout_ms=500)

    def test_all_six_refusals_raise_without_retry(self):
        for reason in _REASONS:
            with self.subTest(reason=reason):
                fake = _FakeClient(
                    [lambda call, r=reason: _refused(call["request_id"],
                                                     "observe", r)])
                with self.assertRaises(ToolRefusal) as caught:
                    tools.observe("surf-1", client=fake, timeout_ms=500)
                self.assertEqual(caught.exception.reason_code, reason)
                self.assertIsNone(caught.exception.core_seq)
                self.assertEqual(str(caught.exception), reason)
                self.assertEqual(len(fake.calls), 1)

    def test_unknown_reason_refuses(self):
        sent = _refused("placeholder", "observe", "DUPLICATE_SEQ")
        fake = _FakeClient([_reply(sent)])
        with self.assertRaises(ToolValidationError):
            tools.observe("surf-1", client=fake, timeout_ms=500)

    def test_error_codes_map(self):
        for code in _ERROR_CODES:
            with self.subTest(code=code):
                sent = _error("placeholder", "observe", code)
                fake = _FakeClient([_reply(sent)])
                with self.assertRaises(ToolValidationError):
                    tools.observe("surf-1", client=fake, timeout_ms=500)
                self.assertEqual(len(fake.calls), 1)
        sent = _error("placeholder", "observe", "VERIFICATION_FAILED")
        fake = _FakeClient([_reply(sent)])
        with self.assertRaises(VerificationFailed) as caught:
            tools.observe("surf-1", client=fake, timeout_ms=500)
        self.assertEqual(caught.exception.receipt["code"],
                         "VERIFICATION_FAILED")

    def test_transport_failures_propagate(self):
        boom = TimeoutError("client deadline")
        fake = _FakeClient([lambda call: boom])
        with self.assertRaises(TimeoutError) as caught:
            tools.observe("surf-1", client=fake, timeout_ms=500)
        self.assertIs(caught.exception, boom)
        err = RuntimeError("socket gone")
        fake = _FakeClient([lambda call: err])
        with self.assertRaises(RuntimeError) as caught:
            tools.observe("surf-1", client=fake, timeout_ms=500)
        self.assertIs(caught.exception, err)

    def test_returned_payload_resists_mutation(self):
        reply = {}
        fake = _FakeClient(
            [lambda call: reply.setdefault(
                "sent", _ok_observe(call["request_id"]))])
        out = tools.observe("surf-1", client=fake, timeout_ms=500)
        snapshot = copy.deepcopy(reply["sent"]["observation"])
        out["frame_ref"]["generation"] = 999
        out["vision"]["elements"][0]["role"] = _CANARY
        self.assertEqual(reply["sent"]["observation"], snapshot)
        self.assertNotIn(_CANARY, repr(reply["sent"]))


class ListTests(unittest.TestCase):
    def _page(self, fake_calls_holder):
        def handler(call):
            fake_calls_holder.append(call)
            return _ok_list(call["request_id"],
                            surfaces=[_surface(),
                                      _surface(surface_id="surf-2",
                                               kind="game_capsule")],
                            next_cursor="cursor-2")
        return handler

    def test_ok_page_returns_result(self):
        seen = []
        fake = _FakeClient([self._page(seen)])
        out = tools.list_surfaces(cursor=None, limit=10, client=fake,
                                  timeout_ms=500)
        self.assertEqual(out["schema"], "mv_tool_result/v0.2")
        self.assertEqual(out["op"], "list")
        self.assertEqual(out["status"], "ok")
        self.assertEqual(len(out["surfaces"]), 2)
        self.assertEqual(out["next_cursor"], "cursor-2")
        self.assertEqual(len(fake.calls), 1)
        body, expect, timeout = fake.calls[0]
        self.assertEqual(body["schema"], "mv_tool_call/v0.2")
        self.assertEqual(body["op"], "list")
        self.assertEqual(body["args"], {"cursor": None, "limit": 10})
        self.assertEqual(expect, "mv_tool_result/v0.2")
        self.assertEqual(timeout, 500)

    def test_empty_page(self):
        fake = _FakeClient([lambda call: _ok_list(call["request_id"])])
        out = tools.list_surfaces(cursor="cursor-9", limit=1, client=fake,
                                  timeout_ms=500)
        self.assertEqual(out["surfaces"], [])
        self.assertIsNone(out["next_cursor"])
        self.assertEqual(fake.calls[0][0]["args"],
                         {"cursor": "cursor-9", "limit": 1})

    def test_single_page_only_despite_cursor(self):
        fake = _FakeClient([lambda call: _ok_list(
            call["request_id"], surfaces=[_surface()],
            next_cursor="cursor-next")])
        out = tools.list_surfaces(cursor=None, limit=10, client=fake,
                                  timeout_ms=500)
        self.assertEqual(out["next_cursor"], "cursor-next")
        self.assertEqual(len(fake.calls), 1)

    def test_bad_cursor_and_limit_refuse_without_dispatch(self):
        for bad in ("", "has space", 5, True, b"c"):
            with self.subTest(cursor=bad):
                fake = _FakeClient([lambda call: {}])
                with self.assertRaises(ToolValidationError):
                    tools.list_surfaces(cursor=bad, limit=10, client=fake,
                                        timeout_ms=500)
                self.assertEqual(fake.calls, [])
        for bad in (0, -3, 257, 1000, True, "10", None, 2.0):
            with self.subTest(limit=bad):
                fake = _FakeClient([lambda call: {}])
                with self.assertRaises(ToolValidationError):
                    tools.list_surfaces(cursor=None, limit=bad, client=fake,
                                        timeout_ms=500)
                self.assertEqual(fake.calls, [])

    def test_limit_bounds_accepted(self):
        for limit in (1, 256):
            with self.subTest(limit=limit):
                fake = _FakeClient(
                    [lambda call: _ok_list(call["request_id"])])
                tools.list_surfaces(cursor=None, limit=limit, client=fake,
                                    timeout_ms=500)
                self.assertEqual(fake.calls[0][0]["args"]["limit"], limit)

    def test_surface_violations_refuse(self):
        good = _surface()
        cases = []
        for key, value in (("kind", "terminal"), ("state", "broken"),
                           ("visibility", "hidden"), ("control", "nobody"),
                           ("surface_id", ""), ("profile_id", ""),
                           ("display", ""), ("schema", "surface/v0.2")):
            bad = copy.deepcopy(good)
            bad[key] = value
            cases.append(bad)
        bad = copy.deepcopy(good)
        bad["geometry"]["w"] = 0
        cases.append(bad)
        bad = copy.deepcopy(good)
        bad["geometry"]["h"] = 16385
        cases.append(bad)
        bad = copy.deepcopy(good)
        bad["extra"] = 1
        cases.append(bad)
        for index, surface in enumerate(cases):
            with self.subTest(index=index):
                fake = _FakeClient([lambda call, s=surface: _ok_list(
                    call["request_id"], surfaces=[s])])
                with self.assertRaises(ToolValidationError):
                    tools.list_surfaces(cursor=None, limit=10, client=fake,
                                        timeout_ms=500)

    def test_oversize_page_and_bad_cursor_refuse(self):
        fake = _FakeClient([lambda call: _ok_list(
            call["request_id"], surfaces=[_surface()] * 257)])
        with self.assertRaises(ToolValidationError):
            tools.list_surfaces(cursor=None, limit=10, client=fake,
                                timeout_ms=500)
        sent = _ok_list("placeholder", next_cursor="")
        fake = _FakeClient([_reply(sent)])
        with self.assertRaises(ToolValidationError):
            tools.list_surfaces(cursor=None, limit=10, client=fake,
                                timeout_ms=500)

    def test_refused_error_and_version_controls(self):
        for reason in _REASONS:
            with self.subTest(reason=reason):
                fake = _FakeClient(
                    [lambda call, r=reason: _refused(call["request_id"],
                                                     "list", r)])
                with self.assertRaises(ToolRefusal) as caught:
                    tools.list_surfaces(cursor=None, limit=10, client=fake,
                                        timeout_ms=500)
                self.assertEqual(caught.exception.reason_code, reason)
                self.assertEqual(len(fake.calls), 1)
        sent = _ok_list("placeholder")
        sent["schema"] = "mv_tool_result/v9.9"
        fake = _FakeClient([_reply(sent)])
        with self.assertRaisesRegex(ToolValidationError,
                                    "unknown result version"):
            tools.list_surfaces(cursor=None, limit=10, client=fake,
                                timeout_ms=500)
        sent = _ok_list("placeholder")
        sent["status"] = "admitted"
        fake = _FakeClient([_reply(sent)])
        with self.assertRaises(ToolValidationError):
            tools.list_surfaces(cursor=None, limit=10, client=fake,
                                timeout_ms=500)


class ProposeTests(unittest.TestCase):
    def test_admitted_returns_verdict_only(self):
        fake = _FakeClient([lambda call: _admitted(call["request_id"])])
        proposal = _proposal()
        out = tools.propose(proposal, client=fake, timeout_ms=500)
        self.assertEqual(out, {"schema": "action_verdict/v0.1",
                               "proposal_id": "p-1",
                               "decision": "admitted",
                               "core_seq": 7})
        self.assertEqual(len(fake.calls), 1)
        body, expect, timeout = fake.calls[0]
        self.assertEqual(body["schema"], "mv_tool_call/v0.2")
        self.assertEqual(body["op"], "propose")
        self.assertEqual(body["args"], {"proposal": proposal})
        self.assertEqual(expect, "mv_tool_result/v0.2")
        self.assertEqual(timeout, 500)

    def test_sent_proposal_isolated_from_caller(self):
        fake = _FakeClient([lambda call: _admitted(call["request_id"])])
        proposal = _proposal()
        tools.propose(proposal, client=fake, timeout_ms=500)
        snapshot = copy.deepcopy(fake.calls[0][0]["args"]["proposal"])
        proposal["budget"]["max_ms"] = 1
        proposal["action"]["x"] = 999
        self.assertEqual(fake.calls[0][0]["args"]["proposal"], snapshot)

    def test_stale_proposal_version_refuses_without_dispatch(self):
        proposal = _proposal(schema="action_proposal/v0.1")
        fake = _FakeClient([lambda call: {}])
        with self.assertRaisesRegex(ToolValidationError,
                                    "unknown proposal version"):
            tools.propose(proposal, client=fake, timeout_ms=500)
        self.assertEqual(fake.calls, [])

    def test_proposal_violations_refuse_without_dispatch(self):
        good = _proposal()
        cases = []
        bad = copy.deepcopy(good)
        del bad["budget"]
        cases.append(bad)
        bad = copy.deepcopy(good)
        bad["extra"] = 1
        cases.append(bad)
        bad = copy.deepcopy(good)
        bad["proposal_id"] = ""
        cases.append(bad)
        bad = copy.deepcopy(good)
        bad["based_on_frame"]["generation"] = 0
        cases.append(bad)
        bad = copy.deepcopy(good)
        bad["based_on_frame"]["sha256"] = "nope"
        cases.append(bad)
        bad = copy.deepcopy(good)
        bad["action"] = {"type": "teleport", "x": 1}
        cases.append(bad)
        bad = copy.deepcopy(good)
        bad["action"] = {"type": "click", "x": 1, "y": 2,
                         "button": "left", "extra": 0}
        cases.append(bad)
        bad = copy.deepcopy(good)
        bad["action"] = {"type": "click", "x": -1, "y": 2,
                         "button": "left"}
        cases.append(bad)
        bad = copy.deepcopy(good)
        bad["action"] = {"type": "click", "x": True, "y": 2,
                         "button": "left"}
        cases.append(bad)
        bad = copy.deepcopy(good)
        bad["action"] = {"type": "key", "keys": []}
        cases.append(bad)
        bad = copy.deepcopy(good)
        bad["action"] = {"type": "wait", "ms": 0}
        cases.append(bad)
        bad = copy.deepcopy(good)
        bad["expectation"] = {"type": "text_present"}
        cases.append(bad)
        bad = copy.deepcopy(good)
        bad["expectation"] = {"type": "bogus"}
        cases.append(bad)
        bad = copy.deepcopy(good)
        bad["expectation"] = {"type": "changed_region",
                              "bbox": {"x": 0, "y": 0, "w": 0, "h": 1}}
        cases.append(bad)
        bad = copy.deepcopy(good)
        bad["expectation"] = {"type": "state_sha256_change",
                              "before": _DIGEST, "min_tick": 0,
                              "max_tick": True}
        cases.append(bad)
        bad = copy.deepcopy(good)
        bad["budget"] = {"max_ms": 0, "max_retries": 0}
        cases.append(bad)
        bad = copy.deepcopy(good)
        bad["budget"] = {"max_ms": 5, "max_retries": -1}
        cases.append(bad)
        for index, proposal in enumerate(cases):
            with self.subTest(index=index):
                fake = _FakeClient([lambda call: {}])
                with self.assertRaises(ToolValidationError):
                    tools.propose(proposal, client=fake, timeout_ms=500)
                self.assertEqual(fake.calls, [])

    def test_all_action_branches_accepted(self):
        actions = [
            {"type": "click", "x": 0, "y": 0, "button": "right"},
            {"type": "key", "keys": ["ctrl", "c"]},
            {"type": "type", "text": "hi"},
            {"type": "scroll", "dx": -3, "dy": 9},
            {"type": "wait", "ms": 50},
            {"type": "lane_submit", "verb": "submit",
             "payload": {"nonce": "n-1", "seq": 2, "command": "run",
                         "args": ["a"]}},
        ]
        for index, action in enumerate(actions):
            with self.subTest(index=index):
                fake = _FakeClient(
                    [lambda call: _admitted(call["request_id"])])
                out = tools.propose(_proposal(action=action), client=fake,
                                    timeout_ms=500)
                self.assertEqual(out["decision"], "admitted")

    def test_all_expectation_branches_accepted(self):
        expectations = [
            {"type": "changed_region",
             "bbox": {"x": 0, "y": 0, "w": 1, "h": 1}},
            {"type": "element_state", "role": "button", "name": "",
             "state": "enabled"},
            {"type": "state_sha256_change", "before": _DIGEST,
             "min_tick": 1, "max_tick": 9},
            {"type": "text_present", "text": "ok"},
        ]
        for index, expectation in enumerate(expectations):
            with self.subTest(index=index):
                fake = _FakeClient(
                    [lambda call: _admitted(call["request_id"])])
                out = tools.propose(_proposal(expectation=expectation),
                                    client=fake, timeout_ms=500)
                self.assertEqual(out["proposal_id"], "p-1")

    def test_verdict_violations_refuse(self):
        cases = []
        bad = _verdict(proposal_id="p-2")
        cases.append(("correlation", bad))
        bad = _verdict()
        del bad["core_seq"]
        cases.append(("missing core_seq", bad))
        bad = _verdict(core_seq=0)
        cases.append(("zero core_seq", bad))
        bad = _verdict(core_seq=True)
        cases.append(("bool core_seq", bad))
        bad = _verdict(decision="refused", reason_code="POLICY")
        cases.append(("refused in admitted branch", bad))
        bad = _verdict()
        del bad["decision"]
        bad["verdict"] = "admitted"
        cases.append(("legacy verdict spelling", bad))
        bad = _verdict(schema="action_verdict/v0.2")
        cases.append(("wrong verdict version", bad))
        bad = _verdict()
        bad["extra"] = 1
        cases.append(("extra key", bad))
        for name, verdict in cases:
            with self.subTest(name=name):
                sent = _admitted("placeholder")
                sent["verdict"] = verdict
                fake = _FakeClient([_reply(sent)])
                with self.assertRaises(ToolValidationError):
                    tools.propose(_proposal(), client=fake, timeout_ms=500)

    def test_all_six_refusals_raise_without_retry(self):
        for reason in _REASONS:
            with self.subTest(reason=reason):
                fake = _FakeClient(
                    [lambda call, r=reason: _refused(call["request_id"],
                                                     "propose", r)])
                with self.assertRaises(ToolRefusal) as caught:
                    tools.propose(_proposal(), client=fake, timeout_ms=500)
                self.assertEqual(caught.exception.reason_code, reason)
                self.assertIsNone(caught.exception.core_seq)
                self.assertEqual(len(fake.calls), 1)

    def test_wrong_status_refuses(self):
        for status in ("ok", "verified", "timeout", "pending"):
            with self.subTest(status=status):
                sent = _admitted("placeholder")
                sent["status"] = status
                fake = _FakeClient([_reply(sent)])
                with self.assertRaises(ToolValidationError):
                    tools.propose(_proposal(), client=fake, timeout_ms=500)


class WaitVerifyTests(unittest.TestCase):
    def test_verified_first_try_returns_receipt(self):
        fake = _FakeClient([lambda call: _verified(call["request_id"])])
        out = tools.wait_verify("p-1", _expectation(), 500, client=fake)
        self.assertEqual(out["schema"], "action_receipt/v0.1")
        self.assertTrue(out["verified"] is True)
        self.assertEqual(out["verification"]["method"], "pixel")
        self.assertEqual(out["error"], "")
        self.assertEqual(len(fake.calls), 1)
        body, expect, timeout = fake.calls[0]
        self.assertEqual(body["schema"], "mv_tool_call/v0.2")
        self.assertEqual(body["op"], "wait_verify")
        self.assertEqual(body["args"]["proposal_id"], "p-1")
        self.assertLessEqual(body["args"]["timeout_ms"], 500)
        self.assertGreaterEqual(body["args"]["timeout_ms"], 1)
        self.assertEqual(expect, "mv_tool_result/v0.2")

    def test_pending_then_verified_polls_with_fresh_ids(self):
        fake = _FakeClient([
            lambda call: _pending(call["request_id"], retry_after_ms=1),
            lambda call: _pending(call["request_id"], retry_after_ms=1),
            lambda call: _verified(call["request_id"]),
        ])
        out = tools.wait_verify("p-1", _expectation(), 5000, client=fake)
        self.assertTrue(out["verified"] is True)
        self.assertEqual(len(fake.calls), 3)
        ids = [body["request_id"] for body, _, _ in fake.calls]
        self.assertEqual(len(set(ids)), 3)
        for body in ids:
            self.assertIsNotNone(_ID_PATTERN.fullmatch(body))
        timeouts = [timeout for _, _, timeout in fake.calls]
        for timeout in timeouts:
            self.assertIs(type(timeout), int)
            self.assertLessEqual(timeout, 5000)
            self.assertGreaterEqual(timeout, 1)
        self.assertEqual(sorted(timeouts, reverse=True), timeouts)
        for body, _, _ in fake.calls:
            self.assertEqual(body["op"], "wait_verify")
            self.assertEqual(body["args"]["proposal_id"], "p-1")

    def test_timeout_branch_raises_verification_failed(self):
        sent = _timeout_result("placeholder")
        fake = _FakeClient([_reply(sent)])
        with self.assertRaises(VerificationFailed) as caught:
            tools.wait_verify("p-1", _expectation(), 500, client=fake)
        receipt = caught.exception.receipt
        self.assertEqual(receipt["status"], "timeout")
        self.assertIs(receipt["verified"], False)
        self.assertEqual(receipt["proposal_id"], "p-1")
        self.assertEqual(len(fake.calls), 1)

    def test_verification_failed_error_retained(self):
        sent = _error("placeholder", "wait_verify", "VERIFICATION_FAILED")
        fake = _FakeClient([_reply(sent)])
        with self.assertRaises(VerificationFailed) as caught:
            tools.wait_verify("p-1", _expectation(), 500, client=fake)
        self.assertEqual(caught.exception.receipt["code"],
                         "VERIFICATION_FAILED")

    def test_other_error_codes_refuse(self):
        for code in _ERROR_CODES:
            with self.subTest(code=code):
                sent = _error("placeholder", "wait_verify", code)
                fake = _FakeClient([_reply(sent)])
                with self.assertRaises(ToolValidationError):
                    tools.wait_verify("p-1", _expectation(), 500,
                                      client=fake)

    def test_receipt_violations_refuse(self):
        def mutate(**over):
            sent = _verified("placeholder")
            sent["receipt"].update(over)
            return sent

        cases = [
            mutate(verified=False),
            mutate(verified=1),
            mutate(error="boom"),
            mutate(proposal_id="p-2"),
            mutate(method="nope"),
            mutate(schema="action_receipt/v0.2"),
        ]
        no_verification = _verified("placeholder")
        del no_verification["receipt"]["verification"]
        cases.append(no_verification)
        no_frame = _verified("placeholder")
        del no_frame["receipt"]["after_frame"]
        cases.append(no_frame)
        bad_method = _verified("placeholder")
        bad_method["receipt"]["verification"]["method"] = "ocr"
        cases.append(bad_method)
        empty_detail = _verified("placeholder")
        empty_detail["receipt"]["verification"]["detail"] = ""
        cases.append(empty_detail)
        no_focus = _verified("placeholder")
        no_focus["focus_verified"] = 1
        cases.append(no_focus)
        bad_mono = _verified("placeholder")
        bad_mono["input_mono_ns"] = -1
        cases.append(bad_mono)
        bool_mono = _verified("placeholder")
        bool_mono["input_mono_ns"] = True
        cases.append(bool_mono)
        bad_frame_sha = _verified("placeholder")
        bad_frame_sha["frame_sha256"] = "short"
        cases.append(bad_frame_sha)
        for index, sent in enumerate(cases):
            with self.subTest(index=index):
                fake = _FakeClient([_reply(sent)])
                with self.assertRaises(ToolValidationError):
                    tools.wait_verify("p-1", _expectation(), 500,
                                      client=fake)

    def test_wrong_proposal_and_status_refuse(self):
        sent = _pending("placeholder", proposal_id="p-9")
        fake = _FakeClient([_reply(sent)])
        with self.assertRaisesRegex(ToolValidationError,
                                    "uncorrelated proposal_id"):
            tools.wait_verify("p-1", _expectation(), 500, client=fake)
        sent = _timeout_result("placeholder", proposal_id="p-9")
        fake = _FakeClient([_reply(sent)])
        with self.assertRaises(ToolValidationError):
            tools.wait_verify("p-1", _expectation(), 500, client=fake)
        sent = _verified("placeholder")
        sent["status"] = "ok"
        fake = _FakeClient([_reply(sent)])
        with self.assertRaises(ToolValidationError):
            tools.wait_verify("p-1", _expectation(), 500, client=fake)

    def test_all_six_refusals_raise_without_retry(self):
        for reason in _REASONS:
            with self.subTest(reason=reason):
                fake = _FakeClient(
                    [lambda call, r=reason: _refused(call["request_id"],
                                                     "wait_verify", r)])
                with self.assertRaises(ToolRefusal) as caught:
                    tools.wait_verify("p-1", _expectation(), 500,
                                      client=fake)
                self.assertEqual(caught.exception.reason_code, reason)
                self.assertEqual(len(fake.calls), 1)

    def test_bad_inputs_refuse_without_dispatch(self):
        for bad_id in ("", "has space", None, 7):
            with self.subTest(bad_id=bad_id):
                fake = _FakeClient([lambda call: {}])
                with self.assertRaises(ToolValidationError):
                    tools.wait_verify(bad_id, _expectation(), 500,
                                      client=fake)
                self.assertEqual(fake.calls, [])
        for bad in ({"type": "bogus"}, {"type": "text_present"},
                    {"type": "text_present", "text": "", "zzz": 1},
                    "expectation", None, []):
            with self.subTest(bad=bad):
                fake = _FakeClient([lambda call: {}])
                with self.assertRaises(ToolValidationError):
                    tools.wait_verify("p-1", bad, 500, client=fake)
                self.assertEqual(fake.calls, [])
        for bad in (0, -5, 60001, 10 ** 9, True, "500", None):
            with self.subTest(timeout=bad):
                fake = _FakeClient([lambda call: {}])
                with self.assertRaises(ToolValidationError):
                    tools.wait_verify("p-1", _expectation(), bad,
                                      client=fake)
                self.assertEqual(fake.calls, [])

    def test_budget_exhaustion_times_out(self):
        fake = _FakeClient(
            [lambda call: _pending(call["request_id"],
                                   retry_after_ms=1)])
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            tools.wait_verify("p-1", _expectation(), 10, client=fake)
        self.assertLess(time.monotonic() - started, 10)
        self.assertGreaterEqual(len(fake.calls), 1)
        ids = [body["request_id"] for body, _, _ in fake.calls]
        self.assertEqual(len(set(ids)), len(ids))

    def test_hostile_retry_after_cannot_stall_past_budget(self):
        fake = _FakeClient(
            [lambda call: _pending(call["request_id"],
                                   retry_after_ms=60000)])
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            tools.wait_verify("p-1", _expectation(), 10, client=fake)
        self.assertLess(time.monotonic() - started, 5)

    def test_client_timeout_propagates_without_poll(self):
        boom = TimeoutError("transport deadline")
        fake = _FakeClient([lambda call: boom])
        with self.assertRaises(TimeoutError) as caught:
            tools.wait_verify("p-1", _expectation(), 500, client=fake)
        self.assertIs(caught.exception, boom)
        self.assertEqual(len(fake.calls), 1)


class RequestIdTests(unittest.TestCase):
    def test_ids_unique_and_well_formed_across_verbs(self):
        seen = []

        def handler(call):
            seen.append(call["request_id"])
            op = call["op"]
            if op == "observe":
                return _ok_observe(call["request_id"])
            if op == "list":
                return _ok_list(call["request_id"])
            if op == "propose":
                return _admitted(call["request_id"])
            return _verified(call["request_id"])

        fake = _FakeClient([handler])
        tools.observe("surf-1", client=fake, timeout_ms=500)
        tools.list_surfaces(cursor=None, limit=5, client=fake,
                            timeout_ms=500)
        tools.propose(_proposal(), client=fake, timeout_ms=500)
        tools.wait_verify("p-1", _expectation(), 500, client=fake)
        self.assertEqual(len(seen), 4)
        self.assertEqual(len(set(seen)), 4)
        for request_id in seen:
            self.assertIsNotNone(_ID_PATTERN.fullmatch(request_id))
            self.assertLessEqual(len(request_id), 128)


class _AlwaysAccept:
    """Mutant double: claims success without validating anything."""

    def observe(self, surface_id, *, client, timeout_ms):
        return {"schema": "observation/v0.1", "admitted": True}

    def list_surfaces(self, *, cursor, limit, client, timeout_ms):
        return {"surfaces": [], "next_cursor": None}

    def propose(self, proposal, *, client, timeout_ms):
        return {"decision": "admitted"}

    def wait_verify(self, proposal_id, expectation, timeout_ms, *, client):
        return {"verified": True}


def _mutant_suite(layer):
    class MutantContrast(unittest.TestCase):
        def test_refused_must_raise(self):
            fake = _FakeClient(
                [lambda call: _refused(call["request_id"], "propose",
                                       "POLICY")])
            with self.assertRaises(ToolRefusal):
                layer.propose(_proposal(), client=fake, timeout_ms=500)

        def test_unknown_version_must_raise(self):
            sent = _ok_observe("placeholder")
            sent["schema"] = "mv_tool_result/v9.9"
            fake = _FakeClient([_reply(sent)])
            with self.assertRaises(ToolValidationError):
                layer.observe("surf-1", client=fake, timeout_ms=500)

        def test_unverified_must_raise(self):
            sent = _timeout_result("placeholder")
            fake = _FakeClient([_reply(sent)])
            with self.assertRaises(VerificationFailed):
                layer.wait_verify("p-1", _expectation(), 500, client=fake)

        def test_miscorrelated_must_raise(self):
            sent = _admitted("placeholder")
            sent["verdict"]["proposal_id"] = "p-other"
            fake = _FakeClient([_reply(sent)])
            with self.assertRaises(ToolValidationError):
                layer.propose(_proposal(), client=fake, timeout_ms=500)

    return unittest.TestLoader().loadTestsFromTestCase(MutantContrast)


class AntiVacuityTests(unittest.TestCase):
    def test_always_accept_mutant_fails_contrast_suite(self):
        stream = io.StringIO()
        prog = runner.TextTestRunner(stream=stream, verbosity=0)
        result = prog.run(_mutant_suite(_AlwaysAccept()))
        self.assertEqual(result.testsRun, 4)
        self.assertFalse(result.wasSuccessful(),
                         "contrast suite passed an always-accept mutant")

    def test_real_layer_passes_contrast_suite(self):
        stream = io.StringIO()
        prog = runner.TextTestRunner(stream=stream, verbosity=0)
        result = prog.run(_mutant_suite(tools))
        self.assertTrue(result.wasSuccessful(), stream.getvalue())


class TestMalformedDomainInputs(unittest.TestCase):
    def test_unhashable_action_and_expectation_discriminators(self):
        for value in ([], {}, None):
            with self.subTest(value=value):
                with self.assertRaises(ToolValidationError):
                    tools._check_action({"type": value})
                with self.assertRaises(ToolValidationError):
                    tools._check_expectation({"type": value})

    def test_unhashable_refusal_and_error_codes(self):
        for status, field, check in (("refused", "reason_code", tools._raise_refused),
                                      ("error", "code", tools._raise_error)):
            for value in ([], {}, None):
                result = {"schema": "mv_tool_result/v0.2", "request_id": "r1",
                          "op": "observe", "status": status, field: value, "detail": ""}
                with self.subTest(status=status, value=value):
                    with self.assertRaises(ToolValidationError):
                        check(result)

    def test_frame_escape_in_tool_observation_refused(self):
        good = {"schema": "observation/v0.1", "frame_ref": _frame(), "vision": _vision()}
        tools._check_observation(good)
        good["vision"]["elements"][0]["bbox"]["x"] = 8
        with self.assertRaises(ToolValidationError):
            tools._check_observation(good)

    def test_huge_confidence_is_validation_failure(self):
        with self.assertRaises(ToolValidationError):
            tools._check_number(10 ** 1000, minimum=0, maximum=1, what="confidence")


if __name__ == "__main__":
    unittest.main()
