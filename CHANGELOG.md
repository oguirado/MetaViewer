# Changelog

## [Unreleased]

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
