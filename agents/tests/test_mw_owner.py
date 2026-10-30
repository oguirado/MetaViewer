"""Owner boundary controls and canonical hosted MemoryWeb fixture builder."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from metaviewer_agents.mw_owner import Corpus, OwnerRefused, ReplayOwner, wender_api


def make_checkout(root, api):
    gate = api[0]
    defs = gate.strict_load((gate.DOCS / 'mw.v1.schema.json').read_bytes())['$defs']

    def sample(schema):
        if '$ref' in schema:
            return sample(defs[schema['$ref'][8:]])
        if 'const' in schema:
            return schema['const']
        if 'anyOf' in schema:
            choices = schema['anyOf']
            return None if any(s.get('type') == 'null' for s in choices) else sample(choices[0])
        if 'oneOf' in schema:
            return sample(schema['oneOf'][0])
        if 'enum' in schema:
            return schema['enum'][0]
        kind = schema.get('type')
        if kind == 'object':
            return {k: sample(schema['properties'][k]) for k in schema.get('required', [])}
        if kind == 'array':
            return [sample(schema['items']) for _ in range(schema.get('minItems', 0))]
        if kind == 'integer':
            return schema.get('minimum', 0)
        if kind == 'boolean':
            return False
        if kind == 'string':
            if schema.get('pattern') == '^[0-9a-f]{64}$':
                return 'a' * 64
            if 'date' in schema.get('description', '').lower() or schema.get('pattern', '').startswith('^\\d{4}'):
                return '2026-01-01'
            return 'sample-id'
        raise AssertionError(schema)

    root = Path(root)
    site_dir = root / 'sites' / 'fixture'
    (site_dir / 'workflows').mkdir(parents=True)
    schemas = root / 'standards' / 'schemas'
    schemas.mkdir(parents=True)
    for kind in ('site', 'workflow', 'step', 'run'):
        schema = dict(defs[kind], **{'$defs': defs})
        (schemas / (kind + '.v1.json')).write_text(gate.canon(schema) + '\n')
    source = ('# Fixture provenance\n' + ''.join(
        '\n## ' + heading + '\nFixture-only offline replay.\n' for heading in gate.HEADINGS)).encode()
    (site_dir / 'EXPLANATION.md').write_bytes(source)
    provenance = dict(source='human', source_ref='EXPLANATION.md', tier=1,
        quote_sha256=hashlib.sha256(source).hexdigest(), receipt_sha256=None,
        derived_from_sha256=None, recorded='2026-01-01', run_id=None)
    policy = dict(requires_capsule_lease=True, min_notice_s=0,
        requires_operator_go_ahead_on_write=False, min_action_pace_ms=0,
        forbidden_keys=['Escape'], allow_capsule_restart=False)
    predicate = lambda name: dict(kind='state_signal', capability_id='mv.ax.present.v1',
        bindings=[dict(name='name', type='string', value=name)], evidence_refs=[],
        comparison='truth', snapshot_ref=None)
    def focused(name):
        return dict(predicate(name), capability_id='mv.ax.focus.v1')
    engines = [dict(engine='wender-agent', version_constraint='v0.3.0',
                    required_capabilities=['mv.ax.present.v1'])]
    site = sample(defs['site'])
    site.update(id='fixture', name='Offline fixture', domains=['fixture.invalid'],
        patterns=[], tags=[], status='draft', engine_compat=engines, reject_when=[],
        provenance=provenance, execution_policy=policy)
    workflow = sample(defs['workflow'])
    workflow.update(id='form', site_id='fixture', status='draft', baseline_id=None,
        fallback=dict(kind='ask_operator', workflow_id=None), engine_compat=engines,
        preconditions=[], text_slots=[], antipattern_guards=[], script_ref=None, script_sha256=None,
        provenance=provenance, execution_policy=policy,
        stats={k: None for k in defs['stats']['properties']},
        evaluation_profile=dict(kind='initial_task_v1', fixture_ids=['form'], cohort_sha256='a' * 64,
                                baseline_workflow_sha256=None),
        oracle=dict(postconditions=[focused('Submit Greeting')], planted_mutant_ids=[],
                    mutants_total=0, mutants_killed=0, receipt_refs=[]))
    steps = []
    for seq, name in enumerate(('Operator Name', 'Submit Greeting'), 1):
        step = sample(defs['step'])
        step.update(seq=seq, target=dict(rung='T1', anchor_ref='ax:' + name,
            offset_dx_px=0, offset_dy_px=0, consistency_tolerance_px=0,
            required_anchor_refs=['ax:' + name], frame_kind='element',
            frame_predicate=predicate(name), relative_xy_bps=None), fallback_targets=[],
            preconditions=[], when=None, already_satisfied=None, protected=True,
            capture_before=[], repeat=None, locate_wait_ms=5000, locate_poll_ms=10,
            action=dict(kind='click', button=1, text_slot=None, key_name=None,
                dx_px=None, dy_px=None, destination=None, delivery_budget_ms=30000, path='coordinates'),
            verify=dict(mode='state_signal', predicate=focused(name), busy_predicate=None,
                ram_evidence_ref=None, change_box_px=None, mask_boxes_px=[],
                postcondition_threshold_bps=0, consecutive_polls=1, poll_interval_ms=10,
                deadline_ms=30000, recorded_gap_ms=0, wait_multiplier_num=1,
                wait_multiplier_den=1, fallback_verifiers=[]))
        steps.append(step)
    for kind in ('key', 'scroll'):
        step = copy.deepcopy(steps[-1])
        step.update(seq=len(steps) + 1, target=None)
        step['action'].update(kind=kind, button=None, key_name='ArrowDown' if kind == 'key' else None,
                              dx_px=0 if kind == 'scroll' else None, dy_px=120 if kind == 'scroll' else None)
        step['preconditions'] = [focused('Submit Greeting')] if kind == 'key' else []
        steps.append(step)
    workflow['steps'] = steps
    for path, value in ((site_dir / 'site.json', site),
                         (site_dir / 'workflows' / 'form.json', workflow)):
        path.write_text(gate.canon(value) + '\n')
    return root


def text_workflow(workflow):
    """Chat-style prompt/Return/answer flow on the pinned hosted form page."""
    click = copy.deepcopy(workflow['steps'][0])
    focus = copy.deepcopy(click['verify']['predicate'])
    answer = dict(copy.deepcopy(focus), capability_id='mv.ax.present.v1',
                  bindings=[dict(name='name', type='string', value='ANSWER_READY')])
    paste = copy.deepcopy(click)
    paste.update(seq=2, target=None, preconditions=[focus])
    paste['action'].update(kind='paste', button=None, text_slot='prompt')
    submit = copy.deepcopy(paste)
    submit.update(seq=3)
    submit['action'].update(kind='key', text_slot=None, key_name='Return')
    submit['verify']['predicate'] = answer
    workflow.update(steps=[click, paste, submit],
        text_slots=[dict(slot_id='prompt', transport='key_seq', clear_first=True,
            budget_ms=30000, max_length=4096, sensitivity='private_runtime_only',
            chip_clear_steps=[], empty_len_allowed=[0], post_type_len_allowed=['exact_n'])])
    workflow['oracle']['postconditions'] = [answer]



class OwnerTests(unittest.TestCase):
    def setUp(self):
        # Scope the private dependency to this fixture. Globally configuring
        # MV_WENDER_ROOT intentionally changes the legacy planner's behavior.
        if os.environ.get('MV_MW_WENDER_ROOT'):
            environment = patch.dict(os.environ, {'MV_WENDER_ROOT': os.environ['MV_MW_WENDER_ROOT']})
            environment.start()
            self.addCleanup(environment.stop)
        self.original_modules = set(sys.modules)
        self.original_path = sys.path[:]
        self.saved_private = {name: value for name, value in sys.modules.items()
                              if name == 'tools' or name.startswith('tools.') or
                              name == 'wender' or name.startswith('wender.')}
        for name in self.saved_private:
            sys.modules.pop(name)
        self.addCleanup(self.remove_private_imports)
        self.api = wender_api()
        self.temp = tempfile.TemporaryDirectory(prefix='mv-mw-Música-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        make_checkout(self.root, self.api)
        self.corpus = Corpus(self.root, 'fixture/form', self.api)
        self.evidence = self.root / 'evidence'
        self.evidence.mkdir(mode=0o700)
        self.calls = []
        class Backend:
            def call(backend, name, **args):
                self.calls.append(name)
                raise AssertionError('backend must remain untouched')
        self.owner = ReplayOwner(Backend(), self.corpus, self.evidence / 'run.json',
            notice=dict(mode='replay', network='offline fixtures', acknowledged=True, mono_ns=time.monotonic_ns()))

    def remove_private_imports(self):
        sys.path[:] = self.original_path
        for name in set(sys.modules) - self.original_modules:
            if name == 'wender' or name.startswith('wender.') or name == 'tools' or name.startswith('tools.'):
                sys.modules.pop(name, None)
        sys.modules.update(self.saved_private)

    def test_real_gate_accepts_canonical_fixture_before_backend(self):
        self.owner.validate_corpus()
        self.assertEqual(self.calls, [])

    def test_modes_refuse(self):
        for mode in (None, '', 'unknown', 'shadow', 'promoted', 'repair'):
            with self.assertRaisesRegex(OwnerRefused, 'MW_NETWORK'):
                ReplayOwner(None, self.corpus, self.evidence / 'run.json', mode=mode)

    def test_mut_owner_forbidden_network_verbs_static_scan(self):
        # MUT-OWNER-NET-DOWN: scan source and prove the scanner kills injection.
        forbidden = tuple('net' + suffix for suffix in ('_down', '_up'))
        root = Path(__file__).resolve().parents[2]
        def violations(source):
            return any(verb in source for verb in forbidden)
        for directory in ('agents', 'tests/e2e'):
            for path in (root / directory).rglob('*'):
                if path.suffix not in ('.py', '.js', '.cjs', '.mjs'):
                    continue
                source = path.read_text()
                # The native argv refusal guard and its tests may name the verb.
                if path == root / 'tests/e2e/e2e1_slice/live.py':
                    continue
                self.assertFalse(violations(source), str(path))
        for relative in ('agents/metaviewer_agents/mw_owner.py',
                         'tests/e2e/e2e1_slice/asm_web_live.py'):
            source = (root / relative).read_text()
            for verb in forbidden:
                self.assertTrue(violations(source + "\nbackend.call('" + verb + "')"))

    def test_missing_notice_refuses_before_backend(self):
        self.owner.notice = None
        with self.assertRaisesRegex(OwnerRefused, 'MW_NOTICE'):
            self.owner.validate_corpus()
        self.assertEqual(self.calls, [])

    def test_mut_drag_and_scroll_point_refuse_before_input(self):
        for kind in ('drag', 'double_click', 'paste'):
            with self.assertRaisesRegex(OwnerRefused, 'MW_UNSUPPORTED_ACTION'):
                self.owner.send(dict(kind=kind), None)
        for point in ((0, 0), None, []):
            with self.assertRaisesRegex(OwnerRefused, 'MW_SCROLL_POINT'):
                self.owner.send(dict(kind='scroll', point=point, dx_px=0, dy_px=10), None)
        self.assertEqual(self.calls, [])

    def test_type_key_and_point_free_scroll_translation(self):
        self.assertEqual(self.owner.translate(dict(kind='type', text='Música'), None),
                         dict(type='type', text='Música'))
        self.assertEqual(self.owner.translate(dict(kind='key', key_name='Tab'), None),
                         dict(type='key', keys=['Tab']))
        self.assertEqual(self.owner.plan(dict(kind='scroll', dx_px=0, dy_px=120), None),
                         dict(type='scroll', dx=0, dy=120))
        with self.assertRaisesRegex(OwnerRefused, 'MW_KEY_POLICY'):
            self.owner.translate(dict(kind='key', key_name='Escape'), None)
        self.assertEqual(self.calls, [])

    def test_type_send_requires_admission_and_verified_receipt(self):
        sensed = dict(frame=dict(surface_id='owned-surface', width=640, height=360),
                      ax=[dict(name='Operator Name', focused=True)])
        self.owner.sense = lambda deadline: sensed
        self.owner.check = lambda *args: self.owner.answer(True)
        calls = []

        def call(stage, **args):
            calls.append(stage)
            if stage == 'propose':
                self.assertEqual(args['plan']['action'], dict(type='type', text='Música'))
                return dict(proposal_id='typed-proposal',
                    verdict=dict(schema='action_verdict/v0.2', proposal_id='typed-proposal',
                                 decision='admitted', core_seq=1),
                    native_evidence=dict(input_mono_ns=time.monotonic_ns()))
            self.assertEqual(stage, 'wait_verify')
            admitted = args['admitted']
            timestamp = admitted['native_evidence']['input_mono_ns']
            return dict(status='verified', focus_verified=True, input_mono_ns=timestamp,
                frame_sha256='a' * 64, receipt_binding_negative_control='PASS',
                receipt=dict(verified=True, proposal_id=admitted['proposal_id'],
                    native_evidence=dict(input_mono_ns=timestamp, surface_id='owned-surface'),
                    after_frame=dict(surface_id='owned-surface', sha256='a' * 64)))

        self.owner.backend.call = call
        self.owner.latest, self.owner.send_ready = sensed, True
        timestamp = self.owner.send(dict(kind='type', text='Música'), None)
        self.assertGreater(timestamp, 0)
        self.assertEqual(calls, ['propose', 'wait_verify'])
        self.assertEqual(len(self.owner.receipts), 1)
        calls.clear()
        sensed['ax'][0]['focused'] = False
        self.owner.send_ready = True
        with self.assertRaisesRegex(OwnerRefused, 'MW_FOCUS'):
            self.owner.send(dict(kind='type', text='Música'), None)
        self.assertEqual(calls, [])

    def test_schema_and_schema_pin_refuse(self):
        site = self.root / 'sites/fixture/site.json'
        value = json.loads(site.read_text())
        value['domains'] = 'invalid'
        site.write_text(self.api[0].canon(value) + '\n')
        with self.assertRaisesRegex(OwnerRefused, 'MW_SCHEMA'):
            Corpus(self.root, 'fixture/form', self.api)
        self.assertEqual(self.calls, [])

    def test_artifact_mutation_refuses(self):
        self.corpus.path.write_text('{}\n')
        with self.assertRaisesRegex(OwnerRefused, 'SEAL_MISMATCH'):
            with self.owner.pin(self.corpus.path):
                self.fail('mutated artifact pinned')

    def test_journal_authentication_and_capacity(self):
        event = dict(seq=1, prev=None, kind='intent', step_seq=1, phase='delivery')
        event['digest'] = self.owner.digest(self.api[0].canon(event).encode(), None)
        self.assertIs(self.owner.authenticate(event).result, self.owner.Truth.TRUE)
        event['step_seq'] = 2
        self.assertIs(self.owner.authenticate(event).result, self.owner.Truth.FALSE)
        with self.assertRaisesRegex(OwnerRefused, 'MW_CAPACITY'):
            self.owner.reserve('peak', self.owner.limits.journal_bytes + 1)

    def test_stale_publication_cannot_follow_verified_input(self):
        frame = dict(surface_id='owned', generation=1, sha256='a' * 64)
        self.owner.receipts = [dict(receipt=dict(after_frame=dict(frame, generation=2)))]
        def call(stage, **args):
            if stage == 'observe':
                return dict(frame_ref=frame)
            if stage == 'perceive':
                return dict(frame=frame, table=dict(frame_sha256=frame['sha256']),
                    frame_witness=dict(sha256=frame['sha256'], generation=1,
                        surface_id='owned', bytes=1, artifact='owned-publication'))
            self.fail('stale publication reached ' + stage)
        self.owner.backend.call = call
        with self.assertRaisesRegex(OwnerRefused, 'MW_STALE_PUBLICATION'):
            self.owner.sense(self.owner.limits.deadline_ns)

    def test_mut_bypass_no_native_import_or_process_boundary(self):
        import ast
        import re
        import metaviewer_agents.mw_owner as module
        def check_source(source, helper=False):
            tree = ast.parse(source)
            allowed = {'contextlib', 'datetime', 'copy', 'hashlib', 'hmac', 'os', 'pathlib',
                       're', 'stat', 'sys', 'time', 'uuid', '.executor', '.tools',
                       '.perception.deps_lock', '.wender_bridge', 'tools', 'wender.learn',
                       'wender.learn.script_live', 'wender.scripts.types', '.mw_handoff'}
            if helper:
                allowed = {'dataclasses', 'json', 'wender.perceive.stopstate'}
            imports = {'.' * n.level + (n.module or '') for n in ast.walk(tree)
                       if isinstance(n, ast.ImportFrom)}
            imports |= {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
            self.assertLessEqual(imports, allowed)
            forbidden = r'(?:system|popen|exec.*|spawn.*|posix_spawn.*|fork.*|socket|__import__|importlib|eval|compile|ctypes|xdotool|docker|srf|injectInputSingleOp|getattr|getattribute|globals|locals|vars|__class__|__dict__|__subclasses__|__builtins__)'
            names = [n.id for n in ast.walk(tree) if isinstance(n, ast.Name)]
            names += [n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)]
            names += [name for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))
                      for a in n.names for name in (a.name, a.asname) if name]
            self.assertEqual([n for n in names if re.fullmatch(forbidden, n)], [])
        source = Path(module.__file__).read_text()
        check_source(source)
        helper = Path(module.__file__).with_name('mw_handoff.py').read_text()
        check_source(helper, helper=True)
        for mutant in ('os.posix_spawn', 'os.spawnl', 'os.fork', 'socket', '__import__',
                       'importlib', 'eval', 'compile', 'ctypes', 'os.execve',
                       'getattr', 'getattribute', 'globals', 'locals', 'vars',
                       'obj.__class__', 'obj.__dict__', 'obj.__subclasses__', '__builtins__',
                       "getattr(os, 'sy' + 'stem')"):
            with self.subTest(mutant=mutant):
                with self.assertRaises(AssertionError):
                    check_source(source + '\n' + mutant + '\n')
                with self.assertRaises(AssertionError):
                    check_source(helper + '\n' + mutant + '\n', helper=True)

    def rewrite(self, mutate):
        workflow = copy.deepcopy(self.corpus.workflow)
        site = copy.deepcopy(self.corpus.site)
        mutate(workflow, site)
        for path, value in ((self.corpus.path, workflow),
                            (self.root / 'sites/fixture/site.json', site)):
            path.write_text(self.api[0].canon(value) + '\n')
        self.corpus = Corpus(self.root, 'fixture/form', self.api)
        self.owner.corpus = self.corpus

    def assert_admission_refused(self, mutate):
        self.rewrite(mutate)
        self.assertIs(self.owner.supports(self.corpus.workflow).result, self.owner.Truth.FALSE)
        with self.assertRaisesRegex(OwnerRefused, 'MW_UNSUPPORTED_WORKFLOW'):
            self.owner.run()
        self.assertEqual(self.calls, [])

    def test_admission_button_null(self):
        self.assert_admission_refused(lambda w, s: w['steps'][0]['action'].update(button=None))

    def test_admission_button_outside_range(self):
        # Outside 1–3 is schema-invalid; supports also refuses it independently.
        self.corpus.workflow['steps'][0]['action']['button'] = 4
        self.assertIs(self.owner.supports(self.corpus.workflow).result, self.owner.Truth.FALSE)
        with self.assertRaisesRegex(OwnerRefused, 'MW_UNSUPPORTED_WORKFLOW'):
            self.owner.validate_corpus()
        self.assertEqual(self.calls, [])

    def test_admission_right_click_button(self):
        self.assert_admission_refused(lambda w, s: w['steps'][0]['action'].update(kind='right_click'))

    def test_admission_escape_after_clicks_zero_proposals(self):
        self.assert_admission_refused(lambda w, s: w['steps'][2]['action'].update(key_name='Escape'))

    def test_mut_chord_esc(self):
        for key in ('Tab+Escape', 'Tab+Esc', 'Tab+', '+Tab', 'Tab++ArrowDown',
                    'escape', ' Escape', 'ESC', 'Tab+escape', 'Tab+ ESC',
                    'Tab+Arrow-Down', 'Tab+é', 'A' * 33, '+'.join(['A'] * 9)):
            with self.subTest(key=key):
                self.assert_admission_refused(lambda w, s: w['steps'][2]['action'].update(key_name=key))
                with self.assertRaisesRegex(OwnerRefused, 'MW_KEY_POLICY'):
                    self.owner.action(dict(kind='key', key_name=key), None)

    def test_admission_policy_forbidden_chord(self):
        for policy in ('site', 'workflow'):
            with self.subTest(policy=policy):
                def mutate(w, s):
                    (s if policy == 'site' else w)['execution_policy']['forbidden_keys'] = ['ArrowDown']
                    w['steps'][2]['action']['key_name'] = 'Shift+ArrowDown'
                self.assert_admission_refused(mutate)

    def test_admission_policy_forbidden_key_case(self):
        for policy in ('site', 'workflow'):
            with self.subTest(policy=policy):
                def mutate(w, s):
                    (s if policy == 'site' else w)['execution_policy']['forbidden_keys'] = ['f5']
                    w['steps'][2]['action']['key_name'] = 'F5'
                self.assert_admission_refused(mutate)

    def test_mut_pace_huge(self):
        self.assert_admission_refused(lambda w, s: w['execution_policy'].update(min_action_pace_ms=3600000))
        with patch('metaviewer_agents.mw_owner.time.sleep') as sleep:
            with self.assertRaisesRegex(OwnerRefused, 'MW_PACE_POLICY'):
                self.owner.send(dict(kind='key', key_name='Tab'), None)
            sleep.assert_not_called()

    def test_admission_site_pace_huge(self):
        self.assert_admission_refused(lambda w, s: s['execution_policy'].update(min_action_pace_ms=5001))

    def test_admission_budget_huge(self):
        self.assert_admission_refused(lambda w, s: w['steps'][0]['action'].update(delivery_budget_ms=120000))

    def test_admission_already_satisfied(self):
        def mutate(w, s):
            w['steps'][0]['already_satisfied'] = dict(w['steps'][0]['verify']['predicate'], comparison='changed')
        self.assert_admission_refused(mutate)

    def test_admission_target_predicate(self):
        self.assert_admission_refused(lambda w, s: w['steps'][0]['target']['frame_predicate'].update(comparison='changed'))

    def test_admission_target_shape(self):
        self.assert_admission_refused(lambda w, s: w['steps'][0]['target'].update(relative_xy_bps=[5000, 5000]))

    def test_admission_precondition(self):
        self.assert_admission_refused(lambda w, s: w['steps'][2]['preconditions'][0].update(comparison='changed'))

    def test_admission_missing_focus(self):
        self.assert_admission_refused(lambda w, s: w['steps'][2].update(preconditions=[]))

    def test_admission_scroll_with_target(self):
        self.assert_admission_refused(lambda w, s: w['steps'][3].update(target=copy.deepcopy(w['steps'][0]['target'])))

    def test_admission_empty_oracle(self):
        # The schema rejects empty oracles on disk; also guard the direct dict seam.
        self.corpus.workflow['oracle']['postconditions'] = []
        self.assertIs(self.owner.supports(self.corpus.workflow).result, self.owner.Truth.FALSE)
        with self.assertRaisesRegex(OwnerRefused, 'MW_UNSUPPORTED_WORKFLOW'):
            self.owner.run()
        self.assertEqual(self.calls, [])

    def test_admission_wait_signal_with_target(self):
        self.assert_admission_refused(lambda w, s: w['steps'][0]['action'].update(kind='wait_signal'))

    def test_admission_wait_signal_without_target(self):
        def mutate(w, s):
            w['steps'][3]['action']['kind'] = 'wait_signal'
        self.assert_admission_refused(mutate)

    def install_backend(self):
        self.proposals = []
        self.focused = None
        self.editor_text = ''
        self.answered = False
        self.generation = 1
        names = ('Operator Name', 'Submit Greeting')
        def frame():
            return dict(surface_id='owned', width=640, height=360, generation=self.generation,
                        sha256=hashlib.sha256(str(self.generation).encode()).hexdigest())
        def nodes():
            return [dict(id=f'{i:016x}', name=name, role='button', actionable=True,
                         depth=0, parent=None, ordinal=i, states={}, box=[10 + i * 100, 20, 80, 30])
                    for i, name in enumerate(names + (('ANSWER_READY',) if self.answered else ()))]
        def call(stage, **args):
            self.calls.append(stage)
            if stage == 'offline_proof':
                return dict(fixtures_offline=True)
            if stage == 'ownership':
                return dict(profile='mv-live-1', capsules=['owned'])
            if stage == 'observe':
                return dict(frame_ref=frame())
            if stage == 'perceive':
                f = frame()
                return dict(frame=f, table=dict(frame_sha256=f['sha256']),
                            frame_witness=dict(f, bytes=1, artifact='hosted-frame'))
            if stage == 'state':
                rows = nodes()
                return dict(schema='wender.state/v1', source=dict(kind='vision', url=None, title='fixture'),
                    prune=dict(name='test', version=1), ax_sha256='b' * 64, ax_stable_sha256='c' * 64,
                    viewport=dict(w=640, h=360), nodes=rows, actionable=[r['id'] for r in rows],
                    counts=dict(raw=len(rows), nodes=len(rows), actionable=len(rows)))
            if stage == 'ax':
                return dict(nodes=[dict(name=name, focused=name == self.focused,
                    text=self.editor_text if name == 'Operator Name' else '')
                    for name in names + (('ANSWER_READY',) if self.answered else ())])
            if stage == 'propose':
                action = args['plan']['action']
                self.proposals.append(action)
                if action['type'] == 'click':
                    self.focused = names[int(action['x'] > 100)]
                if action['type'] == 'type':
                    self.editor_text = action['text']
                if action == dict(type='key', keys=['Return']):
                    self.answered = True
                self.generation += 1
                return dict(proposal_id=str(len(self.proposals)),
                    verdict=dict(schema='action_verdict/v0.2', proposal_id=str(len(self.proposals)),
                                 decision='admitted', core_seq=len(self.proposals)),
                    native_evidence=dict(input_mono_ns=time.monotonic_ns()))
            if stage == 'wait_verify':
                admitted = args['admitted']
                ns = admitted['native_evidence']['input_mono_ns']
                f = frame()
                return dict(status='verified', focus_verified=True, input_mono_ns=ns,
                    frame_sha256=f['sha256'], receipt_binding_negative_control='PASS',
                    receipt=dict(verified=True, proposal_id=admitted['proposal_id'], after_frame=f,
                                 native_evidence=dict(input_mono_ns=ns, surface_id='owned')))
            self.fail(stage)
        self.owner.backend.call = call

    def assert_summary(self, result):
        self.assertIsNotNone(result.summary, result)
        emitted = self.api[0].strict_load(self.owner.output.read_bytes())
        self.assertEqual(emitted, result.summary)
        self.assertTrue(self.api[0].conforms(emitted, self.corpus.schemas['run'], self.corpus.bundle['$defs']))

    def test_mut_site_mode_missing(self):
        # MUT-SITE-MODE-MISSING: no fallback to an assumed open network.
        self.install_backend()
        self.owner.mode, self.owner.network = 'site', None
        self.owner.notice.update(mode='site', network='open')
        original = self.owner.backend.call
        for reply in ({}, None, {'mode': 'unknown'}, {'mode': 'down'}):
            with self.subTest(reply=reply):
                self.owner.backend.call = lambda stage, **args: reply if stage == 'network_context' else original(stage, **args)
                with self.assertRaisesRegex(OwnerRefused, 'MW_NETWORK'):
                    self.owner.run()
                self.assertEqual(self.proposals, [])

    def test_mut_replay_no_proof_before_run(self):
        # MUT-REPLAY-NO-PROOF: missing, false and truthy impostors all refuse.
        self.install_backend()
        original = self.owner.backend.call
        for reply in ({}, None, {'fixtures_offline': False}, {'fixtures_offline': 1}):
            with self.subTest(reply=reply):
                self.owner.backend.call = lambda stage, **args: reply if stage == 'offline_proof' else original(stage, **args)
                with self.assertRaisesRegex(OwnerRefused, 'MW_NETWORK'):
                    self.owner.run()
                self.assertEqual(self.proposals, [])

    def test_mut_replay_proof_revoked_before_input(self):
        self.install_backend()
        original = self.owner.backend.call
        def call(stage, **args):
            if stage == 'offline_proof' and self.proposals:
                return {'fixtures_offline': False}
            return original(stage, **args)
        self.owner.backend.call = call
        result = self.owner.run()
        self.assertNotEqual(result.rc, 0)
        self.assertEqual(len(self.proposals), 1)
        self.assertEqual(len(self.owner.receipts), 1)

    def test_site_modes_recorded_in_notice_and_receipts(self):
        for index, declared in enumerate(('open', 'allowlisted/proxied', 'legacy')):
            with self.subTest(declared=declared):
                self.owner.dispatch.close()
                self.owner = ReplayOwner(self.owner.backend, self.corpus,
                    self.evidence / f'site-{index}.json', mode='site',
                    notice=dict(mode='site', network=declared, acknowledged=True,
                                mono_ns=time.monotonic_ns()))
                self.install_backend()
                original = self.owner.backend.call
                def call(stage, **args):
                    if stage == 'network_context':
                        self.calls.append(stage)
                        return {'mode': declared}
                    self.assertNotEqual(stage, 'offline_proof')
                    return original(stage, **args)
                self.owner.backend.call = call
                result = self.owner.run()
                self.assertEqual(result.verdict_code, 'VERIFIED', result)
                self.assert_summary(result)
                self.assertTrue(self.owner.receipts)
                for receipt in self.owner.receipts:
                    self.assertEqual((receipt['mode'], receipt['network']), ('site', declared))
                self.assertEqual(self.owner.notice['network'], declared)

    def test_site_mode_change_and_notice_mismatch_refuse(self):
        self.install_backend()
        self.owner.mode, self.owner.network = 'site', None
        self.owner.notice.update(mode='site', network='open')
        self.owner.backend.call = lambda stage, **args: {'mode': 'legacy'}
        with self.assertRaisesRegex(OwnerRefused, 'MW_NOTICE'):
            self.owner.validate_corpus()
        self.owner.network = 'open'
        with self.assertRaisesRegex(OwnerRefused, 'MW_NETWORK'):
            self.owner.check_network()

    def test_run_click_key_scroll_sequence_and_run_schema(self):
        self.install_backend()
        result = self.owner.run()
        self.assertEqual(result.verdict_code, 'VERIFIED', result)
        self.assert_summary(result)
        self.assertEqual(self.proposals, [dict(type='click', x=50, y=35, button='left'),
            dict(type='click', x=150, y=35, button='left'), dict(type='key', keys=['ArrowDown']),
            dict(type='scroll', dx=0, dy=120)])
        self.assertEqual(len(self.owner.receipts), 4)

    def test_mut_budget_huge_pre_intent_has_failure_summary(self):
        self.rewrite(lambda w, s: w['steps'][0]['action'].update(delivery_budget_ms=120000))
        self.install_backend()
        # Exercise Wender directly to prove its pre-intent owner seam also refuses.
        # The public owner.run() rejects this earlier at corpus admission.
        with patch.object(self.owner, 'supports', return_value=self.owner.answer(True)):
            result = self.owner.mw.run_workflow(self.corpus.path, bundle=self.corpus.bundle,
                                               owners=self.owner.owners(), limits=self.owner.limits)
        self.assertEqual((result.rc, result.verdict_code), (2, 'USAGE_SCHEMA'))
        self.assert_summary(result)
        self.assertEqual(self.proposals, [])
        self.assertNotIn('intent', [self.api[0].strict_load(e)['kind'] for e in self.owner.events])

    def test_pace_deadline_refuses_without_sleep_or_proposal(self):
        from dataclasses import replace
        self.install_backend()
        self.owner.corpus.workflow['execution_policy']['min_action_pace_ms'] = 5000
        self.focused = 'Submit Greeting'
        self.owner.last_send = time.monotonic_ns()
        self.owner.limits = replace(self.owner.limits, deadline_ns=time.monotonic_ns() + 1_000_000)
        with patch('metaviewer_agents.mw_owner.time.sleep') as sleep:
            with self.assertRaisesRegex(OwnerRefused, 'MW_DEADLINE'):
                self.owner.check('send', self.corpus.workflow, self.owner.scope, self.owner.authority)
            sleep.assert_not_called()
        self.assertEqual(self.proposals, [])

    def prepare_text(self, value='private prompt Ω'):
        self.rewrite(lambda w, s: text_workflow(w))
        self.owner.slots.values = {'prompt': value}
        self.install_backend()

    def test_private_text_run_and_no_content_in_evidence(self):
        self.prepare_text()
        for name in ('prepare', 'clear', 'cleared'):
            guard = patch.object(self.owner.slots, name, create=True,
                                 side_effect=AssertionError('clipboard path'))
            guard.start()
            self.addCleanup(guard.stop)
        result = self.owner.run()
        self.assertEqual((result.rc, result.verdict_code), (0, 'VERIFIED'), result)
        self.assert_summary(result)
        self.assertEqual([p['type'] for p in self.proposals], ['click', 'type', 'key'])
        self.assertEqual(self.proposals[1], dict(type='type', text='private prompt Ω'))
        self.assertEqual(self.proposals[2], dict(type='key', keys=['Return']))
        self.assertEqual(len(self.owner.receipts), 3)
        self.assertTrue(any(v.output_kind == 'integer' and v.value == len('private prompt Ω')
                            for v in self.owner.publications.values()))
        self.assertNotIn('private prompt Ω', json.dumps(self.owner.receipts, ensure_ascii=False))
        for path in self.evidence.iterdir():
            self.assertNotIn('private prompt Ω'.encode(), path.read_bytes())

    def test_mut_slot_from_corpus_and_missing_invocation_value(self):
        self.prepare_text()
        workflow = copy.deepcopy(self.corpus.workflow)
        workflow['text_slots'][0]['value'] = 'corpus secret'
        self.corpus.path.write_text(self.api[0].canon(workflow) + '\n')
        with self.assertRaisesRegex(OwnerRefused, 'MW_SCHEMA'):
            Corpus(self.root, 'fixture/form', self.api)
        self.owner.slots.values = {}
        self.assertIs(self.owner.supports(self.corpus.workflow).result, self.owner.Truth.FALSE)
        self.assertEqual(self.proposals, [])

    def test_mut_unbounded_text_never_reaches_propose(self):
        self.prepare_text()
        for value in ('', 'x' * 4097, 'é' * 2049, 'x' * 65537,
                      'a\n', 'a\t', 'a\x00', 'a\x7f', 'a\u0085',
                      'a\u202e', 'a\u2066', 'a\ud800', 'a\u200f', 'a\u061c'):
            with self.subTest(length=len(value)):
                self.owner.slots.values = {'prompt': value}
                self.assertIs(self.owner.supports(self.corpus.workflow).result, self.owner.Truth.FALSE)
                with self.assertRaises(OwnerRefused):
                    self.owner.send(dict(kind='type', text=value), None)
        self.owner.slots.values = {'prompt': 'long'}
        self.corpus.workflow['text_slots'][0]['max_length'] = 3
        self.assertIs(self.owner.supports(self.corpus.workflow).result, self.owner.Truth.FALSE)
        self.assertEqual(self.proposals, [])

    def test_mut_type_requires_verified_receipt(self):
        for mutation in ('timeout', 'proposal_id', 'input_mono_ns', 'after_frame', 'focus', 'negative'):
            with self.subTest(mutation=mutation):
                self.prepare_text()
                original = self.owner.backend.call
                def call(stage, **args):
                    result = original(stage, **args)
                    if stage == 'wait_verify' and len(self.proposals) == 2:
                        if mutation == 'timeout':
                            raise TimeoutError('receipt absent')
                        if mutation == 'proposal_id':
                            result['receipt']['proposal_id'] = 'foreign'
                        if mutation == 'input_mono_ns':
                            result['receipt']['native_evidence']['input_mono_ns'] = 0
                        if mutation == 'after_frame':
                            result['receipt']['after_frame']['surface_id'] = 'foreign'
                        if mutation == 'focus':
                            result['focus_verified'] = False
                        if mutation == 'negative':
                            result['receipt_binding_negative_control'] = 'FAIL'
                    return result
                self.owner.backend.call = call
                result = self.owner.run()
                self.assertNotEqual(result.rc, 0)
                self.assertEqual([p['type'] for p in self.proposals], ['click', 'type'])
                self.assertEqual(len(self.owner.receipts), 1)
                # A new dispatch owner and private journal per attempt.
                self.owner.dispatch.close()
                for path in self.evidence.iterdir():
                    path.unlink()
                self.owner = ReplayOwner(self.owner.backend, self.corpus, self.evidence / 'run.json',
                    notice=dict(mode='replay', network='offline fixtures', acknowledged=True, mono_ns=time.monotonic_ns()))

    def test_mut_opaque_receipt_cannot_export_text(self):
        self.prepare_text()
        original = self.owner.backend.call
        def call(stage, **args):
            result = original(stage, **args)
            if stage == 'wait_verify':
                result['typed_text'] = 'private prompt Ω'
                result['receipt']['typed_text'] = 'private prompt Ω'
                result['receipt']['native_evidence']['typed_text'] = 'private prompt Ω'
            return result
        self.owner.backend.call = call
        result = self.owner.run()
        self.assertEqual(result.rc, 0, result)
        self.assertNotIn('private prompt Ω', json.dumps(self.owner.receipts, ensure_ascii=False))
        for path in self.evidence.iterdir():
            self.assertNotIn('private prompt Ω'.encode(), path.read_bytes())

    def test_paste_requires_declared_slot_and_focus(self):
        self.prepare_text()
        action = self.corpus.workflow['steps'][1]['action']
        action['text_slot'] = 'undeclared'
        self.assertIs(self.owner.supports(self.corpus.workflow).result, self.owner.Truth.FALSE)
        action['text_slot'] = 'prompt'
        self.corpus.workflow['steps'][1]['preconditions'] = []
        self.assertIs(self.owner.supports(self.corpus.workflow).result, self.owner.Truth.FALSE)
        self.assertEqual(self.proposals, [])

    def test_mut_length_observation_is_measured_not_expected(self):
        self.prepare_text()
        original = self.owner.backend.call
        def call(stage, **args):
            result = original(stage, **args)
            if stage == 'ax' and any(p['type'] == 'type' for p in self.proposals):
                result['nodes'][0]['text'] = 'wrong length'
            return result
        self.owner.backend.call = call
        result = self.owner.run()
        self.assertNotEqual(result.rc, 0)
        self.assertEqual([p['type'] for p in self.proposals], ['click', 'type'])



if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] in ('--fixture', '--fixture-text'):
        api = wender_api()
        make_checkout(Path(sys.argv[2]), api)
        if sys.argv[1] == '--fixture-text':
            path = Path(sys.argv[2]) / 'sites/fixture/workflows/form.json'
            workflow = api[0].strict_load(path.read_bytes())
            text_workflow(workflow)
            path.write_text(api[0].canon(workflow) + '\n')
    else:
        unittest.main()
