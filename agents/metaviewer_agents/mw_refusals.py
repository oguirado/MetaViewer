"""Operator remedies for mw_run refusals without changing the result wire format.

[TARGET, unit decision] Attach one static sentence to stderr for a nonzero
metaviewer.mw_run/v1 result; keep existing diagnostics and stdout byte-exact.
Unknown external codes remain refusals and receive a report-inspection remedy.
"""
import json


REFUSALS = {
    'MW_IDENTITY': 'The identity is invalid or unavailable; select an existing identity and run again.',
    'MW_RUN_NO_SURFACE': 'No live capsule matches the identity; start a capsule for that identity before running again.',
    'MW_RUN_AMBIGUOUS': 'More than one surface or ownership route matches; close extra capsules for this identity and select a single live capsule.',
    'MW_RUN_OWNERSHIP': 'Capsule ownership changed or cannot be proved; select the intended capsule and verify its identity before running again.',
    'MW_RUN_REGISTRATION': 'The core agent registration is missing or ambiguous; use the running app configuration and select its registered agent with MV_AGENT_INSTANCE.',
    'MW_RUN_ATTACH': 'The runner cannot attach to one running app; start MetaViewer and use that app’s MV_CORE_CONFIG and XDG_RUNTIME_DIR values.',
    'MW_RUN_CONFIG': 'Runner configuration is missing or invalid; check the diagnostic and use the environment values of the running MetaViewer app.',
    'MW_RUN_CORE': 'The core connection failed; check that MetaViewer is running and use its core configuration before retrying.',
    'MW_RUN_NATIVE': 'The native observation command failed; check the capsule and native tool diagnostic before running again.',
    'MW_RUN_NATIVE_INPUT': 'Native input could not be verified; inspect the capsule and report for a delivered effect before considering another input.',
    'MW_RUN_STATE': 'The observed state cannot support this action; refresh the capsule observation before planning again.',
    'MW_RUN_OPERATION': 'The requested runner operation is unsupported; select a supported workflow operation.',
    'MW_RUN_RECEIPT': 'The run receipt is missing or invalid; inspect the report and capsule state before considering another run.',
    'receipt path absent': 'The expected receipt was not written; inspect the report and capsule state before considering another run.',
    'MW_PROGRAM_CONTROL': 'The capsule is under human control; for a Human-role capsule use Switch to agent mode on its tile; for a temporarily taken-over Agent capsule, press Release on the tile, then run again.',
    'MW_PROGRAM_KEY_REQUEST': 'The navigation request is unsupported; use focused-key with one arrow or Enter, one step, rules and no text.',
    'MW_PROGRAM_KEY_HOST_ONLY': 'Navigation requires an Agent Host program custody binding; select a live Agent Host program before running again.',
    'MW_PROGRAM_KEY_REFUSED': 'The navigation input was refused; inspect the report and acquire a fresh observation before planning again.',
    'MW_COMPILED_BROWSER_UNAVAILABLE': 'The compiled runtime cannot automate browser capsules; configure a verified wender-agent checkout with MV_WENDER_ROOT or use supported program automation.',
    'MW_DEPENDENCY': 'A pinned dependency is unavailable or mismatched; restore the checkout selected by deps.lock before running again.',
    'MW_PRIVATE_OUTPUT': 'Private evidence could not be written safely; use an absolute writable XDG_STATE_HOME outside the repository without symlinked parents.',
    'MW_NETWORK': 'The capsule network context is invalid or changed; verify its network setting and restart the capsule after changing it.',
    'MW_NOTICE': 'The required execution notice is invalid; repair the workflow execution policy before running again.',
    'MW_HANDOFF_REQUIRED': 'The required handoff evidence is missing or invalid; inspect the run report and restore the handoff record before continuing.',
    'HUMAN_HANDOFF': 'The workflow requires human action; inspect the handoff receipt and complete the requested action before continuing.',
    'INPUT_UNCERTAIN': 'Input may already have been delivered; observe and reconcile the capsule state before considering another input.',
    'MW_WALL_DEADLINE': 'The run exceeded its wall deadline; inspect the report and capsule state before considering another run.',
    'MW_FRAME_BINDING': 'The frame does not match the active surface; acquire a fresh frame from the intended capsule before planning again.',
    'MW_RECEIPT_MISMATCH': 'The receipt does not match the submitted action; inspect the report and reconcile the capsule state before continuing.',
    'MW_STALE_FRAME_EXHAUSTED': 'Fresh-frame retries were exhausted; check capsule responsiveness and acquire a fresh observation before planning again.',
    'MW_REBIND_PIXELS': 'The rebound frame pixels do not match; refresh the capsule observation before planning again.',
    'MW_REBIND_SURFACE': 'The rebound surface does not match; select the intended capsule and refresh its observation.',
    'MW_REBIND_TARGET': 'The rebound target cannot be proved; refresh the observation and select an unambiguous target.',
    'MW_AX': 'The accessibility observation is unavailable or invalid; check native accessibility support and refresh the capsule observation.',
    'MW_ANSWER_CAPTION_AMBIGUOUS': 'The answer caption matches multiple elements; give the workflow an unambiguous answer selector.',
    'MW_ANSWER_CONTAINER': 'The answer container cannot be identified; repair its workflow selector against a fresh observation.',
    'MW_ANSWER_TEXT': 'The answer text cannot be read reliably; inspect the capsule and repair the answer selector before running again.',
    'MW_SLOT': 'Slot arguments are invalid or duplicated; supply each slot once as --slot name=value.',
    'MW_SLOT_READBACK_DEADLINE': 'Slot readback exceeded its deadline; inspect the editor state before considering another text input.',
    'MW_SLOT_LENGTH_EDITOR_BINDING': 'The editor binding does not match the slot; repair the workflow editor binding against a fresh observation.',
    'MW_SLOT_LENGTH_MISSING_EDITOR_ID': 'The slot has no editor identifier; add the workflow’s explicit editor identifier before running again.',
    'MW_SLOT_LENGTH_MISSING_READABLE_TEXT': 'The editor has no readable text witness; enable supported readback before running again.',
    'MW_SLOT_LENGTH_TEXT_MISMATCH': 'The editor text differs from the slot value; inspect and reconcile the editor before considering another text input.',
    'MW_SLOT_LENGTH_TEXT_OF_UNAVAILABLE': 'The editor text reader is unavailable; configure supported editor readback before running again.',
    'MW_SLOT_LENGTH_TRUNCATED_TEXT': 'The editor readback is truncated; obtain complete readable text before verifying the slot.',
    'MW_HOME_GIT': 'The MemoryWeb ignore check failed; repair repository access and rerun tools/mw_home_check.py.',
    'MW_HOME_NOT_IGNORED': 'The MemoryWeb home is not ignored by git; configure its ignore rule and rerun tools/mw_home_check.py.',
    'MW_HOME_SYMLINK': 'The MemoryWeb home contains a symlinked path; use a private home without symlinks and rerun tools/mw_home_check.py.',
    'MW_BROWSER_GOAL_CONFIG': 'Browser goal configuration is invalid; check the goal arguments and diagnostic before running again.',
    'MW_BROWSER_GOAL_SURFACE': 'The selected surface cannot run browser goals; select a live browser capsule for this identity.',
    'MW_BROWSER_SURFACE': 'The browser surface cannot be verified; select the intended live browser capsule and refresh its observation.',
    'MW_BROWSER_AX_BOX': 'The browser target has no valid accessibility box; refresh the observation and select a visible accessible target.',
    'MW_BROWSER_FOCUS': 'The browser text target cannot be uniquely focused; select one visible editable field before running again.',
    'MW_BROWSER_KEY': 'The browser key request is unsupported; use Enter only with explicit text and verified readback.',
    'MW_BROWSER_MODEL_MARK_LIMIT': 'The browser observation exceeds the model mark limit; narrow the visible target set before planning again.',
    'MW_BROWSER_NO_TARGETS': 'No supported browser targets are visible; reveal an accessible target and refresh the observation.',
    'MW_BROWSER_PLANNER': 'The browser planner configuration is unsupported; select a supported planner and check its configuration.',
    'MW_BROWSER_STEPS': 'The browser step budget cannot cover the requested input; include focus, typing and any requested key step.',
    'MW_BROWSER_TEXT': 'The browser text argument is invalid; provide nonempty text within the documented byte limit.',
    'MW_BROWSER_TEXT_MISMATCH': 'Browser text readback differs from the request; inspect and reconcile the field before considering another input.',
    'MW_PROGRAM_BINDING': 'The program surface binding cannot be verified; select the intended capsule and restore its adapter binding.',
    'MW_PROGRAM_BUDGET': 'The program action budget is exhausted or invalid; inspect the report and request a bounded supported action.',
    'MW_PROGRAM_CLICK_TARGET': 'The program click target cannot be uniquely located; reveal one visible target and refresh the observation.',
    'MW_PROGRAM_CONFIG': 'Program configuration is invalid; check the diagnostic and the running capsule configuration before running again.',
    'MW_PROGRAM_DEADLINE': 'The program action deadline expired; inspect the capsule and report before considering another action.',
    'MW_PROGRAM_FOCUSED_TEXT_REQUIRED': 'Focused program input requires explicit text; supply --text for the intended focused editor.',
    'MW_PROGRAM_FOCUS_AMBIGUOUS': 'More than one program focus target matches; select one visible editable target before running again.',
    'MW_PROGRAM_FOCUS_UNVERIFIED': 'Program focus cannot be verified; establish and observe the intended editor focus before typing.',
    'MW_PROGRAM_FRAME_CUSTODY': 'Program frame custody cannot be proved; acquire a fresh adapter-owned observation before planning again.',
    'MW_PROGRAM_FRESH_FRAME': 'A fresh program frame is unavailable; check capsule responsiveness and refresh the observation.',
    'MW_PROGRAM_GOAL': 'The program goal is unsupported or invalid; provide a bounded goal grounded in the visible capsule.',
    'MW_PROGRAM_GOAL_UNGROUNDED': 'The program goal has no verified visible grounding; reveal the intended target and rephrase the goal using that observation.',
    'MW_PROGRAM_KEEPALIVE': 'The program frame lease could not be maintained; check capsule responsiveness and obtain a fresh observation.',
    'MW_PROGRAM_MODEL_BUDGET': 'The model planning budget is exhausted or invalid; inspect the report and narrow the requested action.',
    'MW_PROGRAM_MODEL_FAILED': 'Model planning failed before a verified action was available; inspect the planner diagnostic and restore its configuration before planning again.',
    'MW_PROGRAM_MODEL_FRAME': 'The model frame does not match the current observation; acquire a fresh frame and plan again.',
    'MW_PROGRAM_MODEL_OUTPUT_LIMIT': 'The model reply exceeded the output limit; narrow the goal and request a bounded supported action.',
    'MW_PROGRAM_MODEL_PROCESS_TARGET': 'The model process target cannot be verified; select the intended capsule process and refresh its observation.',
    'MW_PROGRAM_MODEL_TARGET': 'The model reply does not identify one valid observed target; refresh the observation and select a uniquely grounded target before planning again.',
    'MW_PROGRAM_MODEL_TIMEOUT': 'Model planning timed out; check planner responsiveness and inspect the report before planning again.',
    'MW_PROGRAM_NO_NEW_PUBLICATION': 'The capsule published no new frame; check capsule responsiveness and obtain a new observation.',
    'MW_PROGRAM_NO_VISIBLE_EFFECT': 'The action produced no verified visible effect; inspect the capsule state before considering another action.',
    'MW_PROGRAM_OBSERVATION_CHANGED': 'The program observation changed during planning; refresh the observation and plan again.',
    'MW_PROGRAM_OPERATION': 'The requested program operation is unsupported; select a supported bounded program action.',
    'MW_PROGRAM_PASSWORD': 'Program input targets a protected password field; enter credentials manually in the capsule.',
    'MW_PROGRAM_PERCEPTION': 'Program perception is unavailable or invalid; check the pinned perception dependency and refresh the observation.',
    'MW_PROGRAM_PLANNER': 'The program planner is unsupported or unavailable; select a supported planner and check its pinned dependency.',
    'MW_PROGRAM_RAM_REQUIRED': 'Program evidence requires private RAM storage; configure a private evidence directory under /dev/shm.',
    'MW_PROGRAM_STEPS': 'The program step count is invalid; use a count within the documented CLI bounds.',
    'MW_PROGRAM_SURFACE': 'The selected program surface cannot be verified; select a live program capsule for this identity.',
    'MW_PROGRAM_TEXT_FIELD': 'The program text target is not a supported editable field; select a visible supported editor.',
    'MW_PROGRAM_TEXT_MISMATCH': 'Program text readback differs from the request; inspect and reconcile the editor before considering another input.',
    'MW_PROGRAM_TEXT_REFUSED': 'Program text input was refused; inspect the report and editor state before considering another input.',
    'MW_PROGRAM_TEXT_STEPS': 'Program text input requires a single bounded step; use --steps 1 with --text.',
    'MW_PROGRAM_UNKNOWN_OBSERVATION': 'The program observation cannot be classified safely; inspect the capsule and acquire a supported observation.',
    'MW_GATE_': 'The stored workflow failed its pinned gate; repair the site data and rerun tools/mw_home_check.py for the selected workflow.',
    'OUT_OF_SUPPORT': 'The requested action is outside the supported contract; inspect the report and choose a supported workflow or take over manually.',
    'USAGE_SCHEMA': 'The request does not match the supported schema; correct its arguments or workflow definition before running again.',
    'SEAL_MISMATCH': 'An artifact does not match its pinned seal; restore the verified artifact before running again.',
    'LOW_CONFIDENCE': 'The target cannot be identified confidently; refresh the observation and select one explicit target.',
    'CHANGE_MISMATCH': 'The observed change does not match the expected effect; inspect and reconcile the capsule state before continuing.',
    'DEADLINE': 'The workflow deadline expired; inspect the report and capsule state before considering another run.',
    'TORN': 'The workflow journal is incomplete or inconsistent; preserve the evidence and recover a verified generation from the last complete prefix.',
    'STUCK': 'The workflow cannot make verified progress; inspect the capsule and take over manually or revise the supported workflow.',
    'REPAIR_EXHAUSTED': 'The workflow exhausted its repair attempts; inspect the handoff evidence and take over manually.',
    'STALE_FRAME': 'The action refers to a stale frame; acquire a fresh observation and plan again.',
}


def refusal_sentence(code):
    """Return a static remedy, including for dynamically supplied dependency codes."""
    if code in REFUSALS:
        return REFUSALS[code]
    if code.startswith('MW_GATE_'):
        return REFUSALS['MW_GATE_']
    return 'The runner refused with an unrecognized code; inspect the existing diagnostic and run report, then reconcile the capsule state before continuing.'


class RefusalOutput:
    """Transparent stdout proxy observing bounded JSON lines, never buffering output.

    Only complete result records trigger stderr copy; oversized or non-result
    lines pass through without being interpreted as verdicts.
    """
    def __init__(self, stream, stderr):
        self.stream = stream
        self.stderr = stderr
        self.pending = ''
        self.oversized = False

    def __getattr__(self, name):
        return getattr(self.stream, name)

    def write(self, text):
        written = self.stream.write(text)
        parts = text.split('\n')
        for index, part in enumerate(parts):
            if not self.oversized:
                if len(self.pending) + len(part) <= 65536:
                    self.pending += part
                else:
                    self.pending = ''
                    self.oversized = True
            if index < len(parts) - 1:
                self._line()
                self.pending = ''
                self.oversized = False
        return written

    def _line(self):
        if self.oversized:
            return
        try:
            result = json.loads(self.pending)
        except (ValueError, RecursionError):
            return
        if (isinstance(result, dict) and result.get('schema') == 'metaviewer.mw_run/v1'
                and type(result.get('rc')) is int and result['rc'] != 0
                and isinstance(result.get('verdict_code'), str)):
            # JSON encoding keeps unknown external codes on one diagnostic line.
            code = json.dumps(result['verdict_code'], ensure_ascii=True)
            print('mw_run refusal ' + code + ': ' + refusal_sentence(result['verdict_code']),
                  file=self.stderr, flush=True)
