"""Protected deletion stops before any store or native access; no real identities."""
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('p18e_identity', os.environ.get('P18E_IDENTITY_SOURCE', str(ROOT/'tools/mv_identity.py')))
mv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mv)


class ProtectionTests(unittest.TestCase):
    def test_protected_delete_has_no_store_or_native_side_effects(self):
        tool = mv.Identities.__new__(mv.Identities)
        tool.live_profile = 'p18e-configured-live'
        tool.show = Mock(side_effect=AssertionError('MUTANT_STORE_ACCESS'))
        tool.native = Mock(side_effect=AssertionError('MUTANT_NATIVE_ACCESS'))
        tool.profile_helper = Mock(side_effect=AssertionError('MUTANT_PROFILE_REMOVAL'))
        for identity in ['cuentas-1', 'cuentas-99', 'perplexity-1', 'perplexity-other',
                         'srf-id-cuentas-1', 'srf-id-perplexity-1', 'srf-pg-notepad-1',
                         'srf-pg-metaviewer-1', 'srf-pg-other', 'srf-egress-proxy',
                         'n8n', 'distil-box', 'mv-live-1', 'mv-live-4', 'p18e-configured-live']:
            with self.subTest(identity=identity):
                with self.assertRaisesRegex(mv.Refused, '^IDENTITY_PROTECTED$'):
                    tool.delete(identity)
        tool.show.assert_not_called()
        tool.native.assert_not_called()
        tool.profile_helper.assert_not_called()

    def test_owned_identity_reaches_normal_deletion_validation(self):
        tool = mv.Identities.__new__(mv.Identities)
        tool.live_profile = 'mv-live-3'
        tool.show = Mock(side_effect=RuntimeError('NORMAL_DELETE_VALIDATION'))
        with self.assertRaisesRegex(RuntimeError, '^NORMAL_DELETE_VALIDATION$'):
            tool.delete('p18e-owned')
        tool.show.assert_called_once_with('p18e-owned')


if __name__ == '__main__':
    unittest.main()
