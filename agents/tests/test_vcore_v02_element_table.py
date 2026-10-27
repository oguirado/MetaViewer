"""S2 contract upgrades; each valid path has a refusing negative control."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from metaviewer_agents.observe import (
    ObservationError, build_observation, validate_observation,
)
from metaviewer_agents.perception.base import Frame, PerceptionError
from metaviewer_agents.perception.vcore import (
    VCorePerceptionAdapter, VQA_SCHEMAS, project_element_table,
)


def frame_ref():
    return dict(schema='frame_ref/v0.2', surface_id='demo', generation=1,
                tick=0, ts_ns=0, width=4, height=3, format='rgb24',
                ramws_path='/dev/shm/s2/frame.rgb',
                sha256=hashlib.sha256(bytes(36)).hexdigest(),
                capture_us=0)


def c2():
    return dict(schema='ve.cu_describe/v1',
                frame_sha256=hashlib.sha256(bytes(36)).hexdigest(),
                width=4, height=3, changed=None, changed_regions=[],
                crops=[], timing_us=0, marks_png='/dev/shm/vqa-cu/s2.png',
                marks=[dict(id=1, x=1, y=0, w=2, h=2, kind='button',
                            score=0.812345, ocr_text='Open')])


class V02ElementTableTests(unittest.TestCase):
    def assert_code(self, code, error, call, *args, **kwargs):
        with self.assertRaises(error) as caught:
            call(*args, **kwargs)
        self.assertEqual(code, caught.exception.code)

    def test_observation_versions_and_isolation(self):
        for version in ('v0.1', 'v0.2'):
            frame = frame_ref()
            frame['schema'] = 'frame_ref/' + version
            result = build_observation(frame, surface_id='demo', generation=1,
                                       contract_version=version)
            self.assertEqual('observation/' + version, result['schema'])
            frame['width'] = 99
            self.assertEqual(4, result['frame_ref']['width'])
            frame['schema'] = 'frame_ref/v0.3'
            self.assert_code('unknown_version', ObservationError,
                             build_observation, frame, surface_id='demo',
                             generation=1, contract_version=version)
        old = frame_ref()
        old['schema'] = 'frame_ref/v0.1'
        self.assert_code('unknown_version', ObservationError, build_observation,
                         old, surface_id='demo', generation=1,
                         contract_version='v0.2')
        self.assert_code('unknown_version', ObservationError, build_observation,
                         frame_ref(), surface_id='demo', generation=1,
                         contract_version='v0.3')

    def test_real_fake_subprocess_memfd_observation_and_projection(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory) / 'vadapt'
            package.mkdir()
            (package / '__init__.py').write_text('')
            script = (
                'import json, pathlib, sys\n'
                'p = sys.argv[sys.argv.index("--frame") + 1]\n'
                'assert p.startswith("/proc/self/fd/")\n'
                'assert pathlib.Path(p).read_bytes().startswith(b"\\x89PNG\\r\\n\\x1a\\n")\n'
                'print(' + repr(json.dumps(c2())) + ')\n'
            )
            runner = package / 'cu_describe.py'
            runner.write_text(script)
            adapter = VCorePerceptionAdapter(directory, python=sys.executable)
            vision = adapter.perceive(frame_ref(), Frame(4, 3, bytes(36)))
            observation = build_observation(
                frame_ref(), surface_id='demo', generation=1,
                vision=vision, contract_version='v0.2')
            validate_observation(observation, surface_id='demo', generation=1,
                                 contract_version='v0.2')
            table = project_element_table(frame_ref(), vision)
            self.assertIn(table['schema'], VQA_SCHEMAS)
            self.assertEqual({'schema', 'frame_sha256', 'width', 'height', 'elements'}, set(table))
            self.assertEqual([dict(bbox=dict(x=1, y=0, w=2, h=2), role='button',
                                   name='Open', score_ppm=812345)], table['elements'])
            self.assertEqual(table, project_element_table(frame_ref(), c2()))
            table['elements'][0]['bbox']['x'] = 0
            self.assertEqual(1, vision['elements'][0]['bbox']['x'])
            bad = c2()
            bad['schema'] = 've.cu_describe/v999'
            runner.write_text(script.replace(repr(json.dumps(c2())), repr(json.dumps(bad))))
            self.assert_code('unknown_version', PerceptionError, adapter.perceive,
                             frame_ref(), Frame(4, 3, bytes(36)))

    def test_projection_refuses_malformed_and_foreign_evidence(self):
        self.assertEqual(812345, project_element_table(frame_ref(), c2())['elements'][0]['score_ppm'])
        for key, value, code in (
            ('width', 5, 'bad_shape'), ('schema', 'foreign/v1', 'unknown_version'),
            ('frame_sha256', 'cd' * 32, 'identity_mismatch'),
        ):
            bad = c2()
            bad[key] = value
            self.assert_code(code, PerceptionError, project_element_table, frame_ref(), bad)
        for key, value in (('x', True), ('w', 5), ('score', float('nan')),
                           ('score', True), ('score', 1.01)):
            bad = c2()
            bad['marks'][0][key] = value
            self.assert_code('bad_shape', PerceptionError, project_element_table, frame_ref(), bad)
        vision = dict(summary='', changed_regions=[], elements=[
            dict(bbox=dict(x=0, y=0, w=1, h=1), role='button', name='', confidence=0)])
        for score, ppm in ((0, 0), (1, 1000000), (0.0000015, 2)):
            vision['elements'][0]['confidence'] = score
            self.assertEqual(ppm, project_element_table(frame_ref(), vision)['elements'][0]['score_ppm'])
            bad = copy.deepcopy(vision)
            bad['elements'][0]['confidence'] = -1
            self.assert_code('bad_shape', PerceptionError, project_element_table, frame_ref(), bad)
        self.assert_code('bad_shape', PerceptionError, project_element_table, frame_ref(), None)

    def test_optional_lock_verification_is_lazy_and_path_bound(self):
        module = types.ModuleType('metaviewer_agents.perception.deps_lock')
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as other:
            module.resolve_locked_component = Mock(return_value=Path(root))
            with patch.dict(sys.modules, {module.__name__: module}):
                VCorePerceptionAdapter(root)
                module.resolve_locked_component.assert_not_called()
                adapter = VCorePerceptionAdapter(root, verify_lock=True)
                self.assertEqual(Path(root).resolve(), adapter.ve_root)
                module.resolve_locked_component.assert_called_once_with('vision-engine')
                self.assert_code('commit_mismatch', PerceptionError,
                                 VCorePerceptionAdapter, other, verify_lock=True)
                module.resolve_locked_component.side_effect = PerceptionError('dirty_tree', 'dirty')
                self.assert_code('dirty_tree', PerceptionError,
                                 VCorePerceptionAdapter, root, verify_lock=True)
            self.assert_code('bad_shape', PerceptionError,
                             VCorePerceptionAdapter, root, verify_lock=1)

    def test_crop_fallback_and_empty_table(self):
        raw = c2()
        del raw['marks']
        del raw['marks_png']
        table = project_element_table(frame_ref(), raw)
        self.assertEqual([], table['elements'])
        raw['crops'] = [dict(x=0, y=1, w=2, h=2, reason='salient')]
        table = project_element_table(frame_ref(), raw)
        self.assertEqual([dict(bbox=dict(x=0, y=1, w=2, h=2), role='crop',
                               name='salient', score_ppm=500000)], table['elements'])
        raw['crops'][0]['reason'] = 'foreign'
        self.assert_code('bad_shape', PerceptionError,
                         project_element_table, frame_ref(), raw)
        vision = dict(summary='', changed_regions=[], elements=[], extra=True)
        self.assert_code('bad_shape', PerceptionError,
                         project_element_table, frame_ref(), vision)


if __name__ == '__main__':
    unittest.main()
