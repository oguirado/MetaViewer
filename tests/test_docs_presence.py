"""E2E-U18n / G-DOCS presence & routing gate: required operator/developer docs exist and are routed.

[TARGET, unit decision] Verifies that `README.md` (with `## Quickstart`),
`docs/USER_GUIDE.md`, `docs/TESTING.md`, and `docs/PREEXISTING.md` exist on disk,
contain their required sections, have zero phantom suite mentions in `docs/TESTING.md`
(including `tests/e2e/test_volume_bootstrap.py`), and are routed in
`catalogue/nodes.jsonl` and `catalogue/router/docs/*.jsonl` with matching SHA-256
digests.
Mutations:
- Remove any path in a fixture tree or delete its node in `catalogue/nodes.jsonl` ->
  `check_docs_presence` fails with `DOC_MISSING` / `DOC_UNROUTED`.
- Invert `if errors:` in `test_required_docs_exist_and_are_routed` -> the test fails.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]

REQUIRED_DOCS: tuple[str, ...] = (
    "README.md",
    "docs/USER_GUIDE.md",
    "docs/TESTING.md",
    "docs/PREEXISTING.md",
)

REQUIRED_HEADINGS: dict[str, tuple[str, ...]] = {
    "README.md": ("# MetaViewer", "## Quickstart"),
    "docs/USER_GUIDE.md": ("# MetaViewer User Guide",),
    "docs/TESTING.md": ("# How MetaViewer is tested",),
    "docs/PREEXISTING.md": ("# Pre-existing work declaration",),
}

SUITE_TOKEN_RE = re.compile(
    r"`((?:[a-zA-Z0-9_./-]+/)?(?:test_[a-zA-Z0-9_]+\.py|[a-zA-Z0-9_]+\.test\.js))`"
)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_jsonl(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def find_phantom_suite_mentions(testing_md_text: str, root: Path = ROOT) -> list[str]:
    """Return any backticked test suite filenames in TESTING.md that do not exist in the repo."""
    indexed_basenames: set[str] = set()
    indexed_relpaths: set[str] = set()
    for search_dir in ("tests", "agents/tests", "ui/test"):
        base = root / search_dir
        if not base.is_dir():
            continue
        for candidate in base.rglob("*"):
            if candidate.is_file():
                indexed_basenames.add(candidate.name)
                indexed_relpaths.add(candidate.relative_to(root).as_posix())

    phantoms: list[str] = []
    for match in SUITE_TOKEN_RE.finditer(testing_md_text):
        token = match.group(1)
        if "/" in token:
            exists = (root / token).is_file() or token in indexed_relpaths
        else:
            exists = token in indexed_basenames
        if not exists and token not in phantoms:
            phantoms.append(token)
    return phantoms


def check_docs_presence(root: Path = ROOT) -> list[str]:
    errors: list[str] = []
    nodes_rows = load_jsonl(root / "catalogue" / "nodes.jsonl")
    mount_docs_dir = root / "catalogue" / "router" / "docs"
    mount_rows: list[dict] = []
    if mount_docs_dir.is_dir():
        for shard in sorted(mount_docs_dir.glob("*.jsonl")):
            mount_rows.extend(load_jsonl(shard))

    nodes_by_path: dict[str, dict] = {}
    for row in nodes_rows:
        if not isinstance(row, dict):
            continue
        purpose = row.get("purpose", "")
        prefix = "Routed repository file "
        if isinstance(purpose, str) and purpose.startswith(prefix):
            nodes_by_path[purpose[len(prefix) :]] = row

    mount_by_id: dict[str, dict] = {
        row["id"]: row
        for row in mount_rows
        if isinstance(row, dict) and isinstance(row.get("id"), str)
    }

    for rel_path in REQUIRED_DOCS:
        doc_path = root / rel_path
        if not doc_path.is_file():
            errors.append(f"DOC_MISSING:{rel_path}")
            continue
        text = doc_path.read_text(encoding="utf-8")
        if not text.strip():
            errors.append(f"DOC_EMPTY:{rel_path}")
            continue

        for heading in REQUIRED_HEADINGS.get(rel_path, ()):
            if heading not in text:
                if rel_path == "README.md" and heading == "## Quickstart":
                    errors.append("README_QUICKSTART_MISSING")
                else:
                    errors.append(f"DOC_HEADING_MISSING:{rel_path}:{heading}")

        if rel_path == "docs/TESTING.md":
            for phantom in find_phantom_suite_mentions(text, root):
                errors.append(f"TESTING_PHANTOM_SUITE:{phantom}")

        digest = sha256_file(doc_path)
        node = nodes_by_path.get(rel_path)
        if node is None:
            errors.append(f"DOC_UNROUTED:nodes.jsonl:{rel_path}")
            continue
        if node.get("source_sha256") != digest:
            errors.append(f"DOC_DIGEST_DRIFT:nodes.jsonl:{rel_path}")

        node_id = node.get("id")
        mount_entry = mount_by_id.get(node_id) if isinstance(node_id, str) else None
        if mount_entry is None:
            errors.append(f"DOC_UNROUTED:router/docs:{rel_path}")
        elif mount_entry.get("st") != 1:
            errors.append(f"DOC_INACTIVE:router/docs:{rel_path}")

    return errors


def copy_minimal_docs_fixture(dst: Path) -> None:
    for rel_path in REQUIRED_DOCS:
        src = ROOT / rel_path
        target = dst / rel_path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
    nodes_src = ROOT / "catalogue" / "nodes.jsonl"
    nodes_dst = dst / "catalogue" / "nodes.jsonl"
    nodes_dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(nodes_src, nodes_dst)
    mount_src_dir = ROOT / "catalogue" / "router" / "docs"
    mount_dst_dir = dst / "catalogue" / "router" / "docs"
    mount_dst_dir.mkdir(parents=True, exist_ok=True)
    for shard in sorted(mount_src_dir.glob("*.jsonl")):
        shutil.copy2(shard, mount_dst_dir / shard.name)
    for search_dir in ("tests", "agents/tests", "ui/test"):
        base = ROOT / search_dir
        if not base.is_dir():
            continue
        for candidate in base.rglob("*"):
            if candidate.is_file() and (
                candidate.name.startswith("test_") or candidate.name.endswith(".test.js")
            ):
                stub = dst / candidate.relative_to(ROOT)
                stub.parent.mkdir(parents=True, exist_ok=True)
                stub.write_text("", encoding="utf-8")


class DocsPresenceTests(unittest.TestCase):
    def test_required_docs_exist_and_are_routed(self):
        errors = check_docs_presence(ROOT)
        self.assertEqual(errors, [], f"G-DOCS presence/routing failed: {errors}")
        self.assertTrue((ROOT / "tests" / "e2e" / "test_volume_bootstrap.py").is_file())

    def test_negative_controls_removed_or_unrouted_doc_fails(self):
        for removed_doc in REQUIRED_DOCS:
            with self.subTest(removed_doc=removed_doc):
                with tempfile.TemporaryDirectory(prefix="mv-docs-neg-") as tmp:
                    fixture = Path(tmp)
                    copy_minimal_docs_fixture(fixture)
                    (fixture / removed_doc).unlink()
                    errors = check_docs_presence(fixture)
                    self.assertIn(f"DOC_MISSING:{removed_doc}", errors)

        with tempfile.TemporaryDirectory(prefix="mv-docs-quickstart-") as tmp:
            fixture = Path(tmp)
            copy_minimal_docs_fixture(fixture)
            readme = fixture / "README.md"
            readme.write_text(
                readme.read_text(encoding="utf-8").replace("## Quickstart", "## Overview"),
                encoding="utf-8",
            )
            errors = check_docs_presence(fixture)
            self.assertIn("README_QUICKSTART_MISSING", errors)

        with tempfile.TemporaryDirectory(prefix="mv-docs-unrouted-") as tmp:
            fixture = Path(tmp)
            copy_minimal_docs_fixture(fixture)
            nodes_path = fixture / "catalogue" / "nodes.jsonl"
            kept = [
                line
                for line in nodes_path.read_text(encoding="utf-8").splitlines()
                if "Routed repository file docs/PREEXISTING.md" not in line
            ]
            nodes_path.write_text("\n".join(kept) + "\n", encoding="utf-8")
            errors = check_docs_presence(fixture)
            self.assertIn("DOC_UNROUTED:nodes.jsonl:docs/PREEXISTING.md", errors)

    def test_testing_md_phantom_suite_detector_and_negative_control(self):
        testing_text = (ROOT / "docs" / "TESTING.md").read_text(encoding="utf-8")
        self.assertEqual(
            find_phantom_suite_mentions(testing_text, ROOT),
            [],
            "TESTING.md suite list must have zero phantom test files",
        )
        # Negative control: a phantom test file mention in TESTING.md is rejected.
        with_phantom = testing_text + "\n- Phantom suite: `test_phantom_missing_suite.py`\n"
        self.assertEqual(
            find_phantom_suite_mentions(with_phantom, ROOT),
            ["test_phantom_missing_suite.py"],
        )


if __name__ == "__main__":
    unittest.main()
