# MetaViewer User Guide

I built MetaViewer as a desktop AI viewer: a wall of live, isolated application
surfaces where I watch an agent work and take control myself at any time. Every
action is admitted by the Rust core and journaled; the UI only renders state
and submits intents, it never injects input directly.

This guide covers installing and launching the app, the window layout, opening
surfaces, watching the agent, taking control, status indicators, replaying a
session, `mvctl` basics, the multislot screen with recording, and
troubleshooting.

## 1. Install and launch

I develop and test on Linux. There is no packaged
installer yet: a packaged desktop app is planned for v0.2.0 [TARGET]. For now I build
and run each component from this repository.

### Prerequisites

| Tool | Version | Where I pin it |
| --- | --- | --- |
| Rust | 1.97 [CITED] | `Cargo.toml:9` (`rust-version`) |
| Go | 1.26.0 [CITED] | `daemon-adapter/go.mod:3` |
| Node | >= 24 [CITED] | `ui/package.json:7-8` (`engines`), `ui/README.md:3` |
| Python | >= 3.11 [CITED] | `agents/pyproject.toml:4` |
| Electron | 44.9.2 (pinned) [CITED] | `ui/package.json:24`, `ui/electron/main.js:57` (`ELECTRON_PIN`) |
| Capsule UI kit checkout | commit in `ui/kit.lock.json:3` [CITED] | `ui/README.md:9-22` |

The Python agents have no dependencies to install (`agents/pyproject.toml:5`
lists none). The UI kit is consumed from a local checkout set via
`CAPSULE_UI_KIT_REPO`; the sync tool rejects any other commit or digest.

### Build

```sh
# From ui/: stage the exact pinned kit, then install, test, check, build.
node ../tools/sync_kit.mjs "$CAPSULE_UI_KIT_REPO"
npm ci --offline
npm test
npm run check
npm run build
```

```sh
# From the repository root: build the Rust core.
cargo build --offline
```

```sh
# From daemon-adapter/: build the Go adapter into ./mv-daemon-adapter.
go build -o mv-daemon-adapter ./cmd/mv-daemon-adapter
```

I run the full gate with `tools/gate.sh` (the default run covers every leg).
The companion `TESTING.md` is planned for v0.2.0 [TARGET].
I verify the hosted Authority slice and, with the admitted live profile, the
real core, adapter, and browser with `node tests/e2e/e2e1_slice/index.js`
(`--live` for the real processes).

### Launch

Start the core first. It needs two environment variables: `MV_CORE_CONFIG`
pointing at a JSON file with `session_id`, one `core` registration, and
`peers` containing exactly one agent and one daemon registration [CITED], and
`XDG_RUNTIME_DIR` for the socket. Each registration carries a `hello/v0.2`;
the core entry refuses unless its `component_version` matches the build
(`0.1.1`). The session id may only use ASCII letters,
digits, `.`, `_`, `-`. The core listens on
`$XDG_RUNTIME_DIR/metaviewer/core.sock`:

```sh
MV_CORE_CONFIG=/absolute/path/to/core-config.json \
XDG_RUNTIME_DIR=/run/user/$(id -u) \
  ./target/debug/metaviewer-core
```

Then start the daemon adapter with no arguments. All of its configuration
comes from the environment: `MV_SRF_BIN_DIR`, `MV_SRF_STATE_DIR`,
`SRF_IDENTITY_STORE_ROOT`, `SRF_PROXY_REGISTRY`, and `XDG_RUNTIME_DIR` must
all be absolute paths; `MV_SESSION_ID`, `MV_CORE_INSTANCE`, and
`MV_DAEMON_INSTANCE` register it with the core. `MV_SRF_STATE_DIR` must be a
directory owned by the current user with mode `0700` [CITED]. One profile
source is also required: `MV_SRF_PROFILES` (a JSON object mapping profile ids
to capsule profiles), or the `MV_SRF_LIVE_PROFILE` + `MV_SRF_LIVE_RAM_ROOT`
pair. `MV_CONTRACT_DIR` defaults to `contracts/v0.2` relative to the working
directory, and `MV_COMPONENT_COMMIT` defaults to the build's VCS revision:

```sh
MV_SRF_BIN_DIR=/absolute/path/to/srf-bin \
MV_SRF_STATE_DIR=/absolute/path/to/srf-state \
SRF_IDENTITY_STORE_ROOT=/absolute/path/to/identity-store \
SRF_PROXY_REGISTRY=/absolute/path/to/proxy-registry \
MV_SRF_LIVE_PROFILE=/absolute/profile-id \
MV_SRF_LIVE_RAM_ROOT=/absolute/path/to/ram-root \
MV_CONTRACT_DIR=/absolute/path/to/contracts/v0.2 \
XDG_RUNTIME_DIR=/run/user/$(id -u) \
MV_SESSION_ID=my-session MV_CORE_INSTANCE=core MV_DAEMON_INSTANCE=daemon \
  ./mv-daemon-adapter
```

Then build the UI (`npm run build` from `ui/`) and open the shell. The
verified way to see the running shell today is the smoke runner, which needs
a local Electron distribution matching the pinned version and `xvfb-run`:

```sh
export ELECTRON_OVERRIDE_DIST_PATH="/absolute/path/to/local/electron/dist"
npm run smoke
```

Production startup additionally requires `MV_CORE_BOOTSTRAP` naming a trusted
absolute host module that exports `createMainBindings` (core and wire
bindings); without it the main process exits instead of guessing. The status
bar shows `Core connected` once the UI reaches the core. If it
shows `Core not connected`, the core is not reachable yet (see
[Troubleshooting](#9-troubleshooting)).

## 2. Window layout

The window is a kit shell with a top bar, a navigation rail, the capsule
wall, and a status bar:

- **Top bar.** Shows the `MetaViewer` product name, an `Add capsule` button,
  a `Find a capsule…` search field, `Terminal` and `Settings` buttons, a
  `Storyboard` button (enabled when a surface is selected), and an
  `Open in multislot` button (enabled when a surface is selected).
- **Rail.** A collapsible overlay sidebar with one `Workspace` group: an
  `Add capsule` entry plus one entry per connected surface. It floats as an
  overlay above the wall; pick an entry to reveal that surface.
- **Wall.** A dockable tile workspace with exactly one panel per capsule.
  Tiles are at least 240x200 pixels [CITED `ui/src/wall/WallWorkspace.vue:15-16`]
  and can sit in tabs, splits, or floating panels. With no surfaces admitted,
  the wall shows an empty workspace view with its own `Add capsule` action.
  The wall arrangement persists through the host layout bridge; if the layout
  service is unavailable the app refuses to start rather than guessing.
- **Side terminal.** A right-side overlay above the wall, toggled with the
  `Terminal` button. It floats without reflowing tiles, has a resizable
  separator, and remembers its open state and width. Its provider menu offers
  an interactive login shell plus any host-configured provider CLIs; with no
  host data it falls back to the shell-only menu. It stays hidden while the
  multislot screen is open.
- **Activity strip.** Above the status bar, a strip lists the newest outcome
  entries first: one per intent acknowledgement or propose verdict, in closed
  human sentences; raw reason codes never appear as text.
- **Status bar.** Shows a `Main wall` crumb, a `Core connected` /
  `Core not connected` feed indicator, and a caption with the capsule count
  (`N capsules`, or `Ready when you are` when empty).
- **Settings.** The `Settings` button opens a settings screen with the
  `Light` / `Dark` color scheme switch (`mv-light` is the default).

I switch the whole window between light and dark from Settings; the choice
applies live.

## 3. Opening a capsule surface

I click `Add capsule` in the top bar, the rail, or the empty-wall view. A
dialog titled `Add capsule` opens with the prompt `Choose a capsule kind to
open in your wall`, a search field, and one card per known kind:

| Kind | Label |
| --- | --- |
| `identity-browser` | Identity browser |
| `program` | Program |
| `holdings-app` | Holdings app |
| `desktop` | Desktop |

These four launcher kinds [CITED] are the closed set for now. I search, move
with the grid arrow keys, press Enter to open or Escape to close; focus
returns to the button that opened the dialog. Choosing a kind sends a create
intent to the core, which admits it and publishes the new surface row; the
wall then reveals the tile. Unknown or malformed catalog entries render as
typed error rows instead of cards, and an empty search shows
`No capsule kinds match this search.`

The core also carries a frozen catalog authority (kinds `browser`, `program`,
`vm`, `game_capsule`, `desktop_capsule`; host configuration supplies entries
and launch targets). The launcher dialog still offers only the closed
four-kind set above, so catalog management beyond it is planned for
v0.2.0 [TARGET].

## 4. Watching an agent act

Each tile shows one bound surface: a live canvas plus a read-only witness
strip with the frame handle, generation, and digest. Tiles key frames by
`frame_ref/v0.2` (surface, generation, tick, timestamp, dimensions). A tile
whose surface is agent-controlled shows the `agent-acting` state. Capture
keeps running behind the tile even while it is folded or a control request is
refused; only destroyed, lost, or unknown lifecycles stop capturing.

Tiles I can see:

| Tile | Meaning |
| --- | --- |
| `live` | Admitted surface with fresh frames. |
| `agent-acting` | Agent-controlled surface with fresh frames. |
| `human-control` | I hold control of this surface. |
| `folded` | Folded presentation; capture continues behind it. |
| `connecting` | Waiting for the first frame or binding. |
| `lost` | Destroyed or lost backend lifecycle. |
| `error` | A typed refusal applies; the tile reads `Surface update unavailable`. |

The renderer also installs a zero-DOM agent-observation lane (no visual
output, no controls) that exposes a frozen snapshot for agents: they observe
through the core, the adapters, and that snapshot, never through an injector
in the UI. The full AI loop on Holdings is planned for
v0.2.0 [TARGET].

## 5. Take control and release control

I can take control from the agent at any time from the tile's control
action. Take control sends a `take_control` intent (`ui_intent/v0.2` with
the surface id) to the core, which closes admission for that surface, drains
or cancels the in-flight action, acquires ownership, and notifies the daemon
adapter and the agent. The tile switches to `human-control`. My interaction
invalidates pending agent proposals for that surface.

Releasing control sends `release_control`: the core refreshes the frame and
ownership before agent admission resumes, and the tile returns to `live` or
`agent-acting`.

If the core refuses, the tile reads `Surface update unavailable` and a banner
explains the outcome (see below). Folding a surface never revokes agent
ownership by itself, and pinning affects layout only.

## 6. Stale-frame and refusal indicators

Tile status labels I may see: `Live`, `Stale`, `Connecting`, `Waiting`,
`Destroyed`, `Lost`, and `Surface update unavailable`. The last one means a
typed refusal applies: the refusal code travels in the tile's
`data-error-code` attribute and the journaled verdict, never as visible text.
`Stale` means the transport feed went stale while capture continues; the tile
keeps its last control axis (`live`, `human-control`, `agent-acting`, or
`folded`) underneath.

Refusal codes are kept distinct per refusal (never collapsed into one
message):

| Code | Meaning |
| --- | --- |
| `STALE_FRAME` | The frame is too old to act on. |
| `SURFACE_NOT_AGENT_CONTROLLED` | The surface is not under agent control. |
| `LOCKED_BY_OTHER` | Another owner holds the surface. |
| `BUDGET_EXCEEDED` | The action budget is exhausted. |
| `OUT_OF_BOUNDS` | The action targets out-of-range geometry. |
| `POLICY` | Core policy refused the request. |

Above the wall, an outcome banner reports each host request: `Request sent.`
when an intent is acknowledged, `Action admitted.` when a proposal is
admitted, or `This request is unavailable. Please try
again.` when the host refuses it. The banner text is fixed copy; host codes
never become visible text. The status bar's `Core connected` /
`Core not connected` indicator tells me whether the feed itself is up.

## 7. Replay of a session journal

The core appends every admitted record to a hash-chained journal at
`<state-dir>/sessions/<session-id>/journal.jsonl`, where `<state-dir>` is
`$XDG_STATE_HOME/metaviewer`, or `$HOME/.local/state/metaviewer` when
`XDG_STATE_HOME` is unset. Restarting the core with the same session id
recovers that journal; a different session id starts a new one.

I replay a journal offline with `mv-replay`:

```sh
./target/debug/mv-replay --journal <state-dir>/sessions/<session-id>/journal.jsonl \
  --witness-root <witness-root>
```

With `--verify-only` it checks the chain without printing the resulting
state hash. `--anchor` replays from a pinned anchor file. Exit codes [CITED]:
`2` for invalid input (including a corrupt journal), `3` for a duplicate
record, `4` for a witness failure. The journal references persisted envelopes
and prior-record digests; frame bytes stay outside the JSON, so outcome replay
needs the retained frame bytes or archived state witnesses.

## 8. mvctl basics

`mvctl` is the closed command-line client for core admission
(`agents/metaviewer_agents/mvctl.py`). It validates every flag, input byte,
and core reply, and leaves admission decisions to the core. It speaks the
legacy `envelope/v0.1` proposal protocol: it sends exactly one envelope and
prints one verdict [CITED]. I run it from `agents/`:

```sh
python3 -m metaviewer_agents.mvctl propose --json-arg envelope.json \
  --timeout-ms 5000 --max-line-bytes 65536 --max-reply-bytes 65536 \
  [--socket /absolute/path/to/core.sock]
```

(Values `5000`/`65536` are examples; any positive integers work.)

- `--json-arg` names a file holding exactly one `envelope/v0.1` whose body
  is an `action_proposal/v0.1` from `agent` to `core`.
- `--timeout-ms`, `--max-line-bytes`, and `--max-reply-bytes` are all
  required positive integers; no flag may be repeated.
- `--socket` must be an absolute path. Without it, `mvctl` uses
  `$XDG_RUNTIME_DIR/metaviewer/core.sock`.

With `--v02`, `mvctl` speaks the v0.2 tool protocol instead: `observe`,
`propose`, and `wait-verify` verbs with explicit `--socket`, `--session-id`,
`--agent-instance`, and `--core-instance` plus the same three limits.
`observe` takes `--surface-id`, `propose` takes `--json-arg`, and
`wait-verify` takes both:

```sh
python3 -m metaviewer_agents.mvctl --v02 observe --socket /absolute/path/to/core.sock \
  --session-id my-session --agent-instance agent --core-instance core \
  --surface-id surface-1 --timeout-ms 5000 --max-line-bytes 65536 --max-reply-bytes 65536
```

Refusals print one fixed JSON record to stderr (`{"verdict":"refuse",
"code":"…","error":"…"}`) and leave stdout empty; diagnostics never echo my
input. The legacy `observe` subcommand (without `--v02`) is a reserved
skeleton: it always refuses with `unsupported_operation` (exit code 2). For
v0.2 observation I use `mvctl --v02 observe`.

## 9. Troubleshooting

| Symptom | What I check |
| --- | --- |
| Status bar says `Core not connected` | Start the core first and confirm `$XDG_RUNTIME_DIR/metaviewer/core.sock` exists and is owner-only. |
| `MetaViewer cannot start: …` on boot | The layout service is unavailable; the app refuses to start rather than guessing. Check the main-process logs. |
| `This request is unavailable. Please try again.` banner | The host refused my last intent; the tile keeps its state. Retry, or check the tile status (`Surface update unavailable` means the last control request was refused). |
| Tile stuck on `Waiting` / `Connecting` | The surface is admitted but no frame arrived yet. Check the daemon adapter logs and the capsule backend. |
| Tile shows `Stale` | The feed went stale; capture continues. Check the core and adapter before acting. |
| Keystrokes do nothing in multislot | The input mode is `read`; switch it to `write` (see §10). |
| Recording export refused | Export needs a sealed recording and a host-advertised destination; otherwise the panel shows a typed refusal row. |
| `Creative service unavailable.` | The Storyboard screen has no wire schema yet; creative work is planned for v0.2.0. |
| Production shell exits on start | Set `MV_CORE_BOOTSTRAP` to a trusted absolute host module exporting `createMainBindings`, and run the pinned Electron 44.9.2. |
| `Popout is unavailable: this window denies new windows.` | Popout stays unavailable by design; use tabs, splits, or floating panels. |
| `npm run smoke` fails early | Set `ELECTRON_OVERRIDE_DIST_PATH` to a local Electron 44.9.2 distribution first; the runner never downloads one. It also needs `xvfb-run` and a successful `npm run build`. |
| `mvctl` reports `endpoint_error` | `XDG_RUNTIME_DIR` is unset or the socket is missing; pass `--socket` with an absolute path. |
| `mv-replay` exits 2, 3, or 4 | Invalid or corrupt input (2), a duplicate record (3), or a witness mismatch (4); do not trust the state hash. |

The AI loop on Holdings, catalog management beyond the launcher set, the
creative service, and packaged installs are all planned for v0.2.0 [TARGET].

## 10. Multislot screen, recording, and Storyboard

I open the multislot screen with `Open in multislot` (it needs a selected
surface); `Back to wall` returns. The multislot carries an operator input
mode, `read` or `write` (default `read`): `read` never delivers my
keystrokes, `write` delivers them unchanged, and unknown modes fail closed
to `read`.

The multislot screen embeds the recording panel for the selected surface.
Capture is RAM-first: the record axis runs through `idle`, `starting`,
`recording`, `stopping`, `sealed`, and `error`, plus a screenshot axis
(`idle`, `capturing`, `done`, `error`). Export reaches disk only through an
explicit host-advertised destination and only for sealed recordings;
otherwise the panel shows typed refusal rows (`No export destination
advertised by the host`, `Only sealed recordings can be exported`).

The top-bar `Storyboard` button opens the creative screen for the selected
surface, but creative service operations have no wire schema yet, so every
operation reports `Creative service unavailable.`

## Further reading

- [Project overview](../README.md)
- [Architecture](ARCHITECTURE.md)
- [UI architecture](UI_ARCHITECTURE.md)
- [Roadmap](ROADMAP.md)
- [Pre-existing components declaration](PREEXISTING.md)
- [Contracts v0.2](../contracts/v0.2/README.md)
- [Electron shell notes](../ui/README.md)
- [Python adapters](../agents/README.md)
- [License](../LICENSE)
