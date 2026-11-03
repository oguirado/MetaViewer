# Judge tour: MetaViewer after installation

For refusal codes and source-backed next steps, see [Judge troubleshooting](JUDGE_TROUBLESHOOTING.md).

Use this tour with your AI after completing [Judge Quickstart](JUDGE_QUICKSTART.md).
Commands run from the MetaViewer checkout or the installed public operator tree
supplied by **Use MetaViewer**; judge launcher commands run from the kit root.
Use a graphical Linux session (WSLg for the verified Windows/WSL2 setup).

Verification status below is a snapshot for this tour. **Verified** means that specific live flow was
observed; **Available, unverified** means code exists without a supplied live
result on that architecture. Do not treat a parser test as live verification.

**x64 browser automation: verified on local pages through the kit with the rules planner: goal, typing, exact read back, and a login wall stop.**

## Open the wall

**Shows:** the installed application and its connection to the core.

```bash
bash scripts/judge/metaviewer-judge.sh doctor --capsules
bash scripts/judge/metaviewer-judge.sh run
```

**Success:** doctor prints `JUDGE_DOCTOR_OK tier=T2`; the wall opens and reports
**Core connected**. **If refused:** use the printed `JUDGE_<CODE>` fix and repeat
doctor; app-only installation cannot start live capsules. Do not dismiss a
missing image, display or Docker requirement.

**Architecture:** x64 — T2 install verified with the kit on WSL2;
arm64 — live wall used for the verified flows below.

## Browser capsule as Human and Agent

**Shows:** separate browser identities and human/agent roles.
Click **＋ Add capsule → Identity browser**, click **Create Capsule**, then
choose **Role → Human**, an available **Identity**, and **Open capsule**.
Use the tile's URL input and **Go** to visit a permitted page. Repeat with
**Role → Agent** and another available identity. Use the Agent tile's **⋮ →
Watch read-only** to watch it if its stream is hidden. Human input is interactive;
an Agent tile is read-only until you take control. After logging in yourself,
**⋮ → Mark as logged in** records that fact; **⋮ → Switch to agent mode**
changes the role. Marking login alone does not change the role.

**Success:** both tiles show browser frames and their role badges; clicking a
Human page works. Watching an Agent does not give human input authority.
**If refused:** select a free identity and inspect the dialog/activity reason.
On x64, public internet is unavailable without compatible Open network mode;
legacy networking grants no public destinations. A live tile alone does not
prove internet access. Use an already permitted page or ask the installer for
an Open-ready kit; do not bypass policy.

**Architecture:** x64 — Human and Agent tiles verified with the kit on WSL2;
arm64 — Human and Agent browser flows verified.

## Views and desktops

**Shows:** organization of running capsules. Click **Humans** or **Agents**;
use **Ctrl+Tab** to switch views. Click the desktop **+** to create a desktop,
then a desktop pill to select it. In a tile's **⋮ → Move to desktop**, choose
**Move and go** for the destination. Click **2 side by side** in the layout
preset bar to compare visible tiles, or **1 tile** to focus a tile.

**Success:** the selected view/desktop and arrangement change; moving a tile
does not start a new capsule. **If refused:** inspect the activity message and
confirm that the destination desktop exists and the capsule is still live.

**Architecture:** x64 — available, unverified as a separate flow;
arm64 — views verified; desktop operations available, separately unverified.

## Take control and Release

**Shows:** human interruption of an Agent capsule. On its tile click **⋮ →
Take control (emergency)** (or **Control** in the tile header). Wait for
**Interactive**, click the tile, and use it. Click **Release** in the input strip
(**Release to agent** for a Desktop window) to return control.

**Success:** agent actions pause while you control the surface; after release,
the tile returns to watching and fresh observations are required before new input.
**If refused:** wait for the authoritative control update; inspect the activity
reason. Never issue agent input while human control is active or reuse an old
planned action after taking control.

**Architecture:** x64 and arm64 — available; independent live handoff verification
is not documented here.

## Program capsule

**Shows:** a Linux GUI program in a container, separate from your desktop.
Click **＋ Add capsule → Program**, click **Create Capsule**, choose
**Role → Human**, enter `gnome-calculator` in **Binary name**, then **Start**.
Repeat with **Agent** when you want automation.

**Success:** a calculator frame appears with the chosen role; a Human tile accepts
clicks. **If refused:** inspect the missing binary, image or resource message.
Use a GUI binary installed on the host and the required program image. Do not
substitute Host program without reviewing its different isolation boundary.

**Architecture:** x64 — dialog verified; the binary is looked up on your computer,
so without `gnome-calculator` installed it refuses with
`host_program_unavailable: gnome-calculator: not found in PATH` (`sudo apt-get install -y gnome-calculator`);
launch with the binary present is not verified live on x64; arm64 — calculator
automation verified, standalone Program launch is not separately attested.

## Host program and Desktop window

**Shows:** host-backed applications. **These run on your computer and are not
isolated.** Their access and signed-in sessions are real host access.

For **Host program**, choose **＋ Add capsule → Host program**, confirm the
selection, choose a role, enter an installed GUI **Binary name**, and **Start**.
This requires `xpra`. Browser launches use a fresh temporary profile in RAM,
not your personal browser profile.

For **Desktop window**, first open a harmless X11 window yourself. Choose
**＋ Add capsule → Desktop window**, click **Create Capsule**, filter **Search open
windows**, select its row, then **Add**. Acting on it can raise the real window
and move the real pointer; avoid competing desktop input while the AI acts.

**Success:** the tile shows the host isolation warning and live window contents.
Desktop window **⋮ → Stop capsule** detaches it without closing the original
window. **If refused:** Host program needs `xpra`; have it installed before
retrying. For Desktop window, select an existing X11 window; native Wayland
windows are unsupported. Do not assume an empty list means permission to capture
another display.

**Architecture:** x64 — both available, unverified live; arm64 — both verified.

## Terminal and the prompt buttons

**Shows:** a terminal for your AI and prompts for distinct tasks. Open **More ▾ →
Terminal**. Use **🚀 Bootstrap** or **Use MetaViewer** to copy the public entry
prompt, then paste it into your chosen AI. Use the terminal's task buttons:

| Button | What to ask your AI to do | Success evidence |
| --- | --- | --- |
| Automate | Create a reviewed workflow from a demonstration | Reviewed workflow and its checks, before use |
| Use automation | Select and run a stored workflow | Run report and verified outcome |
| No automation | Operate an observed goal without storing a workflow | Fresh observation and bounded action receipts |

These buttons copy prompts; copying does not execute a goal. Use the capsule
**ID** / **Copy ID for AI** and the app's **Copy env path** to identify the actual
running capsule. Never put credentials in prompts.

**If refused:** inspect clipboard/terminal feedback; `TERMINAL_UNAVAILABLE` means
the terminal is unavailable in this build. Use an external terminal with the
same attachment. A copied prompt is not proof that an AI CLI is installed.

**Architecture:** x64 and arm64 — available, no separate live result supplied.

## Prepare commands for your AI

Replace the attachment placeholder with **Copy env path** from the running app.
Run this setup in a dedicated shell; it changes that shell's runtime environment.
The directory created below is private temporary RAM evidence, not durable storage.

```bash
export METAVIEWER_ATTACH='<copied-current.env-path>'
set -a
. "$METAVIEWER_ATTACH"
set +a
export XDG_STATE_HOME="$(mktemp -d /dev/shm/metaviewer-tour.XXXXXX)"
```

The attachment supplies the core and native bindings. Checkout dependencies must
match `deps.lock`; use the roots supplied by the app/operator. **If refused:**
recopy a current attachment; never guess missing paths. Inspect report/receipt
files before shutdown. `--planner rules` needs no account; `--planner muse` needs
Muse Code installed and authenticated and sends observations to that provider.
Both need the verified runtime dependencies.

## Automate a browser goal

**Shows:** bounded action planning against an existing Agent browser. After the
setup, replace the identity and goal with the copied profile and a unique exact
visible accessibility control name from a fresh observation:

```bash
PYTHONPATH=agents python3 -m metaviewer_agents.mw_run \
  --surface-kind browser --identity '<browser-profile>' --planner rules \
  --goal 'Exact visible control name' --steps 1
```

The action budget above is one click.
Choose `--planner muse` in the same command to use Muse Code.
**Success:** `BROWSER_BOUNDED_ACTIONS_VERIFIED` plus a fresh observed effect and
receipts. A verified action does not certify the whole goal.
**If refused:** release human control, inspect the named precondition, and observe
again. `MW_COMPILED_BROWSER_UNAVAILABLE` means this compiled runtime lacks browser
automation; use a verified checkout matching the lock or wait for a compatible
build. Rules does not remove that limitation. Never automatically retry
`INPUT_UNCERTAIN`; delivery may already have happened.

**Architecture:** x64 — verified on a local page with the rules planner; arm64 — browser goal with
Muse verified.

## Automate a program: calculator

**Shows:** verified GUI actions on a running Agent calculator. Start an Agent
calculator through Program or Host program as appropriate; the latter remains
unisolated and needs xpra. Copy its identity and prepare the attachment above.
Clear it manually if necessary, then release control and observe its actual
button names. For each next button, use its unique observed name:

```bash
PYTHONPATH=agents python3 -m metaviewer_agents.mw_run \
  --surface-kind program --identity '<calculator-profile>' --planner muse \
  --goal 'Exact observed calculator button name' --steps 1
```

Repeat after a fresh observation for **7 → + → 8 → =**; expected display **15**. Button names depend on the calculator;
do not pass the whole arithmetic expression as an invented control name.

**Success:** each run reports `PROGRAM_BOUNDED_ACTIONS_VERIFIED` with receipts;
you separately inspect the final display. **If refused:** check Agent ownership,
unique observed target, attachment and dependency pins. Without Muse Code use
`--planner rules` for an exact observed button; that does not inherit the Muse
live verification. A visible effect is not proof of arithmetic correctness.

**Architecture:** x64 — available, unverified live; arm64 — calculator 7+8 by Muse
verified.

## Text in a program

**Shows:** explicit operator text with readback. Open a harmless editor, take
control, focus its text field, then release control. Only when you can assert
that the field is focused, run after the same attachment setup:

```bash
PYTHONPATH=agents python3 -m metaviewer_agents.mw_run \
  --surface-kind program --identity '<editor-profile>' --planner rules \
  --goal focused --text 'Judge tour sample' --steps 1
```

**Success:** inspect `text_readback: exact` and the editor. If OCR cannot read it,
`PROGRAM_TEXT_UNCERTIFIED_NOT_READABLE` is explicitly uncertified even with a
successful process exit. `mismatch` refuses. **If refused:** inspect partial
action evidence before a new attempt; do not blindly type again. Use a named
observed field instead of `focused` if focus is not established. Known password
fields refuse; do not use this flow for secrets. Program `--key` is unsupported.

**Architecture:** arm64 — typed into gedit and read back once with OCR, not always exact; x64 — not verified live;

## Wall stop: login or CAPTCHA

**Shows:** automation stopping at an observed login, CAPTCHA or bot-check wall.
On an authorized local test page that presents such a wall, ask the AI to observe
and use the browser-goal flow. Do not seek a public challenge to bypass.

**Success:** `HUMAN_HANDOFF` stops automated input. Take control, handle the wall
yourself, release, and require a fresh observation and a new goal.
**If it refuses:** retain the report; missing observation or runtime support is
not evidence of a successful wall test. If delivery is uncertain, stop and
inspect receipts rather than retrying.

**Architecture:** x64 — verified on a local page; arm64 — wall
stop verified on local pages only.

## Screenshot and Record

**Shows:** capture of a live capsule. In the strip above its tile, click
**Screenshot**. Click **Record**, interact with harmless content, then **Stop**
in the same strip. Inspect the capture badge for the sealed state. Capture
stays in RAM; it does not save a video to your downloads. The recording panel
implementation also has screenshot/recording rows and an export control gated
on a configured destination, but a normal wall click route to that panel is
not documented here in this checkout. Inspect frames before sharing them.

**Success:** the screenshot control reads **Captured**, or the recording badge
reads **Sealed**. Detailed rows and frame/drop information belong to the
recording panel when available.
**If refused:** inspect the disabled control’s reason and activity feedback;
ensure a live surface or stop another recording for a budget refusal. The
recording panel has more detailed refusal messages when it is available.
Nested display capture is unavailable. Recording is evidence capture;
it does not itself create a stored automation.

**Architecture:** x64 and arm64 — available, not verified live separately.

## Stop and clean up

**Shows:** explicit lifecycle cleanup. Stop recording and inspect temporary
reports first. Use each tile's **⋮ → Stop capsule**; closing a tile with **✕**
only hides its presentation and can leave the capsule running. Desktop window
stop detaches the original host window. Then run from the kit root:

```bash
bash scripts/judge/metaviewer-judge.sh stop
```

**Success:** `JUDGE_STOP_CLEAN`; the app and scoped capsules stop. The shared
`srf-egress-proxy` intentionally remains running and is excluded from that check.
**If refused:** preserve the exact leftover socket/capsule/RAM diagnostic and
review it with the operator; do not remove unrelated host resources.

**Architecture:** x64 — stop verified with the kit on WSL2; arm64 — stop command
available, separate cleanup verification not documented here.

## Architecture support at this snapshot

| Flow / limitation | Linux x64 | Linux arm64 |
| --- | --- | --- |
| T2 kit installation | Verified on WSL2 | Live environment used; kit install not separately attested |
| Browser Human and Agent | Verified | Verified |
| Views | Available, unverified separately | Verified |
| Desktops and control handoff | Take control and Release verified by clicks on WSL2; desktops unverified separately | Take control and Release verified |
| Program capsule | Needs the binary on your computer; refusal verified, launch unverified | Calculator verified; launch route not separately attested |
| Host program | Requires xpra; unverified live | Verified; requires xpra |
| Desktop window | X11 only; unverified live | Verified; X11 only |
| Browser goals | Verified with rules, local page, after Take control and Release | Verified with Muse and rules, local page |
| Calculator 7+8 | Available, unverified live | Muse verified |
| Program text | Implemented; live verification absent | gedit typed; verdict certifies only when OCR reads it back |
| Wall stop | Verified on a local page | Verified on local pages |
| Terminal, prompt buttons, capture | Available; live verification absent | Available; live verification absent |
| Stop | Verified | Available; separate cleanup verification absent |
| Public internet without Open mode | Not available | Legacy policy grants no public destinations |
| VM capsules | Not verified live | Not verified live |

Sources: the live checks above and the linked code.
This tour's claims are limited to the supplied evaluation statements and this checkout.
