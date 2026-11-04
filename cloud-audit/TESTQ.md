# Test quality audit: where green CI gives false comfort

Scope: code new on `ci/assets-375b9be79` (375b9be) against `origin/main` (7721915).
Report only. No product code or tests were changed in this commit. Every mutation
below was applied to a scratch copy (`git archive HEAD`), run, and reverted.

## How this was run

- UI: kit `oguirado/capsule-ui-kit` cloned anonymously at the `ui/kit.lock.json`
  pin `aaada9de…`; `node tools/sync_kit.mjs` and `--check` green. Node 24.14.0
  (the `js` job pin), then `npm ci --ignore-scripts` and `npm test`.
- Go: `go test ./...` in `daemon-adapter` (the go1.26.0 toolchain was downloaded automatically).
- Rust: `cargo test --locked --no-fail-fast` at the workspace root.
- Container: x86_64, root, no display stack, no docker daemon, no KVM.

Baseline [MEASURED]:

- UI: 4409 pass, 8 fail, 2 skipped. All 8 failures are environmental. They need
  Chromium or Electron rendering, built node-pty native files (the install used
  `--ignore-scripts`), an RSS harness or a live SDK host: `V028-FIT-2`, `tile chrome
  fits narrow containers`, `floating allocation updates the real Dockview group minimum`,
  `DISPLAY Stop error…`, `DISPLAY stale task…`, `P18H-R2-PTY`, `U13 production main RSS`,
  and two `real authenticated host…` guest-command observation tests.
- Go: exit 0. One unmutated control run of `./internal/capsule/...` had the
  `slots` package `signal: killed` while cargo was compiling at the same time. A
  rerun passed. Treat it as resource pressure, not a product signal.
- Rust: `verify::ownership_tests::foreign_uid_is_rejected` FAILED. This is expected
  when running as root. The full cargo run was still in progress when this report
  was written, so it has no Rust totals and no Rust mutations.

Mutation method: `tools/mut.sh`-style scratch helper. It makes one exact string
replacement, runs every test file that references the mutated module, then
restores the file. "Survived" means the mutant produced no failure beyond the
baseline environmental ones listed above.

## Findings, ranked by user impact

### 1. Slots: the real Docker helper path is never executed; x64 image choice is unguarded

- Tests: `daemon-adapter/internal/capsule/slots/store_test.go:18`. `localHelper`
  replaces `Store.helper`, so `Store.docker` (`slots/store.go:823-871`) never runs.
  The only Docker exercise is the opt-in flag `-slots-docker-probe`
  (`store_test.go:275-290`), and no workflow passes it. The fixture image is
  hard-coded `opensuperficies-identity-browser-arm64:0.1.1` (`store_test.go:39`) on every
  architecture. Image selection in `slots_bridge.go:63-79` is bypassed in tests by
  injecting `cfg.Slots`.
- Unprotected behaviour: the bind-mount read-only/read-write mode per helper op,
  the `/profiles` and `/slot` mapping for `exchange`, and the per-architecture image
  candidate.
- Surviving mutation M_slot_ro, in `daemon-adapter/internal/capsule/slots/store.go`:
  `if op == "provision" || op == "unpack" || op == "exchange"` →
  `if op == "provision" || op == "exchange"` (unpack mounts read-only).
  `go test -count=1 ./internal/capsule/... ./internal/daemon/...`: all `ok` [MEASURED].
- Surviving mutation M_slot_arch, in `daemon-adapter/internal/capsule/slots_bridge.go`:
  `map[string]string{"amd64": "x64", "arm64": "arm64"}` →
  `map[string]string{"amd64": "arm64", "arm64": "arm64"}`. Same command, all `ok` [MEASURED].
- What a person would see: loading a saved slot fails with `SLOT_HELPER_REFUSED`
  (read-only file system) while saving still works. On x64, stored-data slots are
  unavailable (`SLOT_HELPER_IMAGE_ABSENT`) or run the wrong-arch helper. This is the
  same class as the earlier x64 blockers.
- Smallest real test: put a fake `docker` executable first on `PATH` in a Go test.
  It records argv and execs the helper script locally. Assert the exact `--mount`
  strings for each of `probe`, `pack`, `unpack`, `exchange-probe`, `exchange`, `discard`.
  Extract the image-candidate list into a function and table-test it for `amd64` → `-x64-`
  and `arm64` → `-arm64-`. Negative control: an `unpack` with `,readonly` must fail.

### 2. Grid and snap: the remembered identity cell is neither saved nor applied by any test

- Tests: `ui/test/v028-grid6.test.js:25-31` calls `nextFloatingCell(…, hint)` directly.
  The controller test at `v028-grid6.test.js:62` passes `savedCells:()=>({})`, so the
  hint path in the controller is never taken. Nothing exercises the writer
  `ui/src/wall/DesktopWorkspace.vue:119-122`.
- Unprotected behaviour: after a snap, the identity's cell is recorded. Reopening
  the identity places it back in that cell.
- Surviving mutation M_cell_save, in `ui/src/wall/DesktopWorkspace.vue`:
  `desktop.identityCells[profile] = {col,row};` → `desktop.identityCells[profile] = {col:0,row:0};`.
  Run over all 564 tests in files that reference `DesktopWorkspace` or `WallWorkspace`: 0 fail [MEASURED].
- Surviving mutation M_hint_live, in `ui/src/wall/WallWorkspace.vue:853`:
  `occupied,profile ? savedCells?.()[profile] : null);` → `occupied,null);`. Same run: 0 fail [MEASURED].
- What a person would see: snap a browser to the bottom-right cell, close it, reopen
  it. It lands in the first free cell (top-left) every time. Grid6 placement is
  "remembered" in the saved layout but never honoured.
- Smallest real test: mount the controller with `savedCells:()=>({'identity-0':{col:2,row:1}})`.
  Reveal one surface with `profile_id:'identity-0'` and assert `left:800, top:300`.
  Then drive `DesktopWorkspace`'s snap-commit handler and assert that
  `identityCells['identity-0']` equals the dropped cell. Negative control: drop on a
  different cell and assert the stored value changes.

### 3. Display names: a rename persists but the tile title is never asserted

- Tests: `ui/test/display-names.test.js:4-44` covers only the pure functions in
  `ui/electron/desktopLayout.js`. The renderer step that applies the label to the
  tile, `ui/src/wall/DesktopWorkspace.vue:90`, has no test.
- Surviving mutation M_label, in `ui/src/wall/DesktopWorkspace.vue`:
  `return title?{...row,title}:row;` → `return row;`. 564 tests, 0 fail [MEASURED].
- What a person would see: rename a capsule. The dialog reports success and the
  name is saved, but the tile header keeps the old title, including after a restart.
- Smallest real test: mount `DesktopWorkspace` with one row (`id:'surface-a'`,
  `profile_id:'identity-a'`, `title:'Old'`), call the exposed
  `renameCapsule('surface-a','Editor')`, and assert that the row passed to the wall
  has `title:'Editor'`. Negative control: an invalid label keeps `'Old'`.

### 4. Recording folders: the saved folder only reaches the core in packaged builds, and that line is untested

- Tests: `ui/test/capture-preferences.test.js:19-27` calls `applySavedCapturePreferences`
  in isolation. Its only production caller is the generated packaged main at
  `ui/tools/package.js:1483-1485`. `ui/electron/main.js` never calls it, so the saved
  folder is ignored in dev runs. The bridge tests at `capture-preferences.test.js:42-59`
  fake the core so that `export` always succeeds. The core's real check
  (`core/src/serve/capture.rs:252-275`) requires `MV_RECORDING_DESTINATION` in its
  own environment. Both sides of the seam are faked, so a missing environment
  variable cannot show up.
- Surviving mutation M_rec_env, in `ui/tools/package.js`:
  `if(captureEnv.MV_RECORDING_DESTINATION!==undefined) process.env.MV_RECORDING_DESTINATION=captureEnv.MV_RECORDING_DESTINATION;` → removed.
  Run over every test file referencing `package.js`, `capturePreferences`, `packageOutput`
  or `tools/package`: the same environmental failures as the unmutated control, plus one
  `R1-050` ENOENT on `/root/.cache/electron`, which is also environmental. No test
  failed because of the mutation [MEASURED].
- What a person would see: choose a recordings folder and set "disk-on-stop",
  restart, record, then stop. Nothing appears in the folder; the export is refused
  for lack of a grant. The settings panel still shows the chosen folder.
- Smallest real test: in the packaged-entry test, render the generated main with a
  stub `app.getPath` that points at a temp `capture-preferences.json`, intercept
  `spawn`, and assert `env.MV_RECORDING_DESTINATION` equals the saved folder.
  Negative control: a missing folder sets `MV_CAPTURE_PREFERENCES_ERROR` and leaves
  the variable unset.

### 5. Launcher: the Recent group is never fed by a real launch

- Tests: `ui/test/grouped-launcher.test.js:20-23` hands the dialog ready-made `types`.
  `ui/test/desktop-applications.test.js:27-29` calls `catalog.launched()` directly.
  The only production call, `ui/electron/roleHost.js:902`, has no test.
- Surviving mutation M_recent, in `ui/electron/roleHost.js`:
  `if (choice.hostXpra === true) await installedApps.launched(resolved.path).catch(() => {});` → removed.
  Run over every file referencing `roleHost` or `desktopApplications`: 271 pass, 0 fail [MEASURED].
- What a person would see: launch Text Editor from "Installed apps" and reopen the
  launcher. No "Recent" section appears, ever.
- Smallest real test: in the existing `installRoleHost` harness (`v028-grid6.test.js:80-108`
  shows the pattern), open a host-Xpra program with a temp `MV_SRF_STATE_DIR`, then
  call the `apps` op and assert `recent` contains the app id. Negative control: a
  refused create leaves `recent` empty.

### 6. Agent launch: only Codex is covered, with a hand-written banner

- Tests: `ui/test/agent-prompts.test.js:8` defines the "ready" output as
  `'\x1b[1mOpenAI Codex\x1b[0m\n› '`. This is a synthetic string, not a capture of
  the real CLI's screen sequence (alternate screen, cursor-addressed redraws). The
  Gemini and OpenCode branches in `ui/src/terminal/agentPromptGate.js:13-14` have no test.
- Surviving mutation M_gemini, in `ui/src/terminal/agentPromptGate.js`:
  `/Type your message/i` → `/Type your massage/i`. Run over every file referencing
  `agentPromptGate`, `terminalDeckModel` or `pairedTerminals`: 91 pass, 0 fail [MEASURED].
- What a person would see: choose Gemini (or OpenCode) for a paired terminal. The
  CLI starts, but the workflow prompt is never pasted, and after 15 s a timeout toast
  appears. For Codex the risk is not proven here: if the real TUI paints "OpenAI Codex"
  and the `›` glyph through cursor moves or a later redraw, the same timeout happens.
- Smallest real test: commit scrubbed byte captures (`script -q`) of the first
  screens of each supported CLI version as fixtures. Assert `agentPromptState`
  returns `ready` for each, and `authentication` for a captured login screen.
  Negative control: a shell prompt stays `waiting`.

### 7. Assertions on source text instead of behaviour (not proven by mutation)

- `ui/test/arm64-capsule-package.test.js:65-72` checks the generated bootstrap with
  `indexOf` and `includes` on literal strings. Reformatting breaks it, and a
  behavioural change hidden behind the same text passes.
- `ui/test/v028-grid6.test.js:110-117` carves `copiedIdentity` out of
  `IdentitiesDialog.vue` with a regex and evaluates it via `new Function`. Whether the
  template actually calls it after a copy is not tested.
- `ui/test/v028-grid6.test.js:10-12` and `ui/test/v028-tiles.test.js:5-7` load the
  `WallWorkspace.vue` script by regex-replacing its `vue` import. The tested code is
  close to the shipped component, but it is not the compiled component.
- `ui/test/v028-grid6.test.js:17-18` takes its expected cell from
  `floatDragBounds`, the same function the product uses. Literal anchors at lines
  28 and 69-70 limit the damage at 1200x600 only.
- Impact: low to medium. These tests can fail on harmless edits and pass on real
  breakage. Each should gain one rendered or executed assertion.

### 8. Skipped paths and arch legs (checked; no false comfort found)

- `ui/test/display-electron.test.js:62` skips in the `js` job without `CARGO_TARGET_DIR`.
  The `package` job (both `ubuntu-24.04` and `ubuntu-24.04-arm`) runs it under xvfb and
  fails on any skip marker (`.github/workflows/ci.yml:2638-2683`). Good.
- The real Dockview `addFloatingGroup` options shape (dockview-core 8.4.1,
  `FloatingGroupOptions{position,width,height,disableSmartGuides}`) matches the call in
  `WallWorkspace.vue:149`, so the faked Dockview in `v028-tiles.test.js:52-78` does not
  hide a wire mismatch there.
- The Docker slot probe (finding 1) is the one opt-in path no leg runs.

## What I did not reach

- Guest command and rewind: Go `internal/guestcommand`, Rust `core/src/rewind*` and
  `guest_command*`, the `guest-command-broker` crate, and the Python
  `guest_command_runtime` and `rewind_runtime`. No mutations; seam fakes not reviewed.
- Program lane (`v023-program-binary`, `v024-program-human`) and focused keys
  (`inputarm-wall-input`): not reviewed.
- Stored-data slots UI (`ui/test/stored-data-slots.test.js`) and `slots_bridge_test.go`
  beyond finding 1.
- Rust: no totals (the run was still in progress) and no mutations.
- No arm64 execution; no live clicks. Every user-visible effect above is inferred
  from code and needs confirmation by hand before release.

## Recheck by hand before 0.2.6 (from the findings)

1. On x64: save a slot, then load it. Check that the restored data matches.
2. Snap a capsule to a non-first cell, close it, then reopen the same identity.
3. Rename a capsule; check the tile title live and after a restart.
4. Packaged build: choose a recordings folder, restart, record, stop; check that the file exists.
5. Launch an installed app; reopen the launcher; check the Recent section.
6. Paired terminal with Gemini, OpenCode and Codex: check that the prompt is pasted within 15 s.

---
Model: given in the session chat, not written here (session policy keeps model identifiers out of pushed files).
Effort: low, time-boxed to about 45 minutes.
