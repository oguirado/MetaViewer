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

This design is limited to the supplied worktrees and their pinned contracts and UI kit.
