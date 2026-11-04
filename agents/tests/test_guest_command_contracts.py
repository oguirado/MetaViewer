import importlib.util
import json
from pathlib import Path
import unittest
from metaviewer_agents._contracts_v02 import FILES
from metaviewer_agents.envelope import _BODIES, _resolve_reference

ROOT=Path(__file__).resolve().parents[2]
SPEC=importlib.util.spec_from_file_location('guest_sdk_generator',ROOT/'tools/generate_guest_command_sdk.py')
GEN=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(GEN)

class GuestCommandContractTests(unittest.TestCase):
    def test_all_four_canonical_projections_and_local_refs(self):
        for name in GEN.NAMES:
            filename=name+'.schema.json'
            canonical=json.loads((ROOT/'contracts/v0.2'/filename).read_text())
            self.assertEqual(FILES[filename],GEN.project(canonical))
            self.assertIsNotNone(_resolve_reference('v0.2/'+filename))
        self.assertIn('guest_command_request/v0.2',_BODIES)
        self.assertIn('guest_command_event/v0.2',_BODIES)
        self.assertNotIn('guest_command_session/v0.2',_BODIES)
        self.assertNotIn('guest_transport_metadata/v0.2',_BODIES)

    def test_generator_matches_entire_canonical_map(self):
        source=(ROOT/'agents/metaviewer_agents/_contracts_v02.py').read_text()
        self.assertEqual(source,GEN.generated())
        expected={p.name:GEN.project(json.loads(p.read_text()))
                  for p in (ROOT/'contracts/v0.2').glob('*.schema.json')}
        self.assertEqual(FILES,expected)
        self.assertNotIn('FILES.update',source)
