import json
from pathlib import Path
import hashlib
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'route'))
import route_query as tool

BLOCKED = re.compile('/' + 'home/|/' + 'tmp/cl' + 'aude|/' + 'Users/|Documentos/|M' + 'usica/|M' + '\u00fasica/|wender-agent|vision-engine|(?i:opensuperficies)|(?i:cuentas|perplexity)-[0-9]+|[A-Za-z0-9._+-]+@[A-Za-z0-9-]+[.][a-z]{2,}')


class RouteTest(unittest.TestCase):
    def tree(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / 'core').mkdir()
        (root / 'tests').mkdir()
        (root / 'route').mkdir()
        body = b'fn alpha() { fail("frame arrived too late"); }\nfn beta() {}\n'
        (root / 'core/pacer.rs').write_bytes(body)
        (root / 'tests/test_pacer.py').write_text('alpha = "frame arrived too late"\n', encoding='utf-8')
        span = body[:47]
        sha = hashlib.sha256(span).hexdigest()[:16]
        whole = hashlib.sha256(body).hexdigest()[:16]
        (root / 'route/manifest.json').write_text(json.dumps({'skip': '^$', 'corpus': 'x'}), encoding='utf-8')
        (root / 'route/symbols.jsonl').write_text(json.dumps(['core/pacer.rs', 'alpha', 'function', 0, 46]) + '\n', encoding='utf-8')
        (root / 'route/nodes.jsonl').write_text(json.dumps({'l': 'extract', 'f': 'core', 'k': 'symptom', 't': 'recording stops with a stall', 's': [['core/pacer.rs::alpha', sha, 0, 47]]}) + '\n' + json.dumps({'l': 'extract', 'f': 'core', 'k': 'purpose', 't': 'pacer file', 's': [['core/pacer.rs', whole, None, None]]}) + '\n', encoding='utf-8')
        return root, body

    def test_answers_and_refusals(self):
        root, _ = self.tree()
        route = tool.Map(root, root / 'route')
        self.assertEqual(route.error('frame arrived too late', 3)[0]['path'], 'core/pacer.rs')
        self.assertEqual(route.ask('recording stall', 1)[0]['kind'], 'symptom')
        self.assertEqual(route.find('alpha', 1)[0]['path'], 'core/pacer.rs')
        self.assertEqual(route.locate('recording stall', 3)[0]['path'], 'core/pacer.rs')
        self.assertEqual(route.ask('zqxjkvq', 3), [])
        self.assertEqual(route.error('the of and', 3), [])
        self.assertEqual(route.tests('alpha', 3), ['tests/test_pacer.py'])

    def test_freshness_must_fail_on_change(self):
        root, body = self.tree()
        state = lambda: tool.Map(root, root / 'route').ask('recording stall', 1)[0]['state']
        self.assertEqual(state(), 'FRESH')
        (root / 'core/pacer.rs').write_bytes(body.replace(b'\n', b'\r\n'))
        self.assertEqual(state(), 'FRESH')
        (root / 'core/pacer.rs').write_bytes(b'// moved\n' + body)
        self.assertEqual(state(), 'SHIFT')
        (root / 'core/pacer.rs').write_bytes(body.replace(b'too late', b'too soon'))
        self.assertEqual(state(), 'STALE')
        (root / 'core/pacer.rs').unlink()
        self.assertEqual(state(), 'STALE')

    def test_published_data_stays_filtered(self):
        manifest = ROOT / 'route/manifest.json'
        nodes = ROOT / 'route/nodes.jsonl'
        if not nodes.exists():
            self.skipTest('findings not installed')
        removed = set(json.loads(manifest.read_text(encoding='utf-8'))['removed_sha256'])
        for line in nodes.read_text(encoding='utf-8').splitlines():
            text = json.loads(line)['t']
            self.assertIsNone(BLOCKED.search(text))
            self.assertNotIn(hashlib.sha256(text.encode()).hexdigest(), removed)


if __name__ == '__main__':
    unittest.main()
