"""Engine entry for the Use MetaViewer button; host capabilities live in tools.

Program capsules: --surface-kind program --identity ID --goal TEXT --steps N.
This mode records bounded verified visual clicks, with no task-completion claim.
Browser mode remains the default and requires --site and --workflow.

[TARGET, unit decision] Run-level wall deadline formula:
  budget_s = max(site.execution_policy.min_notice_s,
                 workflow.execution_policy.min_notice_s)
             + sum_steps(locate_wait_ms + action.delivery_budget_ms + verify.deadline_ms) / 1000.0
             + WALL_DEADLINE_MARGIN_S (30.0 s)
When the staged or builtin workflow definition is unavailable or invalid before
runner entry, fall back to WALL_DEADLINE_CEILING_S (360.0 s).
The environment override MV_MW_WALL_DEADLINE_S may only lower the budget
(effective_s = min(budget_s, override_s) for finite override_s > 0).
On expiry, SIGALRM / signal.setitimer(ITIMER_REAL) raises WallDeadlineError
(a RuntimeError subclass with code = 'MW_WALL_DEADLINE') on the main thread so
tools/mw_run_backend.py:run_entry catches it, writes report.json, emits the
metaviewer.mw_run/v1 JSON line, and exits with rc 6. If the deadline expires
while the owner is inside the uncertain input dispatch window (owner result
verdict_code == 'INPUT_UNCERTAIN', rc 5), INPUT_UNCERTAIN is preserved so the
caller never retries an input that may already have been delivered, while
recording the expired deadline on the diagnostic field.
"""
import argparse
from contextlib import contextmanager
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import sys
import time
import uuid

WALL_DEADLINE_CODE = 'MW_WALL_DEADLINE'
WALL_DEADLINE_RC = 6
WALL_DEADLINE_MARGIN_S = 30.0
WALL_DEADLINE_CEILING_S = 360.0
WALL_DEADLINE_ENV = 'MV_MW_WALL_DEADLINE_S'
PRESERVE_INPUT_UNCERTAIN_ON_DEADLINE = True
MAX_NOTICE_S = 300
MAX_WORKFLOW_BYTES = 65536
_ID_RE = re.compile(r'^[a-z0-9][a-z0-9-]{0,63}$')


class WallDeadlineError(RuntimeError):
    """Raised on the main thread when the run-level wall deadline expires."""

    def __init__(self, budget_s, message=None):
        self.code = WALL_DEADLINE_CODE
        self.budget_s = float(budget_s)
        text = message or (
            f'{WALL_DEADLINE_CODE}: run exceeded wall deadline ({self.budget_s:g} s); '
            'inspect report.json and check core and capsule responsiveness before retrying'
        )
        super().__init__(text)


def _strict_nonneg_int(value, *, minimum=0, maximum=None):
    if type(value) is not int or value < minimum:
        raise ValueError('invalid integer budget field')
    if maximum is not None and value > maximum:
        raise ValueError('budget field exceeds maximum')
    return value


def _bounded_json(path):
    path = Path(path)
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise ValueError('symlinked workflow path')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_WORKFLOW_BYTES:
            raise ValueError('invalid workflow file')
        raw = stream.read(MAX_WORKFLOW_BYTES + 1)
    if len(raw) > MAX_WORKFLOW_BYTES:
        raise ValueError('oversized workflow file')
    value = json.loads(raw.decode('utf-8'))
    if not isinstance(value, dict):
        raise ValueError('workflow document must be an object')
    return value


def budget_from_workflow(workflow, site=None, workflow_id=None, *, margin_s=WALL_DEADLINE_MARGIN_S):
    """Return the run-level wall budget in seconds from a workflow and optional site.

    Accepts either parsed dicts (workflow_dict, site_dict=None), a workflow file path,
    or a root/site directory paired with 'site/workflow' or (site_id, workflow_id).
    """
    if isinstance(workflow, (str, Path)):
        base = Path(workflow)
        if base.is_file():
            workflow_doc = _bounded_json(base)
            if isinstance(site, (str, Path)):
                site_doc = _bounded_json(site)
            elif isinstance(site, dict):
                site_doc = site
            elif base.parent.name == 'workflows' and (base.parent.parent / 'site.json').is_file():
                site_doc = _bounded_json(base.parent.parent / 'site.json')
            else:
                site_doc = None
            return budget_from_workflow(workflow_doc, site_doc, margin_s=margin_s)
        if isinstance(site, str) and '/' in site and workflow_id is None:
            site, workflow_id = site.split('/', 1)
        if not isinstance(site, str) or not isinstance(workflow_id, str):
            raise ValueError('directory budget lookup requires site and workflow identifiers')
        if not (_ID_RE.fullmatch(site) and _ID_RE.fullmatch(workflow_id)):
            raise ValueError('invalid site or workflow identifier')
        site_dir = base / 'sites' / site if (base / 'sites' / site).is_dir() else base
        site_doc = _bounded_json(site_dir / 'site.json')
        workflow_doc = _bounded_json(site_dir / 'workflows' / (workflow_id + '.json'))
        return budget_from_workflow(workflow_doc, site_doc, margin_s=margin_s)

    if not isinstance(workflow, dict):
        raise ValueError('workflow must be a dict or path')
    if isinstance(site, (str, Path)):
        site = _bounded_json(site)
    elif site is not None and not isinstance(site, dict):
        raise ValueError('site must be a dict, path, or None')

    wf_policy = workflow.get('execution_policy')
    if not isinstance(wf_policy, dict):
        raise ValueError('workflow execution_policy missing')
    wf_notice_s = _strict_nonneg_int(wf_policy.get('min_notice_s'), minimum=0, maximum=MAX_NOTICE_S)
    site_notice_s = 0
    if site is not None:
        site_policy = site.get('execution_policy')
        if not isinstance(site_policy, dict):
            raise ValueError('site execution_policy missing')
        site_notice_s = _strict_nonneg_int(site_policy.get('min_notice_s'), minimum=0, maximum=MAX_NOTICE_S)
    notice_s = max(site_notice_s, wf_notice_s)

    steps = workflow.get('steps')
    if not isinstance(steps, list) or not steps:
        raise ValueError('workflow steps must be a non-empty list')
    steps_ms = 0
    for step in steps:
        if not isinstance(step, dict):
            raise ValueError('step must be an object')
        action = step.get('action')
        verify = step.get('verify')
        if not isinstance(action, dict) or not isinstance(verify, dict):
            raise ValueError('step action and verify must be objects')
        locate_wait_ms = _strict_nonneg_int(step.get('locate_wait_ms'), minimum=0)
        delivery_budget_ms = _strict_nonneg_int(action.get('delivery_budget_ms'), minimum=1)
        verify_deadline_ms = _strict_nonneg_int(verify.get('deadline_ms'), minimum=1)
        steps_ms += locate_wait_ms + delivery_budget_ms + verify_deadline_ms

    margin_val = float(margin_s)
    if not math.isfinite(margin_val) or margin_val < 0:
        raise ValueError('margin_s must be a non-negative finite number')
    return float(notice_s) + (steps_ms / 1000.0) + margin_val


def apply_budget_override(budget_s, override=None):
    """Apply a test override that is allowed only to lower budget_s."""
    base = float(budget_s)
    if override is None:
        return base
    if isinstance(override, str):
        override = override.strip()
        if not override:
            return base
    try:
        candidate = float(override)
    except (TypeError, ValueError):
        return base
    if not math.isfinite(candidate) or candidate <= 0:
        return base
    return min(base, candidate)


def resolve_wall_deadline_s(args, *, env=None, home=None, repo_root=None,
                            ceiling_s=WALL_DEADLINE_CEILING_S, margin_s=WALL_DEADLINE_MARGIN_S):
    """Derive the run-level wall deadline in seconds from the staged/selected workflow or ceiling."""
    repo = Path(repo_root) if repo_root is not None else Path(__file__).resolve().parents[2]
    site_id = getattr(args, 'site', None)
    workflow_id = getattr(args, 'workflow', None)
    budget_s = float(ceiling_s)
    active_env = env if env is not None else getattr(os, 'environ', {})
    if getattr(args, 'surface_kind', None) == 'program':
        steps = _strict_nonneg_int(args.steps, minimum=1, maximum=16)
        action_ms = _strict_nonneg_int(args.timeout_ms, minimum=1, maximum=30000)
        model_ms = (_strict_nonneg_int(args.model_timeout_ms, minimum=1, maximum=240000)
                    if args.planner == 'muse' else 0)
        budget_s = min(float(ceiling_s), steps * (3 * action_ms + model_ms) / 1000 + margin_s)
    if isinstance(site_id, str) and isinstance(workflow_id, str):
        if _ID_RE.fullmatch(site_id) and _ID_RE.fullmatch(workflow_id):
            try:
                if home is not None:
                    raw_home = home
                else:
                    raw_home = active_env.get('MV_MW_HOME')
                home_path = Path(raw_home) if raw_home is not None else repo / 'memoryweb'
                if home_path.is_absolute() and '..' not in home_path.parts:
                    candidate = home_path / 'sites' / site_id
                    if candidate.exists():
                        site_dir = candidate if candidate.is_dir() else None
                    elif (home_path / 'site.json').is_file() and (home_path / 'workflows').is_dir():
                        site_dir = home_path
                    else:
                        builtin = repo / 'memoryweb-builtin' / 'sites' / site_id
                        site_dir = builtin if builtin.is_dir() else None
                    if site_dir is not None:
                        budget_s = budget_from_workflow(site_dir, site_id, workflow_id, margin_s=margin_s)
            except (OSError, ValueError, KeyError, TypeError):
                budget_s = float(ceiling_s)
    override = active_env.get('MV_MW_WALL_DEADLINE_S')
    return apply_budget_override(budget_s, override)


def _arm_itimer(seconds):
    signal.setitimer(signal.ITIMER_REAL, float(seconds), 0.0)


def _disarm_itimer():
    signal.setitimer(signal.ITIMER_REAL, 0.0, 0.0)


def _alarm_handler(budget_s, state):
    def handle(signum, frame):
        error = WallDeadlineError(budget_s)
        state['expired'] = error
        raise error
    return handle


@contextmanager
def wall_deadline(budget_s):
    """Arm the run-level wall deadline and disarm on exit."""
    state = {'expired': None}
    handler = _alarm_handler(budget_s, state)
    previous_handler = signal.signal(signal.SIGALRM, handler)
    owner_mod = sys.modules.get('metaviewer_agents.mw_owner')
    replay_cls = getattr(owner_mod, 'ReplayOwner', None) if owner_mod is not None else None
    orig_run = getattr(replay_cls, 'run', None) if replay_cls is not None else None
    orig_net = getattr(replay_cls, 'check_network', None) if replay_cls is not None else None
    if replay_cls is not None and callable(orig_run) and callable(orig_net):
        def _wrapped_run(self, *a, **kw):
            result = None
            try:
                result = orig_run(self, *a, **kw)
                return result
            finally:
                expired = state['expired']
                if expired is not None:
                    if (
                        PRESERVE_INPUT_UNCERTAIN_ON_DEADLINE
                        and getattr(result, 'verdict_code', None) == 'INPUT_UNCERTAIN'
                    ):
                        diag = getattr(result, 'diagnostic', None)
                        detail = f'{diag}; {expired}' if diag else str(expired)
                        with_detail = getattr(result, '__class__', None)
                        try:
                            if callable(with_detail):
                                return with_detail(
                                    result.rc,
                                    result.verdict_code,
                                    result.summary,
                                    detail,
                                    result.handoff_path,
                                )
                        except Exception:
                            return result
                    else:
                        raise expired

        def _wrapped_net(self, *a, **kw):
            if state['expired'] is not None:
                raise state['expired']
            try:
                return orig_net(self, *a, **kw)
            finally:
                if state['expired'] is not None:
                    raise state['expired']

        replay_cls.run = _wrapped_run
        replay_cls.check_network = _wrapped_net
    try:
        _arm_itimer(budget_s)
        yield state
    finally:
        _disarm_itimer()
        signal.signal(signal.SIGALRM, previous_handler)
        if replay_cls is not None and orig_run is not None and orig_net is not None:
            replay_cls.run = orig_run
            replay_cls.check_network = orig_net


def _write_fallback_report(error):
    """Write report.json and print the mw_run/v1 line if a custom runner lets WallDeadlineError escape."""
    rc, code = WALL_DEADLINE_RC, getattr(error, 'code', WALL_DEADLINE_CODE)
    message = str(error)
    print('mw_run: ' + (message if message and message.startswith(code) else
                        code + (': ' + message if message else '')), file=sys.stderr, flush=True)
    report = None
    repo = Path(__file__).resolve().parents[2]
    try:
        active_env = getattr(os, 'environ', {})
        base = Path(active_env.get('XDG_STATE_HOME', str(Path(os.environ.get('HOME', str(Path.home()))) / '.local/state')))
        if base.is_absolute():
            evidence = base / 'metaviewer/runs' / uuid.uuid4().hex
            if not evidence.is_relative_to(repo):
                evidence.mkdir(mode=0o700, parents=True)
                if not any(p.is_symlink() for p in (evidence, *evidence.parents)):
                    report_path = evidence / 'report.json'
                    report = str(report_path)
                    result = dict(schema='metaviewer.mw_run/v1', rc=rc, verdict_code=code,
                                  receipt=None, report=report)
                    raw = (json.dumps(dict(result, message=message, network=None),
                                      separators=(',', ':')) + '\n').encode('utf-8')
                    fd = os.open(report_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    with os.fdopen(fd, 'wb') as stream:
                        stream.write(raw)
                        stream.flush()
                        os.fsync(stream.fileno())
                else:
                    code = 'MW_PRIVATE_OUTPUT'
            else:
                code = 'MW_PRIVATE_OUTPUT'
        else:
            code = 'MW_PRIVATE_OUTPUT'
    except OSError:
        report = None
        code = 'MW_PRIVATE_OUTPUT'
    result = dict(schema='metaviewer.mw_run/v1', rc=rc, verdict_code=code, receipt=None, report=report)
    print(json.dumps(result, separators=(',', ':')))
    return result['rc']


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__, add_help=False, allow_abbrev=False)
    parser.add_argument('--identity', required=True)
    for flag in ('site', 'workflow'):
        parser.add_argument('--' + flag)
    parser.add_argument('--surface-kind', choices=('browser', 'program'), default='browser')
    parser.add_argument('--goal')
    parser.add_argument('--steps', type=int, default=1)
    parser.add_argument('--timeout-ms', type=int, default=10000)
    parser.add_argument('--planner', choices=('rules', 'muse'), default='rules')
    parser.add_argument('--model-timeout-ms', type=int, default=120000)
    parser.add_argument('--slot', action='append', default=[])
    return parser


def main(argv=None, *, runner=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.surface_kind == 'program':
        if args.site is not None or args.workflow is not None or args.slot:
            parser.error('program mode does not accept --site, --workflow or --slot')
        if not args.goal or not args.goal.strip() or not 1 <= args.steps <= 16 or not 1 <= args.timeout_ms <= 30000:
            parser.error('program mode requires --goal, --steps within 1..16 and --timeout-ms within 1..30000')
        if not 1 <= args.model_timeout_ms <= 240000:
            parser.error('--model-timeout-ms must be within 1..240000')
    elif (not args.site or not args.workflow or args.goal is not None or args.steps != 1 or
          args.timeout_ms != 10000 or args.planner != 'rules' or args.model_timeout_ms != 120000):
        parser.error('browser mode requires --site and --workflow; program options require --surface-kind program')
    if runner is None:
        path = Path(__file__).resolve().parents[2] / 'tools' / 'mw_run_backend.py'
        spec = importlib.util.spec_from_file_location('mv_mw_run_backend', path)
        host = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(host)
        runner = host.run_entry
    budget_s = resolve_wall_deadline_s(args)
    args.wall_deadline_mono_ns = time.monotonic_ns() + int(budget_s * 1e9)
    with wall_deadline(budget_s):
        try:
            return runner(args)
        except WallDeadlineError as error:
            return _write_fallback_report(error)


if __name__ == '__main__':
    sys.exit(main())
