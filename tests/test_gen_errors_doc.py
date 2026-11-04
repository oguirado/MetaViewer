"""Coverage gate for docs/ERRORS.md (tools/gen_errors_doc.py).

[TARGET, unit decision] Every refusal or error code that the generator finds
in source must have a source-coordinate lookup row in docs/ERRORS.md. Negative controls
run on a scratch tree: removing a row, or adding a code to source without
regenerating, must both be reported, and --check must exit 1.
"""
import importlib.util
import io
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location('gen_errors_doc', ROOT / 'tools' / 'gen_errors_doc.py')
gen = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gen)

REFUSALS_SRC = "REFUSALS = {\n    'MW_ALPHA': 'Alpha remedy.',\n    'MW_BETA': 'Beta remedy.',\n}\n"
JUDGE_SRC = 'fail JUDGE_FIXTURE "fixture problem" "fixture fix"\n'


def scratch_tree(base, refusals=REFUSALS_SRC):
    agents = base / 'agents' / 'metaviewer_agents'
    agents.mkdir(parents=True, exist_ok=True)
    (agents / 'mw_refusals.py').write_text(refusals)
    judge = base / 'scripts' / 'judge'
    judge.mkdir(parents=True, exist_ok=True)
    (judge / 'fixture.sh').write_text(JUDGE_SRC)
    (base / 'docs').mkdir(exist_ok=True)
    return base


def run_check(root):
    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()) as err:
        rc = gen.main(['--check', '--root', str(root)])
    return rc, err.getvalue()


class LiveTree(unittest.TestCase):
    def test_every_code_in_source_has_a_row(self):
        doc = (ROOT / 'docs' / 'ERRORS.md').read_text(encoding='utf-8')
        self.assertEqual(gen.missing_sections(doc, ROOT), [],
                         'run: python3 tools/gen_errors_doc.py --write')

    def test_named_codes_are_discovered(self):
        codes = gen.discover(ROOT)
        for code in ('STALE_FRAME', 'POLICY', 'JOURNAL_FULL', 'INPUT_UNCERTAIN',
                     'MW_PROGRAM_RAM_REQUIRED', 'ADAPTER_PROFILE', 'CAPSULE_SLOT_UNAVAILABLE',
                     'JUDGE_NODE', 'Invalid', 'Corrupt', 'Witness', 'UPGRADE-REQUIRED'):
            self.assertIn(code, codes)

    def test_test_files_are_not_scanned(self):
        for entry in gen.discover(ROOT).values():
            for path, _ in entry['sites']:
                self.assertIsNone(gen.TEST_PATH.search(path), path)

    def test_compact_reviewed_document_preserves_lookup_anchors(self):
        doc = gen.render(ROOT)
        self.assertLess(len(doc.splitlines()), 2500)  # [TARGET] operator limit
        self.assertGreaterEqual(len(set(gen.NOTES) & set(gen.discover(ROOT))), 60)  # [TARGET]
        self.assertEqual(doc.count('ABSENT — do not invent'), 1)
        self.assertIn('<a id="input_uncertain"></a>`INPUT_UNCERTAIN`', doc)
        self.assertIn('### Review INPUT_UNCERTAIN', doc)
        for note in gen.NOTES.values():
            for field in ('meaning', 'causes', 'sees', 'fix', 'verify'):
                self.assertTrue(note[field].strip())
                self.assertNotIn('ABSENT', note[field])

    def test_diagnostics_do_not_claim_uncertain_input_was_undelivered(self):
        doc = gen.render(ROOT)
        self.assertIn('input may already have arrived', doc)
        self.assertIn('never verify by blindly replaying', doc)
        self.assertIn('ARM mode alone does not prove this cause', doc)


class ScratchTree(unittest.TestCase):
    def test_complete_doc_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = scratch_tree(Path(tmp))
            (root / gen.DOC).write_text(gen.render(root))
            self.assertEqual(run_check(root)[0], 0)
            self.assertEqual(gen.render(root), gen.render(root))

    def test_negative_control_removed_row_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = scratch_tree(Path(tmp))
            doc = gen.render(root)
            row = next(line for line in doc.splitlines() if line.startswith('| <a id="mw_beta"'))
            self.assertIn('`agents/metaviewer_agents/mw_refusals.py:3`', row)
            cut = doc.replace(row + '\n', '')
            # A heading or mention is not a substitute for a source lookup row.
            cut += '\n### MW_BETA\n'

            self.assertEqual(gen.missing_sections(cut, root), ['MW_BETA'])
            (root / gen.DOC).write_text(cut)
            rc, err = run_check(root)
            self.assertEqual(rc, 1)
            self.assertIn('ERRORS_DOC_MISSING MW_BETA', err)

    def test_negative_control_new_source_code_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = scratch_tree(Path(tmp))
            old = gen.render(root)
            scratch_tree(root, REFUSALS_SRC.replace('}\n', "    'MW_GAMMA': 'Gamma remedy.',\n}\n"))
            self.assertEqual(gen.missing_sections(old, root), ['MW_GAMMA'])
            (root / gen.DOC).write_text(old)
            rc, err = run_check(root)
            self.assertEqual(rc, 1)
            self.assertIn('ERRORS_DOC_MISSING MW_GAMMA', err)

    def test_negative_control_stale_doc_fails_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = scratch_tree(Path(tmp))
            (root / gen.DOC).write_text(gen.render(root) + 'hand edit\n')
            rc, err = run_check(root)
            self.assertEqual(rc, 1)
            self.assertIn('ERRORS_DOC_STALE', err)

    def test_judge_fail_text_is_quoted(self):
        with tempfile.TemporaryDirectory() as tmp:
            doc = gen.render(scratch_tree(Path(tmp)))
            self.assertIn('<a id="judge_fixture"></a>`JUDGE_FIXTURE`', doc)
            self.assertIn('`fixture problem`', doc)
            self.assertIn('`fixture fix`', doc)


if __name__ == '__main__':
    unittest.main()
