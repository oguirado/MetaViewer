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
