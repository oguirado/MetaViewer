"""MCP JSON-RPC conformance suite (SW-0217 AP-01 / INV-CONS-01)."""

import asyncio
import io
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from metaviewer_agents.mcp_server import MAX_FRAME_BYTES, serve


class _DummyClient:
    def __init__(self):
        self.calls = []

    def request(self, body, expect, *, timeout_ms):
        self.calls.append((body, expect, timeout_ms))
        if body.get("op") == "observe":
            return {
                "schema": "mv_tool_result/v0.2",
                "request_id": body["request_id"],
                "op": "observe",
                "status": "ok",
                "observation": {
                    "schema": "observation/v0.1",
                    "frame_ref": {
                        "schema": "frame_ref/v0.1",
                        "surface_id": body["args"]["surface_id"],
                        "generation": 1,
                        "tick": 0,
                        "ts_ns": 0,
                        "width": 100,
                        "height": 100,
                        "format": "rgb24",
                        "ramws_path": "/dev/shm/test",
                        "sha256": "0" * 64,
                        "capture_us": 0,
                    },
                },
            }
        return {}


class McpConformanceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = _DummyClient()

    async def _run_serve_with_input(self, input_bytes: bytes) -> bytes:
        stdin_mock = SimpleNamespace(buffer=io.BytesIO(input_bytes))
        stdout_mock = SimpleNamespace(buffer=io.BytesIO())

        with mock.patch.object(sys, "stdin", stdin_mock), mock.patch.object(
            sys, "stdout", stdout_mock
        ):
            await serve(client=self.client)

        return stdout_mock.buffer.getvalue()

    async def test_frame_boundary_exact_max_frame_bytes_vs_plus_one(self):
        # Exact MAX_FRAME_BYTES message
        msg = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1.0"},
                "padding": "x" * (MAX_FRAME_BYTES - 200),
            },
        }
        line = json.dumps(msg).encode("utf-8") + b"\n"
        if len(line) <= MAX_FRAME_BYTES:
            pad_len = MAX_FRAME_BYTES - len(line)
            msg["params"]["padding"] += "x" * pad_len
            line = json.dumps(msg).encode("utf-8") + b"\n"

        out = await self._run_serve_with_input(line)
        self.assertTrue(len(out) > 0)
        res = json.loads(out.strip())
        self.assertEqual(res.get("id"), 1)
        self.assertIn("result", res)

        # MAX_FRAME_BYTES + 1 byte
        line_over = b"{" + b"a" * (MAX_FRAME_BYTES) + b"}\n"
        subsequent_req = (
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "ping"}).encode(
                "utf-8"
            )
            + b"\n"
        )
        out_over = await self._run_serve_with_input(line_over + subsequent_req)
        lines = [l for l in out_over.split(b"\n") if l]
        self.assertEqual(len(lines), 1)
        res_over = json.loads(lines[0])
        self.assertEqual(res_over["error"]["code"], -32700)

    async def test_notifications_produce_no_output(self):
        notification = (
            json.dumps({"jsonrpc": "2.0", "method": "initialized"}).encode(
                "utf-8"
            )
            + b"\n"
        )
        out = await self._run_serve_with_input(notification)
        self.assertEqual(out, b"")

    async def test_tools_before_initialize_returns_minus_32000(self):
        tool_req = (
            json.dumps({
                "jsonrpc": "2.0",
                "id": 10,
                "method": "tools/list",
                "params": {},
            }).encode("utf-8")
            + b"\n"
        )

        out = await self._run_serve_with_input(tool_req)
        res = json.loads(out.strip())
        self.assertEqual(res["error"]["code"], -32000)
        self.assertEqual(res["error"]["message"], "Initialize first")

    async def test_jsonrpc_error_codes(self):
        init = (
            json.dumps({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1.0"},
                },
            }).encode("utf-8")
            + b"\n"
        )

        # Unknown method -> -32601
        unk_method = (
            json.dumps({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "unknown_foo",
            }).encode("utf-8")
            + b"\n"
        )
        out1 = await self._run_serve_with_input(init + unk_method)
        lines1 = [l for l in out1.split(b"\n") if l]
        res1 = json.loads(lines1[1])
        self.assertEqual(res1["error"]["code"], -32601)

        # Bad params -> -32602
        bad_params = (
            json.dumps({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": "not-a-dict",
            }).encode("utf-8")
            + b"\n"
        )
        out2 = await self._run_serve_with_input(init + bad_params)
        lines2 = [l for l in out2.split(b"\n") if l]
        res2 = json.loads(lines2[1])
        self.assertEqual(res2["error"]["code"], -32602)

    async def test_stdout_carries_frames_and_nothing_else(self):
        init = (
            json.dumps({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1.0"},
                },
            }).encode("utf-8")
            + b"\n"
        )

        out = await self._run_serve_with_input(init)
        for line in out.splitlines():
            if line:
                parsed = json.loads(line)
                self.assertIn("jsonrpc", parsed)

    async def test_unknown_tool_never_dispatches(self):
        init = (
            json.dumps({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1.0"},
                },
            }).encode("utf-8")
            + b"\n"
        )

        call_unk = (
            json.dumps({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "nonexistent_tool", "arguments": {}},
            }).encode("utf-8")
            + b"\n"
        )

        out = await self._run_serve_with_input(init + call_unk)
        lines = [l for l in out.split(b"\n") if l]
        res = json.loads(lines[1])
        self.assertTrue(res["result"]["isError"])
        self.assertEqual(
            res["result"]["structuredContent"]["code"], "unknown_tool"
        )
        self.assertEqual(len(self.client.calls), 0)


if __name__ == "__main__":
    unittest.main()
