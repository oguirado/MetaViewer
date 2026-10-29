"""Current RGB pixels must bind to the public frame identity before transport."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from metaviewer_agents.perception.base import Frame, PerceptionError
from metaviewer_agents.perception.meta_muse import MetaMusePerceptionAdapter


class MuseIdentityTests(unittest.TestCase):
    def test_mismatched_frame_and_ram_path_refused_before_transport(self):
        pixels_a, pixels_b = b"AAAAAA", b"BBBBBB"
        with tempfile.TemporaryDirectory(dir="/dev/shm") as temporary:
            path = Path(temporary) / "frame.rgb"
            path.write_bytes(pixels_b)
            ref = {"schema": "frame_ref/v0.1", "width": 2, "height": 1,
                   "sha256": hashlib.sha256(pixels_a).hexdigest(), "ramws_path": str(path)}
            for source in (Frame(2, 1, pixels_b), str(path)):
                for previous in (None, Frame(2, 1, pixels_b), str(path)):
                    with self.subTest(source=type(source).__name__, previous=type(previous).__name__):
                        spy = mock.Mock(return_value=json.dumps({"schema": "muse.vision/v1",
                            "vision": {"summary": "", "elements": [], "changed_regions": []}}).encode())
                        adapter = MetaMusePerceptionAdapter(transport=spy, credential=b"fixture")
                        with self.assertRaises(PerceptionError) as caught:
                            adapter.perceive(ref, source, prev=previous)
                        self.assertEqual(caught.exception.code, "identity_mismatch")
                        spy.assert_not_called()
                        self.assertNotIn(pixels_b.decode(), str(caught.exception))
            path.write_bytes(pixels_a)
            spy = mock.Mock(return_value=b'{"schema":"muse.vision/v1","vision":{"summary":"","elements":[],"changed_regions":[]}}')
            adapter = MetaMusePerceptionAdapter(transport=spy, credential=b"fixture")
            self.assertEqual(adapter.perceive(ref, str(path))["summary"], "")
            spy.assert_called_once()
