"""SIT-FIX owner controls: schema-less MemoryWeb home, notice policy, polled completion step.

Named test_sitfix_* so the default unittest discovery of the agents leg collects it.
"""
import copy
import shutil
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_mw_owner as base  # a module alias, so its TestCase classes are not re-collected
from metaviewer_agents.mw_owner import Corpus, OwnerRefused, ReplayOwner

SELECTOR = 'fixture/form'


class SitfixOwnerTests(unittest.TestCase):
    remove_private_imports = base.OwnerTests.remove_private_imports
    rewrite = base.OwnerTests.rewrite

    def setUp(self):
        base.OwnerTests.setUp(self)  # same private-dependency scoping and fixture checkout

    def reopen(self):
        return Corpus(self.root, SELECTOR, self.api)

    def test_home_without_standards_uses_pinned_bundle_and_validates(self):
        reference = {kind: copy.deepcopy(schema) for kind, schema in self.corpus.schemas.items()}
        shutil.rmtree(self.root / 'standards')
        corpus = self.reopen()
        self.assertEqual(corpus.schemas, reference)
        owner = ReplayOwner(self.owner.backend, corpus, self.evidence / 'bundle.json',
            notice=dict(mode='replay', network='offline fixtures', acknowledged=True,
                        mono_ns=time.monotonic_ns()))
        self.addCleanup(owner.dispatch.close)
        owner.validate_corpus()
        self.assertEqual(self.calls, [])

    def test_mut_standards_dir_present_never_falls_back(self):
        # Negative control: only a home with NO standards directory takes the bundle.
        (self.root / 'standards' / 'schemas' / 'run.v1.json').unlink()
        with self.assertRaises(FileNotFoundError):
            self.reopen()

    def test_mut_tampered_schema_still_refused(self):
        path = self.root / 'standards' / 'schemas' / 'site.v1.json'
        value = self.api[0].strict_load(path.read_bytes())
        value['required'] = value['required'][:-1]
        path.write_text(self.api[0].canon(value) + '\n')
        with self.assertRaisesRegex(OwnerRefused, 'MW_SCHEMA_PIN'):
            self.reopen()

    def test_notice_minted_at_launch_needs_zero_minimum(self):
        # The run backend mints the notice at launch; a positive minimum refuses it.
        for minimum, accepted in ((0, True), (10, False)):
            with self.subTest(min_notice_s=minimum):
                self.owner.corpus.site['execution_policy']['min_notice_s'] = minimum
                self.owner.notice['mono_ns'] = time.monotonic_ns()
                if accepted:
                    self.owner.check_notice()
                else:
                    with self.assertRaisesRegex(OwnerRefused, 'MW_NOTICE'):
                        self.owner.check_notice()

    @staticmethod
    def add_completion_step(workflow, site, busy=False):
        base.text_workflow(workflow)
        done = copy.deepcopy(workflow['oracle']['postconditions'][0])
        done['bindings'][0]['value'] = 'ANSWER_DONE'
        # Step 4 mirrors the Gemini ask: re-click the composer, then poll for completion.
        wait = copy.deepcopy(workflow['steps'][0])
        wait['seq'] = 4
        wait['verify'].update(predicate=done, consecutive_polls=2, poll_interval_ms=2000,
                              deadline_ms=600000)
        if busy:
            wait['verify']['busy_predicate'] = copy.deepcopy(done)
        workflow['steps'].append(wait)
        workflow['oracle']['postconditions'].append(done)

    def supported(self, prompt='one line prompt', busy=False):
        self.rewrite(lambda w, s: self.add_completion_step(w, s, busy))
        self.owner.slots.values = {'prompt': prompt}
        return self.owner.supports(self.corpus.workflow).result is self.owner.Truth.TRUE

    def test_polled_completion_step_is_supported(self):
        self.assertTrue(self.supported())
        self.assertEqual([s['seq'] for s in self.corpus.workflow['steps']], [1, 2, 3, 4])

    def test_mut_busy_predicate_completion_is_not_supported(self):
        # Negative control: busy logic is forbidden, so completion must be a polled step.
        self.assertFalse(self.supported(busy=True))

    def test_multiline_prompt_is_refused_before_any_action(self):
        self.assertFalse(self.supported(prompt='line one\nline two'))
        self.assertEqual(self.owner.text_refusal, 'MW_TEXT_UNPRINTABLE: prompt')


if __name__ == '__main__':
    unittest.main()
