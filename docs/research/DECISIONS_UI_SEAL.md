# UI architecture seal: maintainer decisions

Applies to UI_ARCHITECTURE.md, ROUTER_BOOTSTRAP.md and RESEARCH_LOG.md (research pass 2, external Q&A research capsules). Verdict: ACCEPTED, with the decisions and open items below.

## D-UI-01: dependency pins
The pins in research/PINS_EVIDENCE.json are binding: the latest stable version published at least 14 days before the pin date. This resolves the flagged conflict:
- dockview-vue and dockview-core are pinned to 8.4.1 (2026-10-05), not 8.6.1. The handoff's 8.6.1 was the latest version at the time of writing, and the 14-day supply-chain rule wins.
- Vue is pinned to 3.5.43. The other pins are as in PINS_EVIDENCE.json.
- Re-pin only by regenerating PINS_EVIDENCE.json under the same rule and recording it here.
- Installing any package still needs the operator's per-package approval.

## D-UI-02: router bootstrap status
ROUTER_BOOTSTRAP.md runs on the router v2 kit fixture (empty-destination smoke: kit tests T2/T3/T9/T10/T11 and index build/--check PASS [MEASURED in pass 2, re-run by the research unit]). Application-code extraction, resolution and calibration are W0 units with owners. They are the first work of the shared UI repo, before any application writer.

## Acceptance evidence
- Pass 1: 7 PASS / 3 PARTIAL / 0 FAIL (independent review, research/ACCEPTANCE_REVIEW_PASS1.md).
- Pass 2: gaps G0a–G6 closed. the research unit re-ran the pass-2 gates: check_documents rc 0, check_reports rc 0, and check_closures with a positive and a negative control for every item, rc 0/1 for all eight. The pass-2 self-check: 8 PASS, #4 resolved by D-UI-01, #7 W0 plan by D-UI-02 (research/REPORT_UIARCH_SOL_PASS2.md).

## Open items carried to W0 (not blocking the seal)
- Exact shipped-licence and installed-tree provenance check (a CI gate against PINS_EVIDENCE.json).
- Dockview panel-retention behaviour qualified on 8.4.1.
- Secure popout transfer under deny-window.open.
- Versioned prompt, session and PTY contracts.
- OpenSuperficies frame-lease transport.
- Platform qualification on Windows, macOS and Linux.
