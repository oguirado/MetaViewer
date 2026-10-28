"""Multi-trial agent loop runner and ratio adjudication receipt.

[TARGET, unit decision] ``run_trials`` loops the single-shot ``verify.run_loop``
across ``trials`` independent attempts (default 10, minimum verified 9) without
ever retrying a refused or failed proposal inside a trial. Odd trials represent
the Holdings leg and even trials the browser leg. Refusals, verification
failures, and timeouts are recorded as unverified trials with their terminal
codes. Emits one canonical receipt with schema ``metaviewer.ai-loop-report/v1``
and keys ``{schema, trials, verified, pass, results}``. ``validate_report``
re-validates any receipt and rejects tampered ``verified`` counts or ``pass``
flags.
"""

from __future__ import annotations

import argparse
from collections.abc import Callable
import copy
import hashlib
import inspect
import json
import math
from pathlib import Path
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from metaviewer_agents import tools  # noqa: E402
from metaviewer_agents.executor import SurfaceError  # noqa: E402
from metaviewer_agents.observe import (  # noqa: E402
    ObservationError,
    _reject_non_canonical,
)
from metaviewer_agents.verify import run_loop  # noqa: E402

__all__ = [
    "DEFAULT_MIN_VERIFIED",
    "DEFAULT_TRIALS",
    "LoopReportError",
    "REPORT_SCHEMA",
    "TRIAL_KINDS",
    "canonical_json",
    "main",
    "make_scripted_double",
    "recheck_receipt",
    "run_trials",
    "validate_receipt",
    "validate_report",
]

REPORT_SCHEMA = "metaviewer.ai-loop-report/v1"
DEFAULT_TRIALS = 10
DEFAULT_MIN_VERIFIED = 9
TRIAL_KINDS = ("holdings", "browser")

_REPORT_KEYS = frozenset({"schema", "trials", "verified", "pass", "results"})
_RESULT_KEYS = frozenset({"trial", "kind", "proposal_id", "verified", "status", "code"})
_VALID_STATUSES = frozenset({"verified", "refused", "timeout", "unverified"})


class LoopReportError(ObservationError):
    """Typed failure when a loop report or trial configuration is invalid."""

    def __init__(self, code: str, detail: str) -> None:
        self.detail = detail
        super().__init__(code, detail)


def _fail(code: str, detail: str) -> None:
    raise LoopReportError(code, detail)


def canonical_json(value: object) -> str:
    """Serialize value to canonical compact UTF-8 JSON without floats."""
    _reject_non_canonical(value, 0)
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def _trial_kind(trial_number: int) -> str:
    return "holdings" if trial_number % 2 == 1 else "browser"


def _arity(func: Callable) -> int:
    try:
        sig = inspect.signature(func)
    except (ValueError, TypeError):
        return 0
    positional = 0
    for param in sig.parameters.values():
        if param.kind == inspect.Parameter.VAR_POSITIONAL:
            return 3
        if param.kind in (
            inspect.Parameter.POSITIONAL_ONLY,
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
        ):
            positional += 1
    return positional


def _required_arity(func: Callable) -> int:
    try:
        sig = inspect.signature(func)
    except (ValueError, TypeError):
        return 0
    required = 0
    for param in sig.parameters.values():
        if (
            param.kind
            in (
                inspect.Parameter.POSITIONAL_ONLY,
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
            )
            and param.default is inspect.Parameter.empty
        ):
            required += 1
    return required


def _invoke_client_factory(client_factory: Callable, trial: int, kind: str):
    req = _required_arity(client_factory)
    max_pos = _arity(client_factory)
    if req >= 2:
        return client_factory(trial, kind)
    if req == 1:
        return client_factory(trial)
    if max_pos == 0:
        return client_factory()
    try:
        return client_factory()
    except TypeError:
        return client_factory(trial)


def _resolve_surface_id(
    surface_id: str | Callable[[int, str], str] | None,
    client: object,
    trial: int,
    kind: str,
) -> str:
    if callable(surface_id):
        resolved = surface_id(trial, kind)
        if not isinstance(resolved, str) or not resolved:
            raise ValueError("surface_id callable must return a non-empty string")
        return resolved
    if isinstance(surface_id, str):
        if not surface_id:
            raise ValueError("surface_id must be non-empty")
        return surface_id
    client_surface = getattr(client, "surface_id", None)
    if isinstance(client_surface, str) and client_surface:
        return client_surface
    client_frame = getattr(client, "frame", None)
    if isinstance(client_frame, dict) and isinstance(client_frame.get("surface_id"), str):
        return client_frame["surface_id"]
    return "fixture"


def _wrap_planner(planner: Callable, trial: int, kind: str) -> Callable[[dict], tuple]:
    req = _required_arity(planner)

    def _call(observation: dict):
        if req >= 3:
            outcome = planner(observation, trial, kind)
        elif req == 2:
            outcome = planner(observation, trial)
        else:
            outcome = planner(observation)
        if (
            isinstance(outcome, dict)
            and "action" in outcome
            and "expectation" in outcome
        ):
            return outcome["action"], outcome["expectation"]
        return outcome

    return _call


def _check_ratio_bounds(trials: object, min_verified: object, timeout_ms: object) -> None:
    if type(trials) is not int or not 1 <= trials <= 1000:
        raise ValueError("trials must be an integer in 1..1000")
    if type(min_verified) is not int or not 1 <= min_verified <= trials:
        raise ValueError("min_verified must be an integer in 1..trials")
    if type(timeout_ms) is not int or not 1 <= timeout_ms <= 60000:
        raise ValueError("timeout_ms must be an integer in 1..60000")


def run_trials(
    *,
    client_factory: Callable,
    planner: Callable,
    trials: int = DEFAULT_TRIALS,
    min_verified: int = DEFAULT_MIN_VERIFIED,
    timeout_ms: int = 60000,
    surface_id: str | Callable[[int, str], str] | None = None,
    perception_adapter=None,
    goal: str | None = None,
) -> dict:
    """Execute ``trials`` single-shot agent loops and emit a ratio receipt."""
    if not callable(client_factory):
        raise ValueError("client_factory must be callable")
    if not callable(planner):
        raise ValueError("planner must be callable")
    _check_ratio_bounds(trials, min_verified, timeout_ms)

    results: list[dict] = []
    verified_count = 0

    for trial in range(1, trials + 1):
        kind = _trial_kind(trial)
        proposal_id = f"trial-{trial}"
        client = _invoke_client_factory(client_factory, trial, kind)
        trial_surface = _resolve_surface_id(surface_id, client, trial, kind)
        trial_planner = _wrap_planner(planner, trial, kind)

        try:
            receipt = run_loop(
                client=client,
                surface_id=trial_surface,
                proposal_id=proposal_id,
                planner=trial_planner,
                timeout_ms=timeout_ms,
                perception_adapter=perception_adapter,
                goal=goal,
            )
        except tools.ToolRefusal as exc:
            results.append(
                {
                    "trial": trial,
                    "kind": kind,
                    "proposal_id": proposal_id,
                    "verified": False,
                    "status": "refused",
                    "code": exc.reason_code,
                }
            )
            continue
        except tools.VerificationFailed as exc:
            receipt_obj = getattr(exc, "receipt", None)
            is_timeout = (
                isinstance(receipt_obj, dict)
                and receipt_obj.get("status") == "timeout"
            )
            code = (
                "TIMEOUT"
                if is_timeout
                else (
                    receipt_obj.get("code", "VERIFICATION_FAILED")
                    if isinstance(receipt_obj, dict)
                    and isinstance(receipt_obj.get("code"), str)
                    else "VERIFICATION_FAILED"
                )
            )
            results.append(
                {
                    "trial": trial,
                    "kind": kind,
                    "proposal_id": proposal_id,
                    "verified": False,
                    "status": "timeout" if is_timeout else "unverified",
                    "code": code,
                }
            )
            continue
        except TimeoutError:
            results.append(
                {
                    "trial": trial,
                    "kind": kind,
                    "proposal_id": proposal_id,
                    "verified": False,
                    "status": "timeout",
                    "code": "TIMEOUT",
                }
            )
            continue
        except (ObservationError, SurfaceError) as exc:
            code = getattr(exc, "code", None)
            if not isinstance(code, str) or not code:
                code = "OBSERVATION_ERROR"
            results.append(
                {
                    "trial": trial,
                    "kind": kind,
                    "proposal_id": proposal_id,
                    "verified": False,
                    "status": "refused",
                    "code": code,
                }
            )
            continue
        except (tools.ToolValidationError, ValueError) as exc:
            code = getattr(exc, "code", None)
            if not isinstance(code, str) or not code:
                code = (
                    "UNVERIFIED_RECEIPT"
                    if "receipt verified" in str(exc)
                    else "VALIDATION_ERROR"
                )
            results.append(
                {
                    "trial": trial,
                    "kind": kind,
                    "proposal_id": proposal_id,
                    "verified": False,
                    "status": "unverified",
                    "code": code,
                }
            )
            continue

        if isinstance(receipt, dict) and receipt.get("verified") is True:
            verified_count += 1
            results.append(
                {
                    "trial": trial,
                    "kind": kind,
                    "proposal_id": proposal_id,
                    "verified": True,
                    "status": "verified",
                    "code": "OK",
                }
            )
        else:
            results.append(
                {
                    "trial": trial,
                    "kind": kind,
                    "proposal_id": proposal_id,
                    "verified": False,
                    "status": "unverified",
                    "code": "VERIFICATION_FAILED",
                }
            )

    passed = bool(verified_count * trials >= min_verified * trials)
    report = {
        "schema": REPORT_SCHEMA,
        "trials": trials,
        "verified": verified_count,
        "pass": passed,
        "results": results,
    }
    validate_report(report, trials=trials, min_verified=min_verified)
    return copy.deepcopy(report)


def validate_report(
    report: object,
    *,
    trials: int = DEFAULT_TRIALS,
    min_verified: int = DEFAULT_MIN_VERIFIED,
) -> dict:
    """Validate the closed loop report and verify counts against trial rows."""
    _check_ratio_bounds(trials, min_verified, 1000)
    try:
        _reject_non_canonical(report, 0)
    except ObservationError as exc:
        _fail("bad_shape", str(exc))

    if not isinstance(report, dict) or set(report) != _REPORT_KEYS:
        _fail("bad_shape", "report keys must be schema, trials, verified, pass, results")
    if report.get("schema") != REPORT_SCHEMA:
        _fail("bad_shape", "report schema mismatch")

    reported_trials = report.get("trials")
    reported_verified = report.get("verified")
    reported_pass = report.get("pass")
    rows = report.get("results")

    if type(reported_trials) is not int or reported_trials != trials:
        _fail("bad_shape", "report trials count mismatch")
    if type(reported_verified) is not int or not 0 <= reported_verified <= trials:
        _fail("bad_shape", "report verified count out of range")
    if type(reported_pass) is not bool:
        _fail("bad_shape", "report pass flag must be a boolean")
    if not isinstance(rows, list) or len(rows) != trials:
        _fail("bad_shape", "report results length must equal trials")

    actual_verified = 0
    for idx, row in enumerate(rows, start=1):
        if not isinstance(row, dict) or set(row) != _RESULT_KEYS:
            _fail("bad_shape", f"trial {idx} keys invalid")
        if type(row.get("trial")) is not int or row["trial"] != idx:
            _fail("bad_shape", f"trial {idx} index out of order")
        expected_kind = _trial_kind(idx)
        if row.get("kind") != expected_kind:
            _fail("bad_shape", f"trial {idx} kind must be {expected_kind}")
        proposal_id = row.get("proposal_id")
        if not isinstance(proposal_id, str) or not proposal_id:
            _fail("bad_shape", f"trial {idx} proposal_id invalid")
        verified = row.get("verified")
        if type(verified) is not bool:
            _fail("bad_shape", f"trial {idx} verified must be a boolean")
        status = row.get("status")
        if not isinstance(status, str) or status not in _VALID_STATUSES:
            _fail("bad_shape", f"trial {idx} status invalid")
        code = row.get("code")
        if not isinstance(code, str) or not code:
            _fail("bad_shape", f"trial {idx} code invalid")
        if verified:
            if status != "verified" or code != "OK":
                _fail("bad_shape", f"trial {idx} verified row has inconsistent status/code")
            actual_verified += 1
        else:
            if status == "verified" or code == "OK":
                _fail("bad_shape", f"trial {idx} unverified row claims verified status/code")

    if reported_verified != actual_verified:
        _fail(
            "tampered_verified",
            f"reported verified={reported_verified} disagrees with results count={actual_verified}",
        )

    expected_pass = bool(actual_verified * trials >= min_verified * trials)
    if reported_pass != expected_pass:
        _fail(
            "tampered_pass",
            f"reported pass={reported_pass} disagrees with ratio check={expected_pass}",
        )

    return copy.deepcopy(report)


validate_receipt = validate_report
recheck_receipt = validate_report


class _ScriptedTrialClient:
    """Offline deterministic client for one trial of the agent loop."""

    def __init__(
        self,
        *,
        trial: int,
        kind: str,
        should_verify: bool,
        failure_mode: str = "refused",
        refusal_code: str = "STALE_FRAME",
        surface_id: str = "fixture",
    ) -> None:
        self.trial = trial
        self.kind = kind
        self.should_verify = should_verify
        self.failure_mode = failure_mode
        self.refusal_code = refusal_code
        self.surface_id = surface_id
        self.ops: list[str] = []
        self.proposals: list[dict] = []
        seed = f"frame:{surface_id}:{trial}".encode("utf-8")
        self.before_sha = hashlib.sha256(seed).hexdigest()
        self.after_sha = hashlib.sha256(seed + b":after").hexdigest()
        self.state_before = hashlib.sha256(b"state:before:" + seed).hexdigest()
        self.frame = {
            "schema": "frame_ref/v0.2",
            "surface_id": surface_id,
            "generation": trial,
            "tick": trial * 10,
            "ts_ns": trial * 1000,
            "width": 64,
            "height": 64,
            "format": "rgb24",
            "ramws_path": "/dev/shm/fixture",
            "sha256": self.before_sha,
            "capture_us": 10,
        }

    def request(self, call: dict, expect: str, *, timeout_ms: int) -> dict:
        op = call["op"]
        self.ops.append(op)
        reply: dict = {
            "schema": expect,
            "request_id": call["request_id"],
            "op": op,
        }
        if op == "observe":
            obs: dict = {
                "schema": "observation/v0.2",
                "frame_ref": copy.deepcopy(self.frame),
            }
            if self.kind == "holdings":
                obs["ground_truth"] = {
                    "source": "holdings_lane",
                    "state_sha256": self.state_before,
                    "tick": self.frame["tick"],
                }
            else:
                obs["vision"] = {
                    "summary": "scripted browser fixture",
                    "changed_regions": [{"x": 0, "y": 0, "w": 16, "h": 16}],
                    "elements": [
                        {
                            "bbox": {"x": 4, "y": 4, "w": 20, "h": 12},
                            "role": "button",
                            "name": "Continue",
                            "confidence": 1.0,
                        }
                    ],
                }
            reply.update(status="ok", observation=obs)
            return reply

        if op == "propose":
            proposal = copy.deepcopy(call["args"]["proposal"])
            self.proposals.append(proposal)
            if not self.should_verify and self.failure_mode == "refused":
                reply.update(
                    status="refused",
                    reason_code=self.refusal_code,
                    detail="scripted trial refusal",
                )
                return reply
            reply.update(
                status="admitted",
                verdict={
                    "schema": "action_verdict/v0.2",
                    "proposal_id": proposal["proposal_id"],
                    "decision": "admitted",
                    "core_seq": self.trial,
                },
            )
            return reply

        if op == "wait_verify":
            proposal_id = call["args"]["proposal_id"]
            if not self.should_verify:
                if self.failure_mode == "timeout":
                    reply.update(
                        status="timeout",
                        proposal_id=proposal_id,
                        verified=False,
                    )
                    return reply
                reply.update(
                    status="error",
                    code="VERIFICATION_FAILED",
                    detail="scripted verification failed",
                )
                return reply

            after_frame = dict(
                self.frame,
                generation=self.frame["generation"] + 1,
                tick=self.frame["tick"] + 1,
                sha256=self.after_sha,
            )
            method = "state_sha256" if self.kind == "holdings" else "pixel"
            receipt = {
                "schema": "action_receipt/v0.2",
                "proposal_id": proposal_id,
                "executed_at_ns": after_frame["ts_ns"],
                "after_frame": after_frame,
                "verified": True,
                "verification": {
                    "method": method,
                    "detail": f"scripted {method} witness",
                },
                "error": "",
            }
            reply.update(
                status="verified",
                receipt=receipt,
                focus_verified=True,
                input_mono_ns=after_frame["ts_ns"],
                frame_sha256=after_frame["sha256"],
            )
            return reply

        raise AssertionError(f"unexpected tool op: {op}")


def make_scripted_double(
    *,
    trials: int = DEFAULT_TRIALS,
    verified_count: int = DEFAULT_TRIALS,
    failure_mode: str = "refused",
    refusal_code: str = "STALE_FRAME",
    surface_id: str = "fixture",
) -> tuple[Callable[[int, str], _ScriptedTrialClient], Callable[[dict, int, str], tuple[dict, dict]], list[_ScriptedTrialClient]]:
    """Construct an offline deterministic client_factory and planner pair."""
    if type(trials) is not int or not 1 <= trials <= 1000:
        raise ValueError("invalid trials count")
    if type(verified_count) is not int or not 0 <= verified_count <= trials:
        raise ValueError("invalid verified_count")

    clients: list[_ScriptedTrialClient] = []

    def client_factory(trial: int, kind: str) -> _ScriptedTrialClient:
        client = _ScriptedTrialClient(
            trial=trial,
            kind=kind,
            should_verify=(trial <= verified_count),
            failure_mode=failure_mode,
            refusal_code=refusal_code,
            surface_id=surface_id,
        )
        clients.append(client)
        return client

    def planner(observation: dict, trial: int, kind: str) -> tuple[dict, dict]:
        frame = observation["frame_ref"]
        if kind == "holdings" and "ground_truth" in observation:
            truth = observation["ground_truth"]
            action = {
                "type": "lane_submit",
                "verb": "submit",
                "payload": {
                    "nonce": f"nonce-{trial}",
                    "seq": trial,
                    "command": "step",
                    "args": [],
                },
            }
            expectation = {
                "type": "state_sha256_change",
                "before": truth["state_sha256"],
                "min_tick": frame["tick"] + 1,
                "max_tick": frame["tick"] + 5,
            }
            return action, expectation

        action = {"type": "click", "x": 10, "y": 10, "button": "left"}
        expectation = {
            "type": "changed_region",
            "bbox": {"x": 0, "y": 0, "w": frame["width"], "h": frame["height"]},
        }
        return action, expectation

    return client_factory, planner, clients


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            _fail("bad_shape", "duplicate JSON key")
        result[key] = value
    return result


def _reject_constant(token: str) -> None:
    _fail("bad_shape", f"non-finite JSON constant: {token}")


def _checked_float(token: str) -> float:
    value = float(token)
    if not math.isfinite(value):
        _fail("bad_shape", "non-finite float")
    return value


def main(
    argv: list[str] | tuple[str, ...] | None = None,
    *,
    client_factory: Callable | None = None,
    planner: Callable | None = None,
    stdout=None,
    stderr=None,
) -> int:
    """CLI entry: run trials or verify a receipt, exiting nonzero when pass is false."""
    out_stream = sys.stdout if stdout is None else stdout
    err_stream = sys.stderr if stderr is None else stderr

    parser = argparse.ArgumentParser(
        prog="loop_trials",
        description="Run the 10-trial AI loop or validate a loop receipt.",
        allow_abbrev=False,
    )
    parser.add_argument("--trials", type=int, default=DEFAULT_TRIALS)
    parser.add_argument("--min-verified", type=int, default=DEFAULT_MIN_VERIFIED)
    parser.add_argument("--timeout-ms", type=int, default=1000)
    parser.add_argument("--scripted-verified", type=int, default=None)
    parser.add_argument("--verify-receipt", type=Path, default=None)
    parser.add_argument("--receipt-out", type=Path, default=None)

    try:
        args = parser.parse_args(list(sys.argv[1:] if argv is None else argv))
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) and exc.code != 0 else 2

    try:
        if args.verify_receipt is not None:
            raw = args.verify_receipt.read_text(encoding="utf-8")
            parsed = json.loads(
                raw,
                object_pairs_hook=_reject_duplicate_keys,
                parse_constant=_reject_constant,
                parse_float=_checked_float,
            )
            report = validate_report(
                parsed,
                trials=args.trials,
                min_verified=args.min_verified,
            )
        else:
            if client_factory is None or planner is None:
                scripted = (
                    args.trials
                    if args.scripted_verified is None
                    else args.scripted_verified
                )
                default_factory, default_planner, _ = make_scripted_double(
                    trials=args.trials,
                    verified_count=scripted,
                )
                active_factory = (
                    default_factory if client_factory is None else client_factory
                )
                active_planner = (
                    default_planner if planner is None else planner
                )
            else:
                active_factory = client_factory
                active_planner = planner

            report = run_trials(
                client_factory=active_factory,
                planner=active_planner,
                trials=args.trials,
                min_verified=args.min_verified,
                timeout_ms=args.timeout_ms,
            )

        output = canonical_json(report)
        if args.receipt_out is not None:
            args.receipt_out.write_text(output + "\n", encoding="utf-8")
    except LoopReportError as exc:
        print(f"{exc.code}: {exc.detail}", file=err_stream)
        return 2
    except Exception as exc:
        print(f"bad_shape: {exc}", file=err_stream)
        return 2

    print(output, file=out_stream)
    return 0 if report["pass"] is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
