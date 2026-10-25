# Acceptance review — research pass 1, shared capsule visual architecture

Independent read-only review. Documents: UI_ARCHITECTURE.md, ROUTER_BOOTSTRAP.md, RESEARCH_LOG.md, REPORT_UIARCH.md in `<CAMPAIGN_OSCU0>/w8/pplx/sol/`. Criteria: section 4 of `docs/research/HANDOFF_OSCU0_UI_RESEARCH.md`. Laws: `docs/ARCHITECTURE.md` and `<CAMPAIGN_VQA_WS>/hb_mv_ctx_ui-drop/CTX_UI_PACK.md`. Prior art: `<CAMPAIGN_VQA_WS>/hb_mv_on_multislot-drop/hb_mv_on_multislot.md` and `<CAMPAIGN_VQA_WS>/hb_mv_of_orch-drop/hb_mv_of_orch.md`.

Result: 7 PASS, 3 PARTIAL, 0 FAIL. The research pass is honest about every boundary; the partials are identifiable content gaps, not overclaims. Per instruction the two known gaps (exact pins/licences; router kit) are rated briefly below and excluded from the gap list.

## Criteria

1. Operator requirements mapped — PASS. UI §1 maps each HANDOFF §1 requirement to a design element, e.g. "Shared ShellGrid, DockWorkspace, CapsulePanel, MultiSlot, OrchestratorDrawer and token artifact; product content supplied through adapters" (`<CAMPAIGN_OSCU0>/w8/pplx/sol/UI_ARCHITECTURE.md:38-45`). Nothing silently dropped; blocked items stay explicit. No gap.

2. No contradiction with fixed laws — PASS. Sol retains Rust authority, closed IPC, no Electron injection, JS/JSDoc with no authored TypeScript, enabled backgroundThrottling, and deterministic core: "No game simulation or admission logic is ported into Vue." (`<CAMPAIGN_OSCU0>/w8/pplx/sol/UI_ARCHITECTURE.md:34-34`). The popout-vs-deny-window.open tension is kept BLOCKED rather than resolved by weakening policy. No gap.

3. Evidence discipline — PASS. Every decision carries Q ids, exact quotes, or [TARGET]; unknowns are AUSENTE, never invented APIs: "All proposed names, paths, schemas, events, limits and writer units are [TARGET] unless an evidence citation says otherwise." (`<CAMPAIGN_OSCU0>/w8/pplx/sol/UI_ARCHITECTURE.md:3-6`). RESEARCH_LOG covers all 23 questions with adopt/reject reasons. No gap.

4. Exact pins and licences — PARTIAL (known gap, maintainer holds evidence). Pins are named but the text states: "Licence checking here means reconciling supplied assertions and identifying missing proof. It is not an exact shipped-artifact licence clearance." (`<CAMPAIGN_OSCU0>/w8/pplx/sol/UI_ARCHITECTURE.md:77-77`). Not repeated further here.

5. Multislot + drawer lifecycle precision — PASS. UI §6/§7 give state/event/guard tables, e.g. "Toggle hides body without destroying terminal or session; focus returns to fold button before hiding" (`<CAMPAIGN_OSCU0>/w8/pplx/sol/UI_ARCHITECTURE.md:177-177`), and §13 bounds every unit: "Each unit owns at most **3 files [TARGET]**." (`<CAMPAIGN_OSCU0>/w8/pplx/sol/UI_ARCHITECTURE.md:330-330`). Detail gaps inside the dispatch spec are items G2–G4 below.

6. Testable AI-operability contract — PASS. UI §9 gives the control-family matrix ("Every actionable control and meaningful container has a stable semantic anchor, effective role, computed accessible name, state and current box.", `<CAMPAIGN_OSCU0>/w8/pplx/sol/UI_ARCHITECTURE.md:241-241`), box rules ("Synthetic containers/status have null boxes; only currently materialized visible nodes get real boxes.", `<CAMPAIGN_OSCU0>/w8/pplx/sol/UI_ARCHITECTURE.md:261-261`), and the exact digest rule (see (e)). The retail producer endpoint stays honestly BLOCKED. No gap.

7. Executable router bootstrap — PARTIAL (known gap, maintainer holds evidence). Steps are staged and paper-quoted, but "end-to-end software routing is **BLOCKED** by prerequisites the paper itself identifies as unwritten." (`<CAMPAIGN_OSCU0>/w8/pplx/sol/ROUTER_BOOTSTRAP.md:3-3`). Not repeated further here.

8. Holdings mapping explicit — PARTIAL. UI §11 gives logical capsule routes ("These are logical capsule routes, not new gameplay command APIs", `<CAMPAIGN_OSCU0>/w8/pplx/sol/UI_ARCHITECTURE.md:281-281`) with 9 rows covering home/HQ, people, production, equity, loan (as Finance/loans), inbox, pacing/calendar. Gap: 5 of the 12 required screens have no row — newgame/intro, recovery, share-price, products, saves (only "founding/onboarding actions" inside the Home row hints at newgame). See G1.

9. Terminal security — PASS. All three sub-rules explicit: "Closed structured AI console in players; raw PTY only explicit developer mode or MetaViewer; no generic spawn bridge" (`<CAMPAIGN_OSCU0>/w8/pplx/sol/UI_ARCHITECTURE.md:59-59`), and "Untrusted arriving text is display data only: never automatically executes, pastes, grants permissions, opens links or reads/writes clipboard." (`<CAMPAIGN_OSCU0>/w8/pplx/sol/UI_ARCHITECTURE.md:225-225`). No gap.

10. Risks with closure — PASS. UI §14 lists R1–R14, each with conservative behavior plus "Closure owner and discriminating evidence [TARGET]" (`<CAMPAIGN_OSCU0>/w8/pplx/sol/UI_ARCHITECTURE.md:355-368`). No gap.

## Detail checks

(a) Hidden bodies never unmounted — PASS. "Folded live hosts stay mounted using `v-show`/equivalent permanent host, with scheduling disabled." (`<CAMPAIGN_OSCU0>/w8/pplx/sol/UI_ARCHITECTURE.md:185-185`), with remount fallback via attach/replay.

(b) Idempotent request_id + per-slot lock — PARTIAL. Dispatch sends "proposed versioned orchestration intent with idempotency identity" (`<CAMPAIGN_OSCU0>/w8/pplx/sol/UI_ARCHITECTURE.md:201-201`) and orders "Never resend under a new request automatically" (`<CAMPAIGN_OSCU0>/w8/pplx/sol/UI_ARCHITECTURE.md:209-209`). Gap: no literal `request_id` field with derivation/dedup semantics, and no per-slot dispatch lock or GUI/headless advisory single-writer rule (prior art requires both). See G2–G3.

(c) Every prompt a core-admitted intent — PASS. "Frozen target set and prompt, core-admitted per-target work, attributed receipts; no PTY fan-out" (`<CAMPAIGN_OSCU0>/w8/pplx/sol/UI_ARCHITECTURE.md:60-60`). The missing versioned prompt/dispatch schema is honestly flagged AUSENTE as a core-owner dependency, not a research defect (`<CAMPAIGN_OSCU0>/w8/pplx/sol/UI_ARCHITECTURE.md:138-138`).

(d) Closed console vs raw shell — PASS. Player console "presents structured agent dialogue/results, targets and permission decisions, with no shell input or generic process-launch capability", while "Developer/MetaViewer PTY requires explicit authorized mode and core-admitted session profile" (`<CAMPAIGN_OSCU0>/w8/pplx/sol/UI_ARCHITECTURE.md:219-219`).

(e) Geometry-free digest — PASS. "take the complete canonical STATE and replace every `node.box` with `null`; change/remove no other field" with boxes kept in the frame-binding hash (`<CAMPAIGN_OSCU0>/w8/pplx/sol/UI_ARCHITECTURE.md:265-265`). Matches the fixed law exactly.

(f) Screen-to-capsule completeness — PARTIAL. 7 of 12 required screens mapped (see criterion 8). See G1.

(g) Writer units at most 3 files — PASS. "Each unit owns at most **3 files [TARGET]**." and all 13 units list exactly 3 files each (`<CAMPAIGN_OSCU0>/w8/pplx/sol/UI_ARCHITECTURE.md:330-346`).

## GAP LIST for research pass 2

G1. UI §11: add one table row per missing Holdings screen — newgame/intro, recovery, share-price, products, saves — each with capsule content, MetaViewer equivalent, and required battery, in the existing 4-column format. Accept when all 12 required screens have rows.

G2. UI §7 dispatch table: name the idempotency field `request_id`, bind it to the envelope nonce/seq dedup law (core records accepted pairs, refuses duplicates), and add the deterministic derived-`request_id` rule when the client omits it, so retries never fork duplicate runs.

G3. UI §7: add a per-slot dispatch lock row — one in-flight dispatch per target slot; a second dispatch to a busy slot refuses (queues only if that adapter advertises queue semantics) — plus the GUI/headless advisory single-writer rule so one order cannot execute twice.

G4. UI §7 targets: state target eligibility by projected session activity — only ready/waiting-input sessions eligible; unknown/busy/exited sessions shown unavailable or refused per target — mirroring the prior-art waiting-only broadcast rule.

G5. UI §6: add fold/restore focus and veil-arbitration rows from prior art — three-layer focus with retries, activation-veil show conditions, pointerdown/mousedown preventDefault near live surfaces — so writer units implement it without re-reading OpenNewton.

G6. UI §11: replace "Exact current route/command registry spellings beyond the supplied context are AUSENTE" with the actual bound spellings from the on-disk Holdings route registry (closed vocabulary exists in the cited renderer sources); keep minting nothing new.
