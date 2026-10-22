#!/usr/bin/env python3
"""Check repository commit and version laws using only the standard library."""
import argparse
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
NAME = 'oguirado'
EMAIL = '247666607+oguirado@users.noreply.github.com'
FORBIDDEN = ('co-authored-by', 'generated with', 'claude', 'anthropic', 'chatgpt',
             'openai', 'gpt-', 'gemini', 'codex', 'copilot', 'muse spark', 'llama',
             'assistant', 'ai-generated')
SCOPES = r'(?:core|contracts|ui|ci|docs|deps|tools)'
# Deliberately bounded vocabulary: the hook cannot prove arbitrary English grammar.
VERBS = {'add', 'allow', 'apply', 'audit', 'bump', 'change', 'check', 'clean',
         'configure', 'create', 'define', 'document', 'enforce', 'fix', 'implement',
         'improve', 'initialize', 'keep', 'move', 'pin', 'prepare', 'prevent',
         'refactor', 'release', 'remove', 'rename', 'replace', 'require', 'restore',
         'revert', 'run', 'seal', 'set', 'simplify', 'support', 'test', 'update',
         'use', 'validate', 'wire'}
SEMVER = re.compile(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?', re.ASCII)

def check_message(message):
    errors = [f'forbidden message pattern: {word}' for word in FORBIDDEN if word in message.lower()]
    subject = message.splitlines()[0] if message.splitlines() else ''
    if len(subject) > 72:
        errors.append('subject exceeds 72 characters')
    match = re.fullmatch(SCOPES + r': ([A-Za-z]+)(?: [^\r\n]+)?', subject)
    if not match:
        errors.append('subject must use an allowed scope followed by ": " and an English imperative')
    elif match.group(1).lower() not in VERBS:
        errors.append('subject must start with a supported English imperative verb (see VERBS)')
    return errors

def check_identity(author_name, author_email, committer_name, committer_email):
    return [f'{role} must be {NAME} <{EMAIL}>' for role, name, email in
            [('author', author_name, author_email), ('committer', committer_name, committer_email)]
            if (name, email) != (NAME, EMAIL)]

def check_ident(ident):
    match = re.fullmatch(r'(.+) <([^<>]+)> \d+ [+-]\d{4}', ident.strip())
    return bool(match and match.groups() == (NAME, EMAIL))

def check_version(root=ROOT):
    version = (root / 'VERSION').read_text().strip()
    errors = []
    if not SEMVER.fullmatch(version):
        errors.append('VERSION must be valid semantic versioning')
    if not re.search(r'^## ' + re.escape(version) + r'(?:\s|$)', (root / 'CHANGELOG.md').read_text(), re.M):
        errors.append(f'CHANGELOG.md lacks a matching ## {version} section')
    return errors

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True, stderr=subprocess.PIPE)

def check_history(rev_range=None):
    if rev_range is None:
        # A new repository has no commits; an invalid explicit range must still fail.
        if not git('rev-list', '--all').strip():
            return []
        revisions = git('rev-list', '--all').splitlines()
    else:
        revisions = git('rev-list', rev_range).splitlines()
    errors = []
    for rev in revisions:
        fields = git('show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', rev).split('\0', 4)
        errors.extend(f'{rev}: {error}' for error in check_identity(*fields[:4]) + check_message(fields[4]))
    return errors

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--range', dest='rev_range')
    group.add_argument('--message-file', type=Path)
    group.add_argument('--version', action='store_true')
    group.add_argument('--check-ident', help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        if args.check_ident is not None:
            errors = [] if check_ident(args.check_ident) else ['identity must be oguirado <' + EMAIL + '>']
        elif args.message_file:
            errors = check_message(args.message_file.read_text())
        elif args.version:
            errors = check_version()
        else:
            errors = check_history(args.rev_range)
    except (OSError, UnicodeError, subprocess.CalledProcessError) as exc:
        errors = [f'cannot complete laws check: {exc}']
    for error in errors:
        print('ERROR: ' + error, file=sys.stderr)
    if not errors:
        print('Laws check: OK')
    return bool(errors)

if __name__ == '__main__':
    sys.exit(main())
