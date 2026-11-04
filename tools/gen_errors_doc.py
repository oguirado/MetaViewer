#!/usr/bin/env python3
"""Generate docs/ERRORS.md from the refusal and error codes found in source.

Standard library only, deterministic, read-only unless --write is given.

[TARGET, unit decision] Discovery is rule based, never model based. Each family
below names the files it reads and the pattern that admits a code. Coordinates
are path:line on the scanned tree. Explanations come first from text that the
code itself carries (a remedy table, a UI message, a launcher fix string, an
adapter detail); then from the hand notes in NOTES, each written after reading
the cited code; unreviewed codes retain a lookup row without invented explanations.

Usage:
  python3 tools/gen_errors_doc.py --write   # regenerate docs/ERRORS.md
  python3 tools/gen_errors_doc.py --check   # exit 1 if stale or a code lacks a row
"""
import argparse
import ast
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOC = Path('docs/ERRORS.md')
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
            entry = found.setdefault(code, {'defs': [], 'problems': [], 'fixes': [], 'diagnostics': []})
            entry['defs'].append((path, n))
            if problem and fix:
                entry['diagnostics'].append((problem, fix, (path, n)))
            if problem and problem not in entry['problems']:
                entry['problems'].append(problem)
            if fix and fix not in entry['fixes']:
                entry['fixes'].append(fix)
    for entry in found.values():
        entry['meaning'] = '; '.join('`%s`' % p.replace('`', "'") for p in entry['problems'][:3]) or None
        entry['fix'] = '; '.join('`%s`' % f.replace('`', "'") for f in entry['fixes'][:3]) or None
        entry['sees'] = 'stderr line `<CODE>: <problem> -- fix: <fix>` and exit status 2'
    return found



def extract_replay(tree):
    """Public stderr identities emitted by JournalError's Display implementation."""
    path = 'core/src/journal/mod.rs'
    lines = tree.lines(path)
    found = {}
    inside = False
    display_names = {'Empty': 'Corrupt(empty)', 'Blank': 'Corrupt(blank)',
                     'Utf8Bom': 'Corrupt(utf8_bom)', 'MissingLf': 'Corrupt(missing_lf)',
                     'Oversize': 'Corrupt(oversize)', 'UpgradeRequired': 'UPGRADE-REQUIRED'}
    for n, line in enumerate(lines, 1):
        if line.startswith('pub enum JournalError {'):
            inside = True
        elif inside and line == '}':
            break
        elif inside:
            match = re.match(r'    (\w+)\s*[,{]', line)
            if match:
                name = match.group(1)
                found[display_names.get(name, name)] = {'defs': [(path, n)]}
    return found

# Priority keeps codes found by several extractors in one lookup row.
FAMILIES = [
    {'id': 'replay', 'title': 'Journal replay diagnostics', 'extract': extract_replay},
    {'id': 'core-verdict', 'title': 'Core action verdict refusals', 'extract': extract_verdicts},
    {'id': 'core-reply', 'title': 'Core reply and session codes', 'extract': literal_family(('core/',))},
    {'id': 'adapter-code', 'title': 'Daemon adapter codes', 'extract': literal_family(('daemon-adapter/',))},
    {'id': 'adapter-fault', 'title': 'Adapter faults shown as ADAPTER_* in the UI', 'extract': extract_adapter_faults},
    {'id': 'ui-create', 'title': 'Capsule create refusals in the UI', 'extract': extract_ui_create},
    {'id': 'mw-run', 'title': 'mw_run refusals (agent runner)', 'extract': extract_mw_refusals},
    {'id': 'mw-unregistered', 'title': 'mw_run and tool codes without a registered remedy', 'extract': extract_mw_unregistered},
    {'id': 'ui-host', 'title': 'Electron host and packaging codes', 'extract': literal_family(('ui/electron/', 'ui/tools/'))},
    {'id': 'ui-renderer', 'title': 'Renderer (wall UI) codes', 'extract': literal_family(('ui/src/',))},
    {'id': 'tool-code', 'title': 'Tool and agent package codes', 'extract': literal_family(('tools/', 'agents/'))},
    {'id': 'judge', 'title': 'Judge launcher failures', 'extract': extract_judge},
]

# Reviewed against deciding code, not inferred from the spelling of a code.
# Each tuple is: meaning, cause/evidence, user-visible outcome, fix, verification.
NOTES = {}

def reviewed(code, meaning, causes, sees, fix, verify):
    NOTES[code] = dict(meaning=meaning, causes=causes, sees=sees, fix=fix, verify=verify)



# Admission review: check() rechecks current accepted frame, custody, lease and budget.
reviewed('STALE_FRAME', 'The proposal cannot bind the current accepted frame.',
    'Missing surface/frame, refresh pending, or a digest/generation mismatch; core/src/admission/mod.rs:1307.',
    'A refused action verdict with STALE_FRAME.',
    'Observe the intended capsule again and re-plan against that accepted frame.',
    'The new proposal binds the fresh digest/generation and receives an admitted verdict.')
reviewed('SURFACE_NOT_AGENT_CONTROLLED', 'The surface is not available to this agent.',
    'Agent control, live state or owning sender fails the check; core/src/admission/mod.rs:1313. Human-role policy can also return POLICY.',
    'A refused action verdict; an agent cannot assume custody.',
    'Check the intended identity and live capsule; release human takeover or switch to agent mode deliberately.',
    'A fresh observation and proposal from the owning agent is admitted.')
reviewed('LOCKED_BY_OTHER', 'A conflicting input lease prevents admission.',
    'A lease on this surface or shared display conflicts, or dispatch no longer owns its proposal lease; core/src/admission/mod.rs:1322.',
    'LOCKED_BY_OTHER in the refused verdict.',
    'Let the outstanding action settle; inspect ownership before submitting another proposal.',
    'With the conflicting lease settled, a fresh proposal is admitted.')
reviewed('BUDGET_EXCEEDED', 'The proposal exceeds an admission budget or its time window.',
    'Budget depleted, deadline invalid/expired, received time in the future, or wait exceeds its budget; core/src/admission/mod.rs:1333.',
    'BUDGET_EXCEEDED in the refused verdict.',
    'Inspect the request deadline and session budget; use a supported bounded action with a fresh observation.',
    'A request within the actual remaining budget and deadline is admitted; waiting alone does not replenish the session budget.')
reviewed('OUT_OF_BOUNDS', 'Input or expected-effect geometry is outside supported bounds.',
    'Scroll integer overflow, pointer beyond frame, or empty/overflowing expected rectangle; core/src/admission/mod.rs:1345.',
    'OUT_OF_BOUNDS in the refused verdict.',
    'Recompute the action and expected rectangle from the accepted frame dimensions.',
    'The corrected proposal passes geometry validation and receives an admitted verdict.')
reviewed('POLICY', 'A policy gate prevents this action.',
    'Human-role surface, unsupported action, epoch/sender mismatch, or ended session; core/src/admission/mod.rs:1303 and core/src/serve/journal_end.rs:125.',
    'POLICY in the reply; the session notice may identify JOURNAL_FULL.',
    'Read the specific reply/session detail. Correct the named condition; start a fresh session only when the current session ended.',
    'The corrected request is admitted in a live session.')
reviewed('JOURNAL_FULL', 'Journal capacity ended admission for this session.',
    'The append path reached capacity; core/src/serve/journal_end.rs:125.',
    'The session notice says new work is refused and capsules are stopping in order.',
    'Preserve the session journal and start a new session; do not edit or truncate the old journal.',
    'Inspect the session notice and journal-ended.json when present, then replay the accepted old journal. Marker writes are best effort; absence does not prove the session is live. The new session accepts work.')
reviewed('JOURNAL_STOP_FAILED', 'A capsule stop was not confirmed while ending the session.',
    'Session-end stop grace elapsed without a confirmed stop; core/src/serve/journal_end.rs.',
    'JOURNAL_STOP_FAILED accompanies session shutdown evidence.',
    'Close the app and verify remaining capsule processes with operating-system tools; preserve the journal.',
    'Confirm remaining capsules have stopped, then replay the accepted journal before a fresh session.')

reviewed('ADAPTER_PROFILE', 'The adapter does not admit the requested profile.',
    'Missing profile, invalid id, kind/geometry mismatch or invalid dynamic program/window profile; daemon-adapter/internal/capsule/manager.go:819.',
    'The tile/Activity refusal and METAVIEWER_SURFACE_CREATE_REFUSED detail; display-pool faults map separately to CAPSULE_SLOT_UNAVAILABLE.',
    'Compare the actual request with MV_SRF_PROFILES and its kind/geometry. For a dynamic Host program/window, use its matching dynamic profile. ARM mode alone does not prove this cause.',
    'The corrected profile request creates a capsule with a live frame.')
reviewed('CAPSULE_LIMIT_REACHED', 'The live capsule limit prevents another create.',
    'The live count reaches MAX_CAPSULES; ui/electron/roleHost.js:825.',
    'The tile explains that the capsule limit was reached.',
    'Stop an unneeded capsule and verify its closure before adding another.',
    'The live count falls below the limit and the new capsule obtains a live frame.')
reviewed('CAPSULE_SLOT_UNAVAILABLE', 'No suitable capsule or display slot is free.',
    'No free dynamic profile, or an adapter display-pool exhaustion detail; ui/electron/roleHost.js:82 and :859.',
    'The tile says no free capsule slot.',
    'Stop a capsule occupying the required slot and wait for verified release.',
    'Add capsule succeeds using the released slot and presents a live frame.')
reviewed('NO_FREE_PROFILE', 'No eligible configured browser profile is free.',
    'The free profile list is empty; ui/electron/profilePicker.js:274.',
    'The tile reports no free profile; the eligible pool may be empty or occupied.',
    'Check that eligible browser profiles are configured; reuse or close an existing capsule, or configure another supported profile and restart the app.',
    'The profile picker offers an available profile and its capsule starts.')
reviewed('NO_IDENTITY', 'No eligible free profile has an available identity.',
    'No free profile has an identity in the returned set; ui/electron/profilePicker.js:277. Selection can also be unavailable at ui/electron/roleHost.js:948.',
    'The tile requests an identity matching the profile.',
    'Use Identities to create/select the requested profile identity; check existing bindings before reopening.',
    'The matching identity becomes available and Add capsule presents its frame.')
reviewed('SURFACE_CREATE_BUSY', 'A capsule create is already in progress.',
    'The creating guard is held; ui/electron/roleHost.js:527.',
    'The tile says another capsule is starting.',
    'Wait for that operation to settle; inspect its result before requesting another create.',
    'The existing create settles and the next request no longer reports busy.')
reviewed('SURFACE_CREATE_KIND_UNAVAILABLE', 'The requested capsule kind is unavailable on this route.',
    'The create route rejects a non-browser kind; ui/electron/authorityWire.js:980. This route is not the whole catalog.',
    'The tile displays the host-kind refusal. That generic sentence is not proof of the installed platform capabilities.',
    'Check the running host mode and choose a kind it actually offers.',
    'A supported selection creates a capsule with a live frame.')
reviewed('SURFACE_CREATE_TIMEOUT', 'Creation did not become ready within the wait.',
    'The create wait expired; ui/src/App.vue:1290 maps the timeout.',
    'The tile reports a creation timeout.',
    'Inspect the adapter result and existing capsule inventory before another create; a timeout alone does not prove no capsule exists.',
    'Reconcile any existing capsule, then confirm a live frame or a verified stop.')
reviewed('SURFACE_PROFILE_BOUND', 'The configured profile is already bound.',
    'The renderer displays a bound-profile refusal; ui/src/App.vue:1280. Inspect the adapter binding before choosing a remedy.',
    'The tile explains that profiles are bound to running capsules.',
    'Reuse the existing capsule, stop it with confirmed cleanup, or configure another supported profile.',
    'The intended profile is available and a new capsule starts without a duplicate binding.')
reviewed('SURFACE_PROFILE_QUARANTINED', 'A profile is retained after an unresolved native failure.',
    'Quarantine prevents reuse while native outcome is unresolved; ui/src/App.vue:1284 and daemon-adapter/internal/capsule/manager.go:866.',
    'The tile reports a quarantined profile.',
    'Inspect retained native state and use verified lost-capsule cleanup; do not delete custody records to force reuse.',
    'Cleanup confirms the stop and the profile can be reopened with a live frame.')

reviewed('INPUT_UNCERTAIN', 'Input may have arrived without a conclusive result.',
    'A dispatch/settlement attempt is unresolved, or a delivered focus click precedes a failed text step; tools/mw_run_program.py:1274. A wall deadline preserves this outcome; agents/metaviewer_agents/mw_run.py:256.',
    'The runner reports INPUT_UNCERTAIN with rc 5 [CITED: tools/mw_run_program.py].',
    'Observe the capsule and reconcile the intended effect before deciding whether any further input is needed.',
    'Use the existing report, attempt and receipt evidence plus a fresh observation to determine which effects occurred; never verify by blindly replaying the step.')
reviewed('MW_PROGRAM_RAM_REQUIRED', 'Program evidence requires a resolved absolute RAM path.',
    'XDG_STATE_HOME or its default is not a resolved absolute path beneath /dev/shm; tools/mw_run_program.py:79.',
    'The runner reports MW_PROGRAM_RAM_REQUIRED before evidence setup completes.',
    'Unset XDG_STATE_HOME for this runner or use a private directory under /dev/shm; ensure its owner and mode satisfy private_evidence_base.',
    'Evidence setup succeeds in the private RAM directory.')
reviewed('MW_PROGRAM_CONTROL', 'The selected program capsule is in human control.',
    'ProgramBackend detects the human input mode; tools/mw_run_program.py:120.',
    'The runner asks for agent control.',
    'Release temporary takeover or deliberately switch the intended capsule to agent mode.',
    'A fresh observation confirms agent control before any input is attempted.')
reviewed('MW_PROGRAM_KEY_REQUEST', 'The focused-key request does not match the supported shape.',
    'Wrong goal, key, step count, text or planner; tools/mw_run_program.py:44.',
    'The runner refuses the navigation request.',
    'Use focused-key with a supported arrow or Enter, rules planner, no text and a single step [CITED: tools/mw_run_program.py:44].',
    'validate_key_request accepts the corrected request; inspect the final receipt separately for delivery.')
reviewed('MW_PROGRAM_KEY_HOST_ONLY', 'Focused navigation requires an Agent Host program binding.',
    'The program binding does not have host_xpra set; tools/mw_run_program.py:701.',
    'The navigation request is refused before its dispatch attempt.',
    'Select the intended live Agent Host program with valid custody.',
    'The refreshed binding passes the host_xpra check before navigation.')
reviewed('MW_RUN_ATTACH', 'The runner cannot identify or attach to the intended running app.',
    'No unique running app, mismatched environment, unreadable configuration or absent socket; tools/mw_run_backend.py:169 and :363.',
    'The runner emits a specific attach diagnostic.',
    'Start/select the intended app and use its MV_CORE_CONFIG and XDG_RUNTIME_DIR; resolve ambiguous apps.',
    'The runner attaches to that app and can observe its capsule.')
reviewed('MW_RUN_NO_SURFACE', 'No eligible live capsule matches the requested identity.',
    'The filtered surface or native lease list is empty; tools/mw_run_backend.py:459 and :476.',
    'The runner reports no live capsule.',
    'Open the identity capsule and check its live state and binding.',
    'A fresh observation finds the intended eligible surface.')
reviewed('MW_RUN_REGISTRATION', 'Core agent registration is not unique.',
    'The matching registered-peer list does not have the required unique entry; tools/mw_run_backend.py:375.',
    'The runner refuses registration selection.',
    'Use the intended running app registration and its MV_AGENT_INSTANCE.',
    'The registration lookup resolves one intended peer before observation.')
reviewed('MW_PRIVATE_OUTPUT', 'Evidence output cannot meet the private-path rules.',
    'Invalid RAM directory owner/mode/symlink, or unsafe output location; tools/mw_run_program.py:73 and tools/mw_run_backend.py:1013.',
    'The runner reports MW_PRIVATE_OUTPUT; a late output failure may follow effects.',
    'Use a private writable directory outside the repository with no symlinked parents; inspect prior effects before rerunning.',
    'Evidence is written safely and the existing run result is reconciled with the capsule state.')
reviewed('MW_WALL_DEADLINE', 'The overall runner deadline expired.',
    'The run-level timer raises WallDeadlineError; agents/metaviewer_agents/mw_run.py:17.',
    'The runner reports rc 6 unless INPUT_UNCERTAIN must be preserved [CITED: agents/metaviewer_agents/mw_run.py:18].',
    'Inspect report.json and capsule state; check responsiveness before planning further work.',
    'Reconcile previous effects and confirm the next bounded run settles within its allowed deadline.')

# ARM setup is packaged in productionEntry by this public generator.
for code, line, meaning, cause, fix in [
    ('ARM64_SETUP_LOCATION', 1169, 'The setup data location is invalid.', 'The chosen data-home path is not absolute and normalized.', 'Use the login account data directory or an absolute normalized XDG_DATA_HOME.'),
    ('ARM64_SETUP_CUSTODY', 1173, 'The setup registry fails custody checks.', 'setup.json is not a private regular file owned by the current user, or has unsafe links, size or resolution.', 'Restore the setup registry through the supported setup flow; do not loosen its permissions.'),
    ('ARM64_SETUP_BINDING', 1174, 'The packaged source/app binding is malformed.', 'The expected commit or app/operator-root paths fail validation.', 'Restore a matching complete package and its configured setup.'),
    ('ARM64_SETUP_HELPER', 1177, 'An operator helper fails custody checks.', 'A required helper is unsafe, missing a pin, or has invalid file metadata.', 'Restore the packaged helper with its original ownership, permissions and pin.'),
    ('ARM64_SETUP_HELPER_PIN', 1178, 'An operator helper differs from its pinned bytes.', 'The helper SHA-256 differs from the packaged pin.', 'Restore the matching release helper; never rewrite the pin to accept modified bytes.'),
    ('ARM64_SETUP_UI_TRANSPORT', 1183, 'The graphical login transport is invalid.', 'DISPLAY, session bus address or XAUTHORITY fails syntax/path validation.', 'Launch from the intended graphical login with its actual display, session bus and authority values.'),
]:
    reviewed(code, meaning, cause + ' ui/tools/package.js:%d.' % line,
             'ARM64_SETUP_REFUSED prints the setup code and the wrapper exits [CITED: ui/tools/package.js:1364].',
             fix, 'The same setup plan validates and the intended packaged app opens from that login.')

for code, meaning, cause, fix, verify in [
    ('Invalid', 'Replay arguments or archive path invariants are invalid.', 'Missing/duplicate options, symlinks, parent traversal, ownership or directory mode mismatch; core/src/bin/mv-replay.rs:10 and core/src/journal/mod.rs:1280.', 'Use the documented arguments and a preserved private session hierarchy with absolute paths, valid ownership and private modes; copies must preserve the same requirements.', 'Replay validates the original archive and exits successfully.'),
    ('Io', 'A filesystem operation needed by replay failed.', 'Metadata or file access fails; core/src/journal/mod.rs:1287.', 'Check existence, accessibility and original archive location without rewriting journal contents.', 'Replay can read the complete archive and verify it.'),
    ('Corrupt', 'Journal contents fail structural or chain validation.', 'Journal scan rejected the record stream; core/src/journal/mod.rs JournalError and scan.', 'Preserve the original evidence and investigate the rejected record; do not repair by editing the journal.', 'A separately preserved known-valid archive passes replay; the damaged original remains evidence.'),
    ('Duplicate', 'Replay rejects a duplicate or non-increasing record identity.', 'The scan reports JournalError::Duplicate; core/src/bin/mv-replay.rs:45.', 'Preserve the journal and investigate record publication/order; do not remove duplicate lines.', 'The original diagnostic is captured; a known-valid session replays without duplicates.'),
    ('Witness', 'Referenced evidence does not verify against the journal.', 'The scan reports JournalError::Witness; core/src/bin/mv-replay.rs:46.', 'Restore the complete original session evidence from a trusted copy; never substitute or edit a witness.', 'Replay verifies the complete archive and its witnesses.'),
    ('UPGRADE-REQUIRED', 'The stored session version differs from the expected core version.', 'JournalError::UpgradeRequired formats the version mismatch; core/src/journal/mod.rs:710.', 'Stop peers, archive the complete session unchanged, and start a fresh session with a new session id.', 'The new session uses the running core version; preserve the old archive for a matching reader.'),
]:
    reviewed(code, meaning, cause, 'mv-replay writes ' + code + ' to stderr and exits unsuccessfully [CITED: core/src/bin/mv-replay.rs].', fix, verify)

# These judge branches were reviewed against fail/refuse predicates and their exact remedies.
REVIEWED_JUDGE = frozenset('JUDGE_ARCH JUDGE_ASSET JUDGE_DISPLAY JUDGE_DOCKER JUDGE_DOCKER_HOST JUDGE_HOME_PATH JUDGE_IMAGE JUDGE_NET JUDGE_NODE JUDGE_NOT_INSTALLED JUDGE_NPM JUDGE_PROFILE JUDGE_RAM JUDGE_ROOT JUDGE_SHM JUDGE_SMOKE JUDGE_SUDO JUDGE_SYSDEP JUDGE_USERNS JUDGE_XDG_RUNTIME'.split())

def judge_placeholders(text):
    """Render shell expansions as inert placeholders, never runnable examples."""
    text = text.replace(r'\$', '$').replace(r'\"', '"')
    out = []
    pos = 0
    while pos < len(text):
        if text.startswith('$(', pos):
            depth = 1
            end = pos + 2
            while end < len(text) and depth:
                if text[end] == '(':
                    depth += 1
                elif text[end] == ')':
                    depth -= 1
                end += 1
            out.append('<computed value from diagnostic>')
            pos = end
        else:
            match = re.match(r'\$\{([A-Za-z_][A-Za-z_0-9]*)[^}]*\}|\$([A-Za-z_][A-Za-z_0-9]*)', text[pos:])
            if match:
                out.append('<' + (match[1] or match[2]) + '>')
                pos += len(match[0])
            else:
                out.append(text[pos])
                pos += 1
    return ''.join(out)


def review_judge_entries(codes):
    for code in REVIEWED_JUDGE & codes.keys():
        if not codes[code].get('diagnostics'):
            continue
        reviewed(code, 'A judge precondition failed; use the matching diagnostic below.',
                 'Each row below pairs the emitted condition with its own remedy and source.',
                 'stderr prints the code, problem and matching fix; the check fails [CITED: scripts/judge/preflight.sh].',
                 'Use the remedy in the matching row. Angle-bracket placeholders stand for values in the actual diagnostic; replace them before running a command.',
                 'Rerun the failed subcommand and doctor with the same capsule/tier options; require its success marker. Preserve smoke.log when the smoke step fails.')


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
    by_family = {f['id']: [] for f in FAMILIES}
    for code, entry in codes.items():
        by_family[entry['family']].append(code)
    review_judge_entries(codes)
    reviewed_codes = sorted(set(codes) & set(NOTES))
    out = [
        '# MetaViewer error and refusal codes', '',
        '<!-- Generated by tools/gen_errors_doc.py. Edit reviewed notes there, then run '
        '`python3 -B tools/gen_errors_doc.py --write`. -->', '',
        'A pre-dispatch refusal declines that action. A later failure can follow earlier effects: '
        '`INPUT_UNCERTAIN` means input may already have arrived. Observe and reconcile before '
        'another input. A code alone never proves that the whole run changed nothing. '
        'See [DEBUG.md](DEBUG.md).', '',
        '**A finding tells you where to look. Only the code proves it.**', '',
        'For the free-text hold `exhaustive manifest inventory`, see '
        '[package inventory](DEBUG.md#package-inventory-hold).', '',
        '## How this page is built and how to use it', '',
        'Search the exact code. Every discovered code has a compact row with source coordinates '
        'and a stable anchor. Reviewed rows link to evidence-based explanations below. '
        'All rows labelled **unreviewed** have location evidence only: their meaning, cause, '
        'user-visible effect, remedy and verification have not been reviewed. '
        'ABSENT — do not invent those fields from the name.', '',
        'Coordinates use path:line [CITED: named source]. If a line moved, search the literal. '
        'The scan reads tracked non-test source under ' + ', '.join(SCAN_DIRS) +
        '; tests and inline Rust test modules are excluded. It is a lexical inventory, '
        'so it can include internal status labels and cannot discover every dynamically built code.', '',
        'Reviewed codes: %d [MEASURED]; lookup rows: %d [MEASURED]. '
        'Review selection covers judge prerequisites, admission, capsule/profile selection, '
        'runner outcomes, ARM setup, journal and replay.' % (len(reviewed_codes), len(codes)), '',
        '| Family | Lookup rows [MEASURED] |', '|---|---|',
    ]
    for f in FAMILIES:
        out.append('| [%s](#%s) | %d |' % (f['title'], anchor(family_heading(f)), len(by_family[f['id']])))
    for f in FAMILIES:
        out += ['', '## ' + family_heading(f), '', '| Code | Source coordinates [CITED] | Review | Source text |', '|---|---|---|---|']
        for code in by_family[f['id']]:
            sites = codes[code]['sites']
            where = ', '.join('`%s:%d`' % site for site in sites[:MAX_SITES])
            status = '[reviewed](#review-%s)' % anchor(code) if code in NOTES else 'unreviewed'
            source_text = '; '.join(str(codes[code][key]) for key in ('meaning', 'fix') if codes[code].get(key)) if code not in NOTES else 'See review'
            out.append('| <a id="%s"></a>`%s` | %s | %s | %s |' % (anchor(code), esc(code), where, status, esc(source_text) or '—'))
    out += ['', '## Reviewed explanations', '',
            'These are source reviews, not claims that live incidents were reproduced. '
            'Verification steps are checks to perform after the remedy; preserve existing evidence.']
    for code in reviewed_codes:
        note = NOTES[code]
        out += ['', '### Review ' + code, '',
                'Answers: what does %s mean; why do I get %s; how to fix %s' % (code, code, code), '']
        for field, label in [('meaning', 'Meaning'), ('causes', 'Cause and evidence'),
                             ('sees', 'What the user sees'), ('fix', 'Fix'), ('verify', 'Verification')]:
            out.append('- %s: %s' % (label, esc(note[field])))
        diagnostics = codes[code].get('diagnostics', [])
        if diagnostics:
            out += ['', '| Condition | Matching remedy | Source |', '| --- | --- | --- |']
            for problem, fix, (path, line) in diagnostics:
                out.append('| %s | %s | [CITED: `%s:%d`] |' % (
                    esc(judge_placeholders(problem)).replace('<', '&lt;').replace('>', '&gt;'),
                    esc(judge_placeholders(fix)).replace('<', '&lt;').replace('>', '&gt;'),
                    path, line))
    return '\n'.join(out).rstrip('\n') + '\n'


def section_codes(doc_text):
    """Code identities from lookup rows, independent of reviewed headings."""
    return {m.group(1) for m in re.finditer(r'^\| <a id="[^"\n]+"></a>`([^`\n]+)` \|', doc_text, re.MULTILINE)}


def missing_sections(doc_text, root=ROOT):
    """Compatibility API: codes present in source but missing a lookup row."""
    return sorted(set(discover(root)) - section_codes(doc_text))


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
