# Opening modes and automatic tile layouts

An identity is persistent browser storage. Human or agent mode belongs to the
capsule opening. `default_mode` supplies the preferred opening mode; a legacy
profile `role` remains a migration input for that default. Without either setting,
the default is agent. Neither default restricts subsequent opening choices.

## Opening and switching

The additive role request contract carries explicit identity and mode. Main stages
a private `opening_mode` request in the adapter state directory before submitting
the existing create request. The adapter validates ownership, permissions, schema,
identity and mode, consumes the request, and stores mode on the resulting binding.
Malformed or occupied requests fail closed. Frozen transport contracts are unchanged.

The adapter's profile reservation remains the identity exclusion boundary. Main
also serializes opening and switching. A duplicate create retains
`PROFILE_ALREADY_BOUND`. The UI's open operation instead reveals an existing tile
in the same mode, or returns the existing surface and requested mode so the UI can
offer “Close and reopen”. Hiding a tile is presentation only. “Stop capsule” is a
separate lifecycle action.

A switch closes the native view and trace, awaits an acknowledged destroy, then
opens the same identity in the other mode. The replacement receives a fresh native
run and surface identity. Existing epoch and VERIFIED-frame admission checks remain
in force. No previous frame is copied into the replacement. An uncertain stop
blocks replacement and retains the adapter reservation; it cannot prove physical
closure. A failed replacement leaves the acknowledged old lifetime destroyed.

Human openings do not take an initial agent capture, subscribe to frame polling,
or start DISPLAY taps. The additive `role_surface` lifecycle read lets the renderer
show human tiles without a fabricated frame reference. The host stop capability
submits only a validated destroy for a known surface and waits for that lifetime
to acknowledge destruction; it does not broaden the create request validator. Its presentation row has
an explicitly absent frame generation. Human mode is resolved before the wall
can build any agent Control intent. The native human view supplies its own pixels
and input. Agent Watch and emergency Control/Release retain their existing gates.

The identities panel offers both opening modes and displays current mode. The
host stores last-login confirmation separately from browser storage in its private
user-data directory. Only “I logged in” on an active human opening writes it.
Identity listing, file presence, opening, switching and agent mode do not infer it.
Older hosts without the role capability retain their existing login action.

Human traces are continuous private files under
`<recording destination>/<profile id>/human-trace-<uuid>.jsonl`. Existing printable
key redaction remains in effect. Profile components cannot traverse directories
or select a symbolic-link destination.

## Keyboard and observability

Main queries the app host display's XKB layout and supplies the HTML client
`keyboard_layout` option. Failure to resolve a layout refuses mounting rather
than silently choosing an unrelated layout. Writable native input and readonly
Watch keep their distinct client and server gates.

Typed `METAVIEWER_XPRA_STAGE` lines identify surface, human/watch role, client
readiness, timeout, transport loss, recovery and closure. Lines contain neither
the bridge capability nor its authenticated origin. A child failure remains a
typed error with an explicit reopen action.

## Tile presentation

The wall offers a single-column preset, side-by-side preset, grid preset, and
focus with strip preset. All visible docked tiles remain represented. The
single-column choice stacks additional tiles rather than implicitly minimizing
them. Side-by-side and grid adapt to the available tile count. Focus allocates
the main column `70%` [TARGET] of the available width and stacks remaining tiles
in the strip.

Preset application uses existing Dockview panel moves and group sizes. It reuses
panel instances and never changes capsule geometry. Hidden tiles are omitted from
rectangle allocation while their original presentation homes remain intact.
Restoring a tile re-enters the active preset. Individually floating tiles retain
their geometry and stay outside automatic allocation. Maximization temporarily
defers preset application; restoring returns to the active preset. Manual mode
stops automatic reflow. The existing minimize, float and maximize implementations
are not replaced. Tab behavior is outside this change.

The kit retains validated layout persistence and its settled/read-only gates.
Packaging now includes the pinned kit decoder imported by the main layout bridge,
checks its transitive imports, and seals the staged kit bytes. The packaged layout
smoke performs a renderer IPC save/load round trip in isolated user data.

## R2

The live refusal was an allocation mismatch in the previous dev fixture: it
configured a private RAM root although the native browser frame sink uses its
declared producer root. Human startup skips capture; switching to agent activates
the existing frame-allocation gate and exposes the mismatch. The fixture now
derives admission from that native declaration, and Capture retains its path
gate with a fixed allocation-specific diagnostic. Main maps lowercase adapter
faults to stable public codes and logs only an allowlist of fixed cause strings,
including wrapped initial-capture failures. Other diagnostics are withheld.

Switch shows its destination while closing and opening, then retires the ended
Dockview pane so repeated switches retain the replacement tile's space. Its replay guard covers
an acknowledged destroy followed by a create error, preserving the adapter code
and leaving the old lifetime destroyed. An uncertain stop still blocks create.
The persistent parent owns completion across an agent tile's unmount. Pane
retirement waits for wall restore to settle and for the replacement to be admitted.
Native browser Stop now requests window close through the window manager and
requires a bounded browser-process release receipt before removal and lease release. This is needed
because force removal discarded the synthetic cookie even when localStorage
survived. Container termination alone also lost the cookie in the live check;
it is not a profile-flush receipt. A missing browser-release receipt retains the lease.

The shipped xpra HTML client uses a DOM keycode table with symbol fallback, which
does not preserve Spanish dead keys and the ISO physical key. Main reads the
app display's XKB physical positions at mount. The authenticated bridge streams
the upstream Client.js and appends a raw-keyboard compatibility shim before the
connection hello. It advertises the client layout and raw XKB keycodes; no glyph
translation is performed. Capsule XKB composes accents, and duplicate browser
IME text packets are suppressed. Readiness requires the raw-keyboard handshake
marker. Unknown physical keys are dropped, and missing XKB metadata refuses
mounting. There is no frame cache or persistent keyboard cache in main.

Live fixtures operate only on the isolated dev display and its own identity.
The file page checks localStorage. Chromium does not persist cookies on file or
data origins, so the synthetic cookie check uses the fresh profile's reserved
example.org origin and returns only whether the controlled marker matches.
Keyboard input uses XTest physical positions from that display's XKB map;
xdotool keysym lookup can select alternate Spanish levels and is not a faithful
physical-key oracle.
## R3

`RoleSurface` clips the native `WebContentsView` bounds to the intersection of the
tile rectangle, every scrolling or clipping ancestor, the wall viewport, and the
window viewport, updating immediately on scroll events and hiding the native view
without closing the session or bridge when that intersection is empty or when
`body[data-mv-modal]` is active. Stopping a capsule removes its panel from the
wall while retaining its identity slot so a subsequent reopen of the same
identity reuses that slot if the layout still has it. Handled role outcomes
(mode-switch confirmation offers, `PROFILE_ALREADY_BOUND` reveals, busy flags,
and successful role opens or switches) do not emit refusal rows; unexpected
failures report their real code. The mode-switch confirmation renders as a modal
dialog setting `body[data-mv-modal]`.

## P18c

The header has global Humans and Agents buttons. The active button owns the
numbered desktop row directly below it. Each view starts with desktop `1`
[TARGET]. Adding a desktop allocates a monotonically increasing number and
selects it; removed numbers are not reused. The base desktop is retained and
only empty additional desktops can be removed. Capsule titles and identity
labels keep their existing meanings; desktop renaming is outside this change.
Use MetaViewer, Identities and More retain their existing handlers.

`DesktopWorkspace` owns a persistent wall instance for every desktop. Each wall
receives a projection filtered by capsule mode and desktop assignment, its own
Dockview storage adapter, and its own automatic preset. View and desktop
selection use `v-show`, preserving mounted role components, authenticated native
sessions and agent watch state. An explicit presentation-active signal hides
native role views even before the next geometry sample. P18b's shared hidden
session pool still bounds retained hidden views; resource eviction continues to
require the existing explicit reconnect action. View navigation never sends
Stop or bridge-close requests. A capsule lifecycle change retains P18's existing
acknowledged close-and-reopen semantics.

Global view and desktop navigation exits auxiliary screens and overlays while
retaining the desktop host. A view requested during asynchronous layout loading
takes precedence after restore. The existing wall readiness witness survives an
empty-to-populated transition because the desktop host remains mounted.

Role openings from the launcher and Identities select the requested global view
before opening. A successful role reply assigns the returned lifetime to the
matching view's active desktop and follows it. Revealing an existing capsule
returns to its existing home. A mode switch assigns the replacement lifetime to
the destination view's active desktop, then retires the acknowledged old panel.
Stopped lifetimes cannot be re-admitted by a late projection delivery.

The existing packaged layout load/save bridge stores a product presentation
envelope, `metaviewer.desktops/v1`. It contains the active view, each view's active
desktop and next number, per-desktop preset and kit layout, and capsule homes.
The main-process gate validates the closed envelope and passes every embedded
layout through the unchanged pinned kit decoder and product scope gate.
Duplicate capsule panels and cross-desktop panel references are rejected.
Metadata and wall saves share a serialized writer so concurrent desktop saves
cannot overwrite another desktop's state. Read failure locks persistence; an
invalid embedded layout cannot become an accepted empty profile. Legacy kit
profiles migrate into filtered initial walls. Startup retains the existing
`5000 ms` [CITED: `WallWorkspace.vue`, `ORPHAN_GRACE_MS`] orphan grace before
pruning departed assignments. Pruning retains surviving panel groups and geometry
and produces a valid empty grid when the last panel departs.

### P18c-R2

The desktop pruner previously serialized an empty grid with a leaf root. The
pinned kit decoder accepts that shape, but Dockview's runtime requires a branch
root and throws before its layout-loaded event. Restore therefore never emits
readiness or settlement, preventing capsule admission. The apparent quarantine
is the kit's initial read-only snapshot, whose reason is absent until restore
finishes; this is independent of desktop scope and repeated group identifiers.

Empty grids now retain a branch root containing the empty group. After the
unchanged envelope and kit validation gates, desktop restoration wraps historical
leaf roots in a branch without changing panel identities, placements, active
groups, or floating geometry. Normalization is pure and idempotent. The shared
kit scope and frozen contracts remain unchanged.

The product's Vite integration applies a narrowly anchored banner compatibility
overlay before compiling the pinned kit component. It preserves the materialized
kit and its content pin, and fails the build if either source anchor drifts.
The banner includes the kit's quarantine code and reason, or the explicit
`LAYOUT_RESTORE_PENDING` / `LAYOUT_READ_ONLY` code when no reason is available.

The real Dockview guard creates the second desktop, saves empty layouts through
the wall adapters, unmounts and remounts the desktop host, assigns a human surface,
and checks settlement, tile mounting and absence of quarantine. It also replays
historical leaf-root layouts and visits every restored desktop. Reintroducing
the original serialization and removing normalization must fail settlement;
the banner guard separately rejects the original empty reason. The isolated
live acceptance repeats desktop creation and a full app restart before opening
the dedicated human identity, requires xpra's human READY witness, switches away
and back, then checks that no started capsule remains. Its dedicated dev entry
suppresses the boot auto-create request so that only the explicit identity
opening can start a capsule; the Docker wrapper also rejects any further capsule
launch for that run.

The renderer captures Ctrl+Tab and Ctrl plus desktop digits before tile input.
Native xpra children intercept the same chords in Electron's before-input-event
boundary, consume their key-down and key-up events, and dispatch a fixed
presentation event to the parent renderer. A captured key-up is consumed even
if Ctrl has already been released. Ordinary remote keyboard input retains its
existing path; no bridge capability is included in the presentation event.

Verification pairs the requested view, hidden-session, desktop allocation, mode
move, persistence and keyboard oracles with mutations that remove the relevant
invariant. Component tests also retain mounted wall identities across repeated
navigation and restore independent active desktops after remount. The packaged
bridge round-trip test rejects an embedded layout with a foreign product scope.
The execution header's single-capsule limit takes precedence over the brief's
simultaneous multi-capsule live scenario; isolated live work uses the unit's
development display and own profile only.

This design is limited to the supplied worktrees and their pinned contracts and UI kit.

## P18d

The identities dialog separates saved browser identities from the bounded number
of simultaneous capsule openings. Each row shows the identity name, display name,
current opening mode, and explicit last-login confirmation, with human opening,
agent opening, and confirmed deletion beside it. A bound or opening identity
cannot be deleted: the dialog says “Stop it first”, and the tool independently
checks the native lease while holding the identity guard. The guard inode remains
in place after deletion so concurrent waiters cannot bypass exclusion.

The add form requires only Name. Display name defaults to Name. Allowed sites
is optional under Advanced, with plain examples and the empty-field explanation.
Before IPC, sites are trimmed, lowercased, deduplicated, and sorted. The preload
and Python boundary independently reject unsorted or repeated sites. The native
admin and store accept an explicit empty array as the any-site metadata value;
null remains invalid. This metadata change does not alter a capsule's configured
egress mode, proxy policy, or network. The dialog and its nested delete confirmation
retain the body modal marker that hides native views.

Dynamic admission derives geometry, native browser kind, shared RAM root, and
text-input policy from a deterministic configured browser template. Main requires
an explicit matching template, rather than deriving one from picker defaults.
The adapter independently requires a valid identity name and an affirmative public
native-admin metadata lookup before native start. Protected identity prefixes are
refused even when an adversarial store reports them present. Renderer requests
cannot supply a template, executable, RAM root, or display.

The finite display pool consists of compatible configured browser display slots.
Static profiles retain their configured displays and opening defaults. Dynamic
openings borrow a free compatible display; a static opening cannot collide with
a borrowed slot. MaxSurfaces still bounds admission. A verified Stop releases a
dynamic allocation. An uncertain native outcome or stop retains its reservation,
so an absent receipt never proves that a display is free.

Verification gates use real source mutations through Node loader substitutions,
Go overlays, and isolated Python module copies. They exercise required names,
display-name defaults, site normalization, local and native-lease deletion guards,
store existence, protected names, distinct displays, display release, and static
profile compatibility. A compile error does not count as killing a mutant.
Every verification and development-app invocation uses the required memory-capped
user scope; Node tests also receive the required per-test timeout.

The development supervisor isolates user data, session data, runtime paths,
identity metadata, and registry state, and proves its own single-instance lock
before renderer interaction. It records owned processes and containers and cleans
identities through the product UI even when an opening gate fails. Its live check
opens only its own identity, switching modes sequentially with a verified Stop
before restart, and never overlaps native capsules.

Identity creation now provisions its native profile before returning success. The
host tool admits the existing identity ID grammar and public store entry, then
holds the native identity guard while checking that the lease is inactive. It
rejects symbolic links, non-directory targets, mount delimiters, and canonical
paths outside the private profiles directory. The only helper bind mount is that
profiles directory. The already-installed identity browser image runs once as
root, without networking or image pulls, under a random `mv-provision-<id>-<rand>`
name. Its script creates the exact identity directory, pins its working directory,
and assigns the native browser owner and private permissions. Host containment
checks run again afterward, and lstat must verify the native owner, group, and
exact private mode. A successful Docker exit without that stat evidence refuses.

The helper deadline and its separate cleanup deadline fit inside the existing
bridge request deadline. A failed or timed-out helper triggers bounded removal
of only its own generated container name and retains PROFILE_NOT_PROVISIONED and
the existing sudo repair hint. A failed create keeps its metadata for explicit
repair or deletion; it does not falsely report a ready identity. The native
browser's ownership check remains unchanged.

Deletion keeps the same native guard and refuses an active or malformed lease
before either metadata or profile removal. It removes the public store metadata
and inactive lease record first, then invokes the helper to remove only the exact
profile directory. The helper refuses removal while metadata remains or a lease
is active, and the host verifies the directory is absent. The guard inode is
retained. A helper failure after store deletion is reported rather than reversing
the required ordering or claiming complete cleanup.

The legacy dialog and persistence tests follow Name, Display name, Allowed sites,
and Add identity while retaining invalid-name, native-refusal, damaged-profile,
missing-profile, and repair checks. Synthetic Docker doubles keep those tests
independent of host Docker. Dedicated tool tests and executable source mutations
cover identity/path admission, actual stat enforcement, timeout cleanup, create
provisioning, delete ordering, and the active-lease refusal.

The isolated live supervisor records short-lived Docker helpers before launch,
including the native singleton cleanup helper. It validates the own profile mount
before admitting a native capsule. The panel check creates identities without
sudo, verifies directory stat, opens one identity at a time, checks the human
view, switches sequentially to agent mode, and checks its read-only watch. Paint
evidence combines connected native windows, role-appropriate readonly state,
and opaque pixels inside the fitted native viewport that differ from the wrapper
background. Cleanup stops the capsule before panel deletion and checks both
profile removal and empty own store/registry state.

The login-confirmation button text and tooltip live in RoleSurface.vue, which
this unit is explicitly forbidden to edit. The intended wording is “Mark as
logged in”, with tooltip “Remembers that this identity has a signed-in session,
shown in Identities.” Its existing operation and per-identity marker remain
unchanged; the conductor owns that wording change.

This section scopes its mandate to the supplied MetaViewer and OpenSuperficies
worktree corpus.


## P18e — watch, active-desktop presets and protected identities

The watch canvas remains in layout with `visibility:hidden` and `inert`, so a
content-sized host retains a mountable viewport. Watch synchronization runs after
the menu and canvas DOM update. Status text is an overlay rather than a sizing
input. Each opened view tracks whether it has connected; “Reconnecting…” is
reserved for a connection that was previously ready. Closing resets that state
and revokes the native view. Native read-only admission remains unchanged.

Preset actions explicitly select the active view and desktop before dispatch.
The desktop host refuses cold or read-only walls and records the selection only
after the wall accepts it. The selected button exposes `aria-pressed`; manual
layout retains current positions and stops automatic reflow. Per-desktop storage
and the existing rules for floating, hidden and maximized tiles are retained.
The old-wall-ref hypothesis was not reproduced in the supplied source baseline;
the new guards exercise actual toolbar dispatch, desktop isolation and remount.

Name input lowercases, converts whitespace to dashes and removes other id
characters. A separate original-spelling buffer supplies the default Display
name, including incremental typing and middle edits. An explicitly edited Display
name takes precedence. The normalized id is shown before submission; the input
also reconciles edits whose normalized model value did not change.

A shared renderer/host policy protects project prefixes and the existing named
container list, including live-launcher identities. Protected rows disable Delete
with “Managed outside MetaViewer”; forced UI actions are refused as well. The
operator service and direct tool runner reject before dispatch. Python deletion
independently returns `IDENTITY_PROTECTED` before reading the store, taking locks
or invoking profile removal. The closed preload and tool-refusal paths preserve
that code. The configured Python live profile is also protected.

Verification gates use the real renderer with separate desktop layouts and a
content-sized watch host, plus native watch readiness and read-only state in the
isolated dev app. Negative controls restore canvas removal, route presets to the
former wall, enable protected Delete, remove host/tool guards, and remove closed
refusal admission. Synthetic tool tests cannot access real identity stores.
Live identity creation and deletion are restricted to the own `p18e-` namespace.
The earlier invalid-name guard now uses a reserved id; uppercase-name acceptance
has its own incremental-typing and submission assertions.

This section scopes its mandate to the supplied MetaViewer and OpenSuperficies
worktree corpus.

## P18f — tile layout controls

The mandate is presentation on the active desktop. Capsule identity, control,
process lifetime, native network policy and the frozen contracts remain owned
by their existing boundaries.

The human-float failure has two independent causes. `observeOverlays` counted
Dockview's modeless `dv-resize-container[role=dialog]` as a modal, continuously
hiding its native view. `collectClipRects` clipped every ancestor and fell back
to the wall even for floating renderers. Dockview actually portals native tile
content under `dv-render-overlay-float`, separately from the resize container.
Modeless float dialogs are now excluded from modal occlusion; real modals and
menus retain it. A floating renderer clips against its content/window and any
internal overflow clips. Docked renderers retain wall and overflow clipping.
Pointer movement, viewport resizing and the existing bounded poll refresh native
bounds. Neither clipping nor moving a panel revokes a mounted human session.
Inactive Dockview tabs retain nonempty rectangles under visibility:hidden; the
paint predicate explicitly excludes that state without closing the session.

| Preset | Exact active-desktop presentation |
| --- | --- |
| Single | Focused panel fills the wall; remaining panels are tabs in that group. |
| Side by side | Equal columns [TARGET]; first panels visible, excess tabs in the right column. A sole panel fills the wall. |
| Grid | Equal grid cells, including empty cells [TARGET]; excess panels tab in the final cell. Empty cells contain no capsule. |
| Focus + strip | Focus receives approximately 70 percent [TARGET]; remaining panels stack equally in the right column. |
| Floating | Every panel has its own cascaded window, bounded by the wall [TARGET]. |

Preset actions use public Dockview move, group and sizing APIs. The UI kit alone
owns restoration and serialization. A floating-only layout keeps an empty grid
home so the kit can validate and persist it. Grid persistence deliberately retains
empty cells. Membership and wall-size changes reapply the active preset; manual
floating or resizing alone does not trigger a preset reset. Repeated application
keeps the same geometry and panel renderers. Presets persist independently per
desktop. Legacy null presets keep their existing manual presentation.

Compact header buttons request wider, narrower, taller, shorter and fit. Steps
are ten percent of the wall dimension [TARGET]; Dockview enforces panel and
neighbor constraints. Floating panels use the same sizing API. Fit equalizes
row/column shares, or restores a floating window's default size. Serialized grid
sizes omit the split-gap share, which is restored before sizing. Floating height
requests exclude the floating titlebar. These conversions prevent inverse
button presses from accumulating geometry drift. The renderer
and native input boundary share the Ctrl+Alt+Arrow grammar; both keydown and
keyup are consumed. Native shortcuts include the originating capsule identity,
so the correct tile resizes even while keyboard focus is inside xpra.

The tile menu lists destinations only from its current Humans/Agents view.
Move preserves navigation; Move and go follows the destination. New desktop
supports both operations. A local handoff token prevents the departing
RoleSurface from revoking the native session. The arriving renderer adopts the
existing host session, hides it while its desktop is inactive and reuses it on
reveal. The surface ID and bridge do not change. Source/destination layout
snapshots are pruned by ownership and persisted. No backend create/destroy
request is part of a desktop move.

Desktop removal compacts displayed/persisted IDs and remaps assignments and the
active desktop. Desktop objects, layouts and renderer keys survive renumbering;
adapter closures follow the desktop object instead of capturing a former ID.
Legacy envelopes are compacted after validation. A later addition uses the next
position. Occupied desktops and the initial desktop remain protected by the
existing removal policy.

Only the adapter's fixed display-pool-exhaustion/occupied-display faults map to
`CAPSULE_SLOT_UNAVAILABLE`. The UI uses the shared capsule ceiling in its
message. Other profile and frame faults retain their original codes.

Verification gates and negative contrasts:

| Change | Gate | Negative contrast |
| --- | --- | --- |
| Native float | Real isolated native view stays visible while dragging/resizing; bridge listener stays identical | Restore wall clipping or classify the float as modal |
| Presets | Exact geometry/tab ownership for each preset and tile count, real Dockview cell bounds, idempotent reapplication | Mutate each preset's cell/ratio/cascade rule |
| Size controls | Positive/negative steps return within two pixels [TARGET], constraints and fit hold | Mutate the step or drop shortcut interception |
| Desktop move | Same host session, unchanged navigation for Move, navigation for Move and go | Drop reassignment, follow logic or session handoff |
| Numbering | Populated surviving layouts/assignments follow compacted positions | Omit the renumber operation |
| Capacity refusal | Exhaustion gets actionable copy and unrelated codes survive | Remove the specific adapter mapping |

All build, test and dev processes use the operator's capped scope. Live work
uses the isolated dev profile on display :97 [TARGET] and only its own test
capsule; the packaged operator app is outside this mandate. Screenshots for
multiple tiles use a controlled Dockview fixture with simulated transport, and
native screenshots/checks use the sole owned live capsule. Verification artifacts
and command receipts are local evidence, not a replacement for the final report.
This section scopes the implementation mandate to the supplied MetaViewer and OpenSuperficies corpus.

## P18g — identity, projection and native-view hardening

Foreign identity protection is independent of product profile reservation.
The Python tool and Electron share the same foreign prefixes and named holders;
foreign create, provision, login, release, stage and open requests fail with
`IDENTITY_PROTECTED` before dispatch. The dialog also guards forced clicks and
legacy login. Product `mv-*` profiles remain eligible for opening and login;
deleting them remains refused. The form uses the shared protection predicate.
A fixture compares the actual prefix and holder lists across languages.

A successful native create owns its new metadata entry. If provisioning fails,
the wrapper reacquires the native per-identity guard, proves no active lease,
and rolls back that entry. It does not remove browser payloads on this failure
path. Deletion keeps metadata and its inactive lease until profile removal has
succeeded under the same guard. A retry can finish after either helper failure
or a crash between profile removal and metadata removal. Direct helper removal
requires the wrapper's active deletion guard context. Foreign fixtures never
use the real identity store. Privileged helpers request a private Docker CID
file and authorize cleanup only by that validated container ID. Failed creation
without a CID never removes a name. Before cleanup, the wrapper syncs a private
`cleanup_pending` JSON receipt; a failed or timed-out cleanup preserves it for
recovery, while proven cleanup removes the receipt.

The role host compensates an invalid created acknowledgement with `stopSurface`
and requires a destroyed acknowledgement. A creation completing after host
disposal is also compensated. An unproven stop retains the authoritative row
and its profile reservation. Mount and open are fenced during stop/switch.
Per-mount Symbol tokens invalidate pending work without accumulating arbitrary
renderer close identifiers; close removes their entries and disposal clears
remaining tokens. Failed session cleanup retains handles for retry and shares
concurrent cleanup. Renderer surface enumeration projects only schema, surface
and profile identifiers, state, control, visibility, display and geometry.

Both orphan pruning and desktop assignment pruning require a live, non-stale
authoritative snapshot envelope. Missing evidence does not count as an empty
projection. The wall resets absence clocks while unavailable. The desktop grace
starts when the loaded snapshot is observed and reads that snapshot's rows,
independently of renderer presentation props. Native polling marks its retained
projection stale when enumeration fails. Preset failures clear the active preset
and emit one `LAYOUT_PRESET_FAILED`; required panel operations are checked before
moving any panel. Returning desktop surfaces clear obsolete reveal-cache entries.
Inactive identity placement history retains at most 256 entries [TARGET], with
active panels protected from eviction. Persistent desktops are capped at sixteen per view [TARGET], including restored
state admission, to bound permanently mounted workspace instances.

Human recording uses a shared application-session byte budget: fifty MiB
[TARGET], configurable at the recorder seam. Reaching it returns a paused result
without throwing, closes no view, and exposes `Recording paused (size limit)` in
the tile chrome. Every append is checked before writing. Startup retention removes
private regular trace files older than fourteen days [TARGET], including profile
subdirectories, without following symlinks or reading event payloads. Printable
keys and sensitive AX context retain their existing redaction rules. Empty buffer
chunks are refused, and failed no-clobber exports remove their partial output.

Floating chrome and native pixels use the same stacking authority. Dockview
renders floating content in a sibling portal one stacking level above its resize
container; that relationship identifies the owning floating window. The highest
floating panel raises its native child by removing and re-adding it last in
`contentView`. Native focus activates the corresponding existing Dockview panel.
Each native viewport subtracts complete floating-window rectangles above it,
including their chrome. A rectangular remainder is painted within its bounds;
an empty, disconnected or nonrectangular remainder hides the view. Occlusion is
excluded from hidden-session resource eviction, so hiding preserves the bridge
and lease even when the hidden-session limit is zero [TARGET, negative control].

Verification uses fixture-only identity stores, delayed projections, failing
helpers and bridges, source mutants and an isolated Electron paint harness on
display `:97`. The paint harness uses actual WebContentsViews with local canvas
fixtures and explicit loopback listeners; it captures the X11 display because
Electron page capture excludes native child views. It never opens an identity or
starts a capsule. Capsule-backed transport remains a separate integration gate.
The operator's packaged application and display `:100` are outside that gate.

The fixture suite enforces profile-first deletion by asserting metadata and its
inactive lease remain present during helper execution. Failed-create rollback is
asserted before explicitly seeding older UI-only metadata fixtures, preserving
the existing provisioning-hint coverage.
## P18h

More → “Terminal” opens an OpenFresnel-style full-wall Terminal deck workspace
(`TerminalDeckView.vue`, backed by `terminalDeckModel.js`) as a third workspace
beside Humans and Agents. Entering the Terminal deck hides `DesktopWorkspace`
and sets `RoleSurface` `presentation-active` to `false` (hide-not-revoke for
mounted human views); selecting Humans or Agents, or toggling Terminal closed,
restores the capsule wall without revoking native sessions. The legacy
`SideTerminalOverlay.vue` remains intact for the `side-terminal-open` fixture.

The operator bar displays positional screen chips (`Screen 1, 2, …`, starting
with `1` screen [TARGET] and bounded at `16` screens [TARGET]) with `+` to add a
screen and `✕` to remove a screen only when it is empty and more than `1` screen
[TARGET] exists; remaining screens renumber by position. On the right,
`🚀 Bootstrap` copies the canonical agent entry prompt from `docs/AGENT_ENTRY.md`
verbatim and confirms with a `2000 ms` [TARGET] `Copied` status toast, and
`＋ New terminal` opens the launcher popover.

The launcher popover offers **Shell** (`command: 'shell', args: []`), configured
and available broker provider profiles from `ui/src/terminal/providers.js`
(**Claude (TUI)** and **Agy**, omitted when unconfigured or unavailable), and
**Custom CLI**. Custom CLI never widens `ptyBroker.js` `assertSpawnProfile`: it
opens an admitted login shell session (`command: 'shell', args: []`), attaches to
the session port, and writes the trimmed command followed by `\n` into the PTY
input stream.

Active-screen terminals render in an equal-tile CSS grid (`1` to `4` columns
[TARGET] reflowing with tile count, up to `16` slots per screen [TARGET]) with
focus rings, status badges, and `✕` close controls. Closing a running (`busy`)
terminal requires confirmation, then writes `SIGINT` (`0x03` [TARGET]) to the
PTY input stream and closes the broker session after a `150 ms` [TARGET] grace
period. A process that exits on its own remains visible with status `exited`
until closed or restarted. Screen and slot layouts (without live process handles)
persist under `metaviewer.terminalDeck/v1`; restored slots render `Restart`
buttons that re-launch the saved profile or Custom CLI in place. Deck shortcuts
capture `Ctrl+Shift+T` (new Shell), `Ctrl+Shift+W` (confirmed close of focused
tile), and `Ctrl+PageUp` / `Ctrl+PageDown` (screen switch) while forwarding
ordinary terminal keystrokes to the PTY.

This section scopes the implementation mandate strictly to the supplied MetaViewer worktree corpus.
