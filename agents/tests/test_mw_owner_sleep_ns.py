"""Nanosecond owner seam and a delayed poll through pinned Wender replay."""
from contextlib import contextmanager
import signal
import time
import unittest
from unittest.mock import patch

import test_mw_owner as fixtures
from metaviewer_agents.mw_owner import OwnerRefused


@contextmanager
def wall_timeout():
    """Bound even a restored seconds-based sleeper without a pytest plugin."""
    def expired(signum, frame):
        raise AssertionError('verify replay exceeded wall timeout')

    previous = signal.signal(signal.SIGALRM, expired)
    timer = signal.setitimer(signal.ITIMER_REAL, 10)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, *timer)
        signal.signal(signal.SIGALRM, previous)


class OwnerSleepTests(unittest.TestCase):
    # Reuse setup/helpers without inheriting and rediscovering the existing tests.
    setUp = fixtures.OwnerTests.setUp
    remove_private_imports = fixtures.OwnerTests.remove_private_imports
    rewrite = fixtures.OwnerTests.rewrite
    install_backend = fixtures.OwnerTests.install_backend

    def test_owner_sleep_converts_nanoseconds(self):
        with patch('metaviewer_agents.mw_owner.time.sleep') as sleep:
            owners = self.owner.owners()
            owners.sleep(500_000_000)
            sleep.assert_called_once_with(0.5)
            sleep.reset_mock()
            owners.sleep(0)
            sleep.assert_called_once_with(0)
            sleep.reset_mock()
            for invalid in (True, False, 0.5, 500_000_000.0, -1):
                with self.subTest(invalid=invalid):
                    with self.assertRaisesRegex(OwnerRefused, '^MW_SLEEP_NS$'):
                        owners.sleep(invalid)
                    sleep.assert_not_called()

    def test_verify_poll_false_then_true_finishes_inside_deadline(self):
        def delayed(workflow, site):
            workflow['steps'][0]['verify'].update(
                poll_interval_ms=500, deadline_ms=10_000)
        self.rewrite(delayed)
        self.install_backend()
        start = time.monotonic_ns()
        now = start
        sleeps = []
        polls = []
        acquire = self.owner.acquire
        backend_call = self.owner.backend.call
        predicate = self.corpus.workflow['steps'][0]['verify']['predicate']

        def clock():
            nonlocal now
            # Fresh publications must follow the input causally, even without IO.
            now += 1
            return now

        def seconds_sleep(seconds):
            nonlocal now
            sleeps.append(seconds)
            now += round(seconds * 1_000_000_000)

        def delayed_acquire(request, deadline):
            observation = acquire(request, deadline)
            if request == predicate:
                polls.append(observation.value)
            return observation

        def delayed_backend(stage, **args):
            result = backend_call(stage, **args)
            if stage == 'ax' and len(self.proposals) == 1 and not polls:
                for node in result['nodes']:
                    node['focused'] = False
            return result

        self.owner.backend.call = delayed_backend
        with wall_timeout(), \
                patch('metaviewer_agents.mw_owner.time.monotonic_ns', side_effect=clock), \
                patch('metaviewer_agents.mw_owner.time.sleep', side_effect=seconds_sleep), \
                patch.object(self.owner, 'acquire', side_effect=delayed_acquire):
            result = self.owner.run()
        self.assertEqual(result.verdict_code, 'VERIFIED', result)
        self.assertEqual(polls, [False, True])
        self.assertEqual(sleeps, [0.5])
        self.assertGreaterEqual(now - start, 500_000_000)
        self.assertLess(now - start, 10_000_000_000)


if __name__ == '__main__':
    unittest.main()
