import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from metaviewer_agents import envelope
from metaviewer_agents._contracts_v02 import FILES
ROOT=Path(__file__).resolve().parents[2]

# Fixed historical projection hashes; tests require no Git history.
PROJECTED_BASELINE_SHA256 = {'action_proposal.schema.json': 'a97a031d63352d4e4f50f84f1a3075461b0dc83de040acc99862b10c0b9441ef', 'action_receipt.schema.json': 'ddf715bdcc1d7f3f6ff6dabee4b3dbd49e5a5b22ae5b5f4b557fb5fcceb04886', 'action_verdict.schema.json': 'bf7e2ee3a9962b84e68e825a5e15c34b5b2a91677623ff990cbbd3f767e4b91e', 'capsule_capabilities.schema.json': '1b830fc62ccf548b08cacc803c0914f282881c8ba3cc0fdac1fcb0d73dd16d85', 'capsule_envelope.schema.json': '3d3ea5875aab1adb65506955e7aaf9cb76e61b8166e0f3ff88a955f9d3d5c1c3', 'capsule_meta.schema.json': '2da0fbcae64083099ea93e7993fd51e2051a175bdafa4ce8ac62bce199924bd5', 'capsule_resource_inventory.schema.json': '5f7c869c548ed2d6996767914fc41c8230ce0281c66f146f2030218e243640b8', 'catalog_entry.schema.json': '8c5fe91139e23b53d43e0ce635a7465d14a0a1b36cf9ce5e846cb2d7fb6a7748', 'envelope.schema.json': '628c08b268b293a07c6504ec45f2e7f2eea2802ba5ae6d781a48aa1b457e7198', 'frame_ref.schema.json': '887b77f32eaf3334b4587b67c69555b2ddbf776a08a5f9e1abd918676379228c', 'guest_command_event.schema.json': 'cc74299c1eac9db8660b8daecbd4b77fea51c3b403ce7b70ae77536cd74d6023', 'guest_command_request.schema.json': '8e79116df512c7acfd4ecc9bfc9dd7144ac56b11e3b04bcbf94e1f97d90f68fd', 'guest_command_session.schema.json': 'aec49d80947bc7ad361a946dc18d6d297f60730753f3c381280e7e2416f20031', 'guest_transport_metadata.schema.json': 'b423245911bdac1c64c0ee2233bdded727ebcd39b7463fb763c547ae10cf4ea7', 'headless_event.schema.json': 'f745cd19769b9d20f107f969793269e329aee18d334a8d4fd93faeb57619930e', 'headless_request.schema.json': '94268843411d1deb7187a5faf473c3028e71165ae1941744376e6b9c3ad51bfd', 'headless_session.schema.json': '6b2a352212ff480c185ab8c0e1a6c859118b606ecb5330e876ee9f3b68079e79', 'hello.schema.json': 'b63adf0822923f211822a6674151441f0b24c1385a73751ccad4ada1326c4d65', 'mv_tool_call.schema.json': '95d71c1ca2f365d92349dc0fa75e49d90e1efbc11fa12ddcd9fdfc522020ee89', 'mv_tool_result.schema.json': 'c035cbe1a278ac7c8e75983cf4cb5d7d394bd3e9b27e8bb3371f025d159ff4be', 'observation.schema.json': 'cc0c355d62e119e6f518db80e1aa41839096aac7e6f28f759c3ffae591eb0df8', 'record_event.schema.json': '3a94502fad51719f3f3986cdd3dd3f90acf95b29bad6901d802b961587dfd5bf', 'record_request.schema.json': 'cc2d300c73a574119cdbc28e986355dbb82f926df8f52dbfbaff42b7af3295dc', 'session_record.schema.json': 'c809157082b75a72072cd66b5e64c3dbb0efeb29f129f5d7f5f98c1c8edb0c05', 'settings.schema.json': '5b9574b9027b8e5c908c46ce45808d7ec2a134ce0d07f30e0957836da63baa62', 'surface.schema.json': 'd0bcf16a03dcdbfb69f0cee04e9cdb2dbbd4ca4d0a9ad7e5666e54768c37a393', 'surface_event.schema.json': '6423d2f527a26272d372c84cffa68e507d2e24a51f1d55dfec43d0d455b8571c', 'surface_input.schema.json': '039564c1a466124c2b835f1168f6fdb235de44e0bcad54d45155a4c3eb1da9d3', 'surface_request.schema.json': '0c8a1bbd911ec4bd1ab7a71007476ffee01a8c49187f35bf1329db707e1a4c57', 'terminal_session.schema.json': '726f20061dd33484a1de857c9f60e5702531f773a221c041c19e82b51904f88e', 'ui_intent.schema.json': '83999a7f22b111d2e7e12a5b741c7f31fcfe6feda98827d73f0e8f5dbb0b14b1'}

# Published frontend-base schemas remain byte-exact.
PUBLISHED_SCHEMA_SHA256 = {'action_proposal.schema.json': '65ac7b8303183cf2dc07c75732818b67e14da989fd616f1028dde75d3bb2375d', 'action_receipt.schema.json': '2148a9e67669a01829965d8e7698338b425207d6f1e2e771daadd87de89ad36b', 'action_verdict.schema.json': '7c0d1653a58628d969582b204581162edc9a8fa961cfc52aa8c9032f9346b56d', 'capsule_meta.schema.json': '494d99f3882b4e8a3a1c02e2a72785cb3fe13859985aef692068f7bbc9179b0b', 'capsule_state_event.schema.json': '8172a6a2600085e6b08dfaaba91320808aae3c000be160420fcbe9bcd3634070', 'capsule_state_request.schema.json': '27bf48d0778bd9763595efffb8fde177edee13e667c9268f3e49fa4fcec19253', 'catalog_entry.schema.json': '0e3a515c2fcb6a5e2153ab892f394f73b6a4ccc3f76cc5c9916c78a9324bc833', 'envelope.schema.json': '9e4cc8049bb39d906d3e2df21bba20618959ac35c11dae68f59cf450ef0338f3', 'frame_ref.schema.json': '8050ce412b6b95792468701ea69670222798840b54787fee18f1f99dd3738397', 'hello.schema.json': 'e3099628720ebf4260528ff809f74d08a2da8a762339d2fdbaaca097f2a0d13c', 'mv_tool_call.schema.json': '7da7513b1b457dfeb08689c0ae70b2b950a2e093dab8706d99267acbd868cd5f', 'mv_tool_result.schema.json': 'f70eca64419f98375bb01259c4bb0cdd9cc64de1bb9158561ba5c32480fa3faa', 'observation.schema.json': '65ccb926746357fa88d0dad628199b3a27a51b5722201c1eb22e34059d761ead', 'record_event.schema.json': '4a18f9c8d32b43ad43a6f194717d977f786531fc7e9049ab0369951d37619fe8', 'record_request.schema.json': '4c781ef8e0807aa36d3b1abf87eff7f0ca943676626342bdc7f40ba8b6eb2a22', 'session_record.schema.json': '0b409b0e8958fbddb44d029ef8b79f634103e92d9092db76ecc207027bf5af5a', 'settings.schema.json': 'd162909a4f1a34b29f8e00651a89af7ddc75991c74c0aa527373253a729c154e', 'surface.schema.json': '90da5357ae82f065e32efa6b06cc4f6415e709a5257777f226b5c397acb8c2da', 'surface_event.schema.json': '6c4eb7497065bf6fd8fd965448c2cdcd0a5960f78012f5ec7c1453a3b0fba947', 'surface_input.schema.json': '023d7503602109c8b58dc86795cdd6279f1acf2db407ac3d6299a734765d139e', 'surface_request.schema.json': '4ab05a8018d3cc69747fa1b5d478186127fd8d0c3cd555ae7984344493e56a89', 'terminal_session.schema.json': '6896578203d3cbc14ccc474e4d9aec86d4c327e158bdc1fcc6e6689473d34cb5', 'ui_intent.schema.json': 'e30a180368df1ca38a2af58d26a7548053898a8cd6c595bd5cd7d7f4c57e3317'}

def projected_digest(value):
 return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()).hexdigest()

def assert_projected_baseline(case, files):
 for name, expected in PROJECTED_BASELINE_SHA256.items():case.assertEqual(projected_digest(files[name]), expected, name)

class RewindContractTests(unittest.TestCase):
 def test_integrated_projected_entries_preserve_c271_except_pinned_fec_envelope(self):
  assert_projected_baseline(self,FILES)
  for name,expected in PUBLISHED_SCHEMA_SHA256.items():
   self.assertEqual(hashlib.sha256((ROOT/'contracts/v0.2'/name).read_bytes()).hexdigest(),expected,name)

 def test_pinned_projection_rejects_a_semantic_mutation(self):
  changed=dict(FILES)
  name=next(iter(PROJECTED_BASELINE_SHA256))
  changed[name]={'tampered':True}
  with self.assertRaises(AssertionError):assert_projected_baseline(self,changed)

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
