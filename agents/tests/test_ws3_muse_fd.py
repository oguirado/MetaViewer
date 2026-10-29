"""Descriptor shape refusals use real RAM files and a nonblocking FIFO."""
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


class MuseDescriptorTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir="/dev/shm")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.pixels = b"ABCDEF"
        self.ref = {"schema": "frame_ref/v0.1", "width": 2, "height": 1,
                    "sha256": hashlib.sha256(self.pixels).hexdigest()}
        self.spy = mock.Mock(return_value=b'{"schema":"muse.vision/v1","vision":{"summary":"","elements":[],"changed_regions":[]}}')
        self.adapter = MetaMusePerceptionAdapter(transport=self.spy, credential=b"fixture")

    def refused(self, path):
        with self.assertRaises(PerceptionError) as caught:
            self.adapter.perceive(self.ref, path)
        self.assertEqual(caught.exception.code, "bad_shape")
        self.spy.assert_not_called()

    def test_regular_rgb_descriptor_admitted_without_moving_cursor(self):
        file = self.root / "frame.rgb"
        file.write_bytes(self.pixels)
        with file.open("rb") as stream:
            stream.seek(2)
            self.adapter.perceive(self.ref, f"/proc/self/fd/{stream.fileno()}")
            self.assertEqual(stream.tell(), 2)
        self.spy.assert_called_once()

    def test_wrong_size_descriptors_refused(self):
        file = self.root / "frame.rgb"
        for pixels in (b"", self.pixels[:-1], self.pixels + b"X"):
            with self.subTest(size=len(pixels)):
                file.write_bytes(pixels)
                with file.open("rb") as stream:
                    self.refused(f"/proc/self/fd/{stream.fileno()}")

    def test_fifo_descriptor_refused(self):
        fifo = self.root / "fifo"
        os.mkfifo(fifo)
        fd = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
        try:
            self.refused(f"/proc/self/fd/{fd}")
        finally:
            os.close(fd)

    def test_unreadable_and_closed_descriptors_refused(self):
        file = self.root / "frame.rgb"
        file.write_bytes(self.pixels)
        fd = os.open(file, os.O_WRONLY)
        try:
            self.refused(f"/proc/self/fd/{fd}")
        finally:
            os.close(fd)
        self.refused(f"/proc/self/fd/{fd}")

    def test_leading_zero_descriptor_refused(self):
        self.refused("/proc/self/fd/00")

    def test_proc_regular_descriptor_with_unreported_size_refused(self):
        # A proc-backed regular file can supply a complete RGB triple while
        # reporting st_size=0. Unlike a short tmpfs file, Frame validation
        # alone cannot reject it. Restore the calling thread's name always.
        comm = Path("/proc/self/comm")
        original = comm.read_bytes()
        try:
            comm.write_bytes(b"ws")
            self.ref = {"schema": "frame_ref/v0.1", "width": 1, "height": 1,
                        "sha256": hashlib.sha256(b"ws\n").hexdigest()}
            with comm.open("rb") as stream:
                self.assertEqual(os.fstat(stream.fileno()).st_size, 0)
                self.assertEqual(stream.read(), b"ws\n")
                self.refused(f"/proc/self/fd/{stream.fileno()}")
        finally:
            comm.write_bytes(original.rstrip(b"\n"))
