"""Tests for the private signalling boundary; no host signal is issued."""
import pathlib
import sys
import types
import unittest
from unittest.mock import patch

source = pathlib.Path(__file__).with_name("reaper.py").read_text(encoding="utf-8")
if "--mutant" in sys.argv:
    sys.argv.remove("--mutant")
    source = source.replace("1 < pid <= 2147483647", "0 <= pid <= 2147483647")
reaper = types.ModuleType("private_reaper")
exec(compile(source, "private_reaper", "exec"), reaper.__dict__)


class SignalPolicy(unittest.TestCase):
    def test_rejects_invalid_and_noninteger_pids(self):
        with patch.object(reaper.os, "getpid", return_value=42), patch.object(
                reaper.os, "getpgrp", return_value=43):
            for pid in (-1, 0, 1, 42, 43, 2147483648, True, 44.0, "44", object()):
                self.assertFalse(reaper.signalable(pid, True), repr(pid))
            self.assertFalse(reaper.signalable(44, False))
            self.assertTrue(reaper.signalable(44, True))

    def test_invalid_owned_entry_cannot_reach_signal_backend(self):
        owner = reaper.Reaper(16)
        owner.owned[0] = (123, 456)
        with patch.object(reaper.signal, "pidfd_send_signal") as send:
            with self.assertRaises(PermissionError):
                owner.send(reaper.signal.SIGKILL)
            send.assert_not_called()

    def test_pidfd_exit_is_tolerated_but_permission_failure_propagates(self):
        owner = reaper.Reaper(16)
        owner.owned[2147483646] = (123, 456)
        with patch.object(reaper.signal, "pidfd_send_signal", side_effect=ProcessLookupError):
            owner.send(reaper.signal.SIGKILL)
        with patch.object(reaper.signal, "pidfd_send_signal", side_effect=PermissionError):
            with self.assertRaises(PermissionError):
                owner.send(reaper.signal.SIGKILL)

    def test_proc_failure_propagates(self):
        owner = reaper.Reaper(16)
        with patch.object(reaper.os, "scandir", side_effect=PermissionError):
            with self.assertRaises(PermissionError):
                owner.discover()

    def test_retained_identity_permission_propagates(self):
        owner = reaper.Reaper(16)
        owner.owned[100] = (123, 456)
        def lookup(pid):
            if pid == 100:
                raise PermissionError()
            return (1, 1)
        with patch.object(reaper, "exited", return_value=False), patch.object(reaper, "identity", side_effect=lookup), patch.object(reaper.os, "scandir") as scan:
            scan.return_value.__enter__.return_value = []
            with self.assertRaises(PermissionError):
                owner.discover()

    def test_candidate_identity_permission_propagates(self):
        import io
        owner = reaper.Reaper(16)
        task = types.SimpleNamespace(name="1")
        with patch.object(reaper, "identity", side_effect=[(1, 1), (1, 1), PermissionError]), patch.object(reaper.os, "scandir") as scan, patch("builtins.open", return_value=io.StringIO("100")):
            scan.return_value.__enter__.return_value = [task]
            with self.assertRaises(PermissionError):
                owner.discover()

    def test_identity_accepts_non_utf8_comm(self):
        import io
        stat = b"123 (bad\xff)comm) S 42 43 " + b"0 " * 16 + b"987 0"
        with patch("builtins.open", return_value=io.BytesIO(stat)):
            self.assertEqual(reaper.identity(123), (42, 987))

    def test_reaped_owned_pidfd_is_released(self):
        owner = reaper.Reaper(1)
        owner.owned[100] = (123, 456)
        with patch.object(reaper.os, "waitpid", side_effect=[(100, 0), ChildProcessError]), patch.object(reaper.os, "close") as close, patch("builtins.print"):
            self.assertTrue(owner.reap())
            self.assertEqual(owner.owned, {})
            close.assert_called_once_with(123)

    def test_reaping_is_bounded_and_reports_capacity_failure(self):
        owner = reaper.Reaper(1)
        with patch.object(reaper.os, "waitpid", side_effect=[(100, 0), (101, 0), ChildProcessError]), patch("builtins.print") as output:
            self.assertTrue(owner.reap())
            self.assertTrue(owner.failed)
            output.assert_called_once_with(100, flush=True)


if __name__ == "__main__":
    unittest.main()
