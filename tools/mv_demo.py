#!/usr/bin/env python3
"""Operator demonstration custody and offline MemoryWeb validation.

[TARGET, unit decision] MV_MEMORYWEB_REPO selects the read-only authoring
checkout. Build then check a disposable copy, as in the conductor's draft gate.
Only existing active identity leases are recorded; login/start remains operator
work. Recording export rejects unknown files and character-bearing event fields.

[TARGET, unit decision] DEMO-FLOW hardening, each point verified against the
OpenSuperficies recorder source (read only, surface/record.go):
- keysym names are the raw X names, so Page Up/Down arrive as Prior/Next and the
  numeric keypad arrives as KP_* navigation names. Prior/Next and other
  non-printable keys are admitted; KP_* digit/navigation names stay refused
  because the recorder reads level 0, so keypad digits would leak as KP_End etc.
- final frames are final.png or, for multi-window capsules, final_w<N>.png.
- the after frame is named in advance and written 600 ms later; a failed capture
  leaves a dangling name, so a reference to an absent frame is dropped instead of
  discarding the whole demonstration.
- the RAM copy is removed once the private export is sealed and digested.
- a site written by an AI is untrusted data: check copies it without following
  links, refuses special files and bounds the tree.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
sys.path.insert(0, str(ROOT / 'tests/e2e/e2e1_slice'))
import mv_identity as identity
import mw_home_check as home_check
from live import refuse_net_argv, ForbiddenVerb

Refused = identity.Refused
RAM = Path('/dev/shm/vqa-ramws/opensuperficies/os-cu-0/demos')
DEMO = re.compile(r'[a-z0-9][a-z0-9-]{0,39}\Z')
SITE = re.compile(r'[a-z0-9][a-z0-9-]{0,63}\Z')
KEYS = {'Return', 'Tab', 'Escape', 'BackSpace', 'Delete', 'Left', 'Right',
        'Up', 'Down', 'Home', 'End', 'Page_Up', 'Page_Down', 'Insert',
        'Prior', 'Next', 'Begin', 'KP_Enter', 'ISO_Left_Tab', 'Print', 'Pause',
        'Break', 'Menu', 'Linefeed', 'Clear', 'Find', 'Help', 'Cancel', 'Select',
        'Execute', 'Undo', 'Redo', 'Sys_Req', 'unknown'}
# Punctuation keysyms are admitted only inside ctrl/alt/super chords, like [a-zA-Z0-9].
CHORD_KEYS = {'space', 'exclam', 'quotedbl', 'numbersign', 'dollar', 'percent', 'ampersand',
              'apostrophe', 'parenleft', 'parenright', 'asterisk', 'plus', 'comma', 'minus',
              'period', 'slash', 'colon', 'semicolon', 'less', 'equal', 'greater', 'question',
              'at', 'bracketleft', 'backslash', 'bracketright', 'asciicircum', 'underscore',
              'grave', 'braceleft', 'bar', 'braceright', 'asciitilde'}
FRAME = re.compile(r'[0-9]+_(?:before|after)\.png\Z')
FINAL = re.compile(r'final(?:_w[0-9]+)?\.png\Z')
SITE_FILES = 8192
SITE_BYTES = 128 * 1024 * 1024
SITE_DEPTH = 12
FIELDS = {'seq', 'mono_ns', 'window', 'kind', 'x', 'y', 'x2', 'y2', 'button',
          'dir', 'keysym', 'text_len', 'modifiers', 'reason', 'before', 'after'}


def need(ok, code):
    if not ok:
        raise Refused(code)


def identifier(value, pattern=DEMO):
    need(isinstance(value, str) and pattern.fullmatch(value), 'INVALID_ID')
    return value


def private_tree(path):
    path = Path(path).absolute()
    need('..' not in path.parts, 'UNSAFE_PATH')
    for part in reversed((path, *path.parents)):
        need(not part.is_symlink(), 'UNSAFE_PATH')
    return path


def evidence_root():
    base = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state'))
    need(base.is_absolute(), 'UNSAFE_PATH')
    root = private_tree(base / 'metaviewer/demos')
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.parent.mkdir(mode=0o700, exist_ok=True)
    root.mkdir(mode=0o700, exist_ok=True)
    identity.private(root.parent)
    identity.private(root)
    return root


def read_regular(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        need(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
             and info.st_size <= limit, 'UNSAFE_RECORDING')
        data = stream.read(limit + 1)
    need(len(data) <= limit, 'RECORDING_CAPACITY')
    return data


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result, 'DUPLICATE_JSON_KEY')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs)


def validate_events(raw):
    rows = raw.splitlines()
    need(0 < len(rows) <= 501, 'INVALID_RECORDING')
    previous = -1
    for seq, line in enumerate(rows, 1):
        need(len(line) <= 4096, 'RECORDING_CAPACITY')
        row = strict_json(line)
        need(isinstance(row, dict) and not set(row) - FIELDS, 'RECORDING_TEXT_LEAK')
        kind = row.get('kind')
        need(kind in {'click', 'dblclick', 'drag', 'scroll', 'key', 'text', 'stop'}, 'INVALID_RECORDING')
        need(type(row.get('seq')) is int and row['seq'] == seq
             and type(row.get('mono_ns')) is int and row['mono_ns'] >= previous, 'INVALID_RECORDING')
        previous = row['mono_ns']
        need(isinstance(row.get('window'), str) and re.fullmatch(r'w[0-9]+|', row['window']), 'INVALID_RECORDING')
        mods = row.get('modifiers')
        need(isinstance(mods, list) and all(x in ('shift', 'ctrl', 'alt', 'super') for x in mods), 'INVALID_RECORDING')
        if kind == 'text':
            need(type(row.get('text_len')) is int and 1 <= row['text_len'] <= 4096, 'RECORDING_TEXT_LEAK')
        else:
            need('text_len' not in row, 'RECORDING_TEXT_LEAK')
        key = row.get('keysym')
        if key is not None:
            chord = bool(set(mods) & {'ctrl', 'alt', 'super'})
            need(kind == 'key' and isinstance(key, str) and
                 (key in KEYS or re.fullmatch(r'F(?:[1-9]|[12][0-9]|3[0-5])', key)
                  or re.fullmatch(r'XF86[A-Za-z0-9]{1,40}', key)
                  or (chord and (re.fullmatch(r'[a-zA-Z0-9]', key) or key in CHORD_KEYS))), 'RECORDING_TEXT_LEAK')
        for field in ('before', 'after'):
            if field in row:
                need(isinstance(row[field], str) and FRAME.match(row[field]), 'INVALID_RECORDING')
        for field in ('x', 'y', 'x2', 'y2', 'button'):
            if field in row:
                need(type(row[field]) is int, 'INVALID_RECORDING')
        if 'dir' in row:
            need(row['dir'] in ('up', 'down', 'left', 'right'), 'INVALID_RECORDING')
        need((kind == 'stop') == (seq == len(rows)), 'UNSEALED_RECORDING')
        if 'reason' in row:
            need(kind == 'stop' and row['reason'] in ('operator', 'limit', 'recorder_exited'), 'INVALID_RECORDING')
    need(json.loads(rows[-1]).get('reason') in ('operator', 'limit', 'recorder_exited'), 'UNSEALED_RECORDING')


def known_name(name):
    return name in ('events.jsonl', 'README.md') or bool(FRAME.match(name) or FINAL.match(name))


def drop_missing_frames(raw, names):
    """Remove frame references whose file the recorder never wrote.

    The after frame is named before it is captured; a failed capture leaves a
    dangling name. Rows without a dangling name keep their exact bytes.
    """
    rows = []
    changed = False
    for line in raw.splitlines():
        row = strict_json(line)
        missing = [k for k in ('before', 'after') if k in row and row[k] not in names]
        if missing:
            changed = True
            for key in missing:
                del row[key]
            line = json.dumps(row, separators=(',', ':')).encode()
        rows.append(line)
    return b''.join(line + b'\n' for line in rows) if changed else raw


def export_demo(source, destination):
    private_tree(source)
    identity.private(source)
    files = {}
    total = 0
    for path in source.iterdir():
        need(known_name(path.name), 'UNSAFE_RECORDING')
        limit = 512 * 1024 if path.name == 'events.jsonl' else 32768 if path.name == 'README.md' else 32 * 1024 * 1024
        raw = read_regular(path, limit)
        total += len(raw)
        need(total <= 1024 * 1024 * 1024, 'RECORDING_CAPACITY')
        files[path.name] = raw
    need({'events.jsonl', 'README.md'} <= files.keys() and any(FINAL.match(n) for n in files), 'UNSEALED_RECORDING')
    validate_events(files['events.jsonl'])
    files['events.jsonl'] = drop_missing_frames(files['events.jsonl'], files.keys())
    validate_events(files['events.jsonl'])
    # Never copy free-form recorder README text: its bytes are not trusted prose.
    files['README.md'] = b'# Private operator demonstration\n\nData only. Events retain text_len, never typed characters. Frames may show private text.\n'
    for line in files['events.jsonl'].splitlines():
        row = strict_json(line)
        need(all(row[k] in files for k in ('before', 'after') if k in row), 'UNSEALED_RECORDING')
    destination.mkdir(mode=0o700)
    try:
        digests = {}
        for name, raw in files.items():
            with open(destination / name, 'xb') as stream:
                os.chmod(stream.name, 0o600)
                stream.write(raw)
            digests[name] = hashlib.sha256(raw).hexdigest()
        receipt = {'schema': 'metaviewer.demo/v1', 'sha256': digests}
        with open(destination / 'digests.json', 'x') as stream:
            os.chmod(stream.name, 0o600)
            json.dump(receipt, stream, sort_keys=True)
    except BaseException:
        shutil.rmtree(destination)
        raise
    return receipt


def discard_ram(path):
    """Remove the sealed RAM copy; the private export is the only record kept."""
    try:
        shutil.rmtree(private_tree(path))
    except (OSError, Refused):
        pass


def record(who, demo):
    identity.checked_id(who)
    identifier(demo)
    home = home_check.resolve_home(ROOT, os.environ.get('MV_MW_HOME'))
    tool = identity.Identities(os.environ.get('SRF_IDENTITY_STORE_ROOT'), home,
                               os.environ.get('MV_SRF_BIN_DIR'), os.environ.get('MV_SRF_STATE_DIR'))
    tool.show(who)
    lease_path = private_tree(tool.root / 'locks' / (who + '.json'))
    identity.private(lease_path, directory=False)
    lease = strict_json(read_regular(lease_path, 65536))
    need(isinstance(lease, dict), 'INVALID_LEASE')
    container = lease.get('holder')
    need(lease.get('active') is True and isinstance(container, str)
         and identity.CAPSULE.fullmatch(container), 'IDENTITY_BOUND')
    state = private_tree(identity.absolute(tool.state_dir))
    identity.private(state)
    target = evidence_root() / demo
    need(not target.exists() and not target.is_symlink(), 'DEMO_EXISTS')
    need(not (RAM / demo).exists(), 'DEMO_EXISTS')
    argv = [str(tool.bin_dir / 'srf-identity-surface'), 'view', '--container', container,
            '--login', '--record', demo, '--state-dir', str(state), '--store-root', str(tool.root)]
    refuse_net_argv(argv)
    child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        announce = strict_json(child.stdout.readline(65537))
        need(isinstance(announce, dict), 'NATIVE_VIEW_INVALID')
        url = announce.get('url', '')
        parsed = urlsplit(url)
        need(parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost', '::1')
             and not parsed.username and not parsed.password and not any(ord(x) < 32 for x in url), 'NATIVE_VIEW_INVALID')
        print(json.dumps({'url': url}), flush=True)
        try:
            rc = child.wait()
        except KeyboardInterrupt:
            child.send_signal(signal.SIGINT)
            rc = child.wait(timeout=180)
        need(rc == 0, 'RECORD_FAILED')
    finally:
        if child.poll() is None:
            child.send_signal(signal.SIGINT)
            try:
                child.wait(timeout=180)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        child.stdout.close()
    receipt = export_demo(RAM / demo, target)
    discard_ram(RAM / demo)
    return {'evidence': str(target), **receipt}


def admitted_home():
    # Reuse the complete git-ignore/tracking/profile gate, including check_home.
    from contextlib import redirect_stdout
    import io
    with redirect_stdout(io.StringIO()):
        rc = home_check.main(['--repo', str(ROOT), *(['--home', os.environ['MV_MW_HOME']] if 'MV_MW_HOME' in os.environ else [])])
    need(rc == 0, 'MW_HOME_REFUSED')
    return home_check.resolve_home(ROOT, os.environ.get('MV_MW_HOME'))


def authoring_checkout():
    checkout = os.environ.get('MV_MEMORYWEB_REPO')
    need(bool(checkout), 'MEMORYWEB_REPO_REQUIRED')
    checkout = private_tree(identity.absolute(checkout))
    for relative in ('tools/build_index.py', 'sites/README.md',
                     'standards/schemas/mw.v1.schema.json'):
        need((checkout / relative).is_file(), 'MEMORYWEB_FORMAT_MISSING')
    need((checkout / 'templates/site').is_dir(), 'MEMORYWEB_FORMAT_MISSING')
    return checkout


def prompt(demo, site):
    identifier(demo)
    identifier(site, SITE)
    home = admitted_home()
    authoring_checkout()
    evidence = private_tree(evidence_root() / demo)
    identity.private(evidence)
    receipt = strict_json(read_regular(evidence / 'digests.json', 65536))
    need(isinstance(receipt, dict), 'INVALID_DIGESTS')
    need(receipt.get('schema') == 'metaviewer.demo/v1' and isinstance(receipt.get('sha256'), dict), 'INVALID_DIGESTS')
    for name, digest in receipt['sha256'].items():
        need(known_name(name), 'INVALID_DIGESTS')
        need(hashlib.sha256(read_regular(evidence / name, 32 * 1024 * 1024)).hexdigest() == digest, 'DIGEST_MISMATCH')
    names = receipt['sha256'].keys()
    need({'events.jsonl', 'README.md'} <= names and any(FINAL.match(n) for n in names), 'INVALID_DIGESTS')
    validate_events(read_regular(evidence / 'events.jsonl', 512 * 1024))
    template = (ROOT / 'docs/AUTOMATE_FROM_DEMO.md').read_text().split('<!-- PROMPT -->\n', 1)[1].split('\n<!-- /PROMPT -->', 1)[0]
    values = {'@EVIDENCE@': str(evidence), '@SITE_DIR@': str(home / 'sites' / site),
              '@DEMO@': demo, '@VALIDATE@': 'python3 ' + shlex.quote(str(ROOT / 'tools/mv_demo.py')) + ' check --site ' + shlex.quote(site)}
    for key, value in values.items():
        need('```' not in value and '\n' not in value and '\r' not in value, 'UNSAFE_PATH')
        template = template.replace(key, value)
    return template


def copy_site(source_fd, dest, state, depth=0):
    """Copy an untrusted authored site without following links.

    Links, devices, sockets and FIFOs refuse; the tree is bounded.
    """
    need(depth <= SITE_DEPTH, 'SITE_CAPACITY')
    dest.mkdir(mode=0o700, parents=depth == 0)
    with os.scandir(source_fd) as entries:
        names = sorted(entry.name for entry in entries)
    for name in names:
        info = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
        state['files'] += 1
        need(state['files'] <= SITE_FILES, 'SITE_CAPACITY')
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=source_fd)
            try:
                copy_site(child, dest / name, state, depth + 1)
            finally:
                os.close(child)
            continue
        need(stat.S_ISREG(info.st_mode), 'UNSAFE_SITE')
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_fd)
        with os.fdopen(fd, 'rb') as stream:
            opened = os.fstat(stream.fileno())
            need(stat.S_ISREG(opened.st_mode) and state['bytes'] + opened.st_size <= SITE_BYTES, 'SITE_CAPACITY')
            data = stream.read(SITE_BYTES - state['bytes'] + 1)
        state['bytes'] += len(data)
        need(state['bytes'] <= SITE_BYTES, 'SITE_CAPACITY')
        with open(dest / name, 'xb') as out:
            out.write(data)


def check(site):
    identifier(site, SITE)
    home = admitted_home()
    from metaviewer_agents.mw_home import site_root
    root = site_root(home, site)
    origin = 'home' if Path(root) == Path(home).absolute() else 'builtin'
    source = private_tree(root / 'sites' / site)
    need(source.is_dir(), 'SITE_MISSING')
    checkout = authoring_checkout()
    with tempfile.TemporaryDirectory(prefix='mv-demo-check-') as temp:
        copy = Path(temp) / 'memoryweb'
        shutil.copytree(checkout, copy, ignore=shutil.ignore_patterns('.git', '__pycache__'))
        dest = copy / 'sites' / site
        if dest.is_symlink():
            dest.unlink()
        elif dest.exists():
            shutil.rmtree(dest)
        source_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            copy_site(source_fd, dest, {'files': 0, 'bytes': 0})
        finally:
            os.close(source_fd)
        for flags in ([], ['--check']):
            result = subprocess.run([sys.executable, '-I', str(copy / 'tools/build_index.py'), '--root', str(copy), *flags],
                                    cwd=copy, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, timeout=180, check=False)
            need(result.returncode == 0, 'MEMORYWEB_CHECK_FAILED')
    return {'site': site, 'validated': True, 'source': origin}


def main(argv=None):
    parser = identity.Parser(description=__doc__, allow_abbrev=False)
    subs = parser.add_subparsers(dest='verb', required=True)
    for verb in ('record', 'prompt', 'check'):
        sub = subs.add_parser(verb, allow_abbrev=False)
        if verb == 'record':
            sub.add_argument('--identity', required=True)
        if verb != 'check':
            sub.add_argument('--demo', required=True)
        if verb != 'record':
            sub.add_argument('--site', required=True)
    try:
        args = parser.parse_args(argv)
        if args.verb == 'prompt':
            print(prompt(args.demo, args.site))
            return 0
        result = record(args.identity, args.demo) if args.verb == 'record' else check(args.site)
        print(json.dumps({'schema': 'metaviewer.demo/v1', 'ok': True, 'result': result}))
        return 0
    except (Refused, ForbiddenVerb, OSError, ValueError, KeyError, TypeError,
            subprocess.TimeoutExpired, KeyboardInterrupt):
        # No native output, event data, filesystem exception or credential escapes.
        print(json.dumps({'schema': 'metaviewer.demo/v1', 'ok': False, 'error': 'DEMO_REFUSED'}))
        return 6


if __name__ == '__main__':
    sys.exit(main())
