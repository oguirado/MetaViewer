#!/usr/bin/env python3
"""Check repository commit and version laws using only the standard library."""
import argparse
import os
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

# [TARGET, unit decision] Enforce per-unit changelog fragments on product-code
# commits. Flip ALLOW_DIRECT_CHANGELOG to False (or set MV_CHANGELOG_ALLOW_DIRECT=0)
# once in-flight units have landed to refuse direct CHANGELOG.md edits on code commits.
ENFORCE_CHANGELOG_FRAGMENTS = True
ALLOW_DIRECT_CHANGELOG = True
CHANGELOG_ENFORCEMENT_BASE = '455c6a71c3f82a58b72be630aff8e96c6a9ebc9d'
MAX_FRAGMENT_LINE_LENGTH = 1000
FRAGMENT_PATH_RE = re.compile(r'^changes/unreleased/[a-z0-9][a-z0-9-]*\.md$')
NON_PRODUCT_PREFIXES = ('docs/', 'changes/', 'catalogue/', 'router/index/',
                        'tests/', '.github/', '.githooks/')
NON_PRODUCT_FILES = {'CHANGELOG.md', 'README.md', 'LAWS.md', 'AGENTS.md',
                     'llms.txt', 'META_AI_USAGE.md', 'LICENSE', 'VERSION',
                     '.gitignore', '.gitleaks.toml'}


def is_product_code_path(path):
    normalized = path.strip().lstrip('./')
    if not normalized or normalized in NON_PRODUCT_FILES:
        return False
    return not normalized.startswith(NON_PRODUCT_PREFIXES)


def validate_fragment_bytes(name, data, max_line_length=MAX_FRAGMENT_LINE_LENGTH):
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*\.md', name):
        return [f'{name}: fragment file name must match lowercase [a-z0-9-]+.md']
    try:
        text = data.decode('utf-8', errors='strict')
    except UnicodeDecodeError:
        return [f'{name}: fragment is not valid UTF-8']
    if not text.strip():
        return [f'{name}: fragment is empty']
    errors = []
    bullets = 0
    for lineno, line in enumerate(text.splitlines(), 1):
        if not line:
            continue
        if not line.startswith('- ') or len(line.strip()) <= 2:
            errors.append(f'{name}:{lineno}: line must be a "- " bullet entry')
        else:
            bullets += 1
        if len(line) > max_line_length:
            errors.append(f'{name}:{lineno}: line exceeds maximum length of {max_line_length} characters')
        lower = line.lower()
        for word in FORBIDDEN:
            if word in lower:
                errors.append(f'{name}:{lineno}: forbidden message pattern: {word}')
    if bullets == 0 and not errors:
        errors.append(f'{name}: fragment contains no "- " bullet lines')
    return errors


def check_fragments_dir(unreleased_dir):
    if not unreleased_dir.is_dir():
        return []
    errors = []
    for entry in sorted(unreleased_dir.iterdir(), key=lambda p: p.name):
        if entry.name == '.gitkeep':
            continue
        if not entry.is_file() or entry.is_symlink():
            errors.append(f'{entry.name}: fragment must be a regular file')
            continue
        errors.extend(validate_fragment_bytes(entry.name, entry.read_bytes()))
    return errors


def _effective_allow_direct(allow_direct=None):
    if allow_direct is not None:
        return bool(allow_direct)
    env_override = os.environ.get('MV_CHANGELOG_ALLOW_DIRECT')
    if env_override is not None:
        return env_override.strip() not in ('0', 'false', 'False', 'no')
    return ALLOW_DIRECT_CHANGELOG


def check_changelog_changes(changes, allow_direct=None, enforce=None, fragment_blobs=None):
    if (ENFORCE_CHANGELOG_FRAGMENTS if enforce is None else enforce) is False:
        return []
    allow_direct = _effective_allow_direct(allow_direct)
    entries = []
    for item in changes:
        if isinstance(item, tuple) and len(item) == 2:
            status, path = item[0], item[1].strip().lstrip('./')
        else:
            status, path = 'M', str(item).strip().lstrip('./')
        if path:
            entries.append((status, path))

    errors = []
    active_fragments = []
    for status, path in entries:
        if status == 'D':
            continue
        if path.startswith('changes/unreleased/') and path != 'changes/unreleased/.gitkeep':
            if not FRAGMENT_PATH_RE.fullmatch(path):
                errors.append(f'{path}: fragment path must match changes/unreleased/<slug>.md with lowercase [a-z0-9-]')
            else:
                active_fragments.append(path)
                if fragment_blobs is not None and path in fragment_blobs:
                    errors.extend(validate_fragment_bytes(Path(path).name, fragment_blobs[path]))

    has_product = any(is_product_code_path(path) for _, path in entries)
    if not has_product:
        return errors

    if active_fragments:
        return errors

    has_direct_changelog = any(status != 'D' and path == 'CHANGELOG.md' for status, path in entries)
    if allow_direct and has_direct_changelog:
        return errors

    suffix = ' (or CHANGELOG.md during transition)' if allow_direct else ''
    errors.append(
        'product code change requires a changelog fragment in changes/unreleased/<slug>.md' + suffix
    )
    return errors


def check_commit_changelog(rev='HEAD', root=ROOT, allow_direct=None, enforce=None):
    if (ENFORCE_CHANGELOG_FRAGMENTS if enforce is None else enforce) is False:
        return []
    out = subprocess.check_output(
        ['git', 'diff-tree', '--root', '--no-commit-id', '--name-status', '-r', rev],
        cwd=root, text=True, stderr=subprocess.PIPE,
    )
    changes = []
    fragment_blobs = {}
    for line in out.splitlines():
        if not line.strip():
            continue
        parts = line.split('\t')
        status = parts[0][0] if parts[0] else 'M'
        path = parts[-1]
        changes.append((status, path))
        if status != 'D' and FRAGMENT_PATH_RE.fullmatch(path):
            try:
                fragment_blobs[path] = subprocess.check_output(
                    ['git', 'show', f'{rev}:{path}'], cwd=root, stderr=subprocess.PIPE,
                )
            except subprocess.CalledProcessError as exc:
                return [f'{rev}: cannot read fragment {path}: {exc}']
    return [f'{rev}: {err}' for err in check_changelog_changes(
        changes, allow_direct=allow_direct, enforce=enforce, fragment_blobs=fragment_blobs)]


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
    unreleased = root / 'changes' / 'unreleased'
    if unreleased.is_dir():
        errors.extend(check_fragments_dir(unreleased))
    return errors

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True, stderr=subprocess.PIPE)


def _enforced_revisions(revisions, rev_range, root=ROOT):
    probe = subprocess.run(
        ['git', 'cat-file', '-e', CHANGELOG_ENFORCEMENT_BASE + '^{commit}'],
        cwd=root, capture_output=True,
    )
    if probe.returncode != 0:
        return revisions
    if rev_range is None:
        post_base = subprocess.run(
            ['git', 'rev-list', f'{CHANGELOG_ENFORCEMENT_BASE}..HEAD'],
            cwd=root, capture_output=True, text=True,
        )
        candidates = post_base.stdout.splitlines() if post_base.returncode == 0 else []
    else:
        ancestors = subprocess.run(
            ['git', 'rev-list', CHANGELOG_ENFORCEMENT_BASE],
            cwd=root, capture_output=True, text=True,
        )
        ancestor_set = set(ancestors.stdout.splitlines()) if ancestors.returncode == 0 else set()
        candidates = [r for r in revisions if r not in ancestor_set]
    enforced = []
    for rev in candidates:
        has_marker = subprocess.run(
            ['git', 'cat-file', '-e', f'{rev}:changes/README.md'],
            cwd=root, capture_output=True,
        )
        if has_marker.returncode == 0:
            enforced.append(rev)
    return enforced


def check_history(rev_range=None, root=ROOT, allow_direct=None, enforce=None):
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
    if revisions and all(re.fullmatch(r'[0-9a-f]{40}', r) for r in revisions):
        for rev in _enforced_revisions(revisions, rev_range, root=root):
            errors.extend(check_commit_changelog(
                rev, root=root, allow_direct=allow_direct, enforce=enforce))
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
