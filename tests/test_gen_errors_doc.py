"""Coverage gate for docs/ERRORS.md (tools/gen_errors_doc.py).

[TARGET, unit decision] Every refusal or error code that the generator finds
in source must have a `### CODE` section in docs/ERRORS.md. Negative controls
run on a scratch tree: removing a section, or adding a code to source without
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
    def test_every_code_in_source_has_a_section(self):
        doc = (ROOT / 'docs' / 'ERRORS.md').read_text(encoding='utf-8')
        self.assertEqual(gen.missing_sections(doc, ROOT), [],
                         'run: python3 tools/gen_errors_doc.py --write')

    def test_named_codes_are_discovered(self):
        codes = gen.discover(ROOT)
        for code in ('STALE_FRAME', 'POLICY', 'JOURNAL_FULL', 'INPUT_UNCERTAIN',
                     'MW_PROGRAM_RAM_REQUIRED', 'ADAPTER_PROFILE', 'CAPSULE_SLOT_UNAVAILABLE',
                     'JUDGE_NODE'):
            self.assertIn(code, codes)

    def test_test_files_are_not_scanned(self):
        for entry in gen.discover(ROOT).values():
            for path, _ in entry['sites']:
                self.assertIsNone(gen.TEST_PATH.search(path), path)


class ScratchTree(unittest.TestCase):
    def test_complete_doc_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = scratch_tree(Path(tmp))
            (root / gen.DOC).write_text(gen.render(root))
            self.assertEqual(run_check(root)[0], 0)
            self.assertEqual(gen.render(root), gen.render(root))

    def test_negative_control_removed_section_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = scratch_tree(Path(tmp))
            doc = gen.render(root)
            self.assertIn('### MW_BETA\n', doc)
            cut = doc.replace('### MW_BETA\n', '#### not a section\n')
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
            self.assertIn('### JUDGE_FIXTURE\n', doc)
            self.assertIn('`fixture problem`', doc)
            self.assertIn('`fixture fix`', doc)


if __name__ == '__main__':
    unittest.main()
