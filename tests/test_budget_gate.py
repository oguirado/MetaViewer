"""Offline AC-14 controls; no Electron or host signals required."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('budget_gate', ROOT / 'tools/budget_gate.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class BudgetTests(unittest.TestCase):
    def setUp(self):
        self.budget = gate.load_budgets(ROOT / 'tests/perf/budgets.json')
        self.clean = gate.read_json(ROOT / 'tests/perf/clean.json')

    def test_matrix_and_constant_instruments(self):
        receipt = gate.self_test(self.budget)
        self.assertEqual(receipt['failed'], 0)
        self.assertGreater(receipt['passed'], 0)
        for count in receipt['constant_instrument_mismatches'].values():
            self.assertGreater(count, 0)

    def test_boundaries_and_each_role(self):
        for role, bound in gate.CAPS.items():
            with self.subTest(role=role):
                row = copy.deepcopy(self.clean)
                row['samples'][0][role] = bound
                if role != 'rss_tree_bytes':
                    row['samples'][0]['rss_tree_bytes'] = 1100000000
                self.assertTrue(gate.evaluate(row, self.budget)['ok'])
                row['samples'][0][role] += 1
                self.assertFalse(gate.evaluate(row, self.budget)['ok'])

    def test_malformed_budget_rejected(self):
        for value in (None, True, 0, -1, 1.5, float('inf'), 200000001):
            row = copy.deepcopy(self.budget)
            row['budgets'][0]['bound'] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                gate.validate_budgets(row)
        for mutate in (lambda r: r.update(extra=1), lambda r: r['budgets'].pop(),
                       lambda r: r['budgets'][0].update(extra=1)):
            row = copy.deepcopy(self.budget)
            mutate(row)
            with self.assertRaises(ValueError):
                gate.validate_budgets(row)

    def test_missing_inconsistent_or_false_evidence(self):
        mutations = [lambda r: r.update(samples=[]), lambda r: r.update(duration_ms=1),
                     lambda r: r['samples'][0].pop('rss_main_bytes'),
                     lambda r: r['samples'][0].update(rss_renderer_bytes=None),
                     lambda r: r['samples'][0].update(rss_main_bytes=True),
                     lambda r: r['samples'][0].update(rss_tree_bytes=1),
                     lambda r: r['samples'][1].update(at_ms=0),
                     lambda r: r.update(workload=[]), lambda r: r.update(orphans=[42])]
        for mutate in mutations:
            row = copy.deepcopy(self.clean)
            mutate(row)
            self.assertFalse(gate.evaluate(row, self.budget)['ok'])

    def test_cli_leak_nonzero_and_clean_pass(self):
        for file, rc in [('clean.json', 0), ('leak-renderer.json', 1)]:
            result = subprocess.run([sys.executable, str(ROOT / 'tools/budget_gate.py'),
                                     '--receipt', str(ROOT / 'tests/perf' / file)],
                                    text=True, capture_output=True, check=False)
            self.assertEqual(result.returncode, rc, result.stderr)
            self.assertEqual(json.loads(result.stdout)['failed'], int(rc != 0))

    def test_reused_cleanup_guards_without_signals(self):
        api = gate.cleanup_api()
        process = Mock(pid=42)
        for pid in (True, 0, 1, -1, 99):
            fake_os = Mock()
            fake_os.getpid.return_value = 99
            fake_os.getpgrp.return_value = 7
            fake_os.getpgid.return_value = 7
            with patch.dict(api, descendants=lambda _: [pid], process_identity=lambda _: 'same', os=fake_os):
                with self.assertRaises(ValueError):
                    api['stop_process_tree'](process)
            fake_os.kill.assert_not_called()
        fake_os = Mock()
        fake_os.getpid.return_value = 99
        fake_os.getpgrp.return_value = 7
        fake_os.getpgid.return_value = 8
        with patch.dict(api, descendants=lambda _: [42], process_identity=lambda _: 'same', os=fake_os, time=Mock()):
            api['stop_process_tree'](process)
        self.assertEqual([c.args[0] for c in fake_os.kill.call_args_list], [42, 42])


if __name__ == '__main__':
    unittest.main()
