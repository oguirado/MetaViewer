# MetaViewer AI Operator Guide

Use this guide to navigate the UI, select a capsule and connect an external AI.
For the executable task protocol use [AGENT_ENTRY.md](AGENT_ENTRY.md); for
repeatable game, drawing and commentary sessions use the
[computer-use playbook](COMPUTER_USE_PLAYBOOK.md).

Answers: how do I operate the MetaViewer UI and attach my AI.

This guide describes the repository interfaces. Live verification is limited to
the architecture support table in [Judge tour](JUDGE_TOUR.md#architecture-support-at-this-snapshot).

**A finding tells you where to look. Only the code proves it.** Read the cited code
before repeating a claim; numbers carry [MEASURED], [CITED: path] or [TARGET], and
unknown facts read `ABSENT — do not invent`.

## 0. Reading map

Choose the document that matches the next operation.

Answers: where should an AI operator start.

| You want | Go to |
|---|---|
| Why an AI should drive MetaViewer, what was shown live, limits | [AI_AT_THE_CONTROLS.md](AI_AT_THE_CONTROLS.md) |
| Which agent CLIs the paired terminal can start | [AI_AT_THE_CONTROLS.md#2-which-agent-clis-work](AI_AT_THE_CONTROLS.md#2-which-agent-clis-work) |
| The exact prompts an attached AI follows | [AGENT_ENTRY.md](AGENT_ENTRY.md) |
| A first `mw_run`, expected output, refusals | [MW_RUN_FIRST_RUN.md](MW_RUN_FIRST_RUN.md) |
| Install and run | [Section 4](#4-installing-running-and-stopping-metaviewer-metaviewer-judgesh) |
| Capsule kinds | [Section 6](#6-adding-capsules-browser-program-and-desktop-window) |
| Roles and takeover | [Section 7](#7-human-and-agent-roles-hand-off-and-emergency-takeover) |
| Limits | [Section 13](#13-what-is-not-supported-honest-limitations) |
| Find code for a symptom | `python3 route/route_query.py any "<symptom>"`; read returned source coordinates before relying on a finding [CITED: route/README.md] |

---

## 1. What MetaViewer Is (and How to Explain It to a Person)

MetaViewer puts named live tasks on a shared desktop wall.

Answers: how do I explain MetaViewer to a judge.

The capsule kind selects
the execution boundary: a browser, a container program, a Host program, an
existing desktop window, or an available ARM64 guest. Host program runs as your
host user and is not isolated; a Desktop window is an existing real X11 window
[CITED: ui/src/catalog/catalogModel.js].

MetaViewer's source is `AGPL-3.0-only`. The external components are supplied under
[NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md); that notice defines their
compiled evaluation permission.

A Human-role capsule is for direct interaction. In an Agent-role capsule the
person watches, can take manual control, and can release it again. The program
runner rejects input without agent control [CITED: tools/mw_run_program.py].
Use [section 7](#7-human-and-agent-roles-hand-off-and-emergency-takeover) for the
controls, and [WHY_CAPSULES.md](WHY_CAPSULES.md) for their purpose.

---

## 2. Target Hardware and Tier Thresholds (Typical x64 / arm64 Linux Laptop)

Check the actual host with the installer before opening live capsules.

Answers: how do I check whether my host supports the required capsule tier.

App-shell readiness and capsule readiness are different; the installer reports the
specific unmet precondition [CITED: scripts/judge/metaviewer-judge.sh].

```bash
bash scripts/judge/metaviewer-judge.sh doctor --capsules
```

Requirements, storage thresholds and supported architectures are maintained in
[INSTALL.md](INSTALL.md). Live results are limited to the
[architecture support table](JUDGE_TOUR.md#architecture-support-at-this-snapshot).
An available catalog card is not proof that guest assets or every program are
installed. Do not infer support from the processor name alone.

---

## 3. Release Assets and Building Them Locally

Install matching verified release assets; local assembly is a maintainer operation.

Answers: which release assets should I use.

Use the release asset manifest and matching architecture described in
[INSTALL.md](INSTALL.md). The installer checks archive hashes before unpacking
[CITED: scripts/judge/metaviewer-judge.sh].

| Asset family | Purpose |
|---|---|
| `metaviewer-linux-<arch>.tar.gz` | App and operator resources |
| `node-linux-<arch>.tar.xz` | Runtime when a suitable host runtime is absent |
| `opensuperficies-linux-<arch>.tar.gz` | Compiled native capsule commands |
| `images-linux-<arch>.tar` | Images including `opensuperficies-identity-browser-<arch>` and `opensuperficies-program-host-<arch>` |
| `vision-engine.tar.gz`, `wender-agent.tar.gz` | Dependencies pinned by `deps.lock` |
| `SHA256SUMS` | Release asset hashes |

The maintainer can assemble assets with `tools/build_release_assets.py` from
already supplied artifacts [CITED: tools/build_release_assets.py]. This does not
grant access to private source or fetch unavailable components. See the
[release instructions](INSTALL.md) for the full command and provenance checks.

---

## 4. Installing, Running, and Stopping MetaViewer (`metaviewer-judge.sh`)

Use the installer lifecycle commands from the checkout.

Answers: how do I manage the app lifecycle.

Use the installer to check, install, start and stop the app. Run from the
repository containing the script [CITED: scripts/judge/metaviewer-judge.sh].

```bash
bash scripts/judge/metaviewer-judge.sh doctor --capsules
bash scripts/judge/metaviewer-judge.sh install --capsules
bash scripts/judge/metaviewer-judge.sh run
bash scripts/judge/metaviewer-judge.sh stop
```

For initial setup and download failures, follow [INSTALL.md](INSTALL.md).

### What `install --capsules` Does and When `sudo` Is Used

Install prepares the app and capsule dependencies; inspect its requested system
changes before accepting administrator commands.

Answers: what does capsule installation change.

The installer separates profile provisioning from administrator setup. Its
printed refusal or approval request names the action and remedy. Read the
[current installation procedure](INSTALL.md) before using unattended consent
or changing firewall settings [CITED: scripts/judge/metaviewer-judge.sh].

### Default Multi-Capsule Pool Launched by `run`

Run configures profile slots; opening a capsule still requires an available slot
and host resources.

Answers: why can adding another capsule be refused.

The app reports `CAPSULE_SLOT_UNAVAILABLE` or `RAM_ADMISSION_REFUSED` when its
admission checks fail [CITED: ui/src/App.vue]. Stop an unneeded capsule or free
host resources, then inspect the refusal again. Hiding a tile does not stop its
capsule. Do not treat a configured pool size as a promise of simultaneous live
performance.

---

## 5. Navigating the UI: Views, Desktops, and Tile Presets

Select a view and desktop, then arrange its live tiles.

Answers: how do I navigate the wall.

Use the navigation tree to choose a view and desktop, then the visible preset
buttons to arrange its tiles [CITED: ui/src/App.vue].

### Views (`Humans` vs `Agents`)

Choose **Humans** for direct-use capsules or **Agents** for agent work.

Answers: how do I switch workspace views.

`Ctrl+Tab` switches views when focus is outside terminal input. Verify the
selected view before adding or moving a capsule [CITED: ui/electron/desktopShortcuts.js].

### Numbered Desktops (`1..16`)

Each view keeps its own desktops and capsule assignments.

Answers: how do I add or select a desktop.

Use the navigation tree's desktop controls to add, select or rename a desktop.
The limit is **16 per view** [CITED: ui/electron/desktopLayout.js]. `Ctrl+1`
selects the first desktop; the remaining numbered shortcuts follow the same
scheme [CITED: ui/electron/desktopShortcuts.js].

### Tile Presets and Moving/Resizing Tiles

Select a preset by its current visible button, not by an old layout screenshot.

Answers: how do I arrange tiles.

| Visible label [CITED: ui/src/App.vue] | Arrangement |
|---|---|
| `1` | Single tile |
| `2` | Side by side |
| `2×2` | Grid |
| `3×2` | Larger grid |
| `Focus` | Focus + strip |
| `Float` | Floating windows |

Manual arrangement means moving or resizing tiles directly. The tile menu also
offers desktop movement. Layout changes alter click coordinates: capture again
before input. Closing a tile hides it; **Stop capsule** ends its running surface.

---

## 6. Adding Capsules: Browser, Program, and Desktop Window

Choose the capsule kind that matches the required execution boundary.

Answers: how do I add the capsule kind my task needs.

Click **`＋ Add capsule`** in the top bar (or **`＋ Add capsule`** inside an empty
desktop). The dialog also offers Host program, which runs on your computer and
is not isolated. The other launch choices are:

### A. `Identity browser` (`kind: "browser"`)

Choose Identity browser and a configured identity, then launch its capsule.

Answers: how do I open an identity browser.

1. Choose **`Identity browser`**.
2. Pick an existing identity from the list (for example `judge`, `mv-live-2`,
   `mv-live-3`, `mv-live-4`, or any identity created in **`Identities`**), or create
   a new one inline:
   - **`Identity name`**: lowercase letters, digits, and hyphens (`^[a-z0-9][a-z0-9-]{1,39}$`) [CITED: tools/mv_identity.py], not starting with `mv-`.
   - **`Display label`**: human-readable label (e.g. `Work GitHub`).
   - **`Initial domain`**: bare domain (e.g. `github.com` or `example.com`).
3. Click **`Launch`**.
4. Inside the browser capsule tile, use the URL bar (`Back`, `Forward`, `Reload`,
   URL input + **`Go`**, and **`Paste`** to send host clipboard text into the
   capsule).

### B. `Program` (`kind: "desktop_capsule"`, program `host-exec`)

Choose Program or Host program, set the role and start its installed binary.

Answers: how do I open a program with the intended execution boundary.

Program uses the configured container program profile; Host program runs the
selected program on the host and is not isolated [CITED: ui/src/catalog/CatalogLauncher.vue].
Choose the kind before entering its binary:

1. Choose **`Program`**, then **`Create Capsule`**.
2. Choose **`Role`**: `Human` (default, you use it directly) or `Agent`.
3. Enter **`Binary name`**: a bare name found on the host, such as `gedit`,
   `gnome-calculator` or `gnome-mines`, or an absolute path.
4. Click **`Start`**.

Open several programs at once by repeating this. A missing binary is refused in the dialog
with the reason.

### C. `Desktop window` (`kind: "desktop_capsule"`, native kind `host-window`)

Select an existing X11 window to display it in a tile.

Answers: how do I attach an existing X11 window.

Attaches a window that is already open on your real X11 desktop into a tile. No Docker.

1. Choose **`Desktop window`**, then **`Create Capsule`**.
2. Choose a window from the list; filter by title or program. MetaViewer itself is excluded.
3. Click **`Add`**. Nothing is attached without this click.

- The tile says **`Real desktop — not isolated`**. It retains the original
  window's sessions and access.
- **`Stop`** on the tile detaches immediately and never closes the window.
- Manual interaction affects the real window. The `mw_run` program lane does
  not support Desktop-window automation.
- X11 only. Native Wayland windows are not listed and are refused.

---

## 7. Human and Agent Roles, Hand-off, and Emergency Takeover

Switch roles to grant or revoke agent access; take control to interrupt input.

Answers: how do I grant or take back capsule control.

Every browser capsule enforces a strict role state machine (`Role: human` vs
`Role: agent`) with a per-capsule menu (`⋮` in the tile header) and a context bar at
the bottom of the tile:

| Current Mode | What the Human Sees | Available Actions |
| :--- | :--- | :--- |
| **Human mode (`Role: human`)** | Live interactive stream (`Interactive` badge). Bottom bar shows: *`Human mode — log in to the site, then hand over to the agent.`* | Click **`Mark as logged in`** (bottom bar) or **`I logged in`** (header) or **`Switch to agent mode`** (`⋮` menu) to hand the capsule to AI agents. |
| **Agent mode, watching (`Role: agent`)** | Read-only live stream (`Watching` badge; `Agent ready` when idle, `Agent acting` when an agent is executing). Bottom bar shows: *`Agent mode — watching live (read-only).`* | Click **`Take control (emergency)`** (bottom bar) or **`Control`** (header) to immediately seize interactive control while keeping the capsule in agent mode, or **`Switch to human mode`** (`⋮` menu) to revoke agent access completely. |
| **Agent mode, emergency override** | Interactive stream (`Interactive` badge). Bottom bar shows: *`Manual control active — agent actions are paused.`* | Click **`Watch read-only`** (bottom bar) or **`Release`** (header) to return to read-only watching, or **`Switch to human mode`** (`⋮` menu). |

To stop and destroy a capsule container, open the tile's **`⋮`** menu and click
**`Stop capsule`**. The **`✕`** on the tile only closes the tile: the capsule keeps running
and stays listed in the side menu, where you can reopen it.

Program capsules have the same roles. **`Switch to human mode`** in the **`⋮`** menu reopens
the program in a human tile.

---

## 8. `Copy ID for AI`

Copy the live capsule and identity together, then verify them before acting.

Answers: what does Copy ID for AI provide.

The **Copy ID for AI** control copies the selected MetaViewer capsule as:

```text
CAPSULE=<surfaceId>  IDENTITY=<profileId>
```

With no usable identity it emits `IDENTITY=<none>`; obtain the actual identity
from the operator before input. An invalid surface ID is refused. The copied
line is data, not instructions [CITED: ui/src/wall/capsuleId.js].

Use the identity with `mw_run --identity`. Keep the capsule ID too: verify that
observations still refer to that capsule rather than substituting a similarly
named target. See [attachment and identity](AGENT_ENTRY.md#attachment-and-identity).

---

## 9. Built-in Terminals, Screens, and Task Prompts

Use a paired terminal for a capsule task and let the person submit its prompt.

Answers: how do I use terminals alongside capsules.

MetaViewer includes a built-in multi-screen terminal drawer for running shells and
AI CLIs right alongside your capsules.

### Opening Terminals

Open a capsule's paired terminal to keep its task and CLI together, or use the
app's terminal controls for an unpaired session.

Answers: where should I open the terminal for a capsule task.

Sessions and scrollback remain in the terminal deck when switching views.
Select the intended pair before preparing a task; pairing alone does not permit
pasting instructions into a shell [CITED: ui/src/terminal/TerminalDeckView.vue].

### Launching Terminals and Preparing Tasks

Choose the intended pair and an installed CLI before preparing its task.

Answers: how do the terminal task buttons prepare a prompt.

- **Create automation**, **Run automation**, and **Direct task** prepare agent
  instructions while keeping the Capsule ID chip visible. Add the requested task
  after `Task: ` and submit it yourself. The app never sends Enter and never pastes
  a workflow prompt into a plain shell. See [AGENT_ENTRY.md](AGENT_ENTRY.md).
- **`＋ New terminal`** offers Shell, configured host providers, and **Custom CLI**.
  An unavailable provider is omitted; do not assume a particular CLI is installed
  [CITED: ui/src/terminal/terminalDeckModel.js].
- **`Ctrl+Shift+C`** copies a selection; **`Ctrl+Shift+V`** pastes;
  **`Ctrl+Shift+T`** opens a shell and **`Ctrl+Shift+W`** closes the active terminal
  [CITED: ui/src/terminal/terminalDeckModel.js].

---

## 10. Managing Browser Identities (`Identities` Dialog and `tools/mv_identity.py`)

Manage identities through the app or through its same attached store.

Answers: how do I manage browser identities.

### From the UI (`Identities`)

Use Identities to inspect and manage the app's configured identity store.

Answers: how do I manage an identity in the UI.

Click **`Identities`** in the top bar  to:

- Inspect all identities in `$SRF_IDENTITY_STORE_ROOT`, their allowed domains,
  provisioning state, and active lease status.
- Create a new identity (`Identity name`, `Display label`, comma-separated
  `Allowed domains` such as `github.com,example.com`).
- Provision its profile directory (`0700`, UID `10001`) without `sudo` via Docker.
- Delete an unused identity (names starting with `mv-` and the active live profile
  are reserved and protected from deletion).

### From the CLI (`tools/mv_identity.py`)

Source the app attachment so CLI commands use the same store as the app.

Answers: how do I run identity commands against the app store.

Use the same bindings as the running app. Read the attachment path from the
`METAVIEWER_ATTACH <path>` line printed in the terminal running
`metaviewer-judge.sh run`. Replace this placeholder in a dedicated shell before
the commands below:

```text
export METAVIEWER_ATTACH='<copied-current.env-path>'
set -a
. "$METAVIEWER_ATTACH"
set +a
: "${MV_SRF_BIN_DIR:?attachment must supply native binaries}"
: "${SRF_IDENTITY_STORE_ROOT:?attachment must supply the identity store}"
: "${MV_MW_HOME:?attachment must supply the separate MemoryWeb home}"
cd "${MV_OPERATOR_REPO:?attachment must supply the public operator tree}"
```

An explicitly selected alternative store is separate from the app's identities.
For the app's store, retain these exported values:

```bash
# List identities
python3 tools/mv_identity.py \
  --store-root "$SRF_IDENTITY_STORE_ROOT" \
  --memoryweb-home "$MV_MW_HOME" list

# Create and auto-provision a browser identity (sudo-free via Docker)
python3 tools/mv_identity.py \
  --store-root "$SRF_IDENTITY_STORE_ROOT" \
  --memoryweb-home "$MV_MW_HOME" create \
  --id work-demo \
  --label "Work Demo" \
  --domains "example.com"

# Check status (lease, profile provisioning, login reservation)
python3 tools/mv_identity.py \
  --store-root "$SRF_IDENTITY_STORE_ROOT" \
  --memoryweb-home "$MV_MW_HOME" status \
  --id work-demo
```

---

## 11. `Use MetaViewer`: Attaching Any External AI (`docs/AGENT_ENTRY.md`)

Source the intended running app before listing or operating its capsules.

Answers: how do I attach an external AI to the running app.

Use the task-specific section of [AGENT_ENTRY.md](AGENT_ENTRY.md) for your
external AI. Its fenced reference prompt is for stored-workflow mode; it is not
a general command for every capsule kind.

While MetaViewer is running, it publishes owner-only `current.env` and
`current.json` in the host runtime's `metaviewer/attach/` directory. The JSON
schema is `metaviewer.attach/v1`, with `schema`, `session_id`, `pid`,
`core_socket`, `boot_profile`, and `env`. The shell file exports `env`, including
`MV_CORE_CONFIG`, `XDG_RUNTIME_DIR`, and `MV_SESSION_ID`, plus available native,
identity-store and dependency paths. Optional paths can be absent.

Use the absolute host runtime attachment path before sourcing: sourcing changes
`XDG_RUNTIME_DIR` to the app's private core runtime. Use a dedicated shell:

```text
export METAVIEWER_ATTACH='<copied-current.env-path>'
set -a
. "$METAVIEWER_ATTACH"
set +a
cd "${MV_OPERATOR_REPO:?attachment must supply the public operator tree}"
```

To list one page of surfaces, use the shipped core tool client with the trusted
registration in `MV_CORE_CONFIG`. If several agent peers exist, set
`MV_AGENT_INSTANCE` to the operator-selected registered instance; never guess it.
This example does not create or control a capsule:

```bash
PYTHONPATH=agents python3 - <<'PY'
import json, os
from pathlib import Path
from metaviewer_agents import mvctl

with open(os.environ["MV_CORE_CONFIG"], encoding="utf-8") as source:
    config = json.load(source)
agents = [peer for peer in config["peers"]
          if peer["endpoint"]["component"] == "agent"]
selected = os.environ.get("MV_AGENT_INSTANCE")
if selected:
    agents = [peer for peer in agents if peer["endpoint"]["instance"] == selected]
if len(agents) != 1:
    raise SystemExit("Select exactly one registered MV_AGENT_INSTANCE")
raise SystemExit(mvctl.run([
    "list", "--socket", str(Path(os.environ["XDG_RUNTIME_DIR"]) / "metaviewer/core.sock"),
    "--session-id", config["session_id"],
    "--agent-instance", agents[0]["endpoint"]["instance"],
    "--core-instance", config["core"]["endpoint"]["instance"],
    "--limit", "16", "--timeout-ms", "5000",
    "--max-line-bytes", "65536", "--max-reply-bytes", "65536",
]))
PY
```

The result can contain `next_cursor`; pass it as `--cursor` for the next page.
Observation and actions use the existing `mv_tool_call/v0.2` protocol through
`mvctl` or `mw_run`, including core admission and verification. For an existing
Agent capsule, use the goal commands below with its copied identity. Do not
send invented raw capsule commands to the core socket.

---

## 12. Automation with `mw_run` and MemoryWeb

Choose goal mode or a preflighted stored workflow; do not mix their flags.

Answers: which runner mode should I use.

Use goal mode for a current observed control, or stored-workflow mode for an
authored MemoryWeb workflow. These modes have different preconditions and flags
[CITED: agents/metaviewer_agents/mw_run.py]. The complete first-run procedure is
in [MW_RUN_FIRST_RUN.md](MW_RUN_FIRST_RUN.md).

### A. Check MemoryWeb Home Readiness (`tools/mw_home_check.py`)

Check the workflow home before replaying stored automation.

Answers: how do I preflight the workflow home.

```bash
python3 tools/mw_home_check.py --repo .
```

Returns JSON `ok:true` when the admitted MemoryWeb home passes ownership,
layout and repository checks; it does not prove a running capsule or reachable
planner. Refusal includes `code`; repair that precondition before continuing.

### B. Dump Accessibility Tree from a Running Browser Capsule (`tools/mw_ax_dump.py`)

Read the live browser accessibility tree before choosing workflow anchors.

Answers: how do I inspect live browser anchors without input.

```bash
python3 tools/mw_ax_dump.py \
  --repo . \
  --capsule judge \
  --site example-site \
  --out /tmp/ax_snapshot.json
```

### C. Record and Compile a Demo (`tools/mv_demo.py`)

Record the person's demonstration, generate authoring instructions and check the resulting workflow.

Answers: how do I author a workflow from a demonstration.

Source the running app attachment as in the goal instructions below. Set
`MV_MW_HOME` to the admitted MemoryWeb home and `MV_MEMORYWEB_REPO` to the
operator-provided authoring checkout. Use a fresh demo identifier and a site
identifier; these are identifiers, not filesystem paths or URLs.

```bash
python3 tools/mv_demo.py record --identity judge --demo judge-demo
python3 tools/mv_demo.py prompt --demo judge-demo --site example-site
python3 tools/mv_demo.py check --site example-site
```

`record` opens the existing identity's recorder for the person's demonstration;
it does not create a capsule. `prompt` emits the authoring instructions from
sealed evidence; the AI must create and review the site/workflow before `check`.
Success returns rc `0`; `DEMO_REFUSED` returns rc `6` [CITED:
`tools/mv_demo.py` (`main`)]. Inspect custody, evidence and authoring configuration
before trying again; never fabricate a demonstration.

### D. Run a Compiled MemoryWeb Workflow (`metaviewer_agents.mw_run`)

Replay a reviewed stored workflow only after its home and live anchors pass.

Answers: how do I replay a stored workflow.

Here “compiled workflow” means a stored site/workflow, not the compiled Wender
runtime. Source the running app attachment and select an admitted workflow from
`MV_MW_HOME` before running from the checkout:

```bash
PYTHONPATH=agents python3 -m metaviewer_agents.mw_run \
  --identity judge --site example-site --workflow smoke
```

The public parser accepts `--identity`, `--site`, `--workflow` and repeatable
`--slot name=value` for declared operator-supplied inputs. Slots are values, not
RAM workspace indices. Home, core attachment and native paths come from the
environment; this entry does not accept `--input`, `--memoryweb-home`,
`--store-root`, `--ram-Base`, `--bin-dir`, `--state-dir`, `--display`,
`--attach-capsule` or `--attach-socket`. See `docs/MW_RUN_FIRST_RUN.md` for stored
workflow receipts and refusals. Goal-only planner/input flags are described below.

On shared hosts, wrap the same command in the memory scope:

```bash
systemd-run --user --scope -q -p MemoryHigh=6G -p MemoryMax=8G -p MemorySwapMax=0 -- \
  env PYTHONPATH=agents python3 -m metaviewer_agents.mw_run \
  --identity judge --site example-site --workflow smoke
```

### E. Browser Goal Runs (No Stored Workflow)

Use a unique observed browser control name for a bounded goal.

Answers: how do I run a browser goal without a stored workflow.

Use [Attachment and identity](AGENT_ENTRY.md#attachment-and-identity) and the
[read-only browser observation](AGENT_ENTRY.md#observe-the-selected-capsule)
first. Keep the person present and release manual control before input.
`--planner rules` uses the locked rules planner without a model account;
`--planner muse` explicitly selects authenticated Muse Code
[CITED: agents/metaviewer_agents/mw_run.py].

From the attached operator root, replace the placeholders and choose a unique
observed control name:

```sh
export XDG_STATE_HOME="$(mktemp -d /dev/shm/metaviewer-goal.XXXXXX)"
PYTHONPATH=agents python3 -m metaviewer_agents.mw_run \
  --surface-kind browser --identity '<browser-profile>' --planner rules \
  --goal 'Exact visible control name' --steps 1
```

The example bounds actions at one [TARGET]. For a text field add explicit
`--text 'Synthetic value' --key Enter --steps 3` [TARGET], replacing the existing
steps flag. Omit Enter and use `--steps 2` [TARGET] for focus and typing only.
Exact native text readback gates Enter. Never combine goal mode with stored
`--site`, `--workflow` or `--slot` flags. This example does not establish visual task completion; inspect the fresh result.

The pinned Linux x64 compiled runtime supports browser goals with rules or
Muse through the goal runner. Stored browser workflows remain restricted and
refuse `MW_COMPILED_WORKFLOW_UNAVAILABLE` in compiled mode; use a verified
checkout matching `deps.lock` for those. Dependency validation still applies;
compiled support does not admit a wrong-architecture or modified binary. See the
Judge tour architecture table for the supplied live results.

### F. Programs and Host program (`--surface-kind program`)

Use the program runner on a live Agent program with its copied identity.

Answers: how do I run a supported program action.

Start an Agent **Program** or **Host program**, copy its identity and verify
agent control. Follow [the read-only program observation](AGENT_ENTRY.md#observe-a-program-without-input)
to choose a current element name. Missing dependencies or custody stop the run;
this command does not launch a program or attach a Desktop window
[CITED: tools/mw_run_program.py].

```sh
export XDG_STATE_HOME="$(mktemp -d /dev/shm/metaviewer-program.XXXXXX)"
PYTHONPATH=agents python3 -m metaviewer_agents.mw_run \
  --surface-kind program --identity '<program-profile>' --planner rules \
  --goal 'Exact observed element name' --steps 1
```

This requests one click. Programs also accept operator-supplied `--text` with
`--steps 1`, using `--goal focused` only for an already focused field, or a unique
observed field name for focus and typing. Agent Host programs also accept `--goal focused-key --key Right --steps 1`
with `--planner rules` and no text. Allowed keys are Enter and the arrows;
container programs do not support this mode [CITED: tools/mw_run_program.py]. Text
readback is `exact`, `mismatch`, or `not_readable`; mismatch refuses and
not_readable remains explicitly uncertified. Both
goal lanes require owned private RAM evidence under `/dev/shm`, without symlink
ancestors. Keep the output report/receipt paths and inspect them before shutdown.

| Result / rc [CITED: goal runner `run_entry` functions and `mw_run.py` (`main`)] | Next action |
| --- | --- |
| `BROWSER_BOUNDED_ACTIONS_VERIFIED` or `PROGRAM_BOUNDED_ACTIONS_VERIFIED` / `0` | Check receipts and fresh visible outcome; verified actions do not prove goal completion. |
| `PROGRAM_TEXT_UNCERTIFIED_NOT_READABLE` / `0` | Text was sent but could not be read back; inspect the report and editor. This is not certified success. |
| argparse error / `2` | Fix syntax or action budget before running. |
| `HUMAN_HANDOFF` / `4` (browser) | Person takes control, resolves login/CAPTCHA, releases control and observes the new state before a fresh goal. |
| `INPUT_UNCERTAIN` / `5` | Stop; inspect dispatch/receipt/report evidence with the operator. Never automatically retry. |
| refusal / `6` | Inspect the named verdict and earlier moves; repair the precondition before a fresh run. |

`MW_PROGRAM_CONTROL` requires **Switch to agent mode** for a Human-role capsule,
or **Release control** after takeover of an Agent capsule; verify agent control.
`MW_RUN_ATTACH`/`MW_RUN_CONFIG` requires the current app attachment.
`MW_PROGRAM_RAM_REQUIRED`/`MW_PRIVATE_OUTPUT` requires the private RAM setup.
`MW_PROGRAM_GOAL_UNGROUNDED` requires a unique observed target.
A traceback without JSON also requires stopping and operator inspection.

---

## 13. What Is Not Supported (Honest Limitations)

Use only the admitted Linux capsule kinds and bounded command paths.

Answers: what are the supported operating boundaries.

When explaining MetaViewer to a user or judge, state these boundaries clearly:

1. **Linux Only (No macOS, No Native Windows)**:
   MetaViewer relies on Linux namespaces, `/dev/shm` `tmpfs`, Unix domain sockets,
   and rootful Linux Docker containers (`x86_64` and `aarch64`). macOS and native
   Windows are not supported (`JUDGE_OS`).
2. **X11 / XWayland Required (`DISPLAY` Must Be Set)**:
   The MetaViewer Electron shell runs with `--ozone-platform=x11` and needs an X11 or
   XWayland server (`JUDGE_DISPLAY`). Furthermore, the **`Desktop window`** capture
   mode only attaches X11 windows; native Wayland windows are not listed.
3. **Goal Automation Is Bounded**:
   Browser goal runs need no stored workflow, but require an exact visible control
   name and grounded input; they support clicks, verified text and optional Enter.
   Login walls and CAPTCHA require the person (rc `4` [CITED: tools/mw_run_browser_goal.md]).
   Program and Host program runs admit clicks and bounded operator text with
   readback; key input is limited to `--goal focused-key` with Up, Down, Left,
   Right or Enter on Host programs [CITED: tools/mw_run_program.md:68], and
   automation of Desktop window capsules is unsupported. Live program results are limited to the Judge tour table. Explicit
   `--planner muse` sends marks to a provider. A verified action is not a finished
   goal. Browser role switches currently recreate the capsule and can lose the
   open page; preserved profile login state does not prove page continuity.
4. **Rootless Docker and Docker Desktop Are Refused for Tier 2**:
   OpenSuperficies capsule isolation requires the local rootful Linux Docker daemon
   (`JUDGE_DOCKER`, `JUDGE_DOCKER_DESKTOP`, `JUDGE_DOCKER_HOST`).
5. **Guest and Session Limits**:
   ARM64 guest cards require admitted host support and configured assets
   [CITED: ui/src/catalog/catalogModel.js]. Their command binding is distinct
   from graphical program goals. A full journal ends the session; preserve it
   and follow [JOURNAL_END.md](JOURNAL_END.md).
6. **Evidence Limits**:
   Live results remain maintainer-reported. The portable examples have offline
   checks; this guide does not certify live display input or provider access.
   See [the evidence boundary](AI_AT_THE_CONTROLS.md#8-limits-and-negative-results).

### Legacy kit proxy setup

Use the network mode and compiled kit supported by your installation; do not
change a running capsule's network witness to bypass a refusal.

Answers: where do I find compatible network setup.

Follow [INSTALL.md](INSTALL.md) for setup and [DEBUG.md](DEBUG.md) for the reported
network refusal. Stored workflows require a matching start witness and refuse
`MW_NETWORK` if that evidence is absent or changes
[CITED: tools/mw_run_backend.py]. Restart through the supported setup after an
operator-approved network change.

This guide covers the supplied repository's public UI and command interfaces;
live behavior is bounded by the linked architecture results and installed kit.
