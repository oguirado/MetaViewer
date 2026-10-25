# Byobu/tmux terminal workspaces for Holdings / MetaViewer / Cafe capsules

Design synthesis (read-only inputs). An operator ruling admits capsules that
host complex, pre-arranged terminal environments launched with zero manual
setup, each supervised by the AI in that capsule's terminal. This document
reconciles that ruling with the B06 recommendation and the sealed UI
architecture. Every claim cites an answer id (B01-B06) or a local file:line;
anything not established is marked [TARGET] or AUSENTE (citation residue ignored).

Inputs: ANSWERS.md (B01-B06)
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:5-1333`;
queries
`docs/research/queries.byobu.v1.json:1-8`;
sealed architecture sections 6-7
`docs/UI_ARCHITECTURE.md:160-268`;
broker prep: `<CAMPAIGN_VQA_WS>/T7PTY-drop/pty-broker/broker.mjs:1-120`, `<CAMPAIGN_VQA_WS>/T7PTY-drop/pty-broker/README.md:1-142`, `<CAMPAIGN_VQA_WS>/T7PTY-drop/pty-broker/broker.test.mjs:1-60`.
Local facts: byobu 6.11 [MEASURED], tmux 3.4 [MEASURED], screen 4.09.01
[MEASURED]; xterm.js 6.0.0, node-pty 1.1.0, Electron 44.9.2 brief-stated.

## 1. Recommended architecture (from B06)

B06's default is (a): one backend-owned PTY per terminal, rendered as native
Dockview panels, with PTYs and agent supervisors in a broker outside the
renderer (B06,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:1166-1169`).
Option (b), one tmux session per capsule in a single xterm.js, applies when a
capsule intentionally represents a persistent Linux workspace whose internal
layout belongs to tmux. Option (c), control mode mapped to native panes,
applies only when tmux-owned execution persistence and native Dockview
presentation are both non-negotiable, and is a substantial integration
project (B06,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:1307-1333`).

For capsules admitted by that ruling (pre-arranged multi-pane environments, zero setup, AI
supervision) the synthesis is therefore: **(b) with plain tmux per capsule,
plus broker-side pane inspection for the AI** — not Byobu's UI, not (c) as
the foundation. Reasons, all from B06
(`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:1171-1199`):

- Renderer reload alone never justifies tmux: moving execution ownership out
  of the renderer already solves it. tmux is justified here by the
  pre-arranged multi-pane workspace requirement, not by reload survival.
- (b) keeps one frontend emulator per capsule while tmux still owns one PTY
  per internal pane and composes the display; cheapest route to a persistent
  Unix workspace at medium integration complexity.
- "Use plain tmux rather than Byobu for an embedded product": Byobu adds
  profiles, keybindings and status UI that overlap application-owned UI, and
  is not an additional persistence engine (B06,
  `<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:1275-1291`).
  Consistently, Byobu over control mode does not preserve the Byobu
  interface (status bars, window list, copy/choose rendering stay behind);
  the integration target must be the underlying tmux server (B02,
  `<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:534-558`).
- (c) solves transport, not integration: no copy/choose-mode output as pane
  bytes, geometry still exists, reconnect needs inventory plus race
  handling, popups have no `%popup-*` protocol on 3.4 (B02/B06,
  `<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:482-533`).

| Option | Use when | Price |
|---|---|---|
| (a) PTY per pane | Default capsules, native Windows | Own replay/restore design |
| (b) tmux per capsule | Pre-arranged Linux workspace | Two layout managers |
| (c) control mode | tmux exec plus native views | Protocol, restore, geometry |

What survives a renderer reload under (b): tmux server, pane PTYs,
supervised processes, and the broker-owned registry, collectors and journal,
which live outside the renderer (B06,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:1200-1232`;
sealed attach model,
`docs/UI_ARCHITECTURE.md:183-200`). What
does not survive and must be rebuilt: xterm.js views, attachment bindings,
and the visible screen — reattach a fresh client and take a fresh redraw
rather than replaying a truncated VT log, since terminal output is stateful
(buffer switches, cursor, modes) (B03,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:710-719`).
No option survives OS reboot (B06,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:1200-1232`).
Fold/resize/move/popout change presentation only; capture and agent continue
(`docs/UI_ARCHITECTURE.md:160-182`).

How the AI observes the panes: never through the composed outer xterm
stream. The broker gives the agent pane-specific inspection — bounded
`capture-pane` snapshots, a `pipe-pane -O` collector, or a separate
control-mode observer (`%output` tagged by stable `%pane` id) — plus
structured job events kept outside terminal output (B06,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:1233-1274`;
B04,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:822-887`).
Choosing (b) for presentation does not weaken AI observability: a normal
tmux view can serve the human while a control-mode observer serves the
agent; enforce per-terminal single-writer input ownership so human and
agent keystrokes never interleave (B06,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:1233-1274`).

## 2. Terminal workspace profile format

Why an app-owned schema: Byobu named startup files (`windows.tmux.NAME`,
selected by `BYOBU_WINDOWS=NAME`) are tmux command scripts, not a
declarative workspace language, and `byobu-layout save|restore` saves split
geometry only — never each pane's command, arguments and environment, which
must be declared explicitly (B01,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:5-60`).
tmuxp/tmuxinator combine a pane list with a separate layout string rather
than a recursive split tree, and tmuxp does not set pane titles (B01,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:5-60`).
Zellij KDL is the native recursive model to mirror, but the executor here
stays tmux (B01,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:120-175`).
B01's explicit recommendation for this case is an app-owned versioned
YAML/JSON split tree compiled into tmux commands (B01,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:176-233`).

Schema `terminal-workspace/v1` ([TARGET] field set; shape follows B01):

- `version: 1`, `session` (logical name; socket gets an opaque id),
  `cwd` (project root, resolved to absolute by the launcher).
- `env`: mapping, filtered through the section 4 allowlist.
- `windows[]`: each has `id`, `name`, and a `layout` tree. Interior nodes
  are `{axis: columns|rows, children[]}`; children carry `weight` (ratio)
  and either a nested axis or a `pane` leaf. Prefer ratios over fixed cells
  (B01,
  `<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:176-233`).
- `pane` leaf: `id` (stable within profile), `title`, optional `cwd`
  (relative to profile `cwd`), `argv[]` (executable plus arguments, never
  shell text), optional `ready` (probe reference, see section 3), optional
  `onExit: retain|respawn|close`.

Holdings example (game log plus lane monitor plus AI pane) [TARGET]:

```yaml
version: 1
session: holdings-game
cwd: /abs/holdings
env: {LANG: C.UTF-8}
windows:
  - id: ops
    name: Ops
    layout:
      axis: columns
      children:
        - weight: 50
          pane: {id: game-log, title: GameLog,
            argv: [holdings-log, --follow]}
        - weight: 30
          pane: {id: lane-mon, title: Lanes,
            argv: [holdings-lane, --watch]}
        - weight: 20
          pane: {id: ai, title: AI,
            argv: [holdings-agent, --capsule, game]}
```

MetaViewer example (program capsule plus logs plus AI) [TARGET]:

```yaml
version: 1
session: metaviewer-cap
cwd: /abs/metaviewer
windows:
  - id: cap
    name: Capsule
    layout:
      axis: rows
      children:
        - weight: 70
          pane: {id: program, title: Program,
            argv: [mv-program, --serve], ready: {http: 127.0.0.1:43125/health}}
        - weight: 30
          axis: columns
          children:
            - weight: 60
              pane: {id: logs, title: Logs, argv: [mv-logs, --tail]}
            - weight: 40
              pane: {id: ai, title: AI, argv: [mv-agent, --capsule, main]}
```

Zero-setup launch (all steps from B01,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:176-233`):

1. Bootstrap first: verify multiplexer, executables and project files exist
   (application bootstrap step).
2. Resolve profile-relative directories to absolute paths; set the launcher
   child's working directory explicitly.
3. Create the session detached with explicit initial dimensions.
4. Recursively split with explicit targets and `-l NN%` sizes (modern form
   for tmux 3.4, not legacy `-p`); capture pane ids with `-P -F
   '#{pane_id}'`; apply titles with `select-pane -T`.
5. Launch `argv` directly (tmux creation commands take
   executable-plus-arguments); never type commands via `send-keys`.
6. Attach only after construction succeeds; gate "ready" on explicit health
   checks, never on pane creation order.
7. Fix the repeated-launch policy: attach to, reject, or replace an
   existing session — never silently duplicate servers.
8. Treat manifests as executable content: authorize profile commands before
   running an untrusted repository's workspace.

## 3. AI supervision contract

Shape: a deterministic policy-enforcing broker between the AI and tmux. The
AI gets typed operations (`inspect`, `submit`, `cancel`), never raw tmux
command strings; each run binds `{server, pane_id, run_id, generation}`
with stable `%pane` ids; workloads launch as approved executable plus argv;
structured lifecycle state lives outside the terminal; all application
output is untrusted data (B04,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:780-821`).
This matches the sealed rules: no raw SendStdin or focus-implies-permission;
structured intent submission only; dispatch eligibility rechecked under a
slot lock with `ready`/`waiting-input` only
(`docs/UI_ARCHITECTURE.md:183-200`,
`docs/UI_ARCHITECTURE.md:240-257`).

Reading output (B04,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:822-887`;
protocol B02,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:268-352`):

- `capture-pane`: bounded snapshots (`-p -J -S -200`; `-S - -E -` for all
  history; `-a` for the alternate screen). Never diff repeated captures
  into a pseudo-stream.
- `pipe-pane -O`: continuous collection into a fixed administrator-owned
  collector (one pipe per pane; the command field is shell-interpreted, so
  never interpolate untrusted strings). `-I` is input, not logging.
- Control-mode observer: prefer `-C` over pipes; parse
  `%begin`/`%end`/`%error` blocks separately from notifications; decode
  `%output` octal escapes at the byte level; handle `%layout-change`,
  `%window-add/close`, `%exit` (no `%pane-add` exists — reconcile
  inventory). With `pause-after` flow control, resync via fresh capture
  after any pause or reconnect and record an observation gap.

Readiness and completion (B04,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:888-930`):
readiness hierarchy is validated IPC event, then real health probe, then
trusted wrapper report, and terminal-output patterns only as a heuristic —
never silence duration, shell prompt, `pane_current_command`, or a "Ready"
substring. Completion requires the pane to run the task directly (or a
wrapper preserving exit status) with `remain-on-exit` set before start,
then reading `#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}`;
distinguish pane exit, tree stop, job success, and collector flush as four
separate conditions. The sealed architecture agrees: process existence or a
frame alone cannot prove ready; silence, ANSI titles and regex are not
completion
(`docs/UI_ARCHITECTURE.md:160-182`,
`docs/UI_ARCHITECTURE.md:217-239`).

Input (B04,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:931-989`):
three interpretation layers (broker-to-shell/tmux, tmux-to-terminal,
terminal-to-application) need separate controls. Default is admitted
structured intents only. The tmux fallback is `send-keys -l -- '<text>'`
with `-l` meaning literal keys, not safe data: it does not neutralize
embedded newlines or shell metacharacters, so reject CR/LF/ESC and other
controls, allow special keys only through a small [TARGET] enum (never
model-generated key names), serialize all writers per pane, and keep
single-writer ownership per pane. Bulk text goes through broker-generated
named buffers (`load-buffer` from stdin, `paste-buffer -d -p`); bracketed
paste is compatibility, not authorization. Never leave a reusable shell
under an unattended task. Sealed rule: paste is staged, inspected and
explicitly sent; terminal-generated responses are never human intent
(`docs/UI_ARCHITECTURE.md:258-268`).

Hooks and wake-ups (B04,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:990-1023`):
`set-hook -g pane-died 'wait-for -S supervisor-pane-change'` wakes the
broker, which then reconciles registered runs (`pane-died` for retained
panes; configure both lifecycle paths if retention varies). `wait-for`
channels are unique per run plus generation; publish structured state
first, signal second, validate on wake, reconcile on timeout; never hand
the tmux socket to a hostile workload just for `wait-for`. Hooks stay
short: no network, blocking collectors or AI decisions inside them.

Audit (B04,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:1024-1042`):
two records — terminal evidence (bytes, pane/run/generation, seq, gaps)
and a broker action journal (request, decision, exact input, target,
acknowledgment, observation). Log the decision before delivery; store
outside the workload filesystem; escape controls in viewers; record
redactions, gaps and cancellations; bound storage. Sealed constraint:
credentials never enter UI/protocol/logs; raw ANSI disk logs are rejected
(`docs/UI_ARCHITECTURE.md:258-268`).

## 4. Isolation and security

Threat model first: one tmux server per capsule isolates control planes, it
is not a sandbox. Same-user processes can inspect each other; untrusted
code needs a distinct account plus namespaces/containers or a VM (B05,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:1068-1071`).
Keep the socket behind the broker; tmux warns against exposing server
access to untrusted users even read-only (B04,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:780-821`).

One socket per capsule (B05,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:1072-1087`):
`tmux -L "capsule-$(uuidgen)" -f <trusted-conf> new-session -d ...`, one
server per capsule, keeping sockets under tmux's protected per-UID
directory (never predictable names in world-writable paths). Use `-S
/abs/path` only with a self-managed `0700` parent directory, verified
ownership, and unguessable ids — never attacker-controlled paths or
symlinks.

Environment allowlist (B05,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:1088-1108`):
start each server with `env -i` and a minimal explicit set (`HOME`, `USER`,
`LOGNAME`, `SHELL`, `PATH`, `LANG`, `TERM`, ...); exclude credentials and
agent endpoints (`SSH_AUTH_SOCK`, `SSH_AGENT_PID`, cloud/API tokens,
`KUBECONFIG`, `*_TOKEN`, keyring variables). Never pass secrets through
pane commands, titles, logs or environment — use a per-capsule credential
broker or short-lived restricted files. The existing PTY broker already
implements this pattern: fixed `ALLOWED_ENV_KEYS`, broker-wins `PATH`,
`BLOCKED_ENV_RE` credential filter, 4096-byte value caps
(`<CAMPAIGN_VQA_WS>/T7PTY-drop/pty-broker/broker.mjs:13-60`,
`<CAMPAIGN_VQA_WS>/T7PTY-drop/pty-broker/README.md:99-110`); the tmux launcher must reuse it.

Resource caps (B05,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:1109-1129`):
run each capsule server inside one cgroup via `systemd-run --user --scope
--collect --unit=myapp-capsule-<id>.scope` with `CPUQuota`, `MemoryMax`,
`TasksMax` (generous for compilers/servers, low enough to contain fork
bombs), `TimeoutStopSec` and `KillMode=control-group`. Durable
app-managed capsules should use a transient `.service`/template unit
instead of a scope for monitoring and reliable stop. systemd availability
on the target desktop is [TARGET] to confirm; a non-systemd fallback
(setrlimit/process-group kill) is AUSENTE.

Teardown (B05,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:1131-1145`):
two phases — `tmux -L <id> kill-server`, then stop the owning unit so the
whole cgroup dies (bounded `TimeoutStopSec`, `SendSIGKILL=yes`); killing
only tmux's PID orphans shells and grandchildren. Remove only validated
capsule-owned directories under an application root; never `rm -rf
/tmp/tmux-*`. This matches the sealed rule that owned process trees are
reaped at shutdown and the broker is a supervised effect service, not a
second authority
(`docs/UI_ARCHITECTURE.md:258-268`).

Multi-user (B05,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:1146-1157`):
default is no sharing — one account, separate runtime/state dirs, no shared
group. Collaboration, if ever needed, is explicit: dedicated group plus
directory, `server-access` grants to named accounts only, treating the
session as shared terminal access. Never mix tenants in one Unix account.

## 5. xterm.js settings and pitfalls

Baseline stack: xterm.js ↔ IPC ↔ node-pty ↔ tmux client ↔ pane PTYs, with
one xterm instance and one outer node-pty per attached tmux client — tmux
already composes its panes (B03,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:582-589`).

Identity and color (B03,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:590-652`):
spawn node-pty with `name: xterm-256color` and fitted cols/rows; keep outer
`TERM=xterm-256color` distinct from inner `TERM=tmux-256color` set via
`default-terminal`; never export the outer TERM from shell startup files.
Verify `tmux-256color` terminfo everywhere (`infocmp -x`), else fall back
to `screen-256color` (loses italics). tmux baseline: `terminal-features
',xterm-256color:RGB'`, `mouse on`, `focus-events on`, `history-limit
10000`, `escape-time 10`, `status-interval 5`, `set-titles off`. `tmux -2`
forces 256 colors, not true color. Rendering policy: `minimumContrastRatio:
1`, `drawBoldTextInBrightColors: false`.

xterm options (B03,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:653-676`):
`scrollback: 1000` (tmux owns real history), `convertEol: false`,
`allowTransparency: false`, `smoothScrollDuration: 0`, bundled monospace
font, `customGlyphs: true`; on v6 leave `reflowCursorLine: false`. v6
removed `windowsMode` and the canvas renderer — never copy v5 config
blindly.

Mouse, keys, paste (B03,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:677-691`):
let tmux own mouse modes (SGR 1006); keep a modifier-based local-select
path (Shift-selection; `macOptionClickForcesSelection` on macOS); never add
a second unconditional wheel handler; forward all `onData` (including
terminal replies, mouse reports, focus events) to the PTY and handle
`onBinary` separately; reserve Electron shortcuts narrowly (Byobu uses
F-keys heavily; v6 dropped an Alt-to-Ctrl-arrow hack); start `escape-time`
at 10 ms and never split one input escape sequence across delayed IPC
messages.

Resize and geometry (B03,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:692-709`):
single path container-observe → fit → `pty.resize(cols, rows)`; fit only
when attached/visible with valid dimensions; coalesce storms and ignore
duplicates; never subtract status rows in Electron (tmux owns that grid);
tmux re-layout is not xterm reflow; pick `window-size` deliberately
(`latest` default) and consider `ignore-size` for auxiliary clients; test
narrow widths, zoom, popout drags, and second-client attach.

Scrollback and restore (B03,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:710-719`):
tmux copy mode is the history UI (outer scrollback cannot track
multi-window tmux); budget ~1000 outer rows plus 10000 tmux lines per pane,
set before creating panes; never disable alternate-screen to fake
scrollback; on renderer recreation, attach fresh and redraw.

Unicode and rendering (B03,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:720-731`):
valid UTF-8 locale in the PTY env (`tmux -u` declares, does not install);
pin a Unicode-width policy (width addons are compatibility changes needing
tests); separate glyph coverage from cell width; prefer known-width status
symbols; targeted `codepoint-widths` overrides only for verified
disagreements.

Performance (B03,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:732-748`):
WebGL with working DOM fallback (v6 has no canvas fallback); acknowledge
output only in `term.write(chunk, callback)`; start watermarks at
100 KB/10 KB high/low (below ~500 KB); pause/resume the PTY at watermarks
(the broker already exposes pause/resume ops,
`<CAMPAIGN_VQA_WS>/T7PTY-drop/pty-broker/README.md:80-88`); batch small frames in order, never drop
bytes to catch up; keep flow-control tokens out of shell input; cut
`#(command)` polling and expensive status scripts before blaming the
renderer.

Release pitfalls (B03,
`<CAMPAIGN_OSCU0>/w8/pplx/out/holdings_byobu/ANSWERS.md:749-770`):
launch `byobu-tmux` explicitly if Byobu is assumed, else `status off` when
Electron owns all chrome; never ANSI-strip or re-split the VT stream before
`term.write()`; leave `allow-passthrough` off (tmux 3.3+); treat titles,
hyperlinks and OSC 52 clipboard as untrusted (the broker already blocks
OSC 52 and non-navigating links,
`<CAMPAIGN_VQA_WS>/T7PTY-drop/pty-broker/README.md:114-129`); run the RGB/mouse/drag/paste/Unicode/
resize/second-client/`yes`-plus-Ctrl-C acceptance suite inside and outside
tmux.

## 6. Unit plan for after TP7 (at most 4 units)

Paths below are [TARGET]; no implementation exists yet (broker prep only
covers the single-PTY side,
`<CAMPAIGN_VQA_WS>/T7PTY-drop/pty-broker/README.md:114-129`). Each unit lists files, tests, and
negatives.

### U1 — Profile compiler and zero-setup launcher [TARGET]

- Files: `byobu-ws/profile/` with `schema.mjs`, `compiler.mjs`,
  `launcher.mjs`, `holdings.yaml`, `metaviewer.yaml`.
- Tests: golden tmux argv for both example profiles; pane-id capture and
  title application on tmux 3.4 [MEASURED version]; repeated-launch
  attach/reject/replace policy; readiness gate blocks attach until probes
  pass.
- Negatives: missing executable fails before any session exists; duplicate
  launch never spawns a second server; untrusted manifest commands refused
  without authorization; absolute-path escape outside profile root refused.

### U2 — Supervision broker: observe, input, audit [TARGET]

- Files: `byobu-ws/broker/` with `observer.mjs`, `readiness.mjs`,
  `input.mjs`, `hooks.mjs`, `journal.mjs`.
- Tests: bounded capture plus gap recording on pause/reconnect; readiness
  state machine (STARTING/READY/RUNNING/EXITED plus failure/cancel/gap);
  exit status read only after `pane_dead`; hook wake-up reconciles runs;
  journal shows decision-before-delivery with redacted secrets.
- Negatives: composed outer stream never fed to the agent as pane truth;
  newline-bearing literal input refused; arbitrary key names refused;
  `send-keys` success never reported as task completion; hook handler does
  no blocking work.

### U3 — Per-capsule isolation and lifecycle [TARGET]

- Files: `byobu-ws/capsule/` with `socket.mjs`, `env.mjs`, `cgroup.mjs`,
  `teardown.mjs`.
- Tests: socket unpredictable and unreachable cross-capsule; child env
  contains allowlist only (probe for `SSH_AUTH_SOCK`, `*_TOKEN`);
  `TasksMax`/memory caps contain a fork bomb [TARGET thresholds];
  teardown leaves no surviving grandchildren.
- Negatives: predictable/shared socket names refused; `-S` path outside
  owned root refused; cleanup never touches `/tmp/tmux-*` broadly;
  second-consumer/shared-tenant access refused by default.

### U4 — xterm attach, restore and acceptance [TARGET]

- Files: `byobu-ws/view/` with `attach.mjs`, `options.mjs`,
  `acceptance.mjs`.
- Tests: resize path delivers fitted grid once per change; reload restores
  via fresh attach plus redraw with no skipped VT bytes; backpressure
  pause/resume round-trips with the broker; RGB/mouse/Unicode/second-client
  cases pass inside and outside tmux.
- Negatives: hidden/zero-size containers never resize the PTY; status rows
  never subtracted in the view; `yes`-flood plus Ctrl-C stays responsive
  with no dropped bytes; unreviewed OSC/link/clipboard actions stay
  disabled.
