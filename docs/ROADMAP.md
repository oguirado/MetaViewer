# Hackathon roadmap

All dates, release milestones and acceptance goals below are **[TARGET]** for
**2026** [CITED: operator schedule]. Order: assemble, document and seal, test at
scale, then improve only if margin remains. Video work runs in parallel. Gates
must show both the intended success and rejection of the stated negative control.
No unmeasured capacity number is assumed.

| Day [TARGET] | Goals [TARGET] | Verification gate and negative control [TARGET] |
| --- | --- | --- |
| Oct 23 | Complete contract schemas, fixtures and repository CI; components only | Contract/laws/unit gates pass; malformed schema and mislabeled example fail |
| Oct 24 | os-cu-0 prepares Holdings capsule CLI; measure host capacity with components | start/frame/step/stop returns capsule metadata and a ready line; cross-capsule routing is refused; record measured capacity rather than estimating |
| Oct 25 | Reconcile component seams and pins; video-editor trial; prepare assembly checklist | Captured RAM frame and lane witness agree with their capsule; stale/replayed lane submissions fail; a trial clip exports and plays |
| Oct 26 | Assemble minimal Rust admission loop, Go daemon adapter and Python agent adapter | One Holdings surface [TARGET] connects through typed envelopes; unknown contract versions and malformed proposals fail |
| Oct 27 | Finish the end-to-end see → propose → admit → act → verify loop | One verified Holdings action loop [TARGET], using state digest plus tick window; stale-frame, replayed and out-of-window actions fail |
| Oct 28 | Assemble wall UI with several surfaces, fold/unfold/pin and control handoff; finish docs; seal v0.2; begin recording | Hidden surfaces keep running; pinning preserves ownership; human takeover blocks agent injection; release seal has matching VERSION, dated changelog, pins and green gates |
| Oct 29 | Begin scale testing with web coding workers (volume tests and bounded fixes), and local CLI checks; begin multi-website research task | Record concurrency/capture/verification results; wrong-display injection and missing witnesses fail; no fix merges with red gates |
| Oct 30 | Continue scale tests and multi-website research; repair measured failures; capture usable footage | Research completes across isolated website surfaces with traceable observations; hidden or human-controlled surfaces obey ownership; unsupported success claims fail verification |
| Oct 31 | Finish scale campaign, regression fixes and research demonstration; seal v0.3 | Reproducible session replay and verified research output pass; corrupt record chain and duplicate input fail; release metadata and CI agree |
| Nov 1 | Improve only if assembly and scale gates leave margin; otherwise fix defects; video continues | Accept improvements only with measured benefit and unchanged isolation/verification gates; regressions block inclusion |
| Nov 2 | Finish bounded improvements; feature freeze at end of day | Freeze candidate passes contract, replay, takeover and multi-surface regression gates; unresolved critical failures block freeze readiness |
| Nov 3 | Seal v1.0, run final tests, edit final video | VERSION/changelog/tag plan agree; full regression passes; exported video plays and shows verified product behavior; broken replay or export blocks seal |
| Nov 4 | Buffer, submission packaging and operator submission | Operator verifies artifact, links and video accessibility; missing required assets block submission; no speculative feature work |

Version seals refer to planned release lines; the maintainer selects the exact
SemVer patch, dates the changelog and creates tags only after the gates pass.
This scaffold retains its current version. The maintainer alone pushes and
submits. Scale thresholds come from recorded capacity measurements, which are
currently AUSENTE — no inventar.
