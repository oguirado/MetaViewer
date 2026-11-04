"""Docs index, check and shortlist of the route/ router, with negative controls.

A broken anchor, a stale index and a tampered study span must each fail the check.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, REPO / rel)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DOCS = load('route_docs_under_test', 'tools/route_docs.py')
QUERY = load('route_query_under_test', 'route/route_query.py')
EVAL = load('route_eval_under_test', 'tools/route_eval.py')

GUIDE = """# Guide

Lead text about capsules.

## Install the wall

Answers: how do I install; setup steps

Run the installer.

### Without Docker

Use the native tier.

## Rewind a capsule

Back restores deleted files.
"""
LINKER = "# Links\n\n## See also\n\nRead [install](guide.md#install-the-wall) and [native](guide.md#without-docker).\n"
CODE = b"def admit(action):\n    return refuse_unknown(action)\n"


class TreeCase(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='route-docs-'))
        (self.root / 'docs').mkdir()
        (self.root / 'route').mkdir()
        (self.root / 'core').mkdir()
        (self.root / 'docs' / 'guide.md').write_text(GUIDE, encoding='utf-8')
        (self.root / 'docs' / 'links.md').write_text(LINKER, encoding='utf-8')
        (self.root / 'core' / 'admit.py').write_bytes(CODE)
        manifest = {'schema': 'route.manifest.v1', 'skip': r'(^|/)route(/|$)'}
        (self.root / 'route' / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        (self.root / 'route' / 'nodes.jsonl').write_text('', encoding='utf-8')

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def write_study(self, rows):
        (self.root / 'route' / 'study').mkdir(exist_ok=True)
        (self.root / 'route' / 'study' / 'core.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')

    def study_row(self, level='extract', start=0, end=len(CODE)):
        sha = hashlib.sha256(CODE[start:end]).hexdigest()[:16]
        return {'l': level, 'f': 'core', 'k': 'purpose', 't': 'admit refuses unknown actions', 's': [['core/admit.py::admit', sha, start, end - start]]}


class BuildTests(TreeCase):
    def test_nodes_cover_h2_h3_and_lead(self):
        nodes = [node for node in DOCS.build_nodes(self.root) if node['path'] == 'docs/guide.md']
        self.assertEqual([(node['depth'], node['anchor']) for node in nodes],
                         [(1, 'guide'), (2, 'install-the-wall'), (3, 'without-docker'), (2, 'rewind-a-capsule')])
        install = nodes[1]
        self.assertEqual(install['answers'], 'how do I install; setup steps')
        data = (self.root / 'docs' / 'guide.md').read_bytes()
        self.assertTrue(data[install['start']:install['end']].startswith(b'## Install the wall'))
        self.assertIn(b'### Without Docker', data[install['start']:install['end']])
        self.assertNotIn(b'## Rewind', data[install['start']:install['end']])
        self.assertEqual(hashlib.sha256(data[install['start']:install['end']]).hexdigest(), install['sha256'])

    def test_build_is_deterministic(self):
        DOCS.build(self.root)
        first = (self.root / 'route' / 'docs.jsonl').read_bytes()
        DOCS.build(self.root)
        self.assertEqual(first, (self.root / 'route' / 'docs.jsonl').read_bytes())

    def test_headings_in_fences_are_ignored(self):
        data = b"# T\n\n```\n## Not a heading\n```\n\n## Real\n"
        self.assertEqual([title for _, title, _, _ in DOCS.headings(data)], ['T', 'Real'])

    def test_repeated_headings_get_github_suffixes(self):
        self.assertEqual(DOCS.anchors(b"## Added\n## Added\n## Fixed `x`\n"), ['added', 'added-1', 'fixed-x'])


class CheckTests(TreeCase):
    def test_fresh_tree_passes(self):
        DOCS.build(self.root)
        self.assertEqual(DOCS.check(self.root), [])

    def test_negative_control_broken_anchor_fails(self):
        DOCS.build(self.root)
        guide = self.root / 'docs' / 'guide.md'
        guide.write_text(GUIDE.replace('## Install the wall', '## Installing'), encoding='utf-8')
        failures = DOCS.check(self.root)
        self.assertTrue(any(f.startswith('E_STALE_INDEX') for f in failures), failures)
        self.assertTrue(any(f.startswith('E_NODE_ANCHOR docs/guide.md#install-the-wall') for f in failures), failures)
        self.assertTrue(any(f.startswith('E_LINK_ANCHOR docs/links.md:5') for f in failures), failures)
        DOCS.build(self.root)
        self.assertTrue(any(f.startswith('E_LINK_ANCHOR') for f in DOCS.check(self.root)))

    def test_negative_control_broken_link_alone_fails(self):
        (self.root / 'docs' / 'links.md').write_text(LINKER.replace('#without-docker', '#no-such-section'), encoding='utf-8')
        DOCS.build(self.root)
        self.assertEqual([f.split(' ')[0] for f in DOCS.check(self.root)], ['E_LINK_ANCHOR'])

    def test_explicit_html_anchor_resolves(self):
        (self.root / 'docs' / 'guide.md').write_text(GUIDE + '\n<a id="oracle"></a>\n', encoding='utf-8')
        (self.root / 'docs' / 'links.md').write_text(LINKER + '\n[o](guide.md#oracle)\n', encoding='utf-8')
        DOCS.build(self.root)
        self.assertEqual(DOCS.check(self.root), [])

    def test_missing_index_fails(self):
        self.assertTrue(DOCS.check(self.root)[0].startswith('E_NO_INDEX'))

    def test_study_spans_verified(self):
        self.write_study([self.study_row()])
        DOCS.build(self.root)
        self.assertEqual(DOCS.check(self.root), [])
        self.write_study([self.study_row(end=len(CODE) - 1) | {'s': [['core/admit.py::admit', 'deadbeefdeadbeef', 0, 10]]}])
        DOCS.build(self.root)
        self.assertTrue(any(f.startswith('E_STUDY_SPAN') for f in DOCS.check(self.root)))

    def test_study_change_without_rebuild_fails(self):
        self.write_study([self.study_row()])
        DOCS.build(self.root)
        self.write_study([self.study_row(), self.study_row(level='dossier')])
        self.assertTrue(any(f.startswith('E_MANIFEST') for f in DOCS.check(self.root)))


class QueryTests(TreeCase):
    def route(self):
        DOCS.build(self.root)
        return QUERY.Map(self.root, self.root / 'route')

    def test_docs_ranks_title_and_answers(self):
        rows = self.route().docs('how do I install the wall', 5)
        self.assertEqual(rows[0]['ref'], 'docs/guide.md#install-the-wall')
        self.assertEqual(rows[0]['state'], 'FRESH')

    def test_docs_abstains_when_no_term_matches(self):
        self.assertEqual(self.route().docs('zzqx flurble', 5), [])
        self.assertEqual(json.loads(QUERY.shortlist([], 'no_query_term')), {'abstain': 'no_query_term', 'rows': []})

    def test_shortlist_stays_under_limits(self):
        rows = [{'ref': 'docs/x.md#a', 'title': 'y' * 150} for _ in range(40)]
        out = QUERY.shortlist(rows)
        self.assertLessEqual(len(out.encode('utf-8')), QUERY.SHORTLIST_BYTES)
        self.assertLessEqual(len(json.loads(out)['rows']), QUERY.SHORTLIST_ROWS)
        self.assertGreater(len(json.loads(out)['rows']), 0)

    def test_any_rejects_unknown_discriminating_term_with_shared_words(self):
        route = self.route()
        self.assertEqual(route.any('install the wall with nebulacluster', 5), [])
        self.assertIn('nebulacluster', route.unsupported('install the wall with nebulacluster'))
        # A new domain term becomes searchable when actual source evidence exists.
        (self.root / 'core' / 'nebula.py').write_text('def nebulacluster(): pass\n')
        self.assertTrue(self.route().any('nebulacluster', 5))

    def test_any_requires_discriminating_terms_to_cooccur(self):
        self.assertEqual(self.route().any('installer nebula', 5), [])
        (self.root / 'core' / 'other.py').write_text('nebula = True\n')
        (self.root / 'core' / 'install.py').write_text('installer = True\n')
        route = self.route()
        self.assertIn('installer', route.vocabulary)
        self.assertIn('nebula', route.vocabulary)
        self.assertEqual(route.any('installer nebula', 5), [])
        (self.root / 'core' / 'install.py').write_text('installer = "nebula"\n')
        self.assertTrue(self.route().any('installer nebula', 5))

    def test_mixed_case_platform_names_are_not_lost(self):
        self.assertIn('ios', QUERY.terms('run an iOS capsule'))
        self.assertEqual(self.route().any('iOS capsule', 5), [])

    def test_evaluation_files_never_supply_vocabulary(self):
        (self.root / 'route' / 'private_eval.py').write_text('invented_backend = "nebula"\n')
        (self.root / 'route' / 'manifest.json').write_text('{"skip": "^$"}')
        self.assertNotIn('nebula', self.route().vocabulary)

    def test_malformed_manifest_can_still_be_searched(self):
        (self.root / 'core' / 'package.json').write_text('{"invalid_json":')
        self.assertTrue(self.route().any('invalid json', 5))

    def test_show_refuses_files_outside_the_repository(self):
        with self.assertRaisesRegex(ValueError, 'E_PATH_OUTSIDE_ROOT'):
            self.route().show(str(REPO / 'LAWS.md'))

    def test_any_reads_manifests_and_proof_tests(self):
        (self.root / 'core' / 'package.json').write_text('{"engines": {"node": ">=24"}}')
        (self.root / 'tests').mkdir()
        (self.root / 'tests' / 'test_admit.py').write_text('def test_prove_admit(): assert admit()\n')
        route = self.route()
        self.assertIn('core/package.json', [r.get('path') for r in route.any('node engines', 5)])
        self.assertIn('tests/test_admit.py', [r.get('path') for r in route.any('test prove admit', 5)])
        self.assertNotIn('tests/test_admit.py', [r.get('path') for r in route.any('admit', 5)])
        self.assertIn('tests/test_admit.py', [r.get('path') for r in route.any('prove admit', 5)])

    def test_any_fuses_findings_by_cited_file(self):
        self.write_study([self.study_row()])
        rows = self.route().any('admit', 5)
        matching = [r for r in rows if r.get('path') == 'core/admit.py'
                    or any(c.startswith('core/admit.py@') for c in r.get('code', []))]
        self.assertEqual(len(matching), 1)
        self.assertEqual(matching[0]['via'], ['code', 'finding'])

    def test_exact_error_precedes_fuzzy_literal(self):
        (self.root / 'core' / 'admit.py').write_text(
            'raise Error("wall install failed")\nraise Error("install wall failed")\n')
        route = self.route()
        self.assertEqual(route.error('why install wall failed', 2)[0]['text'], 'install wall failed')
        self.assertEqual(route.any('install wall failed', 2)[0]['error'], 'install wall failed')

    def test_show_anchor_returns_only_section_in_bytes(self):
        route = self.route()
        row = route.show('docs/guide.md#install-the-wall')
        self.assertTrue(row['code'].startswith('## Install the wall'))
        self.assertIn('### Without Docker', row['code'])
        self.assertNotIn('## Rewind', row['code'])
        self.assertEqual(row['unit'], 'bytes')
        self.assertEqual(row['code'].encode(), (self.root / row['path']).read_bytes()[row['start']:row['end']])

    def test_show_empty_anchor_returns_an_indexed_lead(self):
        (self.root / 'docs' / 'untitled.md').write_text('Lead text.\n\n## Body\nBody text.\n')
        row = self.route().show('docs/untitled.md#')
        self.assertEqual(row['code'], 'Lead text.\n\n')

    def test_show_missing_anchor_file_or_invalid_span_fails(self):
        route = self.route()
        for reference in ('docs/guide.md#missing', 'missing.md', 'core/admit.py@99-100',
                          'core/admit.py@9-4'):
            with self.subTest(reference=reference), self.assertRaises(ValueError):
                route.show(reference)

    def test_study_rows_replace_older_rows_for_the_same_file(self):
        old = {'l': 'extract', 'f': 'core', 'k': 'purpose', 't': 'old finding', 's': [['core/admit.py::admit', '0000000000000000', 0, 5]]}
        (self.root / 'route' / 'nodes.jsonl').write_text(json.dumps(old) + '\n', encoding='utf-8')
        self.write_study([self.study_row()])
        texts = [node['t'] for node in self.route().nodes]
        self.assertEqual(texts, ['admit refuses unknown actions'])

    def test_end_byte_citation_is_fresh(self):
        row = self.study_row()
        row['s'][0][3] = len(CODE)
        self.write_study([dict(row, s=[['core/admit.py::admit', row['s'][0][1], 4, len(CODE)]])])
        route = self.route()
        sha = hashlib.sha256(CODE[4:]).hexdigest()[:16]
        self.assertEqual(route.cite(['core/admit.py::admit', sha, 4, len(CODE)])[0], 'FRESH')

    def test_level_dossier_filters(self):
        self.write_study([self.study_row(), self.study_row(level='dossier') | {'t': 'admission dossier summary'}])
        rows = self.route().ask('admit refuses', 5, 'dossier')
        self.assertEqual([row['level'] for row in rows], ['dossier'])
        self.assertEqual(self.route().docs('install', 5, 'dossier'), [])


class EvaluationTests(unittest.TestCase):
    def test_gold_file_requires_a_coordinate_boundary(self):
        self.assertIsNone(EVAL.rank_of([{'path': 'ui/package.json.bak'}], ['ui/package.json']))
        self.assertEqual(EVAL.rank_of([{'ref': 'docs/guide.md#install'}], ['docs/guide.md']), 1)
        self.assertEqual(EVAL.rank_of([{'code': ['core/a.rs@10-20']}], ['core/']), 1)


class RepositoryTests(unittest.TestCase):
    def test_repository_index_is_fresh(self):
        self.assertEqual(DOCS.check(REPO), [], 'run python3 tools/route_docs.py build')

    def test_entry_files_name_the_router(self):
        for rel in ('llms.txt', 'AGENTS.md'):
            text = (REPO / rel).read_text(encoding='utf-8')
            self.assertIn('python3 route/route_query.py any', text, rel)
        self.assertIn('AGENTS.md', (REPO / 'CLAUDE.md').read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
