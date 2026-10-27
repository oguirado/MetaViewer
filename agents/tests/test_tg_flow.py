"""U-AG-05b / U3-AG-03 / U3-AG-04: existing lifecycle and workflow seams.

There is no sequence/serve API on AdmittedExecutor. Pin its single-dispatch
contract, including refusal after an earlier admission. Local perception can be
injected through run_loop's existing planner; final verification stays with core
(verify.run_loop and perception/base.py). This does not claim a live executor.
"""
import copy
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_ailoop as loop_fixture
import test_tools as fixture
from metaviewer_agents import tools
from metaviewer_agents.executor import AdmittedExecutor, SurfaceRefused
from metaviewer_agents.perception.base import FakePerceptionAdapter, Frame
from metaviewer_agents.verify import run_loop


class FlowGapTests(unittest.TestCase):
    def test_destroyed_surface_survives_two_lists_without_aliasing(self):
        # Mutation: list_surfaces returns body instead of copy.deepcopy(body).
        destroyed = fixture._surface(state="destroyed")
        page = fixture._ok_list("unused", [destroyed])
        client = fixture._FakeClient([fixture._reply(page), fixture._reply(page)])
        first = tools.list_surfaces(cursor=None, limit=10, client=client, timeout_ms=100)
        self.assertEqual(first["surfaces"][0]["state"], "destroyed")
        first["surfaces"][0]["state"] = "active"
        second = tools.list_surfaces(cursor=None, limit=10, client=client, timeout_ms=100)
        self.assertEqual(second["surfaces"], [fixture._surface(state="destroyed")])
        self.assertEqual(destroyed["state"], "destroyed")
        self.assertEqual([call[0]["op"] for call in client.calls], ["list", "list"])

    def test_malformed_entry_refuses_whole_page_after_valid_destroyed_entry(self):
        # Mutation: validate surfaces[:1] instead of surfaces in list_surfaces.
        destroyed = fixture._surface(state="destroyed")
        client = fixture._FakeClient([
            lambda call: fixture._ok_list(call["request_id"], [destroyed]),
            lambda call: fixture._ok_list(call["request_id"], [
                destroyed, fixture._surface(surface_id="bad", state="resurrected")])])
        first = tools.list_surfaces(cursor=None, limit=10, client=client, timeout_ms=100)
        with self.assertRaises(tools.ToolValidationError):
            tools.list_surfaces(cursor=None, limit=10, client=client, timeout_ms=100)
        self.assertEqual(first["surfaces"], [destroyed])
        self.assertEqual(len(client.calls), 2)

    def test_executor_freezes_proposal_and_strips_transport_verification(self):
        # Mutation: proposal = copy.deepcopy(_check_proposal(proposal)) -> no copy.
        proposal = loop_fixture.proposal()
        original = copy.deepcopy(proposal)

        def transport(frozen):
            frozen["action"]["x"] = 3
            return {"focus_verified": True, "input_mono_ns": 9,
                    "verified": True, "receipt": {"verified": True}}

        executor = AdmittedExecutor(transport=transport)
        result = executor.dispatch(proposal, {
            "schema": "action_verdict/v0.2", "proposal_id": "p1",
            "decision": "admitted", "core_seq": 1})
        self.assertEqual(proposal, original)
        self.assertEqual(result, {"focus_verified": True, "input_mono_ns": 9})

    def test_executor_refusal_and_binding_stop_transport_after_prior_admission(self):
        # Mutation: disable executor.dispatch's verdict/proposal binding branch.
        transport = Mock(return_value={"focus_verified": True, "input_mono_ns": 9})
        executor = AdmittedExecutor(transport=transport)
        admitted = {"schema": "action_verdict/v0.2", "proposal_id": "p1",
                    "decision": "admitted", "core_seq": 1}
        executor.dispatch(loop_fixture.proposal(), admitted)
        refused = dict(admitted, decision="refused",
                       reason_code="SURFACE_NOT_AGENT_CONTROLLED", detail="human takeover")
        with self.assertRaises(tools.ToolValidationError):
            executor.dispatch(loop_fixture.proposal(), refused)
        self.assertEqual(transport.call_count, 1)
        with self.assertRaises(SurfaceRefused) as caught:
            executor.dispatch(loop_fixture.proposal(), dict(admitted, proposal_id="other"))
        self.assertEqual(caught.exception.code, "POLICY")
        self.assertEqual(transport.call_count, 1)

    def client(self, *, refusal=None, forged=False):
        def propose(call):
            if refusal:
                return fixture._refused(call["request_id"], "propose", refusal)
            return fixture._admitted(call["request_id"])

        return fixture._FakeClient([
            lambda call: fixture._ok_observe(call["request_id"], observation={
                "schema": "observation/v0.2", "frame_ref": fixture._frame()}),
            propose,
            lambda call: fixture._verified(call["request_id"], receipt=fixture._receipt(
                verified=not forged))])

    def loop(self, client):
        adapter = FakePerceptionAdapter()
        observations = []

        def planner(observation):
            frame = observation["frame_ref"]
            observation["vision"] = adapter.perceive(frame, Frame(8, 8, bytes(192)))
            observations.append(copy.deepcopy(observation))
            return fixture._proposal()["action"], fixture._proposal()["expectation"]

        result = run_loop(client=client, surface_id="surf-1", proposal_id="p-1",
                          planner=planner, timeout_ms=500)
        return result, observations

    def test_local_perception_planner_submits_bound_frame_then_core_receipt(self):
        # Mutation: build_proposal uses generation + 1 instead of generation.
        client = self.client()
        result, observations = self.loop(client)
        self.assertEqual(result, fixture._receipt())
        self.assertEqual([call[0]["op"] for call in client.calls], ["observe", "propose", "wait_verify"])
        self.assertEqual(observations[0]["vision"], {
            "summary": "fake perception: no change", "changed_regions": [], "elements": []})
        proposal = client.calls[1][0]["args"]["proposal"]
        self.assertEqual(proposal["based_on_frame"], {
            "sha256": fixture._frame()["sha256"], "generation": fixture._frame()["generation"]})
        self.assertEqual(proposal["surface_id"], "surf-1")

    def test_local_perception_cannot_override_core_refusal_or_forge_success(self):
        # Mutation: run_loop returns {'verified': True} immediately after planning.
        for reason in ("SURFACE_NOT_AGENT_CONTROLLED", "STALE_FRAME"):
            with self.subTest(reason=reason):
                client = self.client(refusal=reason)
                with self.assertRaises(tools.ToolRefusal) as caught:
                    self.loop(client)
                self.assertEqual(caught.exception.reason_code, reason)
                self.assertEqual([call[0]["op"] for call in client.calls], ["observe", "propose"])
        forged = self.client(forged=True)
        with self.assertRaises(tools.ToolValidationError):
            self.loop(forged)
        self.assertEqual([call[0]["op"] for call in forged.calls], ["observe", "propose", "wait_verify"])


if __name__ == "__main__":
    unittest.main()
