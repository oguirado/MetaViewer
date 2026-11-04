# Computer use in MetaViewer

An agent can arrange the wall, open a capsule, start a player in its paired terminal,
watch the result and explain what changed. This playbook turns that loop into
repeatable steps. It is drawn from **one live session, maintainer-reported;
receipts and recordings are not published here** [CITED: maintainer session account].
The examples are new, portable adaptations, not the original session scripts.
They have offline checks; they still need acceptance on a live display.

Answers: how can an AI operate MetaViewer; how do I reproduce the computer use session;
what does this playbook prove.

## The idea

Capsules give the operator a named place to observe and control each task, while
the wall makes several tasks visible together. A player works inside a capsule;
a director watches the wall and prepares the next task. The director can comment
on a move without choosing the player's move for it.

Answers: why use capsules for computer use; what does an agent gain over a raw desktop.

On a raw desktop, a click depends on whichever window has focus. In the checked
lane, the core checks the selected capsule, ownership and frame before input,
then records the outcome. A paired terminal keeps the player's explanations next
to its task. Layout changes help compare tasks without switching applications.
This does not make every application isolated: **Host program runs as the host
user and is not isolated**. Its own display is an input destination, not a
security boundary. Desktop window attaches an existing real desktop window.

The public boundaries are described in [WHY_CAPSULES.md](WHY_CAPSULES.md),
[AGENT_ENTRY.md](AGENT_ENTRY.md) and [NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md).
The external components remain private; only the compiled evaluation permission
in that notice applies. No private component source or image is supplied here.

## Choose the control level

Use visible UI control to arrange MetaViewer; use the checked lane for supported
actions inside an Agent capsule. Neither level substitutes for looking afterward.

Answers: should I click the UI or use mw_run; what are the control levels;
can a browser or Desktop window use the game loop.

| Level | Use it for | What must be checked |
|---|---|---|
| UI like a person | Add, stop, hide, arrange, select roles, open terminals | Correct window, current layout, visible target, capture after each action |
| Checked program lane | One focused Enter or arrow input; supported grounded clicks/text | Live attachment, Agent control, capsule identity, current frame, result and after frame |
| Checked browser lane | Supported browser goals or stored workflows from AGENT_ENTRY | Its own browser requirements; it is not the program key loop |

`agents/metaviewer_agents/mw_run.py` accepts `--surface-kind program --goal
focused-key --key` with Enter, Up, Down, Left or Right [CITED:
agents/metaviewer_agents/mw_run.py]. The key run requires `--steps 1` [CITED:
agents/metaviewer_agents/mw_run.py]. The older statement in AI_OPERATOR_GUIDE that
program keys are unsupported does not describe this parser. Browser computer use
was **not shown working by this session**; a browser rendered as a Host program
is still using the program lane. Desktop-window automation is unsupported by
this lane [CITED: docs/AGENT_ENTRY.md].

## Prepare and start

Start an installed, verified package on an authorized X11 display, then identify
its actual window. Never guess the display, package path, identity or attachment.

Answers: how do I start MetaViewer for computer use; what must be installed;
how do I connect the examples to the running app.

Follow [INSTALL.md](INSTALL.md#2-installing-from-the-release-package-tarball) or
[JUDGE_QUICKSTART.md](JUDGE_QUICKSTART.md) for the package and its permitted
compiled dependencies. Source-development requirements are different; this
playbook does not fetch private components. The examples use Python's standard
library, tkinter for their windows, and the named external commands `systemd-run`,
`xwininfo`, `xdotool`, `wmctrl` and `ffmpeg`. A model CLI is optional for manual play.

Run the commands below from the repository root. Set `APP` to the installed
executable and `DISPLAY` to the authorized X11 display. Set `EX` to the absolute
path of `examples/computer-use`; keep work outside the repository.

```sh
EX="$PWD/examples/computer-use"
WORK=$(mktemp -d /dev/shm/mv-computer-use.XXXXXX)
chmod 700 "$WORK"
python3 "$EX/launch.py" app "$APP"
```

The launcher uses `MemoryHigh=6G`, `MemoryMax=8G`, `MemorySwapMax=0` [TARGET,
resource limits]. Keep that terminal running. In another terminal, list windows
with `wmctrl -lx`; select the intended MetaViewer XID and set `WINDOW` to that
literal value. Multiple matches require inspection, not choosing the first.
Ask the window manager to unmaximize it if necessary, then fit and capture:

```sh
python3 "$EX/ui.py" --display "$DISPLAY" --window "$WINDOW" \
  --capture "$WORK/start.png" fit
```

The coordinate reference is a client window of **1920×1080 pixels** [CITED:
maintainer session account]. The driver verifies that geometry with `xwininfo`.
It does not scale the capture. If fitting or capture fails, stop and correct the
window/display. Open `start.png` with the agent's image-viewing tool before input.

For checked input, open **Copy ID for AI** for the intended capsule, keep the
actual identity, and follow [AGENT_ENTRY.md#attachment-and-identity](AGENT_ENTRY.md#attachment-and-identity).
Resolve the pointer in the original terminal environment before sourcing:

```sh
ENV=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/metaviewer/attach/current.env
test -r "$ENV" || exit 1
set -a; . "$ENV"; set +a
test -n "$MV_OPERATOR_REPO" || exit 1
```

Keep this in the same task subshell. Check the recorded app is live and that a
fresh observation belongs to the selected capsule and identity. A live process
alone does not prove the pointer selects your window. Reattach after an app
restart; do not retain the old environment. For checkout dependencies, obtain
the pinned roots named by [tools/mw_run_program.md](../tools/mw_run_program.md)
from the operator; an unavailable root is **ABSENT — do not invent**.

## Look, act, capture, verify

Perform a single visible action, capture it, and inspect its effect before the
next action. A successful click command proves delivery to X11, not a correct UI
target. Never act blind.

Answers: what is the computer use operating loop; how do I verify a click;
what should I do after INPUT_UNCERTAIN.

1. Look at a fresh full-window frame. Identify the current capsule, layout,
   selected role, dialog and focus. Read the labels you intend to use.
2. State the intended visible change. If its target is absent, capture again or
   stop; do not use remembered coordinates on a different layout.
3. Act once. `ui.py` accepts a single click, text insertion or key per invocation.
4. Open its new capture. If a dialog is still loading, wait and take a new
   `shot`; a fixed delay is not readiness evidence.
5. For a player, retain the pre-input frame, validate its decision, run the
   checked key, retain the after frame and inspect the report/receipt. Verified
   input is not proof that the game objective was completed.

The coordinates below have not been display-tested in this revision. Verify the
target in your own fresh frame before using this example UI invocation:

```sh
python3 "$EX/ui.py" --display "$DISPLAY" --window "$WINDOW" \
  --capture "$WORK/add-dialog.png" click 111 101
```

On `INPUT_UNCERTAIN`, input may already have arrived. Stop the player; inspect
the after frame and evidence with the operator before deciding on a fresh run.
Never repeat the previous key automatically. `model_keys.py` stops on any
unverified result and retains its record. The original session sometimes
continued after a fresh look; that is not a retry guarantee.

## UI action reference

Only the coordinates actually reported in the session are numeric below.
Everything else must be located from a fresh capture and its visible label.
These are window coordinates at **1920×1080** [CITED: maintainer session account],
not coordinates in a scaled contact sheet. Each row requires its confirming
capture before proceeding. The complete set below covers this playbook's UI
operations; it is not a claim to enumerate every product control.

Answers: where do I click to add a capsule; where are layout and terminal controls;
what captures confirm each UI action.

| Action and required state | Coordinate [CITED: maintainer session account] or locator | Capture must show |
|---|---|---|
| Add capsule | `(111,101)` | Kind chooser |
| Select Host program in that chooser | `(919,494)` | Host program selected |
| Create Capsule in that chooser | `(1185,957)` | Program dialog |
| Open program Role | `(960,475)` | Role options |
| Select Agent in that role popup | `(535,531)` | Agent selected after popup closes |
| Focus Binary name | `(960,554)` | Correct field focused; capture again after typing |
| Start program | `(960,604)` | Named capsule frame or explicit refusal |
| Side by side preset | `(1497,48)` | Side-by-side wall |
| Grid preset | `(1527,48)` | Grid wall |
| Tile menu, left tile in side-by-side layout without tab row | `(1027,84)` | Menu for the intended tile |
| Stop capsule, that open menu | `(870,321)` | Capsule stopped, not merely hidden |
| Open paired terminal, left tile without tab row | `(782,84)` | Terminal under that tile |
| Open paired terminal, right tile without tab row | `(1610,84)` | Terminal under that tile |
| Open paired terminal, right tile with tab row | `(1610,111)` | Terminal under that tile |
| Focus left/right terminal in side-by-side layout | `(630,930)` / `(1460,930)` | Intended terminal cursor; then typed command |
| Hide terminal, top-left grid tile | `(272,365)` | More room for the capsule, player still running |
| Submit typed shell command | `Return`, only with verified terminal focus | Running command and output |
| Quit app | File → Quit or `Ctrl+Q`, app shell focused | Window closed; next launch has a new attachment |
| Select Identity browser / Program / Desktop window / VM / MicroVM | Visible kind card; coordinate **ABSENT — do not invent** | Correct card and setup dialog |
| Select Human; change role later | Role option or tile menu label; coordinate **ABSENT — do not invent** | Requested role and control status |
| Take control / release control | Visible Control / Release or context-bar label; coordinate **ABSENT — do not invent** | Interactive or watching state as requested |
| Hide/reopen tile | Tile close control / sidebar capsule; coordinate **ABSENT — do not invent** | Hidden/reopened tile, same running capsule |
| Other layout, fullscreen, move to desktop, select desktop | Visible labeled control; coordinate **ABSENT — do not invent** | Intended layout and capsule placement |
| Copy ID for AI / terminal task buttons | Visible labeled control; coordinate **ABSENT — do not invent** | Intended identity or prepared prompt |
| Rewind Pause / Resume / Mark / Back / Stop | Visible enabled control; coordinate **ABSENT — do not invent** | New acknowledged state or explicit refusal |

The current shell defines buttons `1`, `2`, `2×2`, `3×2`, `Focus`, `Float`
[CITED: ui/src/App.vue]. Use their labels; there is no need to invent a dropdown.
Dialog labels and the Host program warning are in
`ui/src/catalog/CatalogLauncher.vue`. Availability comes from host capabilities,
not from a successful click. Menu and terminal positions change with tabs.

## Open and close each kind

Use the kind that matches the task and its admitted host capabilities. Select
Agent when a checked player will act; select Human for direct manual use.

Answers: how do I create each capsule kind; how do I stop or hide a capsule;
why should games start in Agent mode.

| Kind [CITED: ui/src/catalog/catalogModel.js] | Open through Add capsule | Close and limits |
|---|---|---|
| Identity browser | Choose an available identity and role, then Open capsule; create/manage identities via Identities | Stop capsule ends that capsule; hiding its tile does not stop it. Use browser lane guidance separately |
| Program | Create Capsule, choose role, enter installed binary, Start | Stop via tile menu. Uses the configured program profile; does not promise every host binary will run |
| Host program | Same program dialog; enter a wrapper's absolute path | Stop via tile menu. Runs on host, not isolated. Start games as Agent: changing program role can restart them |
| Desktop window | Choose an existing X11 window, then Add | Stop detaches; it does not close the original window. Native Wayland windows are not listed |
| ARM64 Linux VM | Select the card only when available and use its configured profile | Stop via visible controls. Guest assets and host support must already exist |
| MicroVM — ARM64 | Select admitted command guest; wait for ready binding | Stop via guest controls; use command/rewind guidance, not program pixels |

For role changes use the tile menu's **Switch to agent mode** / **Switch to human
mode** and confirm if asked. Verify the resulting capsule identity and state.
For Agent watching, **Control** takes emergency manual control; **Release**
returns to watching. Program role transitions may reopen the program, so prepare
the role before starting the game. Hide and Stop are different operations.
No launch recipe can supply absent VM assets; unsupported cards are a reason to stop.

## Play a game

Create the supplied Connect Four board as a Host program, verify its identity,
then start a player in the paired terminal. This game is deliberately small and
turn-based, so a slow decision does not lose a real-time action window.

Answers: how do I run one game; how do I launch a player in the paired terminal.

1. Initialize a new match and make its launcher. These paths derive from your
   chosen work directory, not the session machine:

   ```sh
   python3 "$EX/connect_four.py" init --state "$WORK/match.json"
   python3 "$EX/launch.py" game-wrapper "$WORK/solo" \
     --game "$EX/connect_four.py" --state "$WORK/match.json" --seat both
   ```

2. Add Host program, set Agent, enter the absolute path printed for `solo`,
   Start. Capture and verify the board before proceeding. This solo view can
   play either side; it demonstrates input, not an independent opponent.
3. Open the paired terminal. Verify its focus before typing. Source the same
   app attachment there and retain `MV_OPERATOR_REPO`. Copy the actual identity
   from the capsule; the wrapper basename is only a hint, not proof.
   Set `EX` and `WORK` in this new shell to the actual absolute paths from setup;
   shell variables from another terminal do not appear here automatically.
4. Run the bounded model command below with `IDENTITY` set to that identity and
   `PLAYER` set to an installed generic adapter executable. The adapter contract
   appears in the model section. Limits are resource targets; the step budget
   is **20** [TARGET].

   ```sh
   systemd-run --user --scope -p MemoryHigh=6G -p MemoryMax=8G -p MemorySwapMax=0 \
     python3 "$EX/model_keys.py" --operator-root "$MV_OPERATOR_REPO" \
     --identity "$IDENTITY" --evidence "$WORK" --steps 20 \
     --goal 'Play the side whose turn is displayed. Use arrows to select a legal column and Enter to drop. STOP when the game ends.' \
     --player "$PLAYER" --image '{frame}' --prompt '{prompt}' --schema '{schema}'
   ```

5. Read the terminal's observation, chosen key and core verdict alongside its
   after frame. Do not call a completed key a win. In the paired-seat recipe,
   a player must stop while it waits for the opponent's turn.
6. Stop the player with terminal interrupt, then Stop capsule from its menu.
   Do not send `Ctrl+C` to the game by mistake: inspect terminal focus first.

For Tuxemon, substitute an operator-installed game launcher for `red` and use a
goal suitable for menus/dialogue. Tuxemon and its dependencies are not bundled by
these examples. Obtain them from the upstream distribution and its instructions.
No completed Tuxemon playthrough is claimed.

## Watch side by side and in a grid

Use independent named wrappers and verified identities for each visible seat;
share the evidence root so the local player loops share their lane lock.

Answers: how do I run two games side by side; how do I watch four players in a grid.

1. Stop the solo capsule. For **two seats** [TARGET], create a fresh paired
   match and its independent views:

   ```sh
   python3 "$EX/connect_four.py" init --state "$WORK/paired.json"
   python3 "$EX/launch.py" game-wrapper "$WORK/red" \
     --game "$EX/connect_four.py" --state "$WORK/paired.json" --seat red
   python3 "$EX/launch.py" game-wrapper "$WORK/yellow" \
     --game "$EX/connect_four.py" --state "$WORK/paired.json" --seat yellow
   ```

2. Add both as Agent Host programs. Select the `2` preset [CITED:
   ui/src/App.vue]. Reopen each capsule from the sidebar into the intended tile
   if creation placed it in a tab. Capture both named boards; moving tiles does
   not create new game state.
3. Open each paired terminal, verify its identity and run its own bounded
   player with the goal "Play only your displayed seat; STOP when it is not
   your turn." A model that stops because it is waiting needs a new run after the
   other seat changes the board. Never run two loops for the same seat.
4. For **four seats in a 2×2 wall** [TARGET], create a separate match file with
   `connect_four.py init`, then another red/yellow wrapper pair with distinct
   filenames. Add that pair and select `2×2` [CITED: ui/src/App.vue]. Verify which
   match and seat each tile displays. This is two independent matches, not a
   four-player rules variant.
5. Hide paired terminals when they obscure boards; use a fresh wall capture to
   inspect all seats. The lock serializes capture/input, not model inference.
   It coordinates only these example loops. Other tools must not act concurrently.
6. Stop on a journal warning, uncertainty or lost capsule. Do not promise a run
   duration or multiply a single-player throughput measurement.

## Run a drawing contest

Have each model return a constrained drawing, then display the results in Host
program capsules. The supplied viewer interprets shapes as data and executes no
model-generated code.

Answers: how do I compare model drawings live; how can I display generated art safely.

1. Give each installed model CLI the same neutral brief, for example “Draw a
   house and a tree using colored shapes.” Ask for only the object format in
   `examples/computer-use/drawing.py`: `shapes`, each with `kind`, `xy`, `color`.
   The canvas coordinates run from **0 to 600**, with at most **100** shapes
   [CITED: examples/computer-use/drawing.py]. Use no people, account information
   or private material in the brief.
2. Save each CLI's JSON answer in a different file beneath `WORK`. CLI output
   transport varies; use its documented output mode. A generic shell adapter
   may write stdout to the chosen file. Invalid JSON is a stop, not permission
   to execute a script that “fixes” it.
3. Create a viewer wrapper per answer:

   ```sh
   python3 "$EX/launch.py" command-wrapper "$WORK/drawing-a" --command \
     python3 "$EX/drawing.py" --input "$WORK/drawing-a.json" --title 'Drawing A'
   ```

4. Add each wrapper as Host program. Choose side by side or grid and inspect
   the actual visible drawings. Apply the same brief and judging criteria;
   describe composition and visible mistakes, not invented intentions.
5. Capture the full wall and exact crops before giving a verdict. Keep incomplete
   or invalid answers identified. This is a display recipe, not a model ranking.

## Wire a model CLI

Any CLI can be a player if an adapter gives it the frame and prompt and returns
the decision object. The model chooses; the loop validates and the checked lane
attempts the input.

Answers: how do I plug in a model CLI; how does Muse Spark 1.3 choose game keys;
what does the generic player return.

Generic adapters accept the illustrated `--image`, `--prompt`, `--schema` paths
and emit exactly this shape on stdout (diagnostics belong on stderr):

```json
{"key":"Right","observation":"My cursor is left of an open column.","reason":"Move toward that column.","expected":"The cursor moves right."}
```

Allowed keys are Enter, Up, Down, Left, Right, STOP [CITED:
examples/computer-use/model_keys.py]. The placeholder arguments are substituted
as argv, never a shell command. `PLAYER` is your adapter, not an executable
shipped by MetaViewer. Tool use, authentication and writing arbitrary files are
outside this decision protocol. Its environment permissions are enforced by the
chosen CLI, not by wording in a prompt.

The worked session used **Muse Spark 1.3** through `muse exec` [CITED:
maintainer session account]. The corresponding invocation for an installed CLI
that supports these flags is below. Check local `muse exec --help`; if that CLI
version lacks a flag, stop and adapt its documented interface. This is a native
CLI invocation; it does not drive a website. Existing login/setup belongs to the
operator and is outside the player loop.

```sh
systemd-run --user --scope -p MemoryHigh=6G -p MemoryMax=8G -p MemorySwapMax=0 \
  python3 "$EX/model_keys.py" --operator-root "$MV_OPERATOR_REPO" \
  --identity "$IDENTITY" --evidence "$WORK" --steps 20 --format muse \
  --goal 'Play the displayed game using one arrow or Enter. STOP if waiting or unsure.' \
  --player muse exec --json --prompt-file '{prompt}' --image '{frame}' \
  --output-schema '{schema}' --model muse-spark-1.3 --reasoning-effort low \
  --workspace '{workspace}' --trust-workspace --sandbox-network restricted \
  --approval-mode never --contributor-mode on --disable-write --disable-shell --disable-web-tools \
  --disable-reminders --max-model-steps 1
```

The inference step cap and run budget above are targets [TARGET]; the flag
spellings come from the supplied session script [CITED: maintainer session
account]. The workspace trust selection applies to the new evidence directory.
The example parses `run.output.delta`, requires `run.terminal.completed`, and
rejects terminal failure events. The completion event name was also checked with
the installed CLI's offline echo provider [MEASURED]; this is not an inference
or account test. A changed event format must fail, not select a guessed key.
No account, quota, latency or provider availability is promised. The selected
CLI is trusted host code: it inherits the user's environment, including the
attachment, and can access whatever its effective permissions allow. The JSON
schema limits what this loop dispatches; it does not sandbox that CLI. The
workspace option selects a working directory, not a filesystem boundary.

## Commentate while players work

Keep the director's short observation loop separate from slow watchers and model
calls. Ask a watcher a bounded question about saved images; do not block the
next necessary capture waiting for its prose.

Answers: how do I commentate live; how should parallel watchers work;
how do I avoid confusing player decisions with commentary.

Only one controller may act on a capsule at a time. The local lock does not
exclude humans or unrelated tools. The checked lane rebinds its own input to a
current frame; it does not prove that a model's earlier interpretation is still
true after a slow inference. Stop if another actor changes the capsule.

The director checks the visible task and recent verdict, then says what is
actually visible: “The red cursor moved; no piece has dropped yet.” A watcher
may compare already saved frames or flag an unreadable tile. It must not send
input, seize focus, or announce progress the director has not checked. Give it
file names and a precise question, and return to your own loop.

Keep observations, predictions and results distinct. “It may be planning a
block” is an interpretation, not access to model thoughts. Read terminal output
before quoting it. Report waiting, failed inputs and stopped loops honestly.
Keep recording lifecycle separate from player lifecycle: reaching a step budget
does not mean the operator asked to end a take.

## Read frames and recordings

Start with a full frame, use a contact sheet to find changes, then inspect the
original resolution crop to read text. A sheet is navigation evidence, not
proof that tiny terminal text says what you expect.

Answers: how do I read frames; how do I make a contact sheet or exact crop;
how do I inspect a recorded take.

```sh
python3 "$EX/frames.py" sheet "$WORK/sheet.png" \
  "$WORK/start.png" "$WORK/add-dialog.png" --columns 2
python3 "$EX/frames.py" crop "$WORK/start.png" "$WORK/terminal-crop.png" \
  --rect 300 700 900 300
ffmpeg -v error -ss "$SECOND" -i "$VIDEO" -frames:v 1 "$WORK/video-frame.png"
ffprobe -v error -show_entries format=duration -of default=nw=1 "$VIDEO"
```

The sheet has **480×270** cells [CITED: examples/computer-use/frames.py]; its
adjacent JSON maps input order. The crop rectangle above is only an example
[TARGET]; choose it from the actual full frame. Crops use original pixels,
without resizing. Open each image with your image viewer. If image viewing is
unavailable, say so and do not claim visual verification.

For video, scan coarsely, narrow around the change, then extract individual
frames around it. Keep the source time with each image. Do not label a sampled
frame with a rounded timestamp that was never checked. Look for black/white
loading frames, hidden dialogs, dead terminals and clipped text.

Recording is optional. The session used OBS; its setup was local and is not
copied here. Select the current window capture source, take a short recording,
stop it through OBS and inspect the file with `ffprobe` and a frame. A saved
window ID can point to the wrong window after restart. A recording process
being alive does not prove frames were recorded. Keep audio and other desktop
content out unless explicitly intended.

## Stop, restart, Rewind and replay

A full journal ends the session; guest Rewind restores admitted guest state;
`mv-replay` checks the journal offline. These are separate operations.

Answers: how do I recover from JOURNAL_FULL; how do I demonstrate Rewind;
how do I run mv-replay after a take.

For journal exhaustion, stop all player loops, keep the evidence paths, quit the
application cleanly, then start a new session. Re-source the new attachment and
verify identities again. Do not erase or edit the old journal to continue it.
Lost alone does not prove journal exhaustion: read the actual terminal/log code.

For a Rewind demonstration:

1. Use an already provisioned, available **ARM64 MicroVM** and its live binding.
   This is unavailable on x64 [CITED: docs/ARM64_MICROVM_REWIND.md]. The program
   game loop is not a guest-command API.
2. Follow [AGENT_ENTRY.md#microvm-direct-task](AGENT_ENTRY.md#microvm-direct-task)
   in the paired terminal, retaining the single connection and checked binding.
   Create a disposable guest file and read it back. A sample guest command is
   `printf 'before\n' > /tmp/mv-rewind-demo.txt`; verify with
   `test "$(cat /tmp/mv-rewind-demo.txt)" = before`.
3. Mark the state before deletion using that recipe's `mark_before` step or
   the enabled **Mark** control. Capture the acknowledged point. Use **Pause**
   / **Resume** only with their acknowledged states; do not assume a disabled
   control succeeded. The connection's generation advances after a mark.
4. Delete only the disposable file, verify its absence, then use **Back** to
   choose the saved point. Capture the new acknowledged state and reacquire
   the fresh guest binding before reading the file again. Never reuse a stale
   command generation. Stop on uncertainty rather than forcing a restore.
5. Show that the file content returned. This is guest recovery; it does not
   rewind a Host program, the host filesystem or the external journal.
6. Stop the guest cleanly. Preserve the original session and run its installed
   verifier with actual absolute paths:

   ```sh
   "$REPLAY" --journal "$(realpath "$JOURNAL")" \
     --witness-root "$(realpath "$SESSION")" --verify-only
   ```

`REPLAY` is the installed `mv-replay` executable; `JOURNAL` and `SESSION` come
from that session's evidence, not a guessed directory. Success is exit **0**
[CITED: core/src/bin/mv-replay.rs]. Without `--verify-only`, it also prints the
reconstructed state hash. `Invalid` can mean wrong arguments or path/ownership
checks, not necessarily corrupt content. Use the original private session,
real paths and original permissions; do not weaken permissions to make it pass.
See [DEBUG.md#replay-a-journal-with-mv-replay](DEBUG.md#replay-a-journal-with-mv-replay).

## Failures, causes and fixes

Use the observed error and current code to choose a fix. The session's explanations
are maintainer reports, not independently reproduced bug diagnoses.

Answers: why did a click miss; why did a player stop; why is the board black;
what failures did the live session expose.

| Symptom | Cause or evidence boundary | Next action |
|---|---|---|
| Start click does nothing | Dialog was not ready in the session | Capture, wait for the actual dialog, click once |
| Wrong menu opens | Tab/layout moved the target; misses occurred | Re-read full frame and label, discard old coordinates |
| All clicks shifted | Session driver used geometry with a frame offset | Use `xwininfo` client origin; verify capture geometry |
| Program will not launch in a restricted profile | Requested kind/profile not admitted; exact reason is in refusal | Check available kind and reason; do not infer from CPU name alone |
| `MW_PROGRAM_RAM_REQUIRED` | Evidence root is not admitted real RAM storage | Use private real RAM directories; do not symlink required roots |
| Missing assets after reboot | Session used temporary RAM files | Recreate only your example work files; obtain configured assets through install guidance |
| Asset path alias refusal | Session moved pinned assets | Restore through their provisioning procedure; do not relocate pinned roots |
| No agent CLI available | Discovery/PATH or host environment validation may fail | Check installed CLI and reported validation reason; do not bypass authentication |
| Agent reads stale instructions | Session launcher pointed at an old operator tree | Verify live `MV_OPERATOR_REPO` and attachment |
| Model sandbox cannot connect | Its process cannot access the required socket | Use the operator-approved native loop/runtime; do not disable sandbox controls as a workaround |
| Direct launch attachment looks stale | Session reported process-namespace mismatch; not reproduced here | Stop that route, inspect current attachment and supported profile |
| `INPUT_UNCERTAIN` | Dispatch/effect did not settle; input may have occurred | Stop, retain before/after evidence, reconcile with operator |
| Player appears to freeze or exits | It may be waiting, at its budget, failed, or stopped | Read the terminal and process result before diagnosing the game |
| Loop stops recording with it | Session waiter coupled the lifecycles | Keep recording and player stop decisions separate |
| Role change resets a game | Program transition may restart it | Select Agent before launching; reverify identity afterward |
| `JOURNAL_FULL`, then Lost | Session admission ended when the journal filled | Preserve evidence and restart the session |
| Asynchronous surface-event traceback after Lost | Reported secondary failure; not fixed here | Preserve traceback and preceding code; restart only after diagnosis |
| OBS black/wrong window | Saved capture source may reference an old window ID | Select current source; verify a short take |
| OBS does not stop | Session's interrupt did not finalize it | Use OBS stop and inspect output; never kill arbitrary recording processes |
| Board black after resize | Session game code retained an old drawing surface | Recreate/redraw against current surface; these examples redraw on resize |
| Browser input does not work | Browser and Host program lanes differ; Desktop window has no supported game custody | Verify kind, stop unsupported route; do not claim browser success |

To investigate a new failure, run `python3 route/route_query.py error "EXACT_CODE"`,
read the returned code, and distinguish the error condition from the suspected
cause. Report the smallest observed sequence, expected effect, actual effect
and retained evidence. Do not edit receipts.

## Evidence limits

This is a usable procedure with explicit gaps, not proof of general-purpose
computer use or a ranking of models.

Answers: what has not been proven; what are the limits of the demonstration;
where did the games come from.

The coordinate set came from a fixed window size and layout; every step still
needs a capture. Misses happened. Keys in the demonstrated program lane are
limited to Enter and arrows. Host programs are not isolated. Browser computer
use was not shown working. A full journal ends a session. The amount of time a
new session lasts is **ABSENT — do not invent**.

The session's games and boards were written for the demonstration, except
**2048 by Gabriele Cirulli (MIT)** and **Tuxemon** [CITED: maintainer session
account]. Some players received text boards or legal moves, so those comparisons
were not uniform vision tests. The new Connect Four and drawing viewer here are
small examples, not those unpublished boards. No external game code is vendored.

Reported play, drawings, Rewind and replay remain maintainer-reported live results
without published receipts. Offline example checks do not establish GUI delivery,
model availability, installed component readiness, or a successful packaged run.
Frames, prompts, model replies and error records remain in the chosen private
work directory until its owner removes or exports them. Inspect and redact them
before sharing. There is no automatic cleanup promise.

The mandate here is limited to the supplied session account and this repository's
public code and documentation.
