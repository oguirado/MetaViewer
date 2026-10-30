"""Copyable prompt drift checks, hosted only."""
import importlib.util
from pathlib import Path
import re
import shlex
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'agents'))
from metaviewer_agents.mw_run import build_parser


SAFETY_LIMITS = (
    'Run live workflows only with the operator present.',
    'Never solve a CAPTCHA or evade bot detection.',
    'Never type credentials.',
    'Stop on any refusal.',
    'Never retry a send.',
    'Never change the network mode.',
)


def check_prompt(text):
    blocks = re.findall(r'```text\n(.*?)```', text, re.S)
    if len(blocks) != 1:
        raise AssertionError('one prompt block required')
    for sentence in SAFETY_LIMITS:
        if sentence not in blocks[0]:
            raise AssertionError('missing safety limit: ' + sentence)
    commands = [shlex.split(line) for line in blocks[0].splitlines() if line.startswith('python3 ')]
    if not commands:
        raise AssertionError('prompt command absent')
    for argv in commands:
        if argv[1:3] != ['-m', 'metaviewer_agents.mw_run']:
            raise AssertionError('unknown prompt module: ' + ' '.join(argv))
        if importlib.util.find_spec(argv[2]) is None:
            raise AssertionError(argv[2])
        parser = build_parser()
        allowed = {flag for action in parser._actions for flag in action.option_strings}
        for token in argv[3:]:
            if token.startswith('--') and token not in allowed:
                raise AssertionError('unknown prompt flag: ' + token)
        parser.parse_args(argv[3:])
    if not (ROOT / 'tools/mw_run_backend.py').is_file():
        raise AssertionError('host backend absent')


class PromptTests(unittest.TestCase):
    def test_prompt_current_and_mut_prompt_stale(self):
        text = (ROOT / 'docs/AGENT_ENTRY.md').read_text()
        check_prompt(text)
        for old in ('--identity', '--site', '--workflow', '--slot'):
            with self.assertRaisesRegex(AssertionError, '--no-such-flag'):
                check_prompt(text.replace(old, '--no-such-flag', 1))
        with self.assertRaisesRegex(AssertionError, 'module'):
            check_prompt(text.replace('metaviewer_agents.mw_run', 'metaviewer_agents.absent', 1))

    def test_mut_prompt_safety_limit_removed(self):
        text = (ROOT / 'docs/AGENT_ENTRY.md').read_text()
        for sentence in SAFETY_LIMITS:
            with self.subTest(sentence=sentence):
                with self.assertRaisesRegex(AssertionError, re.escape(sentence)):
                    check_prompt(text.replace(sentence, '', 1))


if __name__ == '__main__':
    unittest.main()
