"""Authenticated frame subscription interleaving over the existing tool mailbox."""
import copy
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_mw_run_program import frame
from metaviewer_agents.client import ToolClient
from metaviewer_agents.tools import ToolValidationError


class FrameClientTests(unittest.TestCase):
    def setUp(self):
        self.c = ToolClient('/unused', session_id='session-test',
            local=dict(endpoint=dict(component='agent', instance='agent-test')),
            core=dict(endpoint=dict(component='core', instance='core-test')),
            dependency_pins=[], sequence_path='/unused', timeout_s=30,
            max_line_bytes=65536, max_reply_bytes=65536)
        self.c.active = Mock(_timeout_s=30, next_seq=1)
        self.c._ready = True
        self.c._reserve = Mock()

    def reply(self, body, **over):
        return dict({'from':self.c.core['endpoint'], 'to':self.c.local['endpoint'],
                     'session_id':self.c.session_id, 'body':body}, **over)

    def event(self, generation=2):
        return dict(schema='surface_event/v0.2', event='frame_ready',
                    data=dict(frame_ref=frame(generation)))

    def request(self):
        return self.c.request(dict(schema='mv_tool_call/v0.2',request_id='req',
            op='observe',args=dict(surface_id='surface-alice')), 'mv_tool_result/v0.2',timeout_ms=1000)

    def test_subscription_and_new_publication_then_cleanup_preserve_tool_reply(self):
        self.c.subscribe_frames('surface-alice', timeout_ms=1000)
        sent = self.c.active.send.call_args.args[0]
        self.assertEqual(sent['body'], dict(schema='surface_request/v0.2',
            op='frame_subscribe', params=dict(surface_id='surface-alice')))
        result = dict(schema='mv_tool_result/v0.2',request_id='req',op='observe',status='ok',observation={})
        self.c.active.recv.side_effect = [self.reply(self.event(1)), self.reply(self.event(2)), self.reply(result)]
        reply = self.request()
        self.assertEqual(reply, result)
        self.assertEqual(self.c._frames['surface-alice']['generation'], 2)
        self.c.unsubscribe_frames('surface-alice', timeout_ms=1000)
        self.assertEqual(self.c.active.send.call_args.args[0]['body']['op'], 'frame_unsubscribe')
        self.assertEqual(self.c._frame_subscriptions, set())

    def test_wrong_sender_session_surface_and_malformed_event_close_client(self):
        for mutation in ('sender','session','surface','malformed','body'):
            self.setUp()
            self.c.subscribe_frames('surface-alice', timeout_ms=1000)
            env = self.reply(self.event())
            if mutation == 'sender': env['from'] = dict(component='daemon',instance='wrong')
            elif mutation == 'session': env['session_id'] = 'other'
            elif mutation == 'surface': env['body']['data']['frame_ref']['surface_id'] = 'other'
            elif mutation=='body': env['body']=[]
            else: env['body']['extra'] = True
            self.c.active.recv.return_value = env
            with self.subTest(mutation=mutation), self.assertRaises(ToolValidationError):
                self.request()
            self.assertFalse(self.c._ready)
            self.c.active.close.assert_called()

    def test_stale_event_overflow_never_implies_fresh_frame(self):
        self.c.subscribe_frames('surface-alice', timeout_ms=1000)
        self.c.active.recv.return_value = self.reply(self.event(1))
        with self.assertRaisesRegex(ToolValidationError, 'capacity'):
            self.request()
        self.assertFalse(self.c._ready)

    def test_same_owner_drain_authenticates_frames_and_never_discards_tool_response(self):
        self.c.subscribe_frames('surface-alice',timeout_ms=1000)
        self.c.active._rx=bytearray(b'\n')
        self.c.active.recv.return_value=self.reply(self.event(2))
        self.assertTrue(self.c.drain_frames(timeout_ms=1000))
        self.assertEqual(self.c._frames['surface-alice']['generation'],2)
        self.c.active._rx=bytearray()
        with patch('metaviewer_agents.client.select.select',return_value=([],[],[])):
            self.assertFalse(self.c.drain_frames(timeout_ms=1000))
        self.c.active._rx=bytearray(b'\n')
        self.c.active.recv.return_value=self.reply(dict(schema='mv_tool_result/v0.2'))
        with self.assertRaisesRegex(ToolValidationError,'unexpected response'):
            self.c.drain_frames(timeout_ms=1000)
        self.assertFalse(self.c._ready)


if __name__ == '__main__':
    unittest.main()
