# First run: Use MetaViewer -> mw_run perplexity ask

One page for the operator. `$MV_OPERATOR_REPO` is the MetaViewer checkout the app
was started with, and `$MV_WENDER_ROOT` is the wender-agent checkout at its
`deps.lock` commit. Both come from your launcher environment file.

## Steps

1. **Start MetaViewer** with your usual launcher. The top bar separates
   **Humans** (default view, desktop `1`) and **Agents** (desktop `1`, toggled
   with **Agents** or `Ctrl+Tab`). A cold start without a staged opening mode
   auto-creates the first `mv-live-1` browser capsule in `agent` mode on the
   **Agents** view. To sign in to Perplexity **by hand** first, open
   `mv-live-1` in **Human (login & browse)** mode (or open the tile menu `⋮`
   and choose **Switch to human mode**), sign in, optionally choose **Mark as
   logged in** in the tile menu `⋮`, and then choose **Switch to agent mode**
   in the tile menu `⋮` so `mv-live-1` is active on the **Agents** view on the
   Perplexity home page with an empty composer. Keep only one MetaViewer app
   running.
2. **Check the MemoryWeb home** (from `$MV_OPERATOR_REPO`):

   ```bash
   python3 tools/mw_home_check.py --repo . --workflow perplexity/ask
   ```

   Expected: `{"schema":"metaviewer.mw_home/v1",...,"ok":true,"code":null,"faults":[]}`.
   If you see `"code":"MW_PROVENANCE"`, do step 3 once, then repeat step 2.
3. **One-time provenance fix (only if step 2 asks for it).** The imported
   definitions name a document that is not in the home, so the pinned MemoryWeb
   gate refuses them (`MW_GATE_IO`). If you vouch for these definitions, record
   that yourself. Write the notes file **before** pinning it:

   ```bash
   cd "$MV_OPERATOR_REPO/memoryweb/sites/perplexity"
   cp "$MV_OPERATOR_REPO/tests/e2e/fixtures/mw_perplexity/repair/NOTES.md" PROVENANCE.md
   # Optional: reword PROVENANCE.md in your own words; keep its six "## " headings.
   python3 - <<'EOF'
   import hashlib, json
   notes = open('PROVENANCE.md', 'rb').read()
   for name in ('site.json', 'workflows/ask.json'):
       value = json.load(open(name, encoding='utf-8'))
       value['provenance'].update(source='human', source_ref='PROVENANCE.md', receipt_sha256=None,
                                  quote_sha256=hashlib.sha256(notes).hexdigest())
       open(name, 'wb').write((json.dumps(value, sort_keys=True, separators=(',', ':'),
                                          ensure_ascii=False) + '\n').encode())
   EOF
   ```

4. **Copy the prompt.** Copy the fenced text from [AGENT_ENTRY.md](AGENT_ENTRY.md)
   and paste it into the external AI. Give it `MV_OPERATOR_REPO` and `MV_WENDER_ROOT` when it asks.
   Source the live app attachment in a subshell as documented in
   [AGENT_ENTRY.md](AGENT_ENTRY.md#attachment-and-identity); never guess app values.

## Before the first run on a site: check the anchors

Before dispatching `mw_run`, take a single read-only AX snapshot on the live
capsule and compare the page's accessible names with the workflow's declared
anchors (so locale drift is caught before any input):

```bash
python3 tools/mw_ax_dump.py --repo . --capsule mv-live-1 --site perplexity \
  --workflow ask --out /tmp/mv-ax-dump.json
```

- `rc 0`: every workflow AX name anchor is present on the page; `/tmp/mv-ax-dump.json`
  is written with mode `0600` (without row values).
- `rc 3` (`MW_AX_ANCHOR_DRIFT`): at least one anchor is missing; the printed
  `MW_AX_DUMP` JSON summary lists `candidates` from the live AX tree so the UI
  language or workflow anchors can be aligned before running.

5. **Watch the run.** The AI runs, from `$MV_OPERATOR_REPO/agents`:

   ```bash
   MV_WENDER_ROOT=... python3 -m metaviewer_agents.mw_run --identity mv-live-1 \
     --site perplexity --workflow ask --slot 'prompt=<your question>'
   ```

   Expected on stderr first: `mw_run: perplexity/ask acts on identity mv-live-1
   (network legacy) in 10 s; interrupt now to cancel`. Press Ctrl+C within those
   10 s to cancel before any input. Then the capsule shows a click on the
   composer, the pasted question, and Return.

## Expected result

- stdout, one line: `{"schema":"metaviewer.mw_run/v1","rc":0,"verdict_code":"VERIFIED","receipt":".../memoryweb-run.json","report":".../report.json"}`.
- `report.json`: `"attach":"discovered"`, `"corpus":"staged_builtin_schemas"`,
  `"notice_s":10`, `"network":{"effective_mode":"legacy",...}`, and
  `"answer":{"captured":true,"path":".../answer.txt",...}`.
- `memoryweb-run.json`: `"steps_total":3`, `"steps_verified":3`, `"rc":0`.
- `answer.txt` holds the answer's visible text (owner-only file).
- A sign-in dialog or a CAPTCHA gives `rc 4`, `HUMAN_HANDOFF`, and a handoff
  record path in `receipt`. Nothing on the wall is clicked or typed. Deal with it
  by hand in the capsule, then start a new run if you want.

## Common refusals

| Code | Meaning | Fix |
| --- | --- | --- |
| `MW_RUN_ATTACH` | No app, several apps, the app quit, or a caller value differs | Keep exactly one MetaViewer running; unset the variables named on stderr |
| `MW_DEPENDENCY` | `MV_WENDER_ROOT` unset or not at the `deps.lock` commit | Export the pinned checkout |
| `MW_HOME_*` | MemoryWeb home not admitted | Run step 2 and follow its code |
| `MW_GATE_IO` | Provenance file missing (message names the file) | Step 3 |
| `MW_NETWORK` | Start witness missing or mismatched, or network setting changed | Restart after a network change; for a container binding mismatch, see below |
| `MW_RUN_NO_SURFACE` / `MW_RUN_AMBIGUOUS` | Zero or several live surfaces for `mv-live-1` | Keep one capsule for the identity |
| `MW_WALL_DEADLINE` | Run exceeded the wall-clock deadline (`rc 6`) because a native, socket, or sleep seam blocked | Inspect `report.json` and check core and capsule responsiveness before retrying |

### Packaged rehearsal finding

The packaged P12 build `e5c474cef` also refuses `MW_NETWORK` when the adapter's
start witness names `srf-id-mv-live-1` but the native control receipt and Docker
identify an opaque `srf-id-…` container. The real attach path reports
`"attach":"discovered"`; refusal happens before the countdown or workflow input.
Restarting does not repair this producer mismatch. Report both container IDs
from the start witness and native control receipt, without sending identity
store or browser profile files. The adapter must bind the witness to the
container returned by native start before publishing it. Do not edit a running
capsule's witness to bypass the refusal.

The P11h.1 packaged rehearsal (`f5a5c11fc`) confirms that the witness now names
the actual native container. Its operator checkout still returns
`OUT_OF_SUPPORT` after the countdown: native AX requires explicit store and
registry context, but the backend does not forward the discovered context to
its subprocess. The backend fix in this worktree discovers
`SRF_PROXY_REGISTRY` alongside the store path and forwards both to read-only
native calls, without changing the caller environment. The conductor must
integrate that fix into the operator checkout before repeating the packaged
answer and handoff rehearsal. Verified answers and visible handoffs remain
unproven on this package; do not treat the matching witness as E1 success.

The packaged rehearsal driver is `tests/e2e/rehearse_e1_packaged.py`; supply
`--launcher`, `--run-dir`, `--operator-repo`, `--wender-root`, and
`--proxy-registry` (the launcher's explicit registry path, passed to native
setup without reading its contents), and `--fixture-host` (a local host
interface reachable from the capsule). With `--control-cycle`, it switches from
the initial **Humans** view to **Agents** (`--agents-view-at`), opens the agent
tile menu `⋮` (`--tile-menu-at`), clicks **Take control (emergency)**
(`--take-control-at`), verifies core `human` ownership, and clicks the input
indicator **Release** button (`--release-control-at`) to return ownership to
`agent` without switching capsule role. It uses
the dedicated rehearsal display, temporary fixture definitions, and the
unmodified operator CLI. Its guard checks run with `--self-test`. A successful
rehearsal must prove both the captured answer and a newly visible handoff notice.

## Forward diagnostics

Use `--forward-probe` on the packaged rehearsal driver to retain failed stages
and continue into the login fixture. It writes `stages.jsonl`, native AX results,
and instrumented backend traces in the printed private temporary directory.
A failed HTTP fixture load remains a failure. Diagnostic continuation copies
only the tracked public HTML fixtures into the owned capsule's writable temporary
directory and opens local files; it does not change proxy policy. Continuation
results carry `forced: true` and cannot certify the original HTTP workflow.

The fixture pages declare UTF-8 so the native AX composer name matches the
workflow exactly. The direct continuation uses native paste for the Unicode
prompt and checks focus and character length before submitting. Missing OCR
language data fails the display oracle but does not suppress the login workflow.

A failed owner may return no selected receipt. The CLI then retains its failure
verdict with `receipt: null`; `report.json` preserves the diagnostic and any core
proposal refusal code. This is not a verified run. A successful owner without a
receipt is refused as `receipt path absent`. A stale-frame refusal requires fresh
observation and target verification; the diagnostic driver never rebases a
proposal or retries uncertain core input. The owner backend may now retry only an
explicit STALE_FRAME refusal after fresh perception and target verification.

## Focused E1 receipt path

[TARGET] Each perception acquisition now shares one native AX
snapshot across Wender state, handoff detection and AX predicates. Repeated AX
reads could exhaust Wender's fixed locate deadline before dispatch; the deadline
is unchanged. The forward trace records grounding deadline and remaining time.
`--redundant-ax-mutant` restores those reads as a diagnostic negative control.

Before binding a newer frame, the backend allows a single solid black caret
column inside the uniquely focused editor, with a flat surrounding background
and a bounded height. AX identity, geometry, focus, states and text/value must
still match. Other pixel changes refuse; pre-submission pixel races may trigger
bounded reacquisition. Input with an uncertain outcome is never retried.

A native editor with `value_len: null` and no `value`/`text` cannot prove an
empty slot. The length gate refuses `MW_SLOT_LENGTH`; absence is never treated
as zero. Clicking an already focused editor can also leave pixels unchanged,
which the current core pixel expectation refuses despite valid native input.

The core's frozen wait result deliberately removes embedded `native_evidence`.
Its validated result-level focus, monotonic input timestamp and frame hash are
consumed through the tools receipt wrapper. The original wire receipt is kept
unchanged; missing or contradictory witnesses refuse. Cleanup stops only the
proven owned native capsule before terminating the app, releasing its lease.

## If it fails, send back

1. The stdout JSON line and every `mw_run:` stderr line.
2. `report.json`. It holds codes, paths and the network witness, never the
   question text.
3. The handoff record (`memoryweb-run.handoff.json`) if `rc` was 4.
4. The output of step 2.

Do not send `answer.txt` unless you choose to. Never send the identity store,
tokens, keys or `auth.json`.


## STALE_FRAME: idle metadata fence

[TARGET] The host backend re-perceives before submission and
checks the same AX identity, role, name, geometry and focus. It binds the latest
verified frame only if its pixels and dimensions still match that perception.
At most three submissions [TARGET] fit within the original delivery budget;
only an explicit `STALE_FRAME` refusal permits another attempt. Changed target,
focus, pixels, or a human wall refuses; timeouts and receipt failures never retry.
Exhaustion raises `MW_STALE_FRAME_EXHAUSTED`; the owner reports `INPUT_UNCERTAIN`.
Frame-only assembly callers retain their existing single submission path.

This does **not** repair the packaged idle-fence defect. On the unchanged
P12-f5a5c11fc package, the local-file forward probe observed generation 5,
tick 7 [MEASURED], digest
`b146ac68cef52081169514359e1ab64eeadac13ef300f2d85df4de5c4716750a`.
There were 31 samples over 4.087242296 seconds and no advancing verified frame
[MEASURED]. The generation was current, yet proposals at core sequences 97,
101 and 105 were refused with `refresh_after: 80` [MEASURED]. Lifecycle updates
at sequences 39, 54 and 80 set that fence [MEASURED]. A subsequent diagnostic
native click changed pixels and generation 6 at sequence 106 cleared it
[MEASURED]; this forced action is not a workflow receipt.

The cause spans these read-only diagnosis coordinates:

- `ui/electron/hostBindings.js:588` sends a list heartbeat every 10000 ms [CITED].
- `daemon-adapter/internal/daemon/dispatch.go:52` routes list responses through
  `listSnapshots`; line 134 changes `created` snapshots to `state_changed`.
- `core/src/serve/mod.rs:1357` applies that metadata as a lifecycle update.
- `core/src/admission/mod.rs:401` sets `refresh_after` even for an unchanged
  active/agent snapshot; line 659 refuses proposals while it remains set.
- `daemon-adapter/internal/daemon/environment.go:1272` suppresses unchanged
  verified publications after initial confirmations. Only a subsequent Frame
  transition clears the fence (`core/src/admission/mod.rs:445`).

The separate DISPLAY stream is not the proposal source: `tools.observe` obtains
core's verified `frame_ref`, and `core/src/serve/tools.rs:822` joins it to the
current authority frame. DISPLAY updates cannot clear the verified-frame fence.
The sampled source published 0 advancing frames/s [MEASURED]; its next-frame
period is ABSENT — do not invent. Observation-entry-to-core-submit was 2.680178165 seconds; perception-return-to-
submit was 1.739014699 seconds [MEASURED]. Independent preserved boundary
witnesses show metadata intervals of 10.006900617 and 9.996868696 seconds
[MEASURED]. Reducing that delay cannot clear an already-set fence.

Minimal adapter change [TARGET, outside this unit]: when a list snapshot emits
`state_changed`, capture and publish a fresh verified confirmation frame through
`Manager.Capture` and `Publisher.Publish` (as the create branch already does),
in surface-lock order after the metadata and before further input dispatch.
Do not deduplicate this required confirmation. Keep all core admission checks.
Alternatively, make the UI heartbeat use a separately acknowledged no-lifecycle
path; the existing core-tagged keepalive demonstrates that separation.
Regression gate [TARGET]: idle snapshot -> fence -> forced verified confirmation
-> revalidated proposal -> verified receipt; removing the confirmation must
leave STALE_FRAME. No adapter/core change or package rebuild was made here.

Answer capture now excludes standalone captions of AX buttons and links in the
selected answer container. It preserves matching words within answer prose and
fails capture on ambiguous caption placement. The live local-file diagnostic
produced exactly the fixture answer [MEASURED], without `Copiar`.

`rehearse_e1_packaged.py --forward-probe --file-fixture` goes straight to tracked
HTML files copied into the owned capsule. It samples verified frames and retains
session journal/checkpoint and selected authority transitions with their small
boundary witnesses before package cleanup. A forced native continuation never
certifies receipt verification. Missing OCR language data remains a display
oracle failure. These findings are scoped to the supplied checkout, fixed
package, and local-fixture evidence.
