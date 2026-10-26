"""Closed-validator boundary sweep across tools.py, mcp_server.py, observe.py (SW-0143 total functions)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from metaviewer_agents.mcp_server import (
    _check_id,
    _check_timeout_ms,
    _validate_list,
    _validate_observe,
    _InvalidArgs,
)
from metaviewer_agents.observe import (
    ObservationError,
    _check_confidence,
    _check_int,
    validate_observation,
)
from metaviewer_agents.tools import (
    ToolValidationError,
    _check_exact,
    _check_number,
    _check_proposal,
)


class BoundarySweepTests(unittest.TestCase):
    def test_timeout_ms_rail_boundaries(self):
        # timeout_ms in mcp_server: 1..60000
        # Valid boundaries
        self.assertEqual(_check_timeout_ms(1), 1)
        self.assertEqual(_check_timeout_ms(60000), 60000)

        # Off-rail boundaries
        for bad in (0, -1, 60001, True, False, 1.5, "100", None):
            with self.subTest(bad=bad):
                with self.assertRaises(_InvalidArgs):
                    _check_timeout_ms(bad)

    def test_limit_rail_boundaries(self):
        # limit in mcp_server: 1..256
        valid_args_min = {"cursor": None, "limit": 1, "timeout_ms": 100}
        valid_args_max = {"cursor": None, "limit": 256, "timeout_ms": 100}
        self.assertEqual(_validate_list(valid_args_min)["limit"], 1)
        self.assertEqual(_validate_list(valid_args_max)["limit"], 256)

        for bad in (0, -1, 257, True, False, "10", 10.5, None):
            with self.subTest(bad=bad):
                with self.assertRaises(_InvalidArgs):
                    _validate_list({"cursor": None, "limit": bad, "timeout_ms": 100})

    def test_id_length_and_shape_boundaries(self):
        # _check_id: min length 1, max length 128, pattern ^[A-Za-z0-9][A-Za-z0-9._:-]*$
        self.assertEqual(_check_id("a"), "a")
        self.assertEqual(_check_id("a" * 128), "a" * 128)

        for bad in ("", "a" * 129, "-bad_start", ".bad_start", "bad space", "bad!", None, 123, True):
            with self.subTest(bad=bad):
                with self.assertRaises(_InvalidArgs):
                    _check_id(bad)

    def test_bool_as_int_rejection(self):
        # observe._check_int: type(x) is int check
        self.assertEqual(_check_int(0, minimum=0, name="test"), 0)
        self.assertEqual(_check_int(10, minimum=0, name="test"), 10)

        for bad in (True, False, 1.0, "5", None):
            with self.subTest(bad=bad):
                with self.assertRaises(ObservationError) as caught:
                    _check_int(bad, minimum=0, name="test")
                self.assertEqual(caught.exception.code, "bad_shape")

    def test_nan_out_of_range_floats_rejection(self):
        # observe._check_confidence
        _check_confidence(0.0)
        _check_confidence(0.5)
        _check_confidence(1.0)
        _check_confidence(1)  # int admits

        for bad in (-0.001, 1.001, float("nan"), float("inf"), float("-inf"), True, False, "0.5"):
            with self.subTest(bad=bad):
                with self.assertRaises(ObservationError) as caught:
                    _check_confidence(bad)
                self.assertEqual(caught.exception.code, "bad_shape")

    def test_tools_check_number(self):
        self.assertEqual(_check_number(0.5, minimum=0.0, maximum=1.0, what="num"), 0.5)
        for bad in (True, False, float("nan"), float("inf"), -0.1, 1.1):
            with self.subTest(bad=bad):
                with self.assertRaises(ToolValidationError):
                    _check_number(bad, minimum=0.0, maximum=1.0, what="num")

    def test_closed_key_validation_no_partial_state(self):
        # _check_exact in tools.py
        data = {"a": 1, "b": 2}
        self.assertEqual(_check_exact(data, frozenset({"a", "b"}), "test"), data)

        # Extra key or missing key must raise ToolValidationError and leave source data unmodified
        data_extra = {"a": 1, "b": 2, "c": 3}
        with self.assertRaises(ToolValidationError):
            _check_exact(data_extra, frozenset({"a", "b"}), "test")
        self.assertEqual(data_extra, {"a": 1, "b": 2, "c": 3})

        data_missing = {"a": 1}
        with self.assertRaises(ToolValidationError):
            _check_exact(data_missing, frozenset({"a", "b"}), "test")
        self.assertEqual(data_missing, {"a": 1})


if __name__ == "__main__":
    unittest.main()
