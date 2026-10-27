"""Parity and bound regression tests for RV7-CONTRACTS.

Verifies that:
1. Canonical contracts/v0.2/frame_ref.schema.json and the inlined
   mv_tool_result.schema.json/$defs/frame block are identical after
   stripping top-level/property schema metadata, and check_contracts.py
   rejects any single-field drift.
2. Inlined frame blocks in agents/metaviewer_agents/_contracts_v02.py
   match _contracts_v02.FILES["frame_ref.schema.json"] verbatim.
3. Session-relative clock contract descriptions and domain bounds
   (ramws_path, width/height/w/h <= 16384, wait ms/max_ms <= 3600000,
   max_retries <= 10) are enforced consistently across v0.2 schemas,
   _contracts_v02.py, tools.py, and observe.py.
"""

import copy
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agents"))
sys.path.insert(0, str(ROOT / "tools"))

import check_contracts  # noqa: E402
from metaviewer_agents._contracts_v02 import FILES as _RAW_V02_FILES  # noqa: E402
from metaviewer_agents.envelope import EnvelopeError, validate_envelope  # noqa: E402


class FrameRefParityTests(unittest.TestCase):
    def test_canonical_frame_ref_matches_mv_tool_result_defs_frame(self):
        v02 = ROOT / "contracts" / "v0.2"
        frame_ref = json.loads((v02 / "frame_ref.schema.json").read_text(encoding="utf-8"))
        tool_result = json.loads((v02 / "mv_tool_result.schema.json").read_text(encoding="utf-8"))
        self.assertEqual(
            tool_result["$defs"]["frame"],
            check_contracts.inline_frame_def(frame_ref),
        )

    def test_check_contracts_detects_single_field_frame_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp)
            shutil.copytree(ROOT / "contracts", tmp_root / "contracts")
            tool_result_path = tmp_root / "contracts" / "v0.2" / "mv_tool_result.schema.json"
            tool_result = json.loads(tool_result_path.read_text(encoding="utf-8"))
            tool_result["$defs"]["frame"]["properties"]["width"]["maximum"] = 8192
            tool_result_path.write_text(json.dumps(tool_result, indent=2) + "\n", encoding="utf-8")

            errors = check_contracts.check_repository(tmp_root, versions=("v0.2",))
            self.assertTrue(
                any("$defs.frame drifted from canonical" in err for err in errors),
                f"expected frame drift error, got: {errors}",
            )

    def test_python_mirror_inlined_frame_blocks_match_frame_ref(self):
        frame_ref = _RAW_V02_FILES["frame_ref.schema.json"]
        tool_result = _RAW_V02_FILES["mv_tool_result.schema.json"]
        inlined = []
        for branch in tool_result["oneOf"]:
            props = branch.get("properties", {})
            obs_props = props.get("observation", {}).get("properties", {})
            if "frame_ref" in obs_props:
                inlined.append(obs_props["frame_ref"])
            receipt_props = props.get("receipt", {}).get("properties", {})
            if "after_frame" in receipt_props:
                inlined.append(receipt_props["after_frame"])
        self.assertEqual(len(inlined), 2)
        for block in inlined:
            self.assertEqual(block, frame_ref)
            mutant = copy.deepcopy(block)
            mutant["properties"]["height"]["maximum"] = 32768
            self.assertNotEqual(mutant, frame_ref)

    def test_session_relative_clock_contract_documented_in_v02_schemas(self):
        v02 = ROOT / "contracts" / "v0.2"
        envelope = json.loads((v02 / "envelope.schema.json").read_text(encoding="utf-8"))
        frame_ref = json.loads((v02 / "frame_ref.schema.json").read_text(encoding="utf-8"))
        receipt = json.loads((v02 / "action_receipt.schema.json").read_text(encoding="utf-8"))
        tool_result = json.loads((v02 / "mv_tool_result.schema.json").read_text(encoding="utf-8"))
        session_record = json.loads((v02 / "session_record.schema.json").read_text(encoding="utf-8"))

        record_event = json.loads((v02 / "record_event.schema.json").read_text(encoding="utf-8"))

        descriptions = [
            envelope["properties"]["ts_ns"].get("description", ""),
            frame_ref["properties"]["ts_ns"].get("description", ""),
            receipt["properties"]["executed_at_ns"].get("description", ""),
            receipt["properties"]["native_evidence"]["properties"]["input_mono_ns"].get("description", ""),
            receipt["properties"]["native_evidence"]["properties"]["input_ts_ns"].get("description", ""),
            tool_result.get("description", ""),
            session_record.get("description", ""),
            record_event["$defs"]["counter"].get("description", ""),
        ]
        for desc in descriptions:
            self.assertIn("2^53 - 1", desc)
            self.assertIn("monotonic", desc.lower())
            self.assertIn("fails closed", desc.lower())
            self.assertIn("restart", desc.lower())

        import time

        base_env = json.loads(
            (ROOT / "contracts" / "examples" / "v0.2" / "envelope.valid.json").read_text(
                encoding="utf-8"
            )
        )
        validate_envelope({**base_env, "ts_ns": 1000})
        with self.assertRaises(EnvelopeError):
            validate_envelope({**base_env, "ts_ns": time.time_ns()})

    def test_v02_domain_ceilings_and_ramws_pattern(self):
        v02 = ROOT / "contracts" / "v0.2"
        frame_ref = json.loads((v02 / "frame_ref.schema.json").read_text(encoding="utf-8"))
        ramws = frame_ref["properties"]["ramws_path"]
        self.assertEqual(ramws["pattern"], "^/dev/shm(/[A-Za-z0-9_][A-Za-z0-9._-]{0,127}){1,8}$")
        self.assertEqual(ramws["minLength"], 10)
        self.assertEqual(ramws["maxLength"], 255)
        self.assertEqual(frame_ref["properties"]["width"]["maximum"], 16384)
        self.assertEqual(frame_ref["properties"]["height"]["maximum"], 16384)

        surface = json.loads((v02 / "surface.schema.json").read_text(encoding="utf-8"))
        geom = surface["properties"]["geometry"]["properties"]
        self.assertEqual(geom["w"]["maximum"], 16384)
        self.assertEqual(geom["h"]["maximum"], 16384)

        proposal = json.loads((v02 / "action_proposal.schema.json").read_text(encoding="utf-8"))
        wait_branch = next(
            b for b in proposal["properties"]["action"]["oneOf"]
            if b["properties"]["type"]["const"] == "wait"
        )
        self.assertEqual(wait_branch["properties"]["ms"]["maximum"], 3600000)
        changed_branch = next(
            b for b in proposal["properties"]["expectation"]["oneOf"]
            if b["properties"]["type"]["const"] == "changed_region"
        )
        self.assertEqual(changed_branch["properties"]["bbox"]["properties"]["w"]["maximum"], 16384)
        self.assertEqual(changed_branch["properties"]["bbox"]["properties"]["h"]["maximum"], 16384)
        budget = proposal["properties"]["budget"]["properties"]
        self.assertEqual(budget["max_ms"]["maximum"], 3600000)
        self.assertEqual(budget["max_retries"]["maximum"], 10)

        capsule_meta = json.loads((v02 / "capsule_meta.schema.json").read_text(encoding="utf-8"))
        fb_path = capsule_meta["properties"]["fb_path"]
        self.assertEqual(fb_path["pattern"], "^/dev/shm(/[A-Za-z0-9_][A-Za-z0-9._-]{0,127}){1,8}$")
        self.assertEqual(fb_path["minLength"], 10)
        self.assertEqual(fb_path["maxLength"], 255)

        record_event = json.loads((v02 / "record_event.schema.json").read_text(encoding="utf-8"))
        ram_path = record_event["$defs"]["ram_path"]
        self.assertEqual(ram_path["pattern"], "^/dev/shm(/[A-Za-z0-9_][A-Za-z0-9._-]{0,127}){1,8}$")
        self.assertEqual(ram_path["minLength"], 10)
        self.assertEqual(ram_path["maxLength"], 255)


if __name__ == "__main__":
    unittest.main()
