import unittest
from unittest.mock import patch
import subprocess
from laws_range import select_range, ZERO


class RangeTests(unittest.TestCase):
    def test_new_branch_uses_main_merge_base(self):
        with patch("laws_range.subprocess.check_output", return_value="common\n") as git:
            self.assertEqual(select_range("push", ZERO, "tip", "", ""), "common..tip")
        git.assert_called_once_with(["git", "merge-base", "origin/main", "tip"], text=True)

    def test_existing_branch_and_pr_keep_range(self):
        self.assertEqual(select_range("push", "old", "tip", "", ""), "old..tip")
        self.assertEqual(select_range("pull_request", "", "", "base", "tip"), "base..tip")

    def test_negative_missing_main_does_not_scan_all_history(self):
        with patch("laws_range.subprocess.check_output", side_effect=subprocess.CalledProcessError(1, "git")):
            with self.assertRaises(subprocess.CalledProcessError):
                select_range("push", ZERO, "tip", "", "")

    def test_negative_empty_merge_base(self):
        with patch("laws_range.subprocess.check_output", return_value=""):
            with self.assertRaises(ValueError):
                select_range("push", ZERO, "tip", "", "")

    def test_manual(self):
        self.assertIsNone(select_range("workflow_dispatch", "", "", "", ""))

    def test_empty_base_or_tip_fails_closed_and_kills_mutation(self):
        # Negative controls: empty base on pull_request and empty tip on push/pull_request.
        for call_args in (
            ("pull_request", "", "", "", "tip"),
            ("push", "base", "", "", ""),
            ("pull_request", "", "", "base", ""),
        ):
            with self.subTest(call_args=call_args):
                with self.assertRaises(ValueError):
                    select_range(*call_args)

        # Positive controls: valid non-empty, non-ZERO endpoints return "base..tip".
        self.assertEqual(select_range("pull_request", "", "", "base", "tip"), "base..tip")
        self.assertEqual(select_range("push", "base", "tip", "", ""), "base..tip")

        # Surviving mutation verification: changing `if not base or not tip or base == ZERO or tip == ZERO:`
        # to `if base == ZERO or tip == ZERO:` on an in-memory copy returns "..tip" / "base.." instead of raising.
        import pathlib
        laws_range_path = pathlib.Path(__file__).resolve().parent / "laws_range.py"
        src = laws_range_path.read_text(encoding="utf-8")
        anchor = "if not base or not tip or base == ZERO or tip == ZERO:"
        self.assertIn(anchor, src)
        mutated_ns = {}
        exec(compile(src.replace(anchor, "if base == ZERO or tip == ZERO:", 1), str(laws_range_path), "exec"), mutated_ns)
        mutated_select = mutated_ns["select_range"]
        self.assertEqual(mutated_select("pull_request", "", "", "", "tip"), "..tip")
        self.assertEqual(mutated_select("push", "base", "", "", ""), "base..")


if __name__ == "__main__":
    unittest.main()
