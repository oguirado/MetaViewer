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
with its own virtual X11 display (`:100`..`:103`) and streams the live surface into
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

`metaviewer-judge.sh run` configures four browser profile slots (`judge` on `:100`,
`mv-live-2` on `:101`, `mv-live-3` on `:102`, and `mv-live-4` on `:103`) sharing
`$MV_JUDGE_SHM_DIR/vqa-ramws/opensuperficies/os-cu-0` in `MV_SRF_PROFILES`. That
pool lets you run up to **4 concurrent browser or program capsules** out of the box
(subject to available RAM).

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
- **Move a capsule to another desktop**: Click **`Move to ▾`** in the tile header
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

### B. `Program` (`kind: "desktop_capsule"`, `program: "host-exec"`)

Runs a Linux GUI or CLI binary inside an isolated `opensuperficies-program-host:0.1.0`
container on a display from the identity display pool (`:100`..`:103`):

1. Choose **`Program`**.
2. Select an identity slot (or create a `program`-kind identity).
3. Enter **`Binary name`**: a bare binary executable name (letters, digits, `.`, `_`,
   `+`, `-`, 1–64 chars, no slashes — e.g. `xterm`, `xcalc`, `gedit`, `galculator`).
4. Optional **`Arguments (one per line)`**: up to 16 arguments, one per line.
5. Click **`Launch`**.

### C. `Desktop window` (`kind: "x11_window"`)

Captures an existing X11 window from the host X11 server into a tile:

1. Choose **`Desktop window`**.
2. Select a discovered window from the list (or enter a hex X11 Window ID such as
   `0x02400007`).
3. Click **`Capture window`**.
- **Important**: Only real X11 windows with a numeric X11 `windowId` can be
  captured. Native Wayland windows do not expose an X11 window ID and cannot be
  captured.

---

## 7. Human and Agent Roles, Hand-off, and Emergency Takeover

Every browser capsule enforces a strict role state machine (`Role: human` vs
`Role: agent`) with a per-capsule menu (`▾` in the tile header) and a context bar at
the bottom of the tile:

| Current Mode | What the Human Sees | Available Actions |
| :--- | :--- | :--- |
| **Human mode (`Role: human`)** | Live interactive stream (`Interactive` badge). Bottom bar shows: *`Human mode — log in to the site, then hand over to the agent.`* | Click **`Mark as logged in`** (bottom bar) or **`I logged in`** (header) or **`Switch to agent mode`** (`▾` menu) to hand the capsule to AI agents. |
| **Agent mode, watching (`Role: agent`)** | Read-only live stream (`Watching` badge; `Agent ready` when idle, `Agent acting` when an agent is executing). Bottom bar shows: *`Agent mode — watching live (read-only).`* | Click **`Take control (emergency)`** (bottom bar) or **`Control`** (header) to immediately seize interactive control while keeping the capsule in agent mode, or **`Switch to human mode`** (`▾` menu) to revoke agent access completely. |
| **Agent mode, emergency override** | Interactive stream (`Interactive` badge). Bottom bar shows: *`Manual control active — agent actions are paused.`* | Click **`Watch read-only`** (bottom bar) or **`Release`** (header) to return to read-only watching, or **`Switch to human mode`** (`▾` menu). |

To stop and destroy a capsule container, open the tile's **`▾`** menu and click
**`Stop capsule`** (or click **`✕`** on the tile header).

---

## 8. `Copy ID for AI`

Every capsule tile header has an **`ID`** button (and **`Copy ID for AI`** in the
tile's **`▾`** menu).

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

### Opening the Terminal Drawer

- Click **`More ▾`** in the top bar and select **`Terminal`**.
- The drawer opens on the right (`460 px` wide) with numbered screens (**`Screen 1`**,
  **`Screen 2`**, …; click **`+`** to add a screen).
- Click **`More ▾ -> Open in multislot`** inside the terminal drawer to pop the
  current terminal screen out as a full tile on the desktop canvas (or **`Dock to side`**
  to return it to the side drawer).

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

Click **`Identities`** in the top bar (or **`More ▾ -> Identities`**) to:

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

Click **`More ▾ -> Use MetaViewer`** in the top bar to open the attachment modal:

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

## 12. Automation with `mw_run`, MemoryWeb, and `Automate from a demo`

MetaViewer integrates with **MemoryWeb (`wender-agent`)** to compile recorded
demonstrations into repeatable site graphs (`site.json` + `workflows/<workflow>.json`)
and execute them inside an isolated identity capsule via `metaviewer_agents.mw_run`.

### A. Check MemoryWeb Home Readiness (`tools/mw_home_check.py`)

```bash
python3 tools/mw_home_check.py --repo .
```

Reports `ready: true` when `wender-agent` is reachable (via `MV_MW_WENDER_ROOT` or
a sibling `wender-agent` checkout) and checks whether each site under
`$MV_MW_HOME/sites/<site>/` has both `site.json` and `workflows/<workflow>.json`.

### B. Dump Accessibility Tree from a Running Browser Capsule (`tools/mw_ax_dump.py`)

```bash
python3 tools/mw_ax_dump.py \
  --repo . \
  --capsule srf-id-judge \
  --site example.com \
  --out /tmp/ax_snapshot.json
```

### C. Record and Compile a Demo (`Automate from a demo` / `tools/mv_demo.py`)

Click **`More ▾ -> Automate from a demo`** in the top bar (or use `tools/mv_demo.py`
directly):

```bash
# 1. Record a demonstration bundle from a running browser capsule
python3 tools/mv_demo.py record \
  --bundle-dir /tmp/demo-bundle \
  --site example.com \
  --workflow smoke \
  --goal "Open the docs page" \
  --start-url "https://example.com/" \
  --capsule srf-id-judge \
  --step "click:More information"

# 2. Emit the authoring prompt for an AI to compile site.json + workflows/<workflow>.json
python3 tools/mv_demo.py prompt \
  --bundle-dir /tmp/demo-bundle \
  --memoryweb-home "$HOME/.local/share/metaviewer-memoryweb"

# 3. Validate the compiled site.json and workflow JSON against wender-agent
python3 tools/mv_demo.py check \
  --site example.com \
  --workflow smoke \
  --memoryweb-home "$HOME/.local/share/metaviewer-memoryweb" \
  --wender-root "${MV_MW_WENDER_ROOT:-$MV_WENDER_ROOT}"
```

### D. Run a Compiled MemoryWeb Workflow (`metaviewer_agents.mw_run`)

Click **`Run workflow`** in the **`Automate from a demo`** dialog, or run `mw_run`
from the CLI:

```bash
PYTHONPATH=agents python3 -m metaviewer_agents.mw_run \
  --identity judge \
  --site example.com \
  --workflow smoke \
  --slot 0 \
  --memoryweb-home "$HOME/.local/share/metaviewer-memoryweb" \
  --store-root "$HOME/.local/share/srf-identity-store"
```

Supported `mw_run` flags (verified against `agents/metaviewer_agents/mw_run.py`):

- `--identity <id>` (required): browser identity profile (`^[a-z0-9][a-z0-9-]{1,39}$`)
- `--site <domain>` (required): site directory under `$MV_MW_HOME/sites/<site>`
- `--workflow <name>` (required): workflow name under `workflows/<workflow>.json`
- `--slot <0..3>` (required): RAM workspace slot index (`os-cu-<slot>`)
- `--input key=value` (repeatable): workflow input parameters
- `--memoryweb-home <path>` (or `MV_MW_HOME`): MemoryWeb store directory (must be separate from `--store-root`)
- `--store-root <path>` (or `SRF_IDENTITY_STORE_ROOT`): OpenSuperficies identity store root
- `--ram-Base <path>` (default `/dev/shm/vqa-ramws/opensuperficies`): RAM workspace base directory
- `--bin-dir <path>` (or `MV_SRF_BIN_DIR`): directory holding `srf-identity-surface` and `srf-identity-admin`
- `--state-dir <path>` (or `MV_SRF_STATE_DIR`): OpenSuperficies runtime state directory
- `--display <:100..:199>` (default `:100`): container X11 display
- `--attach-capsule <uuid>` + `--attach-socket <path>`: attach to an already-running MetaViewer browser capsule instead of starting a standalone container

Always run `mw_run` inside a memory-capped scope on shared hosts:

```bash
systemd-run --user --scope -q -p MemoryHigh=6G -p MemoryMax=8G -p MemorySwapMax=0 -- \
  env PYTHONPATH=agents python3 -m metaviewer_agents.mw_run \
  --identity judge --site example.com --workflow smoke --slot 0
```

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
   mode (`kind: "x11_window"`) can only capture X11 windows that have a numeric X11
   window ID; native Wayland windows cannot be captured individually.
3. **Program Capsules Are Not Automated by `mw_run`**:
   `metaviewer_agents.mw_run` and MemoryWeb (`wender-agent`) automate **browser
   capsules** (`kind: "browser"`) via CDP / accessibility trees. Linux **Program
   capsules** (`kind: "desktop_capsule"`, `program: "host-exec"` running in
   `opensuperficies-program-host:0.1.0`) stream into tiles for interactive use and
   low-level `capsule.act` pointer/key events, but are **not** driven by `mw_run`
   or `Automate from a demo`.
4. **Rootless Docker and Docker Desktop Are Refused for Tier 2**:
   OpenSuperficies capsule isolation requires the local rootful Linux Docker daemon
   (`JUDGE_DOCKER`, `JUDGE_DOCKER_DESKTOP`, `JUDGE_DOCKER_HOST`).
