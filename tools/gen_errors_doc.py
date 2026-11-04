#!/usr/bin/env python3
"""Generate docs/ERRORS.md from the refusal and error codes found in source.

Standard library only, deterministic, read-only unless --write is given.

[TARGET, unit decision] Discovery is rule based, never model based. Each family
below names the files it reads and the pattern that admits a code. Coordinates
are path:line on the scanned tree. Explanations come first from text that the
code itself carries (a remedy table, a UI message, a launcher fix string, an
adapter detail); then from the hand notes in NOTES, each written after reading
the cited code; otherwise the field reads "ABSENT - do not invent".

Usage:
  python3 tools/gen_errors_doc.py --write   # regenerate docs/ERRORS.md
  python3 tools/gen_errors_doc.py --check   # exit 1 if stale or a code lacks a section
"""
import argparse
import ast
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOC = Path('docs/ERRORS.md')
ABSENT = 'ABSENT \u2014 do not invent; read the raise site.'
SCAN_DIRS = ('core', 'daemon-adapter', 'ui', 'agents', 'tools', 'scripts/judge')
SOURCE_SUFFIXES = ('.rs', '.go', '.py', '.js', '.mjs', '.ts', '.vue', '.sh')
TEST_PATH = re.compile(
    r'(^|/)(tests?|testdata|fixtures|node_modules)/|_tests?\.(rs|py)$|_test\.go$|(^|/)tests?\.(rs|go|py|js)$'
    r'|(^|/)test_[^/]*\.py$|\.test\.(js|mjs|ts)$|(^|/)tools/gen_errors_doc\.py$')
LITERAL = re.compile(r'["\']([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)["\']')
ENV_LINE = re.compile(r'getenv|Getenv|LookupEnv|Setenv|environ|process\.env|env::var|\benv\b|'
                      r'\.env\[|env\.get|ENV')
ENV_PREFIX = re.compile(r'^(MV|XDG|SRF|CARGO|GLIBC|GCONV|PYTHON|NODE|ELECTRON|METAVIEWER|'
                        r'SCREAMING|DBUS|WAYLAND|LD|GTK|QT|SDL|HOME|PATH|DEFAULT)_|^EXIT_CODES$')
CONTEXT = re.compile(r'code|reason|refus|error|\berr\b|fault|fail|detail|verdict|deny|reject',
                     re.IGNORECASE)
MAX_SITES = 6


def source_files(root):
    """Return tracked (or, outside git, present) non-test source files, sorted."""
    try:
        out = subprocess.run(['git', '-C', str(root), 'ls-files', '--', *SCAN_DIRS],
                             capture_output=True, text=True, check=True).stdout.split('\n')
        paths = [p for p in out if p]
    except (OSError, subprocess.CalledProcessError):
        paths = []
    if not paths:
        paths = [p.relative_to(root).as_posix() for d in SCAN_DIRS if (root / d).is_dir()
                 for p in (root / d).rglob('*') if p.is_file()]
    return sorted(p for p in paths if p.endswith(SOURCE_SUFFIXES) and not TEST_PATH.search(p)
                  and (root / p).is_file())


def rust_test_gate(lines, i):
    """For a #[cfg(test)] at i, return ('inline', i), ('file', name) or None."""
    path_attr = None
    for line in lines[i + 1:i + 4]:
        text = line.strip()
        m = re.match(r'#\[path = "([^"]+)"\]', text)
        if m:
            path_attr = m.group(1)
            continue
        m = re.match(r'(?:pub(?:\([^)]*\))? )?mod (\w+)\s*(\{|;)', text)
        if m:
            return ('inline', i) if m.group(2) == '{' else ('file', path_attr or m.group(1) + '.rs')
        if not text.startswith('#['):
            return None
    return None


def read_lines(root, path):
    """Return source lines; Rust stops at the first inline #[cfg(test)] mod { ... }."""
    lines = (root / path).read_text(encoding='utf-8', errors='replace').split('\n')
    if path.endswith('.rs'):
        for i, line in enumerate(lines):
            if line.strip() == '#[cfg(test)]':
                gate = rust_test_gate(lines, i)
                if gate and gate[0] == 'inline':
                    return lines[:i]
    return lines


def rust_test_files(root, paths):
    """Files declared as `#[cfg(test)] mod x;` (sibling x.rs, x/mod.rs, or #[path])."""
    out = set()
    for path in paths:
        if not path.endswith('.rs'):
            continue
        lines = (root / path).read_text(encoding='utf-8', errors='replace').split('\n')
        base = Path(path).parent
        own = base if Path(path).name in ('mod.rs', 'lib.rs', 'main.rs') else base / Path(path).stem
        for i, line in enumerate(lines):
            if line.strip() == '#[cfg(test)]':
                gate = rust_test_gate(lines, i)
                if gate and gate[0] == 'file':
                    name = gate[1]
                    if '/' in name or name.endswith('.rs') and '#[path' in ''.join(lines[i:i + 3]):
                        out.add((base / name).as_posix())
                    else:
                        stem = name[:-3]
                        out.update({(own / name).as_posix(), (own / stem / 'mod.rs').as_posix()})
    return out


class Tree:
    def __init__(self, root):
        self.root = Path(root)
        paths = source_files(self.root)
        skip = rust_test_files(self.root, paths)
        self.files = {p: read_lines(self.root, p) for p in paths if p not in skip}
        self.literal_sites = {}
        env = set()
        for path, lines in self.files.items():
            for n, line in enumerate(lines, 1):
                for code in LITERAL.findall(line):
                    self.literal_sites.setdefault(code, []).append((path, n, line))
                    if ENV_LINE.search(line):
                        env.add(code)
        self.env = env

    def lines(self, path):
        return self.files.get(path, [])


def is_code_literal(tree, code):
    if ENV_PREFIX.match(code) or code in tree.env:
        return False
    return any(CONTEXT.search(line) for _, _, line in tree.literal_sites.get(code, []))


def literal_family(prefixes):
    def extract(tree):
        found = {}
        for code, sites in tree.literal_sites.items():
            mine = [(p, n) for p, n, _ in sites if p.startswith(prefixes)]
            if mine and is_code_literal(tree, code):
                found[code] = {'sites': mine}
        return found
    return extract


def extract_verdicts(tree):
    path = 'core/src/wire/mod.rs'
    found = {}
    for n, line in enumerate(tree.lines(path), 1):
        m = re.search(r'Self::\w+ => "([A-Z_]+)"', line)
        if m:
            found[m.group(1)] = {'defs': [(path, n)]}
    return found


def extract_mw_refusals(tree):
    path = 'agents/metaviewer_agents/mw_refusals.py'
    text = '\n'.join(tree.lines(path))
    found = {}
    if not text:
        return found
    for node in ast.walk(ast.parse(text)):
        if isinstance(node, ast.Assign) and any(getattr(t, 'id', '') == 'REFUSALS' for t in node.targets) \
                and isinstance(node.value, ast.Dict):
            for key, value in zip(node.value.keys, node.value.values):
                if isinstance(key, ast.Constant) and isinstance(value, ast.Constant):
                    code = key.value
                    if code == 'MW_GATE_':
                        code = 'MW_GATE_*'
                    found[code] = {'defs': [(path, key.lineno)], 'meaning': value.value,
                                   'sees': 'stderr line: ' + value.value}
    return found


def extract_mw_unregistered(tree):
    registered = extract_mw_refusals(tree)
    found = {}
    for code, sites in tree.literal_sites.items():
        if not code.startswith('MW_') or code in registered or code.startswith('MW_GATE_'):
            continue
        mine = [(p, n) for p, n, _ in sites if p.startswith(('tools/', 'agents/'))]
        if mine and is_code_literal(tree, code):
            found[code] = {'sites': mine}
    return found


def extract_ui_create(tree):
    found = {}
    path = 'ui/src/App.vue'
    inside = False
    for n, line in enumerate(tree.lines(path), 1):
        if 'const createReasons = {' in line:
            inside = True
            continue
        if inside and line.strip() == '};':
            break
        m = inside and re.match(r"\s+([A-Z][A-Z0-9_]+): ['`](.*)['`],?\s*$", line)
        if m:
            found[m.group(1)] = {'defs': [(path, n)], 'sees': 'tile message: ' + m.group(2)}
    path = 'ui/electron/roleHost.js'
    inside = False
    for n, line in enumerate(tree.lines(path), 1):
        if 'export function surfaceCreateRefusal' in line:
            inside = True
        elif inside and line.startswith('}'):
            break
        elif inside:
            for code in re.findall(r"return '([A-Z][A-Z0-9_]+)'", line) + re.findall(r"\? '([A-Z][A-Z0-9_]+)'", line):
                if code.endswith('_'):
                    code += '*'
                found.setdefault(code, {'defs': []})['defs'].append((path, n))
    return found


def extract_adapter_faults(tree):
    found = {}
    for path, lines in tree.files.items():
        if not path.startswith('daemon-adapter/') or not path.endswith('.go'):
            continue
        for n, line in enumerate(lines, 1):
            for wire, detail in re.findall(r'\bfault\("([a-z][a-z0-9_]*)", "((?:[^"\\]|\\.)*)"', line) + \
                    re.findall(r'Fault\{Code: *"([a-z][a-z0-9_]*)", *Detail: *"((?:[^"\\]|\\.)*)"', line):
                entry = found.setdefault('ADAPTER_' + wire.upper(), {'defs': [], 'details': [], 'wire': wire})
                entry['defs'].append((path, n))
                if detail not in entry['details']:
                    entry['details'].append(detail)
    for entry in found.values():
        entry['meaning'] = 'Adapter wire code `%s`; detail texts in source: %s.' % (
            entry['wire'], '; '.join('`%s`' % d for d in entry['details'][:4])
            + (' (and %d more)' % (len(entry['details']) - 4) if len(entry['details']) > 4 else ''))
    return found


def split_judge_args(rest):
    """Split `"problem" "fix"` loosely: shell text may nest quotes inside $(...)."""
    rest = re.sub(r'\s*(;;|\|\|.*|#.*)$', '', rest.strip()).strip()
    if rest.startswith('"') and rest.endswith('"') and '" "' in rest:
        idx = rest.rfind('" "')
        return rest[1:idx], rest[idx + 3:-1]
    return None, None


def extract_judge(tree):
    found = {}
    pattern = re.compile(r'\b(fail|refuse) (JUDGE_[A-Z_]+) (.*)$')
    for path, lines in tree.files.items():
        if not path.startswith('scripts/judge/'):
            continue
        for n, line in enumerate(lines, 1):
            m = pattern.search(line)
            if not m or line.lstrip().startswith('#'):
                continue
            code = m.group(2)
            problem, fix = split_judge_args(m.group(3))
            entry = found.setdefault(code, {'defs': [], 'problems': [], 'fixes': []})
            entry['defs'].append((path, n))
            if problem and problem not in entry['problems']:
                entry['problems'].append(problem)
            if fix and fix not in entry['fixes']:
                entry['fixes'].append(fix)
    for entry in found.values():
        entry['meaning'] = '; '.join('`%s`' % p.replace('`', "'") for p in entry['problems'][:3]) or None
        entry['fix'] = '; '.join('`%s`' % f.replace('`', "'") for f in entry['fixes'][:3]) or None
        entry['sees'] = 'stderr line `<CODE>: <problem> -- fix: <fix>` and exit status 2'
    return found


# Family order is priority: a code found by two families is written once, under the first.
FAMILIES = [
    {
        'id': 'core-verdict', 'title': 'Core action verdict refusals', 'extract': extract_verdicts,
        'why': 'The core is the only authority that admits an input to a capsule. Every proposal gets '
               'an `action_verdict/v0.2` reply; a refusal carries exactly one of these reason codes so '
               'a caller can tell a refusal (the core said no, nothing was sent) from a failure.',
        'sees': 'mvctl or the agent prints the verdict JSON with `"decision":"refused"` and this '
                '`reason_code`; the tile shows no input effect.',
        'verify': 'Repeat the proposal against a fresh `observe` frame; an admitted verdict carries '
                  '`"decision":"admitted"`. Unit evidence: `cargo test --manifest-path core/Cargo.toml`.',
    },
    {
        'id': 'core-reply', 'title': 'Core reply and session codes', 'extract': literal_family(('core/',)),
        'why': 'Codes the core puts on replies and `surface_event` errors (capture, recording, layout, '
               'journal, guest commands). They let the UI and tools refuse precisely instead of guessing.',
        'sees': 'A `surface_event/v0.2` error or reply with `data.code` set; the UI maps known codes to '
                'fixed text and shows others as a refusal.',
        'verify': 'Repeat the action and confirm the code no longer appears in the reply; for session '
                  'codes, check `journal-ended.json` in the session directory (see docs/DEBUG.md).',
    },
    {
        'id': 'adapter-code', 'title': 'Daemon adapter codes', 'extract': literal_family(('daemon-adapter/',)),
        'why': 'The adapter owns the native side of a capsule (containers, displays, identities, network '
               'egress). Its codes name which native precondition failed so the core never guesses.',
        'sees': 'The code inside an adapter reply detail, in the core log, or on the tile as a refusal.',
        'verify': 'Repeat the action after the fix; `go test ./...` in daemon-adapter is the unit oracle.',
    },
    {
        'id': 'adapter-fault', 'title': 'Adapter faults shown as ADAPTER_* in the UI',
        'extract': extract_adapter_faults,
        'why': 'The adapter CLI reports a lowercase fault code and a fixed detail. The Electron host '
               'turns it into `ADAPTER_<CODE>` (ui/electron/roleHost.js `surfaceCreateRefusal`), except '
               'the codes it maps to named refusals (`binding`, `uncertain`, `profile` with a display '
               'pool detail, `identity_unavailable`, `host_program_unavailable`, `host_window_unavailable`).',
        'sees': 'Tile or Activity text `ADAPTER_<CODE>: ...`; the main process logs '
                '`METAVIEWER_SURFACE_CREATE_REFUSED code=<wire code> detail=<fixed detail or withheld>`.',
        'verify': 'Add the capsule again; the log line no longer appears and the tile shows a frame.',
    },
    {
        'id': 'ui-create', 'title': 'Capsule create refusals in the UI', 'extract': extract_ui_create,
        'why': 'Opening a capsule needs a free slot, a profile, an identity, memory and a working '
               'surface runtime. Each missing precondition has one code and one fixed sentence.',
        'sees': 'The tile or Activity panel shows `<CODE>: <sentence>` (sentence quoted below).',
        'verify': 'Press Add capsule again after the fix; a new tile appears with a live frame.',
    },
    {
        'id': 'mw-run', 'title': 'mw_run refusals (agent runner)', 'extract': extract_mw_refusals,
        'why': 'mw_run drives a capsule for an agent. It stops with a code instead of guessing whenever '
               'it cannot prove identity, frame freshness, input delivery or effect. One static remedy '
               'per code is printed to stderr; stdout stays the `metaviewer.mw_run/v1` JSON line.',
        'sees': 'A nonzero rc, a JSON result line on stdout with the code, and the remedy sentence below '
                'on stderr.',
        'verify': 'Rerun after the remedy; the result line reports success and rc 0. Unit evidence: '
                  '`python3 -m unittest tests.test_mw_refusals`.',
    },
    {
        'id': 'mw-unregistered', 'title': 'mw_run and tool codes without a registered remedy',
        'extract': extract_mw_unregistered,
        'why': 'Codes raised by tools/ and agents/ that are not keys of the remedy table in '
               'agents/metaviewer_agents/mw_refusals.py. They are still refusals.',
        'sees': 'If the code reaches the mw_run result line, stderr carries the generic sentence from '
                '`refusal_sentence` (agents/metaviewer_agents/mw_refusals.py) for unrecognized codes.',
        'verify': 'Rerun after fixing the cause named at the raise site.',
    },
    {
        'id': 'ui-host', 'title': 'Electron host and packaging codes', 'extract': literal_family(('ui/electron/', 'ui/tools/')),
        'why': 'The Electron main process brokers every call between the renderer, the core and the '
               'adapter (roles, terminals, identities, files, wire framing). It refuses with a fixed code '
               'rather than forwarding native text to the page.',
        'sees': 'A refusal or Activity entry with the code, or a rejected IPC promise in the renderer '
                'console; some codes are internal and never shown.',
        'verify': 'Repeat the action; `npm test` in ui/ is the unit oracle.',
    },
    {
        'id': 'ui-renderer', 'title': 'Renderer (wall UI) codes', 'extract': literal_family(('ui/src/',)),
        'why': 'Codes the wall UI uses to refuse or explain an action locally (layout, tiles, frames, '
               'terminal drawer, intents).',
        'sees': 'Tile, header or Activity text; `ERR_*` codes are thrown inside the page and appear in '
                'the developer console.',
        'verify': 'Repeat the action; `npm test` in ui/ is the unit oracle.',
    },
    {
        'id': 'tool-code', 'title': 'Tool and agent package codes', 'extract': literal_family(('tools/', 'agents/')),
        'why': 'Operator and release tools (identities, ARM64 capsules, demo, packaging, mvctl) refuse '
               'with a code before they change state.',
        'sees': 'The code on stderr or in the JSON result of the tool, with a nonzero exit status.',
        'verify': 'Rerun the tool after the fix; its unit test under tests/ is the oracle.',
    },
    {
        'id': 'judge', 'title': 'Judge launcher failures', 'extract': extract_judge,
        'why': 'scripts/judge/metaviewer-judge.sh installs and runs the kit. Each failed precondition '
               'stops with one code, the problem and the exact fix, and changes nothing after it.',
        'sees': 'stderr `<CODE>: <problem> -- fix: <fix>`, exit status 2.',
        'verify': 'Run the fix, then `bash scripts/judge/metaviewer-judge.sh doctor`; success prints '
                  '`JUDGE_DOCTOR_OK`.',
    },
]

# Hand notes: each written after reading the cited code. Fields override generated text.
NOTES = {
    'STALE_FRAME': {
        'meaning': 'The proposal names a frame that is older than (or equal in generation to) the '
                   'capsule\'s current frame, or a surface that is unknown.',
        'causes': 'The capsule published a new frame between observe and propose; the agent reused an '
                  'old frame id; the surface was stopped. See core/src/serve/mod.rs `StaleFrame` arm '
                  'near the frame generation check.',
        'fix': 'Observe again and plan against the new frame. Never resend the old proposal.',
    },
    'SURFACE_NOT_AGENT_CONTROLLED': {
        'meaning': 'The capsule is under human control, so agent input is refused.',
        'causes': 'The tile is in Human mode, or a person pressed Take over. The adapter detail '
                  '`human control blocks agent input` maps here (core/src/serve/mod.rs `adapter_input_refusal`).',
        'fix': 'Switch the tile to agent mode or press Release. Switching a Host program between human '
               'and agent restarts it [MEASURED].',
    },
    'LOCKED_BY_OTHER': {
        'meaning': 'Another controller holds the capsule input lock.',
        'causes': 'Adapter detail contains `SURFACE_NOT_HUMAN_CONTROLLED` or `LOCKED_BY_OTHER` '
                  '(core/src/serve/mod.rs `adapter_input_refusal`).',
        'fix': 'Wait for the other controller to release, or release it from the tile.',
    },
    'BUDGET_EXCEEDED': {
        'meaning': 'The action or capture budget for this surface is spent.',
        'causes': 'Too many proposals or captures inside the budget window; adapter detail '
                  '`BUDGET_EXHAUSTED` also maps here.',
        'fix': 'Slow down; wait for the budget window, then observe and propose again.',
    },
    'OUT_OF_BOUNDS': {
        'meaning': 'A pointer target lies outside the capsule frame.',
        'causes': 'Coordinates computed against another geometry, or adapter detail `invalid click`.',
        'fix': 'Recompute coordinates from the current frame geometry.',
    },
    'POLICY': {
        'meaning': 'The default refusal: the core policy does not admit this action now.',
        'causes': 'Any adapter refusal detail not matched by a more specific code; a closed session '
                  '(JOURNAL_FULL); headless or rewind policy. Read the core log line for the detail.',
        'fix': 'Read the detail, fix that precondition; after JOURNAL_FULL start a new session.',
    },
    'JOURNAL_FULL': {
        'meaning': 'The session journal reached its capacity; admission is closed for this session.',
        'why': 'Every admitted record is journaled before it takes effect, so a full journal cannot accept '
               'more work without losing replayability. See docs/JOURNAL_END.md.',
        'sees': 'Session text: "Session journal is full. New work is refused (POLICY). Capsules are '
                'stopping in order; the accepted journal remains replayable. Start a new session." '
                '(core/src/serve/journal_end.rs `journal_full_notice`).',
        'causes': 'A long run in one session. A full journal ends the session [MEASURED].',
        'fix': 'Start a new session; use a fresh session per long run. The old journal still replays '
               'with mv-replay.',
        'verify': '`journal-ended.json` exists in the session directory; mv-replay on the old journal '
                  'returns rc 0.',
    },
    'JOURNAL_STOP_FAILED': {
        'meaning': 'After JOURNAL_FULL, a capsule stop stayed unconfirmed past the grace period.',
        'fix': 'Close MetaViewer and stop remaining capsules with operating system tools before '
               'reopening (docs/JOURNAL_END.md).',
    },
    'INPUT_UNCERTAIN': {
        'causes': 'The input dispatch window was entered but delivery could not be proved (rc 5). '
                  'agents/metaviewer_agents/mw_run.py keeps this code even when the wall deadline '
                  'expires inside that window. In one recorded game run, 2 of 42 key steps ended '
                  'INPUT_UNCERTAIN [MEASURED].',
        'fix': 'Never retry blindly: observe, check whether the input landed, then decide.',
    },
    'MW_PROGRAM_RAM_REQUIRED': {
        'causes': 'XDG_STATE_HOME (or the default `/dev/shm/vqa-cu/metaviewer-program-<uid>`) is not an '
                  'absolute resolved path under `/dev/shm` (tools/mw_run_program.py `private_evidence_base`).',
        'fix': 'Unset XDG_STATE_HOME for the program runner, or point it at a private directory under '
               '/dev/shm.',
    },
    'ADAPTER_PROFILE': {
        'causes': 'The requested profile, kind or geometry is not admitted (for example human mode on a '
                  'browser that is not 1280x900, or a host-exec request without a dynamic program profile).',
        'fix': 'Use a profile listed in MV_SRF_PROFILES with its declared kind and geometry; in --arm64 '
               'mode only VM and MicroVM are offered [MEASURED].',
    },
    'ADAPTER_*': {
        'meaning': 'Any lowercase adapter fault code not mapped to a named refusal, upper-cased with the '
                   'ADAPTER_ prefix. The specific codes have their own sections in the adapter-fault family.',
        'fix': 'Look up the specific ADAPTER_<CODE> section on this page.',
    },
    'CAPTCHA_HANDOFF': {
        'meaning': 'A login wall or bot check was detected; control passes to a person.',
        'sees': 'Notice text from ui/src/handoff/handoffModel.js: "CAPTCHA or bot check: solve it in the '
                'capsule, then re-run" (or the login variant).',
        'fix': 'A person completes the check in the capsule, then re-runs. MetaViewer and its agents '
               'stop; they do not solve the check (rc 5, login or CAPTCHA: stop and never retry, '
               'ui/src/terminal/workflowPrompts.js).',
    },
    'RAM_ADMISSION_REFUSED': {
        'causes': 'Free host memory is below one capsule\'s need. Stale reservations can also hold memory; '
                  'tools/mv_ram_admission.py is the explicit operator reclaim.',
    },
}


def discover(root=ROOT):
    """Return {code: entry} with entry['family'] set, in family priority order."""
    tree = Tree(root)
    codes = {}
    for family in FAMILIES:
        for code, entry in sorted(family['extract'](tree).items()):
            own = sorted(set(entry.get('defs', []) + entry.get('sites', [])))
            rest = sorted({(p, n) for p, n, _ in tree.literal_sites.get(code, [])} - set(own))
            sites = own + rest  # the family's own coordinates first
            if code in codes:
                codes[code].setdefault('also', []).append(family['id'])
                continue
            entry = dict(entry, family=family['id'], sites=sites)
            codes[code] = entry
    return codes


def anchor(heading):
    """GitHub heading anchor: lower case, drop punctuation except - and _, spaces to -."""
    return re.sub(r'[^\w\- ]', '', heading.lower()).replace(' ', '-')


def esc(text):
    return text.replace('|', '\\|').replace('\n', ' ')


def family_heading(family):
    return 'Family %s: %s' % (family['id'], family['title'])


def first_line(tree, sites):
    path, n = sites[0]
    text = ' '.join(tree.lines(path)[n - 1].split()).replace('`', "'")
    return text if len(text) <= 160 else text[:157] + '...'


def render(root=ROOT):
    codes = discover(root)
    root_tree = Tree(root)
    by_family = {f['id']: [] for f in FAMILIES}
    for code, entry in codes.items():
        by_family[entry['family']].append(code)
    out = [
        '# MetaViewer error and refusal codes',
        '',
        '<!-- Generated by tools/gen_errors_doc.py. Do not edit by hand; run '
        '`python3 tools/gen_errors_doc.py --write`. -->',
        '',
        'Every refusal or error code found in source, one section per code, with where it is raised. '
        'A refusal means MetaViewer declined on purpose and changed nothing; a bug is behaviour that '
        'contradicts the cited code. See [DEBUG.md](DEBUG.md) for symptoms and procedures.',
        '',
        '**A finding tells you where to look. Only the code proves it.** Coordinates are path:line on '
        'the tree this page was generated from; if a line moved, search the code literal.',
        '',
        '## How this page is built and how to use it',
        '',
        'Answers: what does this error code mean; where is this refusal raised; how is ERRORS.md generated',
        '',
        'Search this page for the exact code you saw (Ctrl+F), or open `#<code in lowercase>`. Each '
        'section lists: family, where raised, what it means, why it exists, what the user sees, likely '
        'causes, the fix, and how to verify. Text quoted in backticks is copied from source. A field '
        'that no source or reviewed note supports reads exactly "%s"' % ABSENT,
        '',
        '| Family | Rule that admits a code | Codes [MEASURED] |',
        '|---|---|---|',
    ]
    rules = {
        'core-verdict': '`Self::X => "CODE"` in core/src/wire/mod.rs',
        'core-reply': 'quoted UPPER_SNAKE literal in core/ near code, reason, error or detail; env names excluded',
        'adapter-code': 'same rule in daemon-adapter/',
        'adapter-fault': '`fault("code", "detail")` in daemon-adapter Go, shown as ADAPTER_CODE',
        'ui-create': 'keys of `createReasons` in ui/src/App.vue and returns of `surfaceCreateRefusal`',
        'mw-run': 'keys of `REFUSALS` in agents/metaviewer_agents/mw_refusals.py',
        'mw-unregistered': 'quoted `MW_*` literal in tools/ or agents/ that is not a REFUSALS key',
        'ui-host': 'same literal rule in ui/electron/ and ui/tools/',
        'ui-renderer': 'same literal rule in ui/src/',
        'tool-code': 'same literal rule in tools/ and agents/',
        'judge': '`fail` or `refuse JUDGE_X "problem" "fix"` in scripts/judge/',
    }
    for f in FAMILIES:
        out.append('| [%s](#%s) | %s | %d |' % (f['title'], anchor(family_heading(f)),
                                               rules[f['id']], len(by_family[f['id']])))
    out += [
        '',
        'Scanned: non-test files under %s. Test files and Rust code after `#[cfg(test)]` are skipped. '
        'Not covered: codes built at run time from strings this scan cannot see, and the hold text '
        '"exhaustive manifest inventory" reported for --arm64 after mw_run: its source is not in this '
        'tree, ABSENT \u2014 do not invent (see [DEBUG.md](DEBUG.md#known-issues-and-their-status)).' % ', '.join(SCAN_DIRS),
        '',
    ]
    for f in FAMILIES:
        out += ['## ' + family_heading(f), '',
                'Answers: what are %s; why does MetaViewer refuse with these' % f['title'].lower(), '',
                '- Why this family exists: ' + f['why'],
                '- What the user sees: ' + f['sees'],
                '- How to verify a fix: ' + f['verify'], '']
        for code in by_family[f['id']]:
            entry = codes[code]
            note = NOTES.get(code, {})
            sites = entry['sites']
            where = ', '.join('`%s:%d`' % s for s in sites[:MAX_SITES])
            if len(sites) > MAX_SITES:
                where += ' and %d more sites' % (len(sites) - MAX_SITES)
            fields = [
                ('Family', f['id'] + (' (also found by: %s)' % ', '.join(entry['also']) if entry.get('also') else '')),
                ('Where raised', where or ABSENT),
                ('Source line', '`%s`' % first_line(root_tree, sites) if sites else ABSENT),
                ('What it means', note.get('meaning') or entry.get('meaning') or ABSENT),
                ('Why it exists', note.get('why') or 'See the family note above.'),
                ('What the user sees', note.get('sees') or entry.get('sees') or 'See the family note above.'),
                ('Likely causes', note.get('causes') or ABSENT),
                ('Fix or workaround', note.get('fix') or entry.get('fix')
                 or (entry.get('meaning') if f['id'] in ('mw-run', 'ui-create') else None) or ABSENT),
                ('How to verify', note.get('verify') or 'See the family note above.'),
            ]
            if f['id'] == 'ui-create' and 'sees' in entry and not note.get('fix'):
                fields[6] = ('Fix or workaround', entry['sees'].split(': ', 1)[1])
            out += ['### %s' % code, '',
                    'Answers: what does %s mean; why do I get %s; how to fix %s' % (code, code, code), '']
            out += ['- %s: %s' % (k, esc(v)) for k, v in fields]
            out.append('')
    return '\n'.join(out).rstrip('\n') + '\n'


def section_codes(doc_text):
    return {m.group(1) for m in re.finditer(r'^### (.+?)\s*$', doc_text, re.MULTILINE)}


def missing_sections(doc_text, root=ROOT):
    """Codes present in source with no `### CODE` section in doc_text, sorted."""
    have = section_codes(doc_text)
    return sorted(code for code in discover(root) if code not in have)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--write', action='store_true')
    group.add_argument('--check', action='store_true')
    parser.add_argument('--root', default=str(ROOT))
    args = parser.parse_args(argv)
    root = Path(args.root)
    text = render(root)
    target = root / DOC
    if args.write:
        target.write_text(text, encoding='utf-8')
        print('ERRORS_DOC_WRITTEN codes=%d' % len(section_codes(text)))
        return 0
    current = target.read_text(encoding='utf-8') if target.exists() else ''
    missing = missing_sections(current, root)
    if missing:
        print('ERRORS_DOC_MISSING ' + ' '.join(missing[:20]), file=sys.stderr)
        return 1
    if current != text:
        print('ERRORS_DOC_STALE run: python3 tools/gen_errors_doc.py --write', file=sys.stderr)
        return 1
    print('ERRORS_DOC_OK codes=%d' % len(section_codes(text)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
