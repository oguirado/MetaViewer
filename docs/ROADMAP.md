# Hackathon roadmap

Release **0.1.1** [TARGET] is the pre-event documentation baseline:
scaffold, design notes and the pre-existing work declaration. The build
period starts at kickoff on **October 26, 2026** [CITED: operator schedule].
All dates, release milestones and acceptance goals below are **[TARGET]** for
**2026**. Order: write contracts v0.2 and skeletons, assemble a vertical
slice, reach feature complete, package, then test at scale, polish and seal.
Video work runs in parallel. Gates must show both the intended success and
rejection of the stated negative control. No unmeasured capacity number is
assumed.

| Day [TARGET] | Goals [TARGET] | Verification gate and negative control [TARGET] |
| --- | --- | --- |
| Oct 26 (day 0) | Write contracts v0.2 and component skeletons; finalise pins in a `deps:` commit | Contract/laws/unit gates pass on the new tree; malformed schema and mislabeled example fail |
| Oct 27 (day 1) | Vertical slice: core admission, capsule adapter, frames to the wall, built-in terminal, AI control CLI | One capsule [TARGET] admits an action and shows its frames on the wall; unknown contract versions and malformed proposals fail |
| Oct 28 (day 2) | Feature complete: fold/unfold/pin, control handoff, full see-propose-admit-act-verify loop | Hidden surfaces keep running; pinning preserves ownership; human takeover blocks agent injection |
| Oct 29 (day 3) | Packaged linux-arm64 product | Package installs and runs on linux-arm64 [TARGET]; broken install or missing manifest blocks the package |
| Oct 30 | Large-scale testing | Record concurrency/capture/verification results; wrong-display injection and missing witnesses fail; no fix merges with red gates |
| Oct 31 | Polish and regression fixes | Accept fixes only with measured benefit and unchanged isolation/verification gates; regressions block inclusion |
| Nov 1 | Code seal v1.0.0 | VERSION, changelog, pins and tag plan agree; full regression passes; broken replay blocks seal |
| Nov 2 | Demo video | Exported video plays and shows verified product behavior; faked or pre-rendered shots fail review |
| Nov 3 | Submission packaging | Artifact, links and video verified accessible; missing required assets block submission |
| Nov 4 | Buffer and operator submission | Operator verifies the submission end to end; no speculative feature work |

Version seals refer to planned release lines; the maintainer selects the exact
SemVer patch, dates the changelog and creates tags only after the gates pass.
This scaffold retains its current version until sealed. The maintainer alone
pushes and submits. Scale thresholds come from recorded capacity measurements,
which are currently AUSENTE - no inventar.
