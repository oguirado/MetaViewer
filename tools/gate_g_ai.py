#!/usr/bin/env python3
"""Local-only G-AI assertion runner. Stdout is one canonical JSON receipt.

[TARGET, unit decision] The pinned Wender has no planner CLI. A pipe-only
Python shim calls its public AX pruning/state builder on native surface rows;
local planning chooses a custody-checked visible actionable node. State change
is independently checked on post-action Wender state; a pixel receipt alone
cannot prove it. Every failed assertion terminates the run with cleanup.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'agents'))
sys.path.insert(0, str(ROOT / 'tests/e2e/e2e1_slice'))
from metaviewer_agents import tools, vision  # noqa: E402
from metaviewer_agents.executor import AdmittedExecutor, SurfaceError  # noqa: E402
from metaviewer_agents.observe import ObservationError, compute_battery_state_sha256  # noqa: E402
from metaviewer_agents.perception import vcore  # noqa: E402
from metaviewer_agents.perception.base import PerceptionError  # noqa: E402
from metaviewer_agents.perception.deps_lock import DependencyLockError, resolve_locked_component  # noqa: E402
from metaviewer_agents.verify import build_proposal  # noqa: E402
from metaviewer_agents.wender_bridge import WenderSubprocessAdapter, validate_state  # noqa: E402


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


class GateFailure(RuntimeError):
    def __init__(self, code, detail):
        self.code = code
        super().__init__(detail)


def require(condition, detail):
    if not condition:
        raise GateFailure('assertion_failed', detail)


def rejected(call, exceptions, code=None):
    try:
        call()
    except exceptions as error:
        if code is not None:
            require(getattr(error, 'code', None) == code, 'wrong negative-control error: ' + str(error))
        return True
    raise GateFailure('negative_control_accepted', 'mutated evidence passed its gate')


def checked_frame(frame):
    tools._check_frame(frame)
    path = Path(frame['ramws_path'])
    require(path.resolve().is_relative_to('/dev/shm'), 'frame left shared memory')
    pixels = vcore._ramws_frame(frame, frame['width'], frame['height'])
    if hashlib.sha256(pixels.data).hexdigest() != frame['sha256']:
        raise PerceptionError('bad_shape', 'frame digest mismatch')
    return pixels


# Glue only: all pruning, IDs, AX digests and state serialization are computed
# by the pinned private checkout in a CHILD; no implementation is vendored.
WENDER_SHIM = r'''
import json, sys
from wender.perceive import ax
from wender.perceive.vision_adapter import fuse_regions
from wender.state import schema
request = json.load(sys.stdin)
table, tree = request['element_table'], request['tree']
assert table['schema'] == 'vqa.element-table/v1'
rows = tree['elements']
raw = [dict(nodeId=str(i), role=dict(value=e['role']), name=dict(value=e['name']),
            properties=[dict(name=k, value=dict(value=v)) for k,v in
                        (e.get('states') or {}).items()] if isinstance(e.get('states'), dict) else [])
       for i,e in enumerate(rows)]
nodes = ax.prune(raw)
boxes = {n['id']: rows[int(n['node_id'])].get('box') for n in nodes}
def assemble(selected):
    return schema.build_state(selected, kind='vision', url=tree['window'].get('url'),
        title=tree['window'].get('title'), ax_sha256=ax.snapshot_sha(selected),
        ax_stable_sha256=ax.snapshot_sha(selected, with_state=False),
        prune=dict(name=ax.PRUNE_NAME, version=ax.PRUNE_VERSION), raw_count=len(raw),
        boxes=boxes, viewport=dict(w=table['width'], h=table['height']),
        actionable_roles=ax.ACTIONABLE_ROLES)
state = assemble(nodes)
fusion = fuse_regions(state, [element['bbox'] for element in table['elements']])
visible = {hit['node'] for hit in fusion['hits']}
state = assemble([node for node in nodes if node['id'] in visible])
print(schema.dumps(state))
'''


def wender_state(root, table, tree, *, command=None):
    env = {k: os.environ[k] for k in ('PATH', 'LANG') if k in os.environ}
    env.update(PYTHONPATH=str(root), PYTHONDONTWRITEBYTECODE='1')
    result = subprocess.run(command or [sys.executable, '-c', WENDER_SHIM], cwd=root, env=env,
                            input=canonical(dict(element_table=table, tree=tree)), text=True,
                            capture_output=True, timeout=30)
    if result.returncode:
        raise GateFailure('wender_subprocess_failed', result.stderr[-2000:])
    state = json.loads(result.stdout)
    validate_state(state)
    require(result.stdout.strip() == canonical(state), 'Wender serialization is not canonical')
    return state


def raw_description(frame, root):
    pixels = checked_frame(frame)
    marks_root = Path('/dev/shm/vqa-cu')
    marks_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='mv-g-ai-', dir=marks_root) as marks:
        fd = os.memfd_create('g-ai-frame', os.MFD_CLOEXEC)
        with os.fdopen(fd, 'w+b') as stream:
            stream.write(vcore._png_bytes(pixels))
            stream.flush()
            stream.seek(0)
            result = subprocess.run([sys.executable, '-m', 'vadapt.cu_describe', '--frame',
                                     '/proc/self/fd/' + str(fd), '--marks-out', str(Path(marks) / 'marks.png'),
                                     '--json'], cwd=root, env=vcore._scrubbed_env(root), pass_fds=(fd,),
                                    capture_output=True, text=True, timeout=30)
        if result.returncode:
            raise GateFailure('vision_subprocess_failed', result.stderr[-2000:])
        payload = json.loads(result.stdout)
        vcore.project_element_table(frame, payload)
        return payload


def local_plan(state, frame):
    candidates = [n for n in state['nodes'] if n['id'] in state['actionable'] and n.get('box')]
    for target in candidates:
        try:
            AdmittedExecutor.check_target(target, latest=state['nodes'], frame=frame)
        except (ValueError, SurfaceError):
            continue
        x, y, w, h = target['box']
        return target, dict(type='click', x=x + w // 2, y=y + h // 2, button='left')
    raise GateFailure('no_actionable_target', 'live Wender state has no safe visible target')


def controls(frame, raw, state, target, proposal, verdict):
    flags = {}
    outside = dict(frame, ramws_path='/tmp/frame.rgb')
    flags['A2_path'] = rejected(lambda: vcore._ramws_frame(outside, frame['width'], frame['height']),
                                PerceptionError, 'bad_shape')
    wrong = dict(frame, sha256=('0' if frame['sha256'][0] != '0' else '1') + frame['sha256'][1:])
    flags['A2_digest'] = rejected(lambda: checked_frame(wrong), PerceptionError, 'bad_shape')
    bad = dict(raw, frame_sha256='0' * 64)
    flags['A3_binding'] = rejected(lambda: vcore.project_element_table(frame, bad), PerceptionError, 'identity_mismatch')
    bad = copy.deepcopy(raw)
    bad['crops'] = [dict(x=1.0, y=0, w=1, h=1, reason='salient')]
    flags['A3_float'] = rejected(lambda: vision.parse_description(canonical(bad)), vision.VisionBridgeError)
    bad = copy.deepcopy(state)
    bad['prune']['version'] = 1.0
    flags['A4_float_validate'] = rejected(lambda: validate_state(bad), ObservationError, 'bad_shape')
    flags['A4_float_digest'] = rejected(lambda: compute_battery_state_sha256(bad), ObservationError, 'bad_shape')
    for name, field, value, code in [('stop', 'name', 'Stop generation', 'generation_control'),
                                   ('box', 'box', [frame['width'], 0, 1, 1], 'alignment')]:
        bad = dict(target, **{field: value})
        flags['A5_' + name] = rejected(lambda: AdmittedExecutor.check_target(
            bad, latest=[bad], frame=frame), SurfaceError, code)
    bad = dict(target, role=target['role'] + '-mutated')
    flags['A5_custody'] = rejected(lambda: AdmittedExecutor.check_target(
        bad, latest=state['nodes'], frame=frame), ValueError)
    executor = AdmittedExecutor(transport=lambda _: dict(focus_verified=True, input_mono_ns=0))
    flags['A6_binding'] = rejected(lambda: executor.dispatch(proposal, dict(verdict, proposal_id='wrong')),
                                  SurfaceError, 'POLICY')
    for name, native, code in [('focus', dict(focus_verified=False, input_mono_ns=0), 'refused_focus'),
                              ('timestamp', dict(focus_verified=True), 'malformed_capture')]:
        flags['A7_' + name] = rejected(lambda: AdmittedExecutor(transport=lambda _: native).dispatch(
            proposal, verdict), SurfaceError, code)
    flags['A8_window'] = rejected(lambda: build_proposal(frame, proposal_id='inverted',
        action=proposal['action'], expectation=dict(type='state_sha256_change', before='0' * 64,
        min_tick=2, max_tick=1), max_ms=1000), ValueError)
    class NoChange:
        def request(self, call, expect, *, timeout_ms):
            return dict(schema=expect, request_id=call['request_id'], op='wait_verify',
                        status='timeout', proposal_id=proposal['proposal_id'], verified=False)
    flags['A8_no_change'] = rejected(lambda: tools.wait_verify(proposal['proposal_id'],
        proposal['expectation'], 1000, client=NoChange()), tools.VerificationFailed)
    return flags


def preflight(report):
    roots = {name: resolve_locked_component(name) for name in ('vision-engine', 'wender-agent')}
    require(not any(m.split('.')[0] in ('visioncore', 'vadapt', 'wender') for m in sys.modules),
            'private package imported into host')
    lock = json.loads((ROOT / 'deps.lock').read_text())
    report['deps_verified'] = {c['name']: c['commit'] for c in lock['components'] if c['name'] in roots}
    # Missing and mismatched provenance are checked through the actual resolver,
    # with inert PEP 610 metadata; this never opens or mutates a capsule.
    with tempfile.TemporaryDirectory(prefix='g-ai-provenance-') as temp:
        for name, variable in [('vision-engine', 'VQA_VE_ROOT'), ('wender-agent', 'MV_WENDER_ROOT')]:
            original = os.environ[variable]
            try:
                os.environ[variable] = str(Path(temp) / 'missing')
                report['negative_controls'][name + '_missing'] = rejected(
                    lambda: resolve_locked_component(name), DependencyLockError, 'unavailable')
                metadata = Path(temp) / (name.replace('-', '_') + '-0.dist-info')
                metadata.mkdir()
                (metadata / 'direct_url.json').write_text(canonical(dict(vcs_info=dict(vcs='git', commit_id='0' * 40))))
                os.environ[variable] = str(metadata)
                report['negative_controls'][name + '_pin'] = rejected(
                    lambda: resolve_locked_component(name), DependencyLockError, 'commit_mismatch')
            finally:
                os.environ[variable] = original
    report['assertions']['A1'] = True
    return roots


def run_gate(report, roots, session_factory=None):
    if session_factory is None:
        from g_ai_stack import Session
        session_factory = Session
    session = session_factory()
    try:
        with session as live:
            if hasattr(live, 'prepare_fixture'):
                live.prepare_fixture()
            observation = tools.observe(live.surface_id, client=live, timeout_ms=30000)
            frame = observation['frame_ref']
            checked_frame(frame)
            report['pre_frame_sha256'] = frame['sha256']
            report['assertions']['A2'] = True
            adapter = vcore.VCorePerceptionAdapter(roots['vision-engine'], python=sys.executable,
                                                   timeout=30, verify_lock=True)
            observation['vision'] = adapter.perceive(frame)
            tools._check_observation(observation)
            raw = raw_description(frame, roots['vision-engine'])
            table = vcore.project_element_table(frame, raw)
            report['c2_timing_us'] = adapter.last_timing_us
            report['perceived_elements'] = len(table['elements'])
            report['assertions']['A3'] = True
            tree = live.native_tree()
            state = wender_state(roots['wender-agent'], table, tree)
            state2 = wender_state(roots['wender-agent'], table, live.native_tree())
            battery = compute_battery_state_sha256(state)
            require(battery == compute_battery_state_sha256(state2), 'Wender static state nondeterminism')
            report['wender_state_counts'] = state['counts']
            require(bool(state['actionable']), 'Wender actionable list empty')
            report.update(wender_ax_sha256=state['ax_sha256'], battery_state_sha256=battery,
                          pre_state_sha256=hashlib.sha256(canonical(state).encode()).hexdigest())
            report['assertions']['A4'] = True
            expectation = dict(type='changed_region', bbox=dict(x=0, y=0, w=frame['width'], h=frame['height']))
            configured = os.environ.get('MV_WENDER_PLANNER_CMD')
            if configured is None:
                target, action = local_plan(state, frame)
                report['planner'] = 'local:custody_click/v1'
            else:
                bridge = WenderSubprocessAdapter(command=json.loads(configured),
                                                 wender_root=roots['wender-agent'], timeout=30)
                action, expectation, planned_state, target = bridge.plan_step(observation, table, 'Advance gate')
                require(canonical(planned_state) == canonical(state), 'planner changed observed Wender state')
                report['planner'] = 'configured:MV_WENDER_PLANNER_CMD'
            report['target'] = target
            report['assertions']['A5'] = True
            proposal = build_proposal(frame, proposal_id='g-ai-' + uuid.uuid4().hex,
                                      action=action, expectation=expectation, max_ms=30000)
            # Negative controls execute before the sole live mutation.
            nominal = dict(schema='action_verdict/v0.2', proposal_id=proposal['proposal_id'], decision='admitted', core_seq=1)
            report['negative_controls'].update(controls(frame, raw, state, target, proposal, nominal))
            verdict = tools.propose(proposal, client=live, timeout_ms=30000)
            report.update(proposal_id=proposal['proposal_id'], admission=verdict)
            report['assertions']['A6'] = True
            execution = AdmittedExecutor(transport=live.dispatched).dispatch(proposal, verdict)
            report.update(execution)
            report['assertions']['A7'] = True
            receipt = tools.wait_verify(proposal['proposal_id'], expectation, 30000, client=live)
            report['verified_receipt'] = receipt
            after = receipt['after_frame']
            checked_frame(after)
            report['post_frame_sha256'] = after['sha256']
            report['receipt_verified'] = receipt['verified']
            require(after['sha256'] != frame['sha256'], 'post-action pixels did not change')
            report['tick_window'] = dict(min_tick=frame['tick'] + 1, max_tick=frame['tick'] + 100)
            require(report['tick_window']['min_tick'] <= after['tick'] <= report['tick_window']['max_tick'],
                    'post-action tick outside window')
            stale = copy.deepcopy(proposal)
            stale['proposal_id'] += '-stale'
            try:
                tools.propose(stale, client=live, timeout_ms=30000)
            except tools.ToolRefusal as error:
                require(error.reason_code == 'STALE_FRAME', 'wrong stale-generation refusal')
                report['negative_controls']['A6_stale'] = True
            else:
                raise GateFailure('negative_control_accepted', 'core admitted stale generation')
            live.canvas(after)
            post_raw = raw_description(after, roots['vision-engine'])
            post_table = vcore.project_element_table(after, post_raw)
            post_state = wender_state(roots['wender-agent'], post_table, live.native_tree())
            report['post_state_sha256'] = hashlib.sha256(canonical(post_state).encode()).hexdigest()
            require(report['post_state_sha256'] != report['pre_state_sha256'], 'post-action state did not change')
            report['post_battery_state_sha256'] = compute_battery_state_sha256(post_state)
            require(report['post_battery_state_sha256'] != battery, 'post-action Wender state did not change')
            report['assertions']['A8'] = True
    finally:
        report['live_evidence'] = {k: v for k, v in session.report.items() if k != 'wire_evidence'}
        if hasattr(session, 'cleanup'):
            report['cleanup'] = session.cleanup
    require(isinstance(report.get('cleanup'), dict)
            and report['cleanup'].get('ram_absent') is True
            and not report['cleanup'].get('remaining'), 'cleanup proof missing')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--surface', required=True, choices=['mv-live-1'])
    parser.add_argument('--receipt-out', type=Path)
    args = parser.parse_args(argv)
    report = dict(schema='metaviewer.g-ai-receipt/v1', rc=5, status='BLOCKED',
                  assertions={f'A{i}': False for i in range(1, 9)}, negative_controls={})
    try:
        roots = preflight(report)
        run_gate(report, roots)
        require(all(report['assertions'].values()) and all(report['negative_controls'].values()), 'incomplete gates')
        require(report.get('cleanup', {}).get('ram_absent') is True
                and not report.get('cleanup', {}).get('remaining'), 'cleanup proof missing')
        report.update(rc=0, status='DONE')
    except Exception as error:
        report['error'] = dict(code=getattr(error, 'code', type(error).__name__), detail=str(error))
        if hasattr(error, 'receipt'):
            report['error']['receipt'] = error.receipt
    output = canonical(report)
    if args.receipt_out:
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=args.receipt_out.parent,
                                             prefix='.' + args.receipt_out.name, delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(output + '\n')
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, args.receipt_out)
        except OSError as error:
            report.update(rc=5, status='BLOCKED', error=dict(code='receipt_write_failed', detail=str(error)))
            output = canonical(report)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    print(output)
    return report['rc']


if __name__ == '__main__':
    sys.exit(main())
