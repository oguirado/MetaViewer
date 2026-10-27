"""Bounded agent workflow; success is exclusively the core's receipt.

[TARGET, unit decision] MV_WENDER_PLANNER_CMD is a JSON argv array, never
shell text. Configured Wender requires a goal and pinned MV_WENDER_ROOT;
otherwise the injected local planner is used. Return the verified receipt
for the caller to record; typed exceptions are terminal outcomes, no retries.
Injected perception adapters own their subprocess timeout; the loop checks
its total deadline after each synchronous step before admitting more work.
"""
import copy
import json
import math
import os
import time

from . import tools
from .observe import ObservationError


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
             perception_adapter=None, goal=None):
    """Observe, plan, submit once, then await the core; never replay an action."""
    if type(timeout_ms) is not int or not 1 <= timeout_ms <= 60000:
        raise ValueError('invalid timeout')
    deadline = time.monotonic() + timeout_ms / 1000

    def remaining():
        value = math.ceil((deadline - time.monotonic()) * 1000)
        if value <= 0:
            raise TimeoutError('loop deadline exceeded')
        return value

    observation = tools.observe(surface_id, client=client, timeout_ms=remaining(),
                                perception_adapter=perception_adapter)
    remaining()
    configured = os.environ.get('MV_WENDER_PLANNER_CMD')
    if configured is not None:
        # Lazy import avoids the bridge/tools/executor import cycle.
        from .perception.deps_lock import resolve_locked_component
        from .perception.vcore import project_element_table
        from .wender_bridge import WenderSubprocessAdapter

        try:
            command = json.loads(configured)
        except (ValueError, RecursionError) as exc:
            raise ObservationError('bad_shape', 'planner command must be JSON argv') from exc
        if (not isinstance(command, list) or not command
                or any(not isinstance(arg, str) or not arg or '\x00' in arg for arg in command)):
            raise ObservationError('bad_shape', 'planner command must be nonempty JSON argv')
        if 'vision' not in observation:
            raise ObservationError('unavailable', 'Wender requires perception evidence')
        root = resolve_locked_component('wender-agent')
        bridge = WenderSubprocessAdapter(command=command, wender_root=root,
                                         timeout=remaining() / 1000)
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
    receipt = tools.wait_verify(proposal_id, expectation, remaining(), client=client)
    remaining()
    return receipt
