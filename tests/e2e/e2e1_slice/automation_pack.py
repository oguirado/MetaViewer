"""Offline pack admission; no browser, subprocess or network dependency.

[TARGET, unit decision] One task per pack; builtin-fixtures contains T1/T2/T3.
Caps: automation.json 64 KiB, each HTML 1 MiB, total HTML 8 MiB, 32 packs.
Reads prove ordered markers; optional report_cell selects a pinned report value. No live mode or navigate step admitted.
"""
import hashlib
from html import unescape
from html.parser import HTMLParser
import os
from pathlib import Path
import re
import stat
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tools'))
from check_contracts import Validator, ValidationError, loads_strict

SCHEMA_PATH = ROOT / 'tests/e2e/packs/automation.schema.json'
BUILTINS = ROOT / 'tests/e2e/packs/builtin-fixtures'
# [TARGET, unit decision] Release tasks stay fixed; reviewed additions are opt-in.
DEFAULT_PACK_NAMES = ('T1', 'T2', 'T3')
JSON_CAP = 64 * 1024
PAGE_CAP = 1024 * 1024
TOTAL_CAP = 8 * PAGE_CAP
PACK_CAP = 32
URL_ATTRIBUTES = frozenset(('src', 'href', 'action', 'formaction', 'poster',
                            'data', 'cite', 'background', 'xlink:href', 'manifest',
                            'longdesc', 'codebase', 'usemap'))
C0_SPACE = ''.join(chr(n) for n in range(33))


def inert_action(name, value):
    # Conductor WEB-PACK-1-R3b ruling: only action's trimmed javascript:void(0), with ASCII scheme case folding, is admitted.
    return name == 'action' and re.fullmatch(r'(?ai:javascript):void\(0\)', value.strip(C0_SPACE)) is not None


def local_url(value):
    value = value.strip(C0_SPACE)
    check(not any(ord(c) < 32 for c in value), 'CSP', 'control in fixture URL')
    check(not value.lower().startswith(('http:', 'https:', '//', 'javascript:',
                                       'data:', 'blob:', 'ws:', 'wss:', 'file:', 'ftp:')),
          'CSP', 'nonlocal fixture URL is forbidden')
    return value


def safe_script(source):
    # Conservative token scan, not a JavaScript sandbox: refuse on doubt,
    # including escaped spellings and sinks in strings. Built-ins only per
    # conductor WEB-PACK-1-R4: external pages cannot contain scripts/handlers.
    check('\\' not in source, 'CSP', 'escaped script tokens are forbidden')
    source = re.sub(r'/\*.*?\*/', '', source, flags=re.S)
    check(not re.search(r'\b(?:location|eval|Function|pushState|replaceState)\b|'
                        r'\bopen\s*\(|\bdocument\s*\.\s*write\b|'
                        r'\bset(?:Timeout|Interval)\s*\(\s*[\'"`]|'
                        r'\bimport\s*\(', source),
          'CSP', 'navigation or dynamic script sink is forbidden')


def safe_style(source):
    # Refuse CSS escapes/comments rather than guessing their decoded URL tokens.
    check('\\' not in source and '/*' not in source,
          'CSP', 'ambiguous CSS tokens are forbidden')
    for match in re.finditer(r'url\s*\(([^)]*)(?:\)|$)', source, re.I):
        value = match[1].strip(C0_SPACE).strip('\'"')
        value = local_url(value)
        check(not re.match(r'[a-z][a-z0-9+.-]*:', value, re.I),
              'CSP', 'scheme CSS URL is forbidden')
PAGE_KEYS = frozenset(('Return', 'Enter', 'Tab', 'shift+Tab', 'Escape', 'Space',
                       'Backspace', 'Left', 'Right', 'Up', 'Down', 'Home', 'End',
                       'PageUp', 'PageDown'))


class PackError(RuntimeError):
    def __init__(self, code, detail):
        self.code = code
        super().__init__(detail)


def check(condition, code, detail):
    if not condition:
        raise PackError('E2E_PACK_' + code, detail)


def bounded_file(path, boundary, cap):
    resolved = path.resolve(strict=True)
    check(resolved.is_relative_to(boundary), 'ESCAPE', 'file escapes pack containment')
    fd = os.open(resolved, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        check(stat.S_ISREG(info.st_mode), 'FILE', 'pack entry must be a regular file')
        check(info.st_size <= cap, 'SIZE', 'pack file exceeds size cap')
        raw = stream.read(cap + 1)
    check(len(raw) <= cap, 'SIZE', 'pack file exceeds size cap')
    return raw


class PageFacts(HTMLParser):
    def __init__(self, html, *, builtin=False):
        super().__init__(convert_charrefs=True)
        self.builtin = builtin
        self.csp = False
        self.policies = []
        self.text = []
        self.raw_tag = None
        self.allowed_js = 0
        self.feed(html)
        check(len(re.findall(r'javascript\s*:', html, re.I)) == self.allowed_js,
              'CSP', 'javascript URL is forbidden anywhere')

    def handle_starttag(self, tag, attrs):
        # Reject duplicate attributes instead of choosing a different value
        # than the browser. HTMLParser already normalizes attribute names.
        check(len({name for name, _ in attrs}) == len(attrs), 'CSP', 'duplicate HTML attributes')
        attrs = dict(attrs)
        if not self.builtin:
            check(tag not in ('script', 'iframe', 'frame', 'object', 'embed'),
                  'SCRIPT', 'external packs require static HTML')
            check(not any(name.startswith('on') for name in attrs),
                  'SCRIPT', 'external event handlers are forbidden')
            if tag == 'form' and 'action' in attrs:
                check(inert_action('action', attrs['action'] or ''),
                      'SCRIPT', 'external form action is forbidden')
        raw_attrs = re.sub(r'^<[^\s/>]+', '', self.get_starttag_text(), count=1)
        for match in re.finditer(r'''([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?''', raw_attrs):
            raw_value = next((v for v in match.groups()[1:] if v is not None), '')
            if inert_action(match[1].lower(), unescape(raw_value)):
                self.allowed_js += len(re.findall(r'javascript\s*:', raw_value, re.I))
        check(not re.search(r'javascript\s*:', tag), 'CSP', 'javascript tag is forbidden')
        check(tag != 'base', 'CSP', 'base elements are forbidden')
        if tag == 'link':
            check(not set(attrs.get('rel', '').lower().split()) &
                  {'preload', 'prefetch', 'dns-prefetch', 'preconnect'},
                  'CSP', 'speculative resource links are forbidden')
        for name, value in attrs.items():
            value = value or ''
            check(not re.search(r'javascript\s*:', name, re.I), 'CSP', 'javascript attribute is forbidden')
            if inert_action(name, value):
                continue
            check(not re.search(r'javascript\s*:', value, re.I),
                  'CSP', 'javascript URL is forbidden anywhere')
            if name in URL_ATTRIBUTES:
                local_url(value)
            elif name in ('srcset', 'ping', 'archive'):
                value = local_url(value)
                candidates = value.split(',') if name == 'srcset' else value.split()
                for candidate in candidates:
                    words = candidate.strip(C0_SPACE).split()
                    if words:
                        local_url(words[0])
            elif name == 'style':
                safe_style(value)
            elif name.startswith('on'):
                safe_script(value)
        if tag in ('script', 'style'):
            self.raw_tag = tag
        if tag == 'meta' and 'http-equiv' in attrs:
            check((attrs['http-equiv'] or '').lower() in
                  ('content-security-policy', 'content-type'),
                  'CSP', 'meta http-equiv is not allowlisted')
        if tag == 'meta' and attrs.get('http-equiv', '').lower() == 'content-security-policy':
            policy = {}
            for directive in attrs.get('content', '').split(';'):
                words = directive.strip().split()
                if not words:
                    continue
                name, sources = words[0].lower(), words[1:]
                check(name not in policy, 'CSP', 'duplicate CSP directive')
                check(all(token in {"'none'", "'self'", "'unsafe-inline'"} for token in sources),
                      'CSP', 'nonlocal CSP source token')
                policy[name] = tuple(sorted(sources))
            check(policy.get('default-src') == ("'none'",), 'CSP', 'default-src none required')
            if not self.builtin:
                check(policy.get('script-src', policy['default-src']) == ("'none'",),
                      'SCRIPT', 'external CSP must disable scripts')
            check(not self.policies or policy == self.policies[0], 'CSP', 'disagreeing CSP meta tags')
            self.policies.append(policy)
            self.csp = True

    handle_startendtag = handle_starttag

    def handle_endtag(self, tag):
        if tag == self.raw_tag:
            self.raw_tag = None

    def handle_data(self, data):
        if self.raw_tag == 'script':
            safe_script(data)
        elif self.raw_tag == 'style':
            safe_style(data)
        self.text.append(data.strip())


class Pack:
    def __init__(self, directory):
        try:
            self.root = Path(directory).resolve(strict=True)
            self.builtin = self.root.is_relative_to(BUILTINS.resolve(strict=True))
            check(self.root.is_dir(), 'FILE', 'pack directory required')
            document = loads_strict(bounded_file(self.root / 'automation.json', self.root, JSON_CAP))
            if isinstance(document, dict) and document.get('mode') == 'live':
                raise PackError('E2E_PACK_LIVE', 'live mode requires WEB-NET-2')
            schema = loads_strict(SCHEMA_PATH.read_bytes())
            validator = Validator(SCHEMA_PATH.parent)
            validator.validate(document, schema)
            # The wire validator intentionally has no dynamic-map vocabulary.
            # Validate the two JSON Schema map keywords explicitly here.
            fixture_schema = schema['properties']['fixtures']
            for page, pin in document['fixtures'].items():
                validator.validate(page, fixture_schema['propertyNames'])
                validator.validate(pin, fixture_schema['additionalProperties'])
            check(document['start'] in document['fixtures'], 'START', 'start must name a pinned fixture')
            check(document['start'] != 'flow_a' or 'flow_b' in document['fixtures'],
                  'START', 'flow_a requires pinned flow_b for runner blob links')
            check(all(s[4:] in PAGE_KEYS for s in document['steps'] if s.startswith('key:')),
                  'STEPS', 'key chord is not page-safe')
            if 'report_cell' in document:
                check(document['report_cell']['index'] < len(document['expect']),
                      'SCHEMA', 'report_cell index outside expect')
            check(len(set(document['expect'])) == len(document['expect']),
                  'SCHEMA', 'expect markers must be unique')
            self.document = document
            self.pages = {}
            self.facts = {}
            pages = self.root / 'pages'
            check(pages.resolve(strict=True) == pages, 'ESCAPE', 'pages directory cannot be a symlink')
            total = 0
            for page, pin in document['fixtures'].items():
                raw = bounded_file(pages / (page + '.html'), pages, PAGE_CAP)
                total += len(raw)
                check(total <= TOTAL_CAP, 'SIZE', 'pack HTML exceeds total size cap')
                check(hashlib.sha256(raw).hexdigest() == pin.lower(), 'PIN', 'fixture sha256 mismatch: ' + page)
                html = raw.decode('utf-8')
                facts = PageFacts(html, builtin=self.builtin)
                check(facts.csp, 'CSP', 'fixture CSP default-src none missing: ' + page)
                self.pages[page], self.facts[page] = html, facts
            initial = self.facts[document['start']].text
            markers = [x for x in document['expect'] if x in initial]
            check(bool(markers), 'MARKER', 'start page must contain an expected AX marker')
            self.marker = markers[0]
            reads = [s[5:] for s in document['steps'] if s.startswith('read:')]
            check(bool(reads) and document['steps'][-1].startswith('read:'),
                  'STEPS', 'pack must end with an explicit read proof')
            check(all(x == 'table' or x in document['expect'] for x in reads),
                  'STEPS', 'read region must be table or an expect marker')
            self.read_expected = {r: (document['expect'] if (len(reads) == 1 and r == document['expect'][0]) or r == 'table' else [r])
                                  for r in reads}
            proven = [m for r in reads for m in self.read_expected[r]]
            check(proven == document['expect'], 'STEPS', 'reads must prove expect in order exactly once')
            check(sum(not s.startswith('read:') for s in document['steps']) <= document['budget'],
                  'BUDGET', 'planned inputs exceed budget')
        except PackError:
            raise
        except ValidationError as error:
            raise PackError('E2E_PACK_SCHEMA', str(error)) from error
        except UnicodeError as error:
            raise PackError('E2E_PACK_ENCODING', 'pack must be UTF-8') from error
        except (OSError, RuntimeError, ValueError) as error:
            raise PackError('E2E_PACK_FILE', 'pack entry unavailable: ' + str(error)) from error


def load_packs(explicit=(), automations_dir=None):
    """Explicit packs replace built-ins; environment subdirectories append to either."""
    try:
        directories = list(explicit) or [BUILTINS / name for name in DEFAULT_PACK_NAMES]
        if automations_dir:
            root = Path(automations_dir).resolve(strict=True)
            for child in sorted(root.iterdir()):
                check(not child.is_symlink() or child.resolve(strict=True).is_relative_to(root),
                      'ESCAPE', 'automation subdirectory escapes discovery root')
                if child.is_dir():
                    directories.append(child)
        check(0 < len(directories) <= PACK_CAP, 'SIZE', 'pack count outside admission cap')
        packs = [Pack(p) for p in directories]
        names = [p.document['name'] for p in packs]
        check(len(set(names)) == len(names), 'NAME', 'duplicate pack names')
        return packs
    except PackError:
        raise
    except (OSError, RuntimeError) as error:
        raise PackError('E2E_PACK_FILE', 'automation directory unavailable') from error
