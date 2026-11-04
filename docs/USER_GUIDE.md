# MetaViewer User Guide

MetaViewer shows running application capsules in a desktop wall. A capsule is the
application view you select, observe and control. The current release is
`0.2.6` [CITED: [VERSION](../VERSION)]. Host programs and attached desktop
windows run on your computer and are not isolated.

Start with [installation](INSTALL.md), then use this guide for everyday operation.
For an AI at the controls, continue to [the agent entry guide](AGENT_ENTRY.md).
This manual describes public code; it does not certify a live run on your host.

## How do I install and launch MetaViewer?

Use the [judge quickstart](JUDGE_QUICKSTART.md) for the evaluation package, or
[INSTALL.md](INSTALL.md) for a source build and host setup.

Answers: install; launch; prerequisites; Linux; source build

The judge launcher provides `doctor`, `install`, `run` and `stop`. Run the doctor
for your chosen setup before launching. A refusal names the failed prerequisite
and its remedy; follow [judge troubleshooting](JUDGE_TROUBLESHOOTING.md) if it
persists. Do not substitute a development launch command for missing runtime
configuration. Source: [judge launcher](../scripts/judge/metaviewer-judge.sh).

The evaluation terms for supplied external components are in
[NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md).

## Where are the main controls?

Select a capsule in the left working tree to bring its desktop and tile into view.
The center is the capsule wall; the terminal dock is on the right.

Answers: window layout; navigation; desktop; terminal; settings

| Control | What to use it for |
| --- | --- |
| Working tree | Select Humans, Agents, desktops and capsules |
| Add capsule | Choose a capsule kind or an installed host application |
| Capsule header and menu | Control, recording, screenshot, identity and capsule actions |
| Terminal dock | Open a shell or an installed agent CLI paired with a capsule |
| Settings | Appearance, frame-rate preferences and capture export folders |
| Status bar and activity | Check core connectivity and recent outcomes |

Source: [App.vue](../ui/src/App.vue). A disconnected core or refused request is
not evidence that an operation completed. Check the capsule's resulting state.

### How do I rename, move or stop a capsule?

Use the working tree to rename a desktop or capsule, and the capsule menu to
move it to another desktop or stop it.

Answers: rename; F2; move to desktop; Stop capsule; detach a window

Double-click the name, or focus it and press F2. Enter saves and Escape cancels.
Names change the displayed label; they do not change the capsule's identity.
The capsule menu offers **Move** and **Move and go**, including a new desktop.
Sources: [App.vue](../ui/src/App.vue),
[DesktopWorkspace.vue](../ui/src/wall/DesktopWorkspace.vue),
[RoleSurface.vue](../ui/src/surfaces/RoleSurface.vue).

**Stop capsule** requests lifecycle cleanup. For an attached desktop window,
**Stop** detaches the window from MetaViewer. A lost window may instead offer
**Close tile**, which removes its presentation. Read the resulting status;
removing a tile is not proof that an application stopped.
Source: `lifecycle`, `detachHostWindow` and `closeLostHostWindow` in
[RoleSurface.vue](../ui/src/surfaces/RoleSurface.vue).

## How do I open a capsule?

Choose **Add capsule**, select the kind, and complete the kind's selection dialog.
Browser identities require an available profile; programs require an executable.

Answers: add capsule; identity browser; program; Host program; Desktop window; VM

| Kind | What you select | Important boundary |
| --- | --- | --- |
| Identity browser (`identity-browser`) | An identity and Human or Agent role | Use Identities to inspect or provision the profile |
| Program (`program`) | A binary and role | The executable must exist in its configured capsule environment |
| Host program (`host-program`) | An installed app or binary and role | Runs on your computer; not isolated |
| Desktop window (`desktop-window`) | An available desktop window | Attaches an existing X11 window; not isolated; native Wayland windows are not listed |
| ARM64 Linux VM | An available configured VM | Requires supported host capabilities and verified local assets |
| MicroVM — ARM64 | An available guest console | Requires supported host capabilities and verified local assets |

Sources: [catalog model](../ui/src/catalog/catalogModel.js),
[launcher](../ui/src/catalog/CatalogLauncher.vue).

Recent and installed application entries launch Host programs. If a browser
identity is unavailable, inspect **Identities** and the refusal rather than
creating a duplicate. ARM64 guest setup is a
[developer procedure](ARM64_CAPSULE_SETUP.md), not a substitute for the judge
installation. A missing capability leaves the guest choice unavailable.

## How do I take control and return it to an agent?

Use **Take control** on an Agent capsule, wait for the grant, then click its
canvas to type or point. Use **Release** when the agent may continue.

Answers: take control; release; human input; WRITE; Escape; change role

Taking control arms input only for the selected capsule. The host still checks
ownership on every batch. Pressing Escape releases canvas focus locally; it does
not hand ownership back to the agent. A refused release leaves human ownership
in place. Sources: `applyWallControl`, `onCanvasEscape` and `onCanvasFocus` in
[App.vue](../ui/src/App.vue), and [input port](../ui/src/input/inputPort.js).

Changing a capsule's **Human/Agent role** is separate from temporarily taking
control. Native identity capsules use an acknowledged role transfer. Host
programs use a stop-and-reopen path, so save application work before changing
their role. Attached desktop windows do not support that role switch.
Source: `switchMode` in [roleHost.js](../ui/electron/roleHost.js).

**Agent ready** means agent-owned and idle. **Agent acting** requires action
activity in the authoritative state. Ownership alone is not proof of movement.
Source: [SurfacePanel.vue](../ui/src/wall/SurfacePanel.vue).

## How do I manage identities and login?

Open **Identities** to add, inspect or delete an identity. Use **Log in** where
available, or open its Human view, to perform the site's required human login.

Answers: identities; accounts; login; previous-session reservation; delete identity

Use distinct identity names for separate saved browser sessions. If a previous
session holds an identity, **Release** requests verified cleanup; it does not
stop a live session. Deleting an identity asks for confirmation because it also
removes its saved browser session. Source:
[IdentitiesDialog.vue](../ui/src/identities/IdentitiesDialog.vue).

Authentication history is not proof that a site is currently signed in. Inspect
the live page before handing the capsule to an agent. Do not store credentials
in workflow prompts or public reports.

### Stored-data slots

Use **Stored data** to save or restore an identity's browser data after stopping
its capsule and closing its login view.

Answers: save browser data; restore a slot; copy identity; delete saved slot

| Action | Effect |
| --- | --- |
| Save | Creates a named saved slot |
| Overwrite | Replaces the selected saved slot |
| Load | Replaces the identity's stored data; identity metadata and allowed sites stay unchanged |
| Copy to a new capsule | Copies the saved data into a new identity |
| Delete slot | Removes the saved slot |
| Refresh slots | Reloads the list |

Slots contain stored data, not open tabs. Signed-in sessions travel with the
data; read the confirmation before continuing. Keep MetaViewer open until the
operation finishes. If verification requires recovery, close and reopen the app
before retrying. Failed verification retains the saved data for recovery.
Source: [StoredDataSlots.vue](../ui/src/identities/StoredDataSlots.vue).

## How do I choose the capsule's network policy?

Open the capsule's **Network** dialog, select a supported mode, and choose
**Save network**. Changes apply on the next start.

Answers: network; Open; dedicated proxy; allowlist; legacy; NET_OPEN_PREREQ

| Mode or status | Meaning |
| --- | --- |
| Open (default) | Requests the explicit Open policy; deployment prerequisites must be satisfied |
| Dedicated proxy with allowlist | Requests proxy enforcement for exact hostnames; the installed backend must support it |
| legacy | No network mode is enforced; the capsule keeps its unrestricted legacy network |

Do not read `legacy` as proof that access to the host or LAN is blocked. A saved
allowlist also does not prove enforcement: unsupported proxied mode refuses the
next start. Inspect the effective status and refusal, then use
[network installation guidance](INSTALL.md#capsule-network).
Sources: [NetworkPanel.vue](../ui/src/netmode/NetworkPanel.vue),
[networkCopy.js](../ui/src/netmode/networkCopy.js).

## How do I give a task to an agent CLI?

Open the capsule's paired terminal, launch an installed agent profile, and use
**Direct task**, **Create automation** or **Run automation** to prepare its prompt.

Answers: paired terminal; launch agent; Direct task; Create automation; Run automation

Pairing a terminal does not launch an agent. **New terminal** offers the available
profiles and **Custom CLI**. The workflow action supplies capsule context; add
your request after `Task: ` and review it before submitting.

A ready paired agent can receive the prepared text without automatic submission.
Without a suitable pair, the action copies text to the clipboard. A missing,
exited or unready agent is not a successful launch. A package without terminal
support reports `TERMINAL_UNAVAILABLE`; see [debugging](DEBUG.md).
Sources: [TerminalDeckView.vue](../ui/src/terminal/TerminalDeckView.vue),
[workflowPrompts.js](../ui/src/terminal/workflowPrompts.js),
[terminalHost.js](../ui/electron/terminalHost.js).

The [agent entry guide](AGENT_ENTRY.md) supplies the live attachment and bounded
observe–act–verify procedure. The agent must inspect the result after input;
successful delivery alone does not prove the requested task finished.

### What happens when a task needs a person?

The run stops for login, CAPTCHA or a bot check; use the handoff notice to take
control and perform the required human step yourself.

Answers: human handoff; login wall; CAPTCHA; acknowledge; resume

After taking control succeeds, click the capsule to interact. Release control
when ready and explicitly re-run the workflow. **Acknowledge** dismisses the
notice only after its acknowledgement is saved; it does not resume or retry the
run. Sources: [handoff model](../ui/src/handoff/handoffModel.js),
[HandoffNotice.vue](../ui/src/handoff/HandoffNotice.vue).

## How do I record, take a screenshot and export it?

Use **Record** and **Screenshot** in the capsule header. Open **Recordings and
screenshots** from its menu to inspect captured items and export controls.

Answers: capture; Record; Screenshot; recording list; export; RAM; save to disk

Capture starts in RAM. Stop a recording and wait for it to become sealed before
exporting. Export produces an archive of PNG frames, not a finished video file.
Sources: [TileCaptureChrome.vue](../ui/src/wall/TileCaptureChrome.vue),
[recording panel](../ui/src/recording/MvRecordingPanel.vue),
[export implementation](../core/src/record/capture/export.rs).

In **Settings → Recording**, choose export folders and either **Keep in RAM until
I export** or **Save to disk when recording stops**. Recording-folder changes
apply at the next app start; a host environment setting takes priority.
Screenshot-folder changes apply immediately. Automatic saving waits for an active
folder, and a failed export leaves the RAM capture available.
Source: [MvSettingsPanel.vue](../ui/src/settings/MvSettingsPanel.vue).

The requested recording rate is an upper bound: it cannot create frames that the
source did not deliver. Missing frames, capture limits or an unavailable host
produce refusals. Read the result before retrying. Sources:
[capture state](../core/src/record/capture.rs),
[recording model](../ui/src/recording/recordingModel.js).

### More than one capsule

Use **Add capsule** for each additional available profile and select its tile
from the working tree. A new capsule must pass host RAM admission.

Answers: multiple capsules; RAM admission; parallel work; lost capsule

There is no capacity promise for your host in this guide. Unknown memory state
refuses admission; failed admission does not evict sibling capsules. If cleanup
is uncertain, preserve the refusal and follow the
[RAM admission procedure](INSTALL.md#concurrent-identities-and-ram-admission).
Sources: [RAM admission tool](../tools/mv_ram_admission.py),
[profile picker](../ui/electron/profilePicker.js).

### What does a configured multi-profile example look like?

The following `MV_SRF_PROFILES` fixture shows separate browser profiles sharing
a RAM root while using distinct displays. It is a developer configuration
example, not a command that provisions identities or promises host capacity.

Answers: MV_SRF_PROFILES; profile JSON; shared RAM root; distinct displays

All profile identifiers, display numbers and dimensions in this block are
[CITED: [profiles_doc_test.go](../daemon-adapter/internal/daemon/profiles_doc_test.go)].
The test parses this exact shape and rejects a missing width or a renamed input
field. Before live use, follow [host setup](INSTALL.md) and verify the chosen RAM
root and displays; do not assume this fixture describes your machine.

```json
{
  "mv-live-1": {
    "Kind": "browser", "NativeKind": "browser",
    "RAMRoot": "/dev/shm/vqa-ramws/opensuperficies/os-cu-0",
    "Display": ":100", "Width": 1280, "Height": 900, "text_input": "paste"
  },
  "mv-live-2": {
    "Kind": "browser", "NativeKind": "browser",
    "RAMRoot": "/dev/shm/vqa-ramws/opensuperficies/os-cu-0",
    "Display": ":101", "Width": 1280, "Height": 900, "text_input": "paste"
  },
  "mv-live-3": {
    "Kind": "browser", "NativeKind": "browser",
    "RAMRoot": "/dev/shm/vqa-ramws/opensuperficies/os-cu-0",
    "Display": ":102", "Width": 1280, "Height": 900, "text_input": "paste"
  },
  "mv-live-4": {
    "Kind": "browser", "NativeKind": "browser",
    "RAMRoot": "/dev/shm/vqa-ramws/opensuperficies/os-cu-0",
    "Display": ":103", "Width": 1280, "Height": 900, "text_input": "paste"
  }
}
```

## 7. Replay of a session journal (`mv-replay`)

Use `mv-replay` to verify a preserved session journal and its witnesses offline.
Replay validates history; it does not restart applications or reproduce a desktop.

Answers: replay; verify journal; witness root; state hash

The journal is under `$XDG_STATE_HOME/metaviewer/sessions/<session-id>/`, or
`$HOME/.local/state/metaviewer/sessions/<session-id>/` when the state variable is
unset. From a built source checkout, replace the placeholders with absolute real
paths to the same preserved session:

```sh
./target/debug/mv-replay --journal /absolute/state/sessions/SESSION/journal.jsonl \
  --witness-root /absolute/state/sessions/SESSION
```

These are placeholders, not directories to create for a live session. Add
`--verify-only` to omit the reconstructed state hash. A successful exit is
`0` [CITED: [mv-replay.rs](../core/src/bin/mv-replay.rs)]. For the path, ownership,
mode and failure rules, see [replay troubleshooting](DEBUG.md#replay-a-journal-with-mv-replay).
Sources: `default_state_dir` in [journal module](../core/src/journal/mod.rs),
[mv-replay.rs](../core/src/bin/mv-replay.rs).

## What happens when the session journal fills?

The core closes admission, stops capsules in order and preserves the accepted
journal for replay. Start a fresh session through the normal application entry.

Answers: JOURNAL_FULL; session ended; lost tiles; cleanup; new session

Frozen frames are not proof of live capsules. If cleanup remains unconfirmed,
close MetaViewer and use operating-system controls to stop remaining capsules
before reopening. The session end marker is best-effort evidence; its absence
does not prove that the session is live. See [full session journals](JOURNAL_END.md).
Source: [journal_end.rs](../core/src/serve/journal_end.rs).

## What is unavailable or limited?

Treat the following as product boundaries or deployment requirements, not tasks
that an agent can bypass.

Answers: known limits; unavailable features; guest setup; private components

| Feature | Status | Next step |
| --- | --- | --- |
| Host program and Desktop window containment | Not isolated | Choose the kind with that boundary in mind |
| ARM64 guests | Conditional on host support and local assets | Follow [guest setup](ARM64_CAPSULE_SETUP.md) |
| Storyboard | No live navigation entry | Do not infer availability from retained source or fixtures |
| Demo-authoring dialog | No live navigation entry | Use the scoped [developer procedure](AUTOMATE_FROM_DEMO.md) |
| Terminal CLI profiles | Depend on installed executable and supported host setup | Check the terminal's error and [debug guide](DEBUG.md) |
| Private external components | Source is not published here | Read [evaluation terms](../NOTICE-EVALUATION.md) |

Sources: [App.vue](../ui/src/App.vue), [catalog model](../ui/src/catalog/catalogModel.js),
[agent profile discovery](../ui/electron/agentProviders.js).

For a failed operation, start with [DEBUG.md](DEBUG.md). For exact refusal codes,
use the generated [error reference](ERRORS.md). For verification scope, read
[TESTING.md](TESTING.md) and [EVIDENCE.md](EVIDENCE.md).
