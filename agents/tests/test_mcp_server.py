"""Unit tests for the metaviewer-mvctl stdio MCP bridge."""

import io
import json
import sys
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

import asyncio
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from metaviewer_agents import mcp_server
from metaviewer_agents import tools as tools_mod

class _KeepOpen(io.BytesIO):
    """BytesIO that survives sibling-wrapper teardown during stdio tests."""

    def close(self):
        try:
            self.flush()
        except ValueError:
            pass


_CANARY = "MCP-CANARY-9d4f2b71-never-echo"
_REASONS = (
    "STALE_FRAME",
    "SURFACE_NOT_AGENT_CONTROLLED",
    "LOCKED_BY_OTHER",
    "BUDGET_EXCEEDED",
    "OUT_OF_BOUNDS",
    "POLICY",
)
_TOOL_FUNCS = ("observe", "list_surfaces", "propose", "wait_verify")


class _StubClient:
    """Minimal ToolClient double; tools are mocked so this stays idle."""

    def __init__(self):
        self.calls = []

    def request(self, body, expect, *, timeout_ms):
        self.calls.append(
            {"body": body, "expect": expect, "timeout_ms": timeout_ms}
        )
        raise AssertionError("client reached while tools are mocked")


def _call(name, arguments):
    stub = _StubClient()
    server = mcp_server.create_server(client=stub)
    return asyncio.run(server.call_tool(name, arguments)), stub


def _list():
    stub = _StubClient()
    server = mcp_server.create_server(client=stub)
    return SimpleNamespace(tools=asyncio.run(server.list_tools())), stub


def _direct(name, arguments):
    async def _main():
        return await mcp_server._call_tool_impl(
            name, arguments, client=_StubClient()
        )

    return asyncio.run(_main())


def _patched_all():
    return (
        mock.patch.object(tools_mod, "observe", return_value={"ok": True}),
        mock.patch.object(tools_mod, "list_surfaces", return_value={"ok": True}),
        mock.patch.object(tools_mod, "propose", return_value={"ok": True}),
        mock.patch.object(tools_mod, "wait_verify", return_value={"ok": True}),
    )


class TestInventory(unittest.TestCase):
    def test_server_name(self):
        server = mcp_server.create_server(client=_StubClient())
        self.assertEqual(server.name, "metaviewer-mvctl")
        self.assertEqual(mcp_server.SERVER_NAME, "metaviewer-mvctl")

    def test_list_tools_closed_inventory(self):
        listed, _ = _list()
        self.assertEqual(
            [tool.name for tool in listed.tools],
            ["mv_observe", "mv_list", "mv_propose", "mv_wait_verify"],
        )
        want_required = {
            "mv_observe": {"surface_id", "timeout_ms"},
            "mv_list": {"cursor", "limit", "timeout_ms"},
            "mv_propose": {"proposal", "timeout_ms"},
            "mv_wait_verify": {"proposal_id", "expectation", "timeout_ms"},
        }
        for tool in listed.tools:
            with self.subTest(tool=tool.name):
                schema = tool.inputSchema
                self.assertIs(schema.get("additionalProperties"), False)
                self.assertEqual(set(schema.get("required", [])), want_required[tool.name])
                self.assertEqual(set(schema.get("properties", {})), want_required[tool.name])

    def test_list_tools_returns_isolated_schemas(self):
        first, _ = _list()
        first.tools[0].inputSchema["required"].append("injected")
        second, _ = _list()
        self.assertNotIn("injected", second.tools[0].inputSchema["required"])


class TestSuccess(unittest.TestCase):
    def test_observe_success(self):
        payload = {"schema": "observation/v0.2", "surface_id": "surf-1"}
        with mock.patch.object(
            tools_mod, "observe", return_value=payload
        ) as func:
            result, stub = _call(
                "mv_observe", {"surface_id": "surf-1", "timeout_ms": 500}
            )
        self.assertFalse(result.isError)
        self.assertEqual(result.structuredContent, payload)
        self.assertEqual(json.loads(result.content[0].text), payload)
        func.assert_called_once_with(
            "surf-1", client=mock.ANY, timeout_ms=500
        )
        self.assertEqual(stub.calls, [])

    def test_observe_timeout_rails_accepted(self):
        for timeout in (1, 60000):
            with self.subTest(timeout=timeout):
                with mock.patch.object(
                    tools_mod, "observe", return_value={"ok": True}
                ) as func:
                    result, _ = _call(
                        "mv_observe",
                        {"surface_id": "surf-1", "timeout_ms": timeout},
                    )
                self.assertFalse(result.isError)
                func.assert_called_once_with(
                    "surf-1", client=mock.ANY, timeout_ms=timeout
                )

    def test_list_success_paged(self):
        for cursor in (None, "c-2"):
            with self.subTest(cursor=cursor):
                payload = {"surfaces": [], "next_cursor": None}
                with mock.patch.object(
                    tools_mod, "list_surfaces", return_value=payload
                ) as func:
                    result, stub = _call(
                        "mv_list",
                        {"cursor": cursor, "limit": 25, "timeout_ms": 500},
                    )
                self.assertFalse(result.isError)
                self.assertEqual(result.structuredContent, payload)
                func.assert_called_once_with(
                    cursor=cursor, limit=25, client=mock.ANY, timeout_ms=500
                )
                self.assertEqual(stub.calls, [])

    def test_list_limit_rails_accepted(self):
        for limit in (1, 256):
            with self.subTest(limit=limit):
                with mock.patch.object(
                    tools_mod, "list_surfaces", return_value={"ok": True}
                ) as func:
                    result, _ = _call(
                        "mv_list",
                        {"cursor": None, "limit": limit, "timeout_ms": 500},
                    )
                self.assertFalse(result.isError)
                func.assert_called_once_with(
                    cursor=None, limit=limit, client=mock.ANY, timeout_ms=500
                )

    def test_propose_success(self):
        proposal = {"schema": "action_proposal/v0.2", "proposal_id": "p-1"}
        verdict = {"schema": "action_verdict/v0.2", "decision": "admitted"}
        with mock.patch.object(
            tools_mod, "propose", return_value=verdict
        ) as func:
            result, stub = _call(
                "mv_propose", {"proposal": proposal, "timeout_ms": 500}
            )
        self.assertFalse(result.isError)
        self.assertEqual(result.structuredContent, verdict)
        func.assert_called_once_with(
            proposal, client=mock.ANY, timeout_ms=500
        )
        self.assertEqual(stub.calls, [])

    def test_wait_verify_success(self):
        expectation = {"type": "text_present", "text": "done"}
        receipt = {"schema": "action_receipt/v0.2", "verified": True}
        with mock.patch.object(
            tools_mod, "wait_verify", return_value=receipt
        ) as func:
            result, stub = _call(
                "mv_wait_verify",
                {
                    "proposal_id": "p-1",
                    "expectation": expectation,
                    "timeout_ms": 500,
                },
            )
        self.assertFalse(result.isError)
        self.assertEqual(result.structuredContent, receipt)
        func.assert_called_once_with(
            "p-1", expectation, 500, client=mock.ANY
        )
        self.assertEqual(stub.calls, [])


class TestInvalidArgs(unittest.TestCase):
    def test_unknown_tool_never_dispatches(self):
        patches = _patched_all()
        with patches[0] as m0, patches[1] as m1, patches[2] as m2, patches[3] as m3:
            result, stub = _call("mv_bogus", {})
        self.assertTrue(result.isError)
        self.assertEqual(result.structuredContent, {"code": "unknown_tool"})
        self.assertEqual(result.content[0].text, "unknown tool")
        for func in (m0, m1, m2, m3):
            func.assert_not_called()
        self.assertEqual(stub.calls, [])

    def test_extra_property_refused(self):
        with mock.patch.object(
            tools_mod, "observe", return_value={"ok": True}
        ) as func:
            result, _ = _call(
                "mv_observe",
                {"surface_id": "s-1", "timeout_ms": 500, "junk": 1},
            )
        self.assertTrue(result.isError)
        self.assertEqual(result.structuredContent, {"code": "invalid_arguments"})
        func.assert_not_called()

    def test_missing_property_refused(self):
        with mock.patch.object(
            tools_mod, "observe", return_value={"ok": True}
        ) as func:
            result, _ = _call("mv_observe", {"surface_id": "s-1"})
        self.assertTrue(result.isError)
        self.assertEqual(result.structuredContent, {"code": "invalid_arguments"})
        func.assert_not_called()

    def test_none_arguments_refused(self):
        with mock.patch.object(
            tools_mod, "observe", return_value={"ok": True}
        ) as func:
            result, _ = _call("mv_observe", None)
        self.assertTrue(result.isError)
        self.assertEqual(result.structuredContent, {"code": "invalid_arguments"})
        func.assert_not_called()

    def test_timeout_ms_rails(self):
        bad = (0, -1, 60001, True, False, 1.5, "500", None, float("nan"), 10**30)
        for timeout in bad:
            with self.subTest(timeout=timeout):
                with mock.patch.object(
                    tools_mod, "observe", return_value={"ok": True}
                ) as func:
                    result, _ = _call(
                        "mv_observe",
                        {"surface_id": "s-1", "timeout_ms": timeout},
                    )
                self.assertTrue(result.isError)
                self.assertEqual(
                    result.structuredContent, {"code": "invalid_arguments"}
                )
                func.assert_not_called()

    def test_surface_id_shape(self):
        bad = ("", "has space", "bad!", "x" * 129, 123, None, True, ["s"], "a\x00b")
        for surface_id in bad:
            with self.subTest(surface_id=surface_id):
                with mock.patch.object(
                    tools_mod, "observe", return_value={"ok": True}
                ) as func:
                    result, _ = _call(
                        "mv_observe",
                        {"surface_id": surface_id, "timeout_ms": 500},
                    )
                self.assertTrue(result.isError)
                self.assertEqual(
                    result.structuredContent, {"code": "invalid_arguments"}
                )
                func.assert_not_called()

    def test_limit_rails(self):
        bad = (0, 257, -3, True, "10", None, 2.0)
        for limit in bad:
            with self.subTest(limit=limit):
                with mock.patch.object(
                    tools_mod, "list_surfaces", return_value={"ok": True}
                ) as func:
                    result, _ = _call(
                        "mv_list",
                        {"cursor": None, "limit": limit, "timeout_ms": 500},
                    )
                self.assertTrue(result.isError)
                self.assertEqual(
                    result.structuredContent, {"code": "invalid_arguments"}
                )
                func.assert_not_called()

    def test_cursor_shape(self):
        bad = ("", "bad!", 123, True, ["c"], {"c": 1})
        for cursor in bad:
            with self.subTest(cursor=cursor):
                with mock.patch.object(
                    tools_mod, "list_surfaces", return_value={"ok": True}
                ) as func:
                    result, _ = _call(
                        "mv_list",
                        {"cursor": cursor, "limit": 10, "timeout_ms": 500},
                    )
                self.assertTrue(result.isError)
                self.assertEqual(
                    result.structuredContent, {"code": "invalid_arguments"}
                )
                func.assert_not_called()

    def test_proposal_must_be_object(self):
        bad = (None, [], "x", 5, True)
        for proposal in bad:
            with self.subTest(proposal=proposal):
                with mock.patch.object(
                    tools_mod, "propose", return_value={"ok": True}
                ) as func:
                    result, _ = _call(
                        "mv_propose",
                        {"proposal": proposal, "timeout_ms": 500},
                    )
                self.assertTrue(result.isError)
                self.assertEqual(
                    result.structuredContent, {"code": "invalid_arguments"}
                )
                func.assert_not_called()

    def test_expectation_must_be_object(self):
        bad = (None, [], "x", 5, True)
        for expectation in bad:
            with self.subTest(expectation=expectation):
                with mock.patch.object(
                    tools_mod, "wait_verify", return_value={"ok": True}
                ) as func:
                    result, _ = _call(
                        "mv_wait_verify",
                        {
                            "proposal_id": "p-1",
                            "expectation": expectation,
                            "timeout_ms": 500,
                        },
                    )
                self.assertTrue(result.isError)
                self.assertEqual(
                    result.structuredContent, {"code": "invalid_arguments"}
                )
                func.assert_not_called()

    def test_proposal_id_shape(self):
        bad = ("", "bad!", "x" * 129, None, 7, True)
        for proposal_id in bad:
            with self.subTest(proposal_id=proposal_id):
                with mock.patch.object(
                    tools_mod, "wait_verify", return_value={"ok": True}
                ) as func:
                    result, _ = _call(
                        "mv_wait_verify",
                        {
                            "proposal_id": proposal_id,
                            "expectation": {},
                            "timeout_ms": 500,
                        },
                    )
                self.assertTrue(result.isError)
                self.assertEqual(
                    result.structuredContent, {"code": "invalid_arguments"}
                )
                func.assert_not_called()


class TestMapping(unittest.TestCase):
    def test_refusal_codes_verbatim(self):
        for code in _REASONS:
            for seq in (41, None):
                with self.subTest(code=code, seq=seq):
                    with mock.patch.object(
                        tools_mod,
                        "observe",
                        side_effect=tools_mod.ToolRefusal(code, seq),
                    ):
                        result, _ = _call(
                            "mv_observe",
                            {"surface_id": "s-1", "timeout_ms": 500},
                        )
                    self.assertTrue(result.isError)
                    self.assertIn(code, result.content[0].text)
                    self.assertEqual(
                        result.structuredContent,
                        {"reason_code": code, "core_seq": seq},
                    )

    def test_refusal_with_bad_shape_is_internal(self):
        bad = [
            tools_mod.ToolRefusal("NOPE", 1),
            tools_mod.ToolRefusal("NOPE", None),
            tools_mod.ToolRefusal("POLICY", 0),
            tools_mod.ToolRefusal("POLICY", True),
            tools_mod.ToolRefusal("POLICY", "7"),
            tools_mod.ToolRefusal(None, 1),
            tools_mod.ToolRefusal("", None),
        ]
        for exc in bad:
            with self.subTest(exc=repr(exc)):
                with mock.patch.object(
                    tools_mod, "observe", side_effect=exc
                ):
                    result, _ = _call(
                        "mv_observe",
                        {"surface_id": "s-1", "timeout_ms": 500},
                    )
                self.assertTrue(result.isError)
                self.assertEqual(
                    result.structuredContent, {"code": "internal_error"}
                )

    def test_verification_failed_echoes_receipt(self):
        receipt = {"schema": "action_receipt/v0.2", "verified": False}
        with mock.patch.object(
            tools_mod,
            "wait_verify",
            side_effect=tools_mod.VerificationFailed(receipt),
        ):
            result, _ = _call(
                "mv_wait_verify",
                {
                    "proposal_id": "p-1",
                    "expectation": {},
                    "timeout_ms": 500,
                },
            )
        self.assertTrue(result.isError)
        self.assertEqual(result.content[0].text, "verification failed")
        self.assertEqual(
            result.structuredContent,
            {"code": "verification_failed", "receipt": receipt},
        )

    def test_verification_failed_bad_receipt_is_internal(self):
        with mock.patch.object(
            tools_mod,
            "wait_verify",
            side_effect=tools_mod.VerificationFailed("not-a-dict"),
        ):
            result, _ = _call(
                "mv_wait_verify",
                {
                    "proposal_id": "p-1",
                    "expectation": {},
                    "timeout_ms": 500,
                },
            )
        self.assertTrue(result.isError)
        self.assertEqual(result.structuredContent, {"code": "internal_error"})

    def test_validation_error_never_echoes(self):
        errors = [
            tools_mod.ToolValidationError(_CANARY),
            ValueError(_CANARY),
        ]
        for exc in errors:
            with self.subTest(exc=type(exc).__name__):
                with mock.patch.object(
                    tools_mod, "propose", side_effect=exc
                ):
                    result, _ = _call(
                        "mv_propose",
                        {"proposal": {"a": 1}, "timeout_ms": 500},
                    )
                self.assertTrue(result.isError)
                self.assertEqual(
                    result.structuredContent, {"code": "validation_error"}
                )
                self.assertNotIn(_CANARY, result.content[0].text)

    def test_timeout_never_fabricates_core_metadata(self):
        with mock.patch.object(
            tools_mod, "observe", side_effect=TimeoutError("slow")
        ):
            result, _ = _call(
                "mv_observe", {"surface_id": "s-1", "timeout_ms": 500}
            )
        self.assertTrue(result.isError)
        self.assertEqual(result.structuredContent, {"code": "timeout"})
        self.assertNotIn("reason_code", result.structuredContent)
        self.assertNotIn("core_seq", result.structuredContent)

    def test_client_error_leak_mapping(self):
        leaked = type("ClientError", (Exception,), {})
        cases = [
            ("timeout", {"code": "timeout"}),
            ("unknown_version", {"code": "unknown_version"}),
            ("socket", {"code": "transport_error"}),
            ("length", {"code": "transport_error"}),
            ("bogus", {"code": "transport_error"}),
        ]
        for code, want in cases:
            with self.subTest(code=code):
                exc = leaked("transport")
                exc.code = code
                with mock.patch.object(
                    tools_mod, "observe", side_effect=exc
                ):
                    result, _ = _call(
                        "mv_observe",
                        {"surface_id": "s-1", "timeout_ms": 500},
                    )
                self.assertTrue(result.isError)
                self.assertEqual(result.structuredContent, want)

    def test_unexpected_error_never_echoes(self):
        with mock.patch.object(
            tools_mod, "observe", side_effect=RuntimeError(_CANARY)
        ):
            result, _ = _call(
                "mv_observe", {"surface_id": "s-1", "timeout_ms": 500}
            )
        self.assertTrue(result.isError)
        self.assertEqual(result.structuredContent, {"code": "internal_error"})
        self.assertNotIn(_CANARY, result.content[0].text)

    def test_non_dict_payload_is_internal(self):
        with mock.patch.object(
            tools_mod, "observe", return_value=["not", "a", "dict"]
        ):
            result, _ = _call(
                "mv_observe", {"surface_id": "s-1", "timeout_ms": 500}
            )
        self.assertTrue(result.isError)
        self.assertEqual(result.structuredContent, {"code": "internal_error"})

    def test_non_serializable_payload_is_internal(self):
        bad = ({"x": object()}, {"x": float("nan")}, {"x": float("inf")})
        for payload in bad:
            with self.subTest(payload=repr(payload)):
                with mock.patch.object(
                    tools_mod, "observe", return_value=payload
                ):
                    result, _ = _call(
                        "mv_observe",
                        {"surface_id": "s-1", "timeout_ms": 500},
                    )
                self.assertTrue(result.isError)
                self.assertEqual(
                    result.structuredContent, {"code": "internal_error"}
                )

    def test_missing_tools_module_is_internal(self):
        with mock.patch.object(
            mcp_server, "_get_tools", side_effect=ImportError("gone")
        ):
            result, _ = _call(
                "mv_observe", {"surface_id": "s-1", "timeout_ms": 500}
            )
        self.assertTrue(result.isError)
        self.assertEqual(result.structuredContent, {"code": "internal_error"})

    def test_drifted_tools_module_is_internal(self):
        drifted = [object(), {"observe": True}]
        for module in drifted:
            with self.subTest(module=repr(module)):
                with mock.patch.object(
                    mcp_server, "_get_tools", return_value=module
                ):
                    result, _ = _call(
                        "mv_observe",
                        {"surface_id": "s-1", "timeout_ms": 500},
                    )
                self.assertTrue(result.isError)
                self.assertEqual(
                    result.structuredContent, {"code": "internal_error"}
                )


class TestSnapshot(unittest.TestCase):
    def test_success_result_resists_later_mutation(self):
        payload = {"nested": {"k": "v"}, "n": 1}
        with mock.patch.object(
            tools_mod, "observe", return_value=payload
        ):
            result, _ = _call(
                "mv_observe", {"surface_id": "s-1", "timeout_ms": 500}
            )
        payload["nested"]["k"] = "MUTATED"
        payload["n"] = 999
        self.assertEqual(
            result.structuredContent, {"nested": {"k": "v"}, "n": 1}
        )
        self.assertEqual(
            json.loads(result.content[0].text),
            {"nested": {"k": "v"}, "n": 1},
        )


class TestClientChecks(unittest.TestCase):
    def test_create_server_rejects_bad_client(self):
        for client in (None, object(), 42, "x"):
            with self.subTest(client=repr(client)):
                with self.assertRaises(TypeError):
                    mcp_server.create_server(client=client)

    def test_serve_rejects_bad_client(self):
        async def _main():
            await mcp_server.serve(client=None)

        with self.assertRaises(TypeError):
            asyncio.run(_main())


class TestDirectDefense(unittest.TestCase):
    def test_direct_exotic_arguments_rejected(self):
        for arguments in (None, [], "x", 5, True):
            with self.subTest(arguments=repr(arguments)):
                with mock.patch.object(
                    tools_mod, "observe", return_value={"ok": True}
                ) as func:
                    result = _direct("mv_observe", arguments)
                self.assertTrue(result.isError)
                self.assertEqual(
                    result.structuredContent, {"code": "invalid_arguments"}
                )
                func.assert_not_called()

    def test_direct_unknown_name_types_rejected(self):
        patches = _patched_all()
        for name in (None, 123, ["mv_observe"], {"n": 1}):
            with self.subTest(name=repr(name)):
                with patches[0] as m0, patches[1] as m1, patches[2] as m2, patches[3] as m3:
                    result = _direct(name, {})
                self.assertTrue(result.isError)
                self.assertEqual(
                    result.structuredContent, {"code": "unknown_tool"}
                )
                for func in (m0, m1, m2, m3):
                    func.assert_not_called()


class TestStdio(unittest.TestCase):
    def test_round_trip_hygiene_and_clean_eof(self):
        frames = [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": mcp_server.PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "stdio-test", "version": "0.0.0"},
                },
            },
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "mv_list",
                    "arguments": {
                        "cursor": None,
                        "limit": 10,
                        "timeout_ms": 500,
                    },
                },
            },
            {
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "mv_observe",
                    "arguments": {"surface_id": "s-1", "timeout_ms": 0},
                },
            },
        ]
        body = "".join(
            json.dumps(frame, separators=(",", ":")) + "\n" for frame in frames
        )
        in_buf = _KeepOpen(body.encode("utf-8"))
        out_buf = _KeepOpen()
        fake_in = io.TextIOWrapper(in_buf, encoding="utf-8")
        fake_out = io.TextIOWrapper(
            out_buf, encoding="utf-8", write_through=True
        )
        payload = {"surfaces": [], "next_cursor": None}

        async def _main():
            await asyncio.wait_for(mcp_server.serve(client=_StubClient()), 15)

        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(sys, "stdin", fake_in))
            stack.enter_context(mock.patch.object(sys, "stdout", fake_out))
            listed = stack.enter_context(
                mock.patch.object(
                    tools_mod, "list_surfaces", return_value=payload
                )
            )
            observed = stack.enter_context(
                mock.patch.object(
                    tools_mod, "observe", return_value={"ok": True}
                )
            )
            asyncio.run(_main())
        listed.assert_called_once_with(
            cursor=None, limit=10, client=mock.ANY, timeout_ms=500
        )
        observed.assert_not_called()
        # Read the raw buffer: the stdio layer owns sibling wrappers that
        # may already be torn down, while BytesIO keeps its bytes.
        raw = out_buf.getvalue().decode("utf-8")
        lines = [line for line in raw.split("\n") if line]
        self.assertGreaterEqual(len(lines), 4)
        by_id = {}
        for line in lines:
            message = json.loads(line)
            self.assertEqual(message.get("jsonrpc"), "2.0")
            self.assertIn("id", message)
            by_id[message["id"]] = message
        self.assertEqual(
            by_id[1]["result"]["serverInfo"]["name"], "metaviewer-mvctl"
        )
        self.assertEqual(
            [tool["name"] for tool in by_id[2]["result"]["tools"]],
            ["mv_observe", "mv_list", "mv_propose", "mv_wait_verify"],
        )
        self.assertFalse(by_id[3]["result"]["isError"])
        self.assertEqual(
            by_id[3]["result"]["structuredContent"], payload
        )
        self.assertTrue(by_id[4]["result"]["isError"])
        self.assertEqual(
            by_id[4]["result"]["structuredContent"],
            {"code": "invalid_arguments"},
        )


class TestWireDefense(unittest.TestCase):
    def run_frames(self, raw, cap=None):
        source, sink = io.BytesIO(raw), io.BytesIO()
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(sys, "stdin", SimpleNamespace(buffer=source)))
            stack.enter_context(mock.patch.object(sys, "stdout", SimpleNamespace(buffer=sink)))
            if cap is not None:
                stack.enter_context(mock.patch.object(mcp_server, "MAX_FRAME_BYTES", cap))
            asyncio.run(mcp_server.serve(client=_StubClient()))
        return [json.loads(line) for line in sink.getvalue().splitlines()]

    def test_parse_mutants_never_dispatch(self):
        for raw in (b'{"jsonrpc":"2.0","id":1,"id":2}\n',
                    b'{"x":NaN}\n', b'\xff\n', b'{{}\n'):
            with self.subTest(raw=raw):
                with mock.patch.object(mcp_server.Server, "handle") as dispatch:
                    replies = self.run_frames(raw)
                dispatch.assert_not_called()
                self.assertEqual(replies[0]["error"]["code"], -32700)
                self.assertIsNone(replies[0]["id"])

    def test_framing_failure_closes_instead_of_processing_tail(self):
        with mock.patch.object(mcp_server.Server, "handle") as dispatch:
            replies = self.run_frames(b'x' * 128 + b'\n{}\n', cap=128)
        dispatch.assert_not_called()
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0]["error"]["code"], -32700)
        self.assertEqual(self.run_frames(b'{}')[0]["error"]["code"], -32700)

    def test_initialization_and_rpc_negative_controls(self):
        server = mcp_server.create_server(client=_StubClient())
        def request(method, params=None):
            return asyncio.run(server.handle({"jsonrpc": "2.0", "id": 7,
                                             "method": method, "params": params or {}}))
        self.assertEqual(request("tools/list")["error"]["code"], -32000)
        self.assertEqual(request("initialize")["error"]["code"], -32602)
        initialized = request("initialize", {"protocolVersion": mcp_server.PROTOCOL_VERSION,
                                              "capabilities": {}, "clientInfo": {}})
        self.assertIn("result", initialized)
        self.assertEqual(request("ping")["result"], {})
        self.assertEqual(request("unknown")["error"]["code"], -32601)
        self.assertEqual(request("tools/list", {"extra": True})["error"]["code"], -32602)
        self.assertEqual(request("tools/call", {"name": []})["error"]["code"], -32602)
        self.assertIsNone(asyncio.run(server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"})))
        for value in (None, [], {}, {"jsonrpc": "2.0", "method": "ping", "id": True}):
            self.assertEqual(asyncio.run(server.handle(value))["error"]["code"], -32600)

    def test_oversized_response_is_typed_error(self):
        server = mcp_server.create_server(client=_StubClient())
        init = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"protocolVersion": mcp_server.PROTOCOL_VERSION,
                           "capabilities": {}, "clientInfo": {}}}
        raw = (json.dumps(init) + '\n' + json.dumps({"jsonrpc": "2.0", "id": 2,
                                                     "method": "tools/list"}) + '\n').encode()
        replies = self.run_frames(raw, cap=256)
        self.assertIn("result", replies[0])
        self.assertEqual(replies[1]["id"], 2)
        self.assertEqual(replies[1]["error"]["code"], -32603)


if __name__ == "__main__":
    unittest.main()
