# Agent-Drive Demo Script (`demo_agent_drive.py`)

I use this document to specify the narrated `8`-checkpoint [MEASURED] agent-drive demo sequence implemented by `tests/e2e/e2e1_slice/demo_agent_drive.py` against the live MetaViewer stack (`tests/e2e/e2e1_slice/stack.py`). I have not rerun live acceptance after the current assembly pins. I require the checkpoint receipts, refusal negative control, and clean `LIVE_STACK_STOPPED` teardown before claiming a new live result [CITED: `tests/e2e/e2e1_slice/demo_agent_drive.py`].

## 1. Design Invariants

- **No wire, contract, core, or UI modifications**: The runner operates exclusively over the frozen `v0.2` [CITED: contracts/v0.2] agent tool verbs (`observe`, `propose`, `wait_verify` in `agents/metaviewer_agents/tools.py`).
- **`navigate` wire verb is `ABSENT — do not invent` by decision**: Local page navigation is composed out of `3` [MEASURED] standard input proposals (`key` `["ctrl", "l"]`, `type` `data:text/html,...`, `key` `["Return"]`).
- **Sequence-level navigation verification (`noop_verified=false` and bounded `post_frame_change`)**: In the browser capsule, the omnibox starts focused with `about:blank` selected, so the initial focus/selection step (`key:ctrl+l`) may settle with `verified: false` (`verification.method: "pixel"`) and an unchanged frame (`after_frame_sha256 == before_frame_sha256`). Navigation is verified as a sequence: a focus/selection step whose receipt has `verified: false` with an unchanged frame is recorded as `noop_verified=false` (not a failure). For the `type:data-url` and `key:Return` steps, the adapter's immediate post-input capture can race Chromium painting a long typed data URL or rendering the navigated document; when a `type` or `Return` step settles with `verified: false`, the runner waits up to `POST_FRAME_CHANGE_MAX_S = 3.0` s [CITED: tests/e2e/e2e1_slice/demo_agent_drive.py] (`POST_FRAME_CHANGE_POLL_S = 0.05` s [CITED: tests/e2e/e2e1_slice/demo_agent_drive.py] poll interval), polling the newest `frame_ready` / `observe` frame for a `sha256` digest that differs from `before_frame_sha256`, and accepts that as `verified: true` with `verification.method: "post_frame_change"`. If no changed frame digest arrives within the `3.0` s [CITED: tests/e2e/e2e1_slice/demo_agent_drive.py] bound (or if a focus step changes the frame without verification), the runner blocks immediately and writes a partial receipt.
- **Partial receipt and failing checkpoint line on any block**: If any checkpoint blocks, the runner prints the failing checkpoint JSON line (`status: "BLOCKED"`, `verified: false`, `error`, `proposal_id`, `verdict_id`, `receipt_id`, `verdict_ids`, `receipt_ids`) to `stdout` and writes a partial receipt (`schema: "metaviewer.demo-agent-drive/v1"`, `status: "BLOCKED"`, `partial: true`, `completed_checkpoints`, `failing_checkpoint`, and `checkpoints` containing completed checkpoints plus the failing one with its verdict/receipt IDs) to `--receipt-out` (or the session work directory).
- **Works alongside `stack.py` via `SCM_RIGHTS` agent handoff**: By default (`--start-stack` unset), the runner attaches to an already-ready `stack.py` session (`LIVE_STACK_READY` in `$XDG_RUNTIME_DIR/metaviewer-live-stack/state.json`), preserving `--display private|visible` and `--record <mp4>` supervision until `stack.py stop` is invoked. The supervisor exposes an owner-only (`0600` [CITED: tests/e2e/e2e1_slice/stack.py]) UNIX control socket at `$XDG_RUNTIME_DIR/metaviewer-live-stack/control.sock`; on a single `handoff-agent` request from the same UID (`SO_PEERCRED` check), it transfers its open agent `core.sock` file descriptor via `SCM_RIGHTS`, closes its own descriptor copy, records `agent_handoff` in `state.json`, and refuses any second handoff (`ALREADY_HANDED_OFF`). The runner continues the existing agent session with uninterrupted `seq` continuity (without `pidfd_getfd` or `ptrace`) and closes the descriptor on exit so the agent session ends cleanly.
- **Live frame update resilience**: Because live capsule frames advance continuously, any proposal during `navigate` or `custody_click` that receives `STALE_FRAME` settles the newest `frame_ready` / `observe` frame and retries with a fresh `proposal_id` up to `TICK_MAX_ATTEMPTS = 3` [CITED: tests/e2e/e2e1_slice/stack.py] attempts (`0.5` s [CITED: tests/e2e/e2e1_slice/stack.py] settle cap, `0.15` s [CITED: tests/e2e/e2e1_slice/stack.py] quiesce window).
- **Mandatory `STALE_FRAME` negative control**: Before dispatching the admitted custody click, the runner deliberately submits a proposal pinned to a stale `based_on_frame`, asserts that `metaviewer-core` refuses it with `reason_code: "STALE_FRAME"`, records the refusal in checkpoint `5` [MEASURED], and continues execution.

## 2. Required Environment and Locked Dependency Worktrees

The live perception and state reader (`default_live_reader`) calls `resolve_locked_component` (`agents/metaviewer_agents/perception/deps_lock.py`), which enforces that `VQA_VE_ROOT` and `MV_WENDER_ROOT` point to clean checkouts at the exact `40`-character [CITED: agents/metaviewer_agents/perception/deps_lock.py] commits pinned in `deps.lock` (`git rev-parse --verify HEAD` must match the lock and `git status --porcelain --untracked-files=no` must be empty):

| Environment Variable | Component | Pinned Version | Pinned `deps.lock` Commit |
| --- | --- | --- | --- |
| `VQA_VE_ROOT` | `vision-engine` | `v0.2.0` [CITED: deps.lock] | `3bb54835db8a2e545311cfcc45185a0dfbd9313a` [CITED: deps.lock] |
| `MV_WENDER_ROOT` | `wender-agent` | `v0.3.0` [CITED: deps.lock] | `41493681a2f4d92aae50c476ed13c219c31a0a02` [CITED: deps.lock] |
| `MV_SRF_BIN_DIR` | `opensuperficies` | `os-cu-w9-mv1` [CITED: deps.lock] | `a9ac1ac8543872b428990ea23fa2629cd0a6d1d5` [CITED: deps.lock] |

If a local clone is on a different branch or has tracked modifications, create clean detached worktrees at the `deps.lock` commits (`git worktree add --detach <dir> <commit>`) before running the live script:

```bash
git -C <vision-engine-clone> worktree add --detach <dir>/vision-engine 3bb54835db8a2e545311cfcc45185a0dfbd9313a
git -C <wender-agent-clone> worktree add --detach <dir>/wender-agent 41493681a2f4d92aae50c476ed13c219c31a0a02
export VQA_VE_ROOT=<dir>/vision-engine
export MV_WENDER_ROOT=<dir>/wender-agent
```

### Known Capsule Issue at Start

- **Chromium `"Restore pages?"` bubble**: When the browser capsule starts or restarts after an unclean browser exit in the profile, Chromium's `"Restore pages?"` bubble may be visible at start in the top-right region of the viewport. The composed `ctrl+l` + `type` + `Return` navigation sequence and the custody click on the `"Advance gate"` button (`margin: 80px` [CITED: tests/e2e/e2e1_slice/demo_agent_drive.py]) are implemented by the runner; I have not reverified them live at the current pins; a run with the crash-restore bubble simultaneously visible on screen is not explicitly documented (`ABSENT — do not invent`).

## 3. Ordered Checkpoints and Transcript Schema

Each checkpoint emits `1` [MEASURED] canonical JSON line (`schema: "metaviewer.demo-agent-checkpoint/v1"`) to `stdout` and is appended to the `checkpoints` array of the `--receipt-out` file (`schema: "metaviewer.demo-agent-drive/v1"`).

| Step | Checkpoint | Wire / Subsystem Operation | Required Proof Fields |
| --- | --- | --- | --- |
| `1` [MEASURED] | `LIVE_STACK_READY` | Inspect `$XDG_RUNTIME_DIR/metaviewer-live-stack/state.json` (or `--start-stack`) | `status: "ready"`, `surface_id`, `capsule`, `display`, `display_mode` (`"private"` or `"visible"`), `record_path`, `narration` |
| `2` [MEASURED] | `observe` | `tools.observe(surface_id, timeout_ms=5000)` + `settle_latest_frame` | `frame_ref` (`frame_ref/v0.2`), `generation >= 1` [CITED: agents/metaviewer_agents/tools.py], `pre_frame_sha256` (`64` [CITED: agents/metaviewer_agents/tools.py] hex chars), `narration` |
| `3` [MEASURED] | `navigate` | `3` [MEASURED] composed proposals (`key:ctrl+l`, `type:data-url`, `key:Return`) + `tools.wait_verify` (`15000` ms [CITED: tests/e2e/e2e1_slice/demo_agent_drive.py] budget) + bounded `post_frame_change` poll (`3.0` s [CITED: tests/e2e/e2e1_slice/demo_agent_drive.py] cap) | `verb_absent_by_decision: true`, `composition` (`3` [MEASURED] items), `steps` (`3` [MEASURED] entries with `verdict_id`, `receipt_id`, `attempts <= 3` [MEASURED], `stale_retries`, `verification`; step `1` [MEASURED] allows `verified: false, noop_verified: false` when `before_frame_sha256 == after_frame_sha256`; steps `2`–`3` [MEASURED] require `verified: true` via receipt or `verification.method: "post_frame_change"`), `post_navigate_frame_sha256`, `narration` |
| `4` [MEASURED] | `read` | `VCorePerceptionAdapter.perceive`, persistent `vadapt.vserve` or one-shot `vadapt.cu_describe` fallback, `project_element_table`, `srf-identity-surface ax`, `wender_state` | `vision_marks` (`count >= 1` [MEASURED], `marks`, `marks_sha256`), `element_table` (`schema: "vqa.element-table/v1"`, non-empty `elements`), `target_node_id`, `pre_state_sha256`, `pre_battery_state_sha256`, `narration` |
| `5` [MEASURED] | `stale_negative_control` | `tools.propose` with deliberately stale `based_on_frame` (`generation` / `sha256` mismatch) | `decision: "refused"`, `reason_code: "STALE_FRAME"`, `continued: true`, `based_on_frame`, `current_frame`, `narration` |
| `6` [MEASURED] | `custody_click` | `local:custody_click/v1` (or `WenderSubprocessAdapter` when `MV_WENDER_PLANNER_CMD` is set) + `AdmittedExecutor.check_target` + `tools.propose` | `planner_id`, `proposal_id`, `verdict_id`, `target_node_id`, `action` (`type: "click"`, `button: "left"`), `based_on_frame`, `decision` (`"admitted"` / `"accepted"`), `attempts <= 3` [MEASURED], `pre_frame_sha256`, `narration` |
| `7` [MEASURED] | `wait_verify` | `tools.wait_verify(proposal_id, expectation, 15000)` | `verified: true`, `focus_verified: true`, `input_mono_ns > 0` [MEASURED], `pre_frame_sha256 != post_frame_sha256`, `after_frame`, `receipt`, `narration` |
| `8` [MEASURED] | `post_state_change` | Post-click `observe` + perception + `wender_state` + `compute_battery_state_sha256` | `verified: true`, `negative_control_reason_code: "STALE_FRAME"`, `frame_sha256_changed: true`, `state_sha256_changed: true`, `battery_state_sha256_changed: true`, `pre_frame_sha256 != post_frame_sha256`, `pre_state_sha256 != post_state_sha256`, `narration` |

## 4. Narrated Operator Walkthrough

### Checkpoint `1` [MEASURED]: `LIVE_STACK_READY`

The runner attaches to the active `stack.py` session on `surface_id` (with `1` [MEASURED] ownership-proven `srf-id-*` capsule container) and records whether `--display private` or `--display visible` and `--record <mp4>` are active.

### Checkpoint `2` [MEASURED]: `observe`

The runner calls `tools.observe` (`5000` ms [CITED: tests/e2e/e2e1_slice/demo_agent_drive.py] timeout) and drains any queued `frame_ready` notifications so `initial_frame` reflects the latest published `/dev/shm` RGB24 frame (`1280x900` [CITED: tests/e2e/e2e1_slice/stack.py] pixels).

### Checkpoint `3` [MEASURED]: `navigate`

Because the `navigate` wire verb is `ABSENT — do not invent` by architectural decision, the runner composes navigation to the deterministic local `data:text/html,...` gate page in `3` [MEASURED] steps:

1. Focus the address bar via `{"type": "key", "keys": ["ctrl", "l"]}`. If `tools.wait_verify` reports `VERIFICATION_FAILED` (`verified: false`) and the post-step frame digest equals `before_frame_sha256`, the runner records `verified: false` and `noop_verified: false` on step `1` [MEASURED] and continues.
2. Enter the encoded `data:text/html,...` payload via `{"type": "type", "text": "..."}`. If the immediate receipt capture raced Chromium painting the long text (`verified: false`), the runner polls the newest `frame_ready` / `observe` frame for up to `3.0` s [CITED: tests/e2e/e2e1_slice/demo_agent_drive.py] (`0.05` s [CITED: tests/e2e/e2e1_slice/demo_agent_drive.py] poll interval) until `after_frame_sha256 != before_frame_sha256` and records `verified: true` with `verification.method: "post_frame_change"`; if the digest does not change within the bound, the step blocks.
3. Commit navigation via `{"type": "key", "keys": ["Return"]}`. As with `type`, if the initial receipt is unverified, the runner polls up to `3.0` s [CITED: tests/e2e/e2e1_slice/demo_agent_drive.py] for a changed frame digest (`verification.method: "post_frame_change"`) and requires the sequence post frame digest to differ from `pre_frame_sha256`.

Each step pins the newest `frame_ready` and retries up to `3` [CITED: tests/e2e/e2e1_slice/stack.py] attempts if a background frame tick triggers `STALE_FRAME`.

### Checkpoint `4` [MEASURED]: `read`

Once the page settles, I invoke `VCorePerceptionAdapter`, using persistent `vadapt.vserve` when its capability handshake succeeds and otherwise the one-shot `vadapt.cu_describe` fallback, to extract vision marks and project the `vqa.element-table/v1` table, fuse it with the native accessibility tree from `srf-identity-surface ax`, and print both `vision_marks` and `element_table` in the checkpoint JSON line alongside `pre_state_sha256` and `pre_battery_state_sha256`.

### Checkpoint `5` [MEASURED]: `stale_negative_control`

Before clicking the target button, the runner constructs a proposal with a deliberately stale `based_on_frame` and submits it via `tools.propose`. `metaviewer-core` refuses admission with `reason_code: "STALE_FRAME"`. The runner records `decision: "refused"`, `reason_code: "STALE_FRAME"`, and `continued: true` in the transcript. If the stale proposal is not refused with `STALE_FRAME`, the runner fails closed immediately.

### Checkpoint `6` [MEASURED]: `custody_click`

The planner selects the actionable button (`"Advance gate"`):

- When `MV_WENDER_PLANNER_CMD` is unset, `local:custody_click/v1` (`gate_g_ai.local_plan`) selects the custody-verified node (`AdmittedExecutor.check_target`) and computes its center click coordinates.
- When `MV_WENDER_PLANNER_CMD` is set to a JSON command array, `WenderSubprocessAdapter` plans the step across the subprocess boundary and `AdmittedExecutor.check_target` verifies custody and bounding-box alignment before admission.

The proposal is pinned to the newest `frame_ready` and admitted by `metaviewer-core` (retrying up to `3` [CITED: tests/e2e/e2e1_slice/stack.py] attempts if a live frame tick intervenes).

### Checkpoint `7` [MEASURED]: `wait_verify`

The runner calls `tools.wait_verify` (`15000` ms [CITED: tests/e2e/e2e1_slice/demo_agent_drive.py] timeout) and records the settled `action_receipt/v0.2`, confirming `verified: true`, `focus_verified: true`, `input_mono_ns > 0` [MEASURED], and `post_frame_sha256 != pre_frame_sha256`.

### Checkpoint `8` [MEASURED]: `post_state_change`

The runner re-observes the surface and recomputes the post-action Wender state (`wender.state/v1`), verifying that the button label transitioned from `"Advance gate"` to `"Gate changed"`, `post_frame_sha256 != pre_frame_sha256`, `post_state_sha256 != pre_state_sha256`, `post_battery_state_sha256 != pre_battery_state_sha256`, and `verified: true`.

## 5. CLI Reference

I run these examples from the MetaViewer clone root after substituting the angle-bracket path placeholders. I use `--session stack` by default; `--session g-ai` selects the alternative live session backend. With `--start-stack`, `--ttl` sets stack lifetime (default `45m` [CITED: `demo_agent_drive.py`]); `--max-attempts` bounds each proposal's retries (default `3` [CITED: `tests/e2e/e2e1_slice/stack.py`]). I use `--self-test` for the deterministic injected-peer suite [CITED: `tests/e2e/e2e1_slice/demo_agent_drive.py`].

I keep the version labels above byte-equal to `deps.lock`; I resolve the exact commits, rather than assuming those commits equal release tags. I use persistent `vadapt.vserve` with the raw-frame capability handshake when available and fall back to `vadapt.cu_describe` [CITED: `agents/metaviewer_agents/perception/vcore.py`]. I can set `MV_WENDER_PLANNER_CMD='["python3", "-m", "wender.plan.cli"]'` to use the pinned planner over the pipe-only `{observation, element_table, goal}` boundary. Wender plans; MetaViewer admits and executes [CITED: `agents/metaviewer_agents/wender_bridge.py`].

```bash
# Attach to an already-running stack.py session and write receipt JSON:
VQA_VE_ROOT=<dir>/vision-engine MV_WENDER_ROOT=<dir>/wender-agent \
  python3 tests/e2e/e2e1_slice/demo_agent_drive.py --receipt-out /tmp/metaviewer-agent-receipt.json

# Start and stop stack.py automatically for a self-contained run:
VQA_VE_ROOT=<dir>/vision-engine MV_WENDER_ROOT=<dir>/wender-agent \
  python3 tests/e2e/e2e1_slice/demo_agent_drive.py --start-stack --display private --record /tmp/demo.mp4 --receipt-out /tmp/receipt.json

# Run the offline unit test suite (16 [MEASURED: test method count in test_demo_agent_drive.py] tests with an injected peer):
python3 -m unittest tests.e2e.e2e1_slice.test_demo_agent_drive -v
```
