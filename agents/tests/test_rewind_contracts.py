import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from metaviewer_agents import envelope
from metaviewer_agents._contracts_v02 import FILES
ROOT=Path(__file__).resolve().parents[2]

def assignment(text):
 for node in ast.parse(text).body:
  if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='FILES' for t in node.targets):return ast.literal_eval(node.value)
 raise AssertionError('FILES assignment missing')

class RewindContractTests(unittest.TestCase):
 def test_integrated_projected_entries_preserve_c271_except_pinned_fec_envelope(self):
  old=assignment(subprocess.check_output(['git','show','c271c5592e3266724d4d80268c3f9c28e33cc1f0:agents/metaviewer_agents/_contracts_v02.py'],cwd=ROOT,text=True))
  raw=subprocess.check_output(['git','show','fec7987ced760bf26638c66c2b2ae49f545e5762:contracts/v0.2/envelope.schema.json'],cwd=ROOT)
  self.assertEqual(hashlib.sha256(raw).hexdigest(),'9e4cc8049bb39d906d3e2df21bba20618959ac35c11dae68f59cf450ef0338f3')
  spec=importlib.util.spec_from_file_location('projection_oracle',ROOT/'tools/generate_guest_command_sdk.py')
  module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  old['envelope.schema.json']=module.project(json.loads(raw))
  for name,value in old.items():self.assertEqual(FILES[name],value,name)

 def test_only_new_request_event_are_envelope_bodies(self):
  self.assertEqual(envelope._REWIND_BODY_FILES,{'rewind_request.schema.json','rewind_event.schema.json'})
  self.assertNotIn('rewind_session/v0.2',envelope._BODIES)
  self.assertNotIn('rewind_point/v0.2',envelope._BODIES)
  self.assertEqual(len(envelope._CAPSULE_BODY_FILES),4)
 def test_all_canonical_rewind_examples(self):
  for path in sorted((ROOT/'contracts/examples/v0.2').glob('rewind_*.json')):
   name=path.name.split('.')[0]+'.schema.json';value=json.loads(path.read_text());good='.valid' in path.name
   if name=='rewind_envelope.schema.json':
    if good:envelope.validate_envelope(value)
    else:
     with self.assertRaises(envelope.EnvelopeError,msg=path.name):envelope.validate_envelope(value)
   else:
    schema=envelope._V02_FILES[name]
    if good:envelope._check(value,schema,0)
    else:
     with self.assertRaises(envelope._Mismatch,msg=path.name):envelope._check(value,schema,0)
 def test_existing_generator_is_exact(self):
  spec=importlib.util.spec_from_file_location('sdk_generator',ROOT/'tools/generate_guest_command_sdk.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  self.assertEqual((ROOT/'agents/metaviewer_agents/_contracts_v02.py').read_text(),module.generated())
