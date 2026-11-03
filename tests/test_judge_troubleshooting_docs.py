"""Keep judge troubleshooting identifiers tied to their cited production sources."""

import ast
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
DOC = ROOT / 'docs/JUDGE_TROUBLESHOOTING.md'
ROW = re.compile(
    r'^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \| \[code\]\(\.\./([^()]+)\) \|$',
    re.M,
)


def permitted_source(path):
    return (
        path == 'agents/metaviewer_agents/mw_refusals.py'
        or path in ('tools/mw_run_program.py', 'tools/mw_run_browser_goal.py')
        or (path.startswith('scripts/judge/') and path.endswith('.sh'))
        or (path.startswith('daemon-adapter/') and path.endswith('.go')
            and not path.endswith('_test.go'))
        or (path.startswith('ui/electron/') and path.endswith('.js')
            and 'test' not in path)
    ) and '..' not in Path(path).parts


def source_has_identifier(source, identifier):
    # Whole string literals or unquoted JS object keys, never substrings such
    # as MW_PROGRAM_GOAL inside MW_PROGRAM_GOAL_UNGROUNDED.
    literal = re.escape(identifier)
    return bool(re.search(r"(['\"])" + literal + r'\1', source)
                or re.search(r'^\s*' + literal + r'\s*:', source, re.M)
                # Shell fail/refuse/warn calls pass their code as a bare word.
                or re.search(r'\b(?:fail|refuse|warn|say)\s+' + literal
                             + r'(?=\s|$)', source)
                or re.search(r'''\b(?:printf|note)\s+['"][^'"\n]*\b'''
                             + literal + r'(?=[:)\s])', source))


def validate_rows(markdown, sources):
    errors = []
    for code, meaning, remedy, path in ROW.findall(markdown):
        if not permitted_source(path):
            errors.append(f'{code}: non-production source {path}')
        elif path not in sources or not source_has_identifier(sources[path], code):
            errors.append(f'{code}: absent from {path}')
        if not meaning.strip() or not remedy.strip():
            errors.append(f'{code}: missing diagnosis or next step')
    return errors


class JudgeTroubleshootingDocsTests(unittest.TestCase):
    def setUp(self):
        self.markdown = DOC.read_text(encoding='utf-8')
        self.rows = ROW.findall(self.markdown)
        self.sources = {
            path: (ROOT / path).read_text(encoding='utf-8')
            for _, _, _, path in self.rows if permitted_source(path)
        }

    def test_every_listed_identifier_exists_in_its_cited_source(self):
        table_lines = [line for line in self.markdown.splitlines()
                       if line.startswith('| `')]
        self.assertTrue(table_lines, 'troubleshooting contains no refusal rows')
        self.assertEqual(len(table_lines), len(self.rows), 'unvalidated table row')
        self.assertEqual(validate_rows(self.markdown, self.sources), [])

    def test_shipped_runner_and_judge_refusals_are_covered(self):
        path = ROOT / 'agents/metaviewer_agents/mw_refusals.py'
        module = ast.parse(path.read_text(encoding='utf-8'))
        refusals = next(ast.literal_eval(node.value) for node in module.body
                        if isinstance(node, ast.Assign)
                        and any(isinstance(target, ast.Name) and target.id == 'REFUSALS'
                                for target in node.targets))
        documented = {code for code, _, _, _ in self.rows}
        self.assertFalse(set(refusals) - documented)
        for script in (ROOT / 'scripts/judge').glob('*.sh'):
            source = script.read_text(encoding='utf-8')
            emitted = set(re.findall(r'\b(?:fail|refuse|warn)\s+(JUDGE_[A-Z_]+)', source))
            emitted.update(re.findall(r"printf ['\"](JUDGE_[A-Z_]+):", source))
            self.assertFalse(emitted - documented, f'undocumented refusals in {script.name}')

    def test_stale_code_is_rejected_even_if_another_code_has_its_prefix(self):
        markdown = '| `MW_PROGRAM_GOAL` | Goal invalid. | Inspect. | [code](../agents/metaviewer_agents/mw_refusals.py) |'
        source = {'agents/metaviewer_agents/mw_refusals.py': "'MW_PROGRAM_GOAL_UNGROUNDED': 'detail'"}
        self.assertTrue(validate_rows(markdown, source))

    def test_removing_a_listed_source_identifier_fails_the_check(self):
        code, _, _, path = self.rows[0]
        changed = dict(self.sources)
        changed[path] = changed[path].replace(code, 'REMOVED_REFUSAL')
        self.assertTrue(any(error.startswith(code + ': absent')
                            for error in validate_rows(self.markdown, changed)))

    def test_each_area_has_a_table_and_entry_points_link_here(self):
        for area in ('Kit install and run', 'Capsules', 'Browser goals',
                     'Program goals', 'Walls', 'Stop'):
            section = self.markdown.split('## ' + area + '\n', 1)[1].split('\n## ', 1)[0]
            self.assertTrue(ROW.search(section), area)
            lines = section.splitlines()
            table = [index for index, line in enumerate(lines) if line.startswith('|')]
            self.assertEqual(table, list(range(table[0], table[-1] + 1)),
                             f'{area}: table interrupted by prose or blank lines')
        for name, target in (
            ('README.md', 'docs/JUDGE_TROUBLESHOOTING.md'),
            ('docs/JUDGE_QUICKSTART.md', 'JUDGE_TROUBLESHOOTING.md'),
            ('docs/JUDGE_TOUR.md', 'JUDGE_TROUBLESHOOTING.md'),
        ):
            self.assertIn(f']({target})', (ROOT / name).read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
