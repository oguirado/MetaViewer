"""U3-AG-02: real RAM pixels cross the adapter's actual subprocess boundary.

Surface binding is owned by tools.observe, and content-digest freshness by core
(per perception/base.py and vcore._ramws_frame). The proposed expected_surface_id
argument does not exist. Test the consumer boundary before local perception and
the existing describe transport digest binding rather than inventing that API.
"""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_ailoop as fixture
from metaviewer_agents import tools, vision
from metaviewer_agents.perception.base import PerceptionError, check_vision
from metaviewer_agents.perception.vcore import VCorePerceptionAdapter


PIXELS = bytes(range(48))

# This is a protocol stub, not a mocked subprocess.run. It validates the actual
# inherited memfd's PNG, decompresses it, and compares every frozen RGB byte.
ENGINE = '''import hashlib, json, pathlib, struct, sys, zlib
path = sys.argv[sys.argv.index('--frame') + 1]
png = pathlib.Path(path).read_bytes()
assert png[:8] == b'\\x89PNG\\r\\n\\x1a\\n'
offset, image = 8, b''
while offset < len(png):
    size = struct.unpack('>I', png[offset:offset + 4])[0]
    kind = png[offset + 4:offset + 8]
    data = png[offset + 8:offset + 8 + size]
    if kind == b'IHDR':
        assert struct.unpack('>II', data[:8]) == (4, 4)
    if kind == b'IDAT':
        image += data
    offset += size + 12
rows = zlib.decompress(image)
assert len(rows) == 52
assert all(rows[i * 13] == 0 for i in range(4))
assert b''.join(rows[i * 13 + 1:(i + 1) * 13] for i in range(4)) == bytes(range(48))
print(json.dumps(dict(schema='ve.cu_describe/v1', frame_sha256=hashlib.sha256(bytes(range(48))).hexdigest(),
    width=4, height=4, changed=None, changed_regions=[], timing_us=7,
    crops=[dict(x=1, y=1, w=2, h=2, reason='salient')])))
'''


def engine_root(root):
    package = root / "vadapt"
    package.mkdir()
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "cu_describe.py").write_text(ENGINE, encoding="utf-8")


class VisionGapTests(unittest.TestCase):
    def test_real_ram_frame_and_memfd_engine_return_localized_vision(self):
        # Mutation: _png_bytes writes zero-filled pixels instead of frame.data.
        with tempfile.TemporaryDirectory(prefix="tg-engine-") as directory, \
                tempfile.TemporaryDirectory(prefix="tg-frame-", dir="/dev/shm") as ram:
            root = Path(directory)
            engine_root(root)
            rgb = Path(ram) / "frozen.rgb"
            rgb.write_bytes(PIXELS)
            ref = dict(fixture.frame(), ramws_path=str(rgb),
                       sha256=hashlib.sha256(PIXELS).hexdigest())
            adapter = VCorePerceptionAdapter(root, python=sys.executable)
            result = adapter.perceive(ref)
            check_vision(result, width=4, height=4)
            self.assertEqual(set(result), {"summary", "changed_regions", "elements"})
            self.assertEqual(result["elements"], [{
                "bbox": {"x": 1, "y": 1, "w": 2, "h": 2},
                "role": "crop", "name": "salient", "confidence": 0.5}])
            self.assertEqual(adapter.last_timing_us, 7)
            self.assertEqual(rgb.read_bytes(), PIXELS)

    def test_truncated_ram_frame_refuses_before_engine_spawn(self):
        # Mutation: frame = _ramws_frame(...) -> Frame(width, height, bytes(width*height*3)).
        with tempfile.TemporaryDirectory(prefix="tg-engine-") as directory, \
                tempfile.TemporaryDirectory(prefix="tg-frame-", dir="/dev/shm") as ram:
            rgb = Path(ram) / "short.rgb"
            rgb.write_bytes(PIXELS[:-1])
            adapter = VCorePerceptionAdapter(directory, python=sys.executable)
            with patch("metaviewer_agents.perception.vcore.subprocess.run") as spawn:
                with self.assertRaises(PerceptionError) as caught:
                    adapter.perceive(dict(fixture.frame(), ramws_path=str(rgb)))
                self.assertEqual(caught.exception.code, "bad_shape")
                spawn.assert_not_called()

    def test_cross_surface_observation_never_reaches_perception(self):
        # Mutation: disable tools.observe's `surface_id != want_surface` branch.
        observation = {"schema": "observation/v0.2", "frame_ref": fixture.frame()}
        for surface in ("fixture", "other-surface"):
            with self.subTest(surface=surface):
                observed = copy.deepcopy(observation)
                observed["frame_ref"]["surface_id"] = surface
                client = Mock()
                client.request.side_effect = lambda call, schema, **kw: {
                    "schema": schema, "request_id": call["request_id"], "op": "observe",
                    "status": "ok", "observation": observed}
                perceive = Mock(return_value="perceived")

                def pipeline():
                    result = tools.observe("fixture", client=client, timeout_ms=100)
                    return perceive(result["frame_ref"])

                if surface == "fixture":
                    self.assertEqual(pipeline(), "perceived")
                    perceive.assert_called_once_with(observation["frame_ref"])
                else:
                    with self.assertRaisesRegex(tools.ToolValidationError, "uncorrelated surface_id"):
                        pipeline()
                    perceive.assert_not_called()
                client.request.assert_called_once()

    def test_description_digest_binding_accepts_match_refuses_tampering(self):
        # Mutation: remove frame_sha256 from describe's binding tuple comparison.
        transport = Mock(return_value=(0, json.dumps(fixture.description())))
        result = vision.describe_observation(fixture.frame(), transport=transport)
        self.assertEqual(result["frame_ref"], fixture.frame())
        self.assertEqual(result["vision"]["changed_regions"], [{"x": 0, "y": 0, "w": 2, "h": 2}])
        with self.assertRaisesRegex(vision.VisionBridgeError, "frame binding mismatch"):
            vision.describe_observation(dict(fixture.frame(), sha256="f" * 64),
                                        transport=transport)
        self.assertEqual(transport.call_count, 2)


if __name__ == "__main__":
    unittest.main()
