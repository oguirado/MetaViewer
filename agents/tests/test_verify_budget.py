"""Monotonic deadline budget enforcement tests for tools.wait_verify."""

from __future__ import annotations

import inspect
import io
import math
import sys
import time
import unittest
from pathlib import Path
from unittest import mock, runner

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from metaviewer_agents import tools
from metaviewer_agents.tools import ToolValidationError

_DIGEST = "0123456789abcdef" * 4


def _expectation() -> dict:
    return {
        "type": "changed_region",
        "bbox": {"x": 10, "y": 20, "w": 80, "h": 30},
    }


def _receipt() -> dict:
    return {
        "schema": "action_receipt/v0.2",
        "proposal_id": "p-1",
        "executed_at_ns": 2000000,
        "after_frame": {
            "schema": "frame_ref/v0.2",
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
        },
        "verified": True,
        "verification": {"method": "pixel", "detail": "region changed"},
        "error": "",
    }


def _pending(request_id: str, *, retry_after_ms: int) -> dict:
    return {
        "schema": "mv_tool_result/v0.2",
        "request_id": request_id,
        "op": "wait_verify",
        "status": "pending",
        "proposal_id": "p-1",
        "retry_after_ms": retry_after_ms,
    }


def _verified(request_id: str) -> dict:
    return {
        "schema": "mv_tool_result/v0.2",
        "request_id": request_id,
        "op": "wait_verify",
        "status": "verified",
        "receipt": _receipt(),
        "focus_verified": True,
        "input_mono_ns": 1995000,
        "frame_sha256": _DIGEST,
    }


class FakeClock:
    """Deterministic monotonic fake clock in seconds with zero wall-clock sleep."""

    def __init__(self, start_s: float = 1000.0) -> None:
        self.origin_s = float(start_s)
        self.now_s = float(start_s)
        self.sleeps_ms: list[float] = []

    def __call__(self) -> float:
        return self.now_s

    def advance_ms(self, delta_ms: float) -> None:
        self.now_s = round(self.now_s + delta_ms / 1000.0, 9)

    def sleep(self, seconds: float) -> None:
        delta_ms = seconds * 1000.0
        self.sleeps_ms.append(delta_ms)
        self.advance_ms(delta_ms)

    @property
    def elapsed_ms(self) -> float:
        return round((self.now_s - self.origin_s) * 1000.0, 6)


class FakeVerifyClient:
    """Fake ToolClient returning pending N times then verified while advancing FakeClock."""

    def __init__(
        self,
        *,
        clock: FakeClock,
        budget_ms: int,
        pending_count: int,
        request_cost_ms: int,
        retry_after_ms: int,
    ) -> None:
        self.clock = clock
        self.budget_ms = budget_ms
        self.pending_count = pending_count
        self.request_cost_ms = request_cost_ms
        self.retry_after_ms = retry_after_ms
        self.calls: list[dict] = []

    @property
    def one_poll_ms(self) -> int:
        return self.request_cost_ms + self.retry_after_ms

    def request(self, body: dict, expect: str, *, timeout_ms: int) -> dict:
        dispatch_elapsed_ms = self.clock.elapsed_ms
        remaining_before_call_ms = math.ceil(self.budget_ms - dispatch_elapsed_ms)
        call_index = len(self.calls)
        self.calls.append(
            {
                "index": call_index,
                "dispatch_elapsed_ms": dispatch_elapsed_ms,
                "remaining_before_call_ms": remaining_before_call_ms,
                "timeout_ms": timeout_ms,
                "args_timeout_ms": body["args"]["timeout_ms"],
                "expect": expect,
                "request_id": body["request_id"],
            }
        )
        self.clock.advance_ms(self.request_cost_ms)
        if call_index < self.pending_count:
            return _pending(body["request_id"], retry_after_ms=self.retry_after_ms)
        return _verified(body["request_id"])


class VerifyBudgetTests(unittest.TestCase):
    def test_clock_parameter_defaults_to_time_monotonic_and_rejects_invalid(self) -> None:
        sig = inspect.signature(tools.wait_verify)
        self.assertIn("clock", sig.parameters)
        self.assertIs(sig.parameters["clock"].default, time.monotonic)

        clock = FakeClock()
        client = FakeVerifyClient(
            clock=clock,
            budget_ms=200,
            pending_count=0,
            request_cost_ms=10,
            retry_after_ms=5,
        )
        for bad_clock in (None, 123, "clock", lambda: True, lambda: float("nan"), lambda: float("inf")):
            with self.subTest(bad_clock=bad_clock):
                with self.assertRaises(ToolValidationError):
                    tools.wait_verify(
                        "p-1",
                        _expectation(),
                        200,
                        client=client,
                        clock=bad_clock,
                    )
        self.assertEqual(client.calls, [])

    def test_pending_n_times_then_verified_recomputes_remaining_budget(self) -> None:
        budget_ms = 500
        pending_count = 4
        clock = FakeClock()
        client = FakeVerifyClient(
            clock=clock,
            budget_ms=budget_ms,
            pending_count=pending_count,
            request_cost_ms=75,
            retry_after_ms=25,
        )

        receipt = tools.wait_verify(
            "p-1",
            _expectation(),
            budget_ms,
            client=client,
            clock=clock,
        )

        self.assertTrue(receipt["verified"])
        self.assertEqual(len(client.calls), pending_count + 1)
        expected_timeouts = [500, 400, 300, 200, 100]
        self.assertEqual(
            [record["timeout_ms"] for record in client.calls],
            expected_timeouts,
        )
        for record in client.calls:
            self.assertEqual(record["timeout_ms"], record["args_timeout_ms"])
            self.assertLessEqual(record["timeout_ms"], record["remaining_before_call_ms"])
            self.assertLess(record["dispatch_elapsed_ms"], budget_ms)
        last_call = client.calls[-1]
        self.assertLessEqual(
            last_call["timeout_ms"],
            last_call["remaining_before_call_ms"],
        )
        self.assertLessEqual(clock.elapsed_ms, budget_ms + client.one_poll_ms)

    def test_budget_exhaustion_raises_timeout_and_never_calls_past_deadline(self) -> None:
        # Case 1: in-flight poll crosses the deadline; no post-deadline sleep or call occurs.
        budget_ms = 250
        clock = FakeClock()
        client = FakeVerifyClient(
            clock=clock,
            budget_ms=budget_ms,
            pending_count=6,
            request_cost_ms=60,
            retry_after_ms=20,
        )
        with self.assertRaises(TimeoutError):
            tools.wait_verify(
                "p-1",
                _expectation(),
                budget_ms,
                client=client,
                clock=clock,
            )

        self.assertEqual(len(client.calls), 4)
        self.assertEqual(
            [record["timeout_ms"] for record in client.calls],
            [250, 170, 90, 10],
        )
        for record in client.calls:
            self.assertEqual(record["timeout_ms"], record["args_timeout_ms"])
            self.assertLessEqual(record["timeout_ms"], record["remaining_before_call_ms"])
            self.assertLess(record["dispatch_elapsed_ms"], budget_ms)
        last_call = client.calls[-1]
        self.assertLessEqual(
            last_call["timeout_ms"],
            last_call["remaining_before_call_ms"],
        )
        self.assertLessEqual(clock.elapsed_ms, budget_ms + client.one_poll_ms)

        # Case 2: retry_after_ms reaches the deadline; sleep is clamped and next poll is refused.
        clock2 = FakeClock()
        client2 = FakeVerifyClient(
            clock=clock2,
            budget_ms=200,
            pending_count=5,
            request_cost_ms=60,
            retry_after_ms=50,
        )
        with self.assertRaises(TimeoutError):
            tools.wait_verify(
                "p-1",
                _expectation(),
                200,
                client=client2,
                clock=clock2,
            )

        self.assertEqual(len(client2.calls), 2)
        self.assertEqual(
            [record["timeout_ms"] for record in client2.calls],
            [200, 90],
        )
        self.assertEqual(clock2.sleeps_ms, [50.0, 30.0])
        self.assertEqual(clock2.elapsed_ms, 200.0)
        self.assertLessEqual(clock2.elapsed_ms, 200 + client2.one_poll_ms)


def _frozen_remaining_budget_ms(deadline: float, clock: object, budget_ms: int) -> int:
    """Named mutation: freeze remaining_ms at the initial budget on every poll."""
    del deadline
    tools._read_wait_clock(clock)
    return budget_ms


class VerifyBudgetMutationTests(unittest.TestCase):
    def test_named_mutation_freezing_remaining_at_initial_budget_fails_tests(self) -> None:
        suite = unittest.TestSuite(
            [
                VerifyBudgetTests("test_pending_n_times_then_verified_recomputes_remaining_budget"),
                VerifyBudgetTests("test_budget_exhaustion_raises_timeout_and_never_calls_past_deadline"),
            ]
        )
        stream = io.StringIO()
        with mock.patch.object(
            tools,
            "_remaining_wait_ms",
            side_effect=_frozen_remaining_budget_ms,
        ):
            result = runner.TextTestRunner(stream=stream, verbosity=0).run(suite)

        self.assertEqual(result.testsRun, 2)
        self.assertEqual(len(result.errors), 0, stream.getvalue())
        self.assertEqual(len(result.failures), 2, stream.getvalue())
        self.assertFalse(
            result.wasSuccessful(),
            "Frozen initial budget mutation must fail both budget tests",
        )


if __name__ == "__main__":
    unittest.main()
