"""G-AI ownership wrapper reusing G-W1 wire, binaries and cleanup proof.

[TARGET, unit decision] No Electron is needed for admission; the G-W1 canvas
probe is invoked explicitly by the gate against each retained live frame.
"""
import contextlib
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import uuid
from urllib.parse import quote

from metaviewer_agents import tools
from metaviewer_agents.verify import build_proposal

import live
import stack


class Session:
    def __init__(self):
        self.report = {'commands': [], 'assertions': {}}
        self.processes = []
        self.peers = []
        self.state = None
        self.temp = None

    def __enter__(self):
        try:
            return self.start()
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def start(self):
        if os.environ.get('MV_E2E_LIVE') != '1' or os.environ.get('MV_SRF_LIVE_PROFILE') != 'mv-live-1':
            raise RuntimeError('unavailable: explicit live environment required')
        deadline = time.monotonic() + 1800
        while True:
            before = set(stack.checked(['docker', 'ps', '--format', '{{.Names}}']).splitlines())
            if not live.profile_containers('mv-live-1') and not any('mv-live-1' in n for n in before):
                break
            if time.monotonic() >= deadline:
                raise RuntimeError('unavailable: profile remains allocated')
            time.sleep(60)
        self.temp = tempfile.TemporaryDirectory(prefix='mv-g-ai-')
        self.root = Path(self.temp.name)
        work = self.root / 'run-g-ai'
        work.mkdir(mode=0o700)
        self.work = work
        ram = Path(os.environ['MV_SRF_LIVE_RAM_ROOT']).resolve(strict=True)
        self.state = dict(schema='metaviewer.live-stack/v1', work=str(work), before=sorted(before),
                          ram_before=[p.name for p in ram.iterdir()], published=[], pids=[], capsules=[])
        binaries = stack.binaries(work)
        commit = stack.checked(['git', 'rev-parse', 'HEAD'], cwd=live.ROOT)
        suffix = uuid.uuid4().hex
        self.regs = {c: live.registration(c, commit, suffix) for c in ('core', 'ui', 'agent', 'daemon')}
        self.config = dict(session_id='g-ai-' + suffix, core=self.regs['core'],
                           peers=[self.regs[c] for c in ('ui', 'agent', 'daemon')])
        config_file = work / 'config.json'
        config_file.write_text(json.dumps(self.config))
        runtime = work / 'runtime'
        runtime.mkdir(mode=0o700)
        env = dict(os.environ, MV_CORE_CONFIG=str(config_file), XDG_RUNTIME_DIR=str(runtime),
                   XDG_STATE_HOME=str(work / 'state'), MV_SESSION_ID=self.config['session_id'],
                   MV_CORE_INSTANCE=self.regs['core']['endpoint']['instance'],
                   MV_DAEMON_INSTANCE=self.regs['daemon']['endpoint']['instance'],
                   MV_COMPONENT_COMMIT=commit, MV_SRF_PROFILES='',
                   MV_CONTRACT_DIR=str(live.ROOT / 'contracts/v0.2'))
        sock = runtime / 'metaviewer/core.sock'
        for role in ('core', 'adapter'):
            with open(work / (role + '.log'), 'w') as log:
                proc = subprocess.Popen([str(binaries[role])], cwd=live.ROOT, env=env,
                                        stdout=log, stderr=log, start_new_session=True)
            self.processes.append(proc)
            self.state['pids'].append(dict(pid=proc.pid, identity=stack.identity(proc.pid)))
            if role == 'core':
                live.wait_for(sock.exists, self.processes, 'core socket')
        self.archive = work / 'state/metaviewer/sessions' / self.config['session_id']
        live.wait_for(lambda: (self.archive / 'events/1.json').exists(), self.processes, 'adapter handshake')
        for role in ('ui', 'agent'):
            peer = live.UIWire(sock) if role == 'ui' else live.CoreClient(
                str(sock), timeout_s=30, max_line_bytes=1 << 20, max_reply_bytes=1 << 20)
            self.peers.append(peer)
            if role == 'agent':
                peer.connect()
            live.send(peer, self.regs[role], self.config, self.regs[role]['hello'])
            if peer.recv()['body'] != self.regs['core']['hello']:
                raise RuntimeError('core handshake mismatch')
        self.ui, self.agent = self.peers
        live.send(self.ui, self.regs['ui'], self.config, dict(schema='surface_request/v0.2',
                  op='create', params=dict(kind='browser', geometry=dict(w=1280, h=900), profile_id='mv-live-1')))
        created = self.receive(self.ui, lambda b: b.get('event') == 'created')
        self.surface = created['data']['surface']
        self.surface_id = self.surface['surface_id']
        self.frame = self.receive(self.ui, lambda b: b.get('event') == 'frame_ready')['data']['frame_ref']
        self.state['published'].append(str(Path(self.frame['ramws_path']).parent))
        self.state['capsules'] = sorted(live.profile_containers('mv-live-1') - before)
        if len(self.state['capsules']) != 1:
            raise RuntimeError('capsule ownership witness missing')
        return self

    def receive(self, peer, predicate):
        return live.receive(peer, predicate, self.report)

    def request(self, body, expect, *, timeout_ms):
        live.send(self.agent, self.regs['agent'], self.config, body)
        result = self.receive(self.agent, lambda b: b.get('request_id') == body['request_id'])
        self.last_result = result
        return result

    def prepare_fixture(self):
        """[TARGET, unit decision] Real local page; setup uses core admission.

        The browser starts on an empty page. This deterministic document gives
        perception a real button whose click changes both pixels and AX state.
        It uses a data URL, with no server or network dependency.
        """
        html = ("<!doctype html><title>G-AI Ready</title><body style='background:white'>"
                "<button style='font-size:40px;margin:80px' "
                'onclick="this.textContent=\'Gate changed\';document.title=\'G-AI Changed\'">'
                "Advance gate</button></body>")
        actions = [dict(type='key', keys=['ctrl', 'l']),
                   dict(type='type', text='data:text/html,' + quote(html)),
                   dict(type='key', keys=['Return'])]
        self.report['fixture_setup'] = []
        for action in actions:
            observation = tools.observe(self.surface_id, client=self, timeout_ms=30000)
            frame = observation['frame_ref']
            expectation = dict(type='changed_region', bbox=dict(x=0, y=0, w=frame['width'], h=frame['height']))
            proposal = build_proposal(frame, proposal_id='g-ai-setup-' + uuid.uuid4().hex,
                                      action=action, expectation=expectation, max_ms=30000)
            verdict = tools.propose(proposal, client=self, timeout_ms=30000)
            receipt = self.receive(self.agent, lambda b: b.get('schema') == 'action_receipt/v0.2'
                                   and b.get('proposal_id') == proposal['proposal_id'])
            evidence = receipt.get('native_evidence', {})
            if evidence.get('focus_verified') is not True or type(evidence.get('input_mono_ns')) is not int:
                raise RuntimeError('fixture_unavailable: setup lacks native input evidence')
            self.report['fixture_setup'].append(dict(verdict=verdict, receipt=receipt))
        tree = self.native_tree()
        if not any(e.get('name') == 'Advance gate' for e in tree['elements']):
            raise RuntimeError('fixture_unavailable: rendered button not observed')

    def native_tree(self):
        return json.loads(stack.checked([Path(os.environ['MV_SRF_BIN_DIR']) / 'srf-identity-surface',
                         'ax', '--container', self.state['capsules'][0], '--window', 'w1',
                         '--state-dir', os.environ['MV_SRF_STATE_DIR']]))

    def dispatched(self, proposal):
        receipt = self.receive(self.agent, lambda b: b.get('schema') == 'action_receipt/v0.2'
                               and b.get('proposal_id') == proposal['proposal_id'])
        return receipt['native_evidence']

    def canvas(self, frame):
        live.electron_probe(self.report, self.work, frame, self.surface)

    def __exit__(self, *unused):
        try:
            for peer in self.peers:
                peer.close()
            if self.state is not None:
                for proc in self.processes:
                    if proc.poll() is None:
                        proc.send_signal(signal.SIGCONT)
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    stack.cleanup(self.state, self.root)
                self.cleanup = json.loads(output.getvalue().split('LIVE_STACK_CLEANUP ', 1)[1])
            for proc in self.processes:
                proc.wait(timeout=10)
        finally:
            if self.temp is not None and (self.state is None or hasattr(self, 'cleanup')):
                self.temp.cleanup()
