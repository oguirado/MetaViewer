"""[TARGET, unit decision] Keep provisional budget caps honest about evidence."""

import copy
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


def assert_target_basis(profile):
    """Reject unsupported citations in the profile and every budget row."""
    for entry in (profile, *profile['budgets']):
        basis = entry.get('basis')
        if not isinstance(basis, str) or '[TARGET' not in basis or '[CITED]' in basis:
            raise AssertionError('budget basis must be [TARGET] without [CITED]')
    if 'AC-14: AUSENTE' not in profile['basis']:
        raise AssertionError('AC-14 absence must remain tracked in the profile basis')


class BudgetBasisTests(unittest.TestCase):
    def setUp(self):
        self.profile = json.loads((ROOT / 'tests/perf/budgets.json').read_text(encoding='utf-8'))

    def test_checked_in_budget_basis_is_target_with_absence_tracked(self):
        assert_target_basis(self.profile)

    def test_cited_fixture_is_rejected_at_every_basis(self):
        for index in range(1 + len(self.profile['budgets'])):
            for basis in ('[CITED] AC-14', '[TARGET, unit decision]; [CITED] AC-14'):
                with self.subTest(index=index, basis=basis):
                    fixture = copy.deepcopy(self.profile)
                    entry = ([fixture] + fixture['budgets'])[index]
                    entry['basis'] = basis
                    with self.assertRaisesRegex(AssertionError, 'without'):
                        assert_target_basis(fixture)

    def test_absence_cannot_be_removed_from_target_basis(self):
        fixture = copy.deepcopy(self.profile)
        for entry in fixture['budgets']:
            entry['basis'] = '[TARGET, unit decision] frozen cap'
        fixture['basis'] = '[TARGET, unit decision] frozen caps'
        with self.assertRaisesRegex(AssertionError, 'absence'):
            assert_target_basis(fixture)


if __name__ == '__main__':
    unittest.main()
