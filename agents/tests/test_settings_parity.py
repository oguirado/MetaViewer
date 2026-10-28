"""Cross-language max_fps and settings contract parity tests for Python agents."""

from __future__ import annotations

import copy
import importlib.util
import inspect
import json
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENTS_ROOT = REPO_ROOT / "agents"
if str(AGENTS_ROOT) not in sys.path:
    sys.path.insert(0, str(AGENTS_ROOT))

from metaviewer_agents import _contracts_v02, tools
from metaviewer_agents.tools import ToolValidationError, _check_record_request, record_start

FIXTURE_PATH = REPO_ROOT / "tests" / "fixtures" / "settings_parity.json"


def _load_contracts_validator():
    spec = importlib.util.spec_from_file_location(
        "check_contracts", REPO_ROOT / "tools" / "check_contracts.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.Validator(REPO_ROOT / "contracts" / "v0.2"), module.ValidationError


class _RecordingClient:
    def __init__(self, mode: str = "ram") -> None:
        self.mode = mode
        self.calls: list[dict] = []

    def request(self, body: dict, expect: str, *, timeout_ms: int) -> dict:
        self.calls.append(copy.deepcopy(body))
        return {
            "schema": "record_event/v0.2",
            "request_id": body["request_id"],
            "surface_id": body["params"]["surface_id"],
            "recording_id": body["params"]["recording_id"],
            "event": "started",
            "mono_ns": 100,
            "mode": self.mode,
        }


class SettingsParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.vectors = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        cls.validator, cls.validation_error = _load_contracts_validator()
        cls.embedded_settings_schema = _contracts_v02.FILES["settings.schema.json"]

    def test_d1_requires_explicit_integer_max_fps_and_pins_default_thirty(self) -> None:
        sig = inspect.signature(record_start)
        self.assertEqual(
            sig.parameters["max_fps"].default,
            self.vectors["contract_bounds"]["defaults"]["python_record_start_fps"],
        )

        valid_req = copy.deepcopy(self.vectors["d1_lenient_default"]["valid_ram_start_fps_20"])
        checked = _check_record_request(valid_req, expected_op="ram_start")
        self.assertEqual(checked["params"]["max_fps"], 20)

        for entry in self.vectors["d1_lenient_default"]["invalid_requests"]:
            with self.subTest(case=entry["id"]):
                with self.assertRaises(ToolValidationError):
                    _check_record_request(copy.deepcopy(entry["request"]))

    def test_d2_accepts_1_to_120_including_61_to_120_and_refuses_out_of_contract(self) -> None:
        d2 = self.vectors["d2_ceiling_sixty_vs_one_twenty"]
        all_valid = list(d2["accepted_1_to_60"]) + list(d2["contract_valid_61_to_120"])

        for fps in all_valid:
            with self.subTest(fps=fps):
                ram_client = _RecordingClient(mode="ram")
                started_ram = record_start(
                    "s1",
                    f"rec-ram-{fps}",
                    mode="ram",
                    ring_bytes=8388608,
                    max_fps=fps,
                    client=ram_client,
                    timeout_ms=1000,
                )
                self.assertEqual(started_ram["event"], "started")
                self.assertEqual(ram_client.calls[-1]["params"]["max_fps"], fps)

                disk_client = _RecordingClient(mode="disk")
                started_disk = record_start(
                    "s1",
                    f"rec-disk-{fps}",
                    mode="disk",
                    max_fps=fps,
                    destination_capability_id="recording:configured",
                    destination_path="/tmp/mv-export",
                    client=disk_client,
                    timeout_ms=1000,
                )
                self.assertEqual(started_disk["event"], "started")
                self.assertEqual(disk_client.calls[-1]["params"]["max_fps"], fps)

        for bad_fps in d2["out_of_contract_fps"]:
            with self.subTest(bad_fps=bad_fps):
                with self.assertRaises(ToolValidationError):
                    record_start(
                        "s1",
                        "rec-bad",
                        mode="ram",
                        ring_bytes=8388608,
                        max_fps=bad_fps,
                        client=_RecordingClient(mode="ram"),
                        timeout_ms=1000,
                    )

    def test_d3_refuses_json_float_lexeme_30_point_0(self) -> None:
        d3 = self.vectors["d3_float_lexeme"]
        ram_from_json = json.loads(d3["record_request_ram_start_30_0_json"])
        disk_from_json = json.loads(d3["record_request_disk_start_30_0_json"])
        settings_from_json = json.loads(d3["settings_v02_limits_30_0_json"])

        self.assertIs(type(ram_from_json["params"]["max_fps"]), float)
        with self.assertRaises(ToolValidationError):
            _check_record_request(ram_from_json, expected_op="ram_start")

        self.assertIs(type(disk_from_json["params"]["max_fps"]), float)
        with self.assertRaises(ToolValidationError):
            _check_record_request(disk_from_json, expected_op="disk_start")

        self.assertIs(type(settings_from_json["limits"]["max_fps"]), float)
        with self.assertRaises(self.validation_error):
            self.validator.validate(settings_from_json, self.embedded_settings_schema)

    def test_d4_refuses_unknown_keys_in_record_request_and_settings_schema(self) -> None:
        d4 = self.vectors["d4_unknown_keys"]
        for key in ("record_request_unknown_top", "record_request_unknown_param"):
            with self.subTest(case=key):
                with self.assertRaises(ToolValidationError):
                    _check_record_request(copy.deepcopy(d4[key]))

        for key in ("settings_v02_unknown_top", "settings_v02_unknown_limit"):
            with self.subTest(case=key):
                with self.assertRaises(self.validation_error):
                    self.validator.validate(copy.deepcopy(d4[key]), self.embedded_settings_schema)

    def test_d5_embedded_settings_schema_pins_limits_max_fps_and_runtime_decoder_absence(self) -> None:
        limits_props = self.embedded_settings_schema["properties"]["limits"]["properties"]
        self.assertEqual(
            limits_props["max_fps"],
            {"type": "integer", "minimum": 1, "maximum": 120},
        )
        self.assertFalse(hasattr(tools, "_check_settings"))

        for entry in self.vectors["d5_settings_limits"]["valid_settings_v02"]:
            with self.subTest(valid=entry["id"]):
                self.validator.validate(copy.deepcopy(entry["doc"]), self.embedded_settings_schema)

        for entry in self.vectors["d5_settings_limits"]["invalid_settings_v02"]:
            with self.subTest(invalid=entry["id"]):
                with self.assertRaises(self.validation_error):
                    self.validator.validate(copy.deepcopy(entry["doc"]), self.embedded_settings_schema)


if __name__ == "__main__":
    unittest.main()
