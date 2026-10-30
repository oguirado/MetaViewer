"""Absorbing run handoff; no solver, retry, reset or resume operation.

[TARGET, unit decision] An explicit observation `observed_wall` marker with
kind login_wall or captcha_wall supplies the missing observed-wall seam.
Login controls alone are not walls. A new ReplayOwner is a new authorized run.
The path is returned directly and through the closed run schema's evidence_refs.
"""
from dataclasses import dataclass
import json


@dataclass(frozen=True)
class HandoffResult:
    rc: int
    verdict_code: str
    summary: object
    diagnostic: str | None
    handoff_path: str | None


class HandoffLatch:
    def __init__(self, path):
        self.path = path
        self.latched = False

    def inspect(self, sensed, seq, write):
        if self.latched:
            return True
        # Pinned wender/perceive/stopstate.py:89-176; inspect existing STATE,
        # never acquire a new perception path or persist detector evidence values.
        from wender.perceive.stopstate import detect
        state = sensed.get('state', {'nodes': sensed.get('ax', [])})
        observed = sensed.get('observed', {})
        receipt = detect(state, url=observed.get('url', ''),
                         frame_urls=observed.get('frame_urls', state.get('frame_urls', ())),
                         headers=observed.get('headers', state.get('headers')))
        wall = observed.get('observed_wall')
        if (not receipt['is_stop'] and type(wall) is dict and
                wall.get('observed') is True and
                wall.get('kind') in ('login_wall', 'captcha_wall')):
            # Marker walls use ax_role_name synthetically; no AX cue is asserted.
            receipt = dict(is_stop=True, reason=wall['kind'], confidence=100,
                           evidence=[{'kind': 'ax_role_name'}])
        if not receipt['is_stop']:
            return False
        self.latched = True  # Persistence failure must never reopen admission.
        record = dict(schema='metaviewer.handoff/v1', surface_id=sensed['frame']['surface_id'],
                      step_index=seq, reason=receipt['reason'], confidence=receipt['confidence'],
                      evidence_kinds=sorted({e['kind'] for e in receipt['evidence']}))
        write(self.path, (json.dumps(record, sort_keys=True) + '\n').encode())
        return True
