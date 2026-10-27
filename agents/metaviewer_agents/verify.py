"""Bounded agent workflow; success is exclusively the core's receipt."""
import copy
import math
import time

from . import tools


def build_proposal(frame, *, proposal_id, action, expectation, max_ms, max_retries=0):
    tools._check_frame(frame)
    result = dict(schema='action_proposal/v0.2', proposal_id=proposal_id,
                  surface_id=frame['surface_id'], based_on_frame={
                      'sha256': frame['sha256'], 'generation': frame['generation']},
                  action=copy.deepcopy(action), expectation=copy.deepcopy(expectation),
                  budget={'max_ms': max_ms, 'max_retries': max_retries})
    tools._check_proposal(result)
    if expectation['type'] == 'state_sha256_change' and expectation['min_tick'] > expectation['max_tick']:
        raise ValueError('inverted tick window')
    return result


def run_loop(*, client, surface_id, proposal_id, planner, timeout_ms):
    """Observe, plan, submit once, then await the core; never replay an action."""
    if type(timeout_ms) is not int or not 1 <= timeout_ms <= 60000:
        raise ValueError('invalid timeout')
    deadline = time.monotonic() + timeout_ms / 1000

    def remaining():
        value = math.ceil((deadline - time.monotonic()) * 1000)
        if value <= 0:
            raise TimeoutError('loop deadline exceeded')
        return value

    observation = tools.observe(surface_id, client=client, timeout_ms=remaining())
    action, expectation = planner(copy.deepcopy(observation))
    proposal = build_proposal(observation['frame_ref'], proposal_id=proposal_id,
                              action=action, expectation=expectation, max_ms=remaining())
    tools.propose(proposal, client=client, timeout_ms=remaining())
    return tools.wait_verify(proposal_id, expectation, remaining(), client=client)
