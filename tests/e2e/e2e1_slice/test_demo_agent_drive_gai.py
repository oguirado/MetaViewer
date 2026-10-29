"""Hosted G-AI driver regression: no display, Docker or live processes."""

import importlib.util
from pathlib import Path
import signal
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    'demo_agent_drive_gai', Path(__file__).with_name('demo_agent_drive.py'))
demo = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(demo)
Session = demo.g_ai_stack.Session


class GaiSessionTests(unittest.TestCase):
    def test_driver_constructs_gai_session_with_parsed_ttl(self):
        sessions = []

        def start(session):
            sessions.append(session)
            session.work = Path('stub-work')
            session.surface_id = 'stub-surface'
            session.capsule = 'stub-capsule'
            session.display = ':stub'
            return session

        with patch.object(Session, 'start', start), \
                patch.object(demo, 'run_demo_agent_drive') as run, \
                patch.object(demo.g_ai_stack.signal, 'getsignal', return_value=signal.SIG_DFL), \
                patch.object(demo.g_ai_stack.signal, 'getitimer', return_value=(0.0, 0.0)), \
                patch.object(demo.g_ai_stack.signal, 'signal') as handler, \
                patch.object(demo.g_ai_stack.signal, 'setitimer') as timer:
            self.assertEqual(demo.main(['--session', 'g-ai', '--ttl', '2m']), 0)
            self.assertEqual(sessions[0].ttl, 120)
            self.assertIs(run.call_args.args[0], sessions[0])
            self.assertEqual(timer.call_args_list[0].args, (signal.ITIMER_REAL, 120))
            self.assertEqual(timer.call_args_list[-1].args, (signal.ITIMER_REAL, 0))
            self.assertEqual(handler.call_args_list[-1].args,
                             (signal.SIGALRM, signal.SIG_DFL))

    def test_invalid_ttl_is_rejected_before_startup(self):
        for ttl in (0, -1, True, 1.5, '2m', 86401):
            with self.subTest(ttl=ttl), self.assertRaises(ValueError):
                Session(ttl=ttl)

    def test_no_ttl_preserves_lifecycle_without_alarm(self):
        with patch.object(Session, 'start', lambda session: session), \
                patch.object(demo.g_ai_stack.signal, 'setitimer') as timer:
            with Session() as session:
                self.assertIsNone(session.ttl)
            timer.assert_not_called()

    def test_ttl_expiry_uses_context_cleanup(self):
        peer = SimpleNamespace(close=unittest.mock.Mock())
        with patch.object(Session, 'start', lambda session: session), \
                patch.object(demo.g_ai_stack.signal, 'getsignal', return_value=signal.SIG_DFL), \
                patch.object(demo.g_ai_stack.signal, 'getitimer', return_value=(0.0, 0.0)), \
                patch.object(demo.g_ai_stack.signal, 'signal'), \
                patch.object(demo.g_ai_stack.signal, 'setitimer') as timer:
            with self.assertRaisesRegex(TimeoutError, 'TTL expired'):
                with Session(ttl=1) as session:
                    session.peers.append(peer)
                    session._expire()
            peer.close.assert_called_once_with()
            self.assertEqual(timer.call_args.args, (signal.ITIMER_REAL, 0))

    def test_existing_alarm_is_preserved(self):
        with patch.object(Session, 'start', lambda session: session), \
                patch.object(demo.g_ai_stack.signal, 'getitimer', return_value=(5.0, 0.0)), \
                patch.object(demo.g_ai_stack.signal, 'setitimer') as timer:
            with self.assertRaisesRegex(RuntimeError, 'alarm is already active'):
                with Session(ttl=1):
                    self.fail('existing timer must not be replaced')
            timer.assert_not_called()


if __name__ == '__main__':
    unittest.main()
