"""Stdio MCP bridge for the frozen mvctl tool set.

Mechanical dispatch only: validate the closed MCP arguments, run the
matching synchronous tools.* function off the event loop, and map its
outcome to a CallToolResult. Admission and verification stay with the
core; this module never opens sockets and stdout carries protocol
frames only.

[TARGET, unit decision] JSON-RPC IDs use at most 128 encoded JSON bytes
and safe integers. Final frames, including fallback errors, obey the cap.
"""

from __future__ import annotations

import asyncio
import copy
import sys
from dataclasses import asdict, dataclass
import json
import re
from typing import TYPE_CHECKING, Any

# [TARGET, unit decision] No MCP SDK handoff is supplied. Implement the
# bounded JSON-RPC stdio subset here using only the standard library.
# The protocol version is a local compatibility target, not a measured peer.
PROTOCOL_VERSION = "2025-06-18"
MAX_FRAME_BYTES = 1 << 20


@dataclass
class TextContent:
    type: str
    text: str


@dataclass
class CallToolResult:
    content: list[TextContent]
    structuredContent: dict
    isError: bool


@dataclass
class Tool:
    name: str
    description: str
    inputSchema: dict


if TYPE_CHECKING:  # TOOLS lane owns tools.py; typing only, no runtime bind.
    from .tools import ToolClient

__all__ = ["SERVER_NAME", "TOOL_NAMES", "create_server", "serve"]

SERVER_NAME = "metaviewer-mvctl"
TOOL_NAMES = ("mv_observe", "mv_list", "mv_propose", "mv_wait_verify")

# Bounds mirror the frozen v0.2 wire caps (mv_tool_call wait_verify/list).
_TIMEOUT_MS_MIN = 1
_TIMEOUT_MS_MAX = 60000
_LIMIT_MIN = 1
_LIMIT_MAX = 256
_ID_MAX_LEN = 128
_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]*")
_REFUSAL_CODES = frozenset({
    "STALE_FRAME",
    "SURFACE_NOT_AGENT_CONTROLLED",
    "LOCKED_BY_OTHER",
    "BUDGET_EXCEEDED",
    "OUT_OF_BOUNDS",
    "POLICY",
})

# Fixed diagnostics; caller input is never echoed back.
_TEXT_UNKNOWN_TOOL = "unknown tool"
_TEXT_INVALID_ARGS = "invalid arguments"
_TEXT_UNVERIFIED = "verification failed"
_TEXT_VALIDATION = "invalid tool payload"
_TEXT_TIMEOUT = "request timed out"
_TEXT_TRANSPORT = "transport error"
_TEXT_UNKNOWN_VERSION = "unknown contract version"
_TEXT_INTERNAL = "internal error"

_ID_SCHEMA = {
    "type": "string",
    "minLength": 1,
    "maxLength": _ID_MAX_LEN,
    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
}
_TIMEOUT_SCHEMA = {
    "type": "integer",
    "minimum": _TIMEOUT_MS_MIN,
    "maximum": _TIMEOUT_MS_MAX,
}
_TOOL_SCHEMAS = {
    "mv_observe": {
        "type": "object",
        "properties": {
            "surface_id": _ID_SCHEMA,
            "timeout_ms": _TIMEOUT_SCHEMA,
        },
        "required": ["surface_id", "timeout_ms"],
        "additionalProperties": False,
    },
    "mv_list": {
        "type": "object",
        "properties": {
            "cursor": {"oneOf": [_ID_SCHEMA, {"type": "null"}]},
            "limit": {
                "type": "integer",
                "minimum": _LIMIT_MIN,
                "maximum": _LIMIT_MAX,
            },
            "timeout_ms": _TIMEOUT_SCHEMA,
        },
        "required": ["cursor", "limit", "timeout_ms"],
        "additionalProperties": False,
    },
    "mv_propose": {
        "type": "object",
        "properties": {
            "proposal": {"type": "object"},
            "timeout_ms": _TIMEOUT_SCHEMA,
        },
        "required": ["proposal", "timeout_ms"],
        "additionalProperties": False,
    },
    "mv_wait_verify": {
        "type": "object",
        "properties": {
            "proposal_id": _ID_SCHEMA,
            "expectation": {"type": "object"},
            "timeout_ms": _TIMEOUT_SCHEMA,
        },
        "required": ["proposal_id", "expectation", "timeout_ms"],
        "additionalProperties": False,
    },
}
_TOOL_DESCRIPTIONS = {
    "mv_observe": "Observe one capsule surface through the core mailbox.",
    "mv_list": "List one page of capsule surfaces from the core.",
    "mv_propose": "Submit one action proposal to core admission.",
    "mv_wait_verify": "Wait for the core-final verified receipt of a proposal.",
}


class _InvalidArgs(ValueError):
    """Closed marker: MCP arguments failed local validation, no dispatch."""


def _get_tools():
    """Resolve the TOOLS-lane module late so import order cannot break us."""
    from . import tools

    return tools


def _check_client(client: Any) -> None:
    if client is None or not callable(getattr(client, "request", None)):
        raise TypeError("client must expose request")


def _check_closed(arguments: Any, keys: frozenset) -> dict:
    if not isinstance(arguments, dict):
        raise _InvalidArgs("arguments must be an object")
    if set(arguments.keys()) != keys:
        raise _InvalidArgs("arguments must carry exactly the closed keys")
    return arguments


def _check_timeout_ms(value: Any) -> int:
    # type(x) is int rejects bool, which isinstance would accept.
    if type(value) is not int:
        raise _InvalidArgs("timeout_ms must be an integer")
    if not _TIMEOUT_MS_MIN <= value <= _TIMEOUT_MS_MAX:
        raise _InvalidArgs("timeout_ms out of range")
    return value


def _check_id(value: Any) -> str:
    if not isinstance(value, str):
        raise _InvalidArgs("id must be a string")
    if len(value) > _ID_MAX_LEN or _ID_PATTERN.fullmatch(value) is None:
        raise _InvalidArgs("id out of shape")
    return value


def _validate_observe(arguments: Any) -> dict:
    args = _check_closed(arguments, frozenset(("surface_id", "timeout_ms")))
    return {
        "surface_id": _check_id(args["surface_id"]),
        "timeout_ms": _check_timeout_ms(args["timeout_ms"]),
    }


def _validate_list(arguments: Any) -> dict:
    args = _check_closed(arguments, frozenset(("cursor", "limit", "timeout_ms")))
    cursor = args["cursor"]
    if cursor is not None:
        _check_id(cursor)
    limit = args["limit"]
    if type(limit) is not int or not _LIMIT_MIN <= limit <= _LIMIT_MAX:
        raise _InvalidArgs("limit out of range")
    return {
        "cursor": cursor,
        "limit": limit,
        "timeout_ms": _check_timeout_ms(args["timeout_ms"]),
    }


def _validate_propose(arguments: Any) -> dict:
    # Nested closed proposal validation belongs to tools.py, the single
    # owner of the action_proposal domain; here only the dict gate applies.
    args = _check_closed(arguments, frozenset(("proposal", "timeout_ms")))
    if not isinstance(args["proposal"], dict):
        raise _InvalidArgs("proposal must be an object")
    return {
        "proposal": args["proposal"],
        "timeout_ms": _check_timeout_ms(args["timeout_ms"]),
    }


def _validate_wait_verify(arguments: Any) -> dict:
    args = _check_closed(
        arguments, frozenset(("proposal_id", "expectation", "timeout_ms"))
    )
    if not isinstance(args["expectation"], dict):
        raise _InvalidArgs("expectation must be an object")
    return {
        "proposal_id": _check_id(args["proposal_id"]),
        "expectation": args["expectation"],
        "timeout_ms": _check_timeout_ms(args["timeout_ms"]),
    }


_VALIDATORS = {
    "mv_observe": _validate_observe,
    "mv_list": _validate_list,
    "mv_propose": _validate_propose,
    "mv_wait_verify": _validate_wait_verify,
}

_TOOL_ATTRS = (
    "observe",
    "list_surfaces",
    "propose",
    "wait_verify",
    "ToolRefusal",
    "VerificationFailed",
    "ToolValidationError",
)


def _error(text: str, structured: dict) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=text)],
        structuredContent=structured,
        isError=True,
    )


def _success(payload: Any) -> CallToolResult:
    if not isinstance(payload, dict):
        return _error(_TEXT_INTERNAL, {"code": "internal_error"})
    try:
        text = json.dumps(
            payload, sort_keys=True, separators=(",", ":"), allow_nan=False
        )
    except (TypeError, ValueError):
        # Non-serializable or non-finite tool output fails closed.
        return _error(_TEXT_INTERNAL, {"code": "internal_error"})
    return CallToolResult(
        content=[TextContent(type="text", text=text)],
        structuredContent=json.loads(text),
        isError=False,
    )


def _refusal_result(exc: BaseException) -> CallToolResult:
    code = getattr(exc, "reason_code", None)
    seq = getattr(exc, "core_seq", None)
    # The frozen refused branch carries no core_seq, so None passes
    # through as null; anything else outside int >= 1 fails closed.
    if not (isinstance(code, str) and code in _REFUSAL_CODES):
        return _error(_TEXT_INTERNAL, {"code": "internal_error"})
    if seq is not None and (type(seq) is not int or seq < 1):
        return _error(_TEXT_INTERNAL, {"code": "internal_error"})
    return _error("core refused: " + code, {"reason_code": code, "core_seq": seq})


def _unverified_result(exc: BaseException) -> CallToolResult:
    receipt = getattr(exc, "receipt", None)
    if not isinstance(receipt, dict):
        return _error(_TEXT_INTERNAL, {"code": "internal_error"})
    try:
        frozen = json.loads(
            json.dumps(
                receipt, sort_keys=True, separators=(",", ":"), allow_nan=False
            )
        )
    except (TypeError, ValueError):
        return _error(_TEXT_INTERNAL, {"code": "internal_error"})
    return _error(
        _TEXT_UNVERIFIED, {"code": "verification_failed", "receipt": frozen}
    )


async def _call_tool_impl(
    name: Any, arguments: Any, *, client: Any
) -> CallToolResult:
    if not isinstance(name, str) or name not in _TOOL_SCHEMAS:
        return _error(_TEXT_UNKNOWN_TOOL, {"code": "unknown_tool"})
    try:
        validated = _VALIDATORS[name](arguments)
    except _InvalidArgs:
        return _error(_TEXT_INVALID_ARGS, {"code": "invalid_arguments"})
    try:
        tools_mod = _get_tools()
    except ImportError:
        return _error(_TEXT_INTERNAL, {"code": "internal_error"})
    if any(not hasattr(tools_mod, attr) for attr in _TOOL_ATTRS):
        return _error(_TEXT_INTERNAL, {"code": "internal_error"})
    refusal_cls = tools_mod.ToolRefusal
    unverified_cls = tools_mod.VerificationFailed
    validation_cls = tools_mod.ToolValidationError
    if not all(
        isinstance(cls, type) and issubclass(cls, BaseException)
        for cls in (refusal_cls, unverified_cls, validation_cls)
    ):
        return _error(_TEXT_INTERNAL, {"code": "internal_error"})
    try:
        if name == "mv_observe":
            payload = await asyncio.to_thread(
                lambda: tools_mod.observe(
                    validated["surface_id"],
                    client=client,
                    timeout_ms=validated["timeout_ms"],
                )
            )
        elif name == "mv_list":
            payload = await asyncio.to_thread(
                lambda: tools_mod.list_surfaces(
                    cursor=validated["cursor"],
                    limit=validated["limit"],
                    client=client,
                    timeout_ms=validated["timeout_ms"],
                )
            )
        elif name == "mv_propose":
            payload = await asyncio.to_thread(
                lambda: tools_mod.propose(
                    validated["proposal"],
                    client=client,
                    timeout_ms=validated["timeout_ms"],
                )
            )
        else:
            payload = await asyncio.to_thread(
                lambda: tools_mod.wait_verify(
                    validated["proposal_id"],
                    validated["expectation"],
                    validated["timeout_ms"],
                    client=client,
                )
            )
    except refusal_cls as exc:
        return _refusal_result(exc)
    except unverified_cls as exc:
        return _unverified_result(exc)
    except (validation_cls, ValueError):
        return _error(_TEXT_VALIDATION, {"code": "validation_error"})
    except TimeoutError:
        return _error(_TEXT_TIMEOUT, {"code": "timeout"})
    except Exception as exc:  # Map every leak to a closed local error.
        if exc.__class__.__name__ == "ClientError":
            sub = getattr(exc, "code", None)
            if sub == "timeout":
                return _error(_TEXT_TIMEOUT, {"code": "timeout"})
            if sub == "unknown_version":
                return _error(
                    _TEXT_UNKNOWN_VERSION, {"code": "unknown_version"}
                )
            return _error(_TEXT_TRANSPORT, {"code": "transport_error"})
        return _error(_TEXT_INTERNAL, {"code": "internal_error"})
    return _success(payload)


def _bounded_id(ident):
    if type(ident) is int:
        return -(2**53 - 1) <= ident <= 2**53 - 1
    return (isinstance(ident, str) and len(ident) <= 128
            and len(json.dumps(ident).encode("utf-8")) <= 128)


class Server:
    """Minimal serial MCP server; framing is UTF-8 NDJSON with byte caps."""

    def __init__(self, client):
        self.name = SERVER_NAME
        self.client = client
        self.initialized = False

    async def list_tools(self):
        return [Tool(name, _TOOL_DESCRIPTIONS[name],
                     copy.deepcopy(_TOOL_SCHEMAS[name])) for name in TOOL_NAMES]

    async def call_tool(self, name, arguments):
        return await _call_tool_impl(name, arguments, client=self.client)

    async def handle(self, message):
        def error(code, text, ident=None):
            return {"jsonrpc": "2.0", "id": ident,
                    "error": {"code": code, "message": text}}

        if (not isinstance(message, dict) or message.get("jsonrpc") != "2.0"
                or not isinstance(message.get("method"), str)
                or set(message) - {"jsonrpc", "id", "method", "params"}
                or ("id" in message and type(message["id"]) not in (str, int))):
            return error(-32600, "Invalid Request")
        ident = message.get("id")
        # [TARGET, unit decision] IDs are correlation tokens, capped at an
        # ASCII-encoded JSON size of 128 bytes; numeric IDs use safe integers.
        if "id" in message and not _bounded_id(ident):
            return error(-32603, "Response too large")
        method = message["method"]
        params = message.get("params", {})
        if not isinstance(params, dict):
            return error(-32602, "Invalid params", ident) if "id" in message else None
        if "id" not in message:
            return None
        if method == "initialize":
            if (not isinstance(params.get("protocolVersion"), str)
                    or not isinstance(params.get("capabilities"), dict)
                    or not isinstance(params.get("clientInfo"), dict)):
                return error(-32602, "Invalid params", ident)
            self.initialized = True
            result = {"protocolVersion": PROTOCOL_VERSION,
                      "capabilities": {"tools": {}},
                      "serverInfo": {"name": self.name, "version": "0.1.1"}}
        elif not self.initialized:
            return error(-32000, "Initialize first", ident)
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            if params:
                return error(-32602, "Invalid params", ident)
            result = {"tools": [asdict(tool) for tool in await self.list_tools()]}
        elif method == "tools/call":
            if (set(params) != {"name", "arguments"}
                    or not isinstance(params["name"], str)):
                return error(-32602, "Invalid params", ident)
            result = asdict(await self.call_tool(params["name"], params["arguments"]))
        else:
            return error(-32601, "Method not found", ident)
        return {"jsonrpc": "2.0", "id": ident, "result": result}


def create_server(*, client: ToolClient) -> Server:
    """Build a standard-library server bound to one synchronous client."""
    _check_client(client)
    return Server(client)


def _decode_frame(raw):
    def pairs(entries):
        result = {}
        for key, value in entries:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    def invalid_constant(value):
        raise ValueError("non-finite JSON")

    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)


async def serve(*, client: ToolClient) -> None:
    """Run bounded stdio requests until EOF; emit protocol responses only."""
    server = create_server(client=client)
    reader = sys.stdin.buffer
    writer = sys.stdout.buffer
    while True:
        raw = await asyncio.to_thread(reader.readline, MAX_FRAME_BYTES + 1)
        if not raw:
            return
        if len(raw) > MAX_FRAME_BYTES or not raw.endswith(b"\n"):
            # Close on framing failure; never treat a tail as another request.
            response = {"jsonrpc": "2.0", "id": None,
                        "error": {"code": -32700, "message": "Invalid frame"}}
        else:
            try:
                message = _decode_frame(raw.decode("utf-8"))
            except (UnicodeError, ValueError, RecursionError):
                response = {"jsonrpc": "2.0", "id": None,
                            "error": {"code": -32700, "message": "Parse error"}}
            else:
                response = await server.handle(message)
        if response is not None:
            try:
                output = json.dumps(response, separators=(",", ":"), allow_nan=False).encode("utf-8")
            except (ValueError, TypeError, OverflowError, RecursionError):
                output = b""
            if not output or len(output) + 1 > MAX_FRAME_BYTES:
                ident = response.get("id")
                if not _bounded_id(ident):
                    ident = None
                output = json.dumps({"jsonrpc": "2.0", "id": ident,
                                     "error": {"code": -32603, "message": "Response too large"}},
                                    separators=(",", ":")).encode("utf-8")
            # Check the actual final frame, including the fallback and LF.
            if len(output) + 1 > MAX_FRAME_BYTES:
                output = b'{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Response too large"}}'
            if len(output) + 1 > MAX_FRAME_BYTES:
                return
            writer.write(output + b"\n")
            writer.flush()
        if len(raw) > MAX_FRAME_BYTES or not raw.endswith(b"\n"):
            return
