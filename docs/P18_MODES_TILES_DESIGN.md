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
