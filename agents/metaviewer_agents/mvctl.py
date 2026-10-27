"""Closed command client for MetaViewer core admission.

[TARGET, unit decision] Default CLI verbs use v0.2 and trusted MV_CORE_CONFIG
(or --config) registration. --v02 is a compatibility spelling of that path.
Proposal files contain action_proposal/v0.2 bodies, never legacy envelopes.
[TARGET, unit decision] List exposes the existing single-page tool protocol:
--limit is required and --cursor is optional; no implicit page size is chosen.

This module is an untrusted caller: it validates every flag, input byte and
core reply, and leaves admission, ownership and replay decisions to the core.

The core owns admission and verification. Missing focus/input evidence remains
a verification refusal; receiving a receipt alone never fabricates that proof.
"""

import argparse
import json
import math
import os
import re
import sys
from collections.abc import Callable, Sequence

_ENVELOPE_SCHEMA = "envelope/v0.1"
_PROPOSAL_SCHEMA = "action_proposal/v0.1"
_VERDICT_SCHEMA = "action_verdict/v0.1"
_PROPOSAL_FAMILY = "action_proposal/"
_VERDICT_FAMILY = "action_verdict/"
_RUNTIME_PARTS = ("metaviewer", "core.sock")
_INT_PATTERN = re.compile(r"[1-9][0-9]*")
_MAX_INT_DIGITS = 10
_REFUSAL_TEXT = {
    "usage_error": "invalid command line",
    "input_error": "invalid input file",
    "schema_error": "schema validation failed",
    "unknown_version": "unknown contract version",
    "endpoint_error": "invalid endpoint",
    "transport_unavailable": "transport unavailable",
    "transport_error": "transport error",
    "timeout": "request timed out",
    "unexpected_reply": "unexpected reply",
    "unsupported_operation": "unsupported operation",
}


class _UsageParser(argparse.ArgumentParser):
    """Parser whose diagnostics never echo caller input."""

    def error(self, message):
        _refuse("usage_error")
        self.exit(2)


class _OnceAction(argparse.Action):
    """Reject a repeated flag instead of letting the last value win."""

    def __call__(self, parser, namespace, values, option_string=None):
        seen = getattr(namespace, "_seen_flags", None)
        if seen is None:
            seen = set()
            setattr(namespace, "_seen_flags", seen)
        if self.dest in seen:
            parser.error("duplicate option")
        seen.add(self.dest)
        setattr(namespace, self.dest, values)


def _positive_int(text):
    """Parse a canonical positive base-ten CLI integer with a length rail."""
    if (not isinstance(text, str) or len(text) > _MAX_INT_DIGITS
            or _INT_PATTERN.fullmatch(text) is None):
        raise ValueError("not a canonical positive integer")
    return int(text)


def _build_legacy_parser() -> argparse.ArgumentParser:
    """Build the closed mvctl parser (propose plus reserved observe)."""
    parser = _UsageParser(
        prog="mvctl",
        description="Submit one v0.1 envelope to the core and print its verdict.",
        allow_abbrev=False,
        exit_on_error=True,
    )
    commands = parser.add_subparsers(dest="command", required=True,
                                     metavar="command")
    propose = commands.add_parser(
        "propose",
        help="send the envelope stored in a file",
        allow_abbrev=False,
        exit_on_error=True,
    )
    propose.add_argument("--json-arg", required=True, action=_OnceAction,
                         default=None, metavar="FILE",
                         help="file holding exactly one envelope/v0.1")
    propose.add_argument("--timeout-ms", required=True, action=_OnceAction,
                         type=_positive_int, default=None, metavar="N",
                         help="deadline in milliseconds")
    propose.add_argument("--max-line-bytes", required=True, action=_OnceAction,
                         type=_positive_int, default=None, metavar="N",
                         help="cap for the outbound frame in bytes")
    propose.add_argument("--max-reply-bytes", required=True, action=_OnceAction,
                         type=_positive_int, default=None, metavar="N",
                         help="cap for the inbound frame in bytes")
    propose.add_argument("--socket", required=False, action=_OnceAction,
                         default=None, metavar="PATH",
                         help="absolute core socket path")
    commands.add_parser(
        "observe",
        help="reserved skeleton entry",
        allow_abbrev=False,
        exit_on_error=True,
    )
    return parser


def _refuse(code):
    """Write one fixed refusal record to stderr; stdout stays empty."""
    # The v0.2 hello pin failure has no legacy command equivalent.
    text = ("trusted component pins do not match" if code == "version"
            else _REFUSAL_TEXT[code])
    record = {"verdict": "refuse", "code": code, "error": text}
    print(json.dumps(record, separators=(",", ":"), allow_nan=False),
          file=sys.stderr)


def _reject_duplicate_key(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("duplicate object key")
        obj[key] = value
    return obj


def _reject_constant(text):
    raise ValueError("non-finite constant")


def _checked_float(text):
    value = float(text)
    if not math.isfinite(value):
        raise ValueError("non-finite number")
    return value


def _read_request(path, cap):
    """Read exactly one strict JSON object bounded by cap bytes."""
    try:
        with open(path, "rb") as handle:
            data = handle.read(cap + 1)
    except OSError:
        raise ValueError("unreadable input") from None
    if len(data) > cap:
        raise ValueError("input over cap") from None
    try:
        text = data.decode("utf-8")
    except (ValueError, UnicodeError):
        raise ValueError("input is not strict UTF-8") from None
    try:
        value = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_key,
            parse_constant=_reject_constant,
            parse_float=_checked_float,
        )
    except (ValueError, UnicodeError, RecursionError):
        raise ValueError("input is not one JSON object") from None
    if not isinstance(value, dict):
        raise ValueError("input is not one JSON object")
    return value


def _resolve_endpoint(explicit):
    """Return the socket path, or (None, refusal code) when unusable."""
    if explicit is not None:
        if not os.path.isabs(explicit):
            return None, "usage_error"
        return explicit, None
    runtime = os.environ.get("XDG_RUNTIME_DIR", "")
    if not runtime:
        return None, "endpoint_error"
    return os.path.join(runtime, *_RUNTIME_PARTS), None


def _client_refusal(error, phase):
    """Map a transport failure to a refusal code without echoing detail."""
    code = getattr(error, "code", None)
    if code == "timeout" or isinstance(error, TimeoutError):
        return "timeout"
    if code == "unknown_version":
        return "unknown_version"
    if code == "version":
        return "version"
    if code in ("schema", "bad_shape"):
        return "schema_error"
    if code == "length":
        return "transport_error"
    if isinstance(error, (AttributeError, TypeError)):
        return "transport_unavailable"
    if isinstance(error, (FileNotFoundError, NotADirectoryError,
                           PermissionError)):
        return "endpoint_error"
    if code == "socket" or isinstance(
            error, (ConnectionError, OSError, EOFError, ValueError,
                    UnicodeError)):
        if isinstance(error, (ValueError, UnicodeError)) and code != "socket":
            # Connect-phase value failures describe the endpoint, while
            # call-phase value failures describe the received frame.
            return "endpoint_error" if phase == "connect" else "schema_error"
        return "endpoint_error" if phase == "connect" else "transport_error"
    return "transport_error"


def _check_request_head(request):
    """Route the request by discriminator before full validation."""
    schema = request.get("schema")
    if schema == _ENVELOPE_SCHEMA:
        body = request.get("body")
        nested = body.get("schema") if isinstance(body, dict) else None
        if (isinstance(nested, str) and nested != _PROPOSAL_SCHEMA
                and nested.startswith(_PROPOSAL_FAMILY)):
            return "unknown_version"
        return None
    if schema == _PROPOSAL_SCHEMA:
        return "input_error"
    if isinstance(schema, str):
        return "unknown_version"
    return "schema_error"


def _is_proposal_request(validated):
    """Check the validated request shape propose is allowed to send."""
    body = validated.get("body")
    frm = validated.get("from")
    to = validated.get("to")
    return (
        isinstance(body, dict)
        and body.get("schema") == _PROPOSAL_SCHEMA
        and isinstance(frm, dict)
        and isinstance(to, dict)
        and frm.get("component") == "agent"
        and to.get("component") == "core"
    )


def _matches_request(checked_reply, verdict, checked_request):
    """Check the reply answers this request (no retry or consume loop)."""
    want_from = checked_request.get("from")
    want_to = checked_request.get("to")
    want_body = checked_request.get("body")
    got_from = checked_reply.get("from")
    got_to = checked_reply.get("to")
    return (
        isinstance(got_from, dict)
        and isinstance(got_to, dict)
        and isinstance(want_from, dict)
        and isinstance(want_to, dict)
        and isinstance(want_body, dict)
        and got_from.get("component") == "core"
        and got_to.get("component") == "agent"
        and got_from.get("instance") == want_to.get("instance")
        and got_to.get("instance") == want_from.get("instance")
        and checked_reply.get("session_id") == checked_request.get("session_id")
        and verdict.get("proposal_id") == want_body.get("proposal_id")
    )


def _run_legacy(argv: Sequence[str] | None = None,
        send: Callable[[dict], dict] | None = None) -> int:
    """Parse argv, send one envelope, print one verdict; return 0, 1 or 2."""
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    if raw_argv and raw_argv[0] == "observe":
        _refuse("unsupported_operation")
        return 2
    parser = _build_legacy_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as done:
        return done.code if isinstance(done.code, int) else 2
    if args.command == "observe":
        _refuse("unsupported_operation")
        return 2
    try:
        from .client import ClientError, CoreClient
        from .envelope import EnvelopeError, validate_envelope
    except ImportError:
        _refuse("transport_unavailable")
        return 2
    endpoint, failure = _resolve_endpoint(args.socket)
    if failure is not None:
        _refuse(failure)
        return 2
    try:
        request = _read_request(args.json_arg, args.max_line_bytes)
    except (ValueError, UnicodeError, RecursionError):
        _refuse("input_error")
        return 2
    failure = _check_request_head(request)
    if failure is not None:
        _refuse(failure)
        return 2
    try:
        checked_request = validate_envelope(request)
    except EnvelopeError as err:
        _refuse("unknown_version"
                if err.code == "unknown_version" else "schema_error")
        return 2
    except (ValueError, TypeError):
        _refuse("schema_error")
        return 2
    if not isinstance(checked_request, dict) or not _is_proposal_request(
            checked_request):
        _refuse("schema_error")
        return 2
    if send is not None:
        try:
            reply = send(checked_request)
        except (ClientError, TimeoutError, ConnectionError, OSError, EOFError,
                ValueError, UnicodeError, AttributeError, TypeError,
                RuntimeError) as err:
            _refuse(_client_refusal(err, "call"))
            return 2
    else:
        try:
            client = CoreClient(
                endpoint,
                timeout_s=args.timeout_ms / 1000,
                max_line_bytes=args.max_line_bytes,
                max_reply_bytes=args.max_reply_bytes,
            )
        except (ClientError, TimeoutError, ConnectionError, OSError, EOFError,
                ValueError, UnicodeError, AttributeError, TypeError) as err:
            _refuse(_client_refusal(err, "connect"))
            return 2
        try:
            with client as active:
                if checked_request.get("seq") != active.next_seq:
                    _refuse("input_error")
                    return 2
                try:
                    reply = active.call(checked_request)
                except (ClientError, TimeoutError, ConnectionError, OSError,
                        EOFError, ValueError, UnicodeError, AttributeError,
                        TypeError) as err:
                    _refuse(_client_refusal(err, "call"))
                    return 2
        except (ClientError, TimeoutError, ConnectionError, OSError, EOFError,
                ValueError, UnicodeError, AttributeError, TypeError) as err:
            _refuse(_client_refusal(err, "connect"))
            return 2
    if not isinstance(reply, dict):
        _refuse("schema_error")
        return 2
    schema = reply.get("schema")
    if schema != _ENVELOPE_SCHEMA:
        _refuse("unknown_version"
                if isinstance(schema, str) else "schema_error")
        return 2
    body = reply.get("body")
    nested = body.get("schema") if isinstance(body, dict) else None
    if (isinstance(nested, str) and nested != _VERDICT_SCHEMA
            and nested.startswith(_VERDICT_FAMILY)):
        _refuse("unknown_version")
        return 2
    try:
        checked_reply = validate_envelope(reply)
    except EnvelopeError as err:
        _refuse("unknown_version"
                if err.code == "unknown_version" else "schema_error")
        return 2
    except (ValueError, TypeError):
        _refuse("schema_error")
        return 2
    if not isinstance(checked_reply, dict):
        _refuse("schema_error")
        return 2
    verdict = checked_reply.get("body")
    if (not isinstance(verdict, dict)
            or verdict.get("schema") != _VERDICT_SCHEMA):
        _refuse("unexpected_reply")
        return 2
    if not _matches_request(checked_reply, verdict, checked_request):
        _refuse("unexpected_reply")
        return 2
    try:
        payload = json.dumps(checked_reply, separators=(",", ":"),
                             allow_nan=False)
    except (ValueError, TypeError):
        _refuse("schema_error")
        return 2
    if verdict.get("decision") == "admitted":
        print(payload, file=sys.stdout)
        return 0
    if verdict.get("decision") == "refused":
        print(payload, file=sys.stdout)
        return 1
    _refuse("schema_error")
    return 2


def build_parser() -> argparse.ArgumentParser:
    """Build the default closed v0.2 tool parser."""
    parser = _UsageParser(prog="mvctl", allow_abbrev=False)
    parser.add_argument("--config", action=_OnceAction, default=os.environ.get("MV_CORE_CONFIG"))
    parser.add_argument("command", choices=("observe", "list", "propose", "wait-verify"))
    for flag in ("socket", "session-id", "agent-instance", "core-instance"):
        parser.add_argument("--" + flag, required=True, action=_OnceAction)
    for flag in ("timeout-ms", "max-line-bytes", "max-reply-bytes"):
        parser.add_argument("--" + flag, required=True, action=_OnceAction,
                            type=_positive_int)
    for flag in ("surface-id", "proposal-id", "json-arg", "cursor"):
        parser.add_argument("--" + flag, action=_OnceAction)
    parser.add_argument("--limit", action=_OnceAction, type=_positive_int)
    return parser


# [TARGET, unit decision] Identity and caps are mandatory. Trusted startup
# registration supplies hello pins; persistent sequences survive CLI reconnects.
def _run_v02(argv):
    from . import tools
    from .client import ClientError, ToolClient
    from .envelope import EnvelopeError, make_envelope

    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as done:
        return done.code
    expected = {"observe": (True, False, False),
                "list": (False, False, False),
                "propose": (False, False, True),
                "wait-verify": (False, True, True)}[args.command]
    if tuple(value is not None for value in
             (args.surface_id, args.proposal_id, args.json_arg)) != expected:
        _refuse("usage_error")
        return 2
    # [TARGET, unit decision] List maps to the existing single-page tool API:
    # --limit is explicit, --cursor is optional, and neither belongs to other verbs.
    if ((args.command == "list" and args.limit is None)
            or (args.command != "list" and (args.limit is not None or args.cursor is not None))):
        _refuse("usage_error")
        return 2
    endpoint, failure = _resolve_endpoint(args.socket)
    if failure:
        _refuse(failure)
        return 2

    try:
        payload = (_read_request(args.json_arg, args.max_line_bytes)
                   if args.json_arg else None)
        if payload is not None and args.command == "propose":
            if payload.get("schema") != "action_proposal/v0.2":
                _refuse("unknown_version")
                return 2
            tools._check_proposal(payload)
            # Apply the closed wire contract (including numeric rails) before
            # opening a connection. This validation envelope is never sent.
            make_envelope(msg_id="proposal-preflight", from_component="agent",
                          from_instance=args.agent_instance, to_component="core",
                          to_instance=args.core_instance, session_id=args.session_id,
                          seq=1, ts_ns=0, body=payload)
        if args.command == "wait-verify":
            tools._check_expectation(payload)
        if not args.config:
            _refuse("usage_error")
            return 2
        try:
            config = _read_request(args.config, args.max_line_bytes)
        except (ValueError, OSError):
            _refuse("usage_error")
            return 2
        local = next(peer for peer in config["peers"]
                     if peer["endpoint"] == {"component": "agent", "instance": args.agent_instance})
        if (config["session_id"] != args.session_id
                or config["core"]["endpoint"] != {"component": "core", "instance": args.core_instance}):
            raise ValueError("registration mismatch")
        import hashlib
        scope = json.dumps([args.session_id, local["endpoint"], config["core"]["endpoint"]],
                           sort_keys=True).encode()
        sequence_path = os.path.join(os.path.dirname(endpoint),
                                     ".mvctl-" + hashlib.sha256(scope).hexdigest() + ".seq")
        with ToolClient(endpoint, session_id=args.session_id, local=local,
                        core=config["core"], dependency_pins=local["hello"]["dependencies"],
                        sequence_path=sequence_path, timeout_s=args.timeout_ms / 1000,
                        max_line_bytes=args.max_line_bytes,
                        max_reply_bytes=args.max_reply_bytes) as client:
            if args.command == "list":
                result = tools.list_surfaces(cursor=args.cursor, limit=args.limit,
                                             client=client, timeout_ms=args.timeout_ms)
            elif args.command == "observe":
                result = tools.observe(args.surface_id, client=client,
                                       timeout_ms=args.timeout_ms)
            elif args.command == "propose":
                result = tools.propose(payload, client=client,
                                       timeout_ms=args.timeout_ms)
            else:
                result = tools.wait_verify(args.proposal_id, payload,
                                           args.timeout_ms, client=client)
    except tools.ToolRefusal as err:
        print(json.dumps({"verdict": "refuse", "reason_code": err.reason_code},
                         separators=(",", ":")), file=sys.stdout)
        return 1
    except tools.VerificationFailed as err:
        print(json.dumps(err.receipt, separators=(",", ":")), file=sys.stdout)
        return 1
    except (ClientError, EnvelopeError) as err:
        _refuse("unknown_version" if err.code == "unknown_version"
                else _client_refusal(err, "call"))
        return 2
    except (ValueError, OSError, TimeoutError, TypeError, KeyError, StopIteration) as err:
        code = ("unknown_version" if isinstance(err, tools.ToolValidationError)
                and "unknown result version" in err.detail
                else _client_refusal(err, "call"))
        _refuse(code)
        return 2
    print(json.dumps(result, separators=(",", ":"), allow_nan=False))
    return 0


def run(argv: Sequence[str] | None = None,
        send: Callable[[dict], dict] | None = None) -> int:
    """Run v0.2; the explicit injected v0.1 harness remains test-only."""
    if send is not None:
        return _run_legacy(argv, send)
    raw = list(sys.argv[1:] if argv is None else argv)
    return _run_v02(raw[1:] if raw[:1] == ["--v02"] else raw)


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point returning the process exit code."""
    return run(argv)


if __name__ == "__main__":
    raise SystemExit(main())
