# MetaViewer AI Operator Guide

Give this single file to your own AI (or read it directly) so it can install,
configure, verify, operate, and explain every feature of MetaViewer on a standard
Linux desktop or laptop.

Every command, button label, environment variable, and refusal code in this guide is
verified against the repository source code (`scripts/judge/`, `ui/`,
`daemon-adapter/`, `tools/`, and `agents/metaviewer_agents/`).

---

## 1. What MetaViewer Is (and How to Explain It to a Person)

MetaViewer is a Linux desktop wall of live, isolated capsules. Instead of letting an
automation script take over your personal browser or desktop session, MetaViewer runs
each browser session or Linux program inside its own container (`OpenSuperficies`)
with its own virtual X11 display and streams the live surface into
an interactive tiled canvas.

A person and an AI work side by side on the same wall:

- **Human role (`Role: human`)**: The person logs into a site, solves 2FA/CAPTCHAs,
  or uses an application directly. While a capsule is in human mode, agent
  automation is blocked at the daemon boundary.
- **Agent role (`Role: agent`)**: Once the person clicks **`Mark as logged in`**
  (or **`Switch to agent mode`**), an external AI or `mw_run` can observe and act on
  that specific capsule while the person watches live in read-only mode or takes
  back control at any moment with **`Take control (emergency)`**.

---

## 2. Target Hardware and Tier Thresholds (Typical x64 / arm64 Linux Laptop)

MetaViewer is designed for standard Linux machines (`x86_64` / `x64` and `aarch64` /
`arm64`) such as an **8-core, 16 GiB RAM laptop** running Ubuntu 24.04 LTS or
Debian 12/13 under an X11 or XWayland desktop session (`DISPLAY` set).

| Check | Tier 1 (App shell only) | Tier 2 (`--capsules`, live browser & program capsules) | Refusal Code |
| :--- | :--- | :--- | :--- |
| OS & Arch | Linux (`ubuntu`/`debian` 24.04/12/13; other distros warn) on `x86_64` or `aarch64` | Same | `JUDGE_OS`, `JUDGE_ARCH`, `JUDGE_BUNDLE_ARCH` |
| CPU pinning | **None required** (`MV_JUDGE_REQUIRE_CPUSET` defaults to `none`; >= 8 logical CPUs recommended) | **None required** (`MV_JUDGE_REQUIRE_CPUSET` defaults to `none`) | `JUDGE_CPUSET` (only if `MV_JUDGE_REQUIRE_CPUSET` is explicitly set) |
| Available RAM | `floor = min(MemTotal / 4, 20 GiB)`. Hard minimum: `MemAvailable >= floor + 512 MiB` (`4.5 GiB` on a 16 GiB laptop) [MEASURED]. Warns below `floor + 4 GiB` (`8 GiB` on a 16 GiB laptop) [TARGET]. | Same admission floor (`floor + 512 MiB` hard minimum; warns below `floor + 4 GiB`). Each running browser capsule uses up to ~2 GiB RAM. | `JUDGE_RAM`, `JUDGE_RAM_STALE` |
| `/dev/shm` (`tmpfs`) | Hard minimum: `>= 512 MiB` (`536,870,912` B) [TARGET] | Hard minimum: `>= 1 GiB` (`1,073,741,824` B) [TARGET]; warns below `2.5 GiB` (`2,684,354,560` B) [TARGET] | `JUDGE_SHM` |
| Free disk space | `>= 2 GB` (`2,000,000,000` B) on `MV_JUDGE_HOME` | Hard minimum: `>= 15 GB` (`15,000,000,000` B) on `MV_JUDGE_HOME` and `/var/lib/docker`; warns below `30 GB` (`30,000,000,000` B) [TARGET] | `JUDGE_DISK` |
| Display & Runtime | Reachable X11/XWayland `DISPLAY`; private `XDG_RUNTIME_DIR` (`0700`, owned by current UID) | Same | `JUDGE_DISPLAY`, `JUDGE_XDG_RUNTIME` |
| Docker Engine | Not required | Rootful local Docker Engine (`>= 24.0`) with user in `docker` group; no `DOCKER_HOST`/`DOCKER_CONTEXT`; not rootless or Docker Desktop | `JUDGE_DOCKER`, `JUDGE_DOCKER_HOST`, `JUDGE_DOCKER_DESKTOP` |

If `/dev/shm` is smaller than 1 GiB on a laptop, resize it without rebooting:

```bash
sudo mount -o remount,size=4G /dev/shm
```

---

## 3. Release Assets and Building Them Locally

`scripts/judge/metaviewer-judge.sh` verifies every archive against `assets/SHA256SUMS`
before unpacking:

| Asset Name | Tier | Contents |
| :--- | :--- | :--- |
| `metaviewer-linux-<x64\|arm64>.tar.gz` | T1 & T2 | `MetaViewer-linux-<arch>/` app bundle and `MetaViewer-linux-<arch>.sha256` |
| `node-linux-<x64\|arm64>.tar.xz` | T1 & T2 | Node.js `>= 24` runtime (`*/bin/node`), unpacked only if host `node` is missing or `< 24` |
| `opensuperficies-linux-<x64\|arm64>.tar.gz` | T2 | `opensuperficies/bin/srf*` binaries (`srf-identity-surface`, `srf-identity-admin`, etc.) and `opensuperficies/firewall/` |
| `images-linux-<x64\|arm64>.tar` | T2 | `docker save` archive with `opensuperficies-identity-browser-<arch>:0.1.1`, `opensuperficies-program-host-<arch>:0.1.0`, and `opensuperficies-desktop-<arch>:1.1.0` |
| `vision-engine.tar.gz` | T2 | `vision-engine/` at the commit pinned in `deps.lock` |
| `wender-agent.tar.gz` | T2 | `wender-agent/` at the commit pinned in `deps.lock` |
| `SHA256SUMS` | T1 & T2 | SHA-256 manifest of the release assets |

To build all release assets and `SHA256SUMS` from local artifacts (without embedding
any host path, and checking GitHub's 2 GiB per-asset limit):

```bash
python3 tools/build_release_assets.py \
  --out-dir ./assets \
  --arch x64 \
  --app-dir /path/to/MetaViewer-linux-x64 \
  --node-tarball /path/to/node-v24.14.0-linux-x64.tar.xz \
  --opensuperficies-dir /path/to/opensuperficies/bin \
  --firewall-dir /path/to/opensuperficies/deploy/firewall \
  --vision-engine-dir /path/to/vision-engine \
  --wender-agent-dir /path/to/wender-agent
```

---

## 4. Installing, Running, and Stopping MetaViewer (`metaviewer-judge.sh`)

All four lifecycle subcommands live in `scripts/judge/metaviewer-judge.sh`:

```bash
# 1. Check the machine (read-only; changes nothing on disk)
bash scripts/judge/metaviewer-judge.sh doctor --capsules

# 2. Install Tier 2 (app + capsules, images, and sudo-free profile directories)
bash scripts/judge/metaviewer-judge.sh install --capsules

# 3. Launch MetaViewer (blocks while the app is open)
bash scripts/judge/metaviewer-judge.sh run

# 4. Stop MetaViewer and any running srf-* capsules cleanly
bash scripts/judge/metaviewer-judge.sh stop
```

### What `install --capsules` Does and When `sudo` Is Used

- **Profile provisioning is 100% `sudo`-free**: `install --capsules` provisions
  `$SRF_IDENTITY_STORE_ROOT/profiles/{judge,mv-live-1,mv-live-2,mv-live-3,mv-live-4}`
  as mode `0700` owned by container UID `10001:10001` using a one-shot local Docker
  bind-mount (`opensuperficies-identity-browser-<arch>:0.1.1`) with `--network none`.
- **`sudo` is only requested when genuinely required by the OS**, and the exact
  command is always printed before asking `Run this administrator command? [y/N]`:
  1. Missing `apt-get` system packages (`JUDGE_SYSDEP`).
  2. Loading the AppArmor profile `/etc/apparmor.d/metaviewer-judge` on Ubuntu 24.04+
     when `kernel.apparmor_restrict_unprivileged_userns=1` (`JUDGE_USERNS`).
  3. Optional open-mode egress firewall (`srf-open-egress.service`). If you decline
     this prompt or pass `--no-firewall`, `install --capsules` automatically falls
     back to the legacy Docker bridge network (`srf-idnet`) with zero `sudo` steps.
- Pass `--yes` only when you want unattended consent for those prompts.
- Every refusal exits with code `2` and prints a single line:
  `JUDGE_<CODE>: <problem> -- fix: <exact command>`.

### Default Multi-Capsule Pool Launched by `run`

`metaviewer-judge.sh run` configures browser profile slots `judge`, `mv-live-2`,
`mv-live-3` and `mv-live-4` in `MV_SRF_PROFILES`, sharing
`$MV_JUDGE_SHM_DIR/vqa-ramws/opensuperficies/os-cu-0`. Up to **16 capsules** can run at
once. Before each container capsule, MetaViewer checks that the host has 6 GiB of free
memory (4 GiB RAM plus 2 GiB shm) and refuses with a reason naming what to close.

---

## 5. Navigating the UI: Views, Desktops, and Tile Presets

When the MetaViewer window opens, the top bar (`42 px` height) controls the workspace:

### Views (`Humans` vs `Agents`)

- **`Humans`** tab: Workspace for capsules you interact with directly.
- **`Agents`** tab: Workspace for capsules operated by AI agents.
- **Keyboard shortcut**: Press **`Ctrl+Tab`** to toggle between `Humans` and `Agents`
  (when focus is outside a terminal).

### Numbered Desktops (`1..16`)

- Each view has up to **16 independent virtual desktops** shown as numbered pills
  (`1`, `2`, …).
- Click **`+`** (`New desktop`) to add a desktop (up to 16).
- Double-click a desktop pill to rename it (up to 24 characters).
- Hover a desktop pill and click **`✕`** to close it (when more than one desktop
  exists; capsules on that desktop are moved to a remaining desktop).
- **Keyboard shortcuts**: Press **`Ctrl+1`** through **`Ctrl+9`** to jump directly
  to desktop 1–9.

### Tile Presets and Moving/Resizing Tiles

Click the **`Layout:`** dropdown in the top bar to switch the active desktop's
arrangement:

| Preset Label | Preset ID | Behavior |
| :--- | :--- | :--- |
| **`Single`** | `single` | One active capsule fills the canvas; switch between capsules via the top strip |
| **`Side by side`** | `split-h` | Even horizontal columns |
| **`Grid`** | `grid-2x2` | Balanced 2×2 / multi-cell grid (`auto`, default) |
| **`Focus + strip`** | `main-right` | Primary capsule on the left (`68%` width), vertical stack of secondary capsules on the right (`32%` width) |
| **`Floating`** | `free` | Overlapping draggable/resizable windows with 8-direction resize handles (`N`, `S`, `E`, `W`, `NE`, `NW`, `SE`, `SW`) |
| **`Manual`** | `custom` | Activated automatically when you drag a tile header to swap positions or drag a gap handle (`6 px` gutter) between adjacent tiles |

- **Fullscreen a tile**: Click **`⛶`** in the tile header (or press **`Escape`** /
  click **`⊡`** to exit fullscreen).
- **Move a capsule to another desktop**: Open the tile's **`⋮`** menu and use **`Move to desktop`**
  and pick the target desktop (`1..N`).

---

## 6. Adding Capsules: Browser, Program, and Desktop Window

Click **`＋ Add capsule`** in the top bar (or **`＋ Add capsule`** inside an empty
desktop). The dialog offers three tabs:

### A. `Identity browser` (`kind: "browser"`)

1. Choose **`Identity browser`**.
2. Pick an existing identity from the list (for example `judge`, `mv-live-2`,
   `mv-live-3`, `mv-live-4`, or any identity created in **`Identities`**), or create
   a new one inline:
   - **`Identity name`**: lowercase letters, digits, and hyphens (`^[a-z0-9][a-z0-9-]{1,39}$`), not starting with `mv-`.
   - **`Display label`**: human-readable label (e.g. `Work GitHub`).
   - **`Initial domain`**: bare domain (e.g. `github.com` or `example.com`).
3. Click **`Launch`**.
4. Inside the browser capsule tile, use the URL bar (`Back`, `Forward`, `Reload`,
   URL input + **`Go`**, and **`Paste`** to send host clipboard text into the
   capsule).

### B. `Program` (`kind: "desktop_capsule"`, program `host-exec`)

Runs a Linux GUI program from the host's `/usr` inside its own container, with no network:

1. Choose **`Program`**, then **`Create Capsule`**.
2. Choose **`Role`**: `Human` (default, you use it directly) or `Agent`.
3. Enter **`Binary name`**: a bare name found on the host, such as `gedit`,
   `gnome-calculator` or `gnome-mines`, or an absolute path.
4. Click **`Start`**.

Open several programs at once by repeating this. A missing binary is refused in the dialog
with the reason.

### C. `Desktop window` (`kind: "desktop_capsule"`, native kind `host-window`)

Attaches a window that is already open on your real X11 desktop into a tile. No Docker.

1. Choose **`Desktop window`**, then **`Create Capsule`**.
2. Choose a window from the list; filter by title or program. MetaViewer itself is excluded.
3. Click **`Add`**. Nothing is attached without this click.

- The tile says **`Real desktop — not isolated`**. Unlike other capsules, this is the real
  window, with whatever it is logged in to and can reach.
- **`Stop`** on the tile detaches immediately and never closes the window.
- Acting on the window raises it in front of your other windows and moves the real pointer,
  so do not use the desktop while an AI drives it.
- X11 only. Native Wayland windows are not listed and are refused.

---

## 7. Human and Agent Roles, Hand-off, and Emergency Takeover

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

Every capsule tile header has an **`ID`** button (and **`Copy ID for AI`** in the
tile's **`⋮`** menu).

Clicking **`ID`** / **`Copy ID for AI`** copies a single line to the clipboard and
shows a toast banner at the top of the window:

- For a browser capsule with an identity:
  `capsule_id=<uuid> identity=<profile_id>`
- For a capsule without an identity:
  `capsule_id=<uuid>`

Paste that line directly into your AI terminal or prompt so the AI knows the exact
`capsule_id` and `identity` to target.

---

## 9. Built-in Terminals, Screens, and `🚀 Bootstrap`

MetaViewer includes a built-in multi-screen terminal drawer for running shells and
AI CLIs right alongside your capsules.

### Opening Terminals

- Click **`More`** in the top bar and select **`Terminal`**.
- Terminals live on numbered screens (**`Screen 1`**, **`Screen 2`**, …). Each screen holds
  two terminals; a third opens a new screen. Up to 16 shells and 16 AI sessions run at once.
- Sessions keep running, with their scrollback, while you visit other views.

### Launching Terminals and `🚀 Bootstrap`

- **`🚀 Bootstrap`**: When a screen has no tabs, click **`🚀 Bootstrap`** (or use
  the **`Bootstrap:`** bar at the bottom of the drawer to pick a provider and
  optional API key, then click **`Launch`**). Bootstrap starts a shell with
  `METAVIEWER_AGENT_ENTRY` pointing to `docs/AGENT_ENTRY.md` and prints the live
  attachment coordinates so an AI CLI immediately knows how to use MetaViewer.
- **`＋ New terminal`**: Opens the new-terminal modal with three presets:
  - **`Shell`** (`$SHELL` or `/bin/bash`)
  - **`Agy`** (`agy`)
  - **`Custom CLI`** (enter any command line, e.g. `python3 -i`)
- **Keyboard shortcuts (when focus is inside a terminal)**:
  - **`Ctrl+Shift+C`**: Copy terminal selection to clipboard
  - **`Ctrl+Shift+V`**: Paste clipboard into terminal
  - **`Ctrl+Shift+T`**: Open a new shell tab in the current screen
  - **`Ctrl+Shift+W`**: Close the active terminal tab

---

## 10. Managing Browser Identities (`Identities` Dialog and `tools/mv_identity.py`)

### From the UI (`Identities`)

Click **`Identities`** in the top bar  to:

- Inspect all identities in `$SRF_IDENTITY_STORE_ROOT`, their allowed domains,
  provisioning state, and active lease status.
- Create a new identity (`Identity name`, `Display label`, comma-separated
  `Allowed domains` such as `github.com,example.com`).
- Provision its profile directory (`0700`, UID `10001`) without `sudo` via Docker.
- Delete an unused identity (names starting with `mv-` and the active live profile
  are reserved and protected from deletion).

### From the CLI (`tools/mv_identity.py`)

Operators can also manage identities from a terminal (requires `--store-root` and
`--memoryweb-home` on separate directories):

```bash
# List identities
python3 tools/mv_identity.py list \
  --store-root "$HOME/.local/share/srf-identity-store" \
  --memoryweb-home "$HOME/.local/share/metaviewer-memoryweb"

# Create and auto-provision a browser identity (sudo-free via Docker)
python3 tools/mv_identity.py create \
  --store-root "$HOME/.local/share/srf-identity-store" \
  --memoryweb-home "$HOME/.local/share/metaviewer-memoryweb" \
  --id work-demo \
  --label "Work Demo" \
  --domains "example.com"

# Check status (lease, profile provisioning, login reservation)
python3 tools/mv_identity.py status \
  --store-root "$HOME/.local/share/srf-identity-store" \
  --memoryweb-home "$HOME/.local/share/metaviewer-memoryweb" \
  --id work-demo
```

---

## 11. `Use MetaViewer`: Attaching Any External AI (`docs/AGENT_ENTRY.md`)

Click **`Use MetaViewer`** in the top bar to open the attachment modal:

- **`Copy agent prompt`**: Copies a ready-to-paste prompt telling any external AI to
  read `docs/AGENT_ENTRY.md` and `$XDG_RUNTIME_DIR/metaviewer/attach/current.env`.
- **`Copy env path`**: Copies the path to `$XDG_RUNTIME_DIR/metaviewer/attach/current.env`.

While MetaViewer is running, it maintains two live discovery files in
`$XDG_RUNTIME_DIR/metaviewer/attach/`:

- `current.env` (shell `export` lines: `MV_ATTACH_SOCKET`, `MV_ATTACH_PID`,
  `MV_ATTACH_WORKSPACE`, `MV_ATTACH_ENTRY_DOC`)
- `current.json` (JSON equivalent with `schema_version: "0.2"`)

Any external AI in any terminal can attach and list or control capsules by sourcing
`current.env`:

```bash
. "$XDG_RUNTIME_DIR/metaviewer/attach/current.env"
```

Every IPC envelope sent to `$MV_ATTACH_SOCKET` is a single JSON line (`version: "0.2"`).
For example, to list active capsules (`capsule.list`) from Python:

```bash
python3 - <<'PY'
import json, os, socket, time, uuid

env_file = os.path.join(os.environ["XDG_RUNTIME_DIR"], "metaviewer", "attach", "current.env")
cfg = {}
with open(env_file, encoding="utf-8") as f:
    for line in f:
        if line.startswith("export ") and "=" in line:
            k, v = line[len("export "):].strip().split("=", 1)
            cfg[k] = v.strip("'")

req = {
    "version": "0.2",
    "id": str(uuid.uuid4()),
    "type": "capsule.list",
    "ts_ns": time.time_ns(),
    "payload": {},
}
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
    s.connect(cfg["MV_ATTACH_SOCKET"])
    s.sendall((json.dumps(req) + "\n").encode("utf-8"))
    reply = json.loads(s.makefile().readline())
print(json.dumps(reply, indent=2))
PY
```

To act on a browser capsule (`Role: agent`), send `capsule.act` with:

- `capsule_id`: the target UUID (from `capsule.list` or **`Copy ID for AI`**)
- `actor`: `"agent"`
- `action`: `"navigate"` (`url`), `"click"` (`x`, `y`, `button`), `"type"` (`text`),
  `"key"` (`key`), `"scroll"` (`dx`, `dy`), or `"wait"` (`ms`)

---

## 12. Automation with `mw_run` and MemoryWeb

MetaViewer integrates with **MemoryWeb (`wender-agent`)** to compile recorded
demonstrations into repeatable site graphs (`site.json` + `workflows/<workflow>.json`)
and execute them inside an isolated identity capsule via `metaviewer_agents.mw_run`.

### A. Check MemoryWeb Home Readiness (`tools/mw_home_check.py`)

```bash
python3 tools/mw_home_check.py --repo .
```

Returns JSON `ok:true` when the admitted MemoryWeb home passes ownership,
layout and repository checks; it does not prove a running capsule or reachable
planner. Refusal includes `code`; repair that precondition before continuing.

### B. Dump Accessibility Tree from a Running Browser Capsule (`tools/mw_ax_dump.py`)

```bash
python3 tools/mw_ax_dump.py \
  --repo . \
  --capsule srf-id-judge \
  --site example-site \
  --out /tmp/ax_snapshot.json
```

### C. Record and Compile a Demo (`tools/mv_demo.py`)

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

The Terminal buttons keep their distinct purposes: **Automate** creates a
reviewed workflow from a demonstration, **Use automation** selects a stored
workflow, and **No automation** runs an observed goal without storing a workflow.
For an account-free judge, choose `--planner rules` (the default). It invokes the
locked Wender rules CLI without Muse. `--planner muse` needs Muse Code installed
and authenticated with a Muse account; it sends marks to that provider. There is
no automatic fallback from rules to Muse.

Read `tools/mw_run_browser_goal.md`. Copy the selected capsule's **Copy ID for AI**
identity and the running app's **Copy env path** (`METAVIEWER_ATTACH`). Source the
copied absolute path in a subshell with
`set -a; . "<copied-current.env-path>"; set +a`; it changes `XDG_RUNTIME_DIR`. It supplies
`MV_CORE_CONFIG`, `XDG_RUNTIME_DIR`, `MV_SRF_STATE_DIR`, `MV_SRF_BIN_DIR`,
`SRF_IDENTITY_STORE_ROOT`, and configured dependency roots. Missing pinned roots
must come from the operator. Release human control before running.

From the checkout, replace the placeholders and choose one unique exact visible
AX control name, one goal per run:

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
`--site`, `--workflow` or `--slot` flags. Vision cross-checking is not implemented.

Until the compiled browser build lands, this branch returns
`MW_COMPILED_BROWSER_UNAVAILABLE` for compiled Wender with either planner. Obtain
a verified `deps.lock` checkout as `MV_WENDER_ROOT` and unset
`MV_WENDER_EXECUTABLE` in the subshell, or wait for that build. Never bypass the
refusal. Program compiled support does not establish browser support.

### F. Programs and Host program (`--surface-kind program`)

Read `tools/mw_run_program.md`. Start an Agent program capsule in the UI,
including **Host program** for host-xpra, and copy its returned identity. Release
human control and verify `control:'agent'`. Source the same app attachment and
supply locked dependencies, including `VQA_VE_ROOT` for a checkout setup. Host
program uses `MV_SRF_STATE_DIR`; legacy container programs also need their native
identity configuration. This runner does not launch a program or attach an
arbitrary Desktop window. Choose a unique currently observed element name:

```sh
export XDG_STATE_HOME="$(mktemp -d /dev/shm/metaviewer-program.XXXXXX)"
PYTHONPATH=agents python3 -m metaviewer_agents.mw_run \
  --surface-kind program --identity '<program-profile>' --planner rules \
  --goal 'Exact observed element name' --steps 1
```

This requests one click [TARGET]; programs do not accept text/key input. Both
goal lanes require owned private RAM evidence under `/dev/shm`, without symlink
ancestors. Keep the output report/receipt paths and inspect them before shutdown.

| Result / rc [CITED: goal runner `run_entry` functions and `mw_run.py` (`main`)] | Next action |
| --- | --- |
| `BROWSER_BOUNDED_ACTIONS_VERIFIED` or `PROGRAM_BOUNDED_ACTIONS_VERIFIED` / `0` | Check receipts and fresh visible outcome; verified actions do not prove goal completion. |
| argparse error / `2` | Fix syntax or action budget before running. |
| `HUMAN_HANDOFF` / `4` (browser) | Person takes control, resolves login/CAPTCHA, releases control and observes the new state before a fresh goal. |
| `INPUT_UNCERTAIN` / `5` | Stop; inspect dispatch/receipt/report evidence with the operator. Never automatically retry. |
| refusal / `6` | Inspect the named verdict and earlier moves; repair the precondition before a fresh run. |

`MW_PROGRAM_CONTROL` requires **Release control** and verified agent control.
`MW_RUN_ATTACH`/`MW_RUN_CONFIG` requires the current app attachment.
`MW_PROGRAM_RAM_REQUIRED`/`MW_PRIVATE_OUTPUT` requires the private RAM setup.
`MW_PROGRAM_GOAL_UNGROUNDED` requires a unique observed target.
`MW_COMPILED_BROWSER_UNAVAILABLE` requires the browser checkout route above.
A traceback without JSON also requires stopping and operator inspection.

---

## 13. What Is Not Supported (Honest Limitations)

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
   Program and Host program runs admit clicks only; typing into programs and
   automation of Desktop window capsules are unsupported. The program lane has
   been demonstrated on a Mines move, not arbitrary applications. Explicit
   `--planner muse` sends marks to a provider. A verified action is not a finished
   goal. Browser role switches currently recreate the capsule and can lose the
   open page; preserved profile login state does not prove page continuity.
4. **Rootless Docker and Docker Desktop Are Refused for Tier 2**:
   OpenSuperficies capsule isolation requires the local rootful Linux Docker daemon
   (`JUDGE_DOCKER`, `JUDGE_DOCKER_DESKTOP`, `JUDGE_DOCKER_HOST`).

### Legacy kit proxy setup

The sudo-free fallback calls the kit's `srf-identity-surface net up` with
`--proxy-bin` pointing to the kit's `srf-egress-proxy`. The launcher selects the
proxy entrypoint, internal network and bridge attachment and verifies
`EGRESS_PROXY_READY`; it refuses an existing incompatible proxy without replacing it.
Private metadata lives under `$MV_JUDGE_HOME/network`: separate `policy/`,
`registry/` and `audit/` directories (mode `0700`), with policy and registry files
at `0600`. The x64 source runs the proxy with the CLI caller's UID/GID, so these
files stay owned by the judge user. Profile directories still use Docker to
provision the browser UID separately. Run passes this same registry to capsules.

The initial `policy/policy.json` uses `browserid.proxy-policy/v1` with empty
`approved`, `denied` and `connect_ports` collections. It grants no destinations.
Existing policy files are retained. This upstream schema supports exact capsule
IDs and normalized hosts only: public browsing requires explicit `approved`
entries and HTTPS `connect_ports` entries for each capsule and host. Leave
`private_targets` absent to retain LAN/host blocking. Arbitrary public browsing
is not available through this policy schema; no wildcard policy is implied.

The x64 kit supplies browser image `0.1.1`. If a binary advertises Open and the
firewall witness is present, preflight requires `0.2.0` and refuses that image set.
Retagging `0.1.1` would not establish Open support; the upstream source disables
Open for its default image. Use `--no-firewall` with that kit.
