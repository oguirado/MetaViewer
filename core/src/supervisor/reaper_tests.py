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

    def test_reaping_is_bounded_and_reports_capacity_failure(self):
        owner = reaper.Reaper(1)
        with patch.object(reaper.os, "waitpid", side_effect=[(100, 0), (101, 0), ChildProcessError]), patch("builtins.print") as output:
            self.assertTrue(owner.reap())
            self.assertTrue(owner.failed)
            output.assert_called_once_with(100, flush=True)


if __name__ == "__main__":
    unittest.main()
