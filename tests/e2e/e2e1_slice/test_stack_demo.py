"""Offline unit tests for stack.py demo display and screen recording controls."""

import argparse
from contextlib import redirect_stdout
import importlib.util
import io
import os
from pathlib import Path
import shutil
import signal
import tempfile
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location(
    "live_stack_demo", Path(__file__).with_name("stack.py")
)
stack = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stack)

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

        visible_args = stack.parser().parse_args(
            ["start", "--ttl", "10m", "--display", "visible", "--record", "/tmp/demo.mp4"]
        )
        self.assertEqual(visible_args.ttl, 600)
        self.assertEqual(visible_args.display, "visible")
        self.assertEqual(visible_args.record, "/tmp/demo.mp4")

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


if __name__ == "__main__":
    unittest.main()
