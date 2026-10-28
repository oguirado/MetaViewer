#!/usr/bin/env python3
"""Mutant-injection harness script (SW-0065 contrast table).

Injects 8 distinct mutants into metaviewer_agents, runs the full unit test
suite against each mutant, and outputs the contrast verdict (conforming vs
dead oracle).
"""

import inspect
import json
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agents"))

import metaviewer_agents.client as client_mod
import metaviewer_agents.envelope as envelope_mod
import metaviewer_agents.mcp_server as mcp_mod
import metaviewer_agents.mvctl as mvctl_mod
import metaviewer_agents.observe as observe_mod
from metaviewer_agents.perception import base as perception_base_mod

EXPECTED_MUTANT_COUNT = 8
_MUTANT_SUITE_MODULES = (
    "test_mvctl",
    "test_mvctl_matrix",
    "test_client",
    "test_nesting",
    "test_observe",
    "test_boundary_sweep",
    "test_mcp_server",
    "test_mcp_conformance",
    "test_round1_regressions",
)


def _run_suite_detailed(test_modules: tuple[str, ...] | None = _MUTANT_SUITE_MODULES) -> dict:
    """Run unit tests under agents/tests/ and return separated failures and errors."""
    saved_registry = dict(getattr(perception_base_mod, "_REGISTRY", {}))
    tests_dir = str(ROOT / "agents" / "tests")
    added_path = False
    if tests_dir not in sys.path:
        sys.path.insert(0, tests_dir)
        added_path = True
    try:
        loader = unittest.TestLoader()
        if test_modules is None:
            suite = loader.discover(tests_dir)
        else:
            suite = unittest.TestSuite()
            for mod_name in test_modules:
                suite.addTests(loader.loadTestsFromName(mod_name))
        with open(os.devnull, "w", encoding="utf-8") as devnull:
            runner = unittest.TextTestRunner(stream=devnull, verbosity=0)
            result = runner.run(suite)
        return {
            "tests_run": result.testsRun,
            "failures": [test.id() for test, _ in result.failures],
            "errors": [test.id() for test, _ in result.errors],
        }
    finally:
        if added_path and tests_dir in sys.path:
            sys.path.remove(tests_dir)
        if hasattr(perception_base_mod, "_REGISTRY"):
            perception_base_mod._REGISTRY.clear()
            perception_base_mod._REGISTRY.update(saved_registry)


def _run_suite() -> tuple[int, int]:
    """Run all unit tests under agents/tests/ and return (failures, errors)."""
    summary = _run_suite_detailed()
    return len(summary["failures"]), len(summary["errors"])


def _unpack_suite_counts(outcome) -> tuple[int, int]:
    if isinstance(outcome, tuple):
        return int(outcome[0]), int(outcome[1])
    return int(outcome), 0


_DEFAULT_RUN_SUITE = _run_suite


def _patch_all_modules(attr_name, new_val):
    old_vals = {}
    for modname, mod in list(sys.modules.items()):
        if mod and hasattr(mod, attr_name):
            old_vals[modname] = getattr(mod, attr_name)
            try:
                setattr(mod, attr_name, new_val)
            except Exception:
                pass
    def restore():
        for modname, old_val in old_vals.items():
            mod = sys.modules.get(modname)
            if mod:
                try:
                    setattr(mod, attr_name, old_val)
                except Exception:
                    pass
    return restore


# Mutant definitions
def _apply_mutant_1():
    # Drop rail check in mvctl._positive_int
    orig = mvctl_mod._positive_int
    mvctl_mod._positive_int = lambda text: int(text)
    def restore():
        mvctl_mod._positive_int = orig
    return restore


def _apply_mutant_2():
    # Accept extra key in envelope.py without breaking valid envelopes
    orig_validate = envelope_mod.validate_envelope
    def bad_validate(value):
        if (isinstance(value, dict)
                and set(value) >= envelope_mod._OUTER_KEYS
                and len(value) > len(envelope_mod._OUTER_KEYS)):
            stripped = {k: value[k] for k in envelope_mod._OUTER_KEYS}
            orig_validate(stripped)
            return value
        return orig_validate(value)
    return _patch_all_modules("validate_envelope", bad_validate)


def _apply_mutant_3():
    # Echo input in error in mvctl._refuse
    orig = mvctl_mod._refuse
    def bad_refuse(code):
        record = {"verdict": "refuse", "code": code, "error": code + "_echoed_input_details"}
        print(json.dumps(record, separators=(",", ":"), allow_nan=False), file=sys.stderr)
    mvctl_mod._refuse = bad_refuse
    def restore():
        mvctl_mod._refuse = orig
    return restore


def _apply_mutant_4():
    # Skip terminal transition in client.py
    orig = client_mod.CoreClient._terminate
    def bad_terminate(self):
        client_mod._silent_close(self._sock)
        self._sock = None
        # self._terminal = True  <-- OMITTED
        self._rx.clear()
    client_mod.CoreClient._terminate = bad_terminate
    def restore():
        client_mod.CoreClient._terminate = orig
    return restore


def _apply_mutant_5():
    # Allow depth 33 in envelope.py
    orig_loads = envelope_mod.loads_envelope
    def bad_loads(line, *, max_bytes):
        if not isinstance(line, bytes):
            raise envelope_mod.EnvelopeError("bad_shape", "frame is not bytes")
        envelope_mod._check_cap(max_bytes)
        if len(line) > max_bytes:
            raise envelope_mod.EnvelopeError("length", "frame exceeds byte cap")
        if not line.endswith(b"\n"):
            raise envelope_mod.EnvelopeError("bad_shape", "frame lacks its terminator")
        payload = line[:-1]
        if payload.endswith(b"\r"):
            payload = payload[:-1]
        if not payload:
            raise envelope_mod.EnvelopeError("bad_shape", "frame is blank")
        if b"\n" in payload or b"\r" in payload:
            raise envelope_mod.EnvelopeError("bad_shape", "frame spans more than one line")
        try:
            text = payload.decode("utf-8")
        except UnicodeDecodeError:
            raise envelope_mod.EnvelopeError("bad_shape", "frame is not valid UTF-8")
        depth = 0
        in_string = False
        escaped = False
        for char in text:
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
            elif char == '"':
                in_string = True
            elif char in "[{":
                depth += 1
                if depth > 33: # MUTANT: depth > 33 instead of 32
                    raise envelope_mod.EnvelopeError("bad_shape", "frame exceeds JSON nesting cap")
            elif char in "]}":
                depth -= 1
                if depth < 0:
                    raise envelope_mod.EnvelopeError("bad_shape", "frame has unmatched container")
        try:
            value = envelope_mod.json.loads(text,
                               object_pairs_hook=envelope_mod._reject_duplicate_keys,
                               parse_constant=envelope_mod._reject_constant)
        except (ValueError, RecursionError):
            raise envelope_mod.EnvelopeError("bad_shape", "frame is not valid JSON")
        return envelope_mod.validate_envelope(value)

    return _patch_all_modules("loads_envelope", bad_loads)


def _apply_mutant_6():
    # Accept bool as int in observe._check_int
    orig = observe_mod._check_int
    def bad_check_int(value, *, minimum, name):
        if not isinstance(value, int):
            observe_mod._fail("bad_shape", "%s is not an integer" % name)
        if value < minimum:
            observe_mod._fail("bad_shape", "%s below minimum" % name)
        return value
    observe_mod._check_int = bad_check_int
    def restore():
        observe_mod._check_int = orig
    return restore


def _apply_mutant_7():
    # Skip peer check in client._check_peer
    orig = client_mod.CoreClient._check_peer
    client_mod.CoreClient._check_peer = lambda self, sock: None
    def restore():
        client_mod.CoreClient._check_peer = orig
    return restore


def _apply_mutant_8():
    # Keep serving after a framing failure in mcp_server.serve
    orig_serve = mcp_mod.serve
    async def bad_serve(*, client):
        server = mcp_mod.create_server(client=client)
        reader = sys.stdin.buffer
        writer = sys.stdout.buffer
        while True:
            raw = await mcp_mod.asyncio.to_thread(reader.readline, mcp_mod.MAX_FRAME_BYTES + 1)
            if not raw:
                return
            if len(raw) > mcp_mod.MAX_FRAME_BYTES or not raw.endswith(b"\n"):
                response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Invalid frame"}}
            else:
                try:
                    message = mcp_mod._decode_frame(raw.decode("utf-8"))
                except Exception:
                    response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
                else:
                    pending = server.handle(message)
                    response = await pending if inspect.isawaitable(pending) else None
                    if not isinstance(response, dict):
                        response = None
            if response is not None:
                try:
                    output = mcp_mod.json.dumps(
                        response, separators=(",", ":"), allow_nan=False
                    ).encode("utf-8")
                except (ValueError, TypeError, OverflowError, RecursionError):
                    output = b""
                if not output or len(output) + 1 > mcp_mod.MAX_FRAME_BYTES:
                    ident = response.get("id")
                    if not mcp_mod._bounded_id(ident):
                        ident = None
                    output = mcp_mod.json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": ident,
                            "error": {"code": -32603, "message": "Response too large"},
                        },
                        separators=(",", ":"),
                    ).encode("utf-8")
                if len(output) + 1 > mcp_mod.MAX_FRAME_BYTES:
                    output = (
                        b'{"jsonrpc":"2.0","id":null,'
                        b'"error":{"code":-32603,"message":"Response too large"}}'
                    )
                if len(output) + 1 > mcp_mod.MAX_FRAME_BYTES:
                    return
                writer.write(output + b"\n")
                writer.flush()
            # MUTANT: Omitted `if len(raw) > MAX_FRAME_BYTES or not raw.endswith(b"\n"): return`
    return _patch_all_modules("serve", bad_serve)


MUTANTS = [
    (
        "M1: Drop rail check in _positive_int",
        _apply_mutant_1,
        ("test_mvctl.MvctlTests.test_transport_parameters",),
    ),
    (
        "M2: Accept extra key in envelope outer keys",
        _apply_mutant_2,
        ("test_client.ClientTests.test_closed_keys",),
    ),
    (
        "M3: Echo input in error stderr",
        _apply_mutant_3,
        ("test_mvctl_matrix.MvctlMatrixTests.test_no_caller_input_echoed_to_stderr",),
    ),
    (
        "M4: Skip terminal transition in CoreClient",
        _apply_mutant_4,
        ("test_client.ClientTests.test_inbound_oversize_closes_without_parse",),
    ),
    (
        "M5: Allow container depth 33 in loads_envelope",
        _apply_mutant_5,
        ("test_nesting.NestingTests.test_over_depth_refused_before_json_parser",),
    ),
    (
        "M6: Accept bool as int in observe._check_int",
        _apply_mutant_6,
        ("test_observe.ObservationValidationTests.test_bbox_integer_slots_reject_bool_and_float",),
    ),
    (
        "M7: Skip peer check in CoreClient._check_peer",
        _apply_mutant_7,
        ("test_client.ClientTests.test_foreign_peer_uid_refused_before_first_write",),
    ),
    (
        "M8: Keep serving after framing failure in MCP serve",
        _apply_mutant_8,
        ("test_mcp_server.TestWireDefense.test_framing_failure_closes_instead_of_processing_tail",),
    ),
]


def _matches_killer(failure_ids: list[str], expected_killer: str) -> bool:
    for fid in failure_ids:
        base_id = fid.split(" (", 1)[0]
        if base_id == expected_killer or base_id.endswith("." + expected_killer):
            return True
    return False


def evaluate_mutants(mutants=None, suite_runner=None) -> tuple[int, list[tuple]]:
    """Evaluate a mutant cohort with baseline, error, and killer attribution checks."""
    cohort = MUTANTS if mutants is None else mutants
    custom_int_runner = suite_runner is None and _run_suite is not _DEFAULT_RUN_SUITE
    run_detailed = (_run_suite if custom_int_runner else _run_suite_detailed) if suite_runner is None else suite_runner

    print("=== SW-0065 Mutant Injection Matrix ===")
    min_cohort = 1 if custom_int_runner else EXPECTED_MUTANT_COUNT
    if not isinstance(cohort, (list, tuple)) or len(cohort) < min_cohort:
        print(
            f"ERROR: Mutant cohort size {len(cohort) if isinstance(cohort, (list, tuple)) else 0} "
            f"is below required minimum {min_cohort}!"
        )
        return 1, []

    print("Ground truth baseline check...")
    try:
        baseline = run_detailed()
    except Exception as exc:
        print(f"ERROR: Ground truth execution raised error: {exc}")
        return 1, []
    if isinstance(baseline, (int, tuple)):
        baseline_fails, baseline_errors = _unpack_suite_counts(baseline)
        tests_run = 1
    else:
        baseline_fails = len(baseline.get("failures", ()))
        baseline_errors = len(baseline.get("errors", ()))
        tests_run = int(baseline.get("tests_run", 0))
    print(f"Ground truth test failures: {baseline_fails}, errors: {baseline_errors}")
    if baseline_fails != 0 or baseline_errors != 0 or tests_run <= 0:
        print("ERROR: Ground truth fails before mutation! Aborting.")
        return 1, []

    results = []
    for entry in cohort:
        if not isinstance(entry, (list, tuple)) or len(entry) < 2:
            name = entry[0] if isinstance(entry, (list, tuple)) and entry else "<invalid>"
            results.append((name, 0, 0, "unattributed"))
            continue
        name, applier = entry[0], entry[1]
        expected_killers = entry[2] if len(entry) >= 3 else None
        if not custom_int_runner and (
            not isinstance(expected_killers, (list, tuple, set, frozenset))
            or not expected_killers
            or any(not isinstance(k, str) or not k for k in expected_killers)
        ):
            results.append((name, 0, 0, "unattributed"))
            continue
        restore = None
        try:
            restore = applier()
            summary = run_detailed()
        except Exception:
            results.append((name, 0, 1, "error"))
            continue
        finally:
            if callable(restore):
                restore()
        if isinstance(summary, (int, tuple)):
            fails_count, errs_count = _unpack_suite_counts(summary)
            if errs_count > 0:
                class_str = "error"
            elif fails_count > 0:
                class_str = "conforming"
            else:
                class_str = "dead oracle"
            results.append((name, fails_count, errs_count, class_str))
            continue
        failures = list(summary.get("failures", ()))
        errors = list(summary.get("errors", ()))
        if errors:
            class_str = "error"
        elif not failures:
            class_str = "dead oracle"
        elif not all(_matches_killer(failures, killer) for killer in expected_killers):
            class_str = "unattributed kill"
        else:
            class_str = "conforming"
        results.append((name, len(failures), len(errors), class_str))

    print("\n| ID | Mutant Description | Fails (contrast_rc) | Errors | Class |")
    print("|---|---|---|---|---|")
    for idx, (name, fails, errs, cls) in enumerate(results, 1):
        print(f"| M{idx} | {name} | {fails} | {errs} | {cls} |")

    non_conforming = [r for r in results if r[3] != "conforming"]
    if non_conforming:
        print(f"\nWARNING: Found {len(non_conforming)} non-conforming mutants!")
        return 1, results
    print("\nSUCCESS: All mutants turned the suite red (contrast_rc > 0, errors == 0) with expected killer attribution. Oracle is 100% conforming.")
    return 0, results


def main():
    rc, _ = evaluate_mutants()
    if rc != 0:
        sys.exit(rc)


if __name__ == "__main__":
    main()
