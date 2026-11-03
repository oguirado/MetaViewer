"""Parse tour examples through shipped parsers without connecting to a runtime."""

from contextlib import redirect_stderr
import io
from pathlib import Path
import re
import shlex
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'agents'))
from metaviewer_agents import mw_run


JUDGE_SCRIPT = ROOT / 'scripts/judge/metaviewer-judge.sh'
# Run the actual option/subcommand parser only, before environment or host work.
JUDGE_PARSER, PARSER_BOUNDARY, _ = JUDGE_SCRIPT.read_text(encoding='utf-8').partition(
    '# ---------------------------------------------------------------- environment'
)
if not PARSER_BOUNDARY:
    raise RuntimeError('Judge parser boundary missing; refuse host execution')


def blocks(markdown):
    return re.findall(r'^```(?:bash|sh)\n(.*?)^```', markdown, re.M | re.S)


def validate_commands(markdown):
    errors = []
    seen = []
    setup = {
        ('export', 'METAVIEWER_ATTACH=<copied-current.env-path>'),
        ('set', '-a'), ('.', '$METAVIEWER_ATTACH'), ('set', '+a'),
        ('export', 'XDG_STATE_HOME=$(mktemp -d /dev/shm/metaviewer-tour.XXXXXX)'),
    }
    for block in blocks(markdown):
        syntax = subprocess.run(['bash', '-n'], input=block, text=True,
                                capture_output=True, cwd=ROOT)
        if syntax.returncode:
            errors.append(syntax.stderr)
            continue
        for line in block.replace('\\\n', ' ').splitlines():
            tokens = shlex.split(line)
            if not tokens or line.lstrip().startswith('#'):
                continue
            if tuple(tokens) in setup:
                seen.append('setup')
            elif tokens[:2] == ['bash', 'scripts/judge/metaviewer-judge.sh']:
                # Nothing after the parser is sourced or executed.
                result = subprocess.run(['bash', '-c', JUDGE_PARSER, 'tour-parser', *tokens[2:]],
                                        capture_output=True, text=True, cwd=ROOT)
                if result.returncode:
                    errors.append(result.stderr)
                seen.append('judge')
            elif tokens[:4] == ['PYTHONPATH=agents', 'python3', '-m', 'metaviewer_agents.mw_run']:
                calls = []
                try:
                    # Invoke main as well as argparse: main enforces budgets and
                    # incompatible options. The runner is a data-only recorder.
                    with patch.dict('os.environ', {}, clear=True), redirect_stderr(io.StringIO()):
                        mw_run.main(tokens[4:], runner=lambda args: calls.append(args))
                except SystemExit as error:
                    errors.append(f'automation parser rc={error.code}: {line}')
                if not calls:
                    errors.append(f'command did not reach stub runner: {line}')
                seen.append('automation')
            else:
                errors.append(f'unchecked command: {line}')
    return errors, seen


class JudgeTourDocsTests(unittest.TestCase):
    def setUp(self):
        self.markdown = (ROOT / 'docs/JUDGE_TOUR.md').read_text(encoding='utf-8')

    def test_tour_commands_parse_without_live_execution(self):
        errors, seen = validate_commands(self.markdown)
        self.assertEqual(errors, [], '\n'.join(errors))
        self.assertEqual(seen.count('judge'), 3)
        self.assertEqual(seen.count('automation'), 3)
        self.assertEqual(seen.count('setup'), 5)

    def test_invalid_planner_is_rejected(self):
        errors, _ = validate_commands(self.markdown.replace('--planner rules', '--planner invalid'))
        self.assertTrue(any('automation parser rc=2' in error for error in errors), errors)

    def test_program_key_is_rejected_by_semantic_parser(self):
        errors, _ = validate_commands(self.markdown.replace("--goal focused --text", "--key Enter --goal focused --text"))
        self.assertTrue(any('automation parser rc=2' in error for error in errors), errors)

    def test_invalid_judge_option_is_rejected(self):
        errors, _ = validate_commands(self.markdown.replace('doctor --capsules', 'doctor --invented'))
        self.assertTrue(any('JUDGE_USAGE' in error for error in errors), errors)

    def test_unknown_command_is_not_silently_ignored(self):
        errors, _ = validate_commands(self.markdown + '\n```bash\ninvented-tool run\n```\n')
        self.assertTrue(any('unchecked command' in error for error in errors), errors)

    def test_links_and_current_pending_status(self):
        for name, link in (
            ('README.md', '(docs/JUDGE_TOUR.md)'),
            ('docs/README.md', '(JUDGE_TOUR.md)'),
            ('docs/JUDGE_QUICKSTART.md', '(JUDGE_TOUR.md)'),
        ):
            with self.subTest(name=name):
                self.assertIn(link, (ROOT / name).read_text(encoding='utf-8'))
        self.assertIn('**x64 browser automation: PENDING verification.**', self.markdown)
        self.assertNotRegex(self.markdown, r'/home/|/Users/|/usr/local/go|~/\.cargo')


if __name__ == '__main__':
    unittest.main()
