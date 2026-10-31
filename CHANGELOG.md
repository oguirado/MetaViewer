# Changelog

## 0.2.0 (unreleased draft)

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
- I fixed the packaged app showing only "forbidden": since eb6d8fbab the bundled renderer handler compared the archive directory's device and inode with a startup pin, and Electron reports changing inode values for directories inside an ASAR archive, so every renderer request got 403. Packages of 0.1.1 and 0.1.2 were affected. The handler now pins the physical archive and keeps the asset digests and URL and path refusals, and the package smoke requires the renderer to load.
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
