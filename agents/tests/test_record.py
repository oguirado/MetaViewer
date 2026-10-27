"""U4-AG-01: agent recording verbs over tools.py and mvctl.py.

[TARGET, unit decision] Covers RAM start -> event stream -> stop via an
injected ToolClient double and mvctl CLI dispatch, malformed event stream
refusal, and disk recording preflight rejection with a 0-byte snapshot diff
across both tmp-HOME/work and the repository tree.
"""

from __future__ import annotations

import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parent
sys.path.insert(0, str(ROOT))

import test_mvctl_v02 as cli_fixture
import test_tools as tool_fixture
from metaviewer_agents import envelope, mvctl, tools


def _event(call: dict, event: str, *, mono_ns: int = 10, **fields) -> dict:
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


def _tree_snapshot(root: Path) -> dict[str, tuple[int, str]]:
    snap: dict[str, tuple[int, str]] = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file() or "__pycache__" in path.parts:
            continue
        data = path.read_bytes()
        snap[path.relative_to(root).as_posix()] = (
            len(data),
            hashlib.sha256(data).hexdigest(),
        )
    return snap


class RecordVerbTests(unittest.TestCase):
    def _cli_argv(self, command: str, sock: Path, json_arg: Path) -> list[str]:
        return [
            command,
            "--socket", str(sock),
            "--session-id", "sess-1",
            "--agent-instance", "agent-1",
            "--core-instance", "core-1",
            "--timeout-ms", "2000",
            "--max-line-bytes", "65536",
            "--max-reply-bytes", "65536",
            "--json-arg", str(json_arg),
        ]

    def test_ram_start_stop_event_sequence(self) -> None:
        # Mutation: skip _check_record_event in tools.record_stop or drop
        # "frame_captured" from allowed_stream.
        stream: list[dict] = []
        client = tool_fixture._FakeClient([
            lambda call: _event(call, "started", mono_ns=1, mode="ram"),
            lambda call: _event(
                call, "frame_captured", mono_ns=2,
                ram_path="/dev/shm/mv-rec-1.rgb",
                sha256="ab" * 32, byte_count=48),
            lambda call: _event(
                call, "dropped", mono_ns=3,
                dropped_frames=1, policy="ram_ring_oldest"),
            lambda call: _event(
                call, "stopped", mono_ns=4,
                frame_count=1, byte_count=48),
        ])
        started = tools.record_start(
            "surf-1", "rec-1", mode="ram", ring_bytes=4096, max_fps=30,
            client=client, timeout_ms=1000, events=stream)
        stopped = tools.record_stop(
            "surf-1", "rec-1", mode="ram",
            client=client, timeout_ms=1000, events=stream)

        self.assertEqual(started["event"], "started")
        self.assertEqual(started["mode"], "ram")
        self.assertEqual(stopped["event"], "stopped")
        self.assertEqual(stopped["frame_count"], 1)
        self.assertEqual(stopped["byte_count"], 48)
        self.assertEqual(
            [item["event"] for item in stream],
            ["started", "frame_captured", "dropped", "stopped"],
        )
        self.assertEqual(len(client.calls), 4)
        self.assertEqual(
            [row[0]["op"] for row in client.calls],
            ["ram_start", "ram_stop", "ram_stop", "ram_stop"],
        )
        for row in client.calls:
            env = envelope.make_envelope(
                msg_id="rec-wire", from_component="agent",
                from_instance="agent-1", to_component="core",
                to_instance="core-1", session_id="sess-1", seq=1, ts_ns=0,
                body=row[0])
            self.assertEqual(env["body"], row[0])

        # Exercise mvctl CLI record-start and record-stop dispatch.
        with tempfile.TemporaryDirectory(prefix="mv-rec-cli-") as tmp:
            root = Path(tmp)
            sock = root / "core.sock"
            trusted = root / "trusted.json"
            trusted.write_text(json.dumps(cli_fixture.config()), encoding="utf-8")
            start_file = root / "start.json"
            stop_file = root / "stop.json"
            start_file.write_text(json.dumps({
                "schema": "record_request/v0.2",
                "request_id": "req-start",
                "op": "ram_start",
                "params": {
                    "surface_id": "surf-1",
                    "recording_id": "rec-1",
                    "ring_bytes": 4096,
                    "max_fps": 30,
                },
            }), encoding="utf-8")
            stop_file.write_text(json.dumps({
                "schema": "record_request/v0.2",
                "request_id": "req-stop",
                "op": "ram_stop",
                "params": {
                    "surface_id": "surf-1",
                    "recording_id": "rec-1",
                },
            }), encoding="utf-8")
            cli_client = tool_fixture._FakeClient([
                lambda call: _event(call, "started", mono_ns=10, mode="ram"),
                lambda call: _event(
                    call, "frame_captured", mono_ns=11,
                    ram_path="/dev/shm/mv-rec-cli.rgb",
                    sha256="cd" * 32, byte_count=96),
                lambda call: _event(
                    call, "stopped", mono_ns=12,
                    frame_count=1, byte_count=96),
            ])
            with patch.dict(os.environ, {"MV_CORE_CONFIG": str(trusted)}), \
                    patch("metaviewer_agents.client.ToolClient") as transport:
                transport.return_value.__enter__.return_value = cli_client
                out1, err1 = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(out1), contextlib.redirect_stderr(err1):
                    rc1 = mvctl.run(self._cli_argv("record-start", sock, start_file))
                self.assertEqual((rc1, err1.getvalue()), (0, ""))
                self.assertEqual(json.loads(out1.getvalue())["event"], "started")

                out2, err2 = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(out2), contextlib.redirect_stderr(err2):
                    rc2 = mvctl.run(self._cli_argv("record-stop", sock, stop_file))
                self.assertEqual((rc2, err2.getvalue()), (0, ""))
                self.assertEqual(json.loads(out2.getvalue())["event"], "stopped")
                self.assertEqual(json.loads(out2.getvalue())["byte_count"], 96)

        # Negative controls: malformed or uncorrelated record_event refuses the
        # stream immediately and never consumes trailing events.
        malformed_builders = [
            lambda call: _event(
                call, "frame_captured",
                ram_path="/dev/shm/mv-rec-1.rgb",
                sha256="ab" * 32, byte_count=48, invented_field=True),
            lambda call: _event(
                call, "frame_captured",
                ram_path="/tmp/not-shm.rgb",
                sha256="ab" * 32, byte_count=48),
            lambda call: _event(
                call, "frame_captured",
                ram_path="/dev/shm/mv-rec-1.rgb",
                sha256="bad-digest", byte_count=48),
            lambda call: dict(
                _event(call, "frame_captured",
                       ram_path="/dev/shm/mv-rec-1.rgb",
                       sha256="ab" * 32, byte_count=48),
                surface_id="surf-other"),
            lambda call: dict(
                _event(call, "frame_captured",
                       ram_path="/dev/shm/mv-rec-1.rgb",
                       sha256="ab" * 32, byte_count=48),
                recording_id="rec-other"),
            lambda call: dict(
                _event(call, "frame_captured",
                       ram_path="/dev/shm/mv-rec-1.rgb",
                       sha256="ab" * 32, byte_count=48),
                request_id="req-other"),
            lambda call: _event(
                call, "exported",
                destination_capability_id="dest-1",
                destination_path="/exports/out",
                sha256="ab" * 32, byte_count=48),
        ]
        for idx, bad_builder in enumerate(malformed_builders):
            with self.subTest(bad_index=idx):
                partial: list[dict] = []
                bad_client = tool_fixture._FakeClient([
                    bad_builder,
                    lambda call: _event(
                        call, "stopped", frame_count=1, byte_count=48),
                ])
                with self.assertRaises(tools.ToolValidationError):
                    tools.record_stop(
                        "surf-1", "rec-1", mode="ram",
                        client=bad_client, timeout_ms=1000, events=partial)
                self.assertEqual(partial, [])
                self.assertEqual(len(bad_client.calls), 1)

        # Core refusal in record_event raises ToolRefusal verbatim.
        refused_client = tool_fixture._FakeClient([
            lambda call: _event(
                call, "refused", reason_code="POLICY", detail="denied"),
        ])
        with self.assertRaises(tools.ToolRefusal) as caught:
            tools.record_start(
                "surf-1", "rec-1", mode="ram", ring_bytes=4096, max_fps=30,
                client=refused_client, timeout_ms=1000)
        self.assertEqual(caught.exception.reason_code, "POLICY")

    def test_disk_without_destination_refused_zero_bytes(self) -> None:
        # Mutation: remove destination_path / destination_capability_id check
        # in tools.record_start or mvctl._run_v02 preflight.
        with tempfile.TemporaryDirectory(prefix="mv-rec-disk-") as tmp:
            root = Path(tmp)
            home = root / "home"
            work = root / "work"
            home.mkdir()
            work.mkdir()
            (home / "sentinel.txt").write_bytes(b"immutable")
            trusted = work / "trusted.json"
            trusted.write_text(json.dumps(cli_fixture.config()), encoding="utf-8")
            bad_req_path = work / "bad_disk.json"
            good_req_path = work / "good_disk.json"
            bad_payloads = [
                {
                    "schema": "record_request/v0.2",
                    "request_id": "req-disk-1",
                    "op": "disk_start",
                    "params": {
                        "surface_id": "surf-1",
                        "recording_id": "rec-1",
                        "destination_capability_id": "dest-1",
                        "max_fps": 30,
                    },
                },
                {
                    "schema": "record_request/v0.2",
                    "request_id": "req-disk-2",
                    "op": "disk_start",
                    "params": {
                        "surface_id": "surf-1",
                        "recording_id": "rec-1",
                        "destination_path": "/exports/rec-1",
                        "max_fps": 30,
                    },
                },
                {
                    "schema": "record_request/v0.2",
                    "request_id": "req-disk-3",
                    "op": "disk_start",
                    "params": {
                        "surface_id": "surf-1",
                        "recording_id": "rec-1",
                        "destination_capability_id": "dest-1",
                        "destination_path": "relative/escape",
                        "max_fps": 30,
                    },
                },
            ]
            bad_req_path.write_text(json.dumps(bad_payloads[0]), encoding="utf-8")
            good_req_path.write_text(json.dumps({
                "schema": "record_request/v0.2",
                "request_id": "req-disk-ok",
                "op": "disk_start",
                "params": {
                    "surface_id": "surf-1",
                    "recording_id": "rec-1",
                    "destination_capability_id": "dest-1",
                    "destination_path": "/exports/rec-1",
                    "max_fps": 30,
                },
            }), encoding="utf-8")

            before_tmp = _tree_snapshot(root)
            before_repo = _tree_snapshot(ROOT)

            with patch.dict(os.environ, {"HOME": str(home), "MV_CORE_CONFIG": str(trusted)}), \
                    contextlib.chdir(work):
                # 1. Direct tools.record_start negative controls without destination.
                for kwargs in (
                    {"destination_capability_id": "dest-1", "destination_path": None},
                    {"destination_capability_id": None, "destination_path": "/exports/rec-1"},
                    {"destination_capability_id": None, "destination_path": None},
                    {"destination_capability_id": "dest-1", "destination_path": ""},
                    {"destination_capability_id": "dest-1", "destination_path": "relative/path"},
                    {"destination_capability_id": "dest-1", "destination_path": "/exports/rec-1",
                     "ring_bytes": 4096},
                ):
                    with self.subTest(kwargs=kwargs):
                        client = tool_fixture._FakeClient([])
                        with self.assertRaises(tools.ToolValidationError):
                            tools.record_start(
                                "surf-1", "rec-1", mode="disk", max_fps=30,
                                client=client, timeout_ms=1000, **kwargs)
                        self.assertEqual(client.calls, [])

                self.assertEqual(_tree_snapshot(root), before_tmp)
                self.assertEqual(_tree_snapshot(ROOT), before_repo)

                # 2. CLI mvctl record-start preflight negative controls.
                for bad_payload in bad_payloads:
                    bad_req_path.write_text(json.dumps(bad_payload), encoding="utf-8")
                    before_each = _tree_snapshot(root)
                    with patch("metaviewer_agents.client.ToolClient") as transport:
                        out, err = io.StringIO(), io.StringIO()
                        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                            rc = mvctl.run(
                                self._cli_argv("record-start", root / "core.sock", bad_req_path))
                        self.assertEqual((rc, out.getvalue()), (2, ""))
                        self.assertEqual(
                            json.loads(err.getvalue()),
                            {"verdict": "refuse", "code": "schema_error",
                             "error": "schema validation failed"},
                        )
                        transport.assert_not_called()
                    self.assertEqual(_tree_snapshot(root), before_each)
                    self.assertEqual(_tree_snapshot(ROOT), before_repo)

                # 3. Positive control: valid disk_start + exported + disk_stop succeeds
                # and still writes 0 local bytes on the agent side.
                disk_stream: list[dict] = []
                disk_client = tool_fixture._FakeClient([
                    lambda call: _event(call, "started", mono_ns=20, mode="disk"),
                    lambda call: _event(
                        call, "exported", mono_ns=21,
                        destination_capability_id="dest-1",
                        destination_path="/exports/rec-1",
                        sha256="ef" * 32, byte_count=128),
                    lambda call: _event(
                        call, "stopped", mono_ns=22,
                        frame_count=2, byte_count=128),
                ])
                started = tools.record_start(
                    "surf-1", "rec-1", mode="disk",
                    destination_capability_id="dest-1",
                    destination_path="/exports/rec-1", max_fps=30,
                    client=disk_client, timeout_ms=1000, events=disk_stream)
                stopped = tools.record_stop(
                    "surf-1", "rec-1", mode="disk",
                    client=disk_client, timeout_ms=1000, events=disk_stream)
                self.assertEqual(started["mode"], "disk")
                self.assertEqual(stopped["byte_count"], 128)
                self.assertEqual(
                    [item["event"] for item in disk_stream],
                    ["started", "exported", "stopped"],
                )
                self.assertEqual(_tree_snapshot(root), before_each)
                self.assertEqual(_tree_snapshot(ROOT), before_repo)


if __name__ == "__main__":
    unittest.main()
