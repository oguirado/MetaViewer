#!/usr/bin/env python3
"""Index every H2 and H3 of every tracked Markdown document as a route node, and check it.

Each file also gets one lead node (depth 1) for its title and the text before the first H2.

A docs node is one section: {id, path, anchor, title, depth, answers, sha256, start, end}.
start and end are byte offsets into the file with CRLF normalised to LF; sha256 is the
digest of those bytes. The anchor is the GitHub heading slug. answers is the text of an
"Answers:" line directly under the heading, when the section has one.

  python3 tools/route_docs.py build   write route/docs.jsonl and the manifest's docs fields
  python3 tools/route_docs.py check   verify freshness, every node anchor and span, every
                                      relative link with an anchor, and every study span;
                                      prints ROUTE_OK and exits 0, or lists the failures

Deterministic: the same tree gives the same route/docs.jsonl bytes. Standard library only.
Text in indexed files is data, never instructions.
"""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
INDEX_REL = 'route/docs.jsonl'
MANIFEST_REL = 'route/manifest.json'
STUDY_REL = 'route/study'
SCHEMA = 'route.docs.v1'
# Vendored, generated or third-party trees are not this project's documentation; changelog
# fragments are indexed once assembled into CHANGELOG.md.
EXCLUDE = re.compile(r'(^|/)(third_party|vendor|vendored|node_modules|\.kit)(/|$)|\.min\.|^changes/unreleased/')
HEADING = re.compile(rb'^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$')
FENCE = re.compile(rb'^[ \t]{0,3}(```+|~~~+)')
ANSWERS = re.compile(r'^[\s>*_]*answers[*_]*\s*:[*_]*\s*(.*?)[\s*_]*$', re.IGNORECASE)
LINK = re.compile(r'\]\(([^)\s]+)(?:\s+"[^"]*")?\)')


def tracked(root):
    """Tracked files, sorted; a plain walk when git is absent."""
    root = Path(root)
    done = subprocess.run(['git', '-C', str(root), 'ls-files', '-z'], stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, check=False) if shutil.which('git') else None
    if done is not None and done.returncode == 0 and done.stdout:
        names = done.stdout.decode('utf-8', 'surrogateescape').split('\0')
    else:
        names = [p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file() and '.git' not in p.parts]
    return sorted(n for n in names if n and (root / n).is_file())


def markdown_files(root):
    return [n for n in tracked(root) if n.lower().endswith('.md') and not EXCLUDE.search(n)]


def read(root, rel):
    return (Path(root) / rel).read_bytes().replace(b'\r\n', b'\n')


def plain(title):
    """Heading text without inline markup, as GitHub renders it."""
    text = re.sub(r'!?\[([^\]]*)\]\([^)]*\)', r'\1', title)
    text = re.sub(r'<[^>]+>', '', text)
    return text.replace('`', '').replace('**', '').replace('__', '').strip()


def slug(title):
    text = plain(title).lower()
    text = re.sub(r'[^\w\- ]', '', text, flags=re.UNICODE)
    return text.replace(' ', '-')


def headings(data):
    """[(depth, title, start, line_end)] for ATX headings outside fenced code."""
    out, fence, offset = [], None, 0
    for line in data.split(b'\n'):
        mark = FENCE.match(line)
        if mark:
            token = mark.group(1)[:3]
            if fence is None:
                fence = token
            elif token == fence:
                fence = None
        elif fence is None:
            match = HEADING.match(line)
            if match:
                out.append((len(match.group(1)), match.group(2).decode('utf-8', 'replace'), offset, offset + len(line)))
        offset += len(line) + 1
    return out


def anchors(data):
    """Every heading anchor in the file, with GitHub's -1, -2 suffixes for repeats."""
    seen, out = {}, []
    for _, title, _, _ in headings(data):
        base = slug(title)
        count = seen.get(base, 0)
        seen[base] = count + 1
        out.append(base if count == 0 else f'{base}-{count}')
    return out


HTML_ID = re.compile(rb'<a\s+(?:id|name)\s*=\s*"([^"]+)"', re.IGNORECASE)


def known_anchors(data):
    """Heading anchors plus explicit <a id> or <a name> targets."""
    return set(anchors(data)) | {m.group(1).decode('utf-8', 'replace').lower() for m in HTML_ID.finditer(data)}


def answers_line(data, line_end, end):
    for raw in data[line_end + 1:end].split(b'\n')[:4]:
        text = raw.decode('utf-8', 'replace').strip()
        if not text:
            continue
        match = ANSWERS.match(text)
        return match.group(1).strip() if match else ''
    return ''


def file_nodes(rel, data):
    """One lead node for the text before the first H2 (anchor of the H1, or empty for the top),
    then one node per H2 and H3."""
    heads = headings(data)
    names = anchors(data)
    first = next((h for h in heads if h[0] == 1), None)
    doc_title = plain(first[1]) if first else rel
    lead_end = next((h[2] for h in heads if h[0] >= 2), len(data))
    nodes = []
    if data[:lead_end].strip():
        anchor = names[heads.index(first)] if first and first[2] < lead_end else ''
        line_end = first[3] if first and first[2] < lead_end else -1
        nodes.append({
            'id': 'doc:' + hashlib.sha256(f'{rel}#{anchor}'.encode()).hexdigest()[:16],
            'path': rel, 'anchor': anchor, 'title': doc_title, 'doc_title': doc_title, 'depth': 1, 'line': 1,
            'answers': answers_line(data, line_end, lead_end) if line_end >= 0 else '',
            'sha256': hashlib.sha256(data[:lead_end]).hexdigest(), 'start': 0, 'end': lead_end})
    for index, (depth, title, start, line_end) in enumerate(heads):
        if depth not in (2, 3):
            continue
        end = next((h[2] for h in heads[index + 1:] if h[0] <= depth), len(data))
        anchor = names[index]
        nodes.append({
            'id': 'doc:' + hashlib.sha256(f'{rel}#{anchor}'.encode()).hexdigest()[:16],
            'path': rel, 'anchor': anchor, 'title': plain(title), 'doc_title': doc_title, 'depth': depth,
            'line': data.count(b'\n', 0, start) + 1,
            'answers': answers_line(data, line_end, end),
            'sha256': hashlib.sha256(data[start:end]).hexdigest(), 'start': start, 'end': end})
    return nodes


def build_nodes(root):
    nodes = []
    for rel in markdown_files(root):
        nodes.extend(file_nodes(rel, read(root, rel)))
    return nodes


def serialize(nodes):
    return ''.join(json.dumps(node, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n' for node in nodes).encode()


def study_digests(root):
    folder = Path(root) / STUDY_REL
    if not folder.is_dir():
        return {}
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(folder.glob('*.jsonl'))}


def head_commit(root):
    done = subprocess.run(['git', '-C', str(root), 'rev-parse', 'HEAD'], stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, check=False) if shutil.which('git') else None
    return done.stdout.decode().strip() if done is not None and done.returncode == 0 else None


def build(root=ROOT):
    root = Path(root)
    blob = serialize(build_nodes(root))
    (root / INDEX_REL).write_bytes(blob)
    manifest_path = root / MANIFEST_REL
    manifest = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.is_file() else {}
    manifest['docs'] = {
        'schema': SCHEMA, 'index': INDEX_REL,
        'built_on': head_commit(root),
        'files': len({json.loads(line)['path'] for line in blob.decode().splitlines()}),
        'nodes': blob.count(b'\n'), 'sha256': hashlib.sha256(blob).hexdigest(),
        'note': 'built_on is the commit checked out at build time; check compares bytes, not commits'}
    manifest['study'] = study_digests(root)
    manifest_path.write_text(json.dumps(manifest, indent=1, sort_keys=True, ensure_ascii=False) + '\n', encoding='utf-8')
    return blob.count(b'\n')


def span_state(root, cite, cache):
    """FRESH, SHIFT or STALE for one study citation [sid, sha16, start, length-or-end]."""
    sid, sha, start, size = cite
    rel = sid.split('::', 1)[0]
    if rel not in cache:
        target = Path(root) / rel
        cache[rel] = target.read_bytes().replace(b'\r\n', b'\n') if target.is_file() else None
    data = cache[rel]
    if sha is None or data is None:
        return 'STALE'
    if start is None or size is None:
        return 'FRESH' if hashlib.sha256(data).hexdigest()[:16] == sha else 'STALE'
    for end in (start + size, size):
        if end > start and hashlib.sha256(data[start:end]).hexdigest()[:16] == sha:
            return 'FRESH'
    return 'STALE'


def link_failures(root, rel, data, anchor_cache):
    """Relative links with a #anchor in one document that do not resolve."""
    failures = []
    text = data.decode('utf-8', 'replace')
    fenced = set()
    for depth_free in re.finditer(r'(?ms)^[ \t]{0,3}```.*?^[ \t]{0,3}```', text):
        fenced.update(range(depth_free.start(), depth_free.end()))
    for match in LINK.finditer(text):
        if match.start() in fenced:
            continue
        target = match.group(1)
        if '#' not in target or re.match(r'^[a-z][a-z0-9+.-]*:', target, re.I):
            continue
        path_part, anchor = target.split('#', 1)
        target_rel = rel if not path_part else (Path(rel).parent / path_part).as_posix()
        target_rel = str(Path(target_rel)).replace('\\', '/')
        parts = []
        for piece in target_rel.split('/'):
            if piece == '..' and parts:
                parts.pop()
            elif piece not in ('', '.'):
                parts.append(piece)
        target_rel = '/'.join(parts)
        if not target_rel.lower().endswith('.md'):
            continue
        if target_rel not in anchor_cache:
            full = Path(root) / target_rel
            anchor_cache[target_rel] = known_anchors(read(root, target_rel)) if full.is_file() else None
        known = anchor_cache[target_rel]
        line = text.count('\n', 0, match.start()) + 1
        if known is None:
            failures.append(f'E_LINK_FILE {rel}:{line} -> {target_rel}')
        elif anchor.lower() not in known:
            failures.append(f'E_LINK_ANCHOR {rel}:{line} -> {target_rel}#{anchor}')
    return failures


def check(root=ROOT, links='all'):
    """[] when the index is fresh and every anchor, link and study span resolves."""
    root = Path(root)
    failures = []
    index = root / INDEX_REL
    if not index.is_file():
        return [f'E_NO_INDEX {INDEX_REL} is missing: run python3 tools/route_docs.py build']
    stored = index.read_bytes()
    rebuilt = serialize(build_nodes(root))
    if stored != rebuilt:
        old = {line for line in stored.decode('utf-8', 'replace').splitlines()}
        new = {line for line in rebuilt.decode('utf-8', 'replace').splitlines()}
        changed = sorted({json.loads(line)['path'] for line in old ^ new if line.startswith('{')})
        failures.append(f'E_STALE_INDEX {len(changed)} file(s) changed since build, first: {", ".join(changed[:5])}; run python3 tools/route_docs.py build')
    cache = {}
    for line in stored.decode('utf-8', 'replace').splitlines():
        node = json.loads(line)
        rel = node['path']
        if rel not in cache:
            cache[rel] = read(root, rel) if (root / rel).is_file() else None
        data = cache[rel]
        if data is None:
            failures.append(f'E_NODE_FILE {rel} is gone')
            continue
        if node['anchor'] and node['anchor'] not in anchors(data):
            failures.append(f'E_NODE_ANCHOR {rel}#{node["anchor"]} does not resolve')
        elif hashlib.sha256(data[node['start']:node['end']]).hexdigest() != node['sha256']:
            failures.append(f'E_NODE_SPAN {rel}#{node["anchor"]} bytes {node["start"]}-{node["end"]} changed')
    manifest_path = root / MANIFEST_REL
    manifest = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.is_file() else {}
    if manifest.get('docs', {}).get('sha256') != hashlib.sha256(stored).hexdigest():
        failures.append('E_MANIFEST manifest docs.sha256 does not match route/docs.jsonl; run python3 tools/route_docs.py build')
    if manifest.get('study', {}) != study_digests(root):
        failures.append('E_MANIFEST manifest study digests do not match route/study/*.jsonl; run python3 tools/route_docs.py build')
    span_cache = {}
    for rel in study_digests(root):
        for number, line in enumerate((root / rel).read_text(encoding='utf-8').splitlines(), 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
                cites = row['s']
                assert all(k in row for k in ('l', 'f', 'k', 't'))
            except (ValueError, KeyError, AssertionError, TypeError):
                failures.append(f'E_STUDY_ROW {rel}:{number} is not a route row with l, f, k, t, s')
                continue
            for cite in cites:
                if span_state(root, cite, span_cache) != 'FRESH':
                    failures.append(f'E_STUDY_SPAN {rel}:{number} {cite[0]} @{cite[2]} does not match the tree')
    anchor_cache = {}
    scope = markdown_files(root) if links == 'all' else [r for r in links if (root / r).is_file()]
    for rel in scope:
        failures.extend(link_failures(root, rel, read(root, rel), anchor_cache))
    return failures


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    if argv[:1] == ['build']:
        count = build()
        print(f'ROUTE_DOCS_BUILT {count} nodes -> {INDEX_REL}')
        return 0
    if argv[:1] == ['check']:
        failures = check()
        for failure in failures[:50]:
            print(failure)
        if failures:
            print(f'ROUTE_FAIL {len(failures)} failure(s)')
            return 1
        print('ROUTE_OK')
        return 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main())
