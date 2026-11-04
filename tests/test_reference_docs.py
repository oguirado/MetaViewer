"""Check the reference's navigation and evidence contracts without live effects."""
import json
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
REFERENCE = ROOT / 'docs/REFERENCE.md'
SECTIONS = (
    'reading-map', 'result-contract', 'definitions', 'architecture',
    'engineering-triptych', 'domain-contracts', 'limits', 'reproducibility',
)
TAG = re.compile(r'\[(?:MEASURED|CITED|TARGET)(?:\]|:)')
ANCHOR = re.compile(r'^<a id="([a-z][a-z-]*)"></a>$', re.MULTILINE)
COORDINATE = re.compile(r'(?<![\w/.-])([/\w.-]+):(\d+)\b')
QUANTITY = re.compile(r'(?<![\w])\d+(?:[.,x]\d+)*(?![\w])')


def validate_reference(markdown, root=ROOT):
    """Return diagnostics; existence is not a claim of semantic entailment."""
    errors = []
    metadata = re.match(r'\A```json\n(.*?)\n```', markdown, re.DOTALL)
    if not metadata:
        return ['missing top metadata block']
    try:
        data = json.loads(metadata[1])
    except json.JSONDecodeError:
        return ['invalid metadata JSON']
    if data.get('schema') != 'metaviewer.reference/v1':
        errors.append('wrong reference schema')
    if data.get('version') != (root / 'VERSION').read_text().strip():
        errors.append('version differs from checkout')
    if data.get('licence') != 'AGPL-3.0-only':
        errors.append('wrong licence')
    if set(data.get('private_components', [])) != {
            'wender-agent', 'vision-engine', 'OpenSuperficies'}:
        errors.append('private boundary incomplete')
    if not data.get('status') or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', data.get('date', '')):
        errors.append('missing status or date')
    evidence = data.get('evidence', {})
    for field in ('schema', 'version', 'date', 'licence', 'private_components'):
        if not isinstance(evidence.get(field), str) or not TAG.search(evidence[field]):
            errors.append(f'untagged metadata {field}')
    anchors = ANCHOR.findall(markdown)
    if len(anchors) != len(set(anchors)):
        errors.append('duplicate anchor')
    if data.get('canonical_anchors') != list(SECTIONS):
        errors.append('canonical section map differs')
    for anchor in SECTIONS:
        if anchor not in anchors:
            errors.append(f'missing canonical anchor {anchor}')
    for target in re.findall(r'\]\(#([^)]*)\)', markdown):
        if target not in anchors:
            errors.append(f'broken internal link {target}')
    lines = markdown.splitlines()
    in_fence = False
    top_sections = []
    for index, line in enumerate(lines):
        if line.startswith('```'):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if line.startswith('#'):
            if index == 0 or not ANCHOR.fullmatch(lines[index - 1]):
                errors.append(f'heading lacks stable anchor: {line}')
            if line.startswith('## '):
                top_sections.append(line.split('.')[0].removeprefix('## '))
        # Numeric prose must declare provenance; code identifiers/coordinates
        # are checked separately and shell command fences are executable syntax.
        prose = re.sub(r'`[^`]*`|\]\([^)]*\)', '', line)
        inline_quantities = re.findall(r'`(\d+(?:[x.]\d+)*)`', line)
        if (QUANTITY.search(prose) or inline_quantities) and not TAG.search(line):
            errors.append(f'untagged numeric prose: {line}')
        if COORDINATE.search(line) and not TAG.search(line):
            errors.append(f'untagged coordinate: {line}')
    if top_sections != [str(index) for index in range(len(SECTIONS))]:
        errors.append('numbered section order differs')
    coordinates = COORDINATE.findall(markdown)
    if not coordinates:
        errors.append('no source coordinates')
    canonical_root = root.resolve()
    for relative, number in coordinates:
        path = (root / relative).resolve()
        if Path(relative).is_absolute() or not path.is_relative_to(canonical_root) or not path.is_file():
            errors.append(f'missing or escaping source {relative}:{number}')
            continue
        source = path.read_text(encoding='utf-8').splitlines()
        if not 1 <= int(number) <= len(source):
            errors.append(f'line outside source {relative}:{number}')
        elif not source[int(number) - 1].strip():
            errors.append(f'empty source line {relative}:{number}')
    return errors


class ReferenceDocsTests(unittest.TestCase):
    def setUp(self):
        self.markdown = REFERENCE.read_text(encoding='utf-8')

    def test_reference_contract(self):
        self.assertEqual(validate_reference(self.markdown), [])

    def test_missing_anchor_rejected(self):
        mutant = self.markdown.replace('<a id="authority"></a>', '')
        self.assertTrue(any('anchor' in e or 'link' in e for e in validate_reference(mutant)))

    def test_duplicate_anchor_rejected(self):
        mutant = self.markdown + '\n<a id="authority"></a>\n'
        self.assertIn('duplicate anchor', validate_reference(mutant))

    def test_missing_tag_rejected(self):
        mutant = self.markdown + '\nClaimed capacity: 999 capsules.\n'
        self.assertTrue(any('untagged numeric prose' in e for e in validate_reference(mutant)))

    def test_coordinate_tag_removal_rejected(self):
        mutant = self.markdown + '\n`VERSION:1`\n'
        self.assertTrue(any('untagged coordinate' in e for e in validate_reference(mutant)))

    def test_inline_quantity_tag_removal_rejected(self):
        mutant = self.markdown + '\nClaimed guest size: `999x999`.\n'
        self.assertTrue(any('untagged numeric prose' in e for e in validate_reference(mutant)))

    def test_absolute_coordinate_rejected(self):
        mutant = self.markdown + '\n`/absent-source.rs:1` [MEASURED]\n'
        self.assertTrue(any('missing or escaping source' in e for e in validate_reference(mutant)))

    def test_missing_file_rejected(self):
        mutant = self.markdown + '\n`absent-reference-source.rs:1` [MEASURED]\n'
        self.assertTrue(any('missing or escaping source' in e for e in validate_reference(mutant)))

    def test_out_of_range_line_rejected(self):
        mutant = self.markdown + '\n`VERSION:999999` [MEASURED]\n'
        self.assertTrue(any('line outside source' in e for e in validate_reference(mutant)))

    def test_zero_line_rejected(self):
        mutant = self.markdown + '\n`VERSION:0` [MEASURED]\n'
        self.assertTrue(any('line outside source' in e for e in validate_reference(mutant)))

    def test_parent_escape_rejected(self):
        mutant = self.markdown + '\n`../absent.rs:1` [MEASURED]\n'
        self.assertTrue(any('missing or escaping source' in e for e in validate_reference(mutant)))

    def test_wrong_licence_rejected(self):
        mutant = self.markdown.replace('"licence": "AGPL-3.0-only"', '"licence": "MIT"')
        self.assertIn('wrong licence', validate_reference(mutant))

    def test_missing_metadata_tag_rejected(self):
        mutant = self.markdown.replace('[MEASURED] VERSION:1', 'VERSION:1', 1)
        self.assertIn('untagged metadata version', validate_reference(mutant))


if __name__ == '__main__':
    unittest.main()
