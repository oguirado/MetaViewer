#!/usr/bin/env python3
"""Mutant-injection harness script (SW-0065 contrast table).

Injects 8 distinct mutants into metaviewer_agents, runs the full unit test
suite against each mutant, and outputs the contrast verdict (conforming vs
dead oracle).
"""

import importlib
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
import metaviewer_agents.tools as tools_mod


def _run_suite() -> int:
    """Run all unit tests under agents/tests/ and return the number of failures/errors."""
    loader = unittest.TestLoader()
    suite = loader.discover(str(ROOT / "agents" / "tests"))
    runner = unittest.TextTestRunner(stream=open(os.devnull, "w"), verbosity=0)
    result = runner.run(suite)
    return len(result.failures) + len(result.errors)


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
    # Accept extra key in envelope.py
    orig = envelope_mod._OUTER_KEYS
    envelope_mod._OUTER_KEYS = frozenset(list(orig) + ["extra_key"])
    def restore():
        envelope_mod._OUTER_KEYS = orig
    return restore


def _apply_mutant_3():
    # Echo input in error in mvctl._refuse
    orig = mvctl_mod._refuse
    def bad_refuse(code):
        record = {"verdict": "refuse", "code": code, "error": code + "_echoed_input_details"}
        print(record, file=sys.stderr)
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
    return _patch_all_modules("_check_int", bad_check_int)


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
                    response = await server.handle(message)
            if response is not None:
                output = mcp_mod.json.dumps(response, separators=(",", ":")).encode("utf-8")
                writer.write(output + b"\n")
                writer.flush()
            # MUTANT: Omitted `if len(raw) > MAX_FRAME_BYTES: return` -> loop keeps serving!
    return _patch_all_modules("serve", bad_serve)


MUTANTS = [
    ("M1: Drop rail check in _positive_int", _apply_mutant_1),
    ("M2: Accept extra key in envelope outer keys", _apply_mutant_2),
    ("M3: Echo input in error stderr", _apply_mutant_3),
    ("M4: Skip terminal transition in CoreClient", _apply_mutant_4),
    ("M5: Allow container depth 33 in loads_envelope", _apply_mutant_5),
    ("M6: Accept bool as int in observe._check_int", _apply_mutant_6),
    ("M7: Skip peer check in CoreClient._check_peer", _apply_mutant_7),
    ("M8: Keep serving after framing failure in MCP serve", _apply_mutant_8),
]


def main():
    print("=== SW-0065 Mutant Injection Matrix ===")
    print(f"Ground truth baseline check...")
    baseline_fails = _run_suite()
    print(f"Ground truth test failures: {baseline_fails}")
    if baseline_fails != 0:
        print("ERROR: Ground truth fails before mutation! Aborting.")
        sys.exit(1)

    results = []
    for name, applier in MUTANTS:
        restore = applier()
        fails = _run_suite()
        restore()
        class_str = "conforming" if fails > 0 else "dead oracle"
        results.append((name, fails, class_str))

    print("\n| ID | Mutant Description | Fails (contrast_rc) | Class |")
    print("|---|---|---|---|")
    for idx, (name, fails, cls) in enumerate(results, 1):
        print(f"| M{idx} | {name} | {fails} | {cls} |")

    dead = [r for r in results if r[2] == "dead oracle"]
    if dead:
        print(f"\nWARNING: Found {len(dead)} dead oracles!")
    else:
        print("\nSUCCESS: All mutants turned the suite red (contrast_rc > 0). Oracle is 100% conforming.")


if __name__ == "__main__":
    main()
