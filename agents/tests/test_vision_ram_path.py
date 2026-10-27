"""ARG-s_adapter-1: reject path aliases at the perception boundary."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from metaviewer_agents.vision import VisionBridgeError, parse_description


def description(path, field='marks_png'):
    row = dict(schema='ve.cu_describe/v1', frame_sha256='a' * 64,
               width=4, height=4, changed=False, changed_regions=[],
               crops=[], timing_us=0)
    if field == 'marks_png':
        row.update(marks=[], marks_png=path)
    else:
        row.update(crop_dir=path, crop_pngs=[])
        if field == 'crop_pngs':
            row['crop_dir'] = '/dev/shm/vqa-cu/crops'
            row['crops'] = [dict(x=0, y=0, w=1, h=1, reason='salient')]
            row['crop_pngs'] = [path]
    return json.dumps(row)


class VisionRAMPathTests(unittest.TestCase):
    def test_dotdot_marks_png_rejected(self):
        with self.assertRaises(VisionBridgeError):
            parse_description(description('/dev/shm/vqa-cu/../vqa-cu/marks.png'))

    def test_external_symlink_marks_png_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            link = Path(directory) / 'marks.png'
            link.symlink_to('/dev/shm/vqa-cu/marks.png')
            with self.assertRaises(VisionBridgeError):
                parse_description(description(str(link)))

    def test_nested_ram_path_accepted(self):
        path = '/dev/shm/vqa-cu/a/marks.png'
        self.assertEqual(parse_description(description(path))['marks_png'], path)

    def test_nonnormalized_paths_rejected_for_all_path_fields(self):
        for field in ('marks_png', 'crop_dir', 'crop_pngs'):
            for path in ('/dev/shm/vqa-cu/a/../marks.png',
                         '/dev/shm/vqa-cu/./marks.png',
                         '/dev/shm/vqa-cu//marks.png',
                         '/dev/shm/vqa-cu/marks.png/'):
                with self.subTest(field=field, path=path):
                    with self.assertRaises(VisionBridgeError):
                        parse_description(description(path, field))

    def test_internal_symlink_component_rejected(self):
        root = Path('/dev/shm/vqa-cu')
        if not root.exists():
            root.mkdir()
            self.addCleanup(root.rmdir)
        with tempfile.TemporaryDirectory(dir=root) as directory:
            nested = Path(directory)
            target = nested / 'actual'
            target.mkdir()
            (nested / 'alias').symlink_to(target, target_is_directory=True)
            with self.assertRaises(VisionBridgeError):
                parse_description(description(str(nested / 'alias' / 'marks.png')))


if __name__ == '__main__':
    unittest.main()
