"""Execution facts only; admission and final verification belong to the core.

[TARGET, unit decision] The supervisor supplies the admitted verdict and an
injected transport accepting the frozen proposal. No producer CLI is guessed.
The caller must use the core's dispatch lease, never an agent-supplied verdict.
"""
import copy
import re

from .tools import _check_proposal, _check_verdict_admitted


class SurfaceError(ValueError):
    def __init__(self, code, kind):
        self.code = code
        super().__init__(f'{code}: {kind}')


class SurfaceRefused(SurfaceError):
    pass


class AdmittedExecutor:
    def __init__(self, *, transport):
        if not callable(transport):
            raise TypeError('transport required')
        self.transport = transport

    def dispatch(self, proposal, verdict):
        proposal = copy.deepcopy(_check_proposal(proposal))
        _check_verdict_admitted(verdict)
        if verdict['proposal_id'] != proposal['proposal_id']:
            raise SurfaceRefused('POLICY', 'proposal binding')
        result = self.transport(proposal)
        if not isinstance(result, dict) or result.get('focus_verified') is not True:
            raise SurfaceRefused('refused_focus', proposal['action']['type'])
        if type(result.get('input_mono_ns')) is not int or result['input_mono_ns'] < 0:
            raise SurfaceError('malformed_capture', proposal['action']['type'])
        # A transport cannot confer verification authority through extra fields.
        return {'focus_verified': True, 'input_mono_ns': result['input_mono_ns']}

    @staticmethod
    def check_target(target, *, latest, frame):
        if not isinstance(target, dict) or not isinstance(latest, list):
            raise ValueError('target custody')
        matches = [row for row in latest if row.get('id') and row.get('id') == target.get('id')]
        stable = lambda row: {k: v for k, v in row.items() if k != 'value'}
        if len(matches) != 1 or stable(matches[0]) != stable(target):
            raise ValueError('target custody')
        if re.search(r'^(?:Stop|Detener)\b', target.get('name', ''), re.I):
            raise SurfaceRefused('generation_control', 'click')
        box = target.get('box')
        if (not isinstance(box, list) or len(box) != 4
                or any(type(v) is not int for v in box)):
            raise SurfaceError('alignment', 'click')
        x, y, w, h = box
        if (x < 0 or y < 0 or w < 1 or h < 1
                or x + w > frame['width'] or y + h > frame['height']):
            raise SurfaceError('alignment', 'click')
