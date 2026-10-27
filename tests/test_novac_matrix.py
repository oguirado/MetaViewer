"""E2E-U21 / G-NOVAC non-vacuity matrix gate: every gate runs its positive and negative control.

[TARGET, unit decision] Machine-executable non-vacuity matrix (`NOVAC_MATRIX`)
covering `G-LAWS`, `G-CONTRACTS`, `G-ROUTER`, `G-SECRETS`, `G-THEME`, `G-DOCS`,
`G-VIDEO`, `G-SAFE`, `G-SEC`, `G-PKG`, `G-REPLAY`, and `G-PERF`. Each entry
executes a positive control (must pass -> `True`) and a negative/mutant control
(must be rejected by the gate -> `False`). If any gate passes a mutant
(`negative_fn()` returns `True`), `evaluate_novac_matrix` fails closed with
`VACUOUS_GATE:<gate_id>`.
Mutations:
- Change `if mutant_passed:` to `if not mutant_passed:` in `evaluate_novac_matrix` ->
  both `test_all_gates_pass_positive_and_reject_mutants` and
  `test_any_gate_passing_a_mutant_fails_novac` fail.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass
import importlib.util
import json
from pathlib import Path
import re
import sys
import tempfile
from typing import Callable
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools import check_contracts, check_laws, router_index  # noqa: E402

try:
    from tests import test_docs_presence, test_video_seal
except ModuleNotFoundError:
    import test_docs_presence  # type: ignore[no-redef]
    import test_video_seal  # type: ignore[no-redef]


def _load_module(name: str, rel_path: str):
    path = ROOT / rel_path
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load module {rel_path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


BUDGET_GATE = _load_module("mv_novac_budget_gate", "tools/budget_gate.py")
SECRETS_GATE = _load_module("mv_novac_secrets_gate", "tests/fixtures/secrets/gate.py")

HEX40_RE = re.compile(r"^[0-9a-f]{40}$")


@dataclass(frozen=True)
class NovacEntry:
    gate_id: str
    description: str
    positive_fn: Callable[[], bool]
    negative_fn: Callable[[], bool]


# --- Individual gate evaluators (return True when the gate accepts, False when it rejects) ---


def _eval_laws(message: str, author_name: str = check_laws.NAME) -> bool:
    msg_errors = check_laws.check_message(message)
    id_errors = check_laws.check_identity(
        author_name, check_laws.EMAIL, check_laws.NAME, check_laws.EMAIL
    )
    return not (msg_errors or id_errors)


def _eval_contracts(payload: dict) -> bool:
    validator = check_contracts.Validator(ROOT / "contracts" / "v0.2")
    schema = validator.load("hello.schema.json")
    try:
        validator.validate(payload, schema)
        return True
    except check_contracts.ValidationError:
        return False


def _eval_router(nodes_bytes: bytes, expected_bytes: bytes) -> bool:
    with tempfile.TemporaryDirectory(prefix="mv-novac-router-") as tmp:
        nodes_path = Path(tmp) / "nodes.jsonl"
        nodes_path.write_bytes(nodes_bytes)
        try:
            router_index.check_nodes(nodes_path, expected_bytes)
            return True
        except router_index.RouterError:
            return False


def _eval_secrets_and_privacy(findings_json: str, tracked_blob: bytes, home_needle: bytes) -> bool:
    with tempfile.TemporaryDirectory(prefix="mv-novac-secrets-") as tmp:
        report = Path(tmp) / "report.json"
        report.write_text(findings_json, encoding="utf-8")
        findings = SECRETS_GATE.summarize_findings(report)
    has_home_leak = home_needle in tracked_blob
    return len(findings) == 0 and not has_home_leak


def _relative_luminance(hex_color: str) -> float:
    raw = hex_color.lstrip("#")
    channels = [int(raw[i : i + 2], 16) / 255.0 for i in (0, 2, 4)]
    linear = [
        c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels
    ]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def _contrast_ratio(fg: str, bg: str) -> float:
    l1 = _relative_luminance(fg)
    l2 = _relative_luminance(bg)
    high, low = (l1, l2) if l1 >= l2 else (l2, l1)
    return (high + 0.05) / (low + 0.05)


def _eval_theme(fg: str, bg: str, bundled_fonts: list[str]) -> bool:
    return _contrast_ratio(fg, bg) >= 4.5 and len(bundled_fonts) == 0


def _eval_docs(mutate: bool) -> bool:
    if not mutate:
        return len(test_docs_presence.check_docs_presence(ROOT)) == 0
    with tempfile.TemporaryDirectory(prefix="mv-novac-docs-") as tmp:
        fixture = Path(tmp)
        test_docs_presence.copy_minimal_docs_fixture(fixture)
        (fixture / "docs" / "PREEXISTING.md").unlink()
        return len(test_docs_presence.check_docs_presence(fixture)) == 0


def _eval_video_seal(mutate: bool) -> bool:
    with tempfile.TemporaryDirectory(prefix="mv-novac-video-") as tmp:
        journals_dir = Path(tmp)
        manifest = test_video_seal.build_demo_seal_fixture(journals_dir)
        if mutate:
            manifest["shots"][1]["journal_ref"] = None
        return len(test_video_seal.verify_video_seal(manifest, journals_dir)) == 0


def _eval_safe_kill_guard(target_pid: object, self_pid: int = 99, self_pgid: int = 7) -> bool:
    api = BUDGET_GATE.cleanup_api()
    fake_os = Mock()
    fake_os.getpid.return_value = self_pid
    fake_os.getpgrp.return_value = self_pgid
    fake_os.getpgid.return_value = self_pgid if target_pid == self_pgid else 8
    process = Mock(pid=42)
    with patch.dict(
        api,
        descendants=lambda _: [target_pid],
        process_identity=lambda _: "same",
        os=fake_os,
        time=Mock(),
    ):
        try:
            api["stop_process_tree"](process)
            return True
        except ValueError:
            return False


def _eval_sec_envelope(mutate_kind: str | None) -> bool:
    validator = check_contracts.Validator(ROOT / "contracts" / "v0.2")
    schema = validator.load("envelope.schema.json")
    valid_path = ROOT / "contracts" / "examples" / "v0.2" / "envelope.valid.json"
    payload = check_contracts.loads_strict(valid_path.read_text(encoding="utf-8"))
    if mutate_kind == "unknown_property":
        payload["unexpected_field"] = True
    elif mutate_kind == "unknown_version":
        payload["schema"] = "envelope/v9.9"
    try:
        validator.validate(payload, schema)
        return True
    except check_contracts.ValidationError:
        return False


def _eval_pkg_lock(lock_data: dict) -> bool:
    components = lock_data.get("components")
    if not isinstance(components, list) or len(components) < 3:
        return False
    required = {"vision-engine", "wender-agent", "opensuperficies"}
    seen: set[str] = set()
    for comp in components:
        if not isinstance(comp, dict):
            return False
        name = comp.get("name")
        version = comp.get("version")
        commit = comp.get("commit")
        if (
            not isinstance(name, str)
            or not isinstance(version, str)
            or not version.strip()
            or not isinstance(commit, str)
            or HEX40_RE.match(commit) is None
        ):
            return False
        seen.add(name)
    return required <= seen


def _eval_replay_journal(mutate: bool) -> bool:
    with tempfile.TemporaryDirectory(prefix="mv-novac-replay-") as tmp:
        journal_path = Path(tmp) / "journal.jsonl"
        records = test_video_seal.build_valid_journal_records("novac-session", count=4)
        if mutate:
            records[2]["prev_sha256"] = "bad" + ("0" * 61)
        test_video_seal.write_journal_jsonl(journal_path, records)
        _, err = test_video_seal.verify_journal_file(journal_path, "novac-session")
        return err is None


def _eval_perf_budget(receipt_name: str) -> bool:
    budgets = BUDGET_GATE.load_budgets(ROOT / "tests" / "perf" / "budgets.json")
    receipt = BUDGET_GATE.read_json(ROOT / "tests" / "perf" / receipt_name)
    return bool(BUDGET_GATE.evaluate(receipt, budgets)["ok"])


def build_novac_matrix() -> tuple[NovacEntry, ...]:
    valid_hello = check_contracts.loads_strict(
        (ROOT / "contracts" / "examples" / "v0.2" / "hello.valid.json").read_text(
            encoding="utf-8"
        )
    )
    invalid_hello = copy.deepcopy(valid_hello)
    invalid_hello["unexpected_mutant_field"] = 1

    committed_nodes = (ROOT / "catalogue" / "nodes.jsonl").read_bytes()
    truncated_nodes = b"\n".join(committed_nodes.splitlines()[:-1]) + b"\n"

    deps_lock = json.loads((ROOT / "deps.lock").read_text(encoding="utf-8"))
    drifted_deps_lock = copy.deepcopy(deps_lock)
    drifted_deps_lock["components"][0]["commit"] = "not-a-valid-sha"

    return (
        NovacEntry(
            gate_id="G-LAWS",
            description="Commit message and author identity law check",
            positive_fn=lambda: _eval_laws("core: add deterministic replay check"),
            negative_fn=lambda: _eval_laws(
                "core: add deterministic replay check\n\nCo-Authored-By: Claude"
            ),
        ),
        NovacEntry(
            gate_id="G-CONTRACTS",
            description="Closed JSON schema validation and unknown-property rejection",
            positive_fn=lambda: _eval_contracts(copy.deepcopy(valid_hello)),
            negative_fn=lambda: _eval_contracts(copy.deepcopy(invalid_hello)),
        ),
        NovacEntry(
            gate_id="G-ROUTER",
            description="Router node coverage completeness check",
            positive_fn=lambda: _eval_router(committed_nodes, committed_nodes),
            negative_fn=lambda: _eval_router(truncated_nodes, committed_nodes),
        ),
        NovacEntry(
            gate_id="G-SECRETS",
            description="Secret findings and L5 home-path privacy sweep",
            positive_fn=lambda: _eval_secrets_and_privacy(
                "[]", b"synthetic fixture text", b"/nonexistent_operator_home"
            ),
            negative_fn=lambda: _eval_secrets_and_privacy(
                '[{"RuleID": "generic-api-key"}]',
                b"leaked /nonexistent_operator_home/token",
                b"/nonexistent_operator_home",
            ),
        ),
        NovacEntry(
            gate_id="G-THEME",
            description="WCAG AA >= 4.5:1 token contrast and zero bundled font binaries",
            positive_fn=lambda: _eval_theme("#18181b", "#ffffff", []),
            negative_fn=lambda: _eval_theme("#777777", "#888888", ["Inter.woff2"]),
        ),
        NovacEntry(
            gate_id="G-DOCS",
            description="Required operator/developer documentation presence and routing",
            positive_fn=lambda: _eval_docs(mutate=False),
            negative_fn=lambda: _eval_docs(mutate=True),
        ),
        NovacEntry(
            gate_id="G-VIDEO",
            description="Demo video seal journal reference and AI framing label verification",
            positive_fn=lambda: _eval_video_seal(mutate=False),
            negative_fn=lambda: _eval_video_seal(mutate=True),
        ),
        NovacEntry(
            gate_id="G-SAFE",
            description="Process kill-guard refuses pid <= 1, non-int, self pid, and self pgid",
            positive_fn=lambda: _eval_safe_kill_guard(42, self_pid=99, self_pgid=7),
            negative_fn=lambda: any(
                _eval_safe_kill_guard(bad_pid, self_pid=99, self_pgid=7)
                for bad_pid in (0, 1, -1, True, 99, 7)
            ),
        ),
        NovacEntry(
            gate_id="G-SEC",
            description="IPC envelope rejects unknown properties and unknown schema versions",
            positive_fn=lambda: _eval_sec_envelope(None),
            negative_fn=lambda: (
                _eval_sec_envelope("unknown_property")
                or _eval_sec_envelope("unknown_version")
            ),
        ),
        NovacEntry(
            gate_id="G-PKG",
            description="External dependency lockfile commit SHA and version pin check",
            positive_fn=lambda: _eval_pkg_lock(copy.deepcopy(deps_lock)),
            negative_fn=lambda: _eval_pkg_lock(copy.deepcopy(drifted_deps_lock)),
        ),
        NovacEntry(
            gate_id="G-REPLAY",
            description="Session journal hash-chain and monotonic core_seq verification",
            positive_fn=lambda: _eval_replay_journal(mutate=False),
            negative_fn=lambda: _eval_replay_journal(mutate=True),
        ),
        NovacEntry(
            gate_id="G-PERF",
            description="Resource budget gate accepts clean profile and rejects renderer leak",
            positive_fn=lambda: _eval_perf_budget("clean.json"),
            negative_fn=lambda: _eval_perf_budget("leak-renderer.json"),
        ),
    )


def evaluate_novac_matrix(entries: tuple[NovacEntry, ...] | list[NovacEntry]) -> dict:
    if not entries:
        return {"ok": False, "errors": ["EMPTY_MATRIX"], "results": []}
    errors: list[str] = []
    results: list[dict] = []
    seen_ids: set[str] = set()
    for entry in entries:
        if entry.gate_id in seen_ids:
            errors.append(f"DUPLICATE_GATE:{entry.gate_id}")
        seen_ids.add(entry.gate_id)
        positive_passed = bool(entry.positive_fn())
        mutant_passed = bool(entry.negative_fn())
        if not positive_passed:
            errors.append(f"POSITIVE_FAILED:{entry.gate_id}")
        if mutant_passed:
            errors.append(f"VACUOUS_GATE:{entry.gate_id}")
        results.append(
            {
                "gate_id": entry.gate_id,
                "description": entry.description,
                "positive_passed": positive_passed,
                "mutant_rejected": not mutant_passed,
            }
        )
    return {"ok": len(errors) == 0, "errors": errors, "results": results}


class NovacMatrixTests(unittest.TestCase):
    def test_all_gates_pass_positive_and_reject_mutants(self):
        matrix = build_novac_matrix()
        self.assertEqual(len(matrix), 12)
        report = evaluate_novac_matrix(matrix)
        self.assertTrue(report["ok"], f"G-NOVAC matrix failed: {report['errors']}")
        self.assertEqual(report["errors"], [])
        for row in report["results"]:
            self.assertTrue(row["positive_passed"], row["gate_id"])
            self.assertTrue(row["mutant_rejected"], row["gate_id"])

    def test_any_gate_passing_a_mutant_fails_novac(self):
        matrix = list(build_novac_matrix())
        for idx, entry in enumerate(matrix):
            with self.subTest(vacuous_gate=entry.gate_id):
                mutated = list(matrix)
                mutated[idx] = NovacEntry(
                    gate_id=entry.gate_id,
                    description=entry.description,
                    positive_fn=entry.positive_fn,
                    negative_fn=lambda: True,  # Simulated vacuous gate that passes its mutant
                )
                report = evaluate_novac_matrix(mutated)
                self.assertFalse(report["ok"])
                self.assertIn(f"VACUOUS_GATE:{entry.gate_id}", report["errors"])

        # Positive failure and empty matrix also fail closed.
        broken_positive = list(matrix)
        broken_positive[0] = NovacEntry(
            gate_id=matrix[0].gate_id,
            description=matrix[0].description,
            positive_fn=lambda: False,
            negative_fn=matrix[0].negative_fn,
        )
        pos_report = evaluate_novac_matrix(broken_positive)
        self.assertFalse(pos_report["ok"])
        self.assertIn(f"POSITIVE_FAILED:{matrix[0].gate_id}", pos_report["errors"])
        self.assertFalse(evaluate_novac_matrix([])["ok"])


if __name__ == "__main__":
    unittest.main()
