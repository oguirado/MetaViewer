#!/usr/bin/env python3
"""Query the routed map of this repository: where things are, how they fail, what must hold.

Findings are unreviewed model output, pinned to a commit. Each row is marked against the
working tree: FRESH (cited code unchanged), SHIFT (same bytes, moved), STALE (changed or
gone), UNKNOWN (citation never resolved). They are coordinates, not proof: read the code.
Empty rows mean not indexed, not absent. Reads only; writes nothing. Standard library only.

docs and any return a shortlist under 2000 bytes and 20 rows, or {"abstain": "no_query_term"}
when discriminating query terms lack corpus evidence. check verifies the docs index, every anchor,
every link and every study span, and prints ROUTE_OK.
"""
import argparse
from collections import Counter
from functools import cached_property, lru_cache
import importlib.util
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'route'
STOP = frozenset('the a an of in on to is are was for and or with without when then that this it its by from at as be not no never only almost every about gets get gives give after first second real what how why must hold holds where which does do'.split())
TEST = re.compile(r'(^|/)(test|tests|testdata|__tests__|e2e|fixtures?|goldens?)(/|$)|_test\.|\.test\.|\.spec\.')
MANIFESTS = frozenset({'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'requirements.txt', 'deps.lock'})
CODE = frozenset({'.rs', '.go', '.c', '.h', '.py', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.sh', '.ps1'})
LITERALS = (re.compile(r'"((?:[^"\\\n]|\\.){6,200})"'), re.compile(r"'((?:[^'\\\n]|\\.){6,200})'"), re.compile(r'`([^`\n]{6,200})`'))
RRF = 60
RANKED = 30
SHORTLIST_BYTES = 2000
SHORTLIST_ROWS = 20
BM25_K1, BM25_B = 1.2, 0.75
DOC_FIELDS = {'title': 3.0, 'answers': 3.0, 'doc': 2.0, 'body': 1.0}
LEVELS = ('extract', 'part', 'folder', 'root', 'dossier')


def load_docs_tool(root=ROOT):
    spec = importlib.util.spec_from_file_location('route_docs', Path(root) / 'tools' / 'route_docs.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def stem(word):
    """Conservative English inflections; shared by questions and all evidence fields."""
    if not word.isalpha():
        return word
    if len(word) > 4 and word.endswith('ies'):
        word = word[:-3] + 'y'
    elif len(word) > 4 and word.endswith('s') and not word.endswith(('ss', 'us', 'is')):
        word = word[:-1]
    for suffix in ('ing', 'ed'):
        base = word[:-len(suffix)]
        if word.endswith(suffix) and len(base) > 2 and re.search('[aeiouy]', base):
            word = base
            if len(word) > 2 and word[-1] == word[-2] and word[-1] not in 'lsz':
                word = word[:-1]
            break
    if len(word) > 4 and word.endswith('e'):
        word = word[:-1]
    if len(word) > 2 and word.endswith('y'):
        word = word[:-1] + 'i'
    return word


def words(value):
    value = re.sub(r'([a-z0-9])([A-Z][a-z])', r'\1 \2', value)
    return [stem(word.lower()) for word in re.findall(r'[A-Za-z0-9]+', value)]


STOP = frozenset(words(' '.join(STOP)))


def terms(query):
    return sorted({word for word in words(query) if word not in STOP and len(word) > 1})


def exact_phrase(text, query):
    phrase = [word for word in words(text) if word not in STOP]
    question = [word for word in words(query) if word not in STOP]
    return len(phrase) >= 2 and any(question[i:i + len(phrase)] == phrase
                                    for i in range(len(question) - len(phrase) + 1))


def digest(data):
    return hashlib.sha256(data).hexdigest()[:16]


def jsonl(path):
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line] if path.exists() else []


class Map:
    def __init__(self, root=ROOT, data=DATA):
        self.root, self.data = Path(root), Path(data)
        self.manifest = json.loads((self.data / 'manifest.json').read_text(encoding='utf-8'))
        self.skip = re.compile(self.manifest['skip'])
        self.symbols = [{'path': row[0], 'name': row[1], 'kind': row[2], 'start': row[3], 'end': row[4]} for row in jsonl(self.data / 'symbols.jsonl')]
        self.nodes = self.merge_study(jsonl(self.data / 'nodes.jsonl'))
        self.docs_index = jsonl(self.data / 'docs.jsonl')
        self.bytes_cache = {}

    def merge_study(self, base):
        """Study rows first; an older extract row is dropped when a study row cites the same file."""
        study = []
        for path in sorted((self.data / 'study').glob('*.jsonl')) if (self.data / 'study').is_dir() else []:
            study.extend(dict(row, origin=path.stem) for row in jsonl(path) if row.get('s') is not None)
        covered = {cite[0].split('::', 1)[0] for row in study for cite in row['s'][:1]}
        kept = [row for row in base if not (row['l'] == 'extract' and row['s'] and row['s'][0][0].split('::', 1)[0] in covered)]
        return study + kept

    def read(self, path):
        """Bytes with CRLF normalised, so a Windows checkout compares equal to the pin."""
        if path not in self.bytes_cache:
            target = (self.root / path).resolve()
            if not target.is_relative_to(self.root.resolve()):
                raise ValueError('E_PATH_OUTSIDE_ROOT: ' + path)
            self.bytes_cache[path] = target.read_bytes().replace(b'\r\n', b'\n') if target.is_file() else None
        return self.bytes_cache[path]

    def tracked(self):
        done = subprocess.run(['git', '-C', str(self.root), 'ls-files', '-z'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False) if shutil.which('git') else None
        if done is not None and done.returncode == 0 and done.stdout:
            names = done.stdout.decode('utf-8', 'surrogateescape').split('\0')
        else:
            names = [path.relative_to(self.root).as_posix() for path in self.root.rglob('*') if path.is_file() and '.git' not in path.parts]
        return sorted(name for name in names if name and (Path(name).suffix in CODE or Path(name).name in MANIFESTS) and (self.root / name).is_file())

    @cached_property
    def source_names(self):
        return [name for name in self.tracked() if not self.skip.search(name) and not TEST.search(name)]

    def source_files(self):
        return self.source_names

    def cite(self, cite):
        return self._cite(tuple(cite))

    @lru_cache(maxsize=None)
    def _cite(self, cite):
        """[sid, hash, start, length] -> state and current coordinates."""
        sid, sha, start, length = cite
        path = sid.split('::', 1)[0]
        if sha is None:
            return 'UNKNOWN', path, None, None
        data = self.read(path)
        if data is None:
            return 'STALE', path, None, None
        if length is None:
            return ('FRESH' if digest(data) == sha else 'STALE'), path, None, None
        if digest(data[start:start + length]) == sha:
            return 'FRESH', path, start, start + length
        if length > start and digest(data[start:length]) == sha:
            return 'FRESH', path, start, length
        position = data.find(b'\n')
        lines = [0]
        while position != -1:
            lines.append(position + 1)
            position = data.find(b'\n', position + 1)
        hits = [offset for offset in lines if offset + length <= len(data) and digest(data[offset:offset + length]) == sha]
        if len(hits) == 1:
            return 'SHIFT', path, hits[0], hits[0] + length
        return 'STALE', path, None, None

    def row(self, node, score=None):
        states, code = [], []
        for cite in node['s'][:6]:
            state, path, start, end = self.cite(cite)
            states.append(state)
            if len(code) < 3:
                code.append(f'{path}@{start}-{end}' if start is not None else path)
        worst = next((state for state in ('STALE', 'UNKNOWN', 'SHIFT') if state in states), 'FRESH')
        row = {'state': worst, 'level': node['l'], 'folder': node['f'], 'kind': node['k'], 'text': node['t'], 'sids': [cite[0] for cite in node['s'][:4]], 'code': code, 'unit': 'bytes'}
        if node.get('origin'):
            row['study'] = node['origin']
        if score is not None:
            row['score'] = round(score, 3)
        return row

    def rank_nodes(self, query, level=None):
        wanted = terms(query)
        nodes = [node for node in self.nodes if level is None or node['l'] == level]
        if not wanted or not nodes:
            return []
        documents = [set(words(node['t'])) | set(words(' '.join(cite[0].rsplit('::', 1)[-1] for cite in node['s']))) for node in nodes]
        frequency = {word: sum(1 for document in documents if word in document) for word in wanted}
        weight = {word: math.log(1 + (len(documents) + 1) / (1 + frequency[word])) for word in wanted}
        scored = []
        for index, document in enumerate(documents):
            score = sum(weight[word] for word in wanted if word in document)
            if score > 0:
                scored.append((-score, index))
        return [(-score, nodes[index]) for score, index in sorted(scored)]

    def ask(self, query, k, level=None):
        out, seen = [], set()
        for score, node in self.rank_nodes(query, level):
            if node['t'] in seen:
                continue
            seen.add(node['t'])
            out.append(self.row(node, score))
            if len(out) == k:
                break
        return out

    def rank_symbols(self, query):
        wanted = set(terms(query))
        scores = {}
        for symbol in self.symbols:
            score = len(set(words(symbol['name'])) & wanted)
            if score:
                scores.setdefault(symbol['path'], 0)
                scores[symbol['path']] = max(scores[symbol['path']], score)
        return rank(scores)

    def find(self, query, k):
        exact = [symbol for symbol in self.symbols if symbol['name'].rsplit('.', 1)[-1] == query or symbol['name'] == query]
        wanted = set(terms(query))
        scored = []
        for index, symbol in enumerate(self.symbols):
            score = len(set(words(symbol['name'])) & wanted)
            if score and symbol not in exact:
                scored.append((-score, index))
        rows = exact + [self.symbols[index] for _, index in sorted(scored)]
        return [dict(symbol, sid=symbol['path'] + '::' + symbol['name'], unit='bytes') for symbol in rows[:k]]

    def where(self, query, k):
        wanted = set(terms(query))
        scores = {name: len(set(words(name)) & wanted) for name in self.tracked_all()}
        purposes = {}
        for node in self.nodes:
            if node['k'] == 'purpose' and node['l'] == 'extract' and node['s']:
                path = node['s'][0][0].split('::', 1)[0]
                purposes[path] = len(set(words(node['t'])) & wanted)
        for path, score in purposes.items():
            scores[path] = scores.get(path, 0) + score / 2
        return [{'path': path} for path in rank(scores)[:k]]

    def tracked_all(self):
        done = subprocess.run(['git', '-C', str(self.root), 'ls-files', '-z'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False) if shutil.which('git') else None
        if done is not None and done.returncode == 0 and done.stdout:
            return [name for name in done.stdout.decode('utf-8', 'surrogateescape').split('\0') if name]
        return [path.relative_to(self.root).as_posix() for path in self.root.rglob('*') if path.is_file() and '.git' not in path.parts]

    def literals(self, files):
        rows = []
        for name in files:
            text = (self.root / name).read_text(encoding='utf-8', errors='replace')
            for pattern in (LITERALS[:1] if name.endswith(('.rs', '.c', '.h')) else LITERALS):
                for match in pattern.finditer(text):
                    found = set(words(match.group(1)))
                    if found:
                        rows.append((name, match.group(1), found, text.count('\n', 0, match.start()) + 1))
        return rows

    @cached_property
    def source_literals(self):
        return self.literals(self.source_files())

    def error(self, query, k):
        wanted = terms(query)
        if not wanted:
            return []
        rows = self.source_literals
        frequency = {word: sum(1 for row in rows if word in row[2]) for word in wanted}
        weight = {word: math.log(1 + (len(rows) + 1) / (1 + frequency[word])) for word in wanted}
        scored = []
        for name, text, found, line in rows:
            score = sum(weight[word] for word in wanted if word in found)
            if score > 0:
                exact = exact_phrase(text, query)
                scored.append((not exact, -score, name, line, text))
        return [{'path': name, 'line': line, 'text': text[:160], 'score': round(-score, 3)} for _, score, name, line, text in sorted(scored)[:k]]

    def locate(self, query, k):
        files = self.source_files()
        wanted = set(terms(query))
        by_file = {}
        for row in self.error(query, 200):
            by_file.setdefault(row['path'], row['line'])
        finding_files = []
        for _, node in self.rank_nodes(query)[:RANKED * 2]:
            finding_files.extend(cite[0].split('::', 1)[0] for cite in node['s'][:1])
        rankings = {'path': rank({name: len(set(words(name)) & wanted) for name in files}), 'symbol': self.rank_symbols(query), 'literal': list(by_file)[:RANKED], 'finding': list(dict.fromkeys(finding_files))[:RANKED]}
        votes, via = {}, {}
        for source, ordered in rankings.items():
            for position, name in enumerate(ordered, 1):
                votes[name] = votes.get(name, 0) + 1 / (RRF + position)
                via.setdefault(name, []).append(source)
        return [{'path': name, 'via': via[name], 'line': by_file.get(name, 1)} for name, _ in sorted(votes.items(), key=lambda item: (-item[1], item[0]))[:k]]

    def file(self, path, k):
        symbols = [symbol for symbol in self.symbols if symbol['path'] == path]
        rows, seen = [], set()
        for node in self.nodes:
            if node['l'] == 'extract' and any(cite[0].split('::', 1)[0] == path for cite in node['s']) and node['t'] not in seen:
                seen.add(node['t'])
                rows.append(self.row(node))
        return {'path': path, 'exists': (self.root / path).is_file(), 'symbol_count': len(symbols), 'symbols': symbols[:k * 5], 'finding_count': len(rows), 'findings': rows[:k * 5], 'tests': self.tests(Path(path).stem, k)}

    def folder(self, path, k):
        rows = [node for node in self.nodes if node['f'] == path.rstrip('/') and node['l'] in ('folder', 'root')]
        return {'folder': path, 'summary': next((node['t'] for node in rows if node['k'] == 'summary'), None), 'finding_count': len(rows), 'findings': [self.row(node) for node in rows if node['k'] != 'summary'][:k * 5]}

    def folders(self):
        rows = {}
        for node in self.nodes:
            if node['l'] in ('folder', 'root') and node['k'] == 'summary':
                rows[node['f']] = node['t'][:200]
        return [{'folder': name, 'summary': text} for name, text in sorted(rows.items())]

    def tests(self, query, k):
        if len(query) < 3:
            return []
        out = []
        for name in self.tracked():
            if TEST.search(name) and query in (self.root / name).read_text(encoding='utf-8', errors='replace'):
                out.append(name)
        return out[:k]

    def show(self, query):
        if '#' in query:
            path, anchor = query.split('#', 1)
            data = self.read(path)
            if data is None:
                raise ValueError('E_SHOW_FILE: ' + path)
            tool = load_docs_tool()
            heads = tool.headings(data)
            names = tool.anchors(data)
            if not anchor and data.strip():
                start = 0
                end = next((h[2] for h in heads if h[0] >= 2), len(data))
                if not data[:end].strip():
                    raise ValueError('E_SHOW_ANCHOR: ' + query)
            elif anchor in names:
                index = names.index(anchor)
                depth, _, start, _ = heads[index]
                end = next((h[2] for h in heads[index + 1:] if h[0] <= depth), len(data))
            else:
                raise ValueError('E_SHOW_ANCHOR: ' + query)
            return {'path': path, 'anchor': anchor, 'unit': 'bytes', 'start': start, 'end': end,
                    'code': data[start:end].decode('utf-8', 'replace')}
        match = re.match(r'^(.*)@(\d+)-(\d+)$', query)
        if match:
            path, start, end = match.group(1), int(match.group(2)), int(match.group(3))
        else:
            hit = next((symbol for symbol in self.symbols if symbol['path'] + '::' + symbol['name'] == query), None)
            path, start, end = (hit['path'], hit['start'], hit['end']) if hit else (query, 0, None)
        data = self.read(path)
        if data is None:
            raise ValueError('E_SHOW_FILE: ' + path)
        if start < 0 or start >= len(data) or (end is not None and (end <= start or end > len(data))):
            raise ValueError('E_SHOW_SPAN: ' + query)
        return {'path': path, 'unit': 'bytes', 'start': start, 'end': len(data) if end is None else end,
                'code': data[start:end].decode('utf-8', 'replace')}

    def stats(self):
        states = {}
        if self.nodes:
            for node in self.nodes[::max(1, len(self.nodes) // 200)]:
                state = self.row(node)['state']
                states[state] = states.get(state, 0) + 1
        return {key: self.manifest.get(key) for key in ('corpus', 'study_pin', 'symbols_at', 'review', 'removed_count')} | {'symbols': len(self.symbols), 'findings': len(self.nodes), 'freshness_sample': states}

    def new_symbols(self, k):
        if not shutil.which('ctags'):
            raise SystemExit('E_NO_CTAGS: this command needs Universal Ctags; every other command works without it')
        done = subprocess.run(['ctags', '--output-format=json', '--fields=+n', '-L', '-', '-f', '-'], cwd=str(self.root), input='\n'.join(self.source_files()).encode(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
        known = {(symbol['path'], symbol['name'].rsplit('.', 1)[-1]) for symbol in self.symbols}
        rows = [json.loads(line) for line in done.stdout.splitlines() if line.startswith(b'{"_type": "tag"')]
        return [{'path': row['path'], 'name': row['name'], 'line': row.get('line')} for row in rows if (row['path'], row['name']) not in known][:k]


    def doc_section(self, node):
        data = self.read(node['path'])
        if data is None:
            return None, 'STALE'
        section = data[node['start']:node['end']]
        return section, ('FRESH' if hashlib.sha256(section).hexdigest() == node['sha256'] else 'STALE')

    def rank_docs(self, query, level=None):
        """Field-weighted BM25: title and Answers 3, document path and H1 2, section text 1."""
        wanted = terms(query)
        nodes = [node for node in self.docs_index if level != 'dossier' or node['path'].startswith('docs/dossiers/')]
        if not wanted or not nodes:
            return []
        fields, states = [], []
        for node in nodes:
            section, state = self.doc_section(node)
            fields.append({'title': words(node['title']), 'answers': words(node['answers']),
                           'doc': words(node['path']) + words(node.get('doc_title', '')),
                           'body': words(section.decode('utf-8', 'replace')) if section else []})
            states.append(state)
        sets = [set().union(*field.values()) for field in fields]
        frequency = {word: sum(1 for found in sets if word in found) for word in wanted}
        wanted = [word for word in wanted if frequency[word]]
        if not wanted:
            return []
        idf = {word: math.log(1 + (len(nodes) - frequency[word] + 0.5) / (frequency[word] + 0.5)) for word in wanted}
        average = {name: max(1.0, sum(len(field[name]) for field in fields) / len(fields)) for name in DOC_FIELDS}
        scored = []
        for index, field in enumerate(fields):
            if not sets[index] & set(wanted):
                continue
            score = 0.0
            for name, weight in DOC_FIELDS.items():
                bag = field[name]
                if not bag:
                    continue
                norm = BM25_K1 * (1 - BM25_B + BM25_B * len(bag) / average[name])
                for word in wanted:
                    count = bag.count(word)
                    if count:
                        score += weight * idf[word] * count * (BM25_K1 + 1) / (count + norm)
            scored.append((-score, index))
        return [(-score, nodes[index], states[index]) for score, index in sorted(scored)]

    def docs(self, query, k, level=None):
        if self.unsupported(query):
            return []
        rows = []
        for score, node, state in self.rank_docs(query, level)[:k]:
            rows.append({'ref': f"{node['path']}#{node['anchor']}", 'at': f"{node['path']}:{node['line']}", 'title': node['title'][:90], 'answers': node['answers'][:120], 'state': state, 'score': round(score, 2)})
        return rows

    @cached_property
    def evidence(self):
        """Live lexical records. Evaluation data and router internals never supply evidence."""
        records = []
        files = [name for name in self.tracked() if not self.skip.search(name) and not name.startswith(('route/', 'tools/route_')) and name != 'tests/test_route_docs.py']
        for path in files:
            text = self.read(path).decode('utf-8', 'replace')
            if Path(path).name == 'package.json':
                try:
                    parsed = json.loads(text)
                except json.JSONDecodeError:
                    parsed = None
                manifest = parsed if isinstance(parsed, dict) else {}
            metadata = ''
            if Path(path).name == 'package.json' and isinstance(manifest.get('engines', {}), dict):
                metadata = 'package version ' + ' '.join('required ' + engine + ' version' for engine in manifest.get('engines', {}))
            elif Path(path).name == 'pyproject.toml':
                metadata = 'package version required python version'
            lines = text.splitlines()
            # Overlapping passages preserve local evidence in large source files.
            passages = [(line + 1, Counter(words('\n'.join(lines[line:line + 32]))))
                        for line in range(0, len(lines), 16)]
            records.append({'type': 'code', 'path': path, 'test': bool(TEST.search(path)),
                            'bag': Counter(words(text)), 'title': Counter(words(path + ' ' + metadata)),
                            'passages': passages})
        for node in self.docs_index:
            section, state = self.doc_section(node)
            if state != 'FRESH':
                continue
            if node['path'].startswith('route/'):
                continue
            text = section.decode('utf-8', 'replace')
            records.append({'type': 'doc', 'path': node['path'], 'node': node,
                            'bag': Counter(words(text)),
                            'title': Counter(words(node['title'] + ' ' + node['answers'])),
                            'text': text})
        for node in self.nodes:
            if any(cite[0].startswith(('route/', 'tools/route_')) for cite in node['s']):
                continue
            row = self.row(node)
            if row['state'] not in ('FRESH', 'SHIFT'):
                continue
            records.append({'type': 'finding', 'node': node, 'row': row,
                            'bag': Counter(words(node['t'])), 'title': Counter()})
        return records

    @cached_property
    def vocabulary(self):
        frequency = Counter()
        for record in self.evidence:
            frequency.update(set(record['bag']) | set(record['title']))
        return frequency

    @lru_cache(maxsize=None)
    def unsupported(self, query):
        """Require coherent inverse-frequency coverage, retaining unseen term weight.

        Missing rare vocabulary outweighs generic matches. In a long question,
        an incidental unfamiliar word need not suppress strong local evidence.
        """
        wanted = terms(query)
        if not wanted:
            return []
        total = len(self.evidence)
        weights = {word: math.log(1 + (total + .5) / (self.vocabulary[word] + .5))
                   for word in wanted}
        # Short feature queries must connect their rarest terms. Longer prose
        # can contain incidental verbs; require a majority of its IDF mass.
        if len(wanted) <= 5:
            rare = sorted(wanted, key=lambda word: (self.vocabulary[word], word))[:2]
            if any(not self.vocabulary[word] for word in rare):
                return rare
            if len(rare) == 2 and not any(all(word in record['bag'] or word in record['title']
                                            for word in rare) for record in self.evidence):
                return rare
            return []
        required = sum(weights.values()) / 2
        for record in self.evidence:
            covered = sum(weight for word, weight in weights.items()
                          if word in record['bag'] or word in record['title'])
            if covered >= required:
                return []
        return wanted

    def any(self, query, k, level=None):
        """Rank corroborated file evidence, not an interleaving of source lists."""
        wanted = terms(query)
        if not wanted or self.unsupported(query):
            return []
        total = len(self.evidence)
        weights = {word: math.log(1 + (total + .5) / (self.vocabulary[word] + .5)) for word in wanted}
        proof = bool(set(wanted) & set(words('test prove proof conformance')))

        def score(bag, title):
            length = sum(bag.values())
            value = 0.0
            for word in wanted:
                count = bag[word]
                if count:
                    value += weights[word] * count * 2.2 / (count + 1.2 * (.25 + .75 * length / 160))
                if title[word]:
                    value += 2 * weights[word]
            coverage = sum(weights[word] for word in wanted if bag[word] or title[word]) / sum(weights.values())
            return value * coverage * coverage

        candidates = {}
        def add(key, value, row, kind):
            candidate = candidates.setdefault(key, {'best': {}, 'row': row, 'value': -1})
            candidate['best'][kind] = max(value, candidate['best'].get(kind, 0))
            if value > candidate['value']:
                candidate['row'], candidate['value'] = row, value

        for record in self.evidence:
            kind = record['type']
            if kind == 'code':
                if level == 'dossier' or (record['test'] and not proof):
                    continue
                passage = max(((score(bag, record['title']), line) for line, bag in record['passages']), default=(0, 1))
                value, line = passage
                if record['test'] and proof:
                    value *= 1.35
                row = {'type': 'code', 'path': record['path'], 'line': line}
                add(record['path'], value, row, kind)
            elif kind == 'doc':
                node = record['node']
                if level == 'dossier' and not node['path'].startswith('docs/dossiers/'):
                    continue
                value = score(record['bag'], record['title'])
                row = {'type': 'doc', 'ref': f"{node['path']}#{node['anchor']}",
                       'at': f"{node['path']}:{node['line']}", 'title': node['title'][:90], 'state': 'FRESH'}
                references = {}
                for line in record['text'].splitlines():
                    relevance = score(Counter(words(line)), Counter())
                    for path in set(re.findall(r'[\w./-]+\.(?:py|rs|go|js|sh|toml|json)', line)) & self.source_set:
                        if relevance > 0:
                            references[path] = max(references.get(path, 0), relevance)
                if references:
                    row['code'] = sorted(references, key=lambda path: (-references[path], path))[:3]
                add(row['ref'], value, row, kind)
                for path, relevance in references.items():
                    if path in candidates and candidates[path]['value'] > 0:
                        support = relevance * .8 / math.sqrt(max(1, len(references)))
                        add(path, support, candidates[path]['row'], kind)
            else:
                node, old = record['node'], record['row']
                if level and node['l'] != level:
                    continue
                value = score(record['bag'], record['title'])
                for code in old['code']:
                    path = code.split('@', 1)[0]
                    if path in self.source_set:
                        if TEST.search(path) and not proof:
                            continue
                        row = {'type': 'finding', 'state': old['state'], 'code': [code],
                               'unit': 'bytes', 'text': node['t'][:130]}
                        add(path, value, row, kind)
        # A literal phrase embedded in a natural-language question outranks fuzzy evidence.
        for hit in self.error(query, RANKED):
            literal = hit['text'].lower().strip()
            if exact_phrase(literal, query):
                row = {'type': 'code', 'path': hit['path'], 'line': hit['line'], 'error': hit['text']}
                add(hit['path'], sum(weights.values()) * 4, row, 'exact')
        ordered = []
        for key, candidate in candidates.items():
            scores = sorted(candidate['best'].values(), reverse=True)
            if not scores or scores[0] <= 0:
                continue
            value = scores[0] + .35 * sum(scores[1:])
            row = dict(candidate['row'], via=sorted(candidate['best']))
            ordered.append((-value, key, row))
        return [row for _, _, row in sorted(ordered)[:k]]

    @cached_property
    def source_set(self):
        return set(record['path'] for record in self.evidence if record['type'] == 'code')


def shortlist(rows, abstain=None):
    """Compact JSON, one row per line, at most SHORTLIST_ROWS rows and SHORTLIST_BYTES bytes."""
    if abstain:
        return json.dumps({'abstain': abstain, 'rows': []})
    head, tail = '{"note":"coordinates, not proof","rows":[', '\n]}'
    lines = []
    for row in rows[:SHORTLIST_ROWS]:
        line = json.dumps(row, ensure_ascii=False, separators=(',', ':'))
        candidate = head + ','.join('\n' + item for item in lines + [line]) + tail
        if len(candidate.encode('utf-8')) + 1 > SHORTLIST_BYTES:
            break
        lines.append(line)
    return head + ','.join('\n' + item for item in lines) + tail


def rank(scores):
    ordered = sorted((item for item in scores.items() if item[1] > 0), key=lambda item: (-item[1], item[0]))
    return [path for path, _ in ordered[:RANKED]]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=['any', 'docs', 'check', 'locate', 'ask', 'find', 'where', 'error', 'file', 'folder', 'map', 'tests', 'show', 'stats', 'new'])
    parser.add_argument('query', nargs='?', default='')
    parser.add_argument('--k', type=int, default=8)
    parser.add_argument('--level', choices=LEVELS, default=None, help='only findings of this level; dossier also limits docs to docs/dossiers/')
    args = parser.parse_args(argv)
    if args.k < 1:
        parser.error('--k must be positive')
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    if args.command == 'check':
        failures = load_docs_tool().check(ROOT)
        for failure in failures[:50]:
            print(failure)
        print(f'ROUTE_FAIL {len(failures)} failure(s)' if failures else 'ROUTE_OK')
        return 1 if failures else 0
    route = Map()
    if args.command in ('docs', 'any'):
        rows = getattr(route, args.command)(args.query, min(args.k, SHORTLIST_ROWS), args.level)
        reason = 'unsupported_query' if route.unsupported(args.query) else 'no_query_term'
        print(shortlist(rows, None if rows else reason))
        return 0
    if args.command == 'ask':
        print(json.dumps({'rows': route.ask(args.query, args.k, args.level)}, indent=1, ensure_ascii=False))
        return 0
    if args.command == 'file':
        out = route.file(args.query, args.k)
    elif args.command == 'folder':
        out = route.folder(args.query, args.k)
    elif args.command == 'show':
        try:
            out = route.show(args.query)
        except ValueError as exc:
            print(str(exc), file=sys.stderr)
            return 1
    elif args.command == 'stats':
        out = route.stats()
    elif args.command == 'map':
        out = {'rows': route.folders()}
    elif args.command == 'new':
        out = {'rows': route.new_symbols(args.k)}
    else:
        out = {'rows': getattr(route, args.command)(args.query, args.k)}
    print(json.dumps(out, indent=1, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
