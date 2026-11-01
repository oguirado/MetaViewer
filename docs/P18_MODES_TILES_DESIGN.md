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
