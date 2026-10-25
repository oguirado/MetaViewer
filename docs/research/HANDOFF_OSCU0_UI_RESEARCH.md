# Handoff: MetaViewer visual layer + context router research (external research brief)

From: the Holdings design owner. To: the research unit. Status: historical brief; the context packs it names are private evidence.

## 1. Why this research exists

- Operator ruling: Holdings (the management game) and MetaViewer (the AI desk) share ONE architecture and an IDENTICAL visual interface:
  - Electron + Vue 3 + OpenVue + Dockview;
  - every UI layer is a resizable, dockable capsule panel;
  - a bottom drop-up terminal drawer, styled like a website customer-support chat, is the orchestrator;
  - everything is operable by an AI (vision-engine + wender-agent).
- The only difference is what a capsule contains:
  - MetaViewer: programs and browsers through OpenSuperficies.
  - Holdings: game layers (HQ, production, equity, inbox, loan and so on), with no Docker or xpra.
- **The system architecture is already fixed.** It is MetaViewer `docs/ARCHITECTURE.md` + `<ARCH_NORM>`: Rust authority core, Electron renders and submits intents, closed IPC, agent lane. Do not re-research it.
- **What is open, and what this research must settle:**
  1. The visual layer: how to build the capsule-panel UI, the multislot (a capsule with its attached, foldable AI slot), and the orchestrator terminal drawer, professionally and in a way AI can operate.
  2. How to create, from MetaViewer's first commit, the context router of `<ROUTER_PAPER>`. The repo layout must let the router reach any component, panel, store, IPC verb or CSS token surgically, so AI writers produce maximum-quality code and debugging stays cheap.
- Holdings starts its UI port onto this design right after it is sealed, and MetaViewer reuses it from Monday, October 26. A wrong choice here is paid twice.

## 2. Context packs generated, and why

All files are read-only data for the research pass. They are written to `<CAMPAIGN_VQA_WS>/<job>-drop/`.

| Job | File | What it contains | Why the research pass needs it |
|---|---|---|---|
| hb_mv_ctx_router | `CTX_ROUTER_FOR_UI.md` | The router paper's repository rules (llms.txt, AGENTS.md, the ladder, coordinates, freeze map and lock, bench, gates) and how a Vue/Electron codebase must be laid out to be routable, with exact quotes | So the router is designed in from day one, not bolted on. Perplexity does not know this paper |
| hb_mv_ctx_ui | `CTX_UI_PACK.md` | The fixed laws: security, process model, authority, determinism, agent lane, CSS tokens and components, gates, plus the operator requirements, with exact quotes | So the research pass does not re-decide settled questions and every UI choice respects them |
| hb_mv_ctx_ui | `RESEARCH_QUERIES.md` | 16–24 self-contained Perplexity questions (Dockview, OpenVue, tokens, xterm/node-pty, accessibility and agent-operable UI, live surfaces, Vue state, Electron security, testing, Steam, AI disclosure) | The input for your deterministic Perplexity driver. Convert it to `[{id, prompt}]` |
| hb_mv_on_fold | `hb_mv_on_fold.md` | OpenNewton (`<OPENNEWTON_REPO>`): folding and unfolding of menus and capsules, layout state, persistence | The operator's proven UX, to port to Vue/Dockview |
| hb_mv_on_multislot | `hb_mv_on_multislot.md` | OpenNewton multislot: one capsule = visual layer + an attached, foldable AI slot; binding, lifecycle, streams, focus | The core of the capsule model in both products |
| hb_mv_of_orch | `hb_mv_of_orch.md` | OpenFresnel (`<OPENFRESNEL_REPO>`) backend: an orchestrator terminal launches AI-CLI terminals and injects prompts into them (PTY, readiness, completion, registry, safety) | The orchestrator drawer must send prompts straight to the AI terminals living in each capsule's multislot |
| hb_mv_of_ui | `hb_mv_of_ui.md` | OpenFresnel frontend: terminal component, tabs, prompt composer and broadcast, per-terminal status, targeting one or many terminals | The UX of the chat-style orchestrator drawer |

The review owner confirms when all 4 prior-art files land.

## 3. What the research pass must produce, and why

Deliverables, written to `docs/`:

1. **`UI_ARCHITECTURE.md`**, the sealed visual-layer architecture. It contains:
   - the decision table: each decision with the options considered, the choice, and evidence (a Perplexity answer id or an exact quote from the context pack), tagged [CITED], [MEASURED] or [TARGET];
   - the component inventory and its boundaries: shell layout, Dockview workspace, capsule panel, multislot AI slot, terminal drawer, fleet, inspector, alert board;
   - the state model, which is non-authoritative and comes from core snapshots: which store holds what, and layout persistence;
   - the IPC verbs the UI needs (closed list), mapped onto the existing envelope contracts;
   - the orchestrator drawer: sessions, prompt composer, targeting one, many or all capsules, readiness and completion, and the rule that every prompt is an intent admitted by the core, never a raw keystroke fan-out;
   - the design system: CSS tokens shared by OpenVue and Dockview, dark and light themes, density modes;
   - the AI-operability contract: stable ids, roles, names and boxes for every control, mapped to agent_lane/v1, and a geometry-free test digest;
   - live surface rendering: frames kept out of Vue reactivity, folded panels stop drawing while capture continues;
   - the mapping to both products: Holdings game-layer capsules and MetaViewer program capsules;
   - test gates and a risk list.
2. **`ROUTER_BOOTSTRAP.md`**: how MetaViewer's repository is created so the context router works from the first commit. It covers the files (llms.txt, AGENTS.md, ladder, indexes), naming and size rules per file type (Vue SFC, store, IPC, CSS token, test), coordinates, freeze map, bench and gates, each step quoted from the router paper.
3. **`RESEARCH_LOG.md`**: every Perplexity question id with a short answer digest, the sources Perplexity cited, and what the research pass adopted or rejected.

Why both products need this: Holdings ports its UI first, so it is the proving ground, and MetaViewer gets the same components and router layout already debugged. The router is what makes AI-written code navigable and keeps its quality high.

## 4. How the review owner measures the research pass (acceptance criteria)

The review owner and a reviewer check these:

1. Every operator requirement in section 1 has a concrete design element. None is silently dropped.
2. No contradiction with ARCHITECTURE.md or the HYPERBOOKS laws (Rust authority, closed IPC, Electron never injects input, CSP without eval, determinism).
3. Every decision cites evidence (a Perplexity answer id or an exact context quote) or is marked [TARGET]. No invented library APIs; anything unknown is AUSENTE.
4. Library versions are named exactly (Vue 3.5.x stable, OpenVue 1.0.0, dockview-vue 8.6.1, @xterm/xterm 6.0.0, node-pty 1.1.0) and their licences checked. PrimeVue 5 is not MIT, which is why OpenVue is used.
5. The multislot and the orchestrator drawer are specified down to lifecycle states and events, precise enough for small writer units (at most 3 files each).
6. The AI-operability contract is testable: the ids, roles and boxes, and the digest rule.
7. ROUTER_BOOTSTRAP.md can be executed step by step on an empty repo, and every step is traceable to the router paper.
8. The Holdings mapping is explicit: which game screens become which capsules, and what changes for the agent lane and the batteries.
9. Security for terminals is explicit:
   - player builds get a closed AI console, never a raw shell;
   - the raw shell exists only in developer mode and in MetaViewer;
   - untrusted text is never executed automatically.
10. Risks and open questions are listed with how to close each.

## 5. What we ask you to measure in your capsule (your leg)

- The sequential (1 window) versus parallel (3 windows) run of the same query list: total wall time, per-query t_submit/t_done, the speed-up factor.
- Answer completeness per query (harvested text length, truncation, failures), and any capsule incidents.
- Optional: the replay through wender-agent + vision-engine as the computer-use test.
- Please send the answers JSON path and the timing table to the review owner. The review owner hands the answers to the research pass only through you: you own the research run.

## 6. Constraints

- Never touch credentials and never run `view --login`. Do not change the capsule lifecycle. Stay on perplexity.ai, with at most 3 concurrent threads (your rules).
- The research pass runs at medium effort, writes only the three docs above (plus its report), makes no code edits in Holdings or MetaViewer, does no downloads, and uses no git.
- All files and AI-to-AI messages are in English. The orchestrator model acts as orchestrator only (per operator ruling).
- Scope: this handoff is limited to the named files and repositories; anything outside them is AUSENTE unless the research pass finds it through the Q&A leg.
