# Tests added for the surviving mutations in TESTQ.md

Branch `cloud/tests-mutations`, based on `origin/cloud/base-e1` (695f602b). Only new test
files and one changelog fragment (`changes/unreleased/mutation-regression-tests.md`) were
added. No product code, contract, budget or existing test assertion was changed.

## How each test was proven

Each mutation from `cloud-audit/TESTQ.md` (branch `cloud/audit-testq`) was applied as one
exact string replacement in a scratch copy of `ui/` or `daemon-adapter/`, outside the
repository. The new test was run against the mutant (must fail), and against the unmutated
tree (must pass). The replacement helper refuses to run if the original string does not
occur exactly once.

Toolchain [MEASURED]: Node 24.14.0 (the `js` job pin), `oguirado/capsule-ui-kit` cloned
anonymously at the `ui/kit.lock.json` pin `aaada9dedc177b096e8b4764959e258e76c1ef02`,
`node tools/sync_kit.mjs` and `--check` green, `npm ci --ignore-scripts`; Go via the
`go.mod` toolchain (go1.26.0, downloaded automatically). Container: x86_64, root, no display
stack, no Docker daemon.

## Tests and mutations

| Mutation | Test | Unmutated | Mutated |
|---|---|---|---|
| M_slot_arch (`slots_bridge.go`, `"amd64": "x64"` → `"amd64": "arm64"`) | `daemon-adapter/internal/capsule/slots_bridge_arch_test.go` `TestSlotHelperImageCandidatesFollowHostArchitecture` | PASS | FAIL: candidates were `-arm64:0.2.0`, `-arm64:0.1.1`; expected `-x64-` |
| M_cell_save (`DesktopWorkspace.vue`, `{col,row}` → `{col:0,row:0}`) | `ui/test/v026-identity-cells-labels.test.js` "V026 a snap commit records the identity cell of the dropped capsule" | PASS | FAIL: stored `{col:0,row:0}`, expected `{col:2,row:1}` |
| M_hint_live (`WallWorkspace.vue:853`, saved hint → `null`) | same file, "V026 reopening an identity places it in its remembered cell, others take the first free cell" | PASS | FAIL: `left` 0, expected 800 |
| M_label (`DesktopWorkspace.vue`, `return title?{...row,title}:row;` → `return row;`) | same file, "V026 rename reaches the tile title the wall renders, live and after a restart" | PASS | FAIL: title `'Old'`, expected `'Editor'` |
| M_recent (`roleHost.js:902`, `installedApps.launched(...)` line removed) | `ui/test/launcher-recent-launch.test.js` "a host launch of an installed app feeds the launcher Recent group; a refused launch does not" | PASS | FAIL: `recent` was `[]` after a successful launch |
| M_gemini (`agentPromptGate.js`, `/Type your message/i` → `/Type your massage/i`) | `ui/test/agent-prompts-other-clis.test.js` "each non-default agent CLI is ready only on its own input prompt" and "agent-gemini start pastes the workflow prompt once its TUI prompt is painted" | PASS | FAIL (2 tests); the start test hit the 15 s timeout with nothing pasted, the user-visible symptom |
| Extra: OpenCode (`/Ask anything/i` → `/Ask anythang/i`) | same file, readiness test and "agent-opencode start pastes …" | PASS | FAIL (2 tests), same 15 s timeout |
| M_rec_env (`ui/tools/package.js`) | not added | — | — |

What each test drives:

- M_slot_arch: puts a fake `docker` first on `PATH` that records argv and exits 1, gives a
  `ProcessRunner` an `SRF_IDENTITY_STORE_ROOT`, and calls the real `initSlots` without
  injecting `cfg.Slots`. It asserts the exact probe list for the host architecture and
  `SLOT_HELPER_IMAGE_ABSENT`. On an architecture other than amd64 or arm64, it asserts
  `SLOT_ARCHITECTURE_UNSUPPORTED`. On the arm64 leg the mutant is a no-op, and the test
  checks the arm64 mapping.
- M_cell_save and M_label: compile the real `DesktopWorkspace.vue` with the shared
  `compileSfc` helper. Only `WallWorkspace.vue` is replaced, by a stub that records the
  props each desktop receives. The cell test emits `snap-grid-change` to 3x2, then writes a
  Floating layout through the storage adapter the workspace hands the wall. It asserts the
  `identityCells` prop and the persisted state. Negative control: a drop on another cell
  replaces the stored cell. The label test reads the projection and snapshot that the wall
  renders, before and after `renameCapsule`. It also remounts from the saved state to cover
  a restart. Negative control: an invalid label (control character) is refused, and the
  title stays `'Old'`.
- M_hint_live: the `createWallWorkspaceController` harness from `v028-grid6.test.js` with
  `savedCells` returning `{'identity-0':{col:2,row:1}}`. Negative control: an identity
  without a saved cell takes the first free cell (0, 0).
- M_recent: `installRoleHost` with a temp `XDG_DATA_HOME` desktop entry and a temp
  executable. It sends `create-program` (`hostXpra:true`) and then `list-apps` over the
  real IPC handler. Negative control: a create that the core refuses leaves `recent` empty.
- M_gemini: pure gate checks plus a full `prepareAgentPrompt` run through the terminal deck
  controller for `agent-gemini` and `agent-opencode`. Negative controls: shell prompt, bare
  banner, the other CLI's prompt, and a login screen (no input delivered).

## Limits

- The CLI screens in `agent-prompts-other-clis.test.js` are synthetic, TUI-shaped strings
  (alternate screen, cursor addressing, colour runs, box drawing). They are not `script -q`
  captures of real CLI versions. No real CLI was installed or authenticated here. They pin
  each profile's branch of the gate, not the real screen bytes. The TESTQ finding 6 risk for
  real redraws remains a manual check.
- M_rec_env was not covered. The guarded line exists only inside the packaged main entry
  that `ui/tools/package.js` generates. Executing it up to the core `spawn` needs a staged
  package (bootstrap config, daemon peer, resources path), which did not fit in the time box.
  Recheck 4 in TESTQ.md still applies.
- `python3 tools/router_index.py --check` reports the router as stale after these commits:
  5 new sources are not yet in `catalogue/nodes.jsonl` [MEASURED]. Regenerating the router
  index was outside the allowed scope (test files and one fragment). The usual follow-up
  commit `tools: update the router index` is needed before merge.

## Suite results (unmutated, with the new tests)

- Go, `go test -count=1 ./...` in `daemon-adapter`: exit 0, 12 packages `ok` [MEASURED].
- UI, `npm test` in `ui`: 4445 tests, 4435 pass, 7 fail, 1 cancelled, 2 skipped [MEASURED].
  All 9 new UI tests pass. Every failure is in an existing file that this branch does not
  touch, and each one is environmental:
  - Need Electron or Chromium rendering, or the Electron binary (`--ignore-scripts` install,
    no display stack). The same set is listed in TESTQ.md: `floating-constraints-render`,
    `v027-tile-chrome` (120 s timeout), `v028-fit-render`, `t4-packaged-security` R1-050
    (ENOENT `/root/.cache/electron`), `uiel-smoke-rss` U13 (no `electron/path.txt`), and
    `renderer-asar` (cancelled).
  - `display-holds` ("DISPLAY stale task …") runs `go` with `GOTOOLCHAIN=local`, and the
    container's default `go` is 1.24.7. `display-reader` R2 measured 16 fps under the
    concurrent Go run. Rerun alone with go1.26.0 first on `PATH`: 25 of 25 pass [MEASURED].

## Product bugs found

None. Every new test passed on the unmutated tree on its first complete run, so no test was
held back.

## Notes for the conductor

- The example subject `tests: cover remembered grid cells` fails `tools/check_laws.py`:
  `tests` is not an allowed scope, and `cover` is not in the verb list [MEASURED]. These
  commits use `core:` and `ui:` with the verb `test`. All three messages pass
  `python3 tools/check_laws.py --message-file`, and the range passes
  `--range origin/cloud/base-e1..HEAD`.
- The commit identity in the task text used a full-width at sign (U+FF20). The commits use
  the ASCII identity from `LAWS.md` and `tools/check_laws.py`:
  `oguirado <247666607+oguirado@users.noreply.github.com>`.
- `python3 tools/check_laws.py --range origin/cloud/base-e1..HEAD` fails only on this report
  commit: `cloud-audit/` counts as a product path, so it would need a changelog fragment.
  The TESTQ commit `2a58c0d3` fails in the same way [MEASURED]. The two test commits pass on
  their own (`--range origin/cloud/base-e1..HEAD~1`: OK). Merge the test commits without this
  report commit, or this commit needs a fragment.
- The fragment and the commit messages avoid CLI product names, because `check_laws.py`
  forbids them in messages and fragments.

---
Model: given in the session chat, not written here (session policy keeps model identifiers out of pushed files).
Effort: session reasoning-effort setting 40; time-boxed to about 45 minutes.
