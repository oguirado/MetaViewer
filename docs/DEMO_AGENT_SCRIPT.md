# Agent-drive demo script

The developer runner exercises observation, composed browser input, a deliberate
stale-frame refusal and a verified state change. It is a live-stack harness,
not a judge installation command or a general planner. Current live execution
is not established by this guide.

## What does the script demonstrate?

It operates a small local page through the existing agent tools, checks the
result and records a structured transcript.

Answers: agent-drive demonstration; local page; observe propose verify

[demo_agent_drive.py](../tests/e2e/e2e1_slice/demo_agent_drive.py) composes browser
navigation from ordinary key and type proposals. It reads the resulting state,
selects the visible `Advance gate` control and verifies the change to
`Gate changed`. It also submits intentionally stale evidence and requires a
`STALE_FRAME` refusal before continuing.

The fixture is defined by `DEMO_HTML`; navigation is defined by
`composition_actions`. The custody-click planner uses `gate_g_ai.local_plan`
by default. A configured `MV_WENDER_PLANNER_CMD` selects an external planner;
dependency roots alone do not select one [CITED:
`tests/e2e/e2e1_slice/demo_agent_drive.py`, `plan_custody_click`]. A successful fixture run establishes that specific path,
not arbitrary application control, model quality or task completion elsewhere.

## What must be ready before running it?

Prepare the developer stack and pinned perception dependencies, then attach the
runner to that ready session or let it start the stack itself.

Answers: agent-drive prerequisites; attached stack; runtime pins

Follow [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md) for build, display and native runtime
prerequisites. Set `VQA_VE_ROOT` and `MV_WENDER_ROOT` to dependency installations
whose provenance matches [deps.lock](../deps.lock). The runner reads live state
through `default_live_reader` and the public dependency resolver in
[deps_lock.py](../agents/metaviewer_agents/perception/deps_lock.py).

The default mode attaches to `stack.py` through its private control socket. The
supervisor transfers its existing agent connection once and rejects a repeated
handoff. Finish and stop that session before attempting another attached run.
[CITED: ../tests/e2e/e2e1_slice/stack.py, `handle_control_connection`;
../tests/e2e/e2e1_slice/demo_agent_drive.py, `AttachedLiveStackSession`]

## How do I run the deterministic checks or live script?

Use `--self-test` for the runner's unit checks. Use the live command only after
the prerequisites above are satisfied.

Answers: demo self-test; attach command; start-stack command; receipt output

```sh
python3 tests/e2e/e2e1_slice/demo_agent_drive.py --self-test
```

For an already-ready developer stack, choose an output path outside the
repository and set `RECEIPT` to it:

```sh
python3 tests/e2e/e2e1_slice/demo_agent_drive.py --receipt-out "$RECEIPT"
```

Alternatively, let the runner start and stop its own visible developer stack:

```sh
python3 tests/e2e/e2e1_slice/demo_agent_drive.py \
  --start-stack --display visible --receipt-out "$RECEIPT"
```

`--display` applies to a stack started by this command. Attaching to an existing
stack keeps that stack's display and recording configuration.
[CITED: ../tests/e2e/e2e1_slice/demo_agent_drive.py, `parser`, `main`]

## What must appear in a successful transcript?

Every checkpoint must pass in order, and the final receipt must show changed
frame and state digests plus the expected stale-frame rejection.

Answers: checkpoint order; final receipt; verified state change; negative control

| Checkpoint | Meaning |
| --- | --- |
| `LIVE_STACK_READY` | The runner has the selected stack and capsule |
| `observe` | Fresh frame evidence is available |
| `navigate` | The composed input reached the local fixture |
| `read` | Live state was read for the current frame |
| `stale_negative_control` | Stale evidence was refused with `STALE_FRAME` |
| `custody_click` | The selected visible control received an admitted click |
| `wait_verify` | The action's verification result was collected |
| `post_state_change` | Post-action state and frame evidence changed |

`validate_transcript_and_receipt` requires `status: "PASS"`, `verified: true`,
different pre/post frame and state digests, and a tested negative control that
continued after the expected refusal. The checkpoint and receipt schemas are
`metaviewer.demo-agent-checkpoint/v1` and `metaviewer.demo-agent-drive/v1`
[CITED: ../tests/e2e/e2e1_slice/demo_agent_drive.py].

## Which results need careful interpretation?

A blocked or partially verified run remains blocked. Preserve its transcript
instead of replacing an uncertain checkpoint with a success claim.

Answers: partial demo receipt; no-op focus; post-frame change; stale retry

| Result | Interpretation |
| --- | --- |
| `noop_verified: false` on initial focus selection | The frame was unchanged; this is not proof that the input caused a visible change |
| `verification.method: "post_frame_change"` | The navigation step was accepted after a bounded wait for changed pixels; the later state check is still required |
| `STALE_FRAME` during an ordinary proposal | The runner refreshes evidence within its attempt bound; this is separate from its deliberate refusal checkpoint |
| `status: "BLOCKED"`, `partial: true` | A required checkpoint failed; the receipt retains completed checkpoints and the failing one |
| Cleanup failure | Retain recovery state and investigate before starting another stack |

These interpretations follow `run_demo_agent_drive`, `validate_checkpoint_line`
and `validate_partial_receipt` in the runner. Stop an attached stack with the
command in [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md); a transcript alone does not prove
that cleanup completed.
