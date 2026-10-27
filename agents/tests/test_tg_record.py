"""U-AG-05 adapted to the admitted record_request/record_event codec.

No agent recording transport API exists. These assertions cover the codec's RAM
start/stop/event and disk-destination preconditions, not a fabricated recorder.
The live stream and repository-wide disk-write guarantee remain core/E2E work.
"""
import contextlib
import copy
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from metaviewer_agents import envelope


def wrap(body):
    return envelope.make_envelope(msg_id="record-test", from_component="agent",
        from_instance="agent-test", to_component="core", to_instance="core-test",
        session_id="record-session", seq=1, ts_ns=0, nonce="ab" * 16, body=body)


class RecordingCodecGapTests(unittest.TestCase):
    def roundtrip(self, body):
        env = wrap(body)
        decoded = envelope.loads_envelope(envelope.dumps_envelope(env, max_bytes=65536),
                                         max_bytes=65536)
        self.assertEqual(decoded["body"], body)
        return decoded

    def test_ram_start_stop_and_event_sequence_have_closed_roundtrips(self):
        # Mutation: _BODIES.pop("record_event/v0.2") after schema registration.
        start = {"schema": "record_request/v0.2", "request_id": "r-start",
                 "op": "ram_start", "params": {"surface_id": "s1", "recording_id": "rec1",
                 "ring_bytes": 4096, "max_fps": 30}}
        stop = {"schema": "record_request/v0.2", "request_id": "r-stop",
                "op": "ram_stop", "params": {"surface_id": "s1", "recording_id": "rec1"}}
        events = [{"event": "started", "mode": "ram"},
                  {"event": "frame_captured", "ram_path": "/dev/shm/record.rgb",
                   "sha256": "ab" * 32, "byte_count": 48},
                  {"event": "stopped", "frame_count": 1, "byte_count": 48}]
        for request in (start, stop):
            self.roundtrip(request)
            bad = copy.deepcopy(request)
            del bad["params"]["recording_id"]
            with self.assertRaises(envelope.EnvelopeError) as caught:
                wrap(bad)
            self.assertEqual(caught.exception.code, "bad_shape")
        for index, fields in enumerate(events):
            event = {"schema": "record_event/v0.2", "request_id": "r-start",
                     "surface_id": "s1", "recording_id": "rec1", "mono_ns": index,
                     **fields}
            self.roundtrip(event)
            bad = dict(event, invented_field=True)
            with self.assertRaises(envelope.EnvelopeError) as caught:
                wrap(bad)
            self.assertEqual(caught.exception.code, "bad_shape")

    def test_disk_requires_destination_and_capability_without_local_writes(self):
        # Mutation: remove destination_path from record_request disk_start.required.
        with tempfile.TemporaryDirectory(prefix="tg-record-") as directory:
            root = Path(directory)
            home, working = root / "home", root / "work"
            home.mkdir()
            working.mkdir()
            sentinel = home / "sentinel"
            sentinel.write_bytes(b"unchanged")

            def snapshot():
                return {str(path.relative_to(root)): path.read_bytes()
                        for path in root.rglob("*") if path.is_file()}

            before = snapshot()
            valid = {"schema": "record_request/v0.2", "request_id": "r-disk",
                     "op": "disk_start", "params": {"surface_id": "s1",
                     "recording_id": "rec1", "destination_capability_id": "dest-1",
                     "destination_path": str(working / "output"), "max_fps": 30}}
            with patch.dict(os.environ, {"HOME": str(home)}), contextlib.chdir(working):
                self.roundtrip(valid)
                for missing in ("destination_path", "destination_capability_id"):
                    with self.subTest(missing=missing):
                        bad = copy.deepcopy(valid)
                        del bad["params"][missing]
                        with self.assertRaises(envelope.EnvelopeError) as caught:
                            wrap(bad)
                        self.assertEqual(caught.exception.code, "bad_shape")
                self.assertEqual(snapshot(), before)


if __name__ == "__main__":
    unittest.main()
