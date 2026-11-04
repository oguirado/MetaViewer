"""Additive core-to-UI observation shape; no guest action authority."""
import copy,json,unittest
from pathlib import Path
from metaviewer_agents import envelope as e
ROOT=Path(__file__).resolve().parents[2]
class ObservationContracts(unittest.TestCase):
 def fixture(self):return json.loads((ROOT/'contracts/examples/v0.2/guest_command_observation_envelope.valid.json').read_text())
 def test_roundtrip(self):
  value=self.fixture();self.assertEqual(e.loads_envelope(e.dumps_envelope(value,max_bytes=1048576),max_bytes=1048576),value)
 def test_route_and_cross_family_refusals(self):
  for field,value in [('from',{'component':'agent','instance':'agent-one'}),('to',{'component':'daemon','instance':'daemon-one'}),('schema','capsule_envelope/v0.2'),('schema','envelope/v0.2')]:
   bad=self.fixture();bad[field]=value
   with self.subTest(field=field,value=value),self.assertRaises(e.EnvelopeError):e.validate_envelope(bad)
 def test_no_authority_or_stdin_fields(self):
  for name in ('stdin_b64','env','authority_epoch','native_path'):
   bad=self.fixture();bad['body'][name]='forbidden'
   with self.subTest(name=name),self.assertRaises(e.EnvelopeError):e.validate_envelope(bad)
 def test_required_join_and_scalar_guards(self):
  for key in ('accepted_event_id','request_id','job_id','owner_id','reservation_id','generation'):
   bad=self.fixture();del bad['body'][key]
   with self.subTest(key=key),self.assertRaises(e.EnvelopeError):e.validate_envelope(bad)
  for value in (True,0,9007199254740992):
   bad=self.fixture();bad['body']['generation']=value
   with self.subTest(value=value),self.assertRaises(e.EnvelopeError):e.validate_envelope(bad)
 def test_constructor_selects_new_family(self):
  value=self.fixture();got=e.make_envelope(msg_id='one',from_component='core',from_instance='core-one',to_component='ui',to_instance='ui-one',session_id='one',seq=1,body=value['body'],nonce='one',ts_ns=1)
  self.assertEqual(got['schema'],'guest_command_observation_envelope/v0.2')
