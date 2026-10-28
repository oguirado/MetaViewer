"""Bounded agent workflow; success is exclusively the core's receipt.

[TARGET, unit decision] Wender is the default planner provider via
``DEFAULT_WENDER_PLANNER_CMD = (sys.executable, "-m", "wender.plan.cli")``
with precedence: ``MV_WENDER_PLANNER_CMD`` JSON argv environment override ->
``DEFAULT_WENDER_PLANNER_CMD``. Configured Wender requires a goal, perception
vision evidence, and pinned ``MV_WENDER_ROOT`` verified by
``resolve_locked_component("wender-agent")`` before spawn; it never silently
falls back to the local ``planner`` callable. Return the verified receipt for
the caller to record; typed exceptions are terminal outcomes, no retries.
"""
import copy
import math
import os
from pathlib import Path
import time

from . import tools
from .observe import ObservationError


def get_configured_planner_cmd():
    """Return the raw MV_WENDER_PLANNER_CMD environment override if set."""
    return os.environ.get('MV_WENDER_PLANNER_CMD')


def build_proposal(frame, *, proposal_id, action, expectation, max_ms, max_retries=0):
    tools._check_frame(frame)
    result = dict(schema='action_proposal/v0.2', proposal_id=proposal_id,
                  surface_id=frame['surface_id'], based_on_frame={
                      'sha256': frame['sha256'], 'generation': frame['generation']},
                  action=copy.deepcopy(action), expectation=copy.deepcopy(expectation),
                  budget={'max_ms': max_ms, 'max_retries': max_retries})
    tools._check_proposal(result)
    return result


def run_loop(*, client, surface_id, proposal_id, planner=None, timeout_ms,
             perception_adapter=None, goal=None, provider=None,
             wender_root=None, lock_path=None, model_backend=None):
    """Observe, plan, submit once, then await the core; never replay an action."""
    if type(timeout_ms) is not int or not 1 <= timeout_ms <= 60000:
        raise ValueError('invalid timeout')
    if provider is not None and provider not in ('wender', 'local'):
        raise ObservationError('bad_shape', 'provider must be wender or local')
    deadline = time.monotonic() + timeout_ms / 1000

    def remaining():
        value = math.ceil((deadline - time.monotonic()) * 1000)
        if value <= 0:
            raise TimeoutError('loop deadline exceeded')
        return value

    observation = tools.observe(surface_id, client=client, timeout_ms=remaining(),
                                perception_adapter=perception_adapter)
    frame_ref = observation.get('frame_ref') if isinstance(observation, dict) else None
    observed_surface_id = (
        frame_ref.get('surface_id') if isinstance(frame_ref, dict) else None
    )
    if observed_surface_id != surface_id:
        tools._fail('uncorrelated surface_id')
    remaining()
    # Lazy import avoids the bridge/tools/executor import cycle.
    from .wender_bridge import (
        WenderSubprocessAdapter,
        coerce_model_backend,
        has_configured_wender_root,
        resolve_planner_command,
    )

    configured = get_configured_planner_cmd()
    use_wender = (
        provider == 'wender'
        or configured is not None
        or (
            provider is None
            and (planner is None or has_configured_wender_root(wender_root))
        )
    )
    if use_wender:
        from .perception.deps_lock import resolve_locked_component
        from .perception.vcore import project_element_table

        backend = coerce_model_backend(model_backend)
        command = resolve_planner_command(configured_env=configured, use_env=False)
        if 'vision' not in observation:
            raise ObservationError('unavailable', 'Wender requires perception evidence')
        if lock_path is None:
            root = resolve_locked_component('wender-agent')
        else:
            root = resolve_locked_component('wender-agent', lock_path=lock_path)
        if wender_root is not None:
            try:
                expected_root = Path(wender_root).resolve()
            except (OSError, ValueError, RuntimeError) as exc:
                raise ObservationError('unavailable', 'Wender checkout is not a directory') from exc
            if expected_root != Path(root).resolve():
                raise ObservationError('commit_mismatch', 'verified checkout differs from wender_root')
        bridge = WenderSubprocessAdapter(
            command=command,
            wender_root=root,
            timeout=remaining() / 1000,
            verify_lock=True,
            lock_path=lock_path,
            model_backend=backend,
        )
        action, expectation, _, _ = bridge.plan_step(
            copy.deepcopy(observation),
            project_element_table(observation['frame_ref'], observation['vision']), goal)
    else:
        if not callable(planner):
            raise ObservationError('unavailable', 'local planner required')
        plan = planner(copy.deepcopy(observation))
        if not isinstance(plan, (tuple, list)) or len(plan) != 2:
            raise ObservationError('bad_shape', 'local planner must return action and expectation')
        action, expectation = plan
    proposal = build_proposal(observation['frame_ref'], proposal_id=proposal_id,
                              action=action, expectation=expectation, max_ms=remaining())
    tools.propose(proposal, client=client, timeout_ms=remaining())
    try:
        receipt = tools.wait_verify(
            proposal_id, expectation, remaining(),
            client=client, surface_id=observed_surface_id)
    except TypeError:
        receipt = tools.wait_verify(
            proposal_id, expectation, remaining(), client=client)
    if not isinstance(receipt, dict):
        tools._fail('invalid receipt')
    if 'proposal_id' in receipt and receipt['proposal_id'] != proposal_id:
        tools._fail('uncorrelated proposal_id')
    if 'surface_id' in receipt and receipt['surface_id'] != observed_surface_id:
        tools._fail('uncorrelated surface_id')
    if 'after_frame' in receipt:
        after_frame = receipt['after_frame']
        if (not isinstance(after_frame, dict)
                or after_frame.get('surface_id') != observed_surface_id):
            tools._fail('uncorrelated surface_id')
        if 'schema' in receipt:
            tools._check_receipt_verified(receipt, surface_id=observed_surface_id)
    remaining()
    return receipt
