"""U-AG-07: compare wire bodies, allowing only fresh request identifiers."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_tools as fixture
from metaviewer_agents import tools


def calls(*, now, x=4):
    client = fixture._FakeClient([
        lambda call: fixture._ok_observe(call["request_id"]),
        lambda call: fixture._ok_list(call["request_id"], [fixture._surface()]),
        lambda call: fixture._admitted(call["request_id"]),
        lambda call: fixture._verified(call["request_id"])])
    proposal = fixture._proposal()
    proposal["action"]["x"] = x
    # Different clock origins must affect neither arguments nor relative budgets.
    # Freeze progression only, so both runs receive the same unspent wait budget.
    with patch("metaviewer_agents.tools.time.monotonic", return_value=now):
        tools.observe("surf-1", client=client, timeout_ms=1000)
        tools.list_surfaces(cursor=None, limit=10, client=client, timeout_ms=1000)
        tools.propose(proposal, client=client, timeout_ms=1000)
        tools.wait_verify("p-1", proposal["expectation"], 1000, client=client)
    return copy.deepcopy([row[0] for row in client.calls])


def stable_bytes(sequence):
    return json.dumps([{key: value for key, value in call.items() if key != "request_id"}
                       for call in sequence], sort_keys=True,
                      separators=(",", ":"), ensure_ascii=False).encode("utf-8")


class DeterminismGapTests(unittest.TestCase):
    def test_identical_sequences_differ_only_in_request_id_across_clock_origins(self):
        # Mutation: _send adds `call['ts_ns'] = time.monotonic_ns()` before request.
        first, second = calls(now=1.0), calls(now=1000000.0)
        self.assertEqual([row["op"] for row in first], ["observe", "list", "propose", "wait_verify"])
        self.assertEqual(stable_bytes(first), stable_bytes(second))
        ids = [row["request_id"] for row in first + second]
        self.assertEqual(len(set(ids)), len(ids))
        # Negative control: an actual action change must survive normalization.
        self.assertNotEqual(stable_bytes(first), stable_bytes(calls(now=1.0, x=3)))

    def test_every_tool_body_is_clock_free_including_nested_arguments(self):
        # Mutation: wait_verify adds `call['args']['ts_ns'] = 0` before request.
        forbidden = {"ts", "ts_ns", "timestamp", "timestamp_ns", "clock", "clock_ns",
                     "mono_ns", "monotonic_ns", "input_mono_ns", "executed_at_ns"}

        def keys(value):
            if isinstance(value, dict):
                return set(value).union(*(keys(child) for child in value.values()))
            if isinstance(value, list):
                return set().union(*(keys(child) for child in value))
            return set()

        for call in calls(now=50.0):
            with self.subTest(op=call["op"]):
                self.assertEqual(set(call), {"schema", "request_id", "op", "args"})
                self.assertEqual(call["schema"], "mv_tool_call/v0.2")
                self.assertFalse(keys(call) & forbidden)
                # Negative control checks the same recursive instrument.
                polluted = copy.deepcopy(call)
                polluted["args"]["ts_ns"] = 1
                self.assertEqual(keys(polluted) & forbidden, {"ts_ns"})


if __name__ == "__main__":
    unittest.main()
