# Native program actions

[TARGET, unit decision] Click verification uses a core `changed_region` over
the complete surface, followed by an independent, hash-checked RGB comparison
against the actual dispatch frame. The comparison excludes pre-dispatch table
rows identified as clocks/timers or whose complete name is a clock/time label
or a time-of-day string. Clock-only changes and unchanged open Mines squares
fail with `MW_PROGRAM_NO_VISIBLE_EFFECT`; a calculator display change outside
the clicked button can pass. Unidentified animation is not proof of causality;
this lane certifies visible effects, not completion of the requested goal.
OCR marks are requested within the existing perception budget to identify clock
labels. No mark, transport or action budget is increased.

For a field that already has focus (for example, a just opened editor), use:

```sh
PYTHONPATH=agents python3 -m metaviewer_agents.mw_run --identity PROGRAM_PROFILE \
  --surface-kind program --goal focused --text 'hello' --steps 1
```

[TARGET, unit decision] `focused` reserves an explicit operator assertion of
current focus. It makes no planner/model call and submits one `type` action
through the existing core admission, custody, frame rebind and settlement path.
It never clicks or manufactures a target mark. Empty visual observations are
allowed only for this mode. Known password evidence in the observation refuses
before input; visual data cannot guarantee detection of unlabeled password fields.
Immediately before each submission, focused mode observes and drains pending
frame publications to bind the newest frame, including after explicit
`STALE_FRAME` nonexecution refusals. Pixel changes do not require a target,
another perception or a model call. Surface, geometry, generation, custody,
ownership, existing attempt cap and original deadline remain enforced. Click
modes retain their unchanged-target checks. Exhaustion without any admission
is a clean refusal, with no input or uncertain-input verdict.

Focused OCR uses the RGB changed-area bounding box between the actual dispatch
frame and the post-input receipt frame, intersected with the unique focused
field when available. Unrelated labels outside this box do not affect readback.
The report retains `changed_box` and `readback_box`. A single terminal OCR `|`
is treated as a blinking caret when the requested text does not end in `|`;
all other characters, case and spacing must still match literally.
This mode requires `--text` and `--steps 1`; `--key`
remains browser only. The direct program tool accepts the same goal and text.

For a named field requiring a grounded focus click, use:

```sh
PYTHONPATH=agents python3 -m metaviewer_agents.mw_run --identity PROGRAM_PROFILE \
  --surface-kind program --goal 'Message' --text 'hello' --steps 1
```

The named-field text mode permits a single focus-and-type sequence [TARGET]. It first
grounds and verifies a click on a field, requires the core's focus witness,
then submits a separate `type` action through core admission. Both actions
require a published visible effect. The type action retains its own intent,
dispatch and settlement evidence. The field is rebound by its box and role in
the post-click observation; an absent or ambiguous field refuses typing.
Known password roles, labels and protected/secret/password states refuse before
the focus click and are checked again before typing. Visual data cannot identify
every password field; no password detection guarantee is claimed for unlabeled
fields. Muse remains a click selector; the operator's text is never generated
by the model.

After typing, the existing OCR perception path reads the receipt's published
frame. Only actual `ocr_text` from marks centered inside the selected OCR region is
used, in raster reading order. The report's `text_readback` is `exact`,
`not_readable`, or `mismatch` when read-back has been reached. Exact requires
literal equality, including case, subject to the focused caret rule above.
Missing OCR is `not_readable`, with success
only under the explicit `PROGRAM_TEXT_UNCERTIFIED_NOT_READABLE` verdict and an
`uncertified_text` move. Readable disagreement refuses with a nonzero result,
`text_readback: mismatch`, and retained partial action evidence. A failure before
read-back records null, rather than inventing a read-back outcome.

Use the public engine entry against an already running agent-owned program capsule:

```sh
PYTHONPATH=agents python3 -m metaviewer_agents.mw_run \
  --surface-kind program --identity PROGRAM_PROFILE \
  --goal 'Covered square' --steps 3 --timeout-ms 10000
```

The example requests three actions [TARGET]. Supply the running app's `MV_CORE_CONFIG`,
`XDG_RUNTIME_DIR` and `MV_SRF_STATE_DIR`. Legacy container programs also need
`MV_SRF_BIN_DIR` and `SRF_IDENTITY_STORE_ROOT` from that app.
Supply the locked dependency roots with `MV_WENDER_ROOT` and `VQA_VE_ROOT`.
For a host-xpra program, `MV_SRF_STATE_DIR` supplies the adapter's private binding;
identity-store and native-admin configuration are unnecessary. The legacy
container-backed host-exec program lane retains its native identity and Docker
lease checks, and also requires the adapter witness for the same public surface
and native run. An unrelated active legacy lease never supplies missing custody.
Program evidence defaults to a private subtree beneath `/dev/shm/vqa-cu`.
An explicit `XDG_STATE_HOME` must resolve inside `/dev/shm`, with owned mode-0700
directories and no symlink traversal. Disk evidence refuses before connection or
capture; there is no disk fallback. The command does not create a capsule.

To explicitly request model-backed visual decisions, add `--planner muse` and
provide a natural-language goal. For example:

```sh
PYTHONPATH=agents python3 -m metaviewer_agents.mw_run \
  --surface-kind program --identity PROGRAM_PROFILE --planner muse \
  --goal 'Start the small Mines game; avoid window controls' --steps 1 \
  --model-timeout-ms 60000
```

This example requests one model-planned action [TARGET]. Opting into Muse sends
the selected program's visual marks and projected observation to the configured
authenticated provider through Wender's actual `ModelClient`/`MuseBackend`.
There is no automatic provider selection or fallback from the default rules mode.
Only mark-bound clicks are admitted. The model's unique current mark must map to
the real vision table, then Wender's custody CLI builds and validates its click.

The normal app creation hook is
`globalThis.metaviewerRoles.createProgram({binary: ABSOLUTE_BINARY, role: 'agent'})`.
Read the admitted surface's `profile_id`; do not assume the host-selected name.
The host provisions the identity and program mode before requesting the existing
`desktop_capsule` wire surface. Raw surface creation alone does not perform that setup.
For the existing host-xpra setup path, use
`globalThis.metaviewerRoles.createProgram({binary: ABSOLUTE_BINARY, role: 'agent', hostXpra: true})`.
This path deliberately omits identity-store provisioning. Use the returned program
profile and current core surface; the command does not launch or attach a window.
Native Agent role is separate from core control. The normal UI can arm human
wall input immediately after creation, leaving the wire surface `control:'human'`.
Use the supported Release control UI action, then verify the core surface list
reports `control:'agent'` before starting the program command. `take_control`
means human takeover; the automation never changes that control on its own.

Each tick invokes the locked vision adapter (`vadapt.vserve` or `vadapt.cu_describe`),
projects its bound element table, and invokes the locked Wender planner CLI.
Static first-frame localization explicitly requests the engine's real marks in
a private temporary directory beneath its required `/dev/shm/vqa-cu` namespace.
The directory is removed when the invocation exits. Empty localization remains
a refusal; its actual vision result, transport and diagnostic errors are retained.
The planner uses deterministic goal overlap to select a visual target and produces
a custody-bound click. It is not a general language-model game solver.
In the default rules mode, this entry requires `--goal` to equal exactly one observed element
name, ignoring letter case and whitespace. The selected role and box must match
that element. Generic goals with no unique observed name refuse
`MW_PROGRAM_GOAL_UNGROUNDED`; the planner's highest-score fallback cannot
authorize an arbitrary control. A numbered mark can be an explicit grounded
subgoal, but does not itself establish that the control is a game square.
Muse mode retains the user's goal separately and grounds the model-selected
mark's exact observed name before using the same custody gate.
ModelClient makes the semantic goal decision. Exact-target rules establish
observable target custody; they do not prove that the user's goal was achieved.
For each additional requested move, the lane observes the settled surface,
requests a real fresh publication through the existing shared subscriber, and
waits for a generation newer than both that observation and the previous verified
receipt. It then invokes VE and Wender again. Unchanged pixels may accompany a
new genuine capture; a repeated generation cannot authorize another planning tick.
The next acquisition must match the frame passed to perception and belong to the
same surface. Only the existing bounded explicit `STALE_FRAME` nonexecution path
can trigger an input retry; an unknown dispatch or settlement cannot do so.
The existing backend submits the action through core admission and waits for the
verified native receipt. Before submission, off-target pixel changes can be admitted
only with the target proof described below; a changed target requires replanning.

Success means `PROGRAM_BOUNDED_ACTIONS_VERIFIED`, not task or game completion.
The existing `metaviewer.mw_run/v1` output identifies `moves.json` and `report.json`.
The report retains visual observations, element tables, planner targets, frame
bindings, pending dispatch state, core receipts and immutable RGB frame artifacts.
Inspect pending dispatch evidence before considering another attempt after failure.
The frozen frame-subscription request has no success acknowledgement. The core's
real observation and proposal admission remain authoritative. Before dispatch,
repeat subscribe asks the existing shared poller to publish a new real capture,
including unchanged pixels; the lane waits for that actual newer generation and
proves unchanged geometry and surface plus identical whole-frame pixels or a
unique unchanged target before using the existing plan.
One actor drains authenticated frame events during provider pipe I/O; there is
no competing background reader. The lane never automatically unsubscribes the
global surface poller or cancels other readers; explicit surface lifecycle stop
owns that cleanup. Bounded fresh perception/replanning is permitted after a
pre-proposal observation change. Explicit core `STALE_FRAME` nonexecution retries
only frame acquisition and RGB validation. Unknown delivery or settlement returns
`INPUT_UNCERTAIN` and is never automatically retried.

Private atomic `intent-*.json` and `dispatch-*.json` records are synced before
core submission, including the exact proposal identifier and rebound frame.
An atomic `receipt-*.json` follows verified settlement. These survive an interrupted
final report. An output failure after verified delivery also returns `INPUT_UNCERTAIN`.
An unverified terminal result or wait timeout additionally retains the actual
`VerificationFailed.receipt` payload in `verification-failure-*.json` and the
attempt/report, separately correlated to the dispatched proposal. That payload
can be a tool error/timeout result rather than an action receipt. Missing payloads
remain unknown; missing proposal fields are not manufactured inside them. A
diagnostic-journal failure keeps the in-memory payload and `INPUT_UNCERTAIN`,
never a successful move or an automatic replay.

Drained agent clicks now use the adapter's existing bounded capture-settling loop,
as text/key delivery already did: genuine post-input captures only, within the
existing `1500 ms` bound and `50 ms` spacing [CITED: adapter settle constants].
This allows delayed GUI paint to reach the receipt without repeating input.
Human-origin and native semantic Holdings behavior are unchanged. A click with no visible effect returns its
actual unchanged last capture; core still refuses an unmet changed-region
expectation. This mechanism does not prove a semantic goal or wait indefinitely.

Human/shared control, missing program custody, an unsupported surface, an unknown
visual observation, planner refusal, stale pixels, and failed settlement refuse.
The program lane does not use browser URLs, browser AX, or browser egress witnesses.

Supported host-xpra and legacy host-exec admission uses the existing private
`human-bindings/SURFACE_ID.json` witness with schema
`metaviewer.human_binding/v0.3`. Despite its historical name, the producer exports
it for these agent programs. The exact profile, public surface, agent role, ready
state, native container and run identifier must agree. Host-xpra additionally
requires the true host flag and its derived private-display run identifier. A
foreign, browser, malformed or missing witness refuses; loss of an admitted host
witness cannot select a legacy container. Host-xpra never consults Docker;
legacy host-exec also matches the native receipt's run before using its existing
identity/container checks.

Public observed and retained frames use the real publisher's private
`frames-<random>/<random-hex>.rgb` RAM allocations. These are different from the
native run/window capture paths: the publisher validates the native container,
run and window before producing the authenticated surface-bound `FrameRef`.
The command checks that public surface binding, canonical private publisher path,
owner/modes and retained RGB digest; it does not infer native custody from a raw
filename. Binding dimensions describe initial allocation; current
actions use the genuine frame geometry and require unchanged geometry while
rebinding a decision. Core owns the actual native XID/witness checks. The agent
requires the validated core tool-result projection for host input settlement;
it does not synthesize a native window identifier stripped by that projection.

Host-window admission: **ABSENT — do not invent**. At this base,
`attachHostWindow` retains its XID/witness internally and `PublishHumanBinding`
does not export a host-window witness. A profile name, display, active surface or
unrelated container is insufficient proof. A reviewed producer route is needed
before this lane can admit an arbitrary host window. Browser, VM and interface
integration remain outside this change.

Builtin legacy programs without an exported adapter witness are also unsupported
by this candidate. This intentionally narrows the older profile-plus-lease-only
admission: that broader proof cannot distinguish another public native transport
when an unrelated old lease coexists. The previously accepted legacy Mines
baseline remains historical evidence; it is not a new acceptance claim for these
unexported builtins. The existing producer is unchanged. Only host-xpra and legacy
host-exec programs with actual exported custody are candidates for new live checks.

The existing Wender bridge only admits custody-bound clicks. It cannot currently
plan and deliver a text-editing step in gedit. Wender's model client can emit text
actions, but connecting that interface requires a reviewed focus/custody bridge;
this lane does not bypass the restriction. Admitted text/key custody and semantic
text verification for this program path: **ABSENT — do not invent**. Native
window focus alone does not establish focused-editor custody, and the current
program receipt path supplies RGB evidence rather than the semantic text witness
required by `text_present`. Pixel changes cannot certify intended editor text.

If a newer same-surface publication changes after planning, the final rebind
retains and authenticates both RGB frames and compares every RGB byte inside
the complete selected target box. The original perception table must uniquely
ground its role, name and box. No second perception or model call occurs: exact
target pixels and unchanged surface/geometry bind the existing decision to the
new frame. Off-target clock or cursor updates are allowed; any target pixel
change refuses before constructing a proposal. Identity is grounded in the
original table, not claimed to have been independently perceived again.

After requesting a real publication, the single client owner drains authenticated
frame events until readiness is empty, then selects the highest generation from
the observation and client cache. This covers buffered lines as well as ready
socket data. A publication racing submission can still cause core `STALE_FRAME`;
only that explicit nonexecution retries the cheap rebind, at most twice [TARGET],
under the original absolute deadline, without perception or model calls. No
unknown dispatch or settlement can retry. Changed target pixels after a stale
refusal stop the decision. The report records `frame_rebinds`: `elapsed_us`
includes frame acquisition/draining and `rgb_check_us` measures authentication,
retention and comparison. Both are host monotonic measurements [MEASURED].
Unsubmitted observation refusals preserve previous verified moves as partial
evidence. A delivered click with an unmet changed-region expectation retains
the honest `INPUT_UNCERTAIN` / rc 5 outcome.

Muse replies rejected by ModelClient action validation or unique mark mapping
send no input. The runner requests another decision within the existing shared
attempt bound (at most two additional attempts [TARGET]) and absolute deadline.
Each rejection appears in report `attempts` with its original
`MW_PROGRAM_MODEL_FAILED` or `MW_PROGRAM_MODEL_TARGET` code, model evidence,
`submitted:false` and `refused_before_dispatch`. Exhaustion returns refusal
(rc 6 [TARGET]), preserving earlier verified moves; those moves alone do not
make this model refusal `INPUT_UNCERTAIN`. Unknown dispatch, failed settlement,
and delivery evidence still retain `INPUT_UNCERTAIN` (rc 5 [TARGET]) and never
permit model recovery. Provider/transport failures are not validation retries.

`MW_PROGRAM_CONTROL` means the capsule is under human control: press Release
on the tile, then run again. The runner never releases control itself.

While the external model runs, the same actor maintains the authenticated session
with an existing read-only observe call. The internal interval is shorter than
the pinned core idle deadline; each RPC is capped by the remaining model budget.
The first observation is due immediately, before delivering the provider request,
because prior perception and preparation may already have consumed idle time.
The timer is serviced inside frame-drain batches as well as provider waits, with
no background reader. This narrow maintenance path validates the bound surface
and frame but performs no surface discovery or native commands. Its latest frame
and any failure are diagnostic only: the original model observation/table remains
unchanged, and full ownership plus rebind still gate every proposal. A failed
heartbeat aborts and cleans up the recorded provider group; it does not reconnect,
restart a decision, retry input or extend the absolute deadline.

Focused checks:

```sh
python3 -m unittest discover -s tools -p 'test_mw_*program*.py'
python3 -m unittest discover -s tests -p test_mw_run_backend.py
python3 -m unittest discover -s agents/tests -p test_mw_run.py
```

The pinned integration checks require the dependency roots above; missing roots
fail rather than silently skip. Run host checks inside the operator's required
resource scope. Live acceptance additionally requires recorded program actions
through the real vision, planner and core chain.

Fresh-binding measurements [MEASURED]: the supplied `mines_2030_3.json`, `_2`
and `_1` reports contain nine stale refusals among eleven proposal submissions.
Their second-perception diagnostics show approximately 56–65 ms latency, rather
than a perception longer than the clock tick. Observed-to-submitted generation
gaps span 12–41; the reports do not establish the exact latest core generation at
each refusal. The implementation therefore removes the extra perception and
drains the pending client publications instead of assuming perception duration
alone explains the race. An offline synthetic 1280×900 RGB fixture with a 100×99
target measured retention, authentication and comparison over twenty calls:
10.102 ms minimum, 11.227 ms median, 14.068 ms maximum [MEASURED]. This excludes
publication acquisition, custody discovery and dispatch; runtime `frame_rebinds`
provide acquisition and comparison timings for subsequent operator runs.
