"""Four-way cross-language decoder conformance matrix (T6R2-013).

Runs every contracts/examples/v0.2/*.json fixture plus the T6R2-001..007
adversarial mutations and their positive controls through:
  - Rust: metaviewer_core::decode_envelope
  - Go: metaviewer/daemon-adapter/internal/ipc SchemaPolicy.ValidateEnvelope
  - Python: metaviewer_agents.envelope.validate_envelope
  - Checker: tools.check_contracts.loads_strict + Validator.validate

Asserts unanimous verdicts across all four decoders on all 475+ contract
example fixtures and positive controls, and pins the T6R2-001..007 negative
controls (documenting the pre-U1..U5 splits until U1..U5 land, and enforcing
unanimous refusal once each decoder fix is present).
"""

import ast
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "agents"))

from metaviewer_agents.envelope import EnvelopeError, validate_envelope
from tools.check_contracts import ValidationError, Validator, loads_strict


# Reviewed additions are separate from the preserved upstream fixture corpus.
ADDITIVE_FIXTURE_NAMES = frozenset(['capsule_capabilities.invalid.extra-property.json', 'capsule_capabilities.valid.json', 'capsule_capabilities.valid.ready.json', 'capsule_capabilities.valid.unsupported.json', 'capsule_envelope.invalid.extra.json', 'capsule_envelope.invalid.legacy_body.json', 'capsule_envelope.invalid.old_tag.json', 'capsule_envelope.valid.endpoint_agent.json', 'capsule_envelope.valid.endpoint_core.json', 'capsule_envelope.valid.endpoint_daemon.json', 'capsule_envelope.valid.endpoint_ui.json', 'capsule_envelope.valid.endpoint_vision.json', 'capsule_envelope.valid.endpoint_wender.json', 'capsule_envelope.valid.guest_command_event.0.json', 'capsule_envelope.valid.guest_command_event.1.json', 'capsule_envelope.valid.guest_command_event.10.json', 'capsule_envelope.valid.guest_command_event.11.json', 'capsule_envelope.valid.guest_command_event.12.json', 'capsule_envelope.valid.guest_command_event.13.json', 'capsule_envelope.valid.guest_command_event.14.json', 'capsule_envelope.valid.guest_command_event.15.json', 'capsule_envelope.valid.guest_command_event.16.json', 'capsule_envelope.valid.guest_command_event.17.json', 'capsule_envelope.valid.guest_command_event.18.json', 'capsule_envelope.valid.guest_command_event.19.json', 'capsule_envelope.valid.guest_command_event.2.json', 'capsule_envelope.valid.guest_command_event.20.json', 'capsule_envelope.valid.guest_command_event.21.json', 'capsule_envelope.valid.guest_command_event.22.json', 'capsule_envelope.valid.guest_command_event.23.json', 'capsule_envelope.valid.guest_command_event.24.json', 'capsule_envelope.valid.guest_command_event.25.json', 'capsule_envelope.valid.guest_command_event.26.json', 'capsule_envelope.valid.guest_command_event.27.json', 'capsule_envelope.valid.guest_command_event.28.json', 'capsule_envelope.valid.guest_command_event.29.json', 'capsule_envelope.valid.guest_command_event.3.json', 'capsule_envelope.valid.guest_command_event.30.json', 'capsule_envelope.valid.guest_command_event.31.json', 'capsule_envelope.valid.guest_command_event.32.json', 'capsule_envelope.valid.guest_command_event.33.json', 'capsule_envelope.valid.guest_command_event.34.json', 'capsule_envelope.valid.guest_command_event.35.json', 'capsule_envelope.valid.guest_command_event.36.json', 'capsule_envelope.valid.guest_command_event.37.json', 'capsule_envelope.valid.guest_command_event.38.json', 'capsule_envelope.valid.guest_command_event.39.json', 'capsule_envelope.valid.guest_command_event.4.json', 'capsule_envelope.valid.guest_command_event.40.json', 'capsule_envelope.valid.guest_command_event.41.json', 'capsule_envelope.valid.guest_command_event.42.json', 'capsule_envelope.valid.guest_command_event.43.json', 'capsule_envelope.valid.guest_command_event.44.json', 'capsule_envelope.valid.guest_command_event.45.json', 'capsule_envelope.valid.guest_command_event.46.json', 'capsule_envelope.valid.guest_command_event.47.json', 'capsule_envelope.valid.guest_command_event.48.json', 'capsule_envelope.valid.guest_command_event.49.json', 'capsule_envelope.valid.guest_command_event.5.json', 'capsule_envelope.valid.guest_command_event.50.json', 'capsule_envelope.valid.guest_command_event.51.json', 'capsule_envelope.valid.guest_command_event.52.json', 'capsule_envelope.valid.guest_command_event.53.json', 'capsule_envelope.valid.guest_command_event.54.json', 'capsule_envelope.valid.guest_command_event.6.json', 'capsule_envelope.valid.guest_command_event.7.json', 'capsule_envelope.valid.guest_command_event.8.json', 'capsule_envelope.valid.guest_command_event.9.json', 'capsule_envelope.valid.guest_command_request.0.json', 'capsule_envelope.valid.guest_command_request.1.json', 'capsule_envelope.valid.guest_command_request.2.json', 'capsule_envelope.valid.guest_command_request.3.json', 'capsule_envelope.valid.guest_command_request.4.json', 'capsule_envelope.valid.headless_event.valid.accepted_1.json', 'capsule_envelope.valid.headless_event.valid.accepted_2.json', 'capsule_envelope.valid.headless_event.valid.accepted_3.json', 'capsule_envelope.valid.headless_event.valid.accepted_qemu.json', 'capsule_envelope.valid.headless_event.valid.completed_5.json', 'capsule_envelope.valid.headless_event.valid.refused_bad_request.json', 'capsule_envelope.valid.headless_event.valid.refused_busy.json', 'capsule_envelope.valid.headless_event.valid.refused_duplicate_job.json', 'capsule_envelope.valid.headless_event.valid.refused_duplicate_request.json', 'capsule_envelope.valid.headless_event.valid.refused_known_workload.json', 'capsule_envelope.valid.headless_event.valid.refused_out_of_order.json', 'capsule_envelope.valid.headless_event.valid.refused_owner_mismatch.json', 'capsule_envelope.valid.headless_event.valid.refused_policy.json', 'capsule_envelope.valid.headless_event.valid.refused_stale_generation.json', 'capsule_envelope.valid.headless_event.valid.refused_unavailable.json', 'capsule_envelope.valid.headless_event.valid.refused_unknown_workload.json', 'capsule_envelope.valid.headless_event.valid.state_changed_4.json', 'capsule_envelope.valid.headless_event.valid.state_changed_6.json', 'capsule_envelope.valid.headless_event.valid.stopped_no_job_qemu.json', 'capsule_envelope.valid.headless_event.valid.unknown_create.json', 'capsule_envelope.valid.headless_event.valid.unknown_run.json', 'capsule_envelope.valid.headless_event.valid.unknown_stop.json', 'capsule_envelope.valid.headless_request.valid.create.json', 'capsule_envelope.valid.headless_request.valid.run.json', 'capsule_envelope.valid.headless_request.valid.stop.json', 'capsule_envelope.valid.json', 'capsule_resource_inventory.invalid.bad_hash.json', 'capsule_resource_inventory.invalid.extra.json', 'capsule_resource_inventory.invalid.sequence_zero.json', 'capsule_resource_inventory.valid.json', 'capsule_resource_inventory.valid.session.json', 'guest_command_event.invalid.extra.json', 'guest_command_event.valid.generated0.json', 'guest_command_event.valid.generated1.json', 'guest_command_event.valid.generated10.json', 'guest_command_event.valid.generated11.json', 'guest_command_event.valid.generated12.json', 'guest_command_event.valid.generated13.json', 'guest_command_event.valid.generated14.json', 'guest_command_event.valid.generated15.json', 'guest_command_event.valid.generated16.json', 'guest_command_event.valid.generated17.json', 'guest_command_event.valid.generated18.json', 'guest_command_event.valid.generated19.json', 'guest_command_event.valid.generated2.json', 'guest_command_event.valid.generated20.json', 'guest_command_event.valid.generated21.json', 'guest_command_event.valid.generated22.json', 'guest_command_event.valid.generated23.json', 'guest_command_event.valid.generated24.json', 'guest_command_event.valid.generated25.json', 'guest_command_event.valid.generated26.json', 'guest_command_event.valid.generated27.json', 'guest_command_event.valid.generated28.json', 'guest_command_event.valid.generated29.json', 'guest_command_event.valid.generated3.json', 'guest_command_event.valid.generated30.json', 'guest_command_event.valid.generated31.json', 'guest_command_event.valid.generated32.json', 'guest_command_event.valid.generated33.json', 'guest_command_event.valid.generated34.json', 'guest_command_event.valid.generated35.json', 'guest_command_event.valid.generated36.json', 'guest_command_event.valid.generated37.json', 'guest_command_event.valid.generated38.json', 'guest_command_event.valid.generated39.json', 'guest_command_event.valid.generated4.json', 'guest_command_event.valid.generated40.json', 'guest_command_event.valid.generated41.json', 'guest_command_event.valid.generated42.json', 'guest_command_event.valid.generated43.json', 'guest_command_event.valid.generated44.json', 'guest_command_event.valid.generated45.json', 'guest_command_event.valid.generated46.json', 'guest_command_event.valid.generated47.json', 'guest_command_event.valid.generated48.json', 'guest_command_event.valid.generated49.json', 'guest_command_event.valid.generated5.json', 'guest_command_event.valid.generated50.json', 'guest_command_event.valid.generated51.json', 'guest_command_event.valid.generated52.json', 'guest_command_event.valid.generated53.json', 'guest_command_event.valid.generated6.json', 'guest_command_event.valid.generated7.json', 'guest_command_event.valid.generated8.json', 'guest_command_event.valid.generated9.json', 'guest_command_event.valid.json', 'guest_command_request.invalid.extra.json', 'guest_command_request.valid.generated0.json', 'guest_command_request.valid.generated1.json', 'guest_command_request.valid.generated2.json', 'guest_command_request.valid.generated3.json', 'guest_command_request.valid.json', 'guest_command_session.invalid.extra.json', 'guest_command_session.valid.generated0.json', 'guest_command_session.valid.generated1.json', 'guest_command_session.valid.generated10.json', 'guest_command_session.valid.generated11.json', 'guest_command_session.valid.generated12.json', 'guest_command_session.valid.generated13.json', 'guest_command_session.valid.generated14.json', 'guest_command_session.valid.generated15.json', 'guest_command_session.valid.generated16.json', 'guest_command_session.valid.generated17.json', 'guest_command_session.valid.generated18.json', 'guest_command_session.valid.generated19.json', 'guest_command_session.valid.generated2.json', 'guest_command_session.valid.generated20.json', 'guest_command_session.valid.generated21.json', 'guest_command_session.valid.generated22.json', 'guest_command_session.valid.generated3.json', 'guest_command_session.valid.generated4.json', 'guest_command_session.valid.generated5.json', 'guest_command_session.valid.generated6.json', 'guest_command_session.valid.generated7.json', 'guest_command_session.valid.generated8.json', 'guest_command_session.valid.generated9.json', 'guest_command_session.valid.json', 'guest_transport_metadata.invalid.extra.json', 'guest_transport_metadata.valid.generated0.json', 'guest_transport_metadata.valid.generated1.json', 'guest_transport_metadata.valid.generated10.json', 'guest_transport_metadata.valid.generated11.json', 'guest_transport_metadata.valid.generated12.json', 'guest_transport_metadata.valid.generated13.json', 'guest_transport_metadata.valid.generated14.json', 'guest_transport_metadata.valid.generated15.json', 'guest_transport_metadata.valid.generated16.json', 'guest_transport_metadata.valid.generated17.json', 'guest_transport_metadata.valid.generated18.json', 'guest_transport_metadata.valid.generated19.json', 'guest_transport_metadata.valid.generated2.json', 'guest_transport_metadata.valid.generated20.json', 'guest_transport_metadata.valid.generated21.json', 'guest_transport_metadata.valid.generated22.json', 'guest_transport_metadata.valid.generated23.json', 'guest_transport_metadata.valid.generated24.json', 'guest_transport_metadata.valid.generated25.json', 'guest_transport_metadata.valid.generated26.json', 'guest_transport_metadata.valid.generated27.json', 'guest_transport_metadata.valid.generated28.json', 'guest_transport_metadata.valid.generated29.json', 'guest_transport_metadata.valid.generated3.json', 'guest_transport_metadata.valid.generated4.json', 'guest_transport_metadata.valid.generated5.json', 'guest_transport_metadata.valid.generated6.json', 'guest_transport_metadata.valid.generated7.json', 'guest_transport_metadata.valid.generated8.json', 'guest_transport_metadata.valid.generated9.json', 'guest_transport_metadata.valid.json', 'headless_event.invalid.bool_value.json', 'headless_event.invalid.extra_nonce.json', 'headless_event.invalid.unknown_code.json', 'headless_event.valid.accepted_1.json', 'headless_event.valid.accepted_2.json', 'headless_event.valid.accepted_3.json', 'headless_event.valid.accepted_qemu.json', 'headless_event.valid.completed_5.json', 'headless_event.valid.json', 'headless_event.valid.refused_bad_request.json', 'headless_event.valid.refused_busy.json', 'headless_event.valid.refused_duplicate_job.json', 'headless_event.valid.refused_duplicate_request.json', 'headless_event.valid.refused_known_workload.json', 'headless_event.valid.refused_out_of_order.json', 'headless_event.valid.refused_owner_mismatch.json', 'headless_event.valid.refused_policy.json', 'headless_event.valid.refused_stale_generation.json', 'headless_event.valid.refused_unavailable.json', 'headless_event.valid.refused_unknown_workload.json', 'headless_event.valid.state_changed_4.json', 'headless_event.valid.state_changed_6.json', 'headless_event.valid.stopped_no_job_qemu.json', 'headless_event.valid.unknown_create.json', 'headless_event.valid.unknown_run.json', 'headless_event.valid.unknown_stop.json', 'headless_request.invalid.bool_n.json', 'headless_request.invalid.large_n.json', 'headless_request.invalid.renderer_backend.json', 'headless_request.invalid.renderer_path.json', 'headless_request.invalid.shell.json', 'headless_request.invalid.stale_zero.json', 'headless_request.invalid.wrong_id_namespace.json', 'headless_request.valid.create.json', 'headless_request.valid.json', 'headless_request.valid.run.json', 'headless_request.valid.stop.json', 'headless_session.invalid.bool_generation.json', 'headless_session.invalid.display.json', 'headless_session.invalid.released_uncertain.json', 'headless_session.invalid.wrong_isa.json', 'headless_session.valid.completed.json', 'headless_session.valid.json', 'headless_session.valid.ready.json', 'headless_session.valid.running.json', 'headless_session.valid.starting.json', 'headless_session.valid.stopped.json', 'headless_session.valid.stopped_no_job_qemu.json', 'headless_session.valid.stopping.json', 'headless_session.valid.uncertain.json', 'rewind_envelope.invalid.extra.json', 'rewind_envelope.invalid.legacy_body.json', 'rewind_envelope.invalid.old_family.json', 'rewind_envelope.invalid.sequence.json', 'rewind_envelope.valid.accepted_stop_dominates.json', 'rewind_envelope.valid.completed_stop_dominates.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_accepted.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_accepted_stop_dominates.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_completed.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_completed_stop_dominates.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage25.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage26.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage27.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage28.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage29.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage30.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage31.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage32.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage33.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage34.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage35.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage36.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage37.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage38.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage39.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage40.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage41.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage42.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage43.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage44.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage45.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage46.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage47.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage48.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage49.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage50.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage51.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage52.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage53.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage54.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage56.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage57.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage58.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage59.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage60.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage61.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage62.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage63.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage64.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage65.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage66.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage67.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage68.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage69.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage70.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage71.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage72.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage73.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage74.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage75.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage76.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage77.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage78.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage79.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage80.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage81.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_coverage82.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_outcome_unknown.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_recovery_ready.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_refused.json', 'rewind_envelope.valid.counter_rewind_event_valid_counter_rewind_event_valid_refused_recoverable.json', 'rewind_envelope.valid.coverage100.json', 'rewind_envelope.valid.coverage101.json', 'rewind_envelope.valid.coverage102.json', 'rewind_envelope.valid.coverage103.json', 'rewind_envelope.valid.coverage104.json', 'rewind_envelope.valid.coverage105.json', 'rewind_envelope.valid.coverage106.json', 'rewind_envelope.valid.coverage107.json', 'rewind_envelope.valid.coverage108.json', 'rewind_envelope.valid.coverage109.json', 'rewind_envelope.valid.coverage110.json', 'rewind_envelope.valid.coverage111.json', 'rewind_envelope.valid.coverage112.json', 'rewind_envelope.valid.coverage113.json', 'rewind_envelope.valid.coverage114.json', 'rewind_envelope.valid.coverage115.json', 'rewind_envelope.valid.coverage116.json', 'rewind_envelope.valid.coverage117.json', 'rewind_envelope.valid.coverage118.json', 'rewind_envelope.valid.coverage119.json', 'rewind_envelope.valid.coverage120.json', 'rewind_envelope.valid.coverage121.json', 'rewind_envelope.valid.coverage122.json', 'rewind_envelope.valid.coverage123.json', 'rewind_envelope.valid.coverage124.json', 'rewind_envelope.valid.coverage125.json', 'rewind_envelope.valid.coverage126.json', 'rewind_envelope.valid.coverage127.json', 'rewind_envelope.valid.coverage128.json', 'rewind_envelope.valid.coverage129.json', 'rewind_envelope.valid.coverage130.json', 'rewind_envelope.valid.coverage131.json', 'rewind_envelope.valid.coverage132.json', 'rewind_envelope.valid.coverage133.json', 'rewind_envelope.valid.coverage134.json', 'rewind_envelope.valid.coverage135.json', 'rewind_envelope.valid.coverage136.json', 'rewind_envelope.valid.coverage137.json', 'rewind_envelope.valid.coverage138.json', 'rewind_envelope.valid.coverage139.json', 'rewind_envelope.valid.coverage140.json', 'rewind_envelope.valid.coverage141.json', 'rewind_envelope.valid.coverage142.json', 'rewind_envelope.valid.coverage143.json', 'rewind_envelope.valid.coverage144.json', 'rewind_envelope.valid.coverage145.json', 'rewind_envelope.valid.coverage146.json', 'rewind_envelope.valid.coverage147.json', 'rewind_envelope.valid.coverage148.json', 'rewind_envelope.valid.coverage149.json', 'rewind_envelope.valid.coverage150.json', 'rewind_envelope.valid.coverage151.json', 'rewind_envelope.valid.coverage152.json', 'rewind_envelope.valid.coverage153.json', 'rewind_envelope.valid.coverage154.json', 'rewind_envelope.valid.coverage155.json', 'rewind_envelope.valid.coverage156.json', 'rewind_envelope.valid.coverage83.json', 'rewind_envelope.valid.coverage84.json', 'rewind_envelope.valid.coverage85.json', 'rewind_envelope.valid.coverage86.json', 'rewind_envelope.valid.coverage87.json', 'rewind_envelope.valid.coverage88.json', 'rewind_envelope.valid.coverage89.json', 'rewind_envelope.valid.coverage90.json', 'rewind_envelope.valid.coverage91.json', 'rewind_envelope.valid.coverage92.json', 'rewind_envelope.valid.coverage93.json', 'rewind_envelope.valid.coverage94.json', 'rewind_envelope.valid.coverage95.json', 'rewind_envelope.valid.coverage96.json', 'rewind_envelope.valid.coverage97.json', 'rewind_envelope.valid.coverage98.json', 'rewind_envelope.valid.coverage99.json', 'rewind_envelope.valid.event.json', 'rewind_envelope.valid.json', 'rewind_envelope.valid.recovery_ready.json', 'rewind_envelope.valid.refused_recoverable.json', 'rewind_envelope.valid.unknown_no_session.json', 'rewind_event.invalid.extra.json', 'rewind_event.invalid.phase.json', 'rewind_event.invalid.recovery_extra.json', 'rewind_event.invalid.recovery_live.json', 'rewind_event.valid.accepted.json', 'rewind_event.valid.accepted_stop_dominates.json', 'rewind_event.valid.completed.json', 'rewind_event.valid.completed_stop_dominates.json', 'rewind_event.valid.counter_rewind_event_valid.json', 'rewind_event.valid.counter_rewind_event_valid_accepted.json', 'rewind_event.valid.counter_rewind_event_valid_accepted_stop_dominates.json', 'rewind_event.valid.counter_rewind_event_valid_completed.json', 'rewind_event.valid.counter_rewind_event_valid_completed_stop_dominates.json', 'rewind_event.valid.counter_rewind_event_valid_coverage25.json', 'rewind_event.valid.counter_rewind_event_valid_coverage26.json', 'rewind_event.valid.counter_rewind_event_valid_coverage27.json', 'rewind_event.valid.counter_rewind_event_valid_coverage28.json', 'rewind_event.valid.counter_rewind_event_valid_coverage29.json', 'rewind_event.valid.counter_rewind_event_valid_coverage30.json', 'rewind_event.valid.counter_rewind_event_valid_coverage31.json', 'rewind_event.valid.counter_rewind_event_valid_coverage32.json', 'rewind_event.valid.counter_rewind_event_valid_coverage33.json', 'rewind_event.valid.counter_rewind_event_valid_coverage34.json', 'rewind_event.valid.counter_rewind_event_valid_coverage35.json', 'rewind_event.valid.counter_rewind_event_valid_coverage36.json', 'rewind_event.valid.counter_rewind_event_valid_coverage37.json', 'rewind_event.valid.counter_rewind_event_valid_coverage38.json', 'rewind_event.valid.counter_rewind_event_valid_coverage39.json', 'rewind_event.valid.counter_rewind_event_valid_coverage40.json', 'rewind_event.valid.counter_rewind_event_valid_coverage41.json', 'rewind_event.valid.counter_rewind_event_valid_coverage42.json', 'rewind_event.valid.counter_rewind_event_valid_coverage43.json', 'rewind_event.valid.counter_rewind_event_valid_coverage44.json', 'rewind_event.valid.counter_rewind_event_valid_coverage45.json', 'rewind_event.valid.counter_rewind_event_valid_coverage46.json', 'rewind_event.valid.counter_rewind_event_valid_coverage47.json', 'rewind_event.valid.counter_rewind_event_valid_coverage48.json', 'rewind_event.valid.counter_rewind_event_valid_coverage49.json', 'rewind_event.valid.counter_rewind_event_valid_coverage50.json', 'rewind_event.valid.counter_rewind_event_valid_coverage51.json', 'rewind_event.valid.counter_rewind_event_valid_coverage52.json', 'rewind_event.valid.counter_rewind_event_valid_coverage53.json', 'rewind_event.valid.counter_rewind_event_valid_coverage54.json', 'rewind_event.valid.counter_rewind_event_valid_coverage56.json', 'rewind_event.valid.counter_rewind_event_valid_coverage57.json', 'rewind_event.valid.counter_rewind_event_valid_coverage58.json', 'rewind_event.valid.counter_rewind_event_valid_coverage59.json', 'rewind_event.valid.counter_rewind_event_valid_coverage60.json', 'rewind_event.valid.counter_rewind_event_valid_coverage61.json', 'rewind_event.valid.counter_rewind_event_valid_coverage62.json', 'rewind_event.valid.counter_rewind_event_valid_coverage63.json', 'rewind_event.valid.counter_rewind_event_valid_coverage64.json', 'rewind_event.valid.counter_rewind_event_valid_coverage65.json', 'rewind_event.valid.counter_rewind_event_valid_coverage66.json', 'rewind_event.valid.counter_rewind_event_valid_coverage67.json', 'rewind_event.valid.counter_rewind_event_valid_coverage68.json', 'rewind_event.valid.counter_rewind_event_valid_coverage69.json', 'rewind_event.valid.counter_rewind_event_valid_coverage70.json', 'rewind_event.valid.counter_rewind_event_valid_coverage71.json', 'rewind_event.valid.counter_rewind_event_valid_coverage72.json', 'rewind_event.valid.counter_rewind_event_valid_coverage73.json', 'rewind_event.valid.counter_rewind_event_valid_coverage74.json', 'rewind_event.valid.counter_rewind_event_valid_coverage75.json', 'rewind_event.valid.counter_rewind_event_valid_coverage76.json', 'rewind_event.valid.counter_rewind_event_valid_coverage77.json', 'rewind_event.valid.counter_rewind_event_valid_coverage78.json', 'rewind_event.valid.counter_rewind_event_valid_coverage79.json', 'rewind_event.valid.counter_rewind_event_valid_coverage80.json', 'rewind_event.valid.counter_rewind_event_valid_coverage81.json', 'rewind_event.valid.counter_rewind_event_valid_coverage82.json', 'rewind_event.valid.counter_rewind_event_valid_outcome_unknown.json', 'rewind_event.valid.counter_rewind_event_valid_recovery_ready.json', 'rewind_event.valid.counter_rewind_event_valid_refused.json', 'rewind_event.valid.counter_rewind_event_valid_refused_recoverable.json', 'rewind_event.valid.coverage25.json', 'rewind_event.valid.coverage26.json', 'rewind_event.valid.coverage27.json', 'rewind_event.valid.coverage28.json', 'rewind_event.valid.coverage29.json', 'rewind_event.valid.coverage30.json', 'rewind_event.valid.coverage31.json', 'rewind_event.valid.coverage32.json', 'rewind_event.valid.coverage33.json', 'rewind_event.valid.coverage34.json', 'rewind_event.valid.coverage35.json', 'rewind_event.valid.coverage36.json', 'rewind_event.valid.coverage37.json', 'rewind_event.valid.coverage38.json', 'rewind_event.valid.coverage39.json', 'rewind_event.valid.coverage40.json', 'rewind_event.valid.coverage41.json', 'rewind_event.valid.coverage42.json', 'rewind_event.valid.coverage43.json', 'rewind_event.valid.coverage44.json', 'rewind_event.valid.coverage45.json', 'rewind_event.valid.coverage46.json', 'rewind_event.valid.coverage47.json', 'rewind_event.valid.coverage48.json', 'rewind_event.valid.coverage49.json', 'rewind_event.valid.coverage50.json', 'rewind_event.valid.coverage51.json', 'rewind_event.valid.coverage52.json', 'rewind_event.valid.coverage53.json', 'rewind_event.valid.coverage54.json', 'rewind_event.valid.coverage56.json', 'rewind_event.valid.coverage57.json', 'rewind_event.valid.coverage58.json', 'rewind_event.valid.coverage59.json', 'rewind_event.valid.coverage60.json', 'rewind_event.valid.coverage61.json', 'rewind_event.valid.coverage62.json', 'rewind_event.valid.coverage63.json', 'rewind_event.valid.coverage64.json', 'rewind_event.valid.coverage65.json', 'rewind_event.valid.coverage66.json', 'rewind_event.valid.coverage67.json', 'rewind_event.valid.coverage68.json', 'rewind_event.valid.coverage69.json', 'rewind_event.valid.coverage70.json', 'rewind_event.valid.coverage71.json', 'rewind_event.valid.coverage72.json', 'rewind_event.valid.coverage73.json', 'rewind_event.valid.coverage74.json', 'rewind_event.valid.coverage75.json', 'rewind_event.valid.coverage76.json', 'rewind_event.valid.coverage77.json', 'rewind_event.valid.coverage78.json', 'rewind_event.valid.coverage79.json', 'rewind_event.valid.coverage80.json', 'rewind_event.valid.coverage81.json', 'rewind_event.valid.coverage82.json', 'rewind_event.valid.json', 'rewind_event.valid.outcome_unknown.json', 'rewind_event.valid.recovery_ready.json', 'rewind_event.valid.refused.json', 'rewind_event.valid.refused_no_session.json', 'rewind_event.valid.refused_recoverable.json', 'rewind_event.valid.unknown_no_session.json', 'rewind_guest_reset.invalid.entropy.json', 'rewind_guest_reset.invalid.epoch.json', 'rewind_guest_reset.invalid.extra.json', 'rewind_guest_reset.invalid.foreign_owner.json', 'rewind_guest_reset.valid.json', 'rewind_guest_reset.valid.reply.json', 'rewind_guest_reset.valid.request.json', 'rewind_point.invalid.created_time_missing.json', 'rewind_point.invalid.created_time_zero.json', 'rewind_point.invalid.extra.json', 'rewind_point.invalid.path.json', 'rewind_point.invalid.reference_count.json', 'rewind_point.valid.coverage1.json', 'rewind_point.valid.coverage2.json', 'rewind_point.valid.coverage3.json', 'rewind_point.valid.coverage4.json', 'rewind_point.valid.json', 'rewind_request.invalid.extra.json', 'rewind_request.invalid.path.json', 'rewind_request.invalid.zero_generation.json', 'rewind_request.valid.json', 'rewind_request.valid.mark.json', 'rewind_request.valid.pause.json', 'rewind_request.valid.restore.json', 'rewind_request.valid.resume.json', 'rewind_session.invalid.extra.json', 'rewind_session.invalid.guest_counter_type.json', 'rewind_session.invalid.ring_overflow.json', 'rewind_session.invalid.stopped_held.json', 'rewind_session.invalid.zero_epoch.json', 'rewind_session.valid.counter_rewind_session_valid.json', 'rewind_session.valid.counter_rewind_session_valid_coverage10.json', 'rewind_session.valid.counter_rewind_session_valid_coverage11.json', 'rewind_session.valid.counter_rewind_session_valid_coverage12.json', 'rewind_session.valid.counter_rewind_session_valid_coverage13.json', 'rewind_session.valid.counter_rewind_session_valid_coverage14.json', 'rewind_session.valid.counter_rewind_session_valid_coverage15.json', 'rewind_session.valid.counter_rewind_session_valid_coverage16.json', 'rewind_session.valid.counter_rewind_session_valid_coverage17.json', 'rewind_session.valid.counter_rewind_session_valid_coverage18.json', 'rewind_session.valid.counter_rewind_session_valid_coverage19.json', 'rewind_session.valid.counter_rewind_session_valid_coverage20.json', 'rewind_session.valid.counter_rewind_session_valid_coverage21.json', 'rewind_session.valid.counter_rewind_session_valid_coverage22.json', 'rewind_session.valid.counter_rewind_session_valid_coverage23.json', 'rewind_session.valid.counter_rewind_session_valid_coverage24.json', 'rewind_session.valid.counter_rewind_session_valid_coverage5.json', 'rewind_session.valid.counter_rewind_session_valid_coverage55.json', 'rewind_session.valid.counter_rewind_session_valid_coverage6.json', 'rewind_session.valid.counter_rewind_session_valid_coverage7.json', 'rewind_session.valid.counter_rewind_session_valid_coverage8.json', 'rewind_session.valid.counter_rewind_session_valid_coverage9.json', 'rewind_session.valid.counter_rewind_session_valid_recoverable.json', 'rewind_session.valid.counter_rewind_session_valid_stopped.json', 'rewind_session.valid.coverage10.json', 'rewind_session.valid.coverage11.json', 'rewind_session.valid.coverage12.json', 'rewind_session.valid.coverage13.json', 'rewind_session.valid.coverage14.json', 'rewind_session.valid.coverage15.json', 'rewind_session.valid.coverage16.json', 'rewind_session.valid.coverage17.json', 'rewind_session.valid.coverage18.json', 'rewind_session.valid.coverage19.json', 'rewind_session.valid.coverage20.json', 'rewind_session.valid.coverage21.json', 'rewind_session.valid.coverage22.json', 'rewind_session.valid.coverage23.json', 'rewind_session.valid.coverage24.json', 'rewind_session.valid.coverage5.json', 'rewind_session.valid.coverage55.json', 'rewind_session.valid.coverage6.json', 'rewind_session.valid.coverage7.json', 'rewind_session.valid.coverage8.json', 'rewind_session.valid.coverage9.json', 'rewind_session.valid.json', 'rewind_session.valid.recoverable.json', 'rewind_session.valid.stopped.json'])
ENVELOPE_FILES = {"envelope/v0.2":"envelope.schema.json", "capsule_envelope/v0.2":"capsule_envelope.schema.json", "rewind_envelope/v0.2":"rewind_envelope.schema.json"}

def _find_conditional_oracle_defs(source: str) -> list[str]:
    tree = ast.parse(source)
    return [
        node.name
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name.endswith("_fixed")
    ]


def _run_rust_probe(raw_lines: list[str], schema_cases: list[tuple[dict, dict]] | None = None) -> tuple[list[bool], list[bool]]:
    cargo = shutil.which(os.environ.get("CARGO", "cargo"))
    if cargo is None:
        raise RuntimeError("cargo must be supplied by PATH or CARGO")
    schema_cases = schema_cases or []
    with tempfile.TemporaryDirectory(prefix="conformance-rs-") as temp:
        directory = Path(temp)
        (directory / "src").mkdir()
        (directory / "Cargo.toml").write_text(
            '[package]\nname = "decoder-conformance-probe"\nversion = "0.0.0"\n'
            "edition = \"2021\"\n[workspace]\n[dependencies]\n"
            'serde_json = "=1.0.154"\n'
            "metaviewer-core = { path = " + json.dumps(str(ROOT / "core")) + " }\n"
        )
        (directory / "src/main.rs").write_text(
            "use std::io::{self, BufRead};\nfn main() {\n"
            "for line in io::stdin().lock().lines() {\n"
            "let line = line.unwrap();\n"
            'if let Some(rest) = line.strip_prefix("SCHEMA_VALID:") {\n'
            "let pair: (serde_json::Value, serde_json::Value) = serde_json::from_str(rest).unwrap();\n"
            'println!("{}", metaviewer_core::valid(&pair.0, &pair.1, &pair.1));\n'
            "} else {\n"
            'println!("{}", metaviewer_core::decode_envelope(&line).is_ok());\n'
            "}\n"
            "}\n}\n"
        )
        environment = dict(os.environ)
        environment.setdefault("CARGO_TARGET_DIR", str(directory / "target"))
        stdin_lines = [
            *(line + "\n" for line in raw_lines),
            *(
                "SCHEMA_VALID:" + json.dumps([val, sch], separators=(",", ":")) + "\n"
                for val, sch in schema_cases
            ),
        ]
        result = subprocess.run(
            [cargo, "run", "--offline", "--quiet", "--manifest-path", str(directory / "Cargo.toml")],
            input="".join(stdin_lines),
            text=True,
            capture_output=True,
            env=environment,
            timeout=180,
        )
        if result.returncode != 0:
            raise RuntimeError("Rust conformance probe failed: " + result.stderr)
        answers = [line.strip() == "true" for line in result.stdout.splitlines()]
        expected_total = len(raw_lines) + len(schema_cases)
        if len(answers) != expected_total:
            raise RuntimeError(f"Rust probe line count mismatch: {len(answers)} != {expected_total}")
        return answers[: len(raw_lines)], answers[len(raw_lines) :]


def _run_go_probe(raw_lines: list[str], envelope_schema_override: str | None = None) -> list[bool]:
    go = shutil.which(os.environ.get("GO", "go"))
    if go is None:
        raise RuntimeError("go must be supplied by PATH or GO")
    with tempfile.TemporaryDirectory(prefix="conformance-go-", dir="/tmp") as temp:
        temp_root = Path(temp)
        in_path = temp_root / "in.jsonl"
        out_path = temp_root / "out.txt"
        in_path.write_text("".join(line + "\n" for line in raw_lines))
        environment = dict(
            os.environ,
            GOPROXY="off",
            GOSUMDB="off",
            GOTOOLCHAIN="local",
            TMPDIR=str(temp_root),
            MV_SCHEMA_DIR=str(ROOT / "contracts/v0.2"),
            MV_PROBE_IN=str(in_path),
            MV_PROBE_OUT=str(out_path),
        )
        if envelope_schema_override is not None:
            environment["MV_ENVELOPE_SCHEMA_JSON"] = envelope_schema_override
        result = subprocess.run(
            [go, "test", "./internal/ipc", "-run", "^TestConformanceProbe$", "-count=1"],
            cwd=ROOT / "daemon-adapter",
            text=True,
            capture_output=True,
            env=environment,
            timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError("Go conformance probe failed: " + result.stdout + result.stderr)
        answers = out_path.read_text().splitlines()
        if len(answers) != len(raw_lines):
            raise RuntimeError(f"Go probe line count mismatch: {len(answers)} != {len(raw_lines)}")
        return [line.strip() == "true" for line in answers]


def _run_go_schema_probe(schema_cases: list[tuple[dict, dict]]) -> list[bool]:
    go = shutil.which(os.environ.get("GO", "go"))
    if go is None:
        raise RuntimeError("go must be supplied by PATH or GO")
    with tempfile.TemporaryDirectory(prefix="conformance-go-sch-", dir="/tmp") as temp:
        temp_root = Path(temp)
        in_path = temp_root / "in.jsonl"
        out_path = temp_root / "out.txt"
        in_path.write_text(
            "".join(
                json.dumps([val, sch], separators=(",", ":")) + "\n"
                for val, sch in schema_cases
            )
        )
        environment = dict(
            os.environ,
            GOPROXY="off",
            GOSUMDB="off",
            GOTOOLCHAIN="local",
            TMPDIR=str(temp_root),
            MV_SCHEMA_VALID_IN=str(in_path),
            MV_SCHEMA_VALID_OUT=str(out_path),
        )
        result = subprocess.run(
            [go, "test", "./internal/ipc", "-run", "^TestSchemaNodeAcceptProbe$", "-count=1"],
            cwd=ROOT / "daemon-adapter",
            text=True,
            capture_output=True,
            env=environment,
            timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError("Go schema probe failed: " + result.stdout + result.stderr)
        answers = out_path.read_text().splitlines()
        if len(answers) != len(schema_cases):
            raise RuntimeError(f"Go schema probe line count mismatch: {len(answers)} != {len(schema_cases)}")
        return [line.strip() == "true" for line in answers]


def _run_python_decoder(raw_line: str) -> bool:
    try:
        value = json.loads(
            raw_line,
            object_pairs_hook=lambda pairs: (
                (_ for _ in ()).throw(ValueError("duplicate key"))
                if len({k for k, _ in pairs}) != len(pairs)
                else dict(pairs)
            ),
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite")),
        )
        validate_envelope(value)
        return True
    except (EnvelopeError, ValueError, TypeError, RecursionError):
        return False


def _run_checker_decoder(validator: Validator, envelope_schema: dict, raw_line: str) -> bool:
    try:
        value = loads_strict(raw_line)
        schema = envelope_schema
        supplied_tag = schema.get('properties', {}).get('schema', {}).get('const')
        if (isinstance(supplied_tag, str) and supplied_tag in ENVELOPE_FILES
                and schema.get('$id') == 'https://metaviewer.local/contracts/v0.2/' + ENVELOPE_FILES[supplied_tag]):
            if not isinstance(value, dict) or value.get('schema') not in ENVELOPE_FILES:
                return False
            if value['schema'] != supplied_tag:
                schema = validator.load(ENVELOPE_FILES[value['schema']])
        validator.validate(value, schema)
        return True
    except (ValidationError, ValueError, TypeError, KeyError, RecursionError):
        return False


def _run_python_schema_check(value: dict, schema: dict, filename: str = "") -> bool:
    import copy
    import metaviewer_agents.envelope as env_mod

    versioned = copy.deepcopy(schema)
    for k in ("$schema", "$id", "title", "description"):
        versioned.pop(k, None)
    env_mod._version_refs(versioned, filename)
    try:
        env_mod._check(value, versioned, 0)
        return True
    except env_mod._Mismatch:
        return False



class CheckerSchemaDispatchTests(unittest.TestCase):
    def setUp(self):
        self.validator = Validator(ROOT / 'contracts/v0.2')
        self.envelope = self.validator.load('envelope.schema.json')

    def admit(self, value, schema):
        return _run_checker_decoder(self.validator, schema, json.dumps(value))

    def test_generic_positive_and_negative_keep_supplied_schema(self):
        open_schema = {'properties': {'a': {'type': 'integer'}}}
        self.assertTrue(self.admit({'a': 1, 'zzz': 1}, open_schema))
        self.assertFalse(self.admit({'a': 'bad', 'zzz': 1}, open_schema))
        self.assertFalse(self.admit({'a': 1, 'zzz': 1}, {**open_schema, 'additionalProperties': False}))
        self.assertTrue(self.admit({'a': 1, 'schema': 'not-an-envelope'}, open_schema))
        self.assertTrue(self.admit([1], {'type':'array','items':{'type':'integer'}}))
        self.assertFalse(self.admit(['bad'], {'type':'array','items':{'type':'integer'}}))
        capsule = json.loads((ROOT/'contracts/examples/v0.2/capsule_envelope.valid.json').read_text())
        self.assertFalse(self.admit(capsule, {'properties':{'schema':{'const':'envelope/v0.2'}}}))

    def test_all_three_envelope_families_and_crossed_tags(self):
        for tag, filename in ENVELOPE_FILES.items():
            example = json.loads((ROOT/'contracts/examples/v0.2'/filename.replace('.schema.json','.valid.json')).read_text())
            self.assertTrue(self.admit(example, self.envelope), tag)
            self.assertTrue(self.admit(example, self.validator.load(filename)), tag)
            for wrong in ENVELOPE_FILES:
                if wrong != tag:
                    self.assertFalse(self.admit({**example,'schema':wrong}, self.envelope),(tag,wrong))

    def test_unknown_missing_and_malformed_envelope_tag_refuse(self):
        example = json.loads((ROOT/'contracts/examples/v0.2/envelope.valid.json').read_text())
        self.assertFalse(self.admit({**example,'schema':'unknown/v0.2'},self.envelope))
        del example['schema']
        self.assertFalse(self.admit(example,self.envelope))
        self.assertFalse(self.admit([],self.envelope))

    def test_matching_family_retains_supplied_extra_constraint(self):
        import copy
        example = json.loads((ROOT/'contracts/examples/v0.2/envelope.valid.json').read_text())
        restricted = copy.deepcopy(self.envelope)
        restricted['maxProperties'] = 0
        self.assertFalse(self.admit(example,restricted))


class DecoderConformanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.validator = Validator(ROOT / "contracts/v0.2")
        cls.envelope_schema = cls.validator.load("envelope.schema.json")
        cls.base_envelope = json.loads(
            (ROOT / "contracts/examples/v0.2/envelope.valid.json").read_text()
        )
        cls.examples_dir = ROOT / "contracts/examples/v0.2"
        cls.fixture_paths = sorted(cls.examples_dir.glob("*.json"))
        cls.envelope_schemas = {tag: cls.validator.load(name) for tag, name in ENVELOPE_FILES.items()}
        body_family = {}
        for tag, schema in cls.envelope_schemas.items():
            for branch in schema['properties']['body']['oneOf']:
                name = branch['$ref'].removesuffix('.schema.json')
                if name in body_family: raise AssertionError('body appears in multiple families')
                body_family[name] = tag
        cls.body_family = body_family
        def wrap_obj(body_obj: dict, family='envelope/v0.2') -> str:
            return json.dumps({**cls.base_envelope, 'schema': family, 'body': body_obj}, separators=(',', ':'))
        cls.fixture_cases = []
        cls.metadata_cases = []
        for path in cls.fixture_paths:
            body = json.loads(path.read_text())
            prefix = path.name.split('.', 1)[0]
            valid = '.valid.' in path.name
            if prefix in ('envelope', 'capsule_envelope', 'rewind_envelope'):
                value = body
                expected = valid
            else:
                value = {**cls.base_envelope, 'schema':body_family.get(prefix,'envelope/v0.2'), 'body':body}
                expected = valid and prefix in body_family
                if prefix not in body_family and (ROOT/'contracts/v0.2'/f'{prefix}.schema.json').exists():
                    cls.metadata_cases.append((path.name, body, f'{prefix}.schema.json', valid))
            cls.fixture_cases.append((path.name,json.dumps(value,separators=(',', ':')),expected))
            if expected:
                for wrong in ENVELOPE_FILES:
                    if wrong != value['schema']:
                        cls.fixture_cases.append((path.name+'.crossed-'+wrong.split('/')[0],json.dumps({**value,'schema':wrong},separators=(',', ':')),False))

        obs_valid = json.loads((cls.examples_dir / "observation.valid.json").read_text())
        frame_valid = json.loads((cls.examples_dir / "frame_ref.valid.json").read_text())
        rcpt_valid = json.loads((cls.examples_dir / "action_receipt.valid.json").read_text())
        term_valid = json.loads((cls.examples_dir / "terminal_session.valid.json").read_text())

        # Positive controls corresponding to 001..007
        cls.positive_controls = [
            (
                "pos-001-nested-v02",
                wrap_obj(
                    {
                        "schema": "mv_tool_result/v0.2",
                        "request_id": "req-001",
                        "op": "observe",
                        "status": "ok",
                        "observation": obs_valid,
                    }
                ),
            ),
            ("pos-002-int-generation", wrap_obj({**frame_valid, "generation": 1})),
            ("pos-003-clean-ramws", wrap_obj({**frame_valid, "ramws_path": "/dev/shm/ramws/demo.rgb"})),
            (
                "pos-003b-adapter-ramws",
                wrap_obj(
                    {
                        **frame_valid,
                        "ramws_path": "/dev/shm/mv-adapter-1/frames-123456/0123456789abcdef0123456789abcdef.rgb",
                    }
                ),
            ),
            ("pos-004-clean-sha256", wrap_obj({**frame_valid, "sha256": "a" * 64})),
            ("pos-005-65536-ascii", wrap_obj({**rcpt_valid, "error": "a" * 65536})),
            ("pos-006-valid-unicode", wrap_obj({**rcpt_valid, "error": "é-\U0001f600"})),
            (
                "pos-007-terminal-len-match",
                wrap_obj({**term_valid, "params": {**term_valid["params"], "b64": "YQ==", "byte_count": 1}}),
            ),
            (
                "pos-008-create-nested-depth-0",
                wrap_obj(
                    {
                        "schema": "surface_request/v0.2",
                        "op": "create",
                        "params": {
                            "kind": "desktop_capsule",
                            "geometry": {"w": 1280, "h": 720},
                            "profile_id": "notepad-0",
                            "nested_depth": 0,
                        },
                    }
                ),
            ),
            (
                "pos-009-create-nested-depth-1",
                wrap_obj(
                    {
                        "schema": "surface_request/v0.2",
                        "op": "create",
                        "params": {
                            "kind": "desktop_capsule",
                            "geometry": {"w": 1280, "h": 720},
                            "profile_id": "inner-host-1",
                            "nested_depth": 1,
                        },
                    }
                ),
            ),
        ]

        # Adversarial mutations T6R2-001..007
        raw_001 = wrap_obj(
            {
                "schema": "mv_tool_result/v0.2",
                "request_id": "req-001",
                "op": "observe",
                "status": "ok",
                "observation": {**obs_valid, "schema": "observation/v0.1"},
            }
        )
        raw_002 = wrap_obj({**frame_valid, "generation": 1}).replace(
            '"generation":1', '"generation":1.0'
        )
        raw_003 = wrap_obj({**frame_valid, "ramws_path": "/dev/shm/a\nb"})
        raw_004 = wrap_obj({**frame_valid, "sha256": frame_valid["sha256"] + "\n"})
        raw_005 = wrap_obj({**rcpt_valid, "error": "é" * 32769})
        raw_006 = wrap_obj({**rcpt_valid, "error": "SURROGATE_MARKER"}).replace(
            "SURROGATE_MARKER", r"x\ud800y"
        )
        raw_007 = wrap_obj(
            {**term_valid, "params": {**term_valid["params"], "b64": "YQ==", "byte_count": 2}}
        )

        unanimous_refusal = {
            "rust": False,
            "go": False,
            "python": False,
            "checker": False,
        }
        cls.mutation_cases = [
            ("T6R2-001", raw_001, dict(unanimous_refusal)),
            ("T6R2-002", raw_002, dict(unanimous_refusal)),
            ("T6R2-003", raw_003, dict(unanimous_refusal)),
            ("T6R2-004", raw_004, dict(unanimous_refusal)),
            ("T6R2-005", raw_005, dict(unanimous_refusal)),
            ("T6R2-006", raw_006, dict(unanimous_refusal)),
            ("T6R2-007", raw_007, dict(unanimous_refusal)),
            (
                "RV7-ramws-traversal",
                wrap_obj({**frame_valid, "ramws_path": "/dev/shm/../etc/x"}),
                {"rust": False, "go": False, "python": False, "checker": False},
            ),
            (
                "RV7-ramws-empty-seg",
                wrap_obj({**frame_valid, "ramws_path": "/dev/shm/a//b"}),
                {"rust": False, "go": False, "python": False, "checker": False},
            ),
            (
                "RV7-ramws-hidden-seg",
                wrap_obj({**frame_valid, "ramws_path": "/dev/shm/.x"}),
                {"rust": False, "go": False, "python": False, "checker": False},
            ),
            (
                "RV7-ramws-bare-root",
                wrap_obj({**frame_valid, "ramws_path": "/dev/shm"}),
                {"rust": False, "go": False, "python": False, "checker": False},
            ),
            (
                "AC17-nested-depth-2",
                wrap_obj(
                    {
                        "schema": "surface_request/v0.2",
                        "op": "create",
                        "params": {
                            "kind": "desktop_capsule",
                            "geometry": {"w": 1280, "h": 720},
                            "profile_id": "inner-host-1",
                            "nested_depth": 2,
                        },
                    }
                ),
                dict(unanimous_refusal),
            ),
            (
                "AC17-nested-depth-neg1",
                wrap_obj(
                    {
                        "schema": "surface_request/v0.2",
                        "op": "create",
                        "params": {
                            "kind": "desktop_capsule",
                            "geometry": {"w": 1280, "h": 720},
                            "profile_id": "inner-host-1",
                            "nested_depth": -1,
                        },
                    }
                ),
                dict(unanimous_refusal),
            ),
            (
                "AC17-nested-depth-float",
                wrap_obj(
                    {
                        "schema": "surface_request/v0.2",
                        "op": "create",
                        "params": {
                            "kind": "desktop_capsule",
                            "geometry": {"w": 1280, "h": 720},
                            "profile_id": "inner-host-1",
                            "nested_depth": 1,
                        },
                    }
                ).replace('"nested_depth":1', '"nested_depth":1.0'),
                dict(unanimous_refusal),
            ),
            (
                "AC17-nested-depth-bool",
                wrap_obj(
                    {
                        "schema": "surface_request/v0.2",
                        "op": "create",
                        "params": {
                            "kind": "desktop_capsule",
                            "geometry": {"w": 1280, "h": 720},
                            "profile_id": "inner-host-1",
                            "nested_depth": True,
                        },
                    }
                ),
                dict(unanimous_refusal),
            ),
        ]

        all_raw = (
            [raw for _, raw, _ in cls.fixture_cases]
            + [raw for _, raw in cls.positive_controls]
            + [raw for _, raw, _ in cls.mutation_cases]
        )

        import copy

        synth_good_const = copy.deepcopy(cls.envelope_schema)
        synth_good_const["properties"]["body"] = {
            "oneOf": [
                {
                    "$ref": "frame_ref.schema.json",
                    "const": frame_valid,
                }
            ]
        }
        frame_bad_sha = {**frame_valid, "sha256": "not-a-valid-sha256"}
        synth_bad_const = copy.deepcopy(cls.envelope_schema)
        synth_bad_const["properties"]["body"] = {
            "oneOf": [
                {
                    "$ref": "frame_ref.schema.json",
                    "const": frame_bad_sha,
                }
            ]
        }

        env_gen1 = {**cls.base_envelope, "body": frame_valid}
        env_gen2 = {**cls.base_envelope, "body": {**frame_valid, "generation": 2}}
        env_bad_sha = {**cls.base_envelope, "body": frame_bad_sha}

        synth_max_props_10 = copy.deepcopy(cls.envelope_schema)
        synth_max_props_10["properties"]["body"] = {
            "oneOf": [
                {
                    "$ref": "frame_ref.schema.json",
                    "maxProperties": 10,
                }
            ]
        }
        synth_max_props_12 = copy.deepcopy(cls.envelope_schema)
        synth_max_props_12["properties"]["body"] = {
            "oneOf": [
                {
                    "$ref": "frame_ref.schema.json",
                    "maxProperties": 12,
                }
            ]
        }

        cls.r1_084_cases = [
            ("r1-084-pos-both-match", env_gen1, synth_good_const, True),
            ("r1-084-neg-ref-ok-const-mismatch", env_gen2, synth_good_const, False),
            ("r1-084-neg-const-ok-ref-mismatch", env_bad_sha, synth_bad_const, False),
            ("t6-r3-007-neg-ref-max-properties-10", env_gen1, synth_max_props_10, False),
            ("t6-r3-007-pos-ref-max-properties-12", env_gen1, synth_max_props_12, True),
        ]

        cls.open_props_cases = [
            (
                "d3-open-props-extra-key-admitted",
                {"a": 1, "zzz": 1},
                {"properties": {"a": {"type": "integer"}}},
                True,
            ),
            (
                "d3-open-props-declared-key-type-mismatch-refused",
                {"a": "bad", "zzz": 1},
                {"properties": {"a": {"type": "integer"}}},
                False,
            ),
            (
                "d3-closed-props-extra-key-refused",
                {"a": 1, "zzz": 1},
                {"properties": {"a": {"type": "integer"}}, "additionalProperties": False},
                False,
            ),
        ]

        rs_verdicts, rs_schema_all = _run_rust_probe(
            all_raw,
            [(val, sch) for _, val, sch, _ in cls.r1_084_cases]
            + [(val, sch) for _, val, sch, _ in cls.open_props_cases],
        )
        rs_r1_084 = rs_schema_all[: len(cls.r1_084_cases)]
        rs_open_props = rs_schema_all[len(cls.r1_084_cases) :]
        go_verdicts = _run_go_probe(all_raw)
        go_r1_084_good = _run_go_probe(
            [
                json.dumps(env_gen1, separators=(",", ":")),
                json.dumps(env_gen2, separators=(",", ":")),
            ],
            envelope_schema_override=json.dumps(synth_good_const),
        )
        go_r1_084_bad = _run_go_probe(
            [json.dumps(env_bad_sha, separators=(",", ":"))],
            envelope_schema_override=json.dumps(synth_bad_const),
        )
        go_t6_007_10 = _run_go_probe(
            [json.dumps(env_gen1, separators=(",", ":"))],
            envelope_schema_override=json.dumps(synth_max_props_10),
        )
        go_t6_007_12 = _run_go_probe(
            [json.dumps(env_gen1, separators=(",", ":"))],
            envelope_schema_override=json.dumps(synth_max_props_12),
        )
        go_r1_084 = go_r1_084_good + go_r1_084_bad + go_t6_007_10 + go_t6_007_12
        go_open_props = _run_go_schema_probe([(val, sch) for _, val, sch, _ in cls.open_props_cases])
        py_verdicts = [_run_python_decoder(raw) for raw in all_raw]
        chk_verdicts = [
            _run_checker_decoder(cls.validator, cls.envelope_schema, raw) for raw in all_raw
        ]

        cls.verdicts = [
            {"rust": r, "go": g, "python": p, "checker": c}
            for r, g, p, c in zip(rs_verdicts, go_verdicts, py_verdicts, chk_verdicts)
        ]
        cls.r1_084_verdicts = [
            {
                "rust": rs_r1_084[i],
                "go": go_r1_084[i],
                "python": _run_python_schema_check(val, sch),
                "checker": _run_checker_decoder(
                    cls.validator, sch, json.dumps(val, separators=(",", ":"))
                ),
            }
            for i, (_, val, sch, _) in enumerate(cls.r1_084_cases)
        ]
        cls.open_props_verdicts = [
            {
                "rust": rs_open_props[i],
                "go": go_open_props[i],
                "python": _run_python_schema_check(val, sch),
                "checker": _run_checker_decoder(
                    cls.validator, sch, json.dumps(val, separators=(",", ":"))
                ),
            }
            for i, (_, val, sch, _) in enumerate(cls.open_props_cases)
        ]

    def test_all_v02_example_fixtures_unanimous_across_four_decoders(self):
        import hashlib

        names_all = [p.name for p in self.fixture_paths]
        additions = set(names_all) & ADDITIVE_FIXTURE_NAMES
        self.assertEqual(additions, ADDITIVE_FIXTURE_NAMES)
        legacy = [n for n in names_all if n not in ADDITIVE_FIXTURE_NAMES]
        names_488 = [n for n in legacy if n != 'surface_input.invalid.chord_overflow.json']
        self.assertEqual(len(names_488), 542)
        self.assertEqual(len(legacy), 543)
        self.assertIn('surface_request.invalid.origin_unknown.json', names_488)
        self.assertEqual(hashlib.sha256('\n'.join(names_488).encode()).hexdigest(),
                         '65d137826119d750852c08194f55097822dc6a7113efeba2be35d715d8cf1773')
        self.assertEqual(hashlib.sha256('\n'.join(legacy).encode()).hexdigest(),
                         'fb0b7d559fe823b623dc0556c1d04ddd848705b68603db27b0c91185c5dd6038')
        self.assertEqual(len(names_all), len(legacy) + len(ADDITIVE_FIXTURE_NAMES))
        for idx, (name, _, expected) in enumerate(self.fixture_cases):
            self.assertTrue(
                ".valid." in name or ".invalid." in name,
                f"Unexpected fixture naming: {name}",
            )
            verdict = self.verdicts[idx]
            with self.subTest(fixture=name):
                self.assertEqual(
                    verdict,
                    {"rust": expected, "go": expected, "python": expected, "checker": expected},
                )

    def test_helper_metadata_remains_canonical_and_is_not_an_envelope_body(self):
        self.assertTrue(self.metadata_cases)
        for name, value, filename, expected in self.metadata_cases:
            schema = self.validator.load(filename)
            with self.subTest(fixture=name):
                try:
                    self.validator.validate(value, schema)
                    checker = True
                except ValidationError:
                    checker = False
                self.assertEqual(checker, expected)
                self.assertEqual(_run_python_schema_check(value, schema, filename), expected)
        self.assertEqual(set(self.body_family.values()), set(ENVELOPE_FILES))

    def test_adversarial_mutations_positive_controls_unanimous_admit(self):
        offset = len(self.fixture_cases)
        for idx, (name, _) in enumerate(self.positive_controls):
            verdict = self.verdicts[offset + idx]
            with self.subTest(control=name):
                self.assertEqual(
                    verdict,
                    {"rust": True, "go": True, "python": True, "checker": True},
                )

    def test_adversarial_mutations_001_to_007_negative_controls(self):
        offset = len(self.fixture_cases) + len(self.positive_controls)
        unanimous_refusal = {"rust": False, "go": False, "python": False, "checker": False}
        for idx, (uid, _, expected_map) in enumerate(self.mutation_cases):
            verdict = self.verdicts[offset + idx]
            with self.subTest(uid=uid):
                self.assertEqual(expected_map, unanimous_refusal)
                self.assertEqual(verdict, unanimous_refusal)

    def test_no_source_sniffing_oracles_in_conformance_module(self):
        source = Path(__file__).read_text()
        self.assertEqual(_find_conditional_oracle_defs(source), [])
        # Negative control: synthetic copy with a dummy *_fixed helper is detected.
        mutated_source = source + "\ndef _u1_dummy_fixed() -> bool:\n    return True\n"
        self.assertEqual(
            _find_conditional_oracle_defs(mutated_source),
            ["_u1_dummy_fixed"],
        )

    def test_r1_084_ref_with_sibling_const_mirrored_across_decoders(self):
        for idx, (name, _, _, expected) in enumerate(self.r1_084_cases):
            with self.subTest(case=name):
                self.assertEqual(
                    self.r1_084_verdicts[idx],
                    {"rust": expected, "go": expected, "python": expected, "checker": expected},
                )

    def test_properties_without_additional_properties_false_four_way_conformance(self):
        for idx, (name, _, _, expected) in enumerate(self.open_props_cases):
            with self.subTest(case=name):
                self.assertEqual(
                    self.open_props_verdicts[idx],
                    {"rust": expected, "go": expected, "python": expected, "checker": expected},
                )


if __name__ == "__main__":
    unittest.main()
