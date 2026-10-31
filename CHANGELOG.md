# Changelog

## [Unreleased]

- Ship the identity and RAM-admission reclaim tools under `resources/operator/tools` and resolve the packaged identity tool there.
- Publish an owner-only attach pointer (`metaviewer.attach/v1`, `attach/current.env`) so an external AI reaches the live session's core and capsule identity; retract it on every stop path.
- Refuse a packaged boot with an absent live RAM root (`RAM_ROOT_ABSENT`) or a second instance (`SINGLE_INSTANCE`, existing window raised) before any child starts.
- Echo human clicks on the wall tile with a local dot that hides when a frame with a newer input timestamp is presented or after 1000 ms, never draws in the letterbox and drops with the input gate, and keep the context menu and auxiliary-button click of an input-armed tile away from Electron defaults.
- Dispose the adapter on SIGHUP, hide the window before bridge teardown, quit on Ctrl+Q, and give the adapter a 45 s [TARGET] stop grace above its 30 s [CITED] capsule close budget.
- Make Automate from a demo complete end to end: export real recorder keys (Page Up/Down arrive as Prior/Next), multi-window final frames and recordings with a failed after-frame capture, keep keypad digits refused, free the RAM copy after sealing, check authored sites without following links, and give the dialog id validation, single-use ids, specific refusals and the recording location.
- Word the CAPTCHA and login-wall handoff notice per reason with ordered operator steps (take control, WRITE, solve, release, re-run) and show an unavailable handoff list instead of staying silent.
- Arm wall input when the operator takes control of a capsule from the wall (tile Control action, the tile's view-only chip or the handoff notice): the tile turns interactive once the host grants human control, shows "View only — press Control to interact" otherwise, carries an outline, a crosshair pointer and a Release action while interactive, and the handoff take-control reveals the capsule's tile.
- Reopen a closed browser tile: a create refused as a bound profile now returns a typed `SURFACE_PROFILE_BOUND` and shows the live tile again, a stopping capsule's late error no longer settles the next create, and the wall offers Add capsule after every tile was closed.
- Keep the host connection up when a recording stops or the coordinator refuses: admit the core `dropped_frames` key and the `BUDGET_EXCEEDED` and `POLICY` capture refusals in the main and preload capture asserts.
- Let the renderer pick a recording frame rate (`max_fps`, whole number 1 to 60, "up to the source rate") and show typed capture refusals and the sealed frame and drop counts in the recording panel; correct the guide's capture API and terminal notes.
- Verify shutdown budget parity against Electron’s actual grace, including IPC and subscription teardown, and align the lifecycle e2e assertion with `PROFILE_ALREADY_BOUND`.
- Let an in-flight native create finish for a bounded grace (10 s [TARGET]) when the adapter session is cancelled, so a quit mid-create no longer kills the start and leaks its RAM reservation; shutdown then stops the capsule with verified removal.
- Admit the human wheel at the adapter: a human `scroll` action lowers to one `srf-identity-surface input --scroll X,Y --dir up|down|left|right --count N` call on the dominant axis (50 px per step [CITED: noVNC], 1..20 steps [TARGET, unit decision], surface centre when the closed core schema carries no position); agent scroll stays unsupported and the receipt omits the `kind` the frozen contract cannot name.
- Route human text through `--paste` only when the batch holds a rune outside 0x20-0x7E, so non-ASCII text reaches the capsule while plain ASCII keeps the faster `--type-stdin` path (a paste costs about 1.7 s per call [MEASURED]); the agent profile rule is unchanged and text stays on stdin.
- Name the reservation records of other owners, and the documented reclaim dry run, in the RAM admission refusal detail.
- Give each shutdown stop a fair share of the 30 s close budget, never start a stop on a spent budget, report every failed or skipped stop, and keep the adapter's worst case below the host grace (45 s [TARGET]).
- Emit stable uppercase adapter refusal codes (`PROFILE_ALREADY_BOUND`, `SURFACE_CAPACITY_OR_QUARANTINE`, `IDENTITY_UNAVAILABLE`, `ADAPTER_<CODE>`) instead of the masking lowercase `adapter`, and type a native "identity unavailable or exclusively held" start refusal with its recovery limits.
- Make the renderer input port handle the wheel and control loss like a remote-desktop client: wheel input that carries its DOM delta mode accumulates into whole 50 px steps with a carried remainder (line and page deltas count 19 px each), closing a capsule's input gate sends one key-up-only `release_all` after any dispatched input (never dropped by the epoch fence or the rate window; READ switches and host-driven closures send none), a drag released outside the frame can be mapped onto the frame edge, and the tile policy blocks `contextmenu` and `auxclick` only while input is armed. Tile wiring of the clamp and the block policy, the preload allowlist and the wire schema for `release_all` follow in the units that own those files.

- Preserve the shared packaged RAM admission ledger and drain adapter shutdown before runtime cleanup.
- Register and validate retail frame reports and cover the complete preload invoke surface.
- Track initial capsule creation asynchronously with an independent final deadline and typed busy refusals.
- Delay packaged core spawn until native platform readiness and add an opt-in scrubbed operator smoke.
- Fix the multislot flow: disable the unwired slot Close, block WRITE under agent control, make first Move/Tab submit the current placement, keep Back with an empty notice when the last capsule leaves, and show surface state on the folded rail.
- Report unavailable terminal providers when native PTY support cannot load.
- Give the tile canvas more height by sharing one rail row for Network and capture chrome and moving the state word onto the witness strip line; frame paint and pointer input share one contain transform.
- Show 'Agent acting' only while a busy session or in-flight proposal is present; an idle agent-owned tile reads 'Agent ready'.
- Admit strictly bounded surface creates through the host and retain created surfaces for frame delivery.
- Keep idle daemon connections live with tagged list probes and acknowledged notices while retaining silent-peer deadlines.
- Attach `mw_run` to the running packaged app, explain each refusal on stderr, diagnose MemoryWeb provenance faults, capture the verified answer text, and add an offline Perplexity ask end-to-end test with login and CAPTCHA handoffs.
- Answer the core keepalive probe on the adapter's streaming path, ahead of the data queue, through one shared helper.
- Return visible `TERMINAL_UNAVAILABLE` when native terminal support is absent from a package.
- Refuse browser proposals before IPC when a live surface or frame is absent and show typed refusal codes.
- Forward only validated live text-input modes and hold package smoke to check create delivery and adapter liveness.
- Make packaged identities usable and typed: fall back to the operator checkout's `tools/mv_identity.py`, default `MV_MW_HOME`, stop a login with SIGINT so its reservation is released, return `IDENTITY_REFUSED` apart from `IDENTITY_UNAVAILABLE`, and normalize dialog input.
- Discover agent handoff records from the newest private run directories so the human-handoff notice can appear without a launcher path list; an explicit `MV_HANDOFF_PATHS` keeps its closed behaviour.
- Give an operator demo Stop 300 seconds to seal evidence before escalating, keeping the 10 second budget for quit-time disposal, and refuse a check result that declares a non-user site source.
- Report the adapter's "profile already bound" create refusal as the stable `PROFILE_ALREADY_BOUND` code instead of a generic failure.
- Let the MemoryWeb owner validate a home that carries no `standards/schemas` against the pinned bundle, while a present schema directory is still compared and never replaced.
- Make the operator ChatGPT and Gemini MemoryWeb sites runnable: real provenance files, zero minimum notice, a 16000-character Gemini prompt cap, a polled Gemini completion step and documented re-ask and wall procedures.

- Refuse required-adapter boot with a typed, redacted configuration reason and honest startup guidance.
- Identify native capability replies without network modes as `legacy_binary`, preserving legacy behavior.

Changes after candidate `2a1ee6d5c` through `7a4aad3ae`
[CITED: `git log --oneline 2a1ee6d5c..7a4aad3ae`].
Open remains gated on the operator-provisioned identity image `0.2.0`, firewall
witness and final Open-ready native pin [CITED: `docs/INSTALL.md#capsule-network`].

### Added

- Add the Use MetaViewer and Automate from a demo buttons (`306479a8f`) [CITED: git history].
- Add the demo recording flow behind Automate from a demo (`937b8511d`) [CITED: git history].
- Add the identities menu, capsule network setting and hand-off notice (`2505650dc`) [CITED: git history].
- Add the agent entry that runs one MemoryWeb workflow (`4f412d55d`) [CITED: git history].
- Add the custodied MemoryWeb owner with text and CAPTCHA hand-off (`ff477f464`) [CITED: git history].
- Add host-wide RAM admission for several live capsules (`4a5fca630`) [CITED: git history].
- Add identities as logged-in browser profiles (`3145a2f0e`) [CITED: git history].
- Add per-capsule network modes to the daemon adapter (`a54aee7b7`) [CITED: git history].
- Add a private MemoryWeb home that refuses browser profiles (`da3b333a6`) [CITED: git history].
- Add automation packs to the web runner (`8fd79043b`) [CITED: git history].

### Changed

- Update the router index (`7a4aad3ae`) [CITED: git history].
- Update the router index (`52193bb11`) [CITED: git history].
- Update the usage ledger (`158f91f9a`) [CITED: git history].
- Update the router index (`e29810087`) [CITED: git history].
- Update the router index (`0dce1585e`) [CITED: git history].
- Update the router index (`3fa973d47`) [CITED: git history].
- Update the router index (`22b586dbc`) [CITED: git history].
- Update the usage ledger (`ad1f1a6b6`) [CITED: git history].
- Update the usage ledger (`ef3a0eee5`) [CITED: git history].
- Update the usage ledger (`63411cb08`) [CITED: git history].
- Update the router index (`12c7236a7`) [CITED: git history].
- Pin OpenSuperficies to the net-modes commit 3cb86d7 (`3e3704303`) [CITED: git history].
- Update the usage ledger (`d96b1d8df`) [CITED: git history].
- Update the router index (`4d1d6a057`) [CITED: git history].
- Update the router index (`a1d178417`) [CITED: git history].
- Update the router index (`44b1b336e`) [CITED: git history].
- Update the router index (`1554105df`) [CITED: git history].
- Update the usage ledger (`d1b02311f`) [CITED: git history].
- Update the router index (`c007f1f34`) [CITED: git history].
- Update the router index (`1abd0ce46`) [CITED: git history].
- Enforce capsule-sized type calls for agent text in the adapter (`b4da97547`) [CITED: git history].
- Update the usage ledger (`86de7ec88`) [CITED: git history].
- Update the router index (`d8684995f`) [CITED: git history].
- Update the usage ledger (`3d4ecbf36`) [CITED: git history].
- Update the router index (`48adc3668`) [CITED: git history].

### Fixed

- Fix the e2e lifecycle hang and run MemoryWeb e2e with Wender (`319ea1912`) [CITED: git history].
- Keep RAM admission usable on small hosts and its tests hermetic (`1899ab357`) [CITED: git history].
- Check every tracked Cargo.lock against the release version (`b5587d602`) [CITED: git history].

## 0.2.0 (candidate) [CITED: `VERSION`]

- Fixture navigation clicks the focus prelude only on the session's first navigation; later tasks start at ctrl+L, because a blank-content click after a page interaction changes no pixel.
- Live perception now requests marks every tick; earlier v0.2.0 candidates perceived zero elements on settled pages.
- Web fixtures now expose synchronized chassis-role names; the pinned Wender omits plain paragraphs, table cells and unnamed status text, which agents must read via AX (srf) or vision.
- I fixed fixture navigation with capsule clipboard paste, bounded post-input repaint settling, and the shorter equivalent data URL.
- I made the capsule wall and agent loop safer under failure: stale or unknown daemon frames get a journalled STALE_FRAME verdict without dropping the daemon, a capsule is only reused after proven absence, and input after a revive waits for a fresh probe.
- I made perception faster: the agents keep one persistent vision-engine client (p50 7.6 ms per 1280x900 frame on the trusted path), and wender-agent uses the same persistent bridge with raw RGB frames.
- I hardened the perception interpreter: a pinned Python and a trusted extra site checked through its parent chain, contents and hooks before every spawn.
- I added opt-in live runners for web automation (three local fixture tasks with the network down) and for the Holdings trial, each with a verifiable receipt; their live results are not claimed in this release.
- I added an opt-in shared-memory capture ring reader; the wall keeps the legacy capture path until the ring is installed.
- I made the terminal tile survive throttled input (retryable refusals), refused Holdings output with duplicate keys, and kept the recording ceiling at 60 fps.
- I added test-gap suites for agent perception, Electron capture, core admission, serve and settings, and fixed a load-sensitive core test.

## 0.1.2 (2026-10-27)
- I connected the real core, daemon adapter and Electron tile over one live capsule, and passed G-W1 with verified agent receipts.
- I passed the G-AI live gate with vision-engine and wender-agent pinned by commit and loaded externally, never vendored.
- I received a W1 verdict of PASS_WITH_FIXES from two independent judges.
- I added the observe/propose agent loop, recording, per-tile capture, settings validation and the theme gate.
- I added deterministic Linux packages for arm64 and x64, clean-install smoke checks and hosted CI on both architectures.
- I kept MetaViewer Linux-first: arm64 is the primary target and x64 stays supported; macOS and Windows are not supported.

## 0.1.1 (2026-10-26)
- Add pre-event design and research notes (commit e06d627).
- Rewrite the README and add the pre-existing declaration.
- Publish the public hackathon roadmap.
- License the repository under the PolyForm Strict License 1.0.0.

## 0.1.0 (never tagged; superseded by 0.1.1)
- Preserve repository laws and the initial version.
- Add commit identity/message and version checks, with an executable commit-msg hook.
- Define versioned closed JSON contracts and synthetic valid/invalid fixtures.
- Add a standard-library subset schema validator and unit tests for both checkers.
- Add CI for commit laws, release version consistency, contracts and unit tests.
- Document authority, capture, component seams, replay design and the hackathon gates.
- Record dependency pins and explicit unresolved OpenSuperficies metadata.
- Add documentation-only Rust, Electron, Python and Go adapter skeletons.
