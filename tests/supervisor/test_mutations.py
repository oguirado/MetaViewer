"""Unique mutation anchors are part of the test instrument's contract."""
import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("mutations", pathlib.Path(__file__).with_name("check_mutations.py"))
mutations = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mutations)


class Anchors(unittest.TestCase):
    def test_duplicate_and_missing_anchors_fail_loudly(self):
        for source in ("anchor anchor", "absent"):
            with self.assertRaisesRegex(RuntimeError, "anchor.*unique|unique.*anchor"):
                mutations.apply_mutation(source, "fixture", "anchor", "replacement")
        self.assertEqual(mutations.apply_mutation("anchor", "fixture", "anchor", "replacement"), "replacement")


if __name__ == "__main__":
    unittest.main()
