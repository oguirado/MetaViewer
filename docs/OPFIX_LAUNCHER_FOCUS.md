# Launcher focus probe

The outside-click delay was not reproduced in the isolated launcher probe.
Both Add capsule and Launcher delivered the launch after a second owned window
took focus and the launcher regained focus: two routes [MEASURED]. An owned
X11 message window became viewable before any subsequent outside click.

The probe uses the production CatalogLauncher and GroupedCapsuleDialog,
synthetic installed-app inventory, an Electron IPC receiver, and an owned
graphical process. It sends pointer events to the visible buttons and checks
the X11 map state. Its negative control discards the launch and fails the same
viewable-window requirement [MEASURED].

The production capsule backend is outside this probe. Its live core connection
was not configured in this test session, so the full host-program and capsule
paths are unverified. These results do not establish the cause of the reported
operator-session delay, and no production focus behavior was changed.

The executable probe is `ui/test/opfix-launcher.cjs`, served through the normal
UI development server. `MV_OPFIX_DROP_CREATE` enables the negative control;
`MV_OPFIX_HOLD` keeps the final owned window visible for inspection. Run all
parts inside the campaign memory scope and keep frames in RAM.
