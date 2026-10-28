#!/usr/bin/env python3
"""Assembly smoke verifier for pinned private repositories in deps.lock."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable, Sequence

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LOCK_PATH = REPO_ROOT / "deps.lock"
DEFAULT_DEPS_ROOT = REPO_ROOT / "_deps"
DEFAULT_TIMEOUT_S = 60.0

REQUIRED_COMPONENTS: tuple[str, ...] = (
    "vision-engine",
    "wender-agent",
    "opensuperficies",
)
HEX40_RE = re.compile(r"^[0-9a-f]{40}$")
REPO_SLUG_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")

EXPECTED_VISION_REGIONS: list[dict[str, int]] = [
    {"x": 16, "y": 32, "w": 144, "h": 48},
    {"x": 192, "y": 112, "w": 112, "h": 48},
]

WENDER_PUBLIC_ENTRYPOINTS: tuple[str, ...] = (
    "wender",
    "wender.state.schema",
    "wender.state.handles",
    "wender.perceive.element_table",
    "wender.perceive.vision_bridge",
    "wender.learn.cu_loop",
    "wender.act.actor",
)

OPENSUPERFICIES_BINARIES: tuple[tuple[str, str], ...] = (
    ("srf-identity-surface", "./cmd/srf-identity-surface"),
    ("srf-holdings-capsule", "./cmd/srf-holdings-capsule"),
)


@dataclass(frozen=True)
class PinnedComponent:
    name: str
    kind: str
    repo: str
    version: str
    commit: str

    @property
    def repo_basename(self) -> str:
        return self.repo.split("/", 1)[1]


@dataclass(frozen=True)
class SmokeResult:
    component: str
    status: str
    detail: str
    duration_ms: int = 0
    planner_note: str | None = None


def _unique_object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, val in pairs:
        if key in out:
            raise ValueError(f"duplicate JSON key in deps.lock: {key!r}")
        out[key] = val
    return out


def parse_deps_lock_data(raw: Any) -> dict[str, PinnedComponent]:
    """Validate parsed JSON data from deps.lock and return components keyed by name."""
    if not isinstance(raw, dict):
        raise ValueError("deps.lock root must be a JSON object")
    unknown_top = set(raw.keys()) - {"components", "schema_version"}
    if unknown_top:
        raise ValueError(f"deps.lock has unexpected top-level keys: {sorted(unknown_top)}")
    if "schema_version" in raw and raw["schema_version"] != "metaviewer.deps.lock/v1":
        raise ValueError(
            f"deps.lock schema_version must be 'metaviewer.deps.lock/v1', got {raw['schema_version']!r}"
        )
    components = raw.get("components")
    if not isinstance(components, list) or not components:
        raise ValueError("deps.lock components must be a non-empty list")

    by_name: dict[str, PinnedComponent] = {}
    for idx, item in enumerate(components):
        if not isinstance(item, dict):
            raise ValueError(f"deps.lock components[{idx}] must be an object")
        name = item.get("name")
        kind = item.get("kind")
        repo = item.get("repo")
        version = item.get("version")
        commit = item.get("commit")

        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"deps.lock components[{idx}].name must be a non-empty string")
        if name in by_name:
            raise ValueError(f"duplicate component in deps.lock: {name!r}")
        if not isinstance(kind, str) or not kind.strip():
            raise ValueError(f"deps.lock component {name!r} kind must be a non-empty string")
        if not isinstance(repo, str) or not REPO_SLUG_RE.match(repo):
            raise ValueError(
                f"deps.lock component {name!r} repo must match 'owner/name', got {repo!r}"
            )
        if not isinstance(version, str) or not version.strip():
            raise ValueError(
                f"deps.lock component {name!r} version must be a non-empty string"
            )
        if not isinstance(commit, str) or not HEX40_RE.match(commit):
            raise ValueError(
                f"deps.lock component {name!r} commit must be 40 lowercase hex chars, got {commit!r}"
            )

        by_name[name] = PinnedComponent(
            name=name,
            kind=kind,
            repo=repo,
            version=version,
            commit=commit,
        )

    missing = [req for req in REQUIRED_COMPONENTS if req not in by_name]
    if missing:
        raise ValueError(
            f"deps.lock missing required component(s): {', '.join(missing)}"
        )

    return by_name


def parse_deps_lock(lock_path: Path = DEFAULT_LOCK_PATH) -> dict[str, PinnedComponent]:
    """Read and validate deps.lock from disk."""
    try:
        text = Path(lock_path).read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"cannot read deps.lock at {lock_path}: {exc}") from exc
    try:
        raw = json.loads(text, object_pairs_hook=_unique_object_pairs)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON in {lock_path}: {exc}") from exc
    return parse_deps_lock_data(raw)


def resolve_component_dir(deps_root: Path, pin: PinnedComponent) -> Path:
    """Locate the checkout directory for a pinned component under deps_root."""
    candidates = [
        deps_root / pin.repo_basename,
        deps_root / pin.name,
    ]
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    tried = ", ".join(str(c) for c in candidates)
    raise FileNotFoundError(
        f"component {pin.name!r} directory not found under {deps_root} (tried: {tried})"
    )


def prepare_pinned_tree(
    repo_dir: Path,
    pin: PinnedComponent,
    *,
    strict_head: bool,
    scratch_root: Path,
    timeout_s: float,
) -> tuple[Path, str]:
    """Verify git commit pin and return (tree_path, resolved_head_or_commit)."""
    head_proc = subprocess.run(
        ["git", "-C", str(repo_dir), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        timeout=timeout_s,
        check=False,
    )
    if head_proc.returncode != 0:
        err = (head_proc.stderr or head_proc.stdout or "").strip()
        raise RuntimeError(f"git rev-parse HEAD failed in {repo_dir}: {err}")
    head_sha = head_proc.stdout.strip()
    if head_sha == pin.commit:
        return repo_dir, head_sha

    if strict_head:
        raise RuntimeError(
            f"{pin.name} HEAD mismatch: expected {pin.commit}, got {head_sha}"
        )

    verify_proc = subprocess.run(
        ["git", "-C", str(repo_dir), "rev-parse", "--verify", f"{pin.commit}^{{commit}}"],
        capture_output=True,
        text=True,
        timeout=timeout_s,
        check=False,
    )
    if verify_proc.returncode != 0 or verify_proc.stdout.strip() != pin.commit:
        raise RuntimeError(
            f"{pin.name} pinned commit {pin.commit} not present in {repo_dir} (HEAD={head_sha})"
        )

    archive_dir = scratch_root / f"tree-{pin.name}-{pin.commit[:12]}"
    archive_dir.mkdir(parents=True, exist_ok=True)
    archive_proc = subprocess.run(
        ["git", "-C", str(repo_dir), "archive", "--format=tar", pin.commit],
        capture_output=True,
        timeout=timeout_s,
        check=False,
    )
    if archive_proc.returncode != 0:
        err = archive_proc.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"git archive {pin.commit} failed in {repo_dir}: {err}")

    untar_proc = subprocess.run(
        ["tar", "-x", "-C", str(archive_dir)],
        input=archive_proc.stdout,
        capture_output=True,
        timeout=timeout_s,
        check=False,
    )
    if untar_proc.returncode != 0:
        err = untar_proc.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"tar extract for {pin.name} failed: {err}")

    return archive_dir, pin.commit


def build_minimal_observation_envelope() -> dict[str, Any]:
    """Return a minimal valid MetaViewer envelope/v0.2 carrying observation/v0.2."""
    agents_root = str(REPO_ROOT / "agents")
    if agents_root not in sys.path:
        sys.path.insert(0, agents_root)
    from metaviewer_agents.envelope import make_envelope, validate_envelope
    from metaviewer_agents.observe import validate_observation

    obs_body: dict[str, Any] = {
        "schema": "observation/v0.2",
        "frame_ref": {
            "schema": "frame_ref/v0.2",
            "surface_id": "cap-assembly-smoke01",
            "generation": 1,
            "tick": 0,
            "ts_ns": 1000,
            "width": 320,
            "height": 200,
            "format": "rgb24",
            "ramws_path": "/dev/shm/mv-assembly-smoke",
            "sha256": "a" * 64,
            "capture_us": 100,
        },
        "vision": {
            "summary": "assembly smoke observation",
            "changed_regions": [
                {"x": 16, "y": 32, "w": 144, "h": 48},
            ],
            "elements": [
                {
                    "bbox": {"x": 16, "y": 32, "w": 144, "h": 48},
                    "role": "button",
                    "name": "ok",
                    "confidence": 1.0,
                }
            ],
        },
    }
    validate_observation(
        obs_body,
        surface_id="cap-assembly-smoke01",
        generation=1,
        contract_version="v0.2",
    )
    env = make_envelope(
        msg_id="msg-assembly-smoke-01",
        from_component="core",
        from_instance="core-01",
        to_component="wender",
        to_instance="wender-01",
        session_id="sess-assembly-smoke-01",
        seq=1,
        nonce="0" * 32,
        ts_ns=1000,
        body=obs_body,
    )
    validate_envelope(env)
    return env


_FORBIDDEN_ACTUATION_KEYS: frozenset[str] = frozenset(
    {
        "actuated",
        "actuation",
        "after_frame",
        "cdp",
        "decision",
        "executed",
        "executed_at_ns",
        "focus_verified",
        "input_mono_ns",
        "input_ts_ns",
        "native_evidence",
        "receipt",
        "verdict",
        "verification",
        "verified",
    }
)


def _reject_actuation_fields(value: Any) -> None:
    """Reject any actuation or execution-receipt field in planner CLI output."""
    stack: list[Any] = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            forbidden = sorted(_FORBIDDEN_ACTUATION_KEYS & set(current.keys()))
            if forbidden:
                raise ValueError(
                    f"planner output contains forbidden actuation field(s): {forbidden}"
                )
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)


def build_wender_planner_request() -> dict[str, Any]:
    """Build the {observation, element_table, goal} request sent by MetaViewer's Wender provider."""
    agents_root = str(REPO_ROOT / "agents")
    if agents_root not in sys.path:
        sys.path.insert(0, agents_root)
    from metaviewer_agents.observe import _reject_non_canonical, validate_observation
    from metaviewer_agents.perception.vcore import _BoundVision, project_element_table

    obs_env = build_minimal_observation_envelope()
    observation = obs_env["body"]
    frame_ref = observation["frame_ref"]
    validate_observation(
        observation,
        surface_id=frame_ref["surface_id"],
        generation=frame_ref["generation"],
        contract_version="v0.2",
    )
    element_table = project_element_table(
        frame_ref,
        _BoundVision(observation["vision"], frame_ref["sha256"]),
    )
    _reject_non_canonical(element_table, 0)
    goal = "ok"
    _reject_non_canonical(goal, 0)
    return {
        "observation": observation,
        "element_table": element_table,
        "goal": goal,
    }


def validate_planner_proposal_output(
    raw_stdout: str,
    *,
    request: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Parse planner CLI stdout and verify it is a valid non-actuating plan or action_proposal/v0.2."""
    agents_root = str(REPO_ROOT / "agents")
    if agents_root not in sys.path:
        sys.path.insert(0, agents_root)
    from metaviewer_agents.envelope import make_envelope, validate_envelope
    from metaviewer_agents.executor import AdmittedExecutor
    from metaviewer_agents.observe import _reject_non_canonical
    from metaviewer_agents.tools import _check_action, _check_expectation, _check_proposal
    from metaviewer_agents.verify import build_proposal
    from metaviewer_agents.wender_bridge import validate_state

    text = raw_stdout.strip()
    if not text:
        raise ValueError("wender.plan.cli produced empty stdout")
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if len(lines) != 1:
        raise ValueError(f"wender.plan.cli must emit exactly one JSON line, got {len(lines)}")
    try:
        payload = json.loads(lines[0], object_pairs_hook=_unique_object_pairs)
    except json.JSONDecodeError as exc:
        raise ValueError(f"wender.plan.cli stdout is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError("wender.plan.cli stdout must be a JSON object")

    _reject_actuation_fields(payload)

    if request is not None and set(payload) != {"action", "expectation", "state", "target_node"}:
        raise ValueError("expected planner reply {action, expectation, state, target_node}")

    if set(payload.keys()) == {"action", "expectation", "state", "target_node"}:
        active_req = request if request is not None else build_wender_planner_request()
        obs = (
            active_req.get("observation")
            if isinstance(active_req, dict) and "observation" in active_req
            else build_wender_planner_request()["observation"]
        )
        frame = obs["frame_ref"]
        state = payload["state"]
        action = payload["action"]
        expectation = payload["expectation"]
        target = payload["target_node"]

        validate_state(state)
        if state.get("viewport") != {"w": frame["width"], "h": frame["height"]}:
            raise ValueError("planner state viewport disagrees with observation frame")
        _reject_non_canonical(target, 0)
        _check_action(action)
        _check_expectation(expectation)
        if action.get("type") != "click":
            raise ValueError("only custody-bound clicks supported from wender.plan.cli")
        AdmittedExecutor.check_target(target, latest=state["nodes"], frame=frame)
        if target.get("actionable") is not True or target.get("id") not in state["actionable"]:
            raise ValueError("planner target_node is not actionable")
        tx, ty, tw, th = target["box"]
        if not (tx <= action["x"] < tx + tw and ty <= action["y"] < ty + th):
            raise ValueError("planner click falls outside target_node box")
        proposal = build_proposal(
            frame,
            proposal_id="prop-assembly-smoke-01",
            action=action,
            expectation=expectation,
            max_ms=1000,
            max_retries=0,
        )
        wrapped = make_envelope(
            msg_id="msg-assembly-smoke-prop-01",
            from_component="wender",
            from_instance="wender-01",
            to_component="core",
            to_instance="core-01",
            session_id="sess-assembly-smoke-01",
            seq=1,
            nonce="1" * 32,
            ts_ns=2000,
            body=proposal,
        )
        validate_envelope(wrapped)
        return proposal

    if payload.get("schema") == "envelope/v0.2":
        validate_envelope(payload)
        body = payload.get("body")
        if not isinstance(body, dict) or body.get("schema") != "action_proposal/v0.2":
            raise ValueError("envelope body must be action_proposal/v0.2")
        _check_proposal(body)
        return body

    if payload.get("schema") == "action_proposal/v0.2":
        _check_proposal(payload)
        wrapped = make_envelope(
            msg_id="msg-assembly-smoke-prop-01",
            from_component="wender",
            from_instance="wender-01",
            to_component="core",
            to_instance="core-01",
            session_id="sess-assembly-smoke-01",
            seq=1,
            nonce="1" * 32,
            ts_ns=2000,
            body=payload,
        )
        validate_envelope(wrapped)
        return payload

    raise ValueError(
        f"expected planner reply {{action, expectation, state, target_node}}, action_proposal/v0.2, or envelope/v0.2, got keys={sorted(payload.keys())!r}"
    )


def smoke_vision_engine(
    tree_dir: Path,
    pin: PinnedComponent,
    *,
    timeout_s: float,
) -> SmokeResult:
    """Drive VCorePerceptionAdapter against vision-engine with synthetic 320x200 frames."""
    t0 = time.monotonic()
    adapter_timeout = min(max(timeout_s, 1.0), 60.0)
    probe_code = """
import hashlib
import json
from pathlib import Path
import sys

repo_root = Path(sys.argv[1])
vision_dir = Path(sys.argv[2])
adapter_timeout = float(sys.argv[3])
sys.path.insert(0, str(repo_root / "agents"))

from metaviewer_agents.perception.base import Frame
from metaviewer_agents.perception.vcore import VCorePerceptionAdapter, project_element_table

adapter = VCorePerceptionAdapter(
    ve_root=vision_dir,
    timeout=adapter_timeout,
    python=sys.executable,
)
width, height = 320, 200
prev_frame = Frame(width=width, height=height, data=bytes(width * height * 3))
buf = bytearray(width * height * 3)

for y in range(40, 80):
    for x in range(30, 150):
        idx = (y * width + x) * 3
        buf[idx : idx + 3] = b"\\xff\\xff\\xff"

for y in range(120, 150):
    for x in range(200, 300):
        idx = (y * width + x) * 3
        buf[idx : idx + 3] = b"\\xff\\xff\\xff"

cur_frame = Frame(width=width, height=height, data=bytes(buf))
frame_ref = {
    "schema": "frame_ref/v0.2",
    "surface_id": "cap-assembly-smoke01",
    "generation": 1,
    "tick": 1,
    "ts_ns": 1000,
    "width": width,
    "height": height,
    "format": "rgb24",
    "ramws_path": "/dev/shm/mv-assembly-smoke",
    "sha256": hashlib.sha256(cur_frame.data).hexdigest(),
    "capture_us": 100,
}

vision = adapter.perceive(frame_ref, cur_frame, prev=prev_frame)
table = project_element_table(frame_ref, vision)
print(
    json.dumps(
        {
            "changed_regions": vision.get("changed_regions"),
            "element_count": len(table.get("elements", [])),
            "table_schema": table.get("schema"),
        },
        sort_keys=True,
    )
)
"""
    try:
        proc = subprocess.run(
            [
                sys.executable,
                "-c",
                probe_code,
                str(REPO_ROOT),
                str(tree_dir),
                str(adapter_timeout),
            ],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    except subprocess.TimeoutExpired:
        elapsed = int((time.monotonic() - t0) * 1000)
        return SmokeResult(
            component=pin.name,
            status="FAIL",
            detail=f"timeout after {timeout_s:.1f}s",
            duration_ms=elapsed,
        )

    elapsed = int((time.monotonic() - t0) * 1000)
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip().splitlines()
        msg = err[-1] if err else f"rc={proc.returncode}"
        return SmokeResult(
            component=pin.name,
            status="FAIL",
            detail=f"VCorePerceptionAdapter probe failed ({msg})",
            duration_ms=elapsed,
        )

    try:
        data = json.loads(proc.stdout.strip())
    except json.JSONDecodeError as exc:
        return SmokeResult(
            component=pin.name,
            status="FAIL",
            detail=f"invalid probe JSON output: {exc}",
            duration_ms=elapsed,
        )

    regions = data.get("changed_regions")
    if regions != EXPECTED_VISION_REGIONS:
        return SmokeResult(
            component=pin.name,
            status="FAIL",
            detail=f"changed_regions={regions!r} != expected {EXPECTED_VISION_REGIONS!r}",
            duration_ms=elapsed,
        )

    return SmokeResult(
        component=pin.name,
        status="PASS",
        detail=(
            f"commit={pin.commit[:12]} changed_regions={json.dumps(regions, separators=(',', ':'))}"
        ),
        duration_ms=elapsed,
    )


def run_wender_planner_check(
    tree_dir: Path,
    *,
    timeout_s: float,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> tuple[bool, str]:
    """Execute wender.plan.cli with the provider's observation/table/goal request."""
    cli_file = tree_dir / "wender" / "plan" / "cli.py"
    cli_pkg_init = tree_dir / "wender" / "plan" / "cli" / "__init__.py"
    if not cli_file.is_file() and not cli_pkg_init.is_file():
        return True, "SKIP (planner not pinned yet)"

    planner_req = build_wender_planner_request()

    env = os.environ.copy()
    existing_pp = env.get("PYTHONPATH", "")
    pp_entries = [str(tree_dir), str(REPO_ROOT / "agents")]
    if existing_pp:
        pp_entries.append(existing_pp)
    env["PYTHONPATH"] = os.pathsep.join(pp_entries)

    proc = runner(
        [sys.executable, "-m", "wender.plan.cli"],
        input=json.dumps(planner_req, sort_keys=True, separators=(",", ":")) + "\n",
        capture_output=True,
        text=True,
        timeout=timeout_s,
        env=env,
        check=False,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip().splitlines()
        msg = err[-1] if err else f"rc={proc.returncode}"
        return False, f"wender.plan.cli failed ({msg})"

    try:
        proposal = validate_planner_proposal_output(proc.stdout, request=planner_req)
    except Exception as exc:  # noqa: BLE001
        return False, f"invalid action_proposal/v0.2 from wender.plan.cli: {exc}"

    return True, f"wender.plan.cli verified proposal_id={proposal.get('proposal_id')}"


def smoke_wender_agent(
    tree_dir: Path,
    pin: PinnedComponent,
    *,
    timeout_s: float,
) -> SmokeResult:
    """Verify wender-agent public entry points and optional wender.plan.cli."""
    t0 = time.monotonic()
    import_probe = """
import importlib
import json
from pathlib import Path
import sys

repo_root = Path(sys.argv[1])
wender_dir = Path(sys.argv[2])
entrypoints = json.loads(sys.argv[3])

sys.path.insert(0, str(wender_dir))
sys.path.insert(0, str(repo_root / "agents"))

for mod_name in entrypoints:
    importlib.import_module(mod_name)

from wender.state.schema import build_state
from metaviewer_agents.wender_bridge import validate_state

node_id = "0123456789abcdef"
state = build_state(
    [
        {
            "id": node_id,
            "role": "button",
            "name": "OK",
            "depth": 0,
            "ordinal": 0,
            "attrs": (),
        }
    ],
    kind="vision",
    url=None,
    title="smoke",
    ax_sha256="a" * 64,
    ax_stable_sha256="b" * 64,
    prune={"name": "smoke", "version": 1},
    raw_count=1,
    boxes={node_id: [16, 32, 144, 48]},
    viewport={"w": 320, "h": 200},
    actionable_roles=frozenset({"button"}),
)
digest = validate_state(state)
print(json.dumps({"imported": list(entrypoints), "schema": state["schema"], "digest": digest}))
"""
    try:
        proc = subprocess.run(
            [
                sys.executable,
                "-c",
                import_probe,
                str(REPO_ROOT),
                str(tree_dir),
                json.dumps(list(WENDER_PUBLIC_ENTRYPOINTS)),
            ],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    except subprocess.TimeoutExpired:
        elapsed = int((time.monotonic() - t0) * 1000)
        return SmokeResult(
            component=pin.name,
            status="FAIL",
            detail=f"timeout after {timeout_s:.1f}s",
            duration_ms=elapsed,
        )

    if proc.returncode != 0:
        elapsed = int((time.monotonic() - t0) * 1000)
        err = (proc.stderr or proc.stdout or "").strip().splitlines()
        msg = err[-1] if err else f"rc={proc.returncode}"
        return SmokeResult(
            component=pin.name,
            status="FAIL",
            detail=f"entrypoint import/state check failed ({msg})",
            duration_ms=elapsed,
        )

    try:
        planner_ok, planner_note = run_wender_planner_check(
            tree_dir,
            timeout_s=timeout_s,
        )
    except subprocess.TimeoutExpired:
        elapsed = int((time.monotonic() - t0) * 1000)
        return SmokeResult(
            component=pin.name,
            status="FAIL",
            detail=f"wender.plan.cli timeout after {timeout_s:.1f}s",
            duration_ms=elapsed,
        )

    elapsed = int((time.monotonic() - t0) * 1000)
    if not planner_ok:
        return SmokeResult(
            component=pin.name,
            status="FAIL",
            detail=planner_note,
            duration_ms=elapsed,
            planner_note=planner_note,
        )

    return SmokeResult(
        component=pin.name,
        status="PASS",
        detail=(
            f"commit={pin.commit[:12]} entrypoints={len(WENDER_PUBLIC_ENTRYPOINTS)} "
            f"planner={planner_note}"
        ),
        duration_ms=elapsed,
        planner_note=planner_note,
    )


def smoke_opensuperficies(
    tree_dir: Path,
    pin: PinnedComponent,
    *,
    scratch_root: Path,
    timeout_s: float,
) -> SmokeResult:
    """Build srf-identity-surface and srf-holdings-capsule and run hosted-safe adapter tests."""
    t0 = time.monotonic()
    go_bin = shutil.which("go")
    if not go_bin:
        return SmokeResult(
            component=pin.name,
            status="FAIL",
            detail="go toolchain not found on PATH",
            duration_ms=0,
        )

    bin_dir = scratch_root / "srf-bin"
    bin_dir.mkdir(parents=True, exist_ok=True)

    for bin_name, pkg_path in OPENSUPERFICIES_BINARIES:
        out_bin = bin_dir / bin_name
        try:
            build_proc = subprocess.run(
                [go_bin, "build", "-o", str(out_bin), pkg_path],
                cwd=str(tree_dir),
                capture_output=True,
                text=True,
                timeout=timeout_s,
                check=False,
            )
        except subprocess.TimeoutExpired:
            elapsed = int((time.monotonic() - t0) * 1000)
            return SmokeResult(
                component=pin.name,
                status="FAIL",
                detail=f"go build {bin_name} timeout after {timeout_s:.1f}s",
                duration_ms=elapsed,
            )
        if build_proc.returncode != 0 or not out_bin.is_file():
            elapsed = int((time.monotonic() - t0) * 1000)
            err = (build_proc.stderr or build_proc.stdout or "").strip().splitlines()
            msg = err[-1] if err else f"rc={build_proc.returncode}"
            return SmokeResult(
                component=pin.name,
                status="FAIL",
                detail=f"go build {bin_name} failed ({msg})",
                duration_ms=elapsed,
            )

    # Probe srf-identity-surface capabilities directly (no docker, Xvfb, or capsule).
    try:
        cap_proc = subprocess.run(
            [str(bin_dir / "srf-identity-surface"), "capabilities"],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    except subprocess.TimeoutExpired:
        elapsed = int((time.monotonic() - t0) * 1000)
        return SmokeResult(
            component=pin.name,
            status="FAIL",
            detail=f"srf-identity-surface capabilities timeout after {timeout_s:.1f}s",
            duration_ms=elapsed,
        )
    if cap_proc.returncode != 0 or "srf-identity-surface capabilities v1" not in cap_proc.stdout:
        elapsed = int((time.monotonic() - t0) * 1000)
        return SmokeResult(
            component=pin.name,
            status="FAIL",
            detail=f"srf-identity-surface capabilities unexpected output (rc={cap_proc.returncode})",
            duration_ms=elapsed,
        )

    state_dir = scratch_root / "srf-state"
    state_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(state_dir, 0o700)

    env = os.environ.copy()
    env["MV_E2E_LIVE"] = "1"
    env["MV_SRF_BIN_DIR"] = str(bin_dir)
    env["MV_SRF_STATE_DIR"] = str(state_dir)
    env["MV_SRF_NESTED_LIVE_PROFILE"] = "assembly-smoke"

    try:
        test_proc = subprocess.run(
            [go_bin, "test", "-count=1", "./internal/capsule", "./internal/view"],
            cwd=str(REPO_ROOT / "daemon-adapter"),
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    except subprocess.TimeoutExpired:
        elapsed = int((time.monotonic() - t0) * 1000)
        return SmokeResult(
            component=pin.name,
            status="FAIL",
            detail=f"daemon-adapter go test timeout after {timeout_s:.1f}s",
            duration_ms=elapsed,
        )

    elapsed = int((time.monotonic() - t0) * 1000)
    if test_proc.returncode != 0:
        err = (test_proc.stderr or test_proc.stdout or "").strip().splitlines()
        msg = err[-1] if err else f"rc={test_proc.returncode}"
        return SmokeResult(
            component=pin.name,
            status="FAIL",
            detail=f"daemon-adapter tests failed ({msg})",
            duration_ms=elapsed,
        )

    built_names = ",".join(name for name, _ in OPENSUPERFICIES_BINARIES)
    return SmokeResult(
        component=pin.name,
        status="PASS",
        detail=f"commit={pin.commit[:12]} built=[{built_names}] daemon-adapter=ok",
        duration_ms=elapsed,
    )


def format_smoke_line(result: SmokeResult) -> str:
    """Format a single one-line PASS/FAIL report for a component smoke."""
    status = "PASS" if result.status == "PASS" else "FAIL"
    return f"{status} {result.component}: {result.detail}"


def aggregate_results(
    results: Sequence[SmokeResult],
    required_components: Sequence[str] = REQUIRED_COMPONENTS,
) -> tuple[bool, list[str]]:
    """Aggregate component smoke results and verify required component coverage."""
    lines: list[str] = []
    by_comp: dict[str, SmokeResult] = {}
    all_ok = True

    for res in results:
        if res.planner_note == "SKIP (planner not pinned yet)":
            lines.append("SKIP (planner not pinned yet)")
        lines.append(format_smoke_line(res))
        if res.component in by_comp:
            all_ok = False
        by_comp[res.component] = res
        if res.status != "PASS":
            all_ok = False

    for req in required_components:
        if req not in by_comp:
            all_ok = False
            lines.append(f"FAIL {req}: missing smoke result")

    return all_ok, lines


def run_all_smokes(
    *,
    lock_path: Path,
    deps_root: Path,
    strict_head: bool,
    timeout_s: float,
) -> tuple[bool, list[SmokeResult], list[str]]:
    """Parse deps.lock, prepare each pinned checkout, run all smokes, and aggregate."""
    pins = parse_deps_lock(lock_path)
    results: list[SmokeResult] = []

    with tempfile.TemporaryDirectory(prefix="mv-assembly-smoke-") as tmp:
        scratch_root = Path(tmp)
        for comp_name in REQUIRED_COMPONENTS:
            pin = pins[comp_name]
            try:
                repo_dir = resolve_component_dir(deps_root, pin)
                tree_dir, _ = prepare_pinned_tree(
                    repo_dir,
                    pin,
                    strict_head=strict_head,
                    scratch_root=scratch_root,
                    timeout_s=timeout_s,
                )
            except Exception as exc:  # noqa: BLE001
                results.append(
                    SmokeResult(
                        component=pin.name,
                        status="FAIL",
                        detail=str(exc),
                        duration_ms=0,
                    )
                )
                continue

            if comp_name == "vision-engine":
                results.append(
                    smoke_vision_engine(tree_dir, pin, timeout_s=timeout_s)
                )
            elif comp_name == "wender-agent":
                results.append(
                    smoke_wender_agent(tree_dir, pin, timeout_s=timeout_s)
                )
            elif comp_name == "opensuperficies":
                results.append(
                    smoke_opensuperficies(
                        tree_dir,
                        pin,
                        scratch_root=scratch_root,
                        timeout_s=timeout_s,
                    )
                )

    ok, lines = aggregate_results(results)
    return ok, results, lines


def write_github_outputs(pins: dict[str, PinnedComponent], output_path: Path) -> None:
    """Write validated repo and commit outputs for GitHub Actions."""
    key_prefix = {
        "vision-engine": "vision_engine",
        "wender-agent": "wender_agent",
        "opensuperficies": "opensuperficies",
    }
    lines: list[str] = []
    for name in REQUIRED_COMPONENTS:
        pin = pins[name]
        prefix = key_prefix[name]
        lines.append(f"{prefix}_repo={pin.repo}")
        lines.append(f"{prefix}_commit={pin.commit}")
        lines.append(f"{prefix}_dir={pin.repo_basename}")
    with Path(output_path).open("a", encoding="utf-8") as handle:
        for line in lines:
            handle.write(line + "\n")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run MetaViewer assembly smokes against pinned private dependencies."
    )
    parser.add_argument(
        "--lock",
        type=Path,
        default=DEFAULT_LOCK_PATH,
        help="Path to deps.lock (default: repo deps.lock)",
    )
    parser.add_argument(
        "--deps-root",
        type=Path,
        default=DEFAULT_DEPS_ROOT,
        help="Directory containing component checkouts (default: ./_deps)",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_S,
        help="Hard timeout in seconds per smoke step (default: 60.0)",
    )
    parser.add_argument(
        "--strict-head",
        action="store_true",
        help="Require git HEAD in each component checkout to match the pinned commit",
    )
    parser.add_argument(
        "--print-pins",
        action="store_true",
        help="Validate deps.lock and print JSON summary of pinned components, then exit",
    )
    parser.add_argument(
        "--github-output",
        type=Path,
        default=None,
        help="Validate deps.lock and append repo/commit variables to a GitHub Actions output file",
    )
    args = parser.parse_args(argv)

    try:
        pins = parse_deps_lock(args.lock)
    except ValueError as exc:
        print(f"FAIL deps.lock: {exc}", file=sys.stderr)
        return 1

    if args.github_output is not None:
        write_github_outputs(pins, args.github_output)

    if args.print_pins:
        payload = {
            name: {
                "repo": pins[name].repo,
                "commit": pins[name].commit,
                "version": pins[name].version,
                "kind": pins[name].kind,
                "checkout_dir": pins[name].repo_basename,
            }
            for name in REQUIRED_COMPONENTS
        }
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0

    if args.github_output is not None:
        return 0

    ok, _results, lines = run_all_smokes(
        lock_path=args.lock,
        deps_root=args.deps_root,
        strict_head=args.strict_head,
        timeout_s=args.timeout,
    )
    for line in lines:
        print(line)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
