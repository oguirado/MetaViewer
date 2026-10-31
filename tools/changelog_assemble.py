#!/usr/bin/env python3
"""Assemble changes/unreleased/<slug>.md fragments into CHANGELOG.md."""
# [TARGET, unit decision] Enforce UTF-8 "- " bullet lines up to 1000 characters
# (longest existing CHANGELOG.md bullet is 621 characters [MEASURED]), assemble
# sorted by fragment file name after existing top-level ## [Unreleased] bullets,
# and delete consumed fragments idempotently.
import argparse
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
SLUG_RE = re.compile(r'^[a-z0-9][a-z0-9-]*\.md$')
UNRELEASED_RE = re.compile(r'^## \[Unreleased\][ \t]*$')
MAX_LINE_LENGTH = 1000
FORBIDDEN = ('co-authored-by', 'generated with', 'claude', 'anthropic', 'chatgpt',
             'openai', 'gpt-', 'gemini', 'codex', 'copilot', 'muse spark', 'llama',
             'assistant', 'ai-generated')


def validate_fragment_bytes(name, data, max_line_length=MAX_LINE_LENGTH):
    if not SLUG_RE.fullmatch(name):
        return [], [f'{name}: fragment file name must match lowercase [a-z0-9-]+.md']
    try:
        text = data.decode('utf-8', errors='strict')
    except UnicodeDecodeError:
        return [], [f'{name}: fragment is not valid UTF-8']
    if not text.strip():
        return [], [f'{name}: fragment is empty']
    bullets = []
    errors = []
    for lineno, line in enumerate(text.splitlines(), 1):
        if not line:
            continue
        if not line.startswith('- ') or len(line.strip()) <= 2:
            errors.append(f'{name}:{lineno}: line must be a "- " bullet entry')
        else:
            bullets.append(line)
        if len(line) > max_line_length:
            errors.append(f'{name}:{lineno}: line exceeds maximum length of {max_line_length} characters')
        lower = line.lower()
        for word in FORBIDDEN:
            if word in lower:
                errors.append(f'{name}:{lineno}: forbidden pattern: {word}')
    if not bullets and not errors:
        errors.append(f'{name}: fragment contains no "- " bullet lines')
    return bullets, errors


def collect_fragments(unreleased_dir, max_line_length=MAX_LINE_LENGTH, sort_key=None):
    if not unreleased_dir.exists():
        return [], []
    if not unreleased_dir.is_dir():
        return [], [f'{unreleased_dir}: expected a directory']
    key_fn = (lambda p: p.name) if sort_key is None else sort_key
    entries = sorted(unreleased_dir.iterdir(), key=key_fn)
    fragments = []
    errors = []
    for entry in entries:
        if entry.name == '.gitkeep':
            continue
        if not entry.is_file() or entry.is_symlink():
            errors.append(f'{entry.name}: fragment must be a regular file')
            continue
        try:
            data = entry.read_bytes()
        except OSError as exc:
            errors.append(f'{entry.name}: cannot read fragment: {exc}')
            continue
        bullets, frag_errors = validate_fragment_bytes(
            entry.name, data, max_line_length=max_line_length)
        if frag_errors:
            errors.extend(frag_errors)
        else:
            fragments.append((entry, bullets))
    return fragments, errors


def insert_bullets_into_changelog(changelog_text, bullets):
    lines = changelog_text.splitlines()
    unreleased_idx = next(
        (i for i, line in enumerate(lines) if UNRELEASED_RE.fullmatch(line)),
        None,
    )
    if unreleased_idx is None:
        raise ValueError('CHANGELOG.md lacks a ## [Unreleased] section')
    if not bullets:
        return changelog_text

    section_end = len(lines)
    for i in range(unreleased_idx + 1, len(lines)):
        if lines[i].startswith(('## ', '### ')):
            section_end = i
            break

    last_bullet_idx = None
    for i in range(unreleased_idx + 1, section_end):
        if lines[i].startswith('- '):
            last_bullet_idx = i

    if last_bullet_idx is not None:
        insert_at = last_bullet_idx + 1
        updated = lines[:insert_at] + list(bullets) + lines[insert_at:]
    else:
        insert_at = unreleased_idx + 1
        prefix = lines[:insert_at]
        suffix = lines[insert_at:]
        block = [''] + list(bullets)
        if suffix and suffix[0] != '':
            block.append('')
        updated = prefix + block + suffix

    return '\n'.join(updated) + '\n'


def assemble(root=ROOT, check=False, dry_run=False, delete_consumed=True, sort_key=None):
    root = Path(root)
    changelog_path = root / 'CHANGELOG.md'
    unreleased_dir = root / 'changes' / 'unreleased'

    if not changelog_path.is_file():
        return 1, '', ['CHANGELOG.md is missing']
    try:
        changelog_text = changelog_path.read_bytes().decode('utf-8', errors='strict')
    except (OSError, UnicodeDecodeError) as exc:
        return 1, '', [f'CHANGELOG.md is not readable UTF-8: {exc}']

    fragments, errors = collect_fragments(unreleased_dir, sort_key=sort_key)
    if errors:
        return 1, '', errors

    all_bullets = [bullet for _, frag_bullets in fragments for bullet in frag_bullets]
    try:
        updated_text = insert_bullets_into_changelog(changelog_text, all_bullets)
    except ValueError as exc:
        return 1, '', [str(exc)]

    if check:
        if fragments or updated_text != changelog_text:
            names = ', '.join(path.name for path, _ in fragments)
            return 1, '', [f'un-assembled changelog fragments pending ({len(fragments)}): {names}']
        return 0, changelog_text, []

    if dry_run:
        return 0, updated_text, []

    if not fragments:
        return 0, changelog_text, []

    changelog_path.write_text(updated_text, encoding='utf-8')
    if delete_consumed:
        for path, _ in fragments:
            path.unlink()
    return 0, updated_text, []


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT,
                        help='Repository root containing CHANGELOG.md and changes/unreleased')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true',
                      help='Exit non-zero if any fragment is malformed or pending assembly')
    mode.add_argument('--dry-run', action='store_true',
                      help='Print the assembled CHANGELOG.md without writing or deleting fragments')
    args = parser.parse_args(argv)
    rc, output, errors = assemble(root=args.root, check=args.check, dry_run=args.dry_run)
    for error in errors:
        print('ERROR: ' + error, file=sys.stderr)
    if args.dry_run and rc == 0:
        sys.stdout.write(output)
    return rc


if __name__ == '__main__':
    sys.exit(main())
