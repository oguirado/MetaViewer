"""Offline unit tests for stack.py demo display and screen recording controls."""

import argparse
from contextlib import redirect_stdout
import importlib.util
import io
import os
from pathlib import Path
import shutil
import signal
import socket
import stat
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from urllib.parse import unquote, urlsplit

SPEC = importlib.util.spec_from_file_location(
    "live_stack_demo", Path(__file__).with_name("stack.py")
)
stack = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stack)

CONTRACTS_SPEC = importlib.util.spec_from_file_location(
    "check_contracts_mod", stack.ROOT / "tools/check_contracts.py"
)
check_contracts = importlib.util.module_from_spec(CONTRACTS_SPEC)
CONTRACTS_SPEC.loader.exec_module(check_contracts)

SAMPLE_XDPYINFO = """name of display:    :91
version number:    11.0
vendor string:    The X.Org Foundation
screen #0:
  dimensions:    1600x1000 pixels (423x265 millimeters)
  resolution:    96x96 dots per inch
"""


def assert_recorder_sigint_ordered_first(case, events, recorder_pid, other_pids):
    """Verify recorder SIGINT occurs strictly before any SIGTERM/SIGKILL cleanup."""
    case.assertGreaterEqual(len(events), 2, f"expected at least 2 signal events, got {events!r}")
    first_rec_sigint = next(
        (idx for idx, ev in enumerate(events) if ev == (recorder_pid, signal.SIGINT)),
        None,
    )
    case.assertIsNotNone(first_rec_sigint, f"missing recorder SIGINT in {events!r}")
    first_term_or_kill = next(
        (
            idx
            for idx, (pid, sig) in enumerate(events)
            if pid in other_pids and sig in (signal.SIGTERM, signal.SIGKILL)
        ),
        None,
    )
    case.assertIsNotNone(first_term_or_kill, f"missing process cleanup signals in {events!r}")
    case.assertLess(
        first_rec_sigint,
        first_term_or_kill,
        f"recorder SIGINT index {first_rec_sigint} must precede process cleanup index {first_term_or_kill}: {events!r}",
    )


class StackDemoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="stack-demo-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)

    def base_state(self):
        work = self.root / "run-demo"
        work.mkdir(exist_ok=True)
        return {
            "schema": "metaviewer.live-stack/v1",
            "status": "starting",
            "work": str(work),
            "pids": [],
            "capsules": [],
            "published": [],
        }

    def live_env(self):
        env = {key: str(self.root) for key in stack.REQUIRED}
        env.update(MV_E2E_LIVE="1", MV_SRF_LIVE_PROFILE="mv-live-1")
        return env

    def test_parser_defaults_and_demo_flags(self):
        default_args = stack.parser().parse_args(["start"])
        self.assertEqual(default_args.command, "start")
        self.assertEqual(default_args.ttl, 2700)
        self.assertEqual(default_args.display, "private")
        self.assertIsNone(default_args.record)
        self.assertFalse(default_args.agent_tick_page)
        self.assertFalse(default_args.debug)
        self.assertFalse(default_args.tolerate_capsule_loss)

        visible_args = stack.parser().parse_args(
            [
                "start",
                "--ttl",
                "10m",
                "--display",
                "visible",
                "--record",
                "/tmp/demo.mp4",
                "--agent-tick-page",
                "--debug",
                "--tolerate-capsule-loss",
            ]
        )
        self.assertEqual(visible_args.ttl, 600)
        self.assertEqual(visible_args.display, "visible")
        self.assertEqual(visible_args.record, "/tmp/demo.mp4")
        self.assertTrue(visible_args.agent_tick_page)
        self.assertTrue(visible_args.debug)
        self.assertTrue(visible_args.tolerate_capsule_loss)

        reset_args = stack.parser().parse_args(["reset-config"])
        self.assertEqual(reset_args.command, "reset-config")

        private_args = stack.parser().parse_args(["start", "--display", "private"])
        self.assertEqual(private_args.display, "private")

        stop_args = stack.parser().parse_args(["stop"])
        self.assertEqual(stop_args.command, "stop")

        with self.assertRaises(SystemExit):
            stack.parser().parse_args(["start", "--display", "invalid"])

    def test_xdpyinfo_dimensions_and_ffmpeg_argv_composition(self):
        size = stack.parse_display_dimensions(SAMPLE_XDPYINFO)
        self.assertEqual(size, "1600x1000")

        with self.assertRaises(stack.StackError) as ctx:
            stack.parse_display_dimensions("screen #0:\n  resolution: 96x96 dots per inch\n")
        self.assertEqual(ctx.exception.code, "DISPLAY_SIZE_UNAVAILABLE")

        out_path = self.root / "demo-capture.mp4"
        argv = stack.ffmpeg_record_argv(":91", size, out_path, ffmpeg_bin="/usr/bin/ffmpeg")
        self.assertEqual(
            argv,
            [
                "/usr/bin/ffmpeg",
                "-f", "x11grab",
                "-video_size", "1600x1000",
                "-framerate", "30",
                "-i", ":91",
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-pix_fmt", "yuv420p",
                str(out_path),
            ],
        )

        # Verify start_recorder composes argv from xdpyinfo and records PID in state.
        state = self.base_state()
        state["display"] = ":91"
        state["record_path"] = str(out_path)
        spawned_calls = []

        def fake_popen(cmd, **kwargs):
            spawned_calls.append((cmd, kwargs))
            return Mock(pid=4242, poll=lambda: None)

        proc = stack.start_recorder(
            state,
            Path(state["work"]),
            {"DISPLAY": ":91", "PATH": "/usr/bin"},
            checked_fn=lambda cmd, **kw: SAMPLE_XDPYINFO,
            popen_fn=fake_popen,
            identity_fn=lambda pid: f"birth-{pid}",
        )
        self.assertEqual(proc.pid, 4242)
        self.assertEqual(state["recorder"], {"pid": 4242, "identity": "birth-4242"})
        self.assertIn({"pid": 4242, "identity": "birth-4242"}, state["pids"])
        self.assertEqual(len(spawned_calls), 1)
        self.assertEqual(spawned_calls[0][0][1:3], ["-f", "x11grab"])
        self.assertIn("1600x1000", spawned_calls[0][0])
        self.assertIn("libx264", spawned_calls[0][0])
        self.assertIn("veryfast", spawned_calls[0][0])
        self.assertIn("yuv420p", spawned_calls[0][0])
        self.assertEqual(spawned_calls[0][0][-1], str(out_path))

    def test_refusal_no_display_or_unreachable_display(self):
        env_no_display = self.live_env()
        env_no_display.pop("DISPLAY", None)
        with patch.dict(os.environ, env_no_display, clear=True), \
                patch.object(stack, "gw1_active", return_value=False), \
                patch.object(stack, "inventory") as inv_mock:
            with self.assertRaises(stack.StackError) as ctx:
                stack.preflight(self.root, display_mode="visible")
            self.assertEqual(ctx.exception.code, "DISPLAY_UNSET")
            inv_mock.assert_not_called()

        env_bad_display = dict(self.live_env(), DISPLAY=":99", PATH="/usr/bin")
        with patch.dict(os.environ, env_bad_display, clear=True), \
                patch.object(stack, "gw1_active", return_value=False), \
                patch.object(stack.shutil, "which", return_value="/usr/bin/xdpyinfo"), \
                patch.object(stack, "checked", side_effect=RuntimeError("unable to open display :99")), \
                patch.object(stack, "inventory") as inv_mock:
            with self.assertRaises(stack.StackError) as ctx:
                stack.preflight(self.root, display_mode="visible")
            self.assertEqual(ctx.exception.code, "DISPLAY_UNREACHABLE")
            inv_mock.assert_not_called()

        # Positive control for visible display validation when DISPLAY is set and xdpyinfo succeeds.
        verified = stack.validate_display(
            "visible",
            env={"DISPLAY": ":0", "XAUTHORITY": "/tmp/xauth-visible"},
            which_fn=lambda tool: "/usr/bin/" + tool,
            checked_fn=lambda cmd, **kw: SAMPLE_XDPYINFO,
        )
        self.assertEqual(verified, {"display": ":0", "xauthority": "/tmp/xauth-visible"})

    def test_refusal_existing_file_and_path_inside_repo_and_ffmpeg_absent(self):
        # 1. Existing file refused before anything starts.
        existing_mp4 = self.root / "already-there.mp4"
        existing_mp4.write_bytes(b"mp4")
        with patch.dict(os.environ, self.live_env(), clear=True), \
                patch.object(stack, "gw1_active", return_value=False), \
                patch.object(stack, "inventory") as inv_mock:
            with self.assertRaises(stack.StackError) as ctx:
                stack.preflight(self.root, record_path=str(existing_mp4))
            self.assertEqual(ctx.exception.code, "RECORD_PATH_EXISTS")
            inv_mock.assert_not_called()

        # 2. Path inside repository refused before anything starts.
        repo_mp4 = stack.ROOT / "docs" / "forbidden-inside-repo.mp4"
        with patch.dict(os.environ, self.live_env(), clear=True), \
                patch.object(stack, "gw1_active", return_value=False), \
                patch.object(stack, "inventory") as inv_mock:
            with self.assertRaises(stack.StackError) as ctx:
                stack.preflight(self.root, record_path=str(repo_mp4))
            self.assertEqual(ctx.exception.code, "RECORD_PATH_IN_REPO")
            inv_mock.assert_not_called()

        # 3. ffmpeg absent via PATH override refused before anything starts.
        empty_bin = self.root / "no-ffmpeg-bin"
        empty_bin.mkdir()
        fresh_mp4 = self.root / "fresh-recording.mp4"
        env_no_ffmpeg = dict(self.live_env(), PATH=str(empty_bin))
        with patch.dict(os.environ, env_no_ffmpeg, clear=True), \
                patch.object(stack, "gw1_active", return_value=False), \
                patch.object(stack, "inventory") as inv_mock:
            with self.assertRaises(stack.StackError) as ctx:
                stack.preflight(self.root, record_path=str(fresh_mp4))
            self.assertEqual(ctx.exception.code, "FFMPEG_MISSING")
            inv_mock.assert_not_called()

        # Positive control: valid fresh path outside repo with fake ffmpeg on PATH passes validation.
        fake_ffmpeg = empty_bin / "ffmpeg"
        fake_ffmpeg.write_text("#!/bin/sh\nexit 0\n")
        fake_ffmpeg.chmod(0o700)
        resolved = stack.validate_record_path(
            str(fresh_mp4),
            repo_root=stack.ROOT,
            env={"PATH": str(empty_bin)},
        )
        self.assertEqual(resolved, fresh_mp4.resolve(strict=False))

    def test_stop_orders_recorder_sigint_before_process_cleanup(self):
        state = self.base_state()
        ram = self.root / "ram"
        ram.mkdir()
        recorder_rec = {"pid": 5002, "identity": "birth-5002"}
        core_rec = {"pid": 5001, "identity": "birth-5001"}
        electron_rec = {"pid": 5003, "identity": "birth-5003"}
        state["recorder"] = recorder_rec
        state["pids"] = [core_rec, recorder_rec, electron_rec]
        stack.save_state(self.root, state)

        events = []
        alive_pids = {5001, 5002, 5003}
        recorder_polls_after_sigint = [0]
        clock = [100.0]

        def fake_signal(record, sig):
            pid = record["pid"]
            events.append((pid, sig))
            if pid == 5002 and sig == signal.SIGINT:
                recorder_polls_after_sigint[0] = 1
            elif sig in (signal.SIGTERM, signal.SIGKILL):
                alive_pids.discard(pid)

        def fake_alive(record):
            pid = record.get("pid")
            if pid == 5002 and recorder_polls_after_sigint[0] > 0:
                recorder_polls_after_sigint[0] += 1
                if recorder_polls_after_sigint[0] >= 3:
                    alive_pids.discard(5002)
            return pid in alive_pids

        def fake_monotonic():
            return clock[0]

        def fake_sleep(dt):
            clock[0] += dt

        env = dict(self.live_env(), MV_SRF_LIVE_RAM_ROOT=str(ram))
        with patch.dict(os.environ, env, clear=True), \
                patch.object(stack, "inventory", return_value=set()), \
                patch.object(stack.live, "profile_containers", return_value=set()), \
                redirect_stdout(io.StringIO()):
            stack.cleanup(
                state,
                self.root,
                signal_fn=fake_signal,
                alive_fn=fake_alive,
                monotonic_fn=fake_monotonic,
                sleep_fn=fake_sleep,
            )

        assert_recorder_sigint_ordered_first(self, events, 5002, {5001, 5003})
        self.assertEqual(events[0], (5002, signal.SIGINT))
        self.assertNotIn((5002, signal.SIGTERM), events)

        # Also verify stop_stack sends SIGINT to recorder before SIGTERM to supervisor.
        stop_events = []
        state2 = self.base_state()
        state2["supervisor"] = {"pid": 6000, "identity": "birth-6000"}
        state2["recorder"] = {"pid": 6002, "identity": "birth-6002"}
        stack.save_state(self.root, state2)
        rec2_alive = [True]

        def stop_signal(record, sig):
            stop_events.append((record["pid"], sig))
            if record["pid"] == 6002 and sig == signal.SIGINT:
                rec2_alive[0] = False
            elif record["pid"] == 6000 and sig == signal.SIGTERM:
                (self.root / "state.json").unlink()

        with patch.object(stack, "identity", return_value="birth-6000"), \
                redirect_stdout(io.StringIO()):
            stack.stop_stack(
                self.root,
                signal_fn=stop_signal,
                alive_fn=lambda r: rec2_alive[0] if r.get("pid") == 6002 else False,
                monotonic_fn=fake_monotonic,
                sleep_fn=fake_sleep,
            )
        assert_recorder_sigint_ordered_first(self, stop_events, 6002, {6000})
        self.assertEqual(stop_events, [(6002, signal.SIGINT), (6000, signal.SIGTERM)])

        # Negative control: broken ordering (SIGTERM before recorder SIGINT) fails the check.
        broken_events = [(5001, signal.SIGTERM), (5003, signal.SIGTERM), (5002, signal.SIGINT)]
        with self.assertRaises(AssertionError):
            assert_recorder_sigint_ordered_first(self, broken_events, 5002, {5001, 5003})

    def _make_injected_peer(self, regs, config, surface_id="s-live-1", step_handler=None):
        class InjectedPeer:
            def __init__(self):
                self.next_seq = 1
                self.inbound_seq = 0
                self.core_seq = 0
                self.sent_envelopes = []
                self.rx_queue = []
                self.step_count = 0

            def _frame_ref(self, generation, sha_char):
                return {
                    "schema": "frame_ref/v0.2",
                    "surface_id": surface_id,
                    "generation": generation,
                    "tick": generation,
                    "ts_ns": generation * 1000,
                    "width": 1280,
                    "height": 900,
                    "format": "rgb24",
                    "ramws_path": f"/dev/shm/metaviewer_test/srf_id_12345678/frames/w1/{generation}.rgb",
                    "sha256": sha_char * 64,
                    "capture_us": 500,
                }

            def _enqueue(self, body):
                self.inbound_seq += 1
                self.rx_queue.append(
                    stack.live.make_envelope(
                        msg_id=f"core-msg-{self.inbound_seq}",
                        from_component="core",
                        from_instance=regs["core"]["endpoint"]["instance"],
                        to_component="agent",
                        to_instance=regs["agent"]["endpoint"]["instance"],
                        session_id=config["session_id"],
                        seq=self.inbound_seq,
                        body=body,
                        ts_ns=0,
                    )
                )

            def send(self, envelope):
                self.sent_envelopes.append(envelope)
                self.next_seq += 1
                body = envelope["body"]
                schema = body.get("schema")
                if schema == "hello/v0.2":
                    self._enqueue(regs["core"]["hello"])
                elif schema == "surface_request/v0.2" and body.get("op") == "create":
                    self._enqueue(
                        {
                            "schema": "surface_event/v0.2",
                            "event": "created",
                            "data": {
                                "surface": {
                                    "schema": "surface/v0.2",
                                    "surface_id": surface_id,
                                    "kind": "browser",
                                    "display": ":91",
                                    "geometry": {"w": 1280, "h": 900},
                                    "state": "active",
                                    "visibility": "unfolded",
                                    "control": "agent",
                                    "profile_id": "mv-live-1",
                                }
                            },
                        }
                    )
                    self._enqueue(
                        {
                            "schema": "surface_event/v0.2",
                            "event": "frame_ready",
                            "data": {
                                "frame_ref": self._frame_ref(1, "1"),
                            },
                        }
                    )
                elif schema == "action_proposal/v0.2":
                    self.step_count += 1
                    self.core_seq += 1
                    if step_handler is not None:
                        step_handler(self, self.step_count, body)
                    else:
                        next_gen = self.step_count + 1
                        next_frame = self._frame_ref(next_gen, str(next_gen))
                        self._enqueue(
                            {
                                "schema": "action_verdict/v0.2",
                                "proposal_id": body["proposal_id"],
                                "decision": "admitted",
                                "core_seq": self.core_seq,
                            }
                        )
                        self._enqueue(
                            {
                                "schema": "surface_event/v0.2",
                                "event": "frame_ready",
                                "data": {
                                    "frame_ref": next_frame,
                                },
                            }
                        )
                        self._enqueue(
                            {
                                "schema": "action_receipt/v0.2",
                                "proposal_id": body["proposal_id"],
                                "executed_at_ns": next_gen * 1000,
                                "after_frame": next_frame,
                                "verified": True,
                                "verification": {
                                    "method": "pixel",
                                    "detail": "frame captured after input",
                                },
                                "error": "",
                            }
                        )

            def recv(self):
                if not self.rx_queue:
                    raise RuntimeError("injected peer receive queue empty")
                return self.rx_queue.pop(0)

        return InjectedPeer()

    def _regs_and_config(self):
        commit = "a" * 40
        regs = {
            c: stack.live.registration(c, commit, f"{c}inst01")
            for c in ("core", "ui", "agent", "daemon")
        }
        config = {
            "session_id": "stack-testsession01",
            "core": regs["core"],
            "peers": [regs[c] for c in ("ui", "agent", "daemon")],
        }
        return regs, config

    def test_agent_tick_page_with_flag_produces_exact_ordered_schema_valid_requests(self):
        validator = check_contracts.Validator(stack.ROOT / "contracts/v0.2")
        envelope_schema = validator.load("envelope.schema.json")
        surface_request_schema = validator.load("surface_request.schema.json")
        proposal_schema = validator.load("action_proposal.schema.json")

        regs, config = self._regs_and_config()
        peer = self._make_injected_peer(regs, config)
        state = self.base_state()
        state["agent_tick_page"] = True
        stack.save_state(self.root, state)
        self.assertTrue(stack.load_state(self.root)["agent_tick_page"])

        logged = []
        seq_ids = iter(["aa01", "bb02", "cc03"])
        stack.bootstrap_agent_surface(
            peer,
            regs,
            config,
            state,
            self.root,
            600,
            containers_fn=lambda _profile: {"srf-id-12345678"},
            remember_fn=lambda s, r: stack.save_state(r, s),
            id_fn=lambda: next(seq_ids),
            log_fn=logged.append,
        )

        self.assertEqual(state["status"], "ready")
        self.assertEqual(
            logged,
            [
                "LIVE_STACK_TICK step=1 attempt=1 outcome=admitted",
                "LIVE_STACK_TICK step=2 attempt=1 outcome=admitted",
                "LIVE_STACK_TICK step=3 attempt=1 outcome=admitted",
            ],
        )

        # Validate every sent envelope and body against contracts/v0.2.
        for env in peer.sent_envelopes:
            validator.validate(env, envelope_schema)
        bodies = [env["body"] for env in peer.sent_envelopes]
        self.assertEqual(len(bodies), 5)
        self.assertEqual(bodies[0]["schema"], "hello/v0.2")
        self.assertEqual(bodies[1]["schema"], "surface_request/v0.2")
        self.assertEqual(bodies[1]["op"], "create")
        validator.validate(bodies[1], surface_request_schema)

        proposals = bodies[2:]
        self.assertEqual(len(proposals), 3)
        for prop in proposals:
            validator.validate(prop, proposal_schema)

        proposal_ids = [prop["proposal_id"] for prop in proposals]
        self.assertEqual(proposal_ids, ["tick-1-aa01", "tick-2-bb02", "tick-3-cc03"])
        self.assertEqual(len(set(proposal_ids)), 3)

        self.assertEqual(
            [prop["action"] for prop in proposals],
            [
                {"type": "key", "keys": ["ctrl", "l"]},
                {"type": "type", "text": stack.TICK_URL},
                {"type": "key", "keys": ["Return"]},
            ],
        )
        self.assertEqual(
            [prop["based_on_frame"] for prop in proposals],
            [
                {"generation": 1, "sha256": "1" * 64},
                {"generation": 2, "sha256": "2" * 64},
                {"generation": 3, "sha256": "3" * 64},
            ],
        )

        # Negative control: an invalid proposal (empty keys array or unapproved schema field)
        # is rejected by the repo's contract validator.
        invalid_proposal = dict(proposals[0], action={"type": "key", "keys": []})
        with self.assertRaises(check_contracts.ValidationError):
            validator.validate(invalid_proposal, proposal_schema)

    def test_agent_tick_page_without_flag_sends_nothing(self):
        regs, config = self._regs_and_config()
        peer = self._make_injected_peer(regs, config)
        state = self.base_state()
        logged = []

        stack.bootstrap_agent_surface(
            peer,
            regs,
            config,
            state,
            self.root,
            600,
            containers_fn=lambda _profile: {"srf-id-12345678"},
            remember_fn=lambda s, r: stack.save_state(r, s),
            log_fn=logged.append,
        )

        self.assertEqual(state["status"], "ready")
        self.assertEqual(logged, [])
        bodies = [env["body"] for env in peer.sent_envelopes]
        self.assertEqual([b["schema"] for b in bodies], ["hello/v0.2", "surface_request/v0.2"])
        self.assertEqual(bodies[1]["op"], "create")

    def test_agent_tick_page_pins_newest_frame_ready_after_settle_not_settlement_after_frame(self):
        regs, config = self._regs_and_config()
        clock = [10.0]
        select_waits = []

        def step_handler(peer_obj, count, body):
            peer_obj._enqueue(
                {
                    "schema": "action_verdict/v0.2",
                    "proposal_id": body["proposal_id"],
                    "decision": "admitted",
                    "core_seq": peer_obj.core_seq,
                }
            )
            if count == 1:
                # Step 1 produces frame_ready gen 2, then settlement after_frame carries a
                # distinct digest ("a"*64, gen 9) that must NEVER be pinned because only
                # surface_event(frame_ready) updates core frame state.
                peer_obj._enqueue(
                    {
                        "schema": "surface_event/v0.2",
                        "event": "frame_ready",
                        "data": {"frame_ref": peer_obj._frame_ref(2, "2")},
                    }
                )
                settlement_only = peer_obj._frame_ref(9, "a")
                peer_obj._enqueue(
                    {
                        "schema": "action_receipt/v0.2",
                        "proposal_id": body["proposal_id"],
                        "executed_at_ns": 2000,
                        "after_frame": settlement_only,
                        "verified": True,
                        "verification": {"method": "pixel", "detail": "ok"},
                        "error": "",
                    }
                )
            else:
                next_gen = count + 3
                next_frame = peer_obj._frame_ref(next_gen, str(next_gen))
                peer_obj._enqueue(
                    {
                        "schema": "surface_event/v0.2",
                        "event": "frame_ready",
                        "data": {"frame_ref": next_frame},
                    }
                )
                peer_obj._enqueue(
                    {
                        "schema": "action_receipt/v0.2",
                        "proposal_id": body["proposal_id"],
                        "executed_at_ns": next_gen * 1000,
                        "after_frame": next_frame,
                        "verified": True,
                        "verification": {"method": "pixel", "detail": "ok"},
                        "error": "",
                    }
                )

        peer = self._make_injected_peer(regs, config, step_handler=step_handler)
        peer._sock = object()

        # Simulate omnibox focus / caret frames arriving during the pre-step-2 settle window.
        burst_delivered = [False]

        def fake_select(rlist, _wlist, _xlist, timeout):
            select_waits.append(timeout)
            if peer.step_count == 1 and not burst_delivered[0]:
                burst_delivered[0] = True
                clock[0] += 0.05
                peer._enqueue(
                    {
                        "schema": "surface_event/v0.2",
                        "event": "frame_ready",
                        "data": {"frame_ref": peer._frame_ref(3, "3")},
                    }
                )
                other_surface_frame = dict(peer._frame_ref(99, "f"), surface_id="s-other-99")
                peer._enqueue(
                    {
                        "schema": "surface_event/v0.2",
                        "event": "frame_ready",
                        "data": {"frame_ref": other_surface_frame},
                    }
                )
                peer._enqueue(
                    {
                        "schema": "surface_event/v0.2",
                        "event": "frame_ready",
                        "data": {"frame_ref": peer._frame_ref(4, "4")},
                    }
                )
                return (rlist, [], [])
            clock[0] += timeout
            return ([], [], [])

        state = self.base_state()
        state["agent_tick_page"] = True
        logged = []
        seq_ids = iter(["s1", "s2", "s3"])

        stack.bootstrap_agent_surface(
            peer,
            regs,
            config,
            state,
            self.root,
            600,
            containers_fn=lambda _profile: {"srf-id-12345678"},
            remember_fn=lambda s, r: stack.save_state(r, s),
            id_fn=lambda: next(seq_ids),
            log_fn=logged.append,
            select_fn=fake_select,
            monotonic_fn=lambda: clock[0],
        )

        self.assertEqual(state["status"], "ready")
        proposals = [env["body"] for env in peer.sent_envelopes if env["body"]["schema"] == "action_proposal/v0.2"]
        self.assertEqual(len(proposals), 3)
        # Step 2 must pin generation 4 ("4"*64), the newest frame_ready for s-live-1,
        # never settlement after_frame ("a"*64, gen 9) and never s-other-99 (gen 99).
        self.assertEqual(
            [prop["based_on_frame"] for prop in proposals],
            [
                {"generation": 1, "sha256": "1" * 64},
                {"generation": 4, "sha256": "4" * 64},
                {"generation": 5, "sha256": "5" * 64},
            ],
        )
        self.assertTrue(all(0.0 <= w <= stack.TICK_SETTLE_MAX_S for w in select_waits))

    def test_agent_tick_page_stale_frame_twice_then_admitted_succeeds_on_attempt_3(self):
        validator = check_contracts.Validator(stack.ROOT / "contracts/v0.2")
        envelope_schema = validator.load("envelope.schema.json")
        proposal_schema = validator.load("action_proposal.schema.json")

        regs, config = self._regs_and_config()

        def step_handler(peer_obj, count, body):
            if count == 1:
                # Step 1 admitted on attempt 1 -> emits frame_ready gen 2.
                frame2 = peer_obj._frame_ref(2, "2")
                peer_obj._enqueue(
                    {
                        "schema": "action_verdict/v0.2",
                        "proposal_id": body["proposal_id"],
                        "decision": "admitted",
                        "core_seq": peer_obj.core_seq,
                    }
                )
                peer_obj._enqueue(
                    {
                        "schema": "surface_event/v0.2",
                        "event": "frame_ready",
                        "data": {"frame_ref": frame2},
                    }
                )
                peer_obj._enqueue(
                    {
                        "schema": "action_receipt/v0.2",
                        "proposal_id": body["proposal_id"],
                        "executed_at_ns": 2000,
                        "after_frame": frame2,
                        "verified": True,
                        "verification": {"method": "pixel", "detail": "ok"},
                        "error": "",
                    }
                )
            elif count in (2, 3):
                # Step 2 attempts 1 and 2 refused with STALE_FRAME, each superseded by a fresh frame_ready.
                next_gen = count + 1  # gen 3 after attempt 1, gen 4 after attempt 2
                peer_obj._enqueue(
                    {
                        "schema": "action_verdict/v0.2",
                        "proposal_id": body["proposal_id"],
                        "decision": "refused",
                        "reason_code": "STALE_FRAME",
                        "core_seq": peer_obj.core_seq,
                    }
                )
                peer_obj._enqueue(
                    {
                        "schema": "surface_event/v0.2",
                        "event": "frame_ready",
                        "data": {"frame_ref": peer_obj._frame_ref(next_gen, str(next_gen))},
                    }
                )
            elif count == 4:
                # Step 2 attempt 3 admitted on gen 4 -> emits frame_ready gen 5.
                frame5 = peer_obj._frame_ref(5, "5")
                peer_obj._enqueue(
                    {
                        "schema": "action_verdict/v0.2",
                        "proposal_id": body["proposal_id"],
                        "decision": "admitted",
                        "core_seq": peer_obj.core_seq,
                    }
                )
                peer_obj._enqueue(
                    {
                        "schema": "surface_event/v0.2",
                        "event": "frame_ready",
                        "data": {"frame_ref": frame5},
                    }
                )
                peer_obj._enqueue(
                    {
                        "schema": "action_receipt/v0.2",
                        "proposal_id": body["proposal_id"],
                        "executed_at_ns": 5000,
                        "after_frame": frame5,
                        "verified": True,
                        "verification": {"method": "pixel", "detail": "ok"},
                        "error": "",
                    }
                )
            else:
                # Step 3 attempt 1 admitted on gen 5 -> emits frame_ready gen 6.
                frame6 = peer_obj._frame_ref(6, "6")
                peer_obj._enqueue(
                    {
                        "schema": "action_verdict/v0.2",
                        "proposal_id": body["proposal_id"],
                        "decision": "admitted",
                        "core_seq": peer_obj.core_seq,
                    }
                )
                peer_obj._enqueue(
                    {
                        "schema": "surface_event/v0.2",
                        "event": "frame_ready",
                        "data": {"frame_ref": frame6},
                    }
                )
                peer_obj._enqueue(
                    {
                        "schema": "action_receipt/v0.2",
                        "proposal_id": body["proposal_id"],
                        "executed_at_ns": 6000,
                        "after_frame": frame6,
                        "verified": True,
                        "verification": {"method": "pixel", "detail": "ok"},
                        "error": "",
                    }
                )

        peer = self._make_injected_peer(regs, config, step_handler=step_handler)
        state = self.base_state()
        state["agent_tick_page"] = True
        logged = []
        seq_ids = iter(["id1a", "id2a", "id2b", "id2c", "id3a"])

        stack.bootstrap_agent_surface(
            peer,
            regs,
            config,
            state,
            self.root,
            600,
            containers_fn=lambda _profile: {"srf-id-12345678"},
            remember_fn=lambda s, r: stack.save_state(r, s),
            id_fn=lambda: next(seq_ids),
            log_fn=logged.append,
        )

        self.assertEqual(state["status"], "ready")
        self.assertEqual(
            logged,
            [
                "LIVE_STACK_TICK step=1 attempt=1 outcome=admitted",
                "LIVE_STACK_TICK step=2 attempt=1 outcome=refused:STALE_FRAME",
                "LIVE_STACK_TICK step=2 attempt=2 outcome=refused:STALE_FRAME",
                "LIVE_STACK_TICK step=2 attempt=3 outcome=admitted",
                "LIVE_STACK_TICK step=3 attempt=1 outcome=admitted",
            ],
        )

        for env in peer.sent_envelopes:
            validator.validate(env, envelope_schema)
        proposals = [env["body"] for env in peer.sent_envelopes if env["body"]["schema"] == "action_proposal/v0.2"]
        self.assertEqual(len(proposals), 5)
        for prop in proposals:
            validator.validate(prop, proposal_schema)

        self.assertEqual(
            [prop["proposal_id"] for prop in proposals],
            ["tick-1-id1a", "tick-2-id2a", "tick-2-id2b", "tick-2-id2c", "tick-3-id3a"],
        )
        self.assertEqual(
            [prop["based_on_frame"] for prop in proposals],
            [
                {"generation": 1, "sha256": "1" * 64},
                {"generation": 2, "sha256": "2" * 64},
                {"generation": 3, "sha256": "3" * 64},
                {"generation": 4, "sha256": "4" * 64},
                {"generation": 5, "sha256": "5" * 64},
            ],
        )
        self.assertEqual(
            [prop["action"] for prop in proposals],
            [
                {"type": "key", "keys": ["ctrl", "l"]},
                {"type": "type", "text": stack.TICK_URL},
                {"type": "type", "text": stack.TICK_URL},
                {"type": "type", "text": stack.TICK_URL},
                {"type": "key", "keys": ["Return"]},
            ],
        )

    def test_agent_tick_page_always_stale_frame_retries_three_attempts_then_continues(self):
        regs, config = self._regs_and_config()

        def always_stale_step2(peer_obj, count, body):
            next_gen = count + 1
            next_frame = peer_obj._frame_ref(next_gen, format(next_gen, "x"))
            if body["action"] == {"type": "type", "text": stack.TICK_URL}:
                peer_obj._enqueue(
                    {
                        "schema": "action_verdict/v0.2",
                        "proposal_id": body["proposal_id"],
                        "decision": "refused",
                        "reason_code": "STALE_FRAME",
                        "core_seq": peer_obj.core_seq,
                    }
                )
                peer_obj._enqueue(
                    {
                        "schema": "surface_event/v0.2",
                        "event": "frame_ready",
                        "data": {"frame_ref": next_frame},
                    }
                )
            else:
                peer_obj._enqueue(
                    {
                        "schema": "action_verdict/v0.2",
                        "proposal_id": body["proposal_id"],
                        "decision": "admitted",
                        "core_seq": peer_obj.core_seq,
                    }
                )
                peer_obj._enqueue(
                    {
                        "schema": "surface_event/v0.2",
                        "event": "frame_ready",
                        "data": {"frame_ref": next_frame},
                    }
                )
                peer_obj._enqueue(
                    {
                        "schema": "action_receipt/v0.2",
                        "proposal_id": body["proposal_id"],
                        "executed_at_ns": next_gen * 1000,
                        "after_frame": next_frame,
                        "verified": True,
                        "verification": {"method": "pixel", "detail": "ok"},
                        "error": "",
                    }
                )

        peer = self._make_injected_peer(regs, config, step_handler=always_stale_step2)
        state = self.base_state()
        state["agent_tick_page"] = True
        logged = []
        seq_ids = iter(["a1", "b1", "b2", "b3", "c1"])

        stack.bootstrap_agent_surface(
            peer,
            regs,
            config,
            state,
            self.root,
            600,
            containers_fn=lambda _profile: {"srf-id-12345678"},
            remember_fn=lambda s, r: stack.save_state(r, s),
            id_fn=lambda: next(seq_ids),
            log_fn=logged.append,
        )

        self.assertEqual(state["status"], "ready")
        self.assertEqual(
            logged,
            [
                "LIVE_STACK_TICK step=1 attempt=1 outcome=admitted",
                "LIVE_STACK_TICK step=2 attempt=1 outcome=refused:STALE_FRAME",
                "LIVE_STACK_TICK step=2 attempt=2 outcome=refused:STALE_FRAME",
                "LIVE_STACK_TICK step=2 attempt=3 outcome=refused:STALE_FRAME",
                "LIVE_STACK_TICK step=3 attempt=1 outcome=admitted",
            ],
        )
        proposals = [env["body"] for env in peer.sent_envelopes if env["body"]["schema"] == "action_proposal/v0.2"]
        self.assertEqual(
            [prop["proposal_id"] for prop in proposals],
            ["tick-1-a1", "tick-2-b1", "tick-2-b2", "tick-2-b3", "tick-3-c1"],
        )

        # Negative control: reusing a refused proposal_id on the same lane is rejected by live.send.
        with self.assertRaises(RuntimeError) as dup_ctx:
            stack.live.send(peer, regs["agent"], config, proposals[1])
        self.assertIn("duplicate proposal_id", str(dup_ctx.exception))

    def test_agent_tick_page_refusal_and_error_are_fail_open_and_never_block_ready(self):
        regs, config = self._regs_and_config()

        def refuse_or_fail(peer_obj, count, body):
            if count == 1:
                peer_obj._enqueue(
                    {
                        "schema": "action_verdict/v0.2",
                        "proposal_id": body["proposal_id"],
                        "decision": "refused",
                        "reason_code": "SURFACE_NOT_AGENT_CONTROLLED",
                        "core_seq": peer_obj.core_seq,
                    }
                )
            elif count in (2, 3, 4):
                peer_obj._enqueue(
                    {
                        "schema": "action_verdict/v0.2",
                        "proposal_id": body["proposal_id"],
                        "decision": "refused",
                        "reason_code": "STALE_FRAME",
                        "core_seq": peer_obj.core_seq,
                    }
                )
                peer_obj._enqueue(
                    {
                        "schema": "surface_event/v0.2",
                        "event": "frame_ready",
                        "data": {"frame_ref": peer_obj._frame_ref(count, str(count))},
                    }
                )
            else:
                # Leave rx_queue empty so step 3 raises RuntimeError("injected peer receive queue empty").
                pass

        peer = self._make_injected_peer(regs, config, step_handler=refuse_or_fail)
        state = self.base_state()
        state["agent_tick_page"] = True
        logged = []

        stack.bootstrap_agent_surface(
            peer,
            regs,
            config,
            state,
            self.root,
            600,
            containers_fn=lambda _profile: {"srf-id-12345678"},
            remember_fn=lambda s, r: stack.save_state(r, s),
            log_fn=logged.append,
        )

        # Fail-open: non-STALE_FRAME refusal does not retry; STALE_FRAME retries 3 attempts;
        # error logs once; state still reaches ready.
        self.assertEqual(state["status"], "ready")
        self.assertEqual(
            logged,
            [
                "LIVE_STACK_TICK step=1 attempt=1 outcome=refused:SURFACE_NOT_AGENT_CONTROLLED",
                "LIVE_STACK_TICK step=2 attempt=1 outcome=refused:STALE_FRAME",
                "LIVE_STACK_TICK step=2 attempt=2 outcome=refused:STALE_FRAME",
                "LIVE_STACK_TICK step=2 attempt=3 outcome=refused:STALE_FRAME",
                "LIVE_STACK_TICK step=3 attempt=1 outcome=error:injected peer receive queue empty",
            ],
        )

    def test_binaries_rebuilds_stale_prebuilt_go_adapter_and_keeps_fresh_adapter(self):
        work = self.root / "work-bins"
        work.mkdir()
        fake_src = self.root / "fake-daemon-adapter"
        fake_src.mkdir()
        src_file = fake_src / "main.go"
        src_file.write_text("package main\n")

        core_bin = self.root / "metaviewer-core"
        core_bin.write_bytes(b"#!/bin/sh\nexit 0\n")
        core_bin.chmod(0o700)

        # 1. Prebuilt Go adapter missing deduplicating symbols is stale -> rebuilt into work/mv-daemon-adapter.
        stale_sym_bin = self.root / "stale-sym-adapter"
        stale_sym_bin.write_bytes(b"\xff Go buildinf:go1.26\x00")
        stale_sym_bin.chmod(0o700)
        self.assertTrue(stack.adapter_binary_stale(stale_sym_bin, source_root=fake_src))

        build_calls = []

        def fake_checked(cmd, **kwargs):
            build_calls.append((cmd, kwargs))
            out_bin = Path(cmd[cmd.index("-o") + 1])
            out_bin.write_bytes(
                b"\xff Go buildinf:go1.26\x00PublishIfChanged\x00DeduplicateUnchanged\x00PublishForced\x00"
            )
            out_bin.chmod(0o700)
            return ""

        resolved = stack.binaries(
            work,
            env={
                "MV_E2E_CORE_BIN": str(core_bin),
                "MV_E2E_ADAPTER_BIN": str(stale_sym_bin),
                "GO": "custom-go",
            },
            checked_fn=fake_checked,
            source_root=fake_src,
        )
        self.assertEqual(len(build_calls), 1)
        self.assertEqual(build_calls[0][0][0], "custom-go")
        self.assertEqual(resolved["adapter"], work / "mv-daemon-adapter")

        # 2. Negative control: fresh Go adapter with symbols and mtime >= sources is used as-is.
        fresh_bin = self.root / "fresh-adapter"
        fresh_bin.write_bytes(
            b"\xff Go buildinf:go1.26\x00PublishIfChanged\x00DeduplicateUnchanged\x00PublishForced\x00"
        )
        fresh_bin.chmod(0o700)
        future_ns = src_file.stat().st_mtime_ns + 10_000_000_000
        os.utime(fresh_bin, ns=(future_ns, future_ns))
        self.assertFalse(stack.adapter_binary_stale(fresh_bin, source_root=fake_src))

        build_calls.clear()
        resolved_fresh = stack.binaries(
            work,
            env={
                "MV_E2E_CORE_BIN": str(core_bin),
                "MV_E2E_ADAPTER_BIN": str(fresh_bin),
            },
            checked_fn=fake_checked,
            source_root=fake_src,
        )
        self.assertEqual(build_calls, [])
        self.assertEqual(resolved_fresh["adapter"], fresh_bin.resolve(strict=True))

    def test_tick_url_percent_encoded_and_decodes_to_full_html(self):
        self.assertIsInstance(stack.TICK_URL, str)
        self.assertTrue(stack.TICK_URL.startswith("data:text/html,"))
        self.assertNotIn("#", stack.TICK_URL)
        parsed = urlsplit(stack.TICK_URL)
        self.assertEqual(parsed.fragment, "")
        payload = stack.TICK_URL[len("data:text/html,") :]
        decoded = unquote(payload)
        self.assertEqual(decoded, stack.TICK_HTML)
        self.assertIn("background:#123", decoded)
        self.assertIn("color:#ff0", decoded)
        self.assertIn("background:#f0f", decoded)
        self.assertIn("setInterval", decoded)

        # Negative control: unencoded '#' turns everything from '#123' onward into a URL fragment.
        broken_url = "data:text/html," + stack.TICK_HTML
        broken_parsed = urlsplit(broken_url)
        self.assertTrue(broken_parsed.fragment.startswith("123"))
        self.assertNotIn("setInterval", broken_parsed.path)

    def test_control_socket_permissions_and_unsafe_negative_controls(self):
        sock = stack.open_control_socket(self.root)
        try:
            ctrl_path = stack.verify_control_socket(self.root)
            info = ctrl_path.lstat()
            self.assertTrue(stat.S_ISSOCK(info.st_mode))
            self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
            self.assertEqual(info.st_uid, os.getuid())

            # Negative control 1: group/world permissions are refused.
            os.chmod(ctrl_path, 0o660)
            with self.assertRaises(stack.StackError) as mode_ctx:
                stack.verify_control_socket(self.root)
            self.assertEqual(mode_ctx.exception.code, "CONTROL_SOCKET_UNSAFE")

            # Negative control 2: wrong owner UID is refused.
            os.chmod(ctrl_path, 0o600)
            with self.assertRaises(stack.StackError) as uid_ctx:
                stack.verify_control_socket(self.root, expected_uid=os.getuid() + 1)
            self.assertEqual(uid_ctx.exception.code, "CONTROL_SOCKET_UNSAFE")
        finally:
            stack.close_control_socket(sock, self.root)

        # Negative control 3: missing control socket is refused.
        with self.assertRaises(stack.StackError) as missing_ctx:
            stack.verify_control_socket(self.root)
        self.assertEqual(missing_ctx.exception.code, "CONTROL_SOCKET_MISSING")

        # Negative control 4: regular file at control.sock path is refused.
        fake_path = stack.control_socket_path(self.root)
        fake_path.write_text("not-a-socket")
        fake_path.chmod(0o600)
        with self.assertRaises(stack.StackError) as reg_ctx:
            stack.verify_control_socket(self.root)
        self.assertEqual(reg_ctx.exception.code, "CONTROL_SOCKET_UNSAFE")
        fake_path.unlink()

    def test_control_socket_peercred_refuses_foreign_uid(self):
        client_sock, server_sock = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            # Same-UID SO_PEERCRED succeeds on a real AF_UNIX socketpair.
            cred = stack.verify_peer_cred(server_sock)
            self.assertEqual(cred["uid"], os.getuid())
            self.assertEqual(cred["pid"], os.getpid())
        finally:
            client_sock.close()
            server_sock.close()

        # Negative control: foreign UID is refused by handle_control_connection and request_agent_handoff.
        c_sock, s_sock = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        core_a, core_b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            fake_peer = Mock()
            fake_peer._sock = core_a
            fake_peer.next_seq = 5
            fake_peer._rx = bytearray()
            peer_holder = {"peer": fake_peer}
            state = self.base_state()

            t = threading.Thread(
                target=stack.handle_control_connection,
                args=(s_sock, peer_holder, state, self.root),
                kwargs={"peercred_fn": lambda _conn: (9999, os.getuid() + 1000, os.getgid())},
            )
            t.start()
            with self.assertRaises(stack.StackError) as ctx:
                stack.request_agent_handoff(sock=c_sock)
            t.join(timeout=2.0)
            self.assertEqual(ctx.exception.code, "PEER_CRED_REFUSED")
            self.assertIs(peer_holder["peer"], fake_peer)
            self.assertNotIn("agent_handoff", state)
            fake_peer.close.assert_not_called()
        finally:
            c_sock.close()
            core_a.close()
            core_b.close()

    def test_scm_rights_agent_handoff_socketpair_and_second_handoff_refused(self):
        core_agent_sock, core_server_sock = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sup_peer = stack.live.CoreClient(
                str(self.root / "core.sock"),
                timeout_s=20,
                max_line_bytes=1 << 20,
                max_reply_bytes=1 << 20,
            )
            sup_peer._sock = core_agent_sock
            sup_peer._next_seq = 7
            sup_peer._rx = bytearray(b'{"buffered":true}\n')
            sup_peer._hello_complete = True
            stack.live._lane_state(sup_peer)["inbound_seq"] = 11

            peer_holder = {"peer": sup_peer}
            state = self.base_state()
            stack.save_state(self.root, state)

            # 1. First handoff over AF_UNIX socketpair passes the open fd via SCM_RIGHTS.
            c1, s1 = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                t1 = threading.Thread(
                    target=stack.handle_control_connection,
                    args=(s1, peer_holder, state, self.root),
                )
                t1.start()
                handoff = stack.request_agent_handoff(sock=c1)
                t1.join(timeout=2.0)
            finally:
                c1.close()

            self.assertEqual(handoff["next_seq"], 7)
            self.assertEqual(handoff["inbound_seq"], 11)
            self.assertEqual(bytes.fromhex(handoff["rx_hex"]), b'{"buffered":true}\n')
            self.assertIsNone(peer_holder["peer"])
            self.assertIsNone(sup_peer._sock)

            persisted = stack.load_state(self.root)
            self.assertEqual(
                persisted["agent_handoff"],
                {
                    "pid": os.getpid(),
                    "uid": os.getuid(),
                    "next_seq": 7,
                    "inbound_seq": 11,
                },
            )

            # Verify the passed fd is the live connected endpoint to core_server_sock.
            runner_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM, fileno=handoff["fd"])
            try:
                runner_sock.sendall(b"ping-from-runner\n")
                self.assertEqual(core_server_sock.recv(64), b"ping-from-runner\n")

                # 2. Negative control: a second handoff request is refused with ALREADY_HANDED_OFF.
                c2, s2 = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
                try:
                    t2 = threading.Thread(
                        target=stack.handle_control_connection,
                        args=(s2, peer_holder, state, self.root),
                    )
                    t2.start()
                    with self.assertRaises(stack.StackError) as second_ctx:
                        stack.request_agent_handoff(sock=c2)
                    t2.join(timeout=2.0)
                    self.assertEqual(second_ctx.exception.code, "ALREADY_HANDED_OFF")
                finally:
                    c2.close()
            finally:
                runner_sock.close()

            # Because the supervisor closed its fd copy on handoff, closing runner_sock reaches EOF on core.
            core_server_sock.settimeout(1.0)
            self.assertEqual(core_server_sock.recv(16), b"")
        finally:
            core_server_sock.close()

    def test_release_default_config_reset_and_loss_tolerant_controls(self):
        # 1. Release vs debug core binary selection.
        work = self.root / "work-rel-dbg"
        work.mkdir()
        target_dir = self.root / "cargo-target"
        adapter_bin = self.root / "adapter-bin"
        adapter_bin.write_bytes(b"#!/bin/sh\nexit 0\n")
        adapter_bin.chmod(0o700)
        commit = "c" * 40
        stack.live.write_binary_provenance(adapter_bin, "adapter", commit=commit, repo_root=stack.ROOT)
        cargo_invocations = []

        def fake_cargo(cmd, **_kwargs):
            cargo_invocations.append([str(x) for x in cmd])
            prof = "release" if "--release" in cmd else "debug"
            out = target_dir / prof / "metaviewer-core"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(b"#!/bin/sh\nexit 0\n")
            out.chmod(0o700)
            return ""

        env = {"CARGO": "cargo", "CARGO_TARGET_DIR": str(target_dir), "MV_E2E_ADAPTER_BIN": str(adapter_bin)}
        rel = stack.binaries(work, env=env, checked_fn=fake_cargo, expected_commit=commit)
        self.assertEqual(rel["core"], target_dir / "release/metaviewer-core")
        self.assertIn("--release", cargo_invocations[-1])

        dbg = stack.binaries(work, env=env, checked_fn=fake_cargo, expected_commit=commit, debug=True)
        self.assertEqual(dbg["core"], target_dir / "debug/metaviewer-core")
        self.assertNotIn("--release", cargo_invocations[-1])

        # 2. Persistent config dir survives cleanup/stop and is removed by reset-config.
        cfg = stack.ensure_config_dir(self.root, env={})
        marker = cfg / "metaviewer/settings.json"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text('{"persisted":true}', encoding="utf-8")
        st = self.base_state()
        ram = self.root / "ram-rel"
        ram.mkdir()
        stack.save_state(self.root, st)
        with patch.dict(os.environ, dict(self.live_env(), MV_SRF_LIVE_RAM_ROOT=str(ram)), clear=True), \
                patch.object(stack, "inventory", return_value=set()), \
                patch.object(stack.live, "profile_containers", return_value=set()), \
                redirect_stdout(io.StringIO()):
            stack.cleanup(st, self.root)
        self.assertTrue(marker.is_file())
        with redirect_stdout(io.StringIO()):
            stack.reset_config(self.root, env={})
        self.assertFalse(cfg.exists())

        # 3. Capsule loss tolerance vs fail-closed default.
        loss_body = {
            "schema": "surface_event/v0.2",
            "event": "error",
            "data": {"surface_id": "s-1", "code": "capture_failed", "detail": "capsule gone"},
        }
        peer = Mock(_sock=object(), _rx=b"1\n")
        peer.recv.return_value = {"body": loss_body}
        with patch.object(stack.select, "select", return_value=([], [], [])), \
                self.assertRaisesRegex(RuntimeError, "native surface error"):
            stack.monitor(peer, [], 10, lambda: False, lambda: None, tolerate_capsule_loss=False)

        logged = []
        seen = [0]

        def drain_once():
            seen[0] += 1
            peer._rx = b""
            return {"body": loss_body}

        peer._rx = b"1\n"
        peer.recv.side_effect = drain_once
        with patch.object(stack.select, "select", return_value=([], [], [])):
            stack.monitor(
                peer,
                [],
                10,
                lambda: seen[0] >= 1,
                lambda: None,
                tolerate_capsule_loss=True,
                log_fn=logged.append,
            )
        self.assertEqual(len(logged), 1)
        self.assertTrue(logged[0].startswith("LIVE_CAPSULE_LOST "))


if __name__ == "__main__":
    unittest.main()
