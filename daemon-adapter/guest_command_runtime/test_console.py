import hashlib
import io
from pathlib import Path
import sys
import types
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from guest_command_runtime.native import NativeVM
from test_config import profile


class ConsoleTests(unittest.TestCase):
    def test_full_drain_retains_only_bounded_tail(self):
        value=b'x'*100000+b'tail'
        native=NativeVM(profile(),lambda *args:None)
        native.process=types.SimpleNamespace(stdout=io.BytesIO(value))
        native._capture_console()
        self.assertEqual(native.console_bytes,len(value))
        self.assertEqual(bytes(native.console_tail),value[-4096:])
        self.assertEqual(native.console_hash.hexdigest(),hashlib.sha256(value).hexdigest())
        self.assertIsNone(native.console_error)

    def test_partial_boundary_lines_are_never_published(self):
        secret='a'*64
        for value in (b'x'*4096+secret.encode()[1:]+b'\n', b'prefix '+secret.encode()[:-1]):
            native=NativeVM(profile(),lambda *args:None);native.nonce=secret
            native.process=types.SimpleNamespace(stdout=io.BytesIO(value));native._capture_console()
            self.assertNotIn('a'*16,native._console_summary()['tail'])
        native=NativeVM(profile(),lambda *args:None);native.nonce=secret
        native.process=types.SimpleNamespace(stdout=io.BytesIO(b'nonce='+secret.encode()+b'\n'))
        native._capture_console();self.assertEqual(native._console_summary()['tail'],'nonce=<redacted>\n')


if __name__=='__main__':unittest.main()
