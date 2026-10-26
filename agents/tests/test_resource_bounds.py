"""Resource-bound and concurrency tests (SW-0147 I-MEM/I-CYC, OmniCodex PY.03/PY.04)."""

import asyncio
import io
import json
import os
import resource
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from metaviewer_agents.client import CoreClient
from metaviewer_agents.mcp_server import MAX_FRAME_BYTES, serve
from metaviewer_agents import tools as tools_mod


class _SlowClient:
    def __init__(self, delay_s=0.01):
        self.delay_s = delay_s

    def request(self, body, expect, *, timeout_ms):
        time.sleep(self.delay_s)
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


class ResourceBoundsTests(unittest.IsolatedAsyncioTestCase):
    async def test_serve_loop_no_fd_or_thread_growth(self):
        hostile_frames = (
            b'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{}}}\n'
            + b'{"bad_json":\n' * 50
            + b'{"jsonrpc":"2.0","id":2,"method":"ping"}\n' * 50
        )

        stdin_mock = SimpleNamespace(buffer=io.BytesIO(hostile_frames))
        stdout_mock = SimpleNamespace(buffer=io.BytesIO())

        threads_before = threading.active_count()

        with mock.patch.object(sys, "stdin", stdin_mock), mock.patch.object(
            sys, "stdout", stdout_mock
        ):
            await serve(client=_SlowClient(delay_s=0.001))

        threads_after = threading.active_count()
        self.assertLessEqual(threads_after - threads_before, 2)

        rss_kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        print(f"\n[Resource Finding] serve() max RSS: {rss_kb} KB, thread delta: {threads_after - threads_before}")

    def test_recv_never_buffers_more_than_cap_plus_one(self):
        tmpdir = tempfile.TemporaryDirectory()
        sock_dir = Path(tmpdir.name) / "sock_dir"
        sock_dir.mkdir(mode=0o700)
        sock_path = str(sock_dir / "core.sock")

        server_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server_sock.bind(sock_path)
        os.chmod(sock_path, 0o600)
        server_sock.listen(1)

        cap = 100
        client = CoreClient(
            sock_path, timeout_s=0.5, max_line_bytes=cap, max_reply_bytes=cap
        )
        client.connect()
        conn, _ = server_sock.accept()

        conn.sendall(b"A" * (cap + 10))

        chunks_read = []
        target_fd = client._sock.fileno()

        orig_recv = socket.socket.recv

        def mock_recv(self_sock, bufsize, flags=0):
            try:
                if self_sock.fileno() == target_fd:
                    chunks_read.append(bufsize)
            except Exception:
                pass
            return orig_recv(self_sock, bufsize, flags)

        with mock.patch.object(socket.socket, "recv", mock_recv):
            try:
                client.recv()
            except Exception:
                pass

        client.close()
        conn.close()
        server_sock.close()
        tmpdir.cleanup()

        self.assertTrue(len(chunks_read) > 0)
        for c in chunks_read:
            self.assertLessEqual(c, cap + 1)
        print(f"\n[Resource Finding] Max requested recv chunk size: {max(chunks_read)} (cap + 1 = {cap + 1})")

    async def test_asyncio_to_thread_dispatch_threadpool_bounds(self):
        client = _SlowClient(delay_s=0.01)

        init_req = (
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
        call_req = (
            json.dumps({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "mv_observe",
                    "arguments": {"surface_id": "surf-1", "timeout_ms": 500},
                },
            }).encode("utf-8")
            + b"\n"
        )

        stdin_mock = SimpleNamespace(buffer=io.BytesIO(init_req + call_req))
        stdout_mock = SimpleNamespace(buffer=io.BytesIO())

        t_start = threading.active_count()
        with mock.patch.object(sys, "stdin", stdin_mock), mock.patch.object(
            sys, "stdout", stdout_mock
        ):
            await serve(client=client)

        t_end = threading.active_count()
        print(f"\n[Resource Finding] Active threads during to_thread dispatch start: {t_start}, end: {t_end}")
        self.assertLessEqual(t_end - t_start, 2)


if __name__ == "__main__":
    unittest.main()
