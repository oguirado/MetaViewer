# Shared capsule visual architecture

Status: design sealed within the boundaries below [TARGET]; runtime integration and release qualification BLOCKED. This document specifies behavior, not installed APIs or measured product performance. All proposed names, paths, schemas, events, limits and writer units are [TARGET] unless an evidence citation says otherwise. Versions, schema names, section numbers and identifiers are identities, not measurements.

<a id="reading-map"></a>
Reading map: authority and requirements §1; decisions and dependencies §2; components §3; state/persistence §4; IPC §5; multislot §6; drawer §7; tokens §8; operability §9; rendering §10; products §11; gates §12; writer units §13; risks §14. Evidence Q01–Q23 refers to the corresponding section of `ANSWERS_par3_r1.md` in this directory. Those answers are research claims, not package verification.

<a id="section-1"></a>
## 1. Authority and requirements

Evidence keys expand to these exact files:

| Key | Source |
|---|---|
| ARCH | `docs/ARCHITECTURE.md` |
| WEB | `<ARCH_NORM>` |
| HANDOFF | `docs/research/HANDOFF_OSCU0_UI_RESEARCH.md` |
| UICTX | Supplied `CTX_UI_PACK.md`, with its original absolute source citations |
| ROUTER | `<ROUTER_PAPER>` |
| FOLD / SLOT / ORCH / OFUI | Supplied `hb_mv_on_fold.md`, `hb_mv_on_multislot.md`, `hb_mv_of_orch.md`, `hb_mv_of_ui.md`; prior-art evidence only |

The governing exact quotes are:

> “Electron renders state and submits intents. It never injects input.” — ARCH:9

> “Rust alone mutates simulation.” — WEB:451

> “A UI-submitted surface is a requested snapshot, not a state write.” — ARCH:191

> “Add a schema and positive/negative examples before any producer or consumer.” — ARCH:69

> “JavaScript with JSDoc/checkJs and no authored TypeScript” — WEB:31

The operator's shared Vue ruling in HANDOFF §1 replaces the older Lit prototype selection and the lesson note saying Holdings stays on Lit. It does not replace Rust authority or WEB's no-authored-TypeScript rule. Both products therefore use Vue SFCs with JavaScript/JSDoc, checked separately for renderer, preload, main and Worker contexts [TARGET]. The advisory MetaViewer TypeScript-strict recommendation conflicts with this; it is not adopted. Third-party declarations may be consumed; authored application `.ts` files are excluded [TARGET; WEB:461]. No game simulation or admission logic is ported into Vue.

| Operator requirement, HANDOFF §1 | Concrete design element | Verification / status |
|---|---|---|
| Same architecture and identical visual interface | Shared ShellGrid, DockWorkspace, CapsulePanel, MultiSlot, OrchestratorDrawer and token artifact; product content supplied through adapters | Same shared-artifact hash and common interaction fixtures; product data differs [TARGET] |
| Every UI layer is a resizable, dockable capsule | Common panel registry for content, fleet, inspector, alerts, timeline, help/settings and expanded orchestrator; resize both axes, tabs, dock, float, popout intent | Keyboard equivalents and move/resize tests; popout integration blocked by §14 R2 [TARGET; Q01–Q04] |
| Bottom customer-support-style terminal orchestrator | Discoverable bottom launcher; drop-up session/result drawer; dockable expanded view of the same instance | §7 state machine; collapse never stops sessions [TARGET; Q21] |
| Whole program operable by vision-engine and wender-agent | §9 semantic registry and agent_lane mapping; targets resolve through core/adapters | No Electron injector; retail observation restriction remains binding [TARGET; ARCH:6–9; Q10–Q11] |
| MetaViewer programs/browsers | Surface capsule adapter over core/OpenSuperficies; untrusted content kept separate | Surface lifecycle, frame witness and ownership tests [TARGET; ARCH:14–29] |
| Holdings game layers, without Docker/xpra | §11 in-process presentation of admitted game projections | Dependency-boundary and economic replay tests [TARGET; HANDOFF §1] |
| Fullscreen AI/security desks and Steam game | F11 workspace command, monitor-role presentation, game-safe closed AI console; About/licences and AI disclosure | Packaged desktop and Steam/platform gates; no OS-desktop replacement [TARGET; Q04,Q19,Q20] |
| Router from repository inception | ROUTER_BOOTSTRAP.md; routable companions and source identities before producers ship | Existing kit bootstrap plus owned W0 integration units; no fabricated first-commit PASS [TARGET; ROUTER:1306] |

<a id="section-2"></a>
## 2. Decisions and dependencies

| Decision | Options considered | Choice and boundary | Evidence / tag |
|---|---|---|---|
| Shared presentation | Separate copies; shared package; merged repositories | Versioned renderer-only package, exact artifact consumed by both apps; app owns all privileged integration. Offline checks use provisioned artifacts | Q22,Q23 [TARGET] |
| Component system | PrimeVue 5; OpenVue; PrimeVue v4 fallback | OpenVue exact pin; application import seam; no PrimeVue 5. A fallback is not qualified until an exact v4 profile passes the same tests | Q05,Q06; maintainer decision [TARGET] |
| Docking | Bespoke partition solver; Dockview | Dockview presentation topology only; retain stable capsule identities outside panels | Q01,Q02; UICTX “It is never authority: what a panel shows comes from Rust core snapshots.” [TARGET] |
| Snapshot store | Writable Pinia domain store; private holder; hybrid | Private immutable projection holder; small UI stores; no duplicate domain copy. Pinia is optional tooling, not a required new dependency | Q14 [TARGET] |
| Live objects | Deep reactive payloads; shallow per-frame refs; external registry | External frame/terminal services; Vue receives stable handles and low-rate metadata only | Q13,Q15; UICTX “Do not let frames enter Vue's reactivity.” [TARGET] |
| Restore | Visible progressive panel creation; atomic reveal | Full-size covered workspace, lightweight shells, visible-content readiness barrier, bounded failure display; delayed persistence | Q01,Q02 [TARGET] |
| Popouts | Built-in renderer window.open; independent host window | Requirement retained; host-created hardened-window transfer is a proposed integration seam. Built-in path cannot be presumed compatible with deny-window.open | Q03 versus UICTX security; §14 R2 [TARGET / BLOCKED] |
| Terminal | Raw shell everywhere; closed console; developer shell | Closed structured AI console in players; raw PTY only explicit developer mode or MetaViewer; no generic spawn bridge | Q08,Q09,Q21; HANDOFF criterion 9 [TARGET] |
| Prompt distribution | Keystroke broadcast; structured dispatch | Frozen target set and prompt, core-admitted per-target work, attributed receipts; no PTY fan-out | Q21; ARCH:9 [TARGET] |
| Frame transport | MJPEG; H.264/video; WebRTC; shared-memory bridge | Transport-neutral SurfaceView. H.264/video is a benchmark candidate, not a sealed production selection; authoritative RGB capture remains unchanged | Q12; ARCH:103–117 [TARGET / BLOCKED] |
| Agent observation | CDP; AT-SPI; semantic fixture export | AT-SPI for clean Linux test lane; reviewed app export for fixtures; debugger tooling isolated; retail exporter dormant | Q10,Q11,Q18; WEB:505,513 [TARGET] |
| Theme ownership | Vendor preset as master; shared tokens | Repository-owned tokens generate vendor adapters; Q07 supersedes Q05's minimal OpenVue-master sketch | Q05,Q07 [TARGET] |

### Dependency and licence ledger — G0a

Evidence file PINS = `docs/research/PINS_EVIDENCE.json`, schema `mv.pins.v1`. Its exact rule is "latest stable version published on or before 2026-10-09 (>= 14 days before 2026-10-23)" [CITED: PINS:3]; its source is "npm registry metadata via npm view (no download)" [CITED: PINS:4]. This is supplied registry evidence, not a new registry query or installed-artifact measurement. The age floor is **14 days [CITED]**. Latest-stable completeness cannot be independently proved from a file containing selected versions only.

Required identities remain **Vue 3.5.x stable**, **OpenVue 1.0.0**, **dockview-vue 8.6.1**, **@xterm/xterm 6.0.0**, **node-pty 1.1.0** [CITED: HANDOFF criterion 4]. PINS resolves Vue to **3.5.43** and instead selects **dockview-vue 8.4.1** with matching **dockview-core 8.4.1**. The latter is a real conflict, not an alias: proposed installation baseline is PINS under the age rule [TARGET]; maintainer must reconcile the 8.6.1 requirement before dependency admission. No integrity or publication date for 8.6.1 is supplied. Q01–Q03 APIs must be rechecked against the selected artifact; neither version's behavior is inferred from the other. PrimeVue 5 is not MIT per the commissioning brief and stays excluded; OpenVue is used for its supplied MIT continuation evidence. Exact PrimeVue 5 alternative licence is AUSENTE — no inventar.

Every table cell is [CITED: PINS corresponding package record]; dates are publication evidence, integrity strings are copied byte-exact.

| Package | Exact version | Published | Licence | Registry integrity |
|---|---|---|---|---|
| vue | 3.5.43 | 2026-09-17 | MIT | sha512-o5qZoksdnjIKvW1srZ3ab7pcDNYAerBjRe54D0LBLfRdCYFrSgBHVXokMas35czQc0//lmx4/tuY4ZNQ+Rf2Ng== |
| vite | 8.3.4 | 2026-10-08 | MIT | sha512-IftLE8phJhdNRIGNEV4JCCvfNScoZQVfcXaN8TQropWGJtOHcu+iAB9pHcuGvmEb/kddw0LBe/jS8ztdC6xdiQ== |
| @vitejs/plugin-vue | 6.0.9 | 2026-09-14 | MIT | sha512-rD/MORlhaZMlXWW0rEn4FB4wMinWC0z/D7Ye160S5+Rs1mC8ZDAdcDp4SjKfUhG5t8q1ktcPVw4xuTkPRlzrSA== |
| vue-tsc | 3.3.12 | 2026-10-02 | MIT | sha512-kbpaz18O9jPVkXVHD1BEjpUXM6WhXSu+62L1sGGr6Wbzd8GbvkBQWjoj3KZ/C0aq2MZllce7UdtWzwCIYsBMGA== |
| dockview-vue | 8.4.1 | 2026-10-05 | MIT | sha512-GpgLl1uxzSl9xt6g6+ZHqKJGEVdFHtDmj3z7fxLuhSG2hCXN5UD44F+x3XKhq5aXXVlRL5UZDBOf37IsGMMDDA== |
| dockview-core | 8.4.1 | 2026-10-05 | MIT | sha512-LcvhGwmK/Q1tFDEPkiBpkLIYctimmu8JJHgG5yhIXwyf9IvWQkJa3EG7/a1NKUS2Q8w82uoYZTL+c84/zpQUjg== |
| openvue | 1.0.0 | 2026-09-10 | MIT | sha512-mbc1p+P5TMI2wT9W1Q9eUuK5xG4RJvsxDnfEJ53gBGCoYcr+jwZmsnds673YruEHAko49c958Mn/lzT/G31ZsA== |
| @xterm/xterm | 6.0.0 | 2025-12-22 | MIT | sha512-TQwDdQGtwwDt+2cgKDLn0IRaSxYu1tSUjgKarSDkUM0ZNiSRXFpjxEsvc/Zgc5kq5omJ+V0a8/kIM2WD3sMOYg== |
| @xterm/addon-fit | 0.11.0 | 2025-12-22 | MIT | sha512-jYcgT6xtVYhnhgxh3QgYDnnNMYTcf8ElbxxFzX0IZo+vabQqSPAjC3c1wJrKB5E19VwQei89QCiZZP86DCPF7g== |
| node-pty | 1.1.0 | 2025-12-22 | MIT | sha512-20JqtutY6JPXTUnL0ij1uad7Qe1baT46lyolh2sSENDd4sTzKZ4nmAFkeAARDKwmlLjPx6XKRlwRUxwjOy+lUg== |
| pinia | 4.0.3 | 2026-08-12 | MIT | sha512-XMQqpvjgG7LMqVhhFUzKLT4KEbsYbfZZ0CZU9PgdFm1O2VKBmIkykL8+SfNhOaT7sR0wT6BEgKT0YNDYWgmVRA== |

Electron retains **44.9.2** [CITED: UICTX]; Q16/Q22 discuss **45**, which is not an approved upgrade. Electron integrity/licence evidence is outside PINS and remains AUSENTE. Pinia is listed in PINS but remains optional, not automatically a required runtime dependency [TARGET; Q14].

**CI licence and integrity gate [TARGET; Q23; G-PACKAGE/G-LEGAL]:** packaging owner implements a fail-closed gate against the immutable PINS file. Require every selected direct package's exact version, manifest licence, lockfile integrity and cached distribution SHA-512 to equal its record, including the Dockview pair. Verify SRI over the original cached tarball bytes, not an unpacked directory. An offline clean install from verified artifacts supplies a file-inventory receipt; compare installed files to that inventory, classifying permitted install/build-generated files explicitly. For node-pty bind the native build receipt to this verified source plus exact Electron/OS/architecture ABI. Audit every transitive package and asset's full licence/notice under a separate approved inventory; a direct MIT metadata field never clears the transitive tree. Missing artifact, unknown installed package, unapproved licence, mismatched version/integrity, modified installed file, future/too-recent publication or unresolved Dockview conflict refuses before packaging. Positive: complete provisioned offline tree matches approved records and notices. Negatives: mutate one tarball byte, one installed file, one MIT field, version or publication date; each must refuse independently. No installed tree/tarballs/full licence texts were provided here, so this is a CI contract, not artifact clearance. No downloads were performed.

<a id="section-3"></a>
## 3. Component inventory and ownership

All inventory entries are proposed application components [TARGET; Q01,Q08,Q14,Q21]. They are not exports from any library.

| Component | Owns | Excludes |
|---|---|---|
| ShellGrid | Header, collapsible navigation rails, wall, bottom drawer track; CSS Grid | Core lifecycle, bespoke integer layout engine |
| DockWorkspace | Panel registry, Dockview adapter, presentation moves/tabs/size and restoration barrier | Capsule creation/destruction or authority from add/remove callbacks |
| CapsulePanel | Canonical title/status/actions and permanent body; surface + bound MultiSlot | Credentials, PTY ownership, duplicate per-host card implementations |
| SurfaceView | Display attachment and drawable eligibility | Capture ownership, input injection, ground-truth verification |
| MultiSlot | Foldable AI area, session tabs, attach/replay views, per-session attention | Session creation by mount, shell-based command admission |
| OrchestratorDrawer | Launcher, sessions, target picker, prompt draft/review and dispatch results | Ownership of processes or raw prompt injection |
| FleetPanel | Core-projected capsule/session census, capacity/unknown indicators | Local invention of readiness or capacity |
| InspectorPanel | Selected identity, epochs, source tick/revision, durability and provenance | Editable authoritative permissions/balances |
| AlertBoard | Durable refusal/error references, named alerts, explicit acknowledgement intents | Mark-read on hover/scroll; replacing durable inbox with transient toast |
| TimelinePanel | Read-only journal/correlated dispatch history; replay controls when allowed | Live reinjection during replay |
| MissingPanel | Preserved layout identity and recoverable unavailable-type explanation | Fake content or synthetic backend handles |
| DialogHost / AccessibleOutput | Modal stack, safe textual output, focus restoration | Arbitrary HTML from terminal/model output |

Header/rails/launcher are shell chrome; each substantive UI layer is registered as a capsule-panel type. The expanded orchestrator may dock/tab/pop out using the same identity; the bottom launcher remains its access point. Moving it must not create another composer or another dispatch owner [TARGET; HANDOFF §1; Q03,Q21].

<a id="section-4"></a>
## 4. Non-authoritative state and persistence

| Boundary | Contents | Writer / lifetime |
|---|---|---|
| PublicProjection | Last admitted `{schema,epoch,revision,query,projection}` or unavailable; RAM revision distinct from last durable revision | Admission coordinator only, factory per renderer; views receive read-only access |
| QuerySession | Subscription/abort handles, expected query/epoch, local generation | Coordinator; invalidate before unsubscribe on route/epoch/disposal |
| UiLayout | Panel IDs/types, Dockview payload, rail/drawer mode/size and selected presentation | Pure presentation transitions; persisted through reviewed profile service |
| UiSelection | Stable selected entity/session IDs, sort/filter, route/history | UI; reconcile against incoming projection; never entity copies |
| IntentStatus | Request correlation, pending/refused/accepted/uncertain and verified outcomes | Gateway from core replies; acknowledgements never patch projection |
| Drafts | Composer text, explicit recipient selection, editor validation | UI session; no automatic durable logging of prompt text |
| Connections | Coarse attach/restore/live/lost state, last accepted tuple | Transport coordinator; no byte buffers |
| StreamRegistry | Frame handles, xterm instances, bounded queues, writer callbacks | Non-reactive service; explicit teardown and resource ledger |

Install and await subscription readiness before requesting a snapshot. Decode the complete batch, reject unknown keys/duplicate identities/inexact integers/stale query or epoch, then publish the whole accepted envelope once. Push and initial-response use the same admission function; late initial response cannot roll back a newer push. A delta needs the exact resident base. Preserve last-good with visible stale/error labels; missing money remains unavailable, never zero. UI previews are labelled drafts. Read-only wrappers do not remove mutable aliases: ingress owns/clones accepted data and tests attempted nested mutation [TARGET; Q14,Q15; WEB:451–465].

Layout profile [TARGET; Q01,FOLD]: application schema version, product/profile/workspace scope, shared-kit version, Dockview version, panel-registry version, structural layout and allowlisted per-panel presentation data. No credentials, live process state, budgets, permissions, pending admissions, capture paths, focus/scroll/control lease or authoritative game state. Resource IDs are navigation hints revalidated against core state.

Restore pipeline: cold read → closed decode → sequential pure migrations → panel-type/parameter normalization → replace retired types with MissingPanel preserving IDs and structural references → restore presentation → await visible-panel readiness/fonts/final viewport → reveal settled/error wall → enable save-on-gesture-completion. `toJSON`/`fromJSON` are reported by Q01; exact pinned declarations and nested popout format must be tested before use. No invented `suspendLayout` or `silent` restore API (Q02).

Unknown future schema or corrupt profile is retained untouched and makes persistence read-only until explicit recovery; an in-memory safe layout may be offered without overwriting it. Normal missing profile may use documented defaults. Migrations never relaunch old processes or resend pending prompts. Save atomically through an authenticated profile boundary after migration/read guards; cross-window owner is singular. Popout fallback must not overwrite an intended saved wall placement. No shared-layout localStorage [TARGET; Q01,Q03,FOLD].

<a id="section-5"></a>
## 5. Closed UI operation inventory and envelope mapping

This is a closed design inventory, not a new installed IPC API. A narrow preload method per admitted operation is required; no generic invoke/channel, executable/path/env input, direct adapter socket, or renderer-to-executor path. Every privileged receiver authenticates main-observed sender/frame/origin/profile/slot, decodes closed payload and byte/integer limits, and checks service epoch and ownership before effects [TARGET; Q17; WEB:569].

| Logical UI operation [TARGET] | Existing ARCH contract mapping | Boundary / missing contract |
|---|---|---|
| List capsules | `envelope/v0.1` carrying `surface_request.list`, empty params; authoritative `surface` snapshots | Empty-list completion/correlation explicitly open in ARCH:93–94; cannot infer completion from silence |
| Create capsule | `surface_request create` → validated `surface_event created` → `surface` | Core selects allowlisted profile/kind; no renderer executable/container/display selection |
| Destroy capsule | `surface_request destroy` → unsubscribe/drain → terminal `surface` | Explicit backend effect, distinct from closing a panel |
| Fold / unfold / pin capsule | Desired `surface` snapshot visibility only | Core validates; immutable IDs/display/geometry/profile/lifecycle/control unchanged (ARCH:191–196) |
| Take / release control | `surface_request take_control` / `release_control` | Core drains actions and owns exclusive lease; Electron cannot inject |
| Observe display | `surface` metadata; `frame_ref` via approved display adapter | Renderer display transport, frame lifetime and ACK/lease contract AUSENTE |
| Subscribe / detach display | Existing architecture describes subscriptions and `frame_unsubscribe` | UI-to-core attach framing and exact subscription payloads AUSENTE; capture subscription is not implicitly UI-owned |
| Observe agent results | `observation`, `action_verdict`, verified `action_receipt`, `session_record` projections | UI subscription/cursor/catch-up contract AUSENTE; journal references alone insufficient replay material |
| Request agent work / cancel / resolve prompt uncertainty | Agent emits `action_proposal` after interpreting an admitted prompt; core returns verdict and verified receipt | Prompt/session/dispatch/cancel UI contract AUSENTE. Cannot serialize free-form prompt into an existing closed action payload; versioned schemas required |
| Holdings gameplay command | Existing native `agent_lane/v1` observe/submit behind adapter, T2 envelope | Preserve exact native semantics; ARCH `lane_submit.payload` is proposed translation, not native wire (§11) |
| Read / save layout and preferences | App profile presentation service, separate from authoritative surface changes | No existing ARCH message for this; versioned closed UI contract required; never abuse geometry fields |
| Move / tab / resize / dock back | Local presentation operation; profile save after gesture | Native-window transfer needs reviewed host operation; does not call destroy |
| Fullscreen / approved window lifecycle | Main-owned window policy | Narrow app host contract required; default-deny window.open preserved |
| Attach / resize / read / interrupt / terminate developer terminal | Scoped PTY broker behind core admission and host supervision | PTY/session envelope body and quotas AUSENTE; no raw terminal operation in player facade |

No additional operation is admitted implicitly. The available ARCH envelope is necessary but does not make unsupported bodies legal. For each AUSENTE row: schemas, valid/invalid examples, positive/negative receiver tests and journal semantics precede producer/consumer work. Precise byte caps/timeouts remain ratified product targets, never copied from Q08 examples [TARGET; ARCH:51–71].

<a id="section-6"></a>
## 6. Capsule and multislot lifecycle

Separate backend lifecycle, UI presentation, AI-session activity, attachment and dispatch outcome [TARGET; Q08,Q21]. They must never collapse into a single green/red boolean.

### Capsule identity and lifecycle

Core issues immutable capsule/surface identity with generation/epoch. Panel ID references it but is not backend identity. No list-length IDs, display-number credentials, synthetic successful term IDs, or prefix matching [TARGET; SLOT §§1–2].

| Current state / event | Required transition and effects | Negative contrast |
|---|---|---|
| No capsule / Create requested | UI pending request only; core validates profile, starts adapter and awaits readiness | Mounting a panel never spawns a process |
| Pending / authoritative created | Register exact identity and core lifecycle; attach display/session projections only after readiness | Process existence or a frame alone cannot prove ready |
| Pending / readiness error | Show named error with request correlation; unwind owned resources through core | Never paint running on a swallowed failure |
| Live / core lifecycle update | Paint the exact received state; capability guards update from core | No invented lifecycle enum or local revival |
| Live / Fold or Unfold | Submit desired visibility; on core snapshot change presentation; capture and agent continue | No unsubscribe from authoritative capture; no process termination |
| Live / move, resize, tab, popout | Change presentation only; preserve identity, terminal binding and capture | Dockview remove callback cannot mean destroy |
| Live / Take control | Show pending; core closes admission, drains/cancels, acquires lease then publishes owner | Focus is not permission; no direct UI injection |
| Live / explicit Destroy | Core stops admission, drains, releases leases, unsubscribes, destroys; UI waits terminal snapshot | Hide/close/dock-back are not destruction |
| Any live state / unexpected disappearance | Core publishes `lost`; stop admissions; retain diagnostics/replay | Never manufacture clean destroyed or replay uncertain input |
| Terminal destroyed/lost / reconnect requested | Reconcile current core state; replacement needs new identity | ARCH:226 prohibits revival under old identifier |

ARCH names lifecycle mappings `active`, `standby`, `ceded`, `destroyed`, `lost` at :110. Exact complete enum/schema declarations beyond the supplied architecture are AUSENTE; implementation must read/validate the actual contract before adding states. UI request phases above are presentation statuses, not additions to that enum.

### Multislot UI and attachment

The capsule contains one visual body and a bound AI region with session tabs [TARGET]. The capsule-to-session binding is a core projection; multiple session tabs do not grant simultaneous injection rights. A proposed product default permits one active controller per capsule; passive reviewer sessions remain separate from control leases [TARGET; ARCH:194; Q21].

| Axis | States [TARGET] | Events / rules |
|---|---|---|
| AI-region presentation | expanded, folded | Toggle hides body without destroying terminal or session; focus returns to fold button before hiding |
| Session view selection | selected, unselected | Select changes viewed session only, not recipient set or execution owner |
| Attachment | detached, attaching, restoring, live, disconnected | Attach grants fresh epoch-bound capability; restore consistent snapshot/tail; enable permitted input only after restore; transport loss preserves uncertain work |
| Projected session activity | unknown, ready, busy, waiting-input, waiting-permission, exited, failed | Only authenticated adapter/core events change it; quiet output never implies ready/done |
| View retention | live-view, replay-view, disposed | Exit retains bounded read-only replay; explicit removal disposes view resources, not an independently owned process |

Attach installs handlers first, requests authorized snapshot/cursor, buffers bounded later events, applies the snapshot and contiguous tail, then becomes live. Gap/stale epoch restarts reconciliation; never skip VT bytes and continue. Terminal output goes directly to a per-session non-reactive writer; acknowledge only the contiguous parser-consumed prefix. Renderer reload detaches; broker/capture/session do not die. Broker loss invalidates capabilities and produces lost/unknown, not resurrected sessions [TARGET; Q08,Q15].

Folded live hosts stay mounted using `v-show`/equivalent permanent host, with scheduling disabled. Dockview retention strategy must be qualified against the resolved PINS version (8.4.1) after maintainer reconciliation;  Q02's `renderer:'always'` is a reported candidate, not a verified version promise. Hidden terminals may keep a bounded emulator/headless consumer; visible paint is stopped. If the host library remounts on movement, the core-owned process continues and attach/replay restores presentation [TARGET; Q02,Q08; SLOT,FOLD].

No inherited `onTermReady(send)` callback exposes prompt-injection capability to application UI. Separate structured intent submission from terminal display. Previous prior-art raw SendStdin, display focus, Wails main authority and append-CR broadcasts are explicitly rejected here [TARGET; ARCH:9; Q09,Q21].

### Fold/restore focus and activation veil — G5 [TARGET]

Grounding: SLOT §5 quotes "Keyboard ownership is single per document and three-layered" and "now + 120 ms + 400 ms"; FOLD §2.7 says "rAF plus [CITED] 120 ms". Source: supplied `hb_mv_on_multislot.md` §5, citing `ContenedorSuperficie.svelte:560–578` and `MultiSlotCanonico.svelte:94–105`; supplied `hb_mv_on_fold.md` §2.7, citing `ContenedorSuperficie.svelte:663–676`. These timings are prior-art citations, not measured Electron guarantees.

| Event / guard | Required focus/veil behavior | Negative contrast |
|---|---|---|
| Fold | Move logical/DOM focus to the valid fold invoker before hiding; keep body mounted; cancel pending focus retries | No focus left inside hidden content; no session stop |
| Restore / visible again | After core visibility and current geometry are known, schedule rAF then retry after 120 ms [CITED: FOLD]; retain session and refit terminal | First empty-box frame never supplies fake geometry |
| Explicit Take control after admitted human ownership | Three-layer focus: exact slot census witness, DOM host focus, native surface focus through core/adapter; retry now, after 120 ms and 400 ms [CITED: SLOT] | Electron performs DOM focus only; never calls X11 injector or bypasses core lease |
| Every retry | Revalidate slot identity, generation, visibility, owner and current focus intent; cancel on fold/destroy/ownership change or a newer human focus intent; report failure when bounded attempts exhaust | Late timer cannot steal keys from a sibling or terminal |
| Activation veil | Show only when more than one live surface exists, this surface lacks keyboard ownership, and it is not under AI command [CITED: SLOT §5]; activation is idempotent and clears sibling ownership through authoritative arbitration | No veil over the agent-owned target; no simultaneous keyboard owners |
| Controls beside live surfaces | `pointerdown` and `mousedown` use `preventDefault()` to preserve live-host focus; button click still submits its explicit intent; keyboard semantics remain intact | Browser-specific close-button exception requires a packaged regression proving default prevention eats the click; never apply it globally |

The native focus leg is a privileged effect admitted by Rust, not an OpenNewton API transplanted into Electron. Restoring presentation does not acquire control automatically. Battery: fold/restore preserves PTY and capture identity; verify each focus layer after bounded retries, stale retry cancellation, veil truth table, sibling arbitration, pointer/mouse and keyboard activation, and a close-button regression [TARGET; ARCH:6–9,191–196].

<a id="section-7"></a>
## 7. Orchestrator drawer and prompt dispatch

Presentation states: collapsed, expanded, maximized [TARGET; Q21]. Toggle expands/restores prior height; maximize restores expanded size; collapse preserves in-memory draft/targets/read position, returns focus to launcher and leaves sessions running. The drawer is a labelled non-modal region; only a real confirmation dialog makes the background inert. Resize uses a keyboard separator. Terminal keystrokes never bubble into pane shortcuts.

The drawer shows session tabs, target chips, plain multiline composer, review, per-target receipts and an accessible text result view. Selected/viewed/focused/controlling identities are independent. Empty targets disable Send; empty never means all. “One” selects an explicit capsule/session binding; “Many” is an explicit checked set; “All” expands into the visible scoped set before review. A newly created session cannot silently join an already reviewed dispatch [TARGET; Q21].

| Dispatch state / event | Transition / observable record [TARGET] | Guard / refusal |
|---|---|---|
| Draft / Edit or Select targets | Change UI-only draft and explicit IDs | No network or shell effect |
| Draft / Review | Freeze exact prompt bytes, target IDs, workspace, adapter capabilities and relevant basis | Unknown readiness/ownership is shown unavailable; no default target |
| Reviewing / Basis, prompt or target changed | Invalidate review and return draft with reason | No silently substituted recipient |
| Reviewing / Submit | Send proposed versioned orchestration intent with literal `request_id`; show admitting | Schema/size/epoch/ownership/budget checked by core; no raw PTY bytes |
| Admitting / core refusal | Rejected; preserve draft, show full refusal in named alert | No inferred acceptance from transport success |
| Admitting / core accepted | Persisted dispatch identity plus exact frozen target list; each target has separate run/outcome | Acceptance is not execution completion |
| Accepted target / ready | Adapter receives admitted prompt using reviewed structured protocol | Busy queues only if the adapter advertises supported queue semantics; otherwise refuse that target |
| Target waiting-permission/input | Attention; permission UI references exact request | No auto-answer or prompt overwrite |
| Executing / streamed result | Attribute update to dispatch, target and run; append bounded result projection | Text cannot mint control events or escalate capability |
| Executing / completion event | Adapter work complete; show completion separately from verified outcome | Silence, ANSI title, regex or readiness-to-read is not completion |
| Completed / verified core receipt | Mark verified success or failed verification with evidence reference | Holdings requires state/tick witness; a pixel difference cannot suffice |
| Any in-flight / disconnect or lost reply | Uncertain; reconcile journal by original identity | Never resend under a new request automatically |
| Accepted/running / Cancel | Submit explicit cancel intent; show cancel requested then core terminal outcome | Cancellation is not rollback of committed effects |
| Terminal outcome / Retry selected failure | New explicitly reviewed dispatch linked to old outcome after reconciliation | Successful children are not rerun; uncertain children cannot be blindly retried |

### Dispatch admission invariants — G2, G3, G4 [TARGET]

Grounding exact law: "Record accepted nonce/sequence pairs" and "and refuse duplicates before execution, including after restart." — ARCH:61–62. ORCH §1 reports "strong idempotency on `request_id`"; ORCH §9 requires deterministic missing-id derivation and an advisory slot lock between GUI/headless. These are design constraints, not new installed envelope properties.

| Boundary | Required rule | Negative contrast |
|---|---|---|
| G2 request identity | The future closed dispatch body names `request_id`. Before first submit freeze envelope session, authenticated sender instance, nonce, seq and exact body. If client omits `request_id`, derive `request_id = sha256(UTF-8 canonical JSON(["dispatch-request/v1",session,authenticated_sender_instance,nonce,seq]))`, lowercase full hex. Canonical JSON uses sorted keys, compact separators, no whitespace/newline; all sequence integers use the admitted exact codec. Derived identity is server computed and persisted before effects | Missing nonce/seq/session/sender is refusal, never a random id or a default; no new ID on transport retry |
| G2 transport and effect dedup | Core records accepted envelope nonce/seq pairs durably and refuses duplicates, including after restart. Separately persist `request_id` → frozen body digest, target set and existing run/results atomically with admission. A fresh envelope reconciling the same `request_id` reads the original result without another effect; changed body/targets under the same ID refuses. An exact replay of the old envelope still refuses under the envelope law | Effect lookup never bypasses nonce/seq validation or resends uncertain external input; no exactly-once claim over a crash without reconciliation |
| G3 per-slot dispatch lock | Core atomically acquires a dispatch lock keyed by target slot plus generation, with at most one in-flight dispatch per target slot [TARGET]. A busy slot refuses a second dispatch unless its authenticated adapter advertises queue semantics. Advertised queues have declared bounds/order/cancel rules; queued work rechecks eligibility/ownership at dequeue. Release only on durable terminal outcome or reconciled cancellation; uncertainty retains reservation | A renderer mutex or ready badge cannot authorize parallel dispatch; queue support is never inferred |
| G3 GUI/headless single writer | One core consumer owns the command workspace/output slot under an exclusive advisory lock before scanning orders. GUI and headless connect to that same consumer; headless startup lock failure is fatal. Lock scope, durable order identity and one result writer are shared; crash recovery reconciles journal before consuming again | A second consumer cannot execute the same order; no warning-and-continue or stale lock-file deletion in place of OS lock ownership |
| G4 target eligibility | Only projected `ready` or `waiting-input` sessions are eligible. `busy`, `unknown`, `exited`, `failed`, `waiting-permission`, attaching or disconnected sessions show unavailable and yield a per-target refusal if submitted. Review freezes eligibility basis; core rechecks it under the slot lock at dispatch. Queue exception above accepts only an explicit queue request supported by that adapter; it does not make a busy session ready | Output silence, a mounted terminal or a stale ready chip cannot establish readiness; broadcasts never write into executing sessions |

Positive gate: ready/waiting-input targets dispatch once; omitted id derives identically across retries, restart and GUI/headless paths; advertised queued work dequeues under fresh admission. Negatives: duplicate accepted pair, changed-body ID collision, simultaneous same-slot requests, second GUI/headless consumer, busy/unknown/exited recipient and stale-ready race must independently refuse before any effect [TARGET; ARCH:58–64; ORCH §§1,2,7,9; Q21]. Schema field details and implementations are writer work; this body is not silently added to `envelope/v0.1` itself.

Suggested visible labels Ready/Busy/Done/Error are projections of distinct session, connection, delivery and run axes [TARGET; Q21]. CLI-only adapters without a structured completion witness show outcome unknown unless process exit or a reviewed completion contract supplies it; OpenFresnel has no reliable “AI finished answering” sentinel (ORCH §2). Structured protocol name/version/capabilities remain AUSENTE; ACP in Q21 is a candidate to evaluate, not an adopted API.

Keyboard defaults [TARGET; Q21]: Enter newline; Ctrl/Cmd+Enter review/send; no submission during IME composition; Escape closes innermost picker/review before optional collapse and never cancels a run; drawer toggle remappable; terminal Ctrl+C retained. Announce state changes politely, not every token; new output never steals scroll/focus. Explicit Stop-this-run and Stop-dispatch are distinct.

### Terminal security and byte plane

Player console presents structured agent dialogue/results, targets and permission decisions, with no shell input or generic process-launch capability. Developer/MetaViewer PTY requires explicit authorized mode and core-admitted session profile. Spawn config is server-owned absolute executable/argv/cwd and positive environment allowlist; renderer supplies only profile/workspace references. No text interpolation into shell command strings [TARGET; Q09].

PTY utility broker is a supervised effect service, not a second application authority. Rust owns session admission, budgets and durable order; main owns child supervision/window security; node-pty owns OS handles inside its service. Native ABI matches the exact Electron/OS/architecture. Recorded owned process trees are reaped at shutdown. No shell exists in the renderer [TARGET; Q08,Q09; ARCH:34–40].

Control/input/output are direction-scoped and epoch/attachment/session bound. Separate input and output sequences, cumulative parser ACKs, service-calculated byte credit, per-session watermarks, aggregate caps and fair scheduling. Hidden/detached sessions continue through a bounded authorized consumer; never wait forever for a dead renderer ACK. Snapshot-through-cursor plus ordered tail has a consistent cut; gap forces explicit resync. Unknown PTY write completion is uncertain, not replayable [TARGET; Q08]. Exact limits are AUSENTE until workload ratification.

Untrusted arriving text is display data only: never automatically executes, pastes, grants permissions, opens links or reads/writes clipboard. Stage paste in a separate composer, expose control/newline content and require explicit Send; bracketed paste is compatibility, not authorization. Terminal-generated protocol responses are separately inventoried, never classified as human intent. No arbitrary HTML; titles/OSC/link metadata cannot affect privileged state. Disable unreviewed addons/link/OSC clipboard actions; retain a plain-text inspection view. Test split sequences, forged origins, secret fragments and flood bounds [TARGET; Q09,Q17]. Credentials never enter UI/protocol/logs. Structured journals retain reviewed metadata/content only under an explicit redaction/retention policy; prior-art unconditional raw ANSI disk logs are not adopted (ARCH:270–278; Q09).

<a id="section-8"></a>
## 8. Shared design system

Repository-owned primitive → semantic → component tokens generate static CSS plus OpenVue and Dockview adapters. Shared tokens never reference vendor variables; adapters reference shared roles. Required roles [TARGET; Q07]: canvas/panel/chrome surface, primary/muted/disabled text, border, focus, selection, success/warning/error with icon/text, spacing, radius, type, z-layers, motion and control/tab/separator sizes. No unexplained fallback palette.

Axes [TARGET; UICTX; Q05,Q07]: system/light/dark scheme; normal/high contrast; compact/regular/comfortable density; text scale independent of density; OS forced-colors separately respected. A single committed preference/resolved mode drives root attributes, OpenVue selector and Dockview theme metadata. Initialize from validated bootstrap preferences before first paint with bundled CSP-compatible script; propagate to each window document. OpenVue high contrast is application-owned; do not invent `colorScheme.highContrast` or rely on landing-page “dim” language.

Mapping manifest lists each required vendor token as mapped, approved compatibility default, or irrelevant with reason. Missing/cyclic references, name collisions, incompatible units or unclassified vendor additions fail build. Generate deterministically offline without timestamps; compare clean outputs. Test consumed computed properties, not merely variable existence, in every admitted theme/density/scale. Q05 token-path examples and Q03 popout hooks need pinned-package checks; no rolling-documentation API becomes an untested dependency [TARGET; Q05–Q07].

Shell uses Grid, panel internals Flexbox, absolute positioning only overlays; min-size/overflow constraints keep actions reachable. Folds are immediate; reduced-motion disables optional micro-motion. Keyboard separators and tabs provide the same operations as dragging. Layout qualification uses WEB:497's viewport/localization/scale matrix, including 1280×720 minimum and 1280×800 Deck [CITED; TARGET in source]; actual geometry and fonts are fixture-pinned, never cross-platform pixel equality claims.

<a id="section-9"></a>
## 9. AI-operability contract

Every actionable control and meaningful container has a stable semantic anchor, effective role, computed accessible name, state and current box. The registry is declarative component inventory, not a DOM path/fingerprint. Names localize; IDs do not. Entity identity, presentation instance and control slot form a canonical collision-checked tuple. DOM `id`, framework key, AX handle, semantic anchor and lane `stable_id` are separate. The reviewed producer maps semantic anchor to the lane's generation/epoch-bearing stable identity; UI must not synthesize the wire suffix [TARGET; Q10; UICTX agent_lane schema citation].

| Control family / semantic anchor template [TARGET] | Role / accessible name rule | State / box rule |
|---|---|---|
| `shell/fullscreen`, `shell/navigation/{id}` | button / Full screen; button or tab / current destination | Toggle/selected and availability; fresh materialized box |
| `capsule/{id}/panel`, `/tab` | region / capsule title; tab / title plus status | Namespace by window/presentation to avoid mirror collision |
| `capsule/{id}/{fold,pin,control,close,popout,dock-back}` | button / explicit verb plus capsule title | aria-expanded/pressed/disabled; unavailable action explains reason |
| `workspace/separator/{id}` | separator / Resize named region | Orientation and current/min/max values; keyboard controls |
| `capsule/{id}/slot`, `/session/{sid}/tab` | region / AI sessions for title; tab / session title and disambiguator | Selected/attention/activity; no fabricated box while hidden |
| `session/{sid}/{attach,stop,replay,target}` | button / full operation and session | Permission/readiness from snapshot; terminal input not disguised as button |
| `drawer/toggle`, `/maximize`, `/composer`, `/send` | button / Orchestrator; button / Maximize or Restore; textbox / Prompt; button / Review or Send to named scope | Expanded/controlled region; multiline; disabled empty target or invalid review |
| `drawer/targets/{sid}`, `/all`, `/clear` | checkbox / session identity; button / Select all in workspace; button / Clear targets | Checked set independent of focused terminal |
| `dispatch/{did}/target/{sid}/{result,retry,cancel}` | region / attributed result; button / Retry target; button / Cancel run | Current outcome and uncertainty; retry guarded |
| `fleet/{id}/row`, `inspector/{id}/field` | row / capsule identity; labelled value/status | Unknown omitted/unavailable, never zero; virtual identity survives sorting |
| `alerts/{aid}`, `inbox/{mid}/{read,ack}` | alert / full refusal text; button / Read or Acknowledge message | Durable read/ack flags in names; no focus-driven ack |
| `settings/{key}`, `dialog/{id}/{action}` | native input/combobox/button / computed descriptive name | Active modal scope, inert background, valid invoker restoration |
| `output/{sid}/text`, `about/licences`, `assistant/disclosure` | region / Accessible output; button / Licences; region / AI assistant information | Browsable, no token-by-token announcements |

This matrix is the allowed control-family inventory. Adding any control requires a registry row/instance, semantic fixture and agent journey before admission [TARGET]. Dynamic rows use immutable entity IDs, never index/list length/display/translated text. Focus is a logical entity/cell target; materialize before focusing, transfer before recycle. Off-DOM entities are not actionable nodes. Unknown or ambiguous target refuses; no silent filter clearing. Revalidate after sort, scroll, modal, layout, theme, zoom or scale [TARGET; Q10; WEB:473–491].

Boxes use rounded content-window CSS pixels with content-framebuffer origin; no decorations, screen coordinates, DPI multiplication, clipping or fabricated fallback. Synthetic containers/status have null boxes; only currently materialized visible nodes get real boxes. Remote capsule-native coordinates are separate from scaled wall placement; the core executor uses native window coordinates (ARCH:169–170). Popouts have their own window identity/epoch, never offsets added to main-window boxes [TARGET; Q10; UICTX §5].

Keep the native agent lane closed: exact frame keys `nonce,seq,verb,body`, observe/submit only; unknown keys reject; T2 body exactly `tick,seq,cmd,args`. Existing stable-id syntax and canonical serialization are consumed from reviewed native schema, not replaced by the examples above [CITED: UICTX §5]. Direct Electron semantic export remains BLOCKED pending a reviewed producer contract because bare Electron is absent from the inspected peer enum (WEB:513). Operable markup does not authorize a retail automation endpoint.

Battery digest rule is exact: take the complete canonical STATE and replace every `node.box` with `null`; change/remove no other field; hash according to the native canonical STATE contract. Keep boxes in the frame-binding hash. UICTX quotes: “battery digest = canonical STATE with every `box` set to null; the frame-binding hash keeps the boxes.” and “No other field is removed or changed.” Do not assume this battery digest is interchangeable with ARCH's `state_sha256` witness or session-record hash without a native contract fixture [TARGET]. Same inputs across fresh runs must yield identical geometry-free bytes/digest; moving a box changes frame binding but not battery digest; changing a role/name/value must change battery digest [TARGET; Q10,Q18].

<a id="section-10"></a>
## 10. Live rendering

Capture and presentation have different ownership. Authoritative capture stays raw RGB through the registered adapter/immutable generation, never decoded xpra as authority (ARCH:103–117). Display transport remains measured-choice pending. Frames, buffers, xterm writers, GPU resources and decoder queues stay in external service registries, never reactive stores/template interpolation/deep watchers [TARGET; Q12–Q15].

Drawable eligibility requires selected/open panel, unfolded state, positive size, viewport intersection and allowed window presentation. One coordinated fair scheduler consumes the newest display mailbox under an aggregate budget; no arrival-driven Vue update. Folding disables only the display branch, clears/reclaims presentation-owned pending resources and stops draws/uploads after bounded drain; upstream capture, reasoning and verification continue. Reopen requests newest generation, not hidden backlog. Retain only bounded warm resources; capture leases are not released by DOM hide [TARGET; Q13].

`backgroundThrottling` remains enabled. Capture must not depend on wall rAF. No blanket flag disabling throttling to obtain throughput. OffscreenCanvas/worker pool and H.264/video are candidates only after profiling; workers do not eliminate GPU/compositor cost. Q12's heterogeneous latency numbers and proposed frame counts are not MetaViewer measurements. UICTX's capsule probe figures remain [CITED: prior probe], not a capacity guarantee [TARGET; Q12,Q13].

Instrumentation [TARGET; Q13]: per-surface capture/decode/present counts and age, draw/upload submissions, mailbox replacements, frame/lease generations, input-to-present, authored JS spans, process RSS plus resource ledger, long tasks/LoAF where supported. Freeze actual budgets before runs; unknown limits block qualification. Require bounded memory plateau through resize/fold/reload/reconnect/context loss and shutdown. Timing scopes distinguish submission, parser consumption, presentation and verified domain effect.

<a id="section-11"></a>
## 11. Product mapping and batteries

Evidence ROOT = `<HOLDINGS_REPO>/app/shell/src/renderer/h3-app-root.js`; ROUTES = sibling `h3-app-route.js`. Exact quote: "Closed route vocabulary, in journey order." — ROOT:122. ROOT:125–138 exports `H3_APP_ROUTES`; ROOT:150–163 binds queries; ROUTES:30 names `holdings.owner-projection/v1`, and ROUTES:38–51 admits owner views. Navigation ids are `h3-nav-<route>` (ROOT:2784,2806). The closed route set contains 12 entries [MEASURED: ROOT export]. Newgame and intro are distinct entries grouped as one required journey below; saves is a separate existing capability, never an invented `saves` route. All capsule content, equivalents and batteries below are [TARGET]; route/query/control spellings are [CITED: ROOT/ROUTES].

| Holdings screen/capability | Capsule content | MetaViewer equivalent / distinction | Required battery |
|---|---|---|---|
| newgame / intro | `h3-nav-newgame`, `h3-nav-intro`; founding draft, disclosure and tutorial controller; no domain query subscription | Program onboarding/profile setup capsule | C-ONBOARD, C-FLOW, C-KEY; founding occurs only after admitted review; back never repeats effect |
| home / HQ | `h3-nav-home`; `owner` summary and current/durable revision | Program overview capsule | C-PUBLIC/C-REV, independent founding cost/save/restore oracle |
| people | `h3-nav-people`; `owner/people` stable entity table | Fleet/search panel | C-TABLE/C-IDENTITY/C-FRESH; sort/recycle/focus/unknown totals |
| inbox | `h3-nav-inbox`; `owner/inbox` durable message selection/read/ack | AlertBoard/task results | C-INBOX; arrival preserves focus, explicit read/ack only |
| pacing | `h3-nav-pacing`; `owner/calendar` boundary controls | Timeline/session control | C-PACING/C-CALENDAR; same boundary trail at all speeds, no rAF simulation |
| recovery | `h3-nav-recovery`; local effect-runner transcript, no domain slice | Session recovery/uncertain-result capsule | C-UNCERTAIN/C-RESET; reconcile interrupted commit before retry, never infer rollback |
| production | `h3-nav-production`, `b5-production-view`; `owner/calendar`, `owner/production`, `owner/supply` | Live workflow surface | C-PUBLIC/C-OWN/C-T2; no Docker/xpra; independent production/supply boundary oracle |
| equity | `h3-nav-equity`, `b5-equity-view`; `owner/calendar`, `owner/equity` | Position/ownership inspector | C-EXPLAIN/C-PUBLIC; exact amounts/provenance, hidden facts removed before transport |
| share-price | `h3-nav-share-price`, `b5-share-price-view`; `owner/calendar`, `owner/share_price` | Market/telemetry chart capsule | C-CHART/C-FORMAT/C-EXPLAIN; exact price units, gap/extrema preservation, accessible points |
| products | `h3-nav-products`, `b5-products-view`; `owner/calendar`, `owner/products`, `owner/serving` | Catalog/service workflow capsule | C-TABLE/C-PUBLIC/C-VIEW; product identity and serving projection match Rust oracle |
| loan | `h3-nav-loan`, `b5-loan-view`; `owner`; `b5-loan-native` consent modal | Reviewed operation capsule | C-MODAL/C-OWN; unchanged exact request/basis, back never repeats loan |
| saves (panel, not route) | `h4f-saves`, `h4f-saves-toggle`, `h4f-save-now`, `h4f-restore-<generation>`, `h4f-keep-<generation>`; export/rebase/lineage | Snapshot/session archive capsule | G-CLOUD/C-UNCERTAIN; divergent lineage, rebase, restore/keep-both, consent-main-save refusal; tainted writes sandbox only |
| AI assistant / rival diagnostics (capability) | Closed permitted-observation/T2 console | Multislot and orchestrator | No player shell; provider/state witness/uncertainty tests |
| Settings / DLC / About (capability) | Shared theme/density, licences/disclosure, capability status | Shared chrome/settings | DLC cache never entitlement/economic authority; packaged accessibility |

ROOT:1388–1428 implements saves with `_renderSaves()`; the panel is gated by admitted save/export availability and does not subscribe through `H3_APP_ROUTE_QUERY_IDS`. Export state is not a fabricated `owner/saves` view. ROOT:2856–2860 spells the five `b5-*` view tags. The port preserves existing route/control identity mapping rather than minting replacement route names. Actual view materialization remains required before exporting actionable boxes [TARGET; §9].

Holdings keeps its deterministic core, native agent_lane handshake/nonce/sequence/refusal families, state witness and lockstep tick rules. Route changes are presentation only. Each capsule maps a game-layer query to the existing core route registry; splitting a panel does not create a second simulation. Do not forward ARCH's proposed `lane_submit.payload` directly to the native lane (ARCH:96–98) [TARGET].

The shared visual port updates semantic control inventory/producer mapping and environment-specific screenshots, while preserving core replay goldens, complete canonical boundary outcomes and native lane transport negatives. Battery tests use test-owned main for normal UI input paths, observe → resolve current semantic target → test-owned input → next validated observation; they must not bypass a button by calling its economic handler. This input facility belongs only to test harnesses, never product Electron UI [TARGET; Q18; ARCH:9].

Retail keeps ordinary human accessibility but no harness AX walks/capturePage/sidecar hash/export/T2 endpoint. Optional learning-bed capture remains disabled/BLOCKED without proof and never silently writes pixels to disk. Debugger/DevTools attachment keeps the sticky taint latch; AT-SPI observations are accepted test instrumentation, not timing-neutral. Automated irreversible main-save actions still refuse; tainted sessions use sandbox slots only [CITED: UICTX §2,§5; Q11,Q18].

Steam stays the updater; UI only paints platform capability and core-admitted results. No SDK wrapper is selected by Q19's recommendation. Steam owner, overlay, Cloud and callback-pump implementation stay governed by WEB. Add assistant first-use disclosure and About/privacy/local-versus-remote information as proposed surfaces; Q18/Q20 are mixed harvested answers and cannot substitute for jurisdiction/product review [TARGET; Q19,Q20].

<a id="section-12"></a>
## 12. Test gates and negative controls

Gate names inherited from WEB §9 are contracts, not asserted installed runners. All new predicates below are [TARGET]. This research runs document checks only. Integration remains BLOCKED until registered executables, exact inputs/environment and independent receipts exist; Godot game/runtime tools do not qualify a Vue/Electron design.

| Gate / scope | Positive oracle | Required negative contrast |
|---|---|---|
| G-IPC, G-LAUNCH-CONTEXT | Closed sender/ownership/epoch/schema facade in packaged app | Forged frame/origin/slot; stale service; unknown key/verb; over-bound bytes; generic invoke all refuse before effect |
| G-LIFECYCLE | Core-owned creation/readiness, fold continuity, reload attach, exact destroy/reap | Missing readiness, child crash, duplicate request, recycled display, old identity revive |
| C-OWN,C-PUBLIC,C-DECODE,C-INTEGER | Independent complete public projection and exact codec | Last malformed row rejects whole batch; hidden fact, mutable alias or missing→zero fails |
| C-FLOW,C-REV,C-STREAM,C-JOBS,C-UNCERTAIN | Atomic monotonic query/epoch admission and journal reconciliation | Push-before-initial; wrong-base delta; stale cancelled callback; commit then lost ACK produces no duplicate effect |
| C-TYPE | JS/JSDoc checks in separate process contexts | Renderer Node import, renamed wire field, unsafe index, unhandled union; no authored TS |
| C-TOKEN,C-THEME,C-LAYOUT,C-IDLE | Byte-identical offline CSS/adapters and actual computed modes | Missing focus token, unit collision, contradictory vendor mode, clipped control, drifting idle region |
| C-A11Y,C-KEY,C-IDENTITY,C-MODAL | Independent roles/names/value/focus inventory; packaged OS/AT walkthrough | Duplicate ID, stale box, focus into hidden view, background modal action, off-DOM active descendant |
| C-TABLE,C-INBOX,C-CHART,C-ROUTE | Stable entity/query/ack semantics, independent ordered/reference results | Recycled wrong entity, hover ack, lost extrema, back repeats domain effect |
| G-VISUAL / shared-kit parity | Same-environment admitted baseline at readiness; all loading/empty/error/stale variants | Half-restored wall, missing name/action, hidden required amount or unreviewed changed baseline |
| Drawer / multislot proposed integration gate | Freeze/review/admit/per-target receipts; fold and reload keep sessions | Empty→all, late target inclusion, quiet→done, collapse→kill, output→input, retry uncertain run |
| Frame/budget proposed integration gate | Hidden draw/upload count stops while capture witness advances; fresh reveal; bounded resources | Hidden uploads, stale generation, backlog replay, unbounded queues or missing budget |
| Agent battery / replay | Geometry-free complete STATE equal across fresh runs; correct native witness and tick | Alter role/value unnoticed, absent witness accepted, boxes removed from frame hash, live action on replay |
| C-COST / retail | No automated observation calls and no shell/export capability in player build | Secret/debug endpoint, AX-domain enable, capturePage or raw PTY bridge present |
| G-PACKAGE,G-LEGAL,G-STEAM,G-CLOUD,G-DLC | Exact artifact notices, fuses, ABI and applicable platform evidence | PrimeVue 5/enterprise pulled inadvertently; unsigned/unmatched native module; callback grants money |

Viewport, process memory, JS/input, table/chart and transport numbers from WEB §9.3 remain source proposals until ratified; UI wall budgets are separate from prior capsule probes. Measure the final workload with timing instrumentation isolated from diagnostic tracing. Never retune a frozen target silently [TARGET; WEB:421; Q13].

<a id="section-13"></a>
## 13. Small writer units

Each unit owns at most **3 files [TARGET]**. Paths below are proposed source paths, not existing files; companion/schema work precedes the implementation wave. A conductor assigns disjoint realpaths and dependency gates before writing. Tests are independent behavioral oracles, not mirrors of the implementation [TARGET; Q22; ROUTER:1043].

| Unit | Exclusive file set [TARGET] | Entry / verification gate and negative contrast |
|---|---|---|
| Projection | `src/renderer/state/publicProjection.js`, `publicProjection.test.js`, companion `books/public-projection.md` | Closed schema available; stale query/alias mutation refused |
| Layout migration | `src/renderer/workspace/layoutProfile.js`, `layoutProfile.test.js`, `books/layout-profile.md` | Pinned serialization fixtures; future schema/corrupt overwrite refused |
| Dock host | `src/renderer/workspace/DockWorkspace.vue`, `DockWorkspace.test.js`, `books/dock-workspace.md` | Migration + exact Dockview types; panel move cannot destroy capsule |
| Capsule chrome | `src/renderer/capsules/CapsulePanel.vue`, `CapsulePanel.test.js`, `books/capsule-panel.md` | Snapshot reader and semantic inventory; fold cannot stop capture |
| Multislot | `src/renderer/capsules/MultiSlot.vue`, `MultiSlot.test.js`, `books/multislot.md` | Session projection contract; tab/fold cannot spawn/kill |
| Stream view | `src/renderer/terminal/TerminalView.vue`, `TerminalView.test.js`, `books/terminal-view.md` | Broker/display contract; stale attach/output→input rejected |
| Drawer model | `src/renderer/orchestrator/drawerModel.js`, `drawerModel.test.js`, `books/drawer-model.md` | Prompt schemas first; empty targets/all-change invalidates review |
| Drawer view | `src/renderer/orchestrator/OrchestratorDrawer.vue`, `OrchestratorDrawer.test.js`, `books/orchestrator-drawer.md` | Drawer model; keyboard/IME/focus and no-collapse-kill tests |
| Target picker | `src/renderer/orchestrator/TargetPicker.vue`, `TargetPicker.test.js`, `books/target-picker.md` | Core capability projection; duplicate/unknown recipient refuses |
| Dispatch results | `src/renderer/orchestrator/DispatchResults.vue`, `DispatchResults.test.js`, `books/dispatch-results.md` | Correlation contract; acceptance cannot appear verified |
| Surface scheduling | `src/renderer/surfaces/presentationScheduler.js`, `presentationScheduler.test.js`, `books/presentation-scheduler.md` | Frame leases/budgets; hidden draw or stale generation fails |
| Theme contract | `src/design/tokens.json`, `src/design/tokenMappings.json`, `books/design-tokens.md` | Pinned vendor surfaces; absent/contradictory mapping blocks |
| Semantic registry | `src/renderer/agent/controlRegistry.js`, `controlRegistry.test.js`, `books/control-registry.md` | Reviewed lane producer; collisions/stale epoch fail |

Host-window, PTY, profile, prompt contract and router-gap units remain separate contract-first assignments. Their exact file ownership is assigned only after the missing interfaces are approved; this document does not invent installed schemas or grant another lane write access.

<a id="section-14"></a>
## 14. Risks, open questions and closure

| ID | Unresolved evidence / risk | Conservative behavior | Closure owner and discriminating evidence [TARGET] |
|---|---|---|---|
| R1 | PINS metadata supplied; Dockview version conflict and full artifact/licence/tree proof remain (§2) | PINS proposed baseline only; no release/legal PASS | Maintainer reconciles 8.6.1 versus 8.4.1; dependency owner runs CI integrity/licence/tree gate and audits all notices |
| R2 | Built-in Dockview popout uses window.open; fixed policy denies it; secure host transfer API unproven | Popout control visible as unavailable with reason; retain requirement, do not weaken sandbox/window policy | Host/UI owner implements reviewed main-created transfer contract or obtains explicit policy amendment; test CSP, child realm, dock-back, crash and close |
| R3 | Prompt/session/profile/PTY UI bodies not in ARCH | Unsupported controls disabled; envelope alone grants nothing | Core contract owner adds versioned closed schemas and fixtures, orders/cancel/uncertainty semantics and exact bounds |
| R4 | OpenSuperficies identity/protocol/binaries and frame leases missing | No guessed socket/path/transport | Adapter owner supplies lock/metadata, frame lifetime/ACK and generation tests |
| R5 | Frame display transport/capacity and wall budgets unmeasured | Neutral interface; no production codec/capacity claim | Benchmark matched MJPEG/H.264/WebRTC/shared memory candidates; freeze latency/RSS/quality targets first |
| R6 | Native Wayland cannot promise unattended monitor placement (Q04) | Report compositor/operator-managed assignment; preserve logical roles and old placement; no zero-coordinate overwrite | Linux deployment owner qualifies compositor or explicit X11/XWayland deployment; hotplug/mixed-DPI/popout battery |
| R7 | OpenVue young maintenance and reverse fallback unqualified (Q06) | Exact pin with controlled security upgrades; portable shared subset | UI owner rehearses exact v4 fallback artifact and divergence tests, particularly filtering/virtualization/charts |
| R8 | Direct Electron lane producer absent; retail AI operation conflicts with inert exporter rule | Accessible markup ships; automation seam test-only; no retail endpoint | Agent owner reviews producer schema/peer mapping and separate product authorization; prove taint and C-COST |
| R9 | Router software recipe explicitly unfinished | ROUTER_BOOTSTRAP prerequisite stops; no false routability claim | Router owner adapts the supplied audited kit, closes W0 extractor/resolver/generic gates and fits the UI DEV/TEST bench |
| R10 | Holdings lane translation/witness digest equivalence unconfirmed | No forwarding proposed payload or equating hashes | Native lane owner supplies golden translation, nonce/seq/tick/refusal and digest fixtures |
| R11 | Harvest has citation-label residue, mixed answers and rolling-version APIs | Treat Q18/Q20 and Q22 as mixed; no invented source URLs or installed methods | Research/package owner checks original exact sources/artifact declarations offline when available |
| R12 | Terminal logs, secrets, detached buffering and platform process teardown | No default raw log retention or automatic uncertain resend | Security/runtime owner ratifies retention/redaction/quotas, ABI matrix and descendant-cleanup tests |
| R13 | Steam overlay/Cloud, AI disclosure and exact platform identities not qualified | UI capability/notice surfaces only; no legal/platform success asserted | Product/platform/legal owners provide actual Steam configuration, signed artifact and jurisdiction review |
| R14 | New shared Vue design versus old Lit/TypeScript guidance | Apply operator shared Vue ruling while preserving JS/JSDoc/no-TS law | Conductor updates governing visual decision records before implementation; no simulation architecture change |

This mandate is scoped to the supplied task corpus and explicitly inspected sources; missing runtime evidence remains unclaimed.
