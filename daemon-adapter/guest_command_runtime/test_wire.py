import socket
import struct
import threading
import time
import unittest
from wire import FramedSocket, HEADER, MAGIC, WireError, frame_bytes


def validate(kind, meta, size):
    if set(meta) != {'kind'} or meta['kind'] != kind:
        raise WireError('metadata kind mismatch')


class WireTests(unittest.TestCase):
    def setUp(self):
        self.a, self.b = socket.socketpair()
        self.addCleanup(self.a.close)
        self.addCleanup(self.b.close)

    def test_fragmented_and_coalesced_frames(self):
        one = frame_bytes(1, 1, {'kind': 1}, b'one\x00', validate)
        two = frame_bytes(2, 2, {'kind': 2}, b'two', validate)
        def write():
            for byte in one[:20]:
                self.a.sendall(bytes([byte]))
            self.a.sendall(one[20:] + two)
        thread = threading.Thread(target=write)
        thread.start()
        receiver = FramedSocket(self.b, validate)
        self.assertEqual(receiver.receive(lifetime_deadline=time.monotonic()+1), (1, {'kind':1}, b'one\x00'))
        self.assertEqual(receiver.receive(lifetime_deadline=time.monotonic()+1), (2, {'kind':2}, b'two'))
        thread.join(1)
        self.assertFalse(thread.is_alive())

    def test_replayed_sequence_poisoned(self):
        raw = frame_bytes(1, 1, {'kind': 1}, b'', validate)
        self.a.sendall(raw + raw)
        receiver = FramedSocket(self.b, validate)
        receiver.receive(lifetime_deadline=time.monotonic()+1)
        with self.assertRaisesRegex(WireError, 'sequence'):
            receiver.receive(lifetime_deadline=time.monotonic()+1)
        with self.assertRaisesRegex(WireError, 'terminal'):
            receiver.receive(lifetime_deadline=time.monotonic()+1)

    def test_invalid_metadata_is_terminal(self):
        for raw in (b'{"kind":1,"kind":1}', b'{"kind":NaN}', b'{"kind":1,"extra":0}', b'\xff'):
            with self.subTest(raw=raw):
                a,b=socket.socketpair()
                try:
                    a.sendall(HEADER.pack(MAGIC,1,1,0,len(raw),0,1)+raw)
                    receiver=FramedSocket(b,validate)
                    with self.assertRaises((WireError,ValueError)):
                        receiver.receive(lifetime_deadline=time.monotonic()+1)
                    self.assertTrue(receiver.poisoned)
                finally:a.close();b.close()

    def test_length_rejected_before_body(self):
        self.a.sendall(HEADER.pack(MAGIC,1,1,0,4097,0,1))
        receiver=FramedSocket(self.b,validate)
        with self.assertRaisesRegex(WireError,'length'):
            receiver.receive(lifetime_deadline=time.monotonic()+1)

    def test_partial_timeout_and_eof(self):
        self.a.sendall(b'M')
        receiver=FramedSocket(self.b,validate,partial_seconds=.02)
        with self.assertRaises(WireError):
            receiver.receive(lifetime_deadline=time.monotonic()+1)
        self.assertTrue(receiver.poisoned)

    def test_bad_outbound_metadata_has_no_effect(self):
        sender=FramedSocket(self.a,validate)
        with self.assertRaises(WireError):
            sender.send(1,{'kind':2},deadline=time.monotonic()+1)
        self.assertEqual(sender.tx_sequence,1)
        self.assertFalse(sender.poisoned)
        self.b.setblocking(False)
        with self.assertRaises(BlockingIOError):self.b.recv(1)

    def test_wire_vector_is_architecture_independent(self):
        raw=frame_bytes(3,7,{'kind':3},b'x',validate)
        self.assertEqual(raw[:24].hex(),'4d564743010300000000000a000000010000000000000007')


if __name__ == '__main__':
    unittest.main()
