"""[TARGET, unit decision] mw_run attach and settlement over an actual socket.

The remote core is the only protocol double. Existing native-custody/planner
tests own those boundaries; this test joins attach, client, tools and the final
browser/program backend receipt gate, including an early asynchronous receipt.
"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'agents'), str(ROOT / 'tools')]
import mw_run_backend as host
from mw_run_program import ProgramBackend
from metaviewer_agents import tools
from metaviewer_agents.verify import build_proposal


def registration(component):
    return dict(endpoint=dict(component=component, instance=component+'-seams'),
                hello=dict(schema='hello/v0.2', contract_version='v0.2', component=component,
                           component_version='0.1.1', component_commit='a'*40, dependencies=[]))


class MemoryWebWireSeams(unittest.TestCase):
    def journey(self, kind, *, stale=False):
        with tempfile.TemporaryDirectory(prefix='mv-wire-') as temporary, \
                tempfile.TemporaryDirectory(prefix='frames-seams-', dir='/dev/shm') as ram:
            root, allocation = Path(temporary), Path(ram)
            endpoint = root / 'metaviewer'
            endpoint.mkdir(mode=0o700)
            config = dict(session_id='seams-session', core=registration('core'), peers=[registration('agent')])
            config_path = root / 'config.json'
            config_path.write_text(json.dumps(config))
            frames = []
            for generation, value in ((1, b'a'), (2, b'b')):
                data = value * 12
                path = allocation / (str(generation)*32+'.rgb')
                path.write_bytes(data); path.chmod(0o600)
                frames.append(dict(schema='frame_ref/v0.2', surface_id='surface-seams', generation=generation,
                    tick=generation, ts_ns=generation, width=2, height=2, format='rgb24',
                    ramws_path=str(path), sha256=hashlib.sha256(data).hexdigest(), capture_us=1))
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(endpoint / 'core.sock')); (endpoint / 'core.sock').chmod(0o600)
            server.listen(1); server.settimeout(5)
            order, proposals = [], []

            def peer():
                connection, _ = server.accept()
                with connection, connection.makefile('rb') as reader:
                    connection.settimeout(5)
                    sequence = 0
                    def send(body):
                        nonlocal sequence
                        sequence += 1
                        envelope = dict(schema='envelope/v0.2', msg_id='reply-'+str(sequence), ts_ns=sequence,
                            session_id=config['session_id'], seq=sequence, nonce='nonce-'+str(sequence),
                            body=body, **{'from':config['core']['endpoint'],'to':config['peers'][0]['endpoint']})
                        raw = (json.dumps(envelope)+'\n').encode()
                        # Exercise real NDJSON assembly without sleep-based ordering.
                        connection.sendall(raw[:17]); connection.sendall(raw[17:])
                    waits = 0
                    for line in reader:
                        body = json.loads(line)['body']
                        if body['schema'] == 'hello/v0.2':
                            order.append('hello'); send(config['core']['hello']); continue
                        op = body['op']; order.append(op)
                        head = dict(schema='mv_tool_result/v0.2', request_id=body['request_id'], op=op)
                        if op == 'observe':
                            self.assertEqual(body['args'], dict(surface_id='surface-seams'))
                            send(dict(head, status='ok', observation=dict(schema='observation/v0.2',frame_ref=frames[0])))
                        elif op == 'propose':
                            proposal = body['args']['proposal']; proposals.append(proposal)
                            self.assertEqual(proposal['based_on_frame'],
                                dict(sha256=frames[0]['sha256'], generation=1), 'SEAM_PROPOSAL_BASELINE')
                            receipt = dict(schema='action_receipt/v0.2', proposal_id=proposal['proposal_id'],
                                executed_at_ns=3, after_frame=frames[0] if stale else frames[1], verified=True,
                                verification=dict(method='pixel',detail='changed'), error='')
                            # Production core may forward this before the admitted tool result.
                            send(receipt)
                            send(dict(head,status='admitted',verdict=dict(schema='action_verdict/v0.2',
                                proposal_id=proposal['proposal_id'],decision='admitted',core_seq=7)))
                        elif op == 'wait_verify':
                            waits += 1
                            self.assertEqual(len(proposals), 1, 'SEAM_NO_INPUT_REPLAY')
                            if waits == 1:
                                send(dict(head,status='pending',proposal_id=proposals[0]['proposal_id'],retry_after_ms=1))
                            else:
                                send(dict(head,status='verified',receipt=receipt,focus_verified=True,
                                    input_mono_ns=3,frame_sha256=receipt['after_frame']['sha256']))
                        else:
                            self.fail('SEAM_UNEXPECTED_OPERATION '+op)

            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(peer)
                client = host.connect(dict(MV_CORE_CONFIG=str(config_path), XDG_RUNTIME_DIR=str(root)))
                try:
                    with client:
                        observed = tools.observe('surface-seams',client=client,timeout_ms=1000)
                        proposal = build_proposal(observed['frame_ref'],proposal_id='proposal-seams',
                            action=dict(type='click',x=1,y=1,button='left'),
                            expectation=dict(type='changed_region',bbox=dict(x=0,y=0,w=2,h=2)),max_ms=1000)
                        verdict = tools.propose(proposal,client=client,timeout_ms=1000)
                        self.assertEqual(verdict['decision'], 'admitted')
                        self.assertEqual(order, ['hello','observe','propose'], 'SEAM_ADMISSION_IS_NOT_COMPLETION')
                        verified = tools.wait_verify(proposal['proposal_id'],proposal['expectation'],1000,
                            client=client,surface_id='surface-seams')
                        backend = object.__new__(ProgramBackend if kind == 'program' else host.HostBackend)
                        backend.surface_id, backend.evidence = 'surface-seams', root
                        backend.program_binding = dict(surface_id='surface-seams',host_xpra=True)
                        backend.pending = {proposal['proposal_id']:(proposal,frames[0],verified)}
                        backend.native_witness(verified)
                        result = backend.wait_verify(dict(proposal_id=proposal['proposal_id']),1000)
                        self.assertFalse(stale, 'SEAM_STALE_RECEIPT_ACCEPTED')
                        self.assertEqual(result['status'],'verified')
                        self.assertEqual(Path(root / (frames[1]['sha256']+'.rgb')).read_bytes(), b'b'*12)
                        self.assertEqual(backend.pending,{})
                        self.assertEqual(order,['hello','observe','propose','wait_verify','wait_verify'])
                finally:
                    client.close(); server.close()
                    future.result(timeout=5)

    def test_browser_and_program_attach_admit_pending_then_verify(self):
        for kind in ('browser','program'):
            with self.subTest(kind=kind):
                self.journey(kind)

    def test_admitted_but_same_generation_never_becomes_verified(self):
        for kind in ('browser','program'):
            with self.subTest(kind=kind), self.assertRaisesRegex(host.OwnerRefused,'MW_RECEIPT_MISMATCH'):
                self.journey(kind,stale=True)

    def test_receipt_freshness_source_mutant_is_killed(self):
        # Compile only the deciding method from a changed source string. This
        # retains the real tools/classes and never edits a production file.
        import ast
        source = (ROOT / 'tools/mw_run_backend.py').read_text()
        tree = ast.parse(source)
        method = next(node for node in ast.walk(tree) if isinstance(node,ast.FunctionDef) and node.name=='binding')
        import textwrap
        method_source = textwrap.dedent('\n'.join(source.splitlines()[method.lineno-1:method.end_lineno]))
        before = "receipt['after_frame']['generation'] > before['generation']"
        self.assertEqual(method_source.count(before),1)
        namespace = dict(vars(host))
        exec(method_source.replace(before,"receipt['after_frame']['generation'] >= before['generation']"),namespace)
        with patch.object(host.HostBackend,'binding',staticmethod(namespace['binding'])):
            for kind in ('browser','program'):
                with self.subTest(kind=kind), self.assertRaisesRegex(AssertionError,'SEAM_STALE_RECEIPT_ACCEPTED'):
                    self.journey(kind,stale=True)


if __name__ == '__main__':
    unittest.main()
