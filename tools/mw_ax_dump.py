#!/usr/bin/env python3
"""Read-only AX dump and workflow anchor readiness check for a live capsule."""
from __future__ import annotations

import argparse
import difflib
import json
import os
from pathlib import Path
import stat
import sys
from typing import Any

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
for _entry in (str(REPO_ROOT / 'agents'), str(TOOLS_DIR), str(REPO_ROOT)):
    if _entry not in sys.path:
        sys.path.insert(0, _entry)

import mw_run_backend as backend


def _clean_str(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ''


def _need(condition: bool, code: str, message: str = '') -> None:
    if not condition:
        raise backend.refuse(code, message) if message else backend.OwnerRefused(code)


def _resolve_identity_and_container(
    capsule_arg: str,
    state_dir: Path,
) -> tuple[str, str | None]:
    raw = _clean_str(capsule_arg)
    _need(bool(raw), 'MW_CAPSULE_ID', 'empty --capsule')
    if not raw.startswith('srf-id-'):
        return raw, None
    try:
        entries = sorted(state_dir.glob('*.json'))
    except OSError as exc:
        raise backend.refuse('MW_SRF_STATE', f'cannot list {state_dir}: {exc}') from exc
    for path in entries:
        try:
            doc = backend.private_json(path, state_dir)
        except backend.OwnerRefused:
            continue
        if not isinstance(doc, dict):
            continue
        cap = doc.get('Capsule') if isinstance(doc.get('Capsule'), dict) else {}
        lease = doc.get('Lease') if isinstance(doc.get('Lease'), dict) else {}
        container = _clean_str(cap.get('container') or doc.get('container'))
        if container != raw:
            continue
        profile = _clean_str(
            lease.get('ProfileID')
            or doc.get('profile_id')
            or doc.get('profile')
            or doc.get('identity')
        )
        if profile:
            return profile, raw
    return raw[len('srf-id-'):] or raw, raw


def _predicate_anchor_names(
    predicate: Any,
    node_label: str,
    out: list[tuple[str, str, str]],
) -> None:
    if not isinstance(predicate, dict):
        return
    cap = _clean_str(predicate.get('capability_id'))
    if cap and not cap.startswith('mv.ax.'):
        return
    role_hint = 'textbox' if cap == 'mv.ax.focus.v1' else 'any'
    for binding in predicate.get('bindings') or ():
        if not isinstance(binding, dict):
            continue
        if binding.get('name') == 'name':
            val = _clean_str(binding.get('value'))
            if val:
                out.append((node_label, val, role_hint))


def _target_anchor_names(
    target: Any,
    node_label: str,
    role_hint: str,
    out: list[tuple[str, str, str]],
) -> None:
    if not isinstance(target, dict):
        return
    ref = _clean_str(target.get('anchor_ref'))
    if ref.startswith('ax:') and ref[3:].strip():
        out.append((node_label, ref[3:].strip(), role_hint))
    for req in target.get('required_anchor_refs') or ():
        req_str = _clean_str(req)
        if req_str.startswith('ax:') and req_str[3:].strip():
            out.append((node_label, req_str[3:].strip(), role_hint))
    _predicate_anchor_names(target.get('frame_predicate'), node_label, out)


def _extract_workflow_anchors(
    workflow: dict[str, Any],
) -> list[tuple[str, str, str]]:
    wf_id = _clean_str(workflow.get('id')) or 'workflow'
    raw_items: list[tuple[str, str, str]] = []
    for pred in workflow.get('preconditions') or ():
        _predicate_anchor_names(pred, f'{wf_id}:precondition', raw_items)
    for step in workflow.get('steps') or ():
        if not isinstance(step, dict):
            continue
        seq = step.get('seq', '?')
        step_node = _clean_str(step.get('id') or step.get('node')) or f'{wf_id}:step:{seq}'
        cap = _clean_str(step.get('capability_id'))
        role_hint = 'textbox' if 'type_text' in cap or 'focus' in cap else 'control'
        for pred in step.get('preconditions') or ():
            _predicate_anchor_names(pred, step_node, raw_items)
        for pred in step.get('already_satisfied') or ():
            _predicate_anchor_names(pred, step_node, raw_items)
        _target_anchor_names(step.get('target'), step_node, role_hint, raw_items)
        verify = step.get('verify')
        if isinstance(verify, dict):
            _predicate_anchor_names(verify.get('predicate'), step_node, raw_items)
    oracle = workflow.get('oracle')
    if isinstance(oracle, dict):
        for pred in oracle.get('postconditions') or ():
            _predicate_anchor_names(pred, f'{wf_id}:oracle', raw_items)

    deduped: list[tuple[str, str, str]] = []
    seen: dict[str, int] = {}
    for node_label, anchor_name, role_hint in raw_items:
        if anchor_name not in seen:
            seen[anchor_name] = len(deduped)
            deduped.append((node_label, anchor_name, role_hint))
        elif role_hint == 'textbox' and deduped[seen[anchor_name]][2] != 'textbox':
            prev_node, prev_name, _ = deduped[seen[anchor_name]]
            deduped[seen[anchor_name]] = (prev_node, prev_name, 'textbox')
    return deduped


def _load_site_workflows(
    repo: Path,
    home: Path,
    site: str,
    workflow_id: str | None,
) -> list[dict[str, Any]]:
    root = backend.site_root(home, site, repo)
    wf_dir = root / 'sites' / site / 'workflows'
    _need(wf_dir.is_dir(), 'MW_WORKFLOW_ABSENT', f'missing workflows dir for {site}')
    if workflow_id:
        wf_path = wf_dir / f'{workflow_id}.json'
        _need(wf_path.is_file(), 'MW_WORKFLOW_ABSENT', f'missing workflow {workflow_id}')
        paths = [wf_path]
    else:
        paths = sorted(wf_dir.glob('*.json'))
        _need(bool(paths), 'MW_WORKFLOW_ABSENT', f'no workflows for {site}')
    workflows: list[dict[str, Any]] = []
    for path in paths:
        doc = json.loads(backend.bounded_read(path, root))
        _need(isinstance(doc, dict), 'MW_WORKFLOW_SCHEMA', f'{path} is not a JSON object')
        workflows.append(doc)
    return workflows


def _sanitize_tree(tree: dict[str, Any]) -> dict[str, Any]:
    _need(isinstance(tree, dict), 'MW_RUN_AX_SCHEMA', 'AX payload is not a JSON object')
    elements = tree.get('elements')
    _need(isinstance(elements, list), 'MW_RUN_AX_SCHEMA', 'AX elements is not a list')
    clean_elements: list[dict[str, Any]] = []
    for row in elements:
        if not isinstance(row, dict):
            continue
        clean_row: dict[str, Any] = {}
        raw_val = row.get('value')
        for key, val in row.items():
            if key in ('value', 'text'):
                continue
            clean_row[key] = val
        if 'value_len' in clean_row and clean_row['value_len'] is not None:
            try:
                clean_row['value_len'] = int(clean_row['value_len'])
            except (TypeError, ValueError):
                clean_row['value_len'] = None
        elif isinstance(raw_val, str):
            clean_row['value_len'] = len(raw_val)
        else:
            clean_row.setdefault('value_len', None)
        clean_elements.append(clean_row)
    sanitized = {k: v for k, v in tree.items() if k not in ('value', 'text')}
    sanitized['elements'] = clean_elements
    return sanitized


def _write_private_out(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = (json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + '\n').encode('utf-8')
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(path, flags, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, raw)
    finally:
        os.close(fd)


def _has_ellipsis(text: str) -> bool:
    return text.endswith('…') or text.endswith('...')


def _rank_candidates(
    anchor_name: str,
    role_hint: str,
    elements: list[dict[str, Any]],
    limit: int = 5,
) -> list[str]:
    by_name: dict[str, dict[str, Any]] = {}
    for row in elements:
        name = _clean_str(row.get('name'))
        if not name or name == anchor_name:
            continue
        role = _clean_str(row.get('role'))
        actionable = bool(row.get('actionable'))
        region = _clean_str(row.get('region'))
        entry = by_name.setdefault(
            name,
            {'roles': set(), 'actionable': False, 'regions': set()},
        )
        if role:
            entry['roles'].add(role)
        if actionable:
            entry['actionable'] = True
        if region:
            entry['regions'].add(region)

    anchor_cf = anchor_name.casefold()
    anchor_ell = _has_ellipsis(anchor_name)
    scored: list[tuple[float, str]] = []
    for name, meta in by_name.items():
        roles = meta['roles']
        sim = difflib.SequenceMatcher(None, anchor_cf, name.casefold()).ratio()
        bonus = 0.0
        if role_hint == 'textbox' and ('textbox' in roles or 'combobox' in roles):
            bonus += 2.0
        elif 'textbox' in roles or 'combobox' in roles:
            bonus += 0.35
        if anchor_ell and _has_ellipsis(name):
            bonus += 1.5
        if meta['actionable']:
            bonus += 0.25
        if 'main' in meta['regions']:
            bonus += 0.15
        scored.append((bonus + sim, name))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [name for _, name in scored[:limit]]


def _init_host_backend(
    client: Any,
    identity: str,
    evidence_dir: Path,
    env: dict[str, str],
) -> backend.HostBackend:
    """Initialize HostBackend with its binary resolution and ownership check."""
    host = object.__new__(backend.HostBackend)
    host.client = client
    host.identity = identity
    host.evidence = Path(evidence_dir)
    merged = client.host_env if isinstance(getattr(client, 'host_env', None), dict) else env
    _need(
        isinstance(identity, str) and bool(backend.live.PROFILE_ID_RE.fullmatch(identity)),
        'MW_IDENTITY',
    )
    for key in ('MV_SRF_STATE_DIR', 'MV_SRF_BIN_DIR', 'SRF_IDENTITY_STORE_ROOT'):
        if not merged.get(key):
            raise backend.refuse('MW_RUN_CONFIG', f'{key} is not set; use the value of the running app')
    host.state = Path(merged['MV_SRF_STATE_DIR'])
    host.binary = Path(merged['MV_SRF_BIN_DIR']) / 'srf-identity-surface'
    host.store = Path(merged['SRF_IDENTITY_STORE_ROOT'])
    host.admin = host.binary.with_name('srf-identity-admin')
    _need(all(p.is_absolute() for p in (host.state, host.binary, host.store)), 'MW_RUN_CONFIG')
    host.pending = {}
    host.network_evidence = None
    host.surface_id = None
    host.capsule = None
    host.ownership()
    return host


def _focused_summary(elements: list[dict[str, Any]]) -> dict[str, str | None]:
    for row in elements:
        states = row.get('states') if isinstance(row.get('states'), dict) else {}
        if row.get('focused') is True or states.get('focused') is True:
            role = row.get('role') if isinstance(row.get('role'), str) else None
            name = row.get('name') if isinstance(row.get('name'), str) else None
            return {'role': role, 'name': name}
    return {'role': None, 'name': None}


def run_dump(
    repo: Path,
    capsule_arg: str,
    site: str,
    workflow_id: str | None,
    out_path: Path,
    home_arg: Path | None = None,
    env: dict[str, str] | None = None,
) -> tuple[int, dict[str, Any]]:
    env_map = dict(os.environ if env is None else env)
    home = backend.admit_home(repo, str(home_arg) if home_arg else env_map.get('MV_MW_HOME'))
    workflows = _load_site_workflows(repo, home, site, workflow_id)

    anchors_spec: list[tuple[str, str, str]] = []
    seen_anchors: set[str] = set()
    for wf in workflows:
        for node_label, anchor_name, role_hint in _extract_workflow_anchors(wf):
            if anchor_name not in seen_anchors:
                seen_anchors.add(anchor_name)
                anchors_spec.append((node_label, anchor_name, role_hint))

    with backend.connect(env_map) as client:
        merged_env = client.host_env if isinstance(getattr(client, 'host_env', None), dict) else env_map
        state_raw = _clean_str(merged_env.get('MV_SRF_STATE_DIR'))
        _need(bool(state_raw), 'MW_RUN_CONFIG', 'MV_SRF_STATE_DIR is not set; use the value of the running app')
        identity, expected_container = _resolve_identity_and_container(capsule_arg, Path(state_raw))

        evidence_dir = out_path.resolve().parent
        host_backend = _init_host_backend(client, identity, evidence_dir, merged_env)
        if expected_container is not None:
            _need(
                host_backend.capsule == expected_container,
                'MW_RUN_NO_SURFACE',
                f'capsule container {host_backend.capsule!r} != {expected_container!r}',
            )
        try:
            raw_tree = host_backend.native(
                host_backend.binary,
                [
                    'ax',
                    '--container',
                    host_backend.capsule,
                    '--window',
                    'w1',
                    '--state-dir',
                    str(host_backend.state),
                ],
            )
        except OSError as exc:
            raise backend.refuse('MW_RUN_NATIVE', f'cannot execute {host_backend.binary}: {exc}') from exc

    sanitized_tree = _sanitize_tree(raw_tree)
    _write_private_out(out_path, sanitized_tree)

    elements = sanitized_tree['elements']
    present_names = {
        _clean_str(row.get('name'))
        for row in elements
        if _clean_str(row.get('name'))
    }
    anchors_report: list[dict[str, Any]] = []
    all_present = True
    for node_label, anchor_name, role_hint in anchors_spec:
        is_present = anchor_name in present_names
        if not is_present:
            all_present = False
        candidates = (
            []
            if is_present
            else _rank_candidates(anchor_name, role_hint, elements)
        )
        anchors_report.append(
            {
                'node': node_label,
                'anchor_name': anchor_name,
                'present': is_present,
                'candidates': candidates,
            }
        )

    window = sanitized_tree.get('window') if isinstance(sanitized_tree.get('window'), dict) else {}
    window_url = window.get('url') if isinstance(window.get('url'), str) else ''
    summary: dict[str, Any] = {
        'marker': 'MW_AX_DUMP',
        'rows': len(elements),
        'window_url': window_url,
        'focused': _focused_summary(elements),
        'anchors': anchors_report,
    }
    if not all_present:
        summary['code'] = 'MW_AX_ANCHOR_DRIFT'
        return 3, summary
    return 0, summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True, type=Path, help='MetaViewer repository root')
    parser.add_argument('--capsule', required=True, help='Capsule identity or container name')
    parser.add_argument('--site', required=True, help='Site id in memoryweb home')
    parser.add_argument('--workflow', default=None, help='Optional workflow id')
    parser.add_argument('--out', required=True, type=Path, help='Output JSON path (mode 0600)')
    parser.add_argument('--home', default=None, type=Path, help='Optional memoryweb home override')
    args = parser.parse_args(argv)

    try:
        rc, summary = run_dump(
            repo=args.repo.resolve(),
            capsule_arg=args.capsule,
            site=args.site,
            workflow_id=args.workflow,
            out_path=args.out,
            home_arg=args.home,
        )
    except (
        OSError,
        ValueError,
        RuntimeError,
        KeyError,
        TypeError,
        backend.OwnerRefused,
        backend.HomeError,
        backend.ClientError,
        backend.DependencyLockError,
        backend.tools.ToolRefusal,
    ) as exc:
        code = getattr(exc, 'code', getattr(exc, 'reason_code', 'MW_RUN_CONFIG'))
        detail = str(exc)
        print(
            json.dumps(
                {
                    'marker': 'MW_AX_DUMP',
                    'status': 'refused',
                    'code': code,
                    'detail': detail,
                },
                sort_keys=True,
                ensure_ascii=False,
            )
        )
        return 6

    assert stat.S_IMODE(args.out.stat().st_mode) == 0o600
    print(json.dumps(summary, ensure_ascii=False))
    return rc


if __name__ == '__main__':
    raise SystemExit(main())
