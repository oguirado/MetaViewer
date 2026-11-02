# Native program actions

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
verified native receipt. Changed pixels before submission require a new invocation;
the lane never replays old coordinates against a changed image.

Success means `PROGRAM_BOUNDED_ACTIONS_VERIFIED`, not task or game completion.
The existing `metaviewer.mw_run/v1` output identifies `moves.json` and `report.json`.
The report retains visual observations, element tables, planner targets, frame
bindings, pending dispatch state, core receipts and immutable RGB frame artifacts.
Inspect pending dispatch evidence before considering another attempt after failure.
The frozen frame-subscription request has no success acknowledgement. The core's
real observation and proposal admission remain authoritative. Before dispatch,
repeat subscribe asks the existing shared poller to publish a new real capture,
including unchanged pixels; the lane waits for that actual newer generation and
proves identical pixels, geometry and surface before using the existing plan.
One actor drains authenticated frame events during provider pipe I/O; there is
no competing background reader. The lane never automatically unsubscribes the
global surface poller or cancels other readers; explicit surface lifecycle stop
owns that cleanup. Only explicit core `STALE_FRAME` nonexecution permits bounded
fresh perception/replanning. Unknown delivery or settlement returns
`INPUT_UNCERTAIN` and is never automatically retried.

Private atomic `intent-*.json` and `dispatch-*.json` records are synced before
core submission, including the exact proposal identifier and rebound frame.
An atomic `receipt-*.json` follows verified settlement. These survive an interrupted
final report. An output failure after verified delivery also returns `INPUT_UNCERTAIN`.

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
