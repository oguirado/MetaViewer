"""R3-AGENTS-RPC-1: record correlation, sequence durability, receipt binding, CLI taxonomy."""

from __future__ import annotations

import contextlib
import copy
import fcntl
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

TESTS_DIR = Path(__file__).resolve().parent
ROOT = TESTS_DIR.parents[0]
sys.path.insert(0, str(TESTS_DIR))
sys.path.insert(0, str(ROOT))

import test_mvctl_v02 as cli_fixture
import test_tools as tool_fixture
from metaviewer_agents import client as client_mod
from metaviewer_agents import mvctl, tools, verify
from metaviewer_agents.client import ClientError, CoreClient, ToolClient
from metaviewer_agents.envelope import make_envelope, validate_envelope


def _record_event(call: dict, event: str, *, mono_ns: int = 10, **fields) -> dict:
    params = call["params"]
    return {
        "schema": "record_event/v0.2",
        "request_id": call["request_id"],
        "surface_id": params["surface_id"],
        "recording_id": params["recording_id"],
        "event": event,
        "mono_ns": mono_ns,
        **fields,
    }


def _open_sequence_state(tc: ToolClient) -> int:
    fd = os.open(tc.sequence_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    tc._sequence_fd = fd
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    raw = os.read(fd, 32)
    tc.active._next_seq = int(raw) if raw else 1
    return tc.active.next_seq


@contextlib.contextmanager
def _unix_core_or_inmemory(replies):
    """Run MvctlV02Tests.core over AF_UNIX, falling back cleanly if bind is denied."""
    harness = cli_fixture.MvctlV02Tests()
    try:
        with harness.core(replies) as (sock, calls):
            yield sock, calls
            return
    except PermissionError:
        pass

    with tempfile.TemporaryDirectory(prefix="mvctl-mem-") as directory:
        sock = Path(directory) / "core.sock"
        sock.write_text("", encoding="utf-8")
        calls: list[dict] = []
        queue = [list(builders) for builders in replies]

        def fake_connect(self_core):
            self_core._session_builders = queue.pop(0) if queue else []
            self_core._seq = 0
            return copy.deepcopy(cli_fixture.registration("core")["hello"])

        def fake_call(self_core, envelope_msg):
            validated = validate_envelope(copy.deepcopy(envelope_msg))
            calls.append(validated)
            builders = getattr(self_core, "_session_builders", [])
            builder = builders.pop(0)
            body = builder(validated["body"])
            self_core._seq = getattr(self_core, "_seq", 0) + 1
            reply = make_envelope(
                msg_id="reply",
                from_component="core",
                from_instance="core-1",
                to_component="agent",
                to_instance="agent-1",
                session_id="sess-1",
                seq=self_core._seq,
                body=body,
            )
            return validate_envelope(reply)

        with patch.object(CoreClient, "connect", fake_connect), \
                patch.object(CoreClient, "call", fake_call), \
                patch.object(CoreClient, "close", lambda self_core: None):
            yield sock, calls


class R3AgentsRpcTests(unittest.TestCase):
    def _cli_argv(self, command: str, sock: Path, *extra: str) -> list[str]:
        return [
            command,
            "--socket", str(sock),
            "--session-id", "sess-1",
            "--agent-instance", "agent-1",
            "--core-instance", "core-1",
            "--timeout-ms", "2000",
            "--max-line-bytes", "65536",
            "--max-reply-bytes", "65536",
            *extra,
        ]

    def test_t3r3_01_record_event_correlation_and_single_stop_budget(self) -> None:
        replies = [
            [lambda call: _record_event(call, "started", mono_ns=10, mode="ram")],
            [
                lambda call: _record_event(
                    call, "frame_captured", mono_ns=11,
                    ram_path="/dev/shm/mv-r3-frame-1.rgb",
                    sha256="ab" * 32, byte_count=64),
                lambda call: _record_event(
                    call, "stopped", mono_ns=12, frame_count=1, byte_count=64),
            ],
        ]
        with _unix_core_or_inmemory(replies) as (sock, calls):
            root = sock.parent
            trusted = root / "trusted.json"
            trusted.write_text(json.dumps(cli_fixture.config()), encoding="utf-8")
            start_path = root / "start.json"
            stop_path = root / "stop.json"
            start_path.write_text(json.dumps({
                "schema": "record_request/v0.2",
                "request_id": "req-r3-start",
                "op": "ram_start",
                "params": {
                    "surface_id": "surf-1",
                    "recording_id": "rec-1",
                    "ring_bytes": 4096,
                    "max_fps": 30,
                },
            }), encoding="utf-8")
            stop_path.write_text(json.dumps({
                "schema": "record_request/v0.2",
                "request_id": "req-r3-stop",
                "op": "ram_stop",
                "params": {
                    "surface_id": "surf-1",
                    "recording_id": "rec-1",
                },
            }), encoding="utf-8")

            with patch.dict(os.environ, {"MV_CORE_CONFIG": str(trusted)}):
                out1, err1 = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(out1), contextlib.redirect_stderr(err1):
                    rc1 = mvctl.run(self._cli_argv("record-start", sock, "--json-arg", str(start_path)))
                self.assertEqual((rc1, err1.getvalue()), (0, ""))
                self.assertEqual(json.loads(out1.getvalue())["event"], "started")

                out2, err2 = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(out2), contextlib.redirect_stderr(err2):
                    rc2 = mvctl.run(self._cli_argv("record-stop", sock, "--json-arg", str(stop_path)))
                self.assertEqual((rc2, err2.getvalue()), (0, ""))
                stopped = json.loads(out2.getvalue())
                self.assertEqual(stopped["event"], "stopped")
                self.assertEqual(stopped["frame_count"], 1)
            self.assertEqual(len(calls), 3)

        # Verify ToolClient.request rejects uncorrelated record_event replies
        # and preserves strict op correlation for mv_tool_result/v0.2.
        cfg = cli_fixture.config()
        bad_cases = [
            (
                "record_event/v0.2",
                {
                    "schema": "record_request/v0.2",
                    "request_id": "req-1",
                    "op": "ram_start",
                    "params": {
                        "surface_id": "surf-1",
                        "recording_id": "rec-1",
                        "ring_bytes": 4096,
                        "max_fps": 30,
                    },
                },
                lambda call: dict(_record_event(call, "started", mode="ram"), surface_id="surf-other"),
            ),
            (
                "record_event/v0.2",
                {
                    "schema": "record_request/v0.2",
                    "request_id": "req-2",
                    "op": "ram_start",
                    "params": {
                        "surface_id": "surf-1",
                        "recording_id": "rec-1",
                        "ring_bytes": 4096,
                        "max_fps": 30,
                    },
                },
                lambda call: dict(_record_event(call, "started", mode="ram"), recording_id="rec-other"),
            ),
            (
                "mv_tool_result/v0.2",
                {
                    "schema": "mv_tool_call/v0.2",
                    "request_id": "req-4",
                    "op": "observe",
                    "args": {"surface_id": "surf-1"},
                },
                lambda call: {
                    "schema": "mv_tool_result/v0.2",
                    "request_id": call["request_id"],
                    "op": "list",
                    "status": "ok",
                    "surfaces": [],
                    "next_cursor": None,
                },
            ),
        ]
        for idx, (expect_schema, req_body, reply_builder) in enumerate(bad_cases):
            with self.subTest(bad_case=idx):
                with _unix_core_or_inmemory([[reply_builder]]) as (sock, _):
                    with ToolClient(
                        str(sock),
                        session_id="sess-1",
                        local=cfg["peers"][0],
                        core=cfg["core"],
                        dependency_pins=[],
                        sequence_path=str(sock.parent / f"neg-{idx}.seq"),
                        timeout_s=2.0,
                        max_line_bytes=65536,
                        max_reply_bytes=65536,
                    ) as tc:
                        with self.assertRaises(tools.ToolValidationError):
                            tc.request(copy.deepcopy(req_body), expect_schema, timeout_ms=2000)

        # Confirm record_event/v0.2 has additionalProperties: false and zero op field.
        from metaviewer_agents.envelope import EnvelopeError
        with self.assertRaises(EnvelopeError):
            make_envelope(
                msg_id="bad-rec-op",
                from_component="core",
                from_instance="core-1",
                to_component="agent",
                to_instance="agent-1",
                session_id="sess-1",
                seq=1,
                body={
                    "schema": "record_event/v0.2",
                    "request_id": "req-3",
                    "surface_id": "surf-1",
                    "recording_id": "rec-1",
                    "event": "started",
                    "mono_ns": 10,
                    "mode": "ram",
                    "op": "ram_start",
                },
            )

        # Verify record_stop enforces a single overall monotonic deadline budget.
        seen_timeouts: list[int] = []

        class _BudgetClient:
            def __init__(self) -> None:
                self.step = 0

            def request(self, body: dict, expect: str, *, timeout_ms: int) -> dict:
                seen_timeouts.append(timeout_ms)
                self.step += 1
                return _record_event(
                    body, "frame_captured", mono_ns=100 + self.step,
                    ram_path=f"/dev/shm/mv_budget_{self.step}.rgb",
                    sha256="cd" * 32, byte_count=64,
                )

        clock_values = iter([100.0, 100.2, 100.7, 101.1])
        with patch.object(tools.time, "monotonic", side_effect=lambda: next(clock_values)):
            with self.assertRaises(TimeoutError) as timeout_err:
                tools.record_stop(
                    "surf-1", "rec-1", mode="ram",
                    client=_BudgetClient(), timeout_ms=1000)
        self.assertIn("record_stop budget exhausted", str(timeout_err.exception))
        self.assertEqual(seen_timeouts, [800, 300])

    def test_t3r3_10_sequence_reservation_atomic_under_partial_writes(self) -> None:
        cfg = cli_fixture.config()
        transitions = [
            (9, b"9", 10, b"10"),
            (99, b"99", 100, b"100"),
            (999, b"999", 1000, b"1000"),
        ]
        with tempfile.TemporaryDirectory(prefix="mv-seq-atomic-") as tmp:
            root = Path(tmp)
            for prior_seq, prior_bytes, next_seq, next_bytes in transitions:
                for partial_len in range(0, len(next_bytes)):
                    with self.subTest(prior=prior_seq, partial_len=partial_len):
                        seq_file = root / f"seq-{prior_seq}-{partial_len}.seq"
                        seq_file.write_bytes(prior_bytes)
                        seq_file.chmod(0o600)
                        tc = ToolClient(
                            str(root / "unused.sock"),
                            session_id="sess-1",
                            local=cfg["peers"][0],
                            core=cfg["core"],
                            dependency_pins=[],
                            sequence_path=str(seq_file),
                            timeout_s=2.0,
                            max_line_bytes=65536,
                            max_reply_bytes=65536,
                        )
                        try:
                            self.assertEqual(_open_sequence_state(tc), prior_seq)
                            real_write = os.write

                            def short_write(fd: int, data: bytes, k: int = partial_len) -> int:
                                if k > 0:
                                    real_write(fd, data[:k])
                                return k

                            with patch.object(client_mod.os, "write", side_effect=short_write):
                                with self.assertRaises(ClientError) as caught:
                                    tc._reserve()
                                self.assertEqual(caught.exception.code, "socket")
                                self.assertIn("sequence reservation failed", str(caught.exception))
                        finally:
                            tc.close()

                        # Sequence file on disk must never regress or truncate.
                        self.assertEqual(seq_file.read_bytes(), prior_bytes)
                        self.assertFalse((root / f"{seq_file.name}.tmp").exists())

                        # Next open must observe prior_seq and reserve next_seq cleanly.
                        tc2 = ToolClient(
                            str(root / "unused.sock"),
                            session_id="sess-1",
                            local=cfg["peers"][0],
                            core=cfg["core"],
                            dependency_pins=[],
                            sequence_path=str(seq_file),
                            timeout_s=2.0,
                            max_line_bytes=65536,
                            max_reply_bytes=65536,
                        )
                        try:
                            self.assertEqual(_open_sequence_state(tc2), prior_seq)
                            tc2._reserve()
                            self.assertEqual(seq_file.read_bytes(), next_bytes)
                        finally:
                            tc2.close()

            # Also verify OSError during tmp unlink cleanup does not mask ClientError.
            seq_cleanup = root / "seq-cleanup.seq"
            seq_cleanup.write_bytes(b"9")
            seq_cleanup.chmod(0o600)
            tc3 = ToolClient(
                str(root / "unused.sock"),
                session_id="sess-1",
                local=cfg["peers"][0],
                core=cfg["core"],
                dependency_pins=[],
                sequence_path=str(seq_cleanup),
                timeout_s=2.0,
                max_line_bytes=65536,
                max_reply_bytes=65536,
            )
            try:
                self.assertEqual(_open_sequence_state(tc3), 9)
                with patch.object(client_mod.os, "write", return_value=1), \
                        patch.object(client_mod.os, "unlink", side_effect=OSError("unlink failed")):
                    with self.assertRaises(ClientError) as caught:
                        tc3._reserve()
                    self.assertEqual(caught.exception.code, "socket")
                self.assertEqual(seq_cleanup.read_bytes(), b"9")
            finally:
                tc3.close()
                with contextlib.suppress(OSError):
                    (root / "seq-cleanup.seq.tmp").unlink()

    def test_t3r3_06_core_client_timeout_representability(self) -> None:
        unused_sock = str(Path(tempfile.gettempdir()) / "mv-unused.sock")
        for bad_timeout in (1e300, float("inf"), float("-inf"), float("nan"), 0, -1.0, True):
            with self.subTest(timeout_s=bad_timeout):
                with self.assertRaises(ClientError) as caught:
                    CoreClient(
                        unused_sock,
                        timeout_s=bad_timeout,  # type: ignore[arg-type]
                        max_line_bytes=65536,
                        max_reply_bytes=65536,
                    )
                self.assertEqual(caught.exception.code, "timeout")

        # Even if timeout_s is mutated after __init__, connect() bounds it and
        # catches OverflowError from sock.settimeout.
        with tempfile.TemporaryDirectory(prefix="mv-timeout-") as tmp:
            sock_file = Path(tmp) / "core.sock"
            sock_file.write_text("", encoding="utf-8")
            sock_file.chmod(0o600)
            cc = CoreClient(
                sock_file,
                timeout_s=2.0,
                max_line_bytes=65536,
                max_reply_bytes=65536,
            )
            cc._timeout_s = 1e300
            with patch.object(CoreClient, "_check_endpoint", lambda self_c, p: (1, 1)):
                with self.assertRaises(ClientError) as caught:
                    cc.connect()
                self.assertEqual(caught.exception.code, "timeout")

            cc2 = CoreClient(
                sock_file,
                timeout_s=2.0,
                max_line_bytes=65536,
                max_reply_bytes=65536,
            )
            fake_sock = MagicMock()
            fake_sock.settimeout.side_effect = OverflowError("timeout too large")
            with patch.object(CoreClient, "_check_endpoint", lambda self_c, p: (1, 1)), \
                    patch.object(client_mod.socket, "socket", return_value=fake_sock):
                with self.assertRaises(ClientError) as caught2:
                    cc2.connect()
                self.assertEqual(caught2.exception.code, "timeout")
                fake_sock.close.assert_called_once()

    def test_t3r3_03_receipt_surface_and_frame_sha256_binding(self) -> None:
        digest_a = "ab" * 32
        digest_b = "cd" * 32

        def _make_verified_reply(call: dict, *, outer_sha: str = digest_a,
                                 after_sha: str = digest_a,
                                 after_surface: str = "surf-1",
                                 native_evidence: dict | None = None) -> dict:
            after_frame = dict(
                cli_fixture.FRAME,
                surface_id=after_surface,
                sha256=after_sha,
            )
            receipt = {
                "schema": "action_receipt/v0.2",
                "proposal_id": call["args"]["proposal_id"],
                "executed_at_ns": 2000000,
                "after_frame": after_frame,
                "verified": True,
                "verification": {"method": "pixel", "detail": "region changed"},
                "error": "",
            }
            body = {
                "schema": "mv_tool_result/v0.2",
                "request_id": call["request_id"],
                "op": "wait_verify",
                "status": "verified",
                "receipt": receipt,
                "focus_verified": True,
                "input_mono_ns": 1500000,
                "frame_sha256": outer_sha,
            }
            env = make_envelope(
                msg_id="receipt-env",
                from_component="core",
                from_instance="core-1",
                to_component="agent",
                to_instance="agent-1",
                session_id="sess-1",
                seq=1,
                body=body,
            )
            validated_body = validate_envelope(env)["body"]
            if native_evidence is not None:
                validated_body["receipt"]["native_evidence"] = native_evidence
            return validated_body

        expectation = {"type": "text_present", "text": "done"}

        # 1. Outer frame_sha256 != receipt.after_frame.sha256 must fail closed.
        bad_sha_client = tool_fixture._FakeClient([
            lambda call: _make_verified_reply(call, outer_sha=digest_b, after_sha=digest_a),
        ])
        with self.assertRaises(tools.ToolValidationError) as sha_err:
            tools.wait_verify("p-1", expectation, 2000, client=bad_sha_client, surface_id="surf-1")
        self.assertIn("uncorrelated frame_sha256", sha_err.exception.detail)

        # 2. receipt.after_frame.surface_id != expected surface_id must fail closed.
        bad_surf_client = tool_fixture._FakeClient([
            lambda call: _make_verified_reply(call, after_surface="surf-2"),
        ])
        with self.assertRaises(tools.ToolValidationError) as surf_err:
            tools.wait_verify("p-1", expectation, 2000, client=bad_surf_client, surface_id="surf-1")
        self.assertIn("uncorrelated surface_id", surf_err.exception.detail)

        # 3. native_evidence surface mismatch or extra field must fail closed.
        bad_native_client = tool_fixture._FakeClient([
            lambda call: _make_verified_reply(
                call,
                native_evidence={
                    "surface_id": "surf-2",
                    "input_mono_ns": 100,
                    "input_ts_ns": 200,
                },
            ),
        ])
        with self.assertRaises(tools.ToolValidationError) as native_err:
            tools.wait_verify("p-1", expectation, 2000, client=bad_native_client, surface_id="surf-1")
        self.assertIn("uncorrelated native surface_id", native_err.exception.detail)

        extra_native_client = tool_fixture._FakeClient([
            lambda call: _make_verified_reply(
                call,
                native_evidence={
                    "surface_id": "surf-1",
                    "input_mono_ns": 100,
                    "input_ts_ns": 200,
                    "extra_field": "forbidden",
                },
            ),
        ])
        with self.assertRaises(tools.ToolValidationError):
            tools.wait_verify("p-1", expectation, 2000, client=extra_native_client, surface_id="surf-1")

        # 4. verify.run_loop rejects receipt when after_frame.surface_id != observed_surface_id.
        def _loop_replies(after_surface: str, *, outer_sha: str = digest_a):
            return [
                lambda call: {
                    "schema": "mv_tool_result/v0.2",
                    "request_id": call["request_id"],
                    "op": "observe",
                    "status": "ok",
                    "observation": copy.deepcopy(cli_fixture.OBSERVATION),
                },
                lambda call: {
                    "schema": "mv_tool_result/v0.2",
                    "request_id": call["request_id"],
                    "op": "propose",
                    "status": "admitted",
                    "verdict": copy.deepcopy(cli_fixture.VERDICT),
                },
                lambda call: _make_verified_reply(
                    call, outer_sha=outer_sha, after_sha=digest_a, after_surface=after_surface),
            ]

        planner = lambda obs: (
            {"type": "click", "x": 4, "y": 5, "button": "left"},
            expectation,
        )
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("MV_WENDER_PLANNER_CMD", None)
            wrong_surface_loop_client = tool_fixture._FakeClient(_loop_replies("surf-other"))
            with self.assertRaises(tools.ToolValidationError) as loop_surf_err:
                verify.run_loop(
                    client=wrong_surface_loop_client,
                    surface_id="surf-1",
                    proposal_id="p-1",
                    planner=planner,
                    timeout_ms=2000,
                )
            self.assertIn("uncorrelated surface_id", loop_surf_err.exception.detail)

            wrong_sha_loop_client = tool_fixture._FakeClient(
                _loop_replies("surf-1", outer_sha=digest_b))
            with self.assertRaises(tools.ToolValidationError) as loop_sha_err:
                verify.run_loop(
                    client=wrong_sha_loop_client,
                    surface_id="surf-1",
                    proposal_id="p-1",
                    planner=planner,
                    timeout_ms=2000,
                )
            self.assertIn("uncorrelated frame_sha256", loop_sha_err.exception.detail)

            ok_loop_client = tool_fixture._FakeClient(_loop_replies("surf-1"))
            verified_receipt = verify.run_loop(
                client=ok_loop_client,
                surface_id="surf-1",
                proposal_id="p-1",
                planner=planner,
                timeout_ms=2000,
            )
            self.assertEqual(verified_receipt["after_frame"]["surface_id"], "surf-1")
            self.assertEqual(verified_receipt["after_frame"]["sha256"], digest_a)

    def test_cli_preserves_failure_categories(self) -> None:
        # T3R3-11: Core operational errors (UNAVAILABLE, NOT_FOUND, PROTOCOL)
        # must map to distinct CLI refusal codes, never collapsing to schema_error;
        # malformed registrations must deterministically return usage_error.
        error_expectations = [
            ("UNAVAILABLE", "transport_unavailable", "transport unavailable"),
            ("NOT_FOUND", "endpoint_error", "invalid endpoint"),
            ("PROTOCOL", "transport_error", "transport error"),
        ]
        replies = [
            [lambda call, code=code: {
                "schema": "mv_tool_result/v0.2",
                "request_id": call["request_id"],
                "op": call["op"],
                "status": "error",
                "code": code,
                "detail": f"secret-core-{code}-detail",
            }]
            for code, _, _ in error_expectations
        ] + [
            # Local schema failure (valid envelope, but op mismatch on list verb) -> schema_error
            [lambda call: {
                "schema": "mv_tool_result/v0.2",
                "request_id": call["request_id"],
                "op": "observe",
                "status": "ok",
                "observation": copy.deepcopy(cli_fixture.OBSERVATION),
            }],
        ]
        with _unix_core_or_inmemory(replies) as (sock, _):
            root = sock.parent
            trusted = root / "trusted.json"
            trusted.write_text(json.dumps(cli_fixture.config()), encoding="utf-8")
            with patch.dict(os.environ, {"MV_CORE_CONFIG": str(trusted)}):
                for code, expected_cli_code, expected_msg in error_expectations:
                    with self.subTest(core_error_code=code):
                        out, err = io.StringIO(), io.StringIO()
                        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                            rc = mvctl.run(self._cli_argv("list", sock, "--limit", "10"))
                        self.assertEqual((rc, out.getvalue()), (2, ""))
                        payload = json.loads(err.getvalue())
                        self.assertEqual(
                            payload,
                            {"verdict": "refuse", "code": expected_cli_code, "error": expected_msg},
                        )
                        self.assertNotIn(f"secret-core-{code}-detail", err.getvalue())

                # Local schema failure still maps to schema_error.
                out_s, err_s = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(out_s), contextlib.redirect_stderr(err_s):
                    rc_s = mvctl.run(self._cli_argv("list", sock, "--limit", "10"))
                self.assertEqual((rc_s, out_s.getvalue()), (2, ""))
                self.assertEqual(
                    json.loads(err_s.getvalue()),
                    {"verdict": "refuse", "code": "schema_error", "error": "schema validation failed"},
                )

            # Malformed registration structures deterministically refuse with usage_error
            # before opening any socket.
            base_cfg = cli_fixture.config()
            malformed_configs = [
                {},
                {"session_id": "sess-1", "peers": [], "core": base_cfg["core"]},
                {"session_id": "sess-1", "peers": [None], "core": base_cfg["core"]},
                {"session_id": "sess-1", "peers": "not-a-list", "core": base_cfg["core"]},
                dict(base_cfg, session_id="sess-wrong"),
                dict(base_cfg, core={"endpoint": {"component": "core", "instance": "core-1"}, "hello": None}),
                {
                    "session_id": "sess-1",
                    "peers": [{"endpoint": {"component": "agent", "instance": "agent-1"}, "hello": None}],
                    "core": base_cfg["core"],
                },
            ]
            for idx, bad_cfg in enumerate(malformed_configs):
                with self.subTest(malformed_config=idx):
                    bad_cfg_path = root / f"bad-cfg-{idx}.json"
                    bad_cfg_path.write_text(json.dumps(bad_cfg), encoding="utf-8")
                    with patch.dict(os.environ, {"MV_CORE_CONFIG": str(bad_cfg_path)}), \
                            patch("metaviewer_agents.client.ToolClient") as transport:
                        out_c, err_c = io.StringIO(), io.StringIO()
                        with contextlib.redirect_stdout(out_c), contextlib.redirect_stderr(err_c):
                            rc_c = mvctl.run(self._cli_argv("list", sock, "--limit", "10"))
                        self.assertEqual((rc_c, out_c.getvalue()), (2, ""))
                        self.assertEqual(
                            json.loads(err_c.getvalue()),
                            {"verdict": "refuse", "code": "usage_error", "error": "invalid command line"},
                        )
                        transport.assert_not_called()

    def test_tool_client_receipt_cache_eviction_and_deepcopy_isolation(self) -> None:
        cfg = cli_fixture.config()
        with tempfile.TemporaryDirectory(prefix="mv-receipt-cache-") as tmp:
            root = Path(tmp)
            sock_file = root / "unused.sock"
            sock_file.write_text("", encoding="utf-8")
            sock_file.chmod(0o600)
            seq_file = root / "receipt.seq"

            pending_frames: list[dict] = []
            recv_seq = 0

            def fake_connect(self_core):
                return copy.deepcopy(cfg["core"]["hello"])

            def fake_call(self_core, envelope_msg):
                nonlocal recv_seq
                validated = validate_envelope(copy.deepcopy(envelope_msg))
                self_core._next_seq += 1
                recv_seq += 1
                return validate_envelope(
                    make_envelope(
                        msg_id="hello-reply",
                        from_component="core",
                        from_instance="core-1",
                        to_component="agent",
                        to_instance="agent-1",
                        session_id="sess-1",
                        seq=recv_seq,
                        body=copy.deepcopy(cfg["core"]["hello"]),
                    )
                )

            def fake_send(self_core, envelope_msg):
                nonlocal recv_seq
                validated = validate_envelope(copy.deepcopy(envelope_msg))
                self_core._next_seq += 1
                req = validated["body"]
                idx = int(req["request_id"].split("-")[-1])
                receipt_body = {
                    "schema": "action_receipt/v0.2",
                    "proposal_id": f"prop-{idx}",
                    "executed_at_ns": 1000 + idx,
                    "after_frame": copy.deepcopy(cli_fixture.FRAME),
                    "verified": True,
                    "verification": {"method": "pixel", "detail": f"region-{idx}"},
                    "error": "",
                }
                tool_body = {
                    "schema": "mv_tool_result/v0.2",
                    "request_id": req["request_id"],
                    "op": "list",
                    "status": "ok",
                    "surfaces": [],
                    "next_cursor": None,
                }
                recv_seq += 1
                pending_frames.append(
                    validate_envelope(
                        make_envelope(
                            msg_id=f"rcpt-{idx}",
                            from_component="core",
                            from_instance="core-1",
                            to_component="agent",
                            to_instance="agent-1",
                            session_id="sess-1",
                            seq=recv_seq,
                            body=receipt_body,
                        )
                    )
                )
                recv_seq += 1
                pending_frames.append(
                    validate_envelope(
                        make_envelope(
                            msg_id=f"res-{idx}",
                            from_component="core",
                            from_instance="core-1",
                            to_component="agent",
                            to_instance="agent-1",
                            session_id="sess-1",
                            seq=recv_seq,
                            body=tool_body,
                        )
                    )
                )

            def fake_recv(self_core):
                return pending_frames.pop(0)

            with patch.object(CoreClient, "_check_endpoint", lambda self_c, p: (1, 1)), \
                    patch.object(CoreClient, "connect", fake_connect), \
                    patch.object(CoreClient, "call", fake_call), \
                    patch.object(CoreClient, "send", fake_send), \
                    patch.object(CoreClient, "recv", fake_recv), \
                    patch.object(CoreClient, "close", lambda self_core: None):
                with ToolClient(
                    str(sock_file),
                    session_id="sess-1",
                    local=cfg["peers"][0],
                    core=cfg["core"],
                    dependency_pins=[],
                    sequence_path=str(seq_file),
                    timeout_s=2.0,
                    max_line_bytes=65536,
                    max_reply_bytes=65536,
                ) as tc:
                    for i in range(130):
                        res = tc.request(
                            {
                                "schema": "mv_tool_call/v0.2",
                                "request_id": f"req-{i}",
                                "op": "list",
                                "args": {"cursor": None, "limit": 1},
                            },
                            "mv_tool_result/v0.2",
                            timeout_ms=2000,
                        )
                        self.assertEqual(res["status"], "ok")

                    first_id = "prop-0"
                    second_id = "prop-1"
                    oldest_retained_id = "prop-2"
                    latest_id = "prop-129"

                    self.assertIsNone(tc.receipt(first_id))
                    self.assertIsNone(tc.receipt(second_id))
                    self.assertIsNotNone(tc.receipt(oldest_retained_id))

                    latest = tc.receipt(latest_id)
                    self.assertIsNotNone(latest)
                    assert latest is not None
                    self.assertEqual(latest["proposal_id"], latest_id)
                    self.assertEqual(latest["executed_at_ns"], 1129)
                    self.assertEqual(latest["verification"]["detail"], "region-129")

                    # Mutate returned receipt in place and verify cache isolation.
                    latest["verified"] = False
                    latest["after_frame"]["surface_id"] = "corrupted-surface"
                    latest["verification"]["detail"] = "corrupted-detail"

                    second_read = tc.receipt(latest_id)
                    self.assertIsNotNone(second_read)
                    assert second_read is not None
                    self.assertIs(second_read["verified"], True)
                    self.assertEqual(second_read["after_frame"]["surface_id"], "surf-1")
                    self.assertEqual(second_read["verification"]["detail"], "region-129")


if __name__ == "__main__":
    unittest.main()
