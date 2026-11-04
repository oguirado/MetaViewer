```json
{
  "schema": "metaviewer.reference/v1",
  "version": "0.2.6",
  "status": "source-reference; live qualification is separate",
  "licence": "AGPL-3.0-only",
  "private_components": ["wender-agent", "vision-engine", "OpenSuperficies"],
  "canonical_anchors": ["reading-map", "result-contract", "definitions", "architecture", "engineering-triptych", "domain-contracts", "limits", "reproducibility"],
  "date": "2026-11-04",
  "evidence": {
    "schema": "[TARGET] document format",
    "version": "[MEASURED] VERSION:1",
    "date": "[CITED] reference publication date; not a runtime measurement",
    "licence": "[MEASURED] ui/package.json:4",
    "private_components": "[CITED] NOTICE-EVALUATION.md private-source boundary; pins in deps.lock:1"
  }
}
```

<a id="reading-map"></a>
## 0. Reading map and prerequisites [TARGET]

Judge summary:

- Admission binds actions to fresh frames before dispatch (`core/src/admission/mod.rs:1316`) [MEASURED: inspected source].
- Durable authority journals outcomes before publishing state (`core/src/admission/mod.rs:1523`) [MEASURED: inspected source].
- Slot custody requires human confirmation before credential copying (`daemon-adapter/internal/capsule/slots/store.go:278`) [MEASURED: inspected source].
- Transport input has explicit ceilings (`daemon-adapter/internal/ipc/config.go:20`) [MEASURED: inspected source].

See the [worked refusal](#epistemic-contract), [public evidence guide](EVIDENCE.md), and [Judge Quickstart](JUDGE_QUICKSTART.md).

Action rule: read the result contract, select a capsule boundary, then run the corresponding oracle before claiming support.
If a prerequisite, runtime receipt or private component is missing, report **ABSENT — do not invent** and retain the refusal.

<a id="prerequisites"></a>
### Prerequisites matrix

| Prerequisite | Required understanding or resource | Admission evidence |
|---|---|---|
| Public source checkout | Rust owns authority; rendering does not grant control | [Architecture](#architecture) |
| Source verification | Python, Rust formatter/toolchain, Go and cached UI dependencies | `tools/gate.sh:1732` [MEASURED: tool discovery] |
| Packaged wall | Matching Linux package, reachable graphical display and private runtime directory | `scripts/judge/preflight.sh:177` [MEASURED: refusal path] |
| Browser/Program capsule | Compatible private binaries, container image and an available identity | `daemon-adapter/internal/daemon/environment.go:115` [MEASURED: configuration] |
| Graphical VM / MicroVM | Explicit protected host setup and supported host architecture | `ui/electron/guestCommandProfile.js:47` [MEASURED: capability check] |
| Private components | wender-agent, vision-engine and OpenSuperficies are private; public source verifies their boundary, not their implementation | `deps.lock:1` [MEASURED: pins]; private status [CITED: operator disclosure] |

<a id="persona-tracks"></a>
### Persona reading tracks

| Reader | Link chain |
|---|---|
| Judge | [Result](#result-contract) → [Limits](#limits) → [Tour](#tour) |
| Judge's AI agent | [Definitions](#definitions) → [Architecture](#architecture) → [Oracle](#oracle) → [Evidence](#evidence) |
| Operator | [Domains](#domain-contracts) → [Handoff](#handoff) → [Install](#install) → [Stop](#stop) |
| Contributor | [Laws](#admission-laws) → [Architecture](#architecture) → [Gates](#verification-gates) |
| Security reviewer | [Authority](#authority) → [Slots](#stored-data-slots) → [Private boundary](#private-boundary) → [Negative knowledge](#negative-knowledge) |

<a id="notation"></a>
### Notation index

| Notation | Meaning |
|---|---|
| `surface_id`, `display` | Addressable surface and its display target |
| `profile_id` | Persistent capsule identity; distinct from a surface, role or desktop |
| `generation`, `sha256` | Frame identity used for freshness and content binding |
| `epoch` | Executor incarnation; old execution evidence cannot authorize current work |
| `operation_id`, `slot_id` | Slot operation identity and stored data selection |
| [MEASURED] | Inspected source, counted files or a named executed command; the source/command states which. Static inspection does not imply a live run |
| [CITED] | An identified source or external assertion; reported live results without repository receipts stay attributed |
| [TARGET] | Intended contract or document structure; no runtime success implied |
| ABSENT | Evidence is unavailable; it is neither a successful result nor a numeric zero |

Numeric section labels, schema/version identifiers, architecture names and source coordinates are identifiers; tags on their containing statements describe their provenance. Bounds describe code predicates unless a live receipt is explicitly supplied.

<a id="result-contract"></a>
## 1. Abstract and result contract [TARGET]

MetaViewer is a Linux wall for viewing and controlling capsule surfaces. Electron hosts a Vue interface; the Rust authority admits intents and action proposals; the Go adapter invokes native capsule executors and publishes observations. Human and agent control are explicit states. A tile, a frame and an execution receipt are different evidence objects. `ui/src/App.vue:148`, `core/src/admission/mod.rs:1`, `daemon-adapter/internal/capsule/manager.go:845` [MEASURED: implementation boundaries].

| Contract | Definition | Evidence |
|---|---|---|
| Inputs | Closed versioned envelopes, authenticated component identity, configured capsule profiles, frames, UI intents and proposals | `core/src/admission/mod.rs:52` [MEASURED] |
| Outputs | Admitted/refused outcomes, executor dispatch, surface events, observations and journal records; UI projections of admitted state | `core/src/serve/mod.rs:223` [MEASURED] |
| Guarantee within the public authority | Validate peer/session binding and admission state before dispatch; enforce freshness, control, leases and budget; preserve explicit unknown outcomes | `core/src/admission/mod.rs:52`, `core/src/admission/mod.rs:1159` [MEASURED] |
| No guaranteed task success | A settled input is not proof that a semantic goal succeeded | `core/src/admission/mod.rs:16` [MEASURED] |
| No universal sandbox claim | Host-backed programs and attached desktop windows retain host access | `ui/src/surfaces/RoleSurface.vue:532` [MEASURED] |
| No public private-source proof | wender-agent, vision-engine and OpenSuperficies are private; their algorithms cannot be audited from this checkout | [CITED: operator disclosure]; `deps.lock:1` [MEASURED: pin boundary] |

The inspected checkout identifies itself as `0.2.6` [MEASURED: `VERSION:1`]. The [published pre-release](https://github.com/oguirado/MetaViewer/releases/tag/v0.2.5) has its own assets and reported results [CITED: release notes]. Current source inspection does not certify that package or unpublished changes.

<a id="definitions"></a>
## 2. Definitions, validity and bounds [TARGET]

<a id="capsule-kinds"></a>
### Capsule kinds

The frozen graphical catalog accepts Browser, Program, VM, Game capsule and Desktop capsule, with kind-specific launch targets. Host program and Desktop window are UI/native routes whose names must not imply container isolation. MicroVM commands have a separate guest-command lifecycle rather than a graphical frame contract. `core/src/catalog/mod.rs:15`, `core/src/catalog/launch.rs:4`, `ui/src/catalog/catalogModel.js:118`, `ui/electron/guestCommandProfile.js:47` [MEASURED]. The [domain table](#domain-contracts) distinguishes these routes. Why capsules exist and what each kind gains or loses against plain desktops, tabs, containers, VMs and remote desktops: [WHY_CAPSULES.md](WHY_CAPSULES.md).

<a id="authority"></a>
### Authority core and roles

An action proposal is valid only after closed decoding, peer/session binding and current authority checks. The authority stores live surface ownership, frame identity, injection leases, pending work, remaining budget and executor epoch. Human input and agent proposals have separate admission paths. Taking control cancels pending agent work; ceding control requires fresh observation before reuse. Refused, unknown and verified are not interchangeable outcomes. `core/src/admission/mod.rs:25`, `core/src/admission/mod.rs:52`, `core/src/admission/mod.rs:99`, `core/src/admission/mod.rs:1136`, `core/src/admission/mod.rs:1159` [MEASURED].

<a id="handoff"></a>
### Handoff

A login wall or bot check stops the workflow for the operator. Take control, solve or sign in manually, release control, then explicitly re-run. Acknowledging the notice only hides it; it does not resume execution. Missing or failed handoff reads do not dismiss pending notices. `ui/src/handoff/handoffModel.js:1` [MEASURED].

<a id="identity"></a>
### Identity

A profile is persistent data and native custody, not a tile label. A surface is a live addressable target; a role determines how control is held; a wall desktop groups presentation. A profile cannot be treated as free merely because a frame disappeared. Configuration resolves private binaries from `MV_SRF_BIN_DIR` and profiles from explicit environment metadata. `daemon-adapter/internal/daemon/environment.go:115`, `daemon-adapter/internal/capsule/slots/store.go:274` [MEASURED].

<a id="stored-data-slots"></a>
### Stored data slots

Slots save stopped Browser/Program profile data, including credentials and signed-in sessions. They do not save running processes, open tabs or general machine state. Save, overwrite, load, list, delete and copy are explicit operations; credential copying requires human confirmation and source/destination custody. Protected or foreign identities and live bindings are refused. Load checks kind, architecture and image compatibility. The store records payload hashes and generations; retained generations and orphans count toward quota. Power-loss qualification for btrfs and WSL is ABSENT — do not invent. `contracts/v0.2/capsule_state_request.schema.json:1`, `daemon-adapter/internal/capsule/slots/store.go:1`, `daemon-adapter/internal/capsule/slots/store.go:274`, `daemon-adapter/internal/capsule/slots/store.go:647` [MEASURED].

<a id="rewind"></a>
### Rewind

Rewind is a guest-state operation with owner, generation and authority-epoch binding. Unknown, stopping or pending rewind states gate further commands. Physical reset evidence belongs to the registered daemon. It does not restore external services, host state, authority history or effects already sent outside the guest. Native rewind requires ARM Linux and explicitly admitted protected artifacts; it is developer setup, not a portable turnkey feature. `core/src/rewind_flow.rs:1`, `core/src/rewind_flow.rs:60`, `daemon-adapter/rewind_runtime/native.py:122`, `daemon-adapter/rewind_runtime/config.py:15` [MEASURED].

<a id="grid"></a>
### Grid

The wall grid is presentation. Moving/reflowing tiles does not create a session or confer input authority. Floating placement accepts dimensions from one through five cells per axis [MEASURED: `ui/src/wall/WallWorkspace.vue:16`]. This is a layout bound, not a measured concurrent-capsule capacity. Layout restoration does not create, stop or rebind terminal sessions. `core/src/serve/layout.rs:1` [MEASURED].

<a id="transport-bounds"></a>
### Transport validity and bounds

| Adapter policy ceiling | Value | Failure meaning |
|---|---|---|
| Frame bytes | 1048576 [MEASURED: `daemon-adapter/internal/ipc/config.go:20`] | Oversized frame/configuration is refused |
| JSON nesting depth | 32 [MEASURED: `daemon-adapter/internal/ipc/config.go:20`] | Deeper objects exceed the frozen policy |
| String bytes | 65536 [MEASURED: `daemon-adapter/internal/ipc/config.go:20`] | Larger strings exceed policy |
| Object keys | 256 [MEASURED: `daemon-adapter/internal/ipc/config.go:20`] | Larger objects exceed policy |
| Array items | 4096 [MEASURED: `daemon-adapter/internal/ipc/config.go:20`] | Larger arrays exceed policy |
| Initial hello timeout | At most 5 seconds [MEASURED: `daemon-adapter/internal/ipc/config.go:23`] | Missing handshake cannot leave an unbounded connection |
| Later read timeout | At most 30 seconds [MEASURED: `daemon-adapter/internal/ipc/config.go:23`] | Idle reads must remain bounded |

These are ceilings, not successful-load measurements. Configuration also requires explicit positive limits and deadlines. Rust reads newline-delimited UTF-8 envelopes under its configured frame/deadline bounds and refuses incomplete, oversized or invalid input. `core/src/transport/mod.rs:42` [MEASURED].

<a id="admission-laws"></a>
### Admission laws

| Governing law | Required behavior | Source |
|---|---|---|
| Authorship | Maintainer authors commits; no assistant attribution | `LAWS.md:5` [MEASURED] |
| Version authority | VERSION supplies release identity; component pins change deliberately | `LAWS.md:10` [MEASURED] |
| Contracts first | Schema precedes component messages; breaking contracts retain version boundaries; valid and invalid examples required | `LAWS.md:15` [MEASURED] |
| CI | Laws, contracts, tests and builds gate integration; never weaken tests to pass | `LAWS.md:20` [MEASURED] |
| Privacy | No credentials or personal paths in tracked source; synthetic/scrubbed fixtures | `LAWS.md:25` [MEASURED] |
| Push authority | Maintainer performs pushes and releases | `LAWS.md:29` [MEASURED] |

<a id="verification-gates"></a>
### Verification gates and failure meanings

Run from the checkout root with local toolchains and dependencies installed. The aggregate includes the legs below; a green static gate does not establish live platform qualification. `tools/gate.sh:1944` [MEASURED].

| Gate | Exact command | Failure meaning |
|---|---|---|
| Laws | `bash tools/gate.sh --leg laws` | Repository policy, release or privacy constraint failed |
| Contracts | `bash tools/gate.sh --leg contracts` | Schema/example or generated mirror disagreement |
| Manifest pins | `bash tools/gate.sh --leg manifests` | Dependency, version or frozen offline closure invalid |
| Public unit tests | `bash tools/gate.sh --leg unit` | Public tooling or authority-boundary regression |
| Agent tests | `bash tools/gate.sh --leg agents` | SDK/agent contract or mutation failure |
| JavaScript | `bash tools/gate.sh --leg js` | Native/tooling JavaScript regression |
| Rust | `bash tools/gate.sh --leg rust` | Formatter, clippy or authority tests failed |
| Go | `bash tools/gate.sh --leg go` | Vet, host race tests or opposite-architecture compilation failed |
| UI | `bash tools/gate.sh --leg ui` | Offline install, tests, types or build failed |
| UI smoke | `bash tools/gate.sh --leg ui-smoke` | Isolated renderer/preload smoke failed; inspect display/runtime prerequisites |
| Performance instrument | `bash tools/gate.sh --leg perf` | Budget/instrument tests failed; live memory probe requires explicit enabling |
| Aggregate | `bash tools/gate.sh` | Any required leg failed or was unavailable |
| Gate oracle | `bash tools/gate.sh --self-test` | Gate failed its disposable fixtures/negative controls |
| Reference oracle | `python3 -m unittest discover -s tests -p test_reference_docs.py` | Anchors, evidence tags or source coordinates invalid |
| Router freshness | `python3 tools/router_index.py --check` | Index differs from edited source; integration must refresh it |

The Rust leg checks the whole crate with formatter `1.92.0` [MEASURED: `tools/gate.sh:1757`]. Source coordinates must be rechecked after edits; an index freshness failure requires regeneration before routing can be trusted.

<a id="architecture"></a>
## 3. Architecture map [TARGET]

| Layer | Source coordinate | Responsibility and boundary |
|---|---|---|
| Electron main | `ui/electron/main.js:330` [MEASURED] | Builds constrained window options; context isolation and disabled Node integration |
| Preload | `ui/electron/preload.js:1` [MEASURED] | Narrow renderer/native facade; closed validators before forwarding |
| Vue wall | `ui/src/App.vue:148` [MEASURED] | Projects admitted state; refuses unavailable authority dispatcher |
| Layout | `ui/src/wall/WallWorkspace.vue:164` [MEASURED] | Presets and floating/grid arrangement |
| Host adapter | `ui/electron/hostBindings.js:309` [MEASURED] | Binds guest-command owner and host capability checks |
| Go entry | `daemon-adapter/cmd/mv-daemon-adapter/main.go:24` [MEASURED] | Loads runtime environment and starts adapter |
| Native executor | `daemon-adapter/internal/capsule/manager.go:845` [MEASURED] | Routes native CLI operations; private binary implementation stays outside source |
| Rust admission | `core/src/admission/mod.rs:52` [MEASURED] | Closed proposals, identity binding and state transition authority |
| Rust server/journal | `core/src/serve/mod.rs:223` [MEASURED] | Opens session authority with replayable journal storage |
| Wire contracts | `contracts/v0.2/envelope.schema.json:1` [MEASURED] | Versioned component boundary; contract version is not app version |
| Slots | `daemon-adapter/internal/capsule/slots/store.go:274` [MEASURED] | Native custody, credentials confirmation and profile compatibility |
| Private pins | `deps.lock:1` [MEASURED] | Identifies private component revisions; no private source is reproduced |

<a id="private-boundary"></a>
### Private binaries boundary

`wender-agent`, `vision-engine` and `OpenSuperficies` are fully private: their repositories and source are closed. Compiled x64 builds are publicly downloadable from the pre-release for hackathon judge evaluation only; that download grants no general use or redistribution rights. MetaViewer itself is AGPL-3.0-only. See [NOTICE-EVALUATION.md](../NOTICE-EVALUATION.md) [CITED: licensing boundary]. Pins are declared in `deps.lock:1` [MEASURED]. The public Go manager calls configured CLI binaries; it cannot prove their isolation internals. Fake executor tests prove adapter handling, not that a deployed private binary obeys the same contract. Missing binaries, images or profiles must remain typed unavailable results. No private source, credentials or internal deployment locations are needed to reproduce the public tests.

<a id="engineering-triptych"></a>
## 4. Engineering triptych [TARGET]

<a id="epistemic-contract"></a>
### Panel A — epistemic contract

Worked example: an agent proposes an action against an older frame generation or digest. Admission returns `STALE_FRAME` before dispatch (`core/src/admission/mod.rs:1316`) [MEASURED: source inspection].

`Authority::apply_with_witnesses` appends the input, outcome and next state to the journal before replacing current state (`core/src/admission/mod.rs:1523`). `mv-replay` scans that journal and prints the reconstructed state digest (`core/src/bin/mv-replay.rs:25`) [MEASURED: source inspection].

This is an inspected code path; a live stale-frame demo at this checkout is not established. The existing [admission journal tests](../core/tests/admission_journal.rs) exercise durable replay and refusal histories.

| Claim | Evidence required | Falsifier |
|---|---|---|
| Agent action was authorized | Peer/session binding, current control and fresh frame in authority | Stale frame, human control, exhausted budget or mismatched executor epoch |
| Goal succeeded | Post-action observation checked against the stated goal | Receipt alone or unchanged/wrong output |
| Slot can be loaded | Stopped identity, explicit confirmation, matching kind/architecture/image and valid manifest | Busy/protected profile, denied credentials confirmation or incompatible image |
| Capsule is isolated | Route-specific executor boundary and live evidence | Host program or attached Desktop window |
| Platform is qualified | Actual receipt from that platform and route | Cross-compilation, parser test or another architecture's receipt alone |

The first claim is implemented in `core/src/admission/mod.rs:1159`; execution-only receipt semantics in `core/src/admission/mod.rs:16`; slot custody in `daemon-adapter/internal/capsule/slots/store.go:274` [MEASURED]. Raw platform qualification receipts in this repository are ABSENT — do not invent; reported historical results are attributed in [the evidence guide](EVIDENCE.md).

<a id="negative-knowledge"></a>
### Panel B — negative knowledge

| Tempting inference | Why it fails | Verification contrast |
|---|---|---|
| A visible tile proves control | Display and input ownership differ | Attempt input under human control; authority must refuse agent dispatch |
| A receipt proves task success | Execution settlement lacks a semantic oracle | Inspect the resulting frame or goal verifier |
| A vanished window frees identity | Custody and unknown effects can remain | Slot operations require native stopped evidence |
| A slot is a VM snapshot | Only stopped profile data is stored | Running tabs/processes must not be promised |
| Rewind undoes external effects | Guest state cannot retract network/host effects | Treat external systems as outside the restore boundary |
| Cross-build proves live support | Compilation does not execute target drivers/display/runtime | Keep platform live evidence ABSENT |
| A green anchor test proves prose | Coordinate existence is weaker than semantic entailment | Read the cited predicate and run its independent contract tests |

These contrasts delimit claims; they are not new runtime measurements.

<a id="oracle"></a>
### Panel C — reference usage and oracle

An AI can run these public, local checks from the checkout root. Tests must execute in a bounded user scope; memory limits below are execution targets, not benchmark results. Choose a private per-checkout `CARGO_TARGET_DIR` before Cargo-backed gates.

```bash
python3 -m unittest discover -s tests -p test_reference_docs.py
python3 tools/check_contracts.py
systemd-run --user --scope -p MemoryHigh=6G -p MemoryMax=8G -p MemorySwapMax=0 bash tools/gate.sh # [TARGET] scope limits
systemd-run --user --scope -p MemoryHigh=6G -p MemoryMax=8G -p MemorySwapMax=0 bash tools/gate.sh --self-test # [TARGET] scope limits
```

For consistent bounded execution, place the first checks inside the same scope when running them separately. The document test breaks an anchor, removes an evidence tag and supplies invalid coordinates as negative controls. Its success means the reference is structurally navigable; the whole gate supplies independent implementation checks. Gate commands and formatter policy are implemented at `tools/gate.sh:1732` [MEASURED]. External UI kit and Electron distribution locations must be supplied through `CAPSULE_UI_KIT_REPO` and `ELECTRON_OVERRIDE_DIST_PATH`, never copied from a particular developer host. A failed leg retains its exact diagnostics.

<a id="domain-contracts"></a>
## 5. Domain contracts per capsule kind [TARGET]

Legend: **configured** means code admits a route only with its dependencies; it is not a live qualification claim. **ABSENT** means no qualifying receipt is established here. Reported x64 browser and Program observations are listed in [Judge tour](JUDGE_TOUR.md), attributed to the maintainer; raw receipts are absent. The table below describes source capability, not a denial of those reports.

| Kind / route | Isolation | Input | Frames | Save | Rewind | arm64 | x64 | Windows via WSL2/WSLg |
|---|---|---|---|---|---|---|---|---|
| Identity browser | Private container executor boundary | Human control or admitted agent actions | Published surface frames | Stopped profile slots; credentials travel | Not browser rollback | Configured; live receipt ABSENT | Configured; live receipt ABSENT | Requires graphical Linux/display/container prerequisites; live receipt ABSENT |
| Program | Private program-container boundary | Role-specific native input | Published surface frames | Compatible stopped profile slots | Not process rollback | Configured; live receipt ABSENT | Configured; live receipt ABSENT | Host GUI/image compatibility required; live receipt ABSENT |
| Graphical VM | Guest boundary with private native VM executor | Guest GUI input | Guest display | Profile-slot API does not cover VM | Not interchangeable with MicroVM rewind | Protected setup; live receipt ABSENT | Unavailable | Unavailable on x64 guest path |
| MicroVM | Protected guest runtime | Bounded guest commands | Command outputs, no graphical tile promise | Guest lifecycle, not profile slots | Guest state only; developer setup | Protected setup; Rewind episode observed [MEASURED: operator live run, see [WHY_CAPSULES.md#rewind](WHY_CAPSULES.md#rewind)]; raw receipt not in repository | Unavailable | Unavailable on x64 guest path |
| Game capsule | Private holdings executor boundary | Native game input | Native frames | Profile slots unsupported | No generic rewind claim | Configured; live receipt ABSENT | Live receipt ABSENT | Live receipt ABSENT |
| Desktop capsule | Private desktop executor boundary; distinct from window attachment | Native desktop input | Native frames | Profile slots unsupported | No generic rewind claim | Configured; live receipt ABSENT | Live receipt ABSENT | Live receipt ABSENT |
| Host program | **Not isolated**; runs on operator computer | Host Xpra route / role checks | Host-backed stream | No isolated-profile save claim | No host rollback | Runtime prerequisites; receipt ABSENT | Runtime prerequisites; receipt ABSENT | Requires Linux GUI plumbing; receipt ABSENT |
| Desktop window | **Not isolated**; existing real desktop window | Real window/pointer effects | Attached window frames | No profile slot | No desktop rollback | X11 prerequisites; receipt ABSENT | X11 prerequisites; receipt ABSENT | Reachable X window required; receipt ABSENT |

Evidence for the table: launch targets `core/src/catalog/launch.rs:4`; native routing `daemon-adapter/internal/capsule/manager.go:845`; ARM capability refusal `ui/electron/guestCommandProfile.js:47`; slot kind/compatibility `daemon-adapter/internal/capsule/slots/store.go:281`; host warnings `ui/src/surfaces/RoleSurface.vue:532`; display/runtime checks `scripts/judge/preflight.sh:250` [MEASURED]. Private executor isolation is a boundary contract, not a public-source proof [TARGET].

<a id="limits"></a>
## 6. Applicability limits [TARGET]

| Limit | Plain statement | Evidence |
|---|---|---|
| Guest display | The configured guest display is fixed at `1280x900`; tile resizing does not change the guest display | `tools/arm64_capsule_session.py:544` [MEASURED] |
| Rewind scope | Rewind restores guest state only; host, journal and external effects remain outside its mandate | `core/src/rewind_flow.rs:1`, `daemon-adapter/rewind_runtime/native.py:122` [MEASURED: runtime boundary] |
| Rewind setup | ARM rewind requires developer setup, protected configuration and reviewed artifacts | `daemon-adapter/rewind_runtime/config.py:15` [MEASURED] |
| Release platform boundary | No x64 VM or MicroVM in this release; current code disables the ARM guest routes on non-ARM hosts | `ui/electron/guestCommandProfile.js:47` [MEASURED] |
| Host program | Host program is not isolated | `ui/src/catalog/CatalogLauncher.vue:319` [MEASURED] |
| Desktop window | Desktop window is not isolated and can affect the real pointer/window | `ui/src/surfaces/RoleSurface.vue:533` [MEASURED: host attachment] |
| Stored credentials | Slots carry credentials and signed-in sessions; copy requires human confirmation | `daemon-adapter/internal/capsule/slots/store.go:1`, `daemon-adapter/internal/capsule/slots/store.go:278` [MEASURED] |
| Slot portability | Matching kind, image and architecture are required; no arbitrary cross-platform restore | `daemon-adapter/internal/capsule/slots/store.go:647` [MEASURED] |
| Power loss | Slot power-loss qualification on btrfs/WSL is ABSENT — do not invent | `daemon-adapter/internal/capsule/slots/store.go:7` [MEASURED: declared qualification limit] |
| Windows | Native Windows execution is not established; WSL requires an actual graphical Linux session and compatible dependencies | `scripts/judge/preflight.sh:177`, `scripts/judge/preflight.sh:250` [MEASURED] |
| Untested scope | Source inspection and deterministic checks do not establish live desktop, guest, network, power-loss or private-runtime qualification | Live evidence ABSENT — do not invent |

Repository tests can establish that a refusal is enforced. They cannot prove that a route was never tested anywhere. Historical exhaustive testing coverage is ABSENT — do not invent; no claim from an unmerged branch is admitted here.

<a id="reproducibility"></a>
## 7. Reproducibility [TARGET]

<a id="install"></a>
### Install and doctor

Use the matching release kit and pre-provisioned checksum-verified assets. Install may request administrator consent for host prerequisites and network policy; doctor checks without changing them. Run the launcher from the checkout root or use the kit's corresponding judge entry. `scripts/judge/metaviewer-judge.sh:1`, `scripts/judge/metaviewer-judge.sh:21` [MEASURED]. Do not execute install merely to validate this reference.

```bash
bash scripts/judge/metaviewer-judge.sh doctor --before-install --capsules
bash scripts/judge/metaviewer-judge.sh install --capsules
bash scripts/judge/metaviewer-judge.sh doctor --capsules
bash scripts/judge/metaviewer-judge.sh run
```

For source reproduction, make cached dependency closure available, run `npm ci --offline --prefix ui`, supply the matching UI kit from `ui/kit.lock.json:1` [MEASURED], then execute the [aggregate oracle](#oracle). Resolve tools through PATH or environment variables. Missing dependencies are a failure, not permission to fetch an unpinned substitute. ARM guest setup has a separate local doctor: `python3 tools/arm64_capsules.py doctor` [MEASURED: `tools/arm64_capsules.py:324`]; it does not itself enable an unsupported host.

<a id="tour"></a>
### Tour and result observation

Follow [Judge tour](JUDGE_TOUR.md) for user gestures. Open an Identity browser with an available identity; distinguish Human from Agent, watch frames, take control, release, and re-run after manual handoff. Try Program separately from Host program and Desktop window. Read capability refusal reasons before attempting guest routes. Check the resulting observation against the requested goal; a successful launch or input receipt alone does not satisfy it. Handoff gestures are implemented in `ui/src/handoff/handoffModel.js:1` [MEASURED]. The tour is an operational guide; its reported historical results do not establish current-checkout acceptance.

<a id="stop"></a>
### Stop and custody

```bash
bash scripts/judge/metaviewer-judge.sh stop
```

Stop targets the launcher's scoped capsules and resources. The shared proxy remains running; private package sessions and unrelated host roots are census-only. Do not equate a stop request with proved absence: inspect its diagnostics and reconcile uncertain custody before identity reuse or slot operations. `scripts/judge/metaviewer-judge.sh:38`, `scripts/judge/metaviewer-judge.sh:773`, `scripts/judge/metaviewer-judge.sh:826` [MEASURED].

<a id="evidence"></a>
### Evidence paths and interpretation

| Evidence | Location rule | What it establishes |
|---|---|---|
| Release identity | `VERSION` | Checkout version; no release qualification by itself |
| Private pins | `deps.lock` | Exact declared revisions of private dependencies |
| Kit pin | `ui/kit.lock.json` | UI source kit identity |
| Authority journal | `<state_dir>/sessions/<session_id>/journal.jsonl` | Replayable session history, including admission outcomes |
| State directory | `$XDG_STATE_HOME/metaviewer`, otherwise `$HOME/.local/state/metaviewer` | Local private state root |
| Judge state | `$MV_JUDGE_HOME`, otherwise `$XDG_DATA_HOME/metaviewer-judge` with home fallback | Installed app/deps, run state, logs and `judge_receipt.json` |
| Recordings | `$XDG_STATE_HOME/metaviewer/recordings` with home fallback | Private recorded evidence; never publish unsanitized sessions |
| Slots | `$SRF_IDENTITY_STORE_ROOT/slots` | Credential-bearing manifests/payload generations; keep private |

Path rules are implemented at `core/src/serve/mod.rs:237`, `core/src/journal/mod.rs:4009`, `scripts/judge/metaviewer-judge.sh:84`, `scripts/judge/metaviewer-judge.sh:671`, `daemon-adapter/internal/capsule/slots/store.go:227` [MEASURED]. Runtime roots are variable templates, not developer machine paths. Runtime evidence is private until reviewed and scrubbed. This reference is limited to the public source and explicitly attributed external reports identified above.
