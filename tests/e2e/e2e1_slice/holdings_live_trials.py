#!/usr/bin/env python3
"""AC05-H4: opt-in Holdings trials attached to an operator-owned READY stack.

[TARGET, unit decision] Reuse AttachedLiveStackSession's authenticated agent
handoff, one connection across trials, and the shipped plan_holdings_step.
The core's existing verify::canonical_state checks STATE sidecar bytes and
digests for every state_sha256_change; no local synthetic witness is accepted.
Provisioning Godot/T2, UI-tree validation and engine/Xfb comparison belong to
the operator's fixture bringup, not this attach-only driver. No stack is started
or stopped here. A browser-only READY stack fails Holdings observation preflight.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT / "agents") not in sys.path:
    sys.path.insert(0, str(ROOT / "agents"))

from metaviewer_agents import loop_trials, tools  # noqa: E402
from metaviewer_agents.planner import plan_holdings_step  # noqa: E402


def _runtime():
    # Lazy: even importing the live tooling is behind the explicit opt-in.
    import stack
    from demo_agent_drive import AttachedLiveStackSession

    return stack, AttachedLiveStackSession


def main(argv=None, *, stdout=None, stderr=None):
    out = sys.stdout if stdout is None else stdout
    err = sys.stderr if stderr is None else stderr
    if os.environ.get("MV_LIVE_HOLDINGS") != "1":
        print("BLOCKED HOLDINGS_OPT_IN: MV_LIVE_HOLDINGS=1 required", file=err)
        return 2
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--trials", type=int, default=loop_trials.DEFAULT_TRIALS)
    parser.add_argument("--min-verified", type=int, default=loop_trials.DEFAULT_MIN_VERIFIED)
    parser.add_argument("--timeout-ms", type=int, default=60000)
    parser.add_argument("--receipt-out", type=Path, required=True)
    args = parser.parse_args(argv)

    stage = "HOLDINGS_ARGUMENTS"
    try:
        loop_trials._check_ratio_bounds(args.trials, args.min_verified, args.timeout_ms)
        # run_loop otherwise lets these settings override the injected planner.
        if "MV_WENDER_PLANNER_CMD" in os.environ or os.environ.get("MV_WENDER_ROOT"):
            raise ValueError("unset MV_WENDER_PLANNER_CMD and MV_WENDER_ROOT for the Holdings planner")
        stage = "HOLDINGS_STACK_NOT_READY"
        stack, session_type = _runtime()
        root = stack.state_root()
        state = stack.load_state(root)
        if state.get("status") != "ready" or not stack.alive(state.get("supervisor", {})):
            raise ValueError("a READY live supervisor is required")
        if state.get("agent_handoff") is not None:
            raise ValueError("agent already handed off; use a fresh operator-owned stack")
        stage = "HOLDINGS_LIVE_CLIENT"
        session = session_type(root)
        # MUT-SCRIPTED-DEFAULT: reject doubles before entering or sending input.
        if type(session) is not session_type:
            raise ValueError("only AttachedLiveStackSession is admitted")
        with session as client:
            if client is not session:
                raise ValueError("live context replaced its client")
            stage = "HOLDINGS_STATE_PREFLIGHT"
            observation = tools.observe(client.surface_id, client=client, timeout_ms=args.timeout_ms)
            # Validates holdings_lane ground truth and frame binding before input.
            plan_holdings_step(observation)

            def client_factory(trial, kind):
                if kind != "holdings" or type(client) is not session_type:
                    raise ValueError("scripted or non-Holdings client refused")
                return client

            stage = "HOLDINGS_TRIALS"
            report = loop_trials.run_holdings_trials(
                client_factory=client_factory,
                planner=plan_holdings_step,
                surface_id=client.surface_id,
                trials=args.trials,
                min_verified=args.min_verified,
                timeout_ms=args.timeout_ms,
            )
        stage = "HOLDINGS_RECEIPT"
        loop_trials.validate_report(report, trials=args.trials,
                                    min_verified=args.min_verified, kind="holdings")
        encoded = loop_trials.canonical_json(report) + "\n"
        args.receipt_out.write_text(encoded, encoding="utf-8")
    except Exception as exc:
        print(f"BLOCKED {stage}: {exc}", file=err)
        return 2
    print(encoded, end="", file=out)
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
