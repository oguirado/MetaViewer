"""Tests for metaviewer_agents.export and the embedded mw.run_bundle.v1 schema fixture."""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from metaviewer_agents import export
from metaviewer_agents.export import (
    BUNDLE_SCHEMA,
    GENESIS_PREV_SHA256,
    JOURNAL_HEADER_SCHEMA,
    MAX_BUNDLE_BYTES,
    SESSION_RECORD_SCHEMA,
    ExportError,
    build_export_bundle,
    canonical_json_bytes,
    canonical_sha256,
    dumps_export_bundle,
    project_refusal,
    project_state_ref,
    project_step,
    project_vision_elements,
    scrub_metadata,
    scrub_text,
    validate_bundle_schema,
    validate_export_bundle,
    verify_journal,
)
from metaviewer_agents.observe import compute_battery_state_sha256
from metaviewer_agents.perception.base import Frame

FIXTURE_SCHEMA_PATH = (
    Path(__file__).resolve().parent / "fixtures" / "mw_run_bundle_v1.schema.json"
)
EXPECTED_SCHEMA_SHA256 = (
    "3d63d974afe79100d49ac2eabd0fa1cde95efc2594286d8dbbe4bbdabaf2303a"
)

SHA_0 = "0" * 64
SHA_1 = "1" * 64
SHA_2 = "2" * 64
SHA_3 = "3" * 64
SHA_4 = "4" * 64
SHA_GT = "a" * 64

# Assembled from pieces so this test file stays inert under secret and path scanners.
P_HOME = "/" + "ho" + "me/operator/session.json"
P_SHM = "/dev/" + "shm/mv_frame_01.rgb"
P_TMP = "/" + "tm" + "p/capture.bin"
P_PROC = "/" + "proc/self/maps"
P_RAMWS = "ramws" + "://surface-1/frame-1"
P_CAPSULE = "capsule" + "_id=cap-999"
P_TRACE = "Trace" + "back (most recent call last):"
P_DATA_IMG = "data:" + "image/png;base64,AAAA"
P_B64_PNG = "iVBOR" + "w0KGgoAAAANSUhEUgAAAAUA"
P_B64_JPG = "/9j/4" + "AAQSkZJRgABAQAAAQABAAD/"
P_PNG_MAGIC = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
P_SET_COOKIE = "Set-" + "Cookie: sid=xyz987; HttpOnly"
P_COOKIE_HDR = "Coo" + "kie: auth_session=abc123"
P_DOC_COOKIE = "document." + "cookie"
P_HOST_COOKIE = "__Host-" + "session=12345"
P_PRIV_KEY = "-----BEGIN " + "PRIVATE KEY-----"
P_AWS_MARKER = "AK" + "IA1234567890ABCDEF"
P_GH_MARKER = "gh" + "p_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"
P_BEARER_MARKER = "Bea" + "rer eyJhbGciOiJIUzI1NiJ9"
P_JWT_MARKER = (
    "eyJhbGciOi"
    + "JIUzI1NiJ9.eyJzdWIiOi"
    + "IxMjM0NTYifQ.SflKxwRJSM"
    + "eKKF2QT4fwpM"
)
P_URL_CRED = (
    "https://shop.example.invalid/callback?"
    + "access_"
    + "tok"
    + "en=markerValue123"
)
P_ASSIGN_CRED = "api_" + "ke" + "y=markerValue123"
P_EMAIL = "alice.smith" + "@" + "corp.example.invalid"
P_ACCT_TEXT = "Logged " + "in as Alice Smith"
P_SSN = "123-" + "45-6789"


def _make_frame_ref(sha: str, generation: int, *, width: int = 1280, height: int = 800) -> dict:
    return {
        "schema": "frame_ref/v0.2",
        "surface_id": "surf-checkout",
        "generation": generation,
        "tick": generation * 10,
        "ts_ns": generation * 1_000_000,
        "width": width,
        "height": height,
        "format": "rgb24",
        "ramws_path": f"/dev/shm/mv_frame_{generation}.rgb",
        "sha256": sha,
        "capture_us": 250,
    }


def _make_journal_lines() -> tuple[list[str], str]:
    header = {
        "schema": JOURNAL_HEADER_SCHEMA,
        "session_id": "sess-checkout-01",
        "core_version": "0.1.0",
    }
    specs = [
        (1, "received", "msg-p1-recv"),
        (2, "admitted", "msg-p1-admit"),
        (3, "executed", "msg-p1-exec"),
        (4, "verified", "msg-p1-verify"),
        (5, "received", "msg-p2-recv"),
        (6, "admitted", "msg-p2-admit"),
        (7, "verified", "msg-p2-verify"),
        (8, "received", "msg-p3-recv"),
        (9, "refused", "msg-p3-refuse"),
        (10, "surface_changed", "msg-surf-4"),
        (11, "received", "msg-p4-recv"),
        (12, "admitted", "msg-p4-admit"),
        (13, "verified", "msg-p4-verify"),
    ]
    lines = [canonical_json_bytes(header).decode("utf-8")]
    prev = GENESIS_PREV_SHA256
    for seq, kind, msg_id in specs:
        record = {
            "schema": SESSION_RECORD_SCHEMA,
            "core_seq": seq,
            "kind": kind,
            "msg_id": msg_id,
            "prev_sha256": prev,
        }
        raw = canonical_json_bytes(record)
        prev = hashlib.sha256(raw).hexdigest()
        lines.append(raw.decode("utf-8"))
    return lines, prev


def _make_wender_state(*, box_x: int = 580, title: str = "Order Review") -> dict:
    node = {
        "id": "0123456789abcdef",
        "role": "button",
        "name": "Place order",
        "depth": 0,
        "parent": None,
        "ordinal": 0,
        "states": {"enabled": "true"},
        "actionable": True,
        "box": [box_x, 495, 120, 50],
    }
    return {
        "schema": "wender.state/v1",
        "source": {"kind": "cdp", "url": "https://checkout.example.invalid/review", "title": title},
        "prune": {"name": "default", "version": 1},
        "ax_sha256": "b" * 64,
        "ax_stable_sha256": "c" * 64,
        "viewport": {"w": 1280, "h": 800},
        "nodes": [node],
        "actionable": ["0123456789abcdef"],
        "counts": {"raw": 2, "nodes": 1, "actionable": 1},
    }


def _build_fixture_bundle() -> tuple[dict, str]:
    journal_lines, expected_head = _make_journal_lines()
    obs_1 = {
        "schema": "observation/v0.2",
        "frame_ref": _make_frame_ref(SHA_0, 1),
        "vision": {
            "summary": "Initial checkout screen",
            "changed_regions": [{"x": 380, "y": 280, "w": 240, "h": 80}],
            "elements": [
                {
                    "bbox": {"x": 390, "y": 290, "w": 210, "h": 50},
                    "role": "field",
                    "name": "Coupon code",
                    "confidence": 0.94,
                },
                {
                    "bbox": {"x": 580, "y": 495, "w": 120, "h": 50},
                    "role": "button",
                    "name": "Place order",
                    "confidence": 0.985,
                },
            ],
        },
        "ground_truth": {
            "source": "holdings_lane",
            "state_sha256": SHA_GT,
            "tick": 10,
        },
    }

    proposals = [
        {
            "schema": "action_proposal/v0.2",
            "proposal_id": "prop-1",
            "surface_id": "surf-checkout",
            "based_on_frame": {"sha256": SHA_0, "generation": 1},
            "action": {"type": "click", "x": 420, "y": 310, "button": "left"},
            "expectation": {
                "type": "changed_region",
                "bbox": {"x": 380, "y": 280, "w": 240, "h": 80},
            },
            "budget": {"max_ms": 1000, "max_retries": 0},
            "gap_before_ms": 120,
            "gap_after_ms": 450,
            "mark": {
                "mark_id": "m-coupon",
                "kind": "input",
                "bbox": {"x": 390, "y": 290, "w": 210, "h": 50},
                "ocr_text": "Coupon code",
                "score": 0.94,
                "missing_reason": None,
            },
        },
        {
            "schema": "action_proposal/v0.2",
            "proposal_id": "prop-2",
            "surface_id": "surf-checkout",
            "based_on_frame": {"sha256": SHA_1, "generation": 2},
            "action": {"type": "type", "text": "SAVE2026"},
            "expectation": {
                "type": "element_state",
                "role": "input",
                "name": "Coupon code",
                "state": "populated",
            },
            "budget": {"max_ms": 1000, "max_retries": 0},
            "gap_before_ms": 450,
            "gap_after_ms": 320,
        },
        {
            "schema": "action_proposal/v0.2",
            "proposal_id": "prop-3",
            "surface_id": "surf-checkout",
            "based_on_frame": {"sha256": SHA_2, "generation": 3},
            "action": {"type": "click", "x": 640, "y": 520, "button": "left"},
            "expectation": {
                "type": "changed_region",
                "bbox": {"x": 200, "y": 150, "w": 880, "h": 570},
            },
            "budget": {"max_ms": 1000, "max_retries": 0},
            "gap_before_ms": 200,
            "gap_after_ms": 200,
        },
        {
            "schema": "action_proposal/v0.2",
            "proposal_id": "prop-4",
            "surface_id": "surf-checkout",
            "based_on_frame": {"sha256": SHA_2, "generation": 4},
            "action": {"type": "click", "x": 640, "y": 520, "button": "left"},
            "expectation": {
                "type": "state_sha256_change",
                "before": SHA_GT,
                "min_tick": 10,
                "max_tick": 50,
            },
            "budget": {"max_ms": 1000, "max_retries": 0},
            "gap_before_ms": 320,
            "gap_after_ms": 600,
        },
    ]

    verdicts = [
        {
            "schema": "action_verdict/v0.2",
            "proposal_id": "prop-1",
            "decision": "admitted",
            "core_seq": 2,
        },
        {
            "schema": "action_verdict/v0.2",
            "proposal_id": "prop-2",
            "decision": "admitted",
            "core_seq": 6,
        },
        {
            "schema": "action_verdict/v0.2",
            "proposal_id": "prop-3",
            "decision": "refused",
            "reason_code": "STALE_FRAME",
            "core_seq": 9,
            "summary": "Initial submit click proposal was refused due to a stale frame generation",
            "mitigation": "Wait for the coupon total recomputation frame to settle before proposing",
        },
        {
            "schema": "action_verdict/v0.2",
            "proposal_id": "prop-4",
            "decision": "admitted",
            "core_seq": 12,
        },
    ]

    receipts = [
        {
            "schema": "action_receipt/v0.2",
            "proposal_id": "prop-1",
            "executed_at_ns": 1_500_000,
            "after_frame": _make_frame_ref(SHA_1, 2),
            "verified": True,
            "verification": {"method": "pixel", "detail": "changed region verified"},
            "error": "",
            "native_evidence": {
                "surface_id": "surf-checkout",
                "native_surface_id": "win-1",
                "kind": "click",
                "input_mono_ns": 1_400_000,
                "input_ts_ns": 400_000,
                "focus_verified": True,
                "result": "ok",
            },
        },
        {
            "schema": "action_receipt/v0.2",
            "proposal_id": "prop-2",
            "executed_at_ns": 2_500_000,
            "after_frame": _make_frame_ref(SHA_2, 3),
            "verified": True,
            "verification": {"method": "element", "detail": "coupon field populated"},
            "error": "",
        },
        {
            "schema": "action_receipt/v0.2",
            "proposal_id": "prop-4",
            "executed_at_ns": 4_500_000,
            "after_frame": _make_frame_ref(SHA_3, 5),
            "verified": True,
            "verification": {"method": "state_sha256", "detail": "order state advanced"},
            "error": "",
        },
    ]

    wender_state = _make_wender_state()
    bundle = build_export_bundle(
        site_id="acme-checkout",
        site_name="Acme Checkout Portal",
        domains=["checkout.example.invalid"],
        recorded_date="2026-10-28",
        run_id="run-20261028-01",
        demo_id="guest-order-demo",
        workflow_id="guest-order",
        task_summary="Submit a guest checkout order after entering a coupon code",
        tags=["checkout", "click", "shop", "submit", "type"],
        journal="\n".join(journal_lines),
        observations=[obs_1],
        proposals=proposals,
        verdicts=verdicts,
        receipts=receipts,
        states=[wender_state],
    )
    return bundle, expected_head


def _in_process_fixture_schema_validate(raw_bytes: bytes, schema_doc: dict) -> list[str]:
    """Independent in-process validator against the fixture JSON schema and semantic rules."""
    if len(raw_bytes) > MAX_BUNDLE_BYTES:
        return ["BUNDLE_OVERSIZE"]
    if b"\x00" in raw_bytes or raw_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return ["FORBIDDEN_PIXELS"]
    bundle = json.loads(raw_bytes.decode("utf-8"))
    if canonical_json_bytes(bundle) != raw_bytes:
        return ["NON_CANONICAL_JSON"]

    errs = validate_bundle_schema(bundle, schema_doc)
    if errs:
        return errs

    findings = export._scan_forbidden_bundle(bundle)
    if findings:
        return findings

    steps = bundle["steps"]
    if [s["seq"] for s in steps] != list(range(1, len(steps) + 1)):
        return ["BUNDLE_STEP_SEQ"]
    vp_w, vp_h = bundle["surface"]["viewport_px"]
    for s in steps:
        if (s["kind"] == "paste") != (s["text_len"] is not None):
            return ["BUNDLE_TEXT_LEN"]
        for box_field in (
            s["expected_change_box_px"],
            s["mark"]["box_px"] if s["mark"] is not None else None,
        ):
            if box_field is not None and (box_field[2] <= box_field[0] or box_field[3] <= box_field[1]):
                return ["BUNDLE_BOX"]
        if s["recorded_point_px"] is not None:
            px, py = s["recorded_point_px"]
            if px < 0 or py < 0 or px > vp_w or py > vp_h:
                return ["BUNDLE_POINT_OUT_OF_VIEWPORT"]
    for el in bundle["vision_elements"]:
        b = el["box_px"]
        if b[2] <= b[0] or b[3] <= b[1]:
            return ["BUNDLE_BOX"]
    seen: set[str] = set()
    for group in (bundle["vision_elements"], bundle["state_refs"], bundle["refusals"]):
        for item in group:
            if item["id"] in seen:
                return ["BUNDLE_DUPLICATE_ID"]
            seen.add(item["id"])
    for r in bundle["refusals"]:
        if r["step_seq"] > len(steps):
            return ["BUNDLE_REFUSAL_SEQ"]
    return []


class ExportSchemaFixtureTests(unittest.TestCase):
    def test_embedded_schema_fixture_sha256_and_closed_objects(self) -> None:
        self.assertTrue(FIXTURE_SCHEMA_PATH.is_file())
        raw = FIXTURE_SCHEMA_PATH.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        self.assertEqual(digest, EXPECTED_SCHEMA_SHA256)
        schema_doc = json.loads(raw.decode("utf-8"))
        self.assertEqual(raw.rstrip(b"\n"), canonical_json_bytes(schema_doc))
        self.assertEqual(schema_doc, export._EMBEDDED_SCHEMA)

        def assert_closed(node: object, where: str) -> None:
            if isinstance(node, dict):
                if node.get("type") == "object" or "properties" in node:
                    self.assertIs(
                        node.get("additionalProperties"),
                        False,
                        f"{where} must set additionalProperties: false",
                    )
                for k, v in node.items():
                    assert_closed(v, f"{where}.{k}")
            elif isinstance(node, list):
                for i, v in enumerate(node):
                    assert_closed(v, f"{where}[{i}]")

        assert_closed(schema_doc, "$")

    def test_emitted_fixture_bundle_passes_in_process_schema_checks(self) -> None:
        schema_doc = json.loads(FIXTURE_SCHEMA_PATH.read_text(encoding="utf-8"))
        bundle, expected_head = _build_fixture_bundle()
        raw_bytes = dumps_export_bundle(bundle)
        findings = _in_process_fixture_schema_validate(raw_bytes, schema_doc)
        self.assertEqual(findings, [])
        self.assertEqual(bundle["schema"], BUNDLE_SCHEMA)
        self.assertEqual(bundle["journal_head_sha256"], expected_head)
        self.assertEqual(len(bundle["steps"]), 4)
        self.assertEqual([s["seq"] for s in bundle["steps"]], [1, 2, 3, 4])
        self.assertEqual(
            [s["verdict"] for s in bundle["steps"]],
            ["admitted", "admitted", "refused", "admitted"],
        )
        self.assertEqual(
            [s["verify_method"] for s in bundle["steps"]],
            ["pixel", "element", None, "state_sha256"],
        )
        # Step 1 mark projected from {x, y, w, h} -> [x0, y0, x1, y1] and relative_xy_bps
        self.assertEqual(bundle["steps"][0]["mark"]["box_px"], [390, 290, 600, 340])
        self.assertEqual(bundle["steps"][0]["mark"]["relative_xy_bps"], [1428, 4000])
        self.assertEqual(bundle["steps"][0]["mark"]["ocr_score_promille"], 940)
        # Step 2 typed text "SAVE2026" is never in the bundle; only text_len=8 is recorded
        self.assertEqual(bundle["steps"][1]["kind"], "paste")
        self.assertEqual(bundle["steps"][1]["text_len"], 8)
        self.assertNotIn(b"SAVE2026", raw_bytes)
        # ramws_path is never in the bundle
        self.assertNotIn(b"ramws_path", raw_bytes)
        self.assertNotIn(b"/dev/shm", raw_bytes)
        # Vision elements projected with compatibility role (field -> input) and [x0, y0, x1, y1]
        self.assertEqual(len(bundle["vision_elements"]), 2)
        self.assertEqual(bundle["vision_elements"][0]["role"], "input")
        self.assertEqual(bundle["vision_elements"][0]["box_px"], [390, 290, 600, 340])
        self.assertEqual(bundle["vision_elements"][0]["confidence_ppm"], 940000)
        self.assertEqual(bundle["vision_elements"][1]["role"], "button")
        self.assertEqual(bundle["vision_elements"][1]["box_px"], [580, 495, 700, 545])
        self.assertEqual(bundle["vision_elements"][1]["confidence_ppm"], 985000)
        # Refusal linked to step 3
        self.assertEqual(len(bundle["refusals"]), 1)
        self.assertEqual(bundle["refusals"][0]["step_seq"], 3)
        self.assertEqual(bundle["refusals"][0]["reason_code"], "STALE_FRAME")
        self.assertEqual(bundle["refusals"][0]["failure_tag"], "stale-element")


class StateAndActionProjectionTests(unittest.TestCase):
    def test_wender_state_ref_hashes_attributes_not_boxes(self) -> None:
        state_a = _make_wender_state(box_x=100)
        state_b = _make_wender_state(box_x=900)
        ref_a = project_state_ref(state_a, index=1)
        ref_b = project_state_ref(state_b, index=1)
        self.assertEqual(ref_a["state_sha256"], compute_battery_state_sha256(state_a))
        # Geometry change alone must not change the battery state digest.
        self.assertEqual(ref_a["state_sha256"], ref_b["state_sha256"])

        # Attribute change (node name) must change the battery state digest.
        state_c = _make_wender_state(box_x=100)
        state_c["nodes"][0]["name"] = "Cancel order"
        ref_c = project_state_ref(state_c, index=1)
        self.assertNotEqual(ref_a["state_sha256"], ref_c["state_sha256"])

    def test_action_variants_key_scroll_wait_and_right_click(self) -> None:
        proposals = [
            {
                "schema": "action_proposal/v0.2",
                "proposal_id": "p-key",
                "surface_id": "s-1",
                "based_on_frame": {"sha256": SHA_0, "generation": 1},
                "action": {"type": "key", "keys": ["Control", "Shift", "Enter"]},
                "expectation": {"type": "text_present", "text": "Submitted"},
                "budget": {"max_ms": 500, "max_retries": 0},
            },
            {
                "schema": "action_proposal/v0.2",
                "proposal_id": "p-scroll",
                "surface_id": "s-1",
                "based_on_frame": {"sha256": SHA_1, "generation": 2},
                "action": {"type": "scroll", "dx": 0, "dy": -240},
                "expectation": {"type": "text_present", "text": "Footer"},
                "budget": {"max_ms": 500, "max_retries": 0},
            },
            {
                "schema": "action_proposal/v0.2",
                "proposal_id": "p-wait",
                "surface_id": "s-1",
                "based_on_frame": {"sha256": SHA_2, "generation": 3},
                "action": {"type": "wait", "ms": 750},
                "expectation": {"type": "text_present", "text": "Ready"},
                "budget": {"max_ms": 1000, "max_retries": 0},
            },
            {
                "schema": "action_proposal/v0.2",
                "proposal_id": "p-rclick",
                "surface_id": "s-1",
                "based_on_frame": {"sha256": SHA_3, "generation": 4},
                "action": {"type": "click", "x": 200, "y": 150, "button": "right"},
                "expectation": {"type": "text_present", "text": "Context menu"},
                "budget": {"max_ms": 500, "max_retries": 0},
            },
        ]
        receipts = [
            {
                "schema": "action_receipt/v0.2",
                "proposal_id": pid,
                "executed_at_ns": idx * 1000,
                "after_frame": _make_frame_ref(after_sha, idx + 1),
                "verified": True,
                "verification": {"method": "pixel", "detail": "ok"},
                "error": "",
            }
            for idx, (pid, after_sha) in enumerate(
                [("p-key", SHA_1), ("p-scroll", SHA_2), ("p-wait", SHA_3), ("p-rclick", SHA_4)],
                1,
            )
        ]
        bundle = build_export_bundle(
            site_id="demo-site",
            site_name="Demo Site",
            domains=["demo.example.invalid"],
            recorded_date="2026-10-28",
            run_id="run-actions-01",
            demo_id="demo-actions",
            task_summary="Exercise key, scroll, wait, and right click",
            proposals=proposals,
            receipts=receipts,
        )
        self.assertEqual(bundle["steps"][0]["kind"], "key")
        self.assertEqual(bundle["steps"][0]["modifiers"], ["Control", "Shift"])
        self.assertEqual(bundle["steps"][0]["key_name"], "Enter")
        self.assertEqual(bundle["steps"][1]["kind"], "scroll")
        self.assertEqual(bundle["steps"][2]["kind"], "wait")
        self.assertEqual(bundle["steps"][2]["gap_after_ms"], 750)
        self.assertEqual(bundle["steps"][3]["kind"], "right_click")
        self.assertEqual(bundle["steps"][3]["button"], 3)


class JournalAndCorrelationNegativeControlTests(unittest.TestCase):
    def test_journal_chain_tampering_and_duplicates_refused(self) -> None:
        lines, _ = _make_journal_lines()
        # 1. Tamper with prev_sha256 in the middle of the chain.
        bad_chain = list(lines)
        rec = json.loads(bad_chain[3])
        rec["prev_sha256"] = "f" * 64
        bad_chain[3] = canonical_json_bytes(rec).decode("utf-8")
        with self.assertRaises(ExportError) as ctx:
            verify_journal(bad_chain)
        self.assertEqual(ctx.exception.code, "chain_mismatch")

        # 2. Non-zero genesis prev_sha256 fails closed.
        bad_genesis = list(lines)
        rec1 = json.loads(bad_genesis[1])
        rec1["prev_sha256"] = "1" * 64
        bad_genesis[1] = canonical_json_bytes(rec1).decode("utf-8")
        with self.assertRaises(ExportError) as ctx:
            verify_journal(bad_genesis[:2])
        self.assertEqual(ctx.exception.code, "chain_mismatch")

        # 3. Duplicate msg_id fails closed.
        r1 = {
            "schema": SESSION_RECORD_SCHEMA,
            "core_seq": 1,
            "kind": "received",
            "msg_id": "dup-msg",
            "prev_sha256": GENESIS_PREV_SHA256,
        }
        r2 = {
            "schema": SESSION_RECORD_SCHEMA,
            "core_seq": 2,
            "kind": "admitted",
            "msg_id": "dup-msg",
            "prev_sha256": canonical_sha256(r1),
        }
        with self.assertRaises(ExportError) as ctx:
            verify_journal([r1, r2])
        self.assertEqual(ctx.exception.code, "duplicate_record")

        # 4. Mismatched explicit journal_head_sha256 fails closed.
        bundle, _ = _build_fixture_bundle()
        with self.assertRaises(ExportError) as ctx:
            build_export_bundle(
                site_id="acme-checkout",
                site_name="Acme Checkout",
                domains=["checkout.example.invalid"],
                recorded_date="2026-10-28",
                run_id="run-01",
                demo_id="demo-01",
                task_summary="Summary",
                journal=lines,
                journal_head_sha256="e" * 64,
                steps=bundle["steps"],
            )
        self.assertEqual(ctx.exception.code, "chain_mismatch")

    def test_unverified_receipt_and_uncorrelated_verdict_refused(self) -> None:
        proposal = {
            "schema": "action_proposal/v0.2",
            "proposal_id": "prop-1",
            "surface_id": "surf-checkout",
            "based_on_frame": {"sha256": SHA_0, "generation": 1},
            "action": {"type": "click", "x": 100, "y": 100, "button": "left"},
            "expectation": {"type": "text_present", "text": "Done"},
            "budget": {"max_ms": 1000, "max_retries": 0},
        }
        unverified_receipt = {
            "schema": "action_receipt/v0.2",
            "proposal_id": "prop-1",
            "executed_at_ns": 100,
            "after_frame": _make_frame_ref(SHA_1, 2),
            "verified": False,
            "verification": {"method": "pixel", "detail": "failed"},
            "error": "verification failed",
        }
        with self.assertRaises(ExportError) as ctx:
            project_step(seq=1, proposal=proposal, verdict="admitted", receipt=unverified_receipt)
        self.assertEqual(ctx.exception.code, "unverified_receipt")

        with self.assertRaises(ExportError) as ctx:
            project_step(seq=1, proposal=proposal, verdict="admitted", receipt=None)
        self.assertEqual(ctx.exception.code, "unverified_receipt")

        # Verdict claims admitted at core_seq=9 where journal recorded refused
        lines, _ = _make_journal_lines()
        bad_verdict = {
            "schema": "action_verdict/v0.2",
            "proposal_id": "prop-1",
            "decision": "admitted",
            "core_seq": 9,
        }
        good_receipt = dict(unverified_receipt, verified=True, error="")
        with self.assertRaises(ExportError) as ctx:
            build_export_bundle(
                site_id="acme-checkout",
                site_name="Acme Checkout",
                domains=["checkout.example.invalid"],
                recorded_date="2026-10-28",
                run_id="run-01",
                demo_id="demo-01",
                task_summary="Summary",
                journal=lines,
                proposals=[proposal],
                verdicts=[bad_verdict],
                receipts=[good_receipt],
            )
        self.assertEqual(ctx.exception.code, "uncorrelated")


class PrivacyScrubbingAndRefusalGateTests(unittest.TestCase):
    def test_scrub_metadata_and_text_strip_paths_cookies_keys_and_account_text(self) -> None:
        dirty_meta = {
            "ramws_path": P_SHM,
            "cookies": P_SET_COOKIE,
            "api_key": P_GH_MARKER,
            "account_text": P_ACCT_TEXT,
            "email": P_EMAIL,
            "capsule_id": "cap-01",
            "note": (
                f" captured at {P_SHM} with {P_COOKIE_HDR} and {P_ASSIGN_CRED} "
                f"for {P_ACCT_TEXT} ({P_EMAIL}) at {P_HOME} "
            ),
        }
        cleaned = scrub_metadata(dirty_meta)
        self.assertEqual(set(cleaned.keys()), {"note"})
        self.assertEqual(export._scan_forbidden_bundle(cleaned), [])

        state_with_dirty_title = _make_wender_state(
            title=f"Dashboard - {P_ACCT_TEXT} {P_EMAIL} {P_SHM} {P_COOKIE_HDR} {P_GH_MARKER}"
        )
        ref = project_state_ref(state_with_dirty_title, index=1)
        self.assertEqual(export._scan_forbidden_bundle(ref), [])

    def test_pixels_cookies_paths_credentials_and_pii_refused_in_bundle_validation(self) -> None:
        base, _ = _build_fixture_bundle()

        # 1. Raw Frame or pixel fields refused in scrub_metadata and validate_export_bundle
        with self.assertRaises(ExportError) as ctx:
            scrub_metadata({"frame": Frame(4, 4, bytes(48))})
        self.assertEqual(ctx.exception.code, "forbidden_pixels")

        with self.assertRaises(ExportError) as ctx:
            validate_export_bundle(P_PNG_MAGIC)
        self.assertEqual(ctx.exception.code, "forbidden_pixels")

        for field_key, expected_code in (
            ("pixels", "forbidden_pixels"),
            ("ramws_path", "forbidden_host_path"),
            ("cookies", "forbidden_cookie"),
            ("api_key", "forbidden_credential"),
            ("account_text", "forbidden_personal_data"),
        ):
            mut = copy.deepcopy(base)
            mut[field_key] = "present"
            with self.assertRaises(ExportError) as ctx:
                validate_export_bundle(mut)
            self.assertEqual(ctx.exception.code, expected_code)

        # 2. Planted string patterns in task_summary fail closed with exact category code
        string_cases = [
            (P_DATA_IMG, "forbidden_pixels"),
            (P_B64_PNG, "forbidden_pixels"),
            (P_B64_JPG, "forbidden_pixels"),
            (P_HOME, "forbidden_host_path"),
            (P_SHM, "forbidden_host_path"),
            (P_TMP, "forbidden_host_path"),
            (P_PROC, "forbidden_host_path"),
            (P_RAMWS, "forbidden_host_path"),
            (P_CAPSULE, "forbidden_host_path"),
            (P_TRACE, "forbidden_host_path"),
            (P_SET_COOKIE, "forbidden_cookie"),
            (P_COOKIE_HDR, "forbidden_cookie"),
            (P_DOC_COOKIE, "forbidden_cookie"),
            (P_HOST_COOKIE, "forbidden_cookie"),
            (P_PRIV_KEY, "forbidden_credential"),
            (P_AWS_MARKER, "forbidden_credential"),
            (P_GH_MARKER, "forbidden_credential"),
            (P_BEARER_MARKER, "forbidden_credential"),
            (P_JWT_MARKER, "forbidden_credential"),
            (P_URL_CRED, "forbidden_credential"),
            (P_ASSIGN_CRED, "forbidden_credential"),
            (P_EMAIL, "forbidden_personal_data"),
            (P_ACCT_TEXT, "forbidden_personal_data"),
            (P_SSN, "forbidden_personal_data"),
        ]
        for marker, expected_code in string_cases:
            with self.subTest(marker=expected_code):
                mut = copy.deepcopy(base)
                mut["task_summary"] = f"Run summary with {marker}"[:240]
                with self.assertRaises(ExportError) as ctx:
                    validate_export_bundle(mut)
                self.assertEqual(ctx.exception.code, expected_code)

    def test_semantic_and_schema_negative_controls(self) -> None:
        base, _ = _build_fixture_bundle()

        # Unknown property at root or nested step
        mut_unknown = copy.deepcopy(base)
        mut_unknown["steps"][0]["extra_field"] = 1
        with self.assertRaises(ExportError) as ctx:
            validate_export_bundle(mut_unknown)
        self.assertEqual(ctx.exception.code, "unknown_field")

        # Oversize raw bytes
        oversize = b'{"schema":"mw.run_bundle.v1","pad":"' + (b"a" * MAX_BUNDLE_BYTES) + b'"}'
        with self.assertRaises(ExportError) as ctx:
            validate_export_bundle(oversize)
        self.assertEqual(ctx.exception.code, "bundle_oversize")

        # Non-sequential step seq
        mut_seq = copy.deepcopy(base)
        mut_seq["steps"][1]["seq"] = 9
        with self.assertRaises(ExportError) as ctx:
            validate_export_bundle(mut_seq)
        self.assertEqual(ctx.exception.code, "semantic_error")

        # Paste step without text_len
        mut_paste = copy.deepcopy(base)
        mut_paste["steps"][1]["text_len"] = None
        with self.assertRaises(ExportError) as ctx:
            validate_export_bundle(mut_paste)
        self.assertEqual(ctx.exception.code, "semantic_error")

        # Non-positive box_px area
        mut_box = copy.deepcopy(base)
        mut_box["vision_elements"][0]["box_px"] = [500, 300, 500, 350]
        with self.assertRaises(ExportError) as ctx:
            validate_export_bundle(mut_box)
        self.assertEqual(ctx.exception.code, "semantic_error")

        # Recorded point outside viewport
        mut_pt = copy.deepcopy(base)
        mut_pt["steps"][0]["recorded_point_px"] = [1281, 310]
        with self.assertRaises(ExportError) as ctx:
            validate_export_bundle(mut_pt)
        self.assertEqual(ctx.exception.code, "semantic_error")

        # Duplicate ID across vision_elements and state_refs
        mut_dup = copy.deepcopy(base)
        mut_dup["state_refs"][0]["id"] = mut_dup["vision_elements"][0]["id"]
        with self.assertRaises(ExportError) as ctx:
            validate_export_bundle(mut_dup)
        self.assertEqual(ctx.exception.code, "semantic_error")

        # Refusal step_seq > len(steps)
        mut_rseq = copy.deepcopy(base)
        mut_rseq["refusals"][0]["step_seq"] = 99
        with self.assertRaises(ExportError) as ctx:
            validate_export_bundle(mut_rseq)
        self.assertEqual(ctx.exception.code, "semantic_error")

        # Invalid domain hostname (single label without dot)
        mut_dom = copy.deepcopy(base)
        mut_dom["domains"] = ["localhost"]
        with self.assertRaises(ExportError) as ctx:
            validate_export_bundle(mut_dom)
        self.assertEqual(ctx.exception.code, "semantic_error")


if __name__ == "__main__":
    unittest.main()
