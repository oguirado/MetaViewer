"""E2E-U19 / G-VIDEO demo video seal gate: program shots journal-referenced, AI scenes labelled.

[TARGET, unit decision] Implements the `metaviewer.video_seal/v1` validator and
tests it against `docs/DEMO_RECURSIVE_SCRIPT.md` and hash-chained
`metaviewer.journal/v1` session journals:
1. Every `"program"` shot must carry a `journal_ref` (`session_id`, `journal_path`,
   `core_seq_start`, `core_seq_end`, `record_sha256`) backed by a valid hash-chained
   `metaviewer.journal/v1` JSONL file on disk.
2. Every `"ai_framing"` scene must carry a non-empty `ai_label` containing
   `"AI-generated"` and `journal_ref` must be `None`.
3. Shots must form a contiguous timeline covering `0..duration_sec` with
   `duration_sec` in `[150, 180]` seconds (2:30–3:00 [TARGET]).
Mutations:
- Remove the `journal_ref is None` check for `"program"` shots in `verify_video_seal` ->
  `test_unreferenced_program_shot_blocks_seal_and_other_negatives` fails.
- Corrupt `record_sha256` check in `verify_video_seal` -> positive or negative test fails.
"""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import re
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "docs" / "DEMO_RECURSIVE_SCRIPT.md"

VIDEO_SEAL_SCHEMA = "metaviewer.video_seal/v1"
JOURNAL_SCHEMA = "metaviewer.journal/v1"
GENESIS_PREV_SHA256 = "0" * 64
MIN_DURATION_SEC = 150
MAX_DURATION_SEC = 180

MANIFEST_KEYS = frozenset({"schema", "title", "duration_sec", "shots"})
SHOT_KEYS = frozenset(
    {"shot_id", "start_sec", "end_sec", "layer", "summary", "journal_ref", "ai_label"}
)
JOURNAL_REF_KEYS = frozenset(
    {"session_id", "journal_path", "core_seq_start", "core_seq_end", "record_sha256"}
)
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
TIME_RANGE_RE = re.compile(r"^(\d+):([0-5]\d)[–-](\d+):([0-5]\d)$")


def canonical_record_sha256(record: dict) -> str:
    encoded = json.dumps(record, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def build_valid_journal_records(session_id: str, count: int = 12) -> list[dict]:
    records: list[dict] = []
    prev_hash = GENESIS_PREV_SHA256
    for seq in range(1, count + 1):
        rec = {
            "schema": JOURNAL_SCHEMA,
            "session_id": session_id,
            "core_seq": seq,
            "prev_sha256": prev_hash,
            "ts_ns": seq * 1_000_000,
            "event": {
                "kind": "CapsuleCreated" if seq == 1 else "FramePublished",
                "surface_id": "cap-demo-1",
                "seq": seq,
            },
        }
        prev_hash = canonical_record_sha256(rec)
        records.append(rec)
    return records


def write_journal_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [json.dumps(r, sort_keys=True, separators=(",", ":")) for r in records]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def verify_journal_file(
    journal_path: Path, expected_session_id: str
) -> tuple[dict[int, tuple[dict, str]] | None, str | None]:
    if not journal_path.is_file():
        return None, "MISSING_JOURNAL"
    try:
        raw_lines = [
            line
            for line in journal_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    except OSError:
        return None, "MISSING_JOURNAL"
    if not raw_lines:
        return None, "EMPTY_JOURNAL"

    prev_hash = GENESIS_PREV_SHA256
    by_seq: dict[int, tuple[dict, str]] = {}
    expected_seq = 1
    for line in raw_lines:
        try:
            rec = json.loads(line)
        except ValueError:
            return None, "CORRUPT_JOURNAL_JSON"
        if not isinstance(rec, dict) or rec.get("schema") != JOURNAL_SCHEMA:
            return None, "CORRUPT_JOURNAL_SCHEMA"
        if rec.get("session_id") != expected_session_id:
            return None, "JOURNAL_SESSION_MISMATCH"
        seq = rec.get("core_seq")
        if not isinstance(seq, int) or isinstance(seq, bool) or seq != expected_seq:
            return None, "CORRUPT_JOURNAL_SEQ"
        if rec.get("prev_sha256") != prev_hash:
            return None, "CORRUPT_JOURNAL_CHAIN"
        rec_hash = canonical_record_sha256(rec)
        by_seq[seq] = (rec, rec_hash)
        prev_hash = rec_hash
        expected_seq += 1

    return by_seq, None


def verify_video_seal(manifest: object, journals_dir: Path) -> list[str]:
    errors: list[str] = []
    if not isinstance(manifest, dict):
        return ["MANIFEST_NOT_OBJECT"]
    if set(manifest.keys()) != MANIFEST_KEYS:
        return ["MANIFEST_KEYS_INVALID"]
    if manifest.get("schema") != VIDEO_SEAL_SCHEMA:
        errors.append("MANIFEST_SCHEMA_INVALID")
    title = manifest.get("title")
    if not isinstance(title, str) or not title.strip():
        errors.append("MANIFEST_TITLE_INVALID")
    duration_sec = manifest.get("duration_sec")
    if (
        not isinstance(duration_sec, int)
        or isinstance(duration_sec, bool)
        or not (MIN_DURATION_SEC <= duration_sec <= MAX_DURATION_SEC)
    ):
        errors.append("DURATION_OUT_OF_RANGE")

    shots = manifest.get("shots")
    if not isinstance(shots, list) or not shots:
        errors.append("SHOTS_EMPTY")
        return errors

    expected_start = 0
    seen_shot_ids: set[int] = set()
    journal_cache: dict[tuple[str, str], tuple[dict[int, tuple[dict, str]] | None, str | None]] = {}

    for idx, shot in enumerate(shots):
        tag = f"shot[{idx}]"
        if not isinstance(shot, dict) or set(shot.keys()) != SHOT_KEYS:
            errors.append(f"SHOT_KEYS_INVALID:{tag}")
            continue
        shot_id = shot.get("shot_id")
        if not isinstance(shot_id, int) or isinstance(shot_id, bool) or shot_id <= 0:
            errors.append(f"SHOT_ID_INVALID:{tag}")
            continue
        tag = f"shot-{shot_id}"
        if shot_id in seen_shot_ids:
            errors.append(f"DUPLICATE_SHOT_ID:{tag}")
        seen_shot_ids.add(shot_id)

        start_sec = shot.get("start_sec")
        end_sec = shot.get("end_sec")
        if (
            not isinstance(start_sec, int)
            or isinstance(start_sec, bool)
            or not isinstance(end_sec, int)
            or isinstance(end_sec, bool)
            or end_sec <= start_sec
        ):
            errors.append(f"SHOT_RANGE_INVALID:{tag}")
        else:
            if start_sec != expected_start:
                errors.append(f"SHOT_TIMELINE_DISCONTINUITY:{tag}")
            expected_start = end_sec

        summary = shot.get("summary")
        if not isinstance(summary, str) or not summary.strip():
            errors.append(f"SHOT_SUMMARY_EMPTY:{tag}")

        layer = shot.get("layer")
        journal_ref = shot.get("journal_ref")
        ai_label = shot.get("ai_label")

        if layer == "program":
            if ai_label is not None:
                errors.append(f"PROGRAM_SHOT_HAS_AI_LABEL:{tag}")
            if not isinstance(journal_ref, dict) or set(journal_ref.keys()) != JOURNAL_REF_KEYS:
                errors.append(f"UNREFERENCED_PROGRAM_SHOT:{tag}")
                continue
            session_id = journal_ref.get("session_id")
            rel_journal = journal_ref.get("journal_path")
            seq_start = journal_ref.get("core_seq_start")
            seq_end = journal_ref.get("core_seq_end")
            record_sha256 = journal_ref.get("record_sha256")
            if (
                not isinstance(session_id, str)
                or not session_id.strip()
                or not isinstance(rel_journal, str)
                or not rel_journal.strip()
                or Path(rel_journal).is_absolute()
                or ".." in Path(rel_journal).parts
                or not isinstance(seq_start, int)
                or isinstance(seq_start, bool)
                or not isinstance(seq_end, int)
                or isinstance(seq_end, bool)
                or seq_start < 1
                or seq_end < seq_start
                or not isinstance(record_sha256, str)
                or HEX64_RE.match(record_sha256) is None
            ):
                errors.append(f"UNREFERENCED_PROGRAM_SHOT:{tag}")
                continue

            cache_key = (session_id, rel_journal)
            if cache_key not in journal_cache:
                journal_cache[cache_key] = verify_journal_file(
                    journals_dir / rel_journal, session_id
                )
            by_seq, j_err = journal_cache[cache_key]
            if j_err is not None or by_seq is None:
                errors.append(f"{j_err}:{tag}")
                continue
            if seq_start not in by_seq or seq_end not in by_seq:
                errors.append(f"JOURNAL_SEQ_OUT_OF_RANGE:{tag}")
                continue
            _, actual_hash = by_seq[seq_end]
            if actual_hash != record_sha256:
                errors.append(f"JOURNAL_RECORD_HASH_MISMATCH:{tag}")

        elif layer == "ai_framing":
            if journal_ref is not None:
                errors.append(f"AI_SCENE_HAS_JOURNAL_REF:{tag}")
            if (
                not isinstance(ai_label, str)
                or "AI-generated" not in ai_label
                or not ai_label.strip()
            ):
                errors.append(f"UNLABELLED_AI_SCENE:{tag}")
        else:
            errors.append(f"UNKNOWN_SHOT_LAYER:{tag}")

    if isinstance(duration_sec, int) and not isinstance(duration_sec, bool):
        if expected_start != duration_sec:
            errors.append("SHOT_TIMELINE_END_MISMATCH")

    return errors


def parse_demo_script(script_path: Path = SCRIPT_PATH) -> list[dict]:
    """Parse the shot table in docs/DEMO_RECURSIVE_SCRIPT.md into structured rows."""
    text = script_path.read_text(encoding="utf-8")
    shots: list[dict] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if len(cells) != 5 or not cells[0].isdigit():
            continue
        shot_id = int(cells[0])
        m = TIME_RANGE_RE.match(cells[1])
        if m is None:
            raise ValueError(f"invalid time range in DEMO_RECURSIVE_SCRIPT.md: {cells[1]!r}")
        start_sec = int(m.group(1)) * 60 + int(m.group(2))
        end_sec = int(m.group(3)) * 60 + int(m.group(4))
        what_happens = cells[4]
        if "Static card" in what_happens or "AI framing" in what_happens:
            layer = "ai_framing"
        else:
            layer = "program"
        shots.append(
            {
                "shot_id": shot_id,
                "start_sec": start_sec,
                "end_sec": end_sec,
                "layer": layer,
                "on_screen": cells[2],
                "narration": cells[3],
                "what_happens": what_happens,
            }
        )
    return shots


def build_demo_seal_fixture(journals_dir: Path) -> dict:
    inner_session = "demo-inner-s1"
    outer_session = "demo-outer-s1"
    inner_rel = f"sessions/{inner_session}/journal.jsonl"
    outer_rel = f"sessions/{outer_session}/journal.jsonl"
    inner_records = build_valid_journal_records(inner_session, count=12)
    outer_records = build_valid_journal_records(outer_session, count=8)
    write_journal_jsonl(journals_dir / inner_rel, inner_records)
    write_journal_jsonl(journals_dir / outer_rel, outer_records)

    parsed_shots = parse_demo_script(SCRIPT_PATH)
    seal_shots: list[dict] = []
    inner_idx = 0
    outer_idx = 0
    for row in parsed_shots:
        if row["layer"] == "program":
            is_outer = "OUTER" in row["what_happens"] or "outer" in row["what_happens"]
            if is_outer:
                seq_start = outer_idx * 2 + 1
                seq_end = seq_start + 1
                outer_idx += 1
                session_id = outer_session
                rel_journal = outer_rel
                rec_hash = canonical_record_sha256(outer_records[seq_end - 1])
            else:
                seq_start = inner_idx * 2 + 1
                seq_end = seq_start + 1
                inner_idx += 1
                session_id = inner_session
                rel_journal = inner_rel
                rec_hash = canonical_record_sha256(inner_records[seq_end - 1])
            seal_shots.append(
                {
                    "shot_id": row["shot_id"],
                    "start_sec": row["start_sec"],
                    "end_sec": row["end_sec"],
                    "layer": "program",
                    "summary": row["on_screen"],
                    "journal_ref": {
                        "session_id": session_id,
                        "journal_path": rel_journal,
                        "core_seq_start": seq_start,
                        "core_seq_end": seq_end,
                        "record_sha256": rec_hash,
                    },
                    "ai_label": None,
                }
            )
        else:
            seal_shots.append(
                {
                    "shot_id": row["shot_id"],
                    "start_sec": row["start_sec"],
                    "end_sec": row["end_sec"],
                    "layer": "ai_framing",
                    "summary": row["on_screen"],
                    "journal_ref": None,
                    "ai_label": "AI-generated — framing scene",
                }
            )

    return {
        "schema": VIDEO_SEAL_SCHEMA,
        "title": "MetaViewer Recursive Demo",
        "duration_sec": 180,
        "shots": seal_shots,
    }


class VideoSealTests(unittest.TestCase):
    def test_demo_script_and_valid_video_seal_pass(self):
        self.assertTrue(SCRIPT_PATH.is_file(), "docs/DEMO_RECURSIVE_SCRIPT.md must exist")
        parsed = parse_demo_script(SCRIPT_PATH)
        self.assertEqual(len(parsed), 8)
        program_shots = [s for s in parsed if s["layer"] == "program"]
        ai_shots = [s for s in parsed if s["layer"] == "ai_framing"]
        self.assertEqual(len(program_shots), 7)
        self.assertEqual(len(ai_shots), 1)

        with tempfile.TemporaryDirectory(prefix="mv-video-seal-") as tmp:
            journals_dir = Path(tmp)
            manifest = build_demo_seal_fixture(journals_dir)
            errors = verify_video_seal(manifest, journals_dir)
            self.assertEqual(errors, [], f"valid demo video seal must pass: {errors}")

    def test_unreferenced_program_shot_blocks_seal_and_other_negatives(self):
        with tempfile.TemporaryDirectory(prefix="mv-video-seal-neg-") as tmp:
            journals_dir = Path(tmp)
            base_manifest = build_demo_seal_fixture(journals_dir)

            # 1. Negative control (primary E2E-U19 requirement): unreferenced program shot blocks seal.
            unreferenced = copy.deepcopy(base_manifest)
            unreferenced["shots"][1]["journal_ref"] = None
            self.assertIn(
                "UNREFERENCED_PROGRAM_SHOT:shot-2",
                verify_video_seal(unreferenced, journals_dir),
            )

            # 2. Missing journal file on disk blocks seal.
            missing_journal = copy.deepcopy(base_manifest)
            missing_journal["shots"][2]["journal_ref"]["journal_path"] = "sessions/absent/journal.jsonl"
            self.assertIn(
                "MISSING_JOURNAL:shot-3",
                verify_video_seal(missing_journal, journals_dir),
            )

            # 3. Wrong record_sha256 blocks seal.
            bad_hash = copy.deepcopy(base_manifest)
            bad_hash["shots"][3]["journal_ref"]["record_sha256"] = "f" * 64
            self.assertIn(
                "JOURNAL_RECORD_HASH_MISMATCH:shot-4",
                verify_video_seal(bad_hash, journals_dir),
            )

            # 4. Out-of-range core_seq blocks seal.
            bad_seq = copy.deepcopy(base_manifest)
            bad_seq["shots"][4]["journal_ref"]["core_seq_end"] = 999
            self.assertIn(
                "JOURNAL_SEQ_OUT_OF_RANGE:shot-5",
                verify_video_seal(bad_seq, journals_dir),
            )

            # 5. Unlabelled AI framing scene blocks seal.
            unlabelled_ai = copy.deepcopy(base_manifest)
            unlabelled_ai["shots"][7]["ai_label"] = "Framing outro"
            self.assertIn(
                "UNLABELLED_AI_SCENE:shot-8",
                verify_video_seal(unlabelled_ai, journals_dir),
            )

            # 6. AI framing scene claiming a journal reference blocks seal.
            ai_with_journal = copy.deepcopy(base_manifest)
            ai_with_journal["shots"][7]["journal_ref"] = copy.deepcopy(
                base_manifest["shots"][1]["journal_ref"]
            )
            self.assertIn(
                "AI_SCENE_HAS_JOURNAL_REF:shot-8",
                verify_video_seal(ai_with_journal, journals_dir),
            )

            # 7. Corrupted journal hash chain on disk blocks seal.
            corrupt_dir = journals_dir / "corrupt"
            corrupt_manifest = build_demo_seal_fixture(corrupt_dir)
            journal_file = corrupt_dir / "sessions" / "demo-inner-s1" / "journal.jsonl"
            lines = journal_file.read_text(encoding="utf-8").splitlines()
            tampered = json.loads(lines[1])
            tampered["prev_sha256"] = "a" * 64
            lines[1] = json.dumps(tampered, sort_keys=True, separators=(",", ":"))
            journal_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
            self.assertIn(
                "CORRUPT_JOURNAL_CHAIN:shot-2",
                verify_video_seal(corrupt_manifest, corrupt_dir),
            )


if __name__ == "__main__":
    unittest.main()
