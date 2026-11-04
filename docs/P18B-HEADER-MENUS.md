# Header menus and retained role views

## Scope

The application header, role tile presentation, native view occlusion, and the
renderer-owned pool of retained hidden connections are the owned dependency
closure. The frozen authority contracts remain unchanged. This design applies
only to the provided MetaViewer sources and the pinned UI kit surface.

## Header and tile actions

The Use MetaViewer sidebar entry is removed for this release. The host entry
prompt API remains available.
The left working tree groups Humans and Agents by desktop and capsule, with
real state, counts and pending handoffs. Selecting a capsule restores and focuses
its tile. Identities and Settings remain available in the sidebar and rail.
Storyboard is unavailable in release 0.2.6; its code and fixtures are retained.

Each role tile has a menu beside its mode badge in the panel header. The human
menu offers Switch to agent mode, I logged in and Stop capsule. The agent menu
offers Switch to human mode, Watch read-only and Stop capsule, followed by a
separator and Take control (emergency). The existing takeover admission governs
whether that last action is available. Window controls keep their existing
presentation behavior. Native human input never instantiates the agent canvas.

Gate: render the actual action templates and exercise their buttons. Negative
controls remove a secondary header action and invert each role's action group.

## Overlay ownership

An overlay coordinator holds independent owner objects. Its nonempty owner set
sets `body[data-mv-modal="open"]`; releasing an owner cannot clear another
owner's claim. App dialogs and tile menus explicitly own claims. An observer
covers rendered kit dialogs, popup menus, listboxes, open details and popovers.
Permanent sidebar navigation menus are excluded. Native select interactions
hold a separate claim through change, dismissal or focus departure.

Role views observe the body flag, hide their native view and retain their
authenticated connection. Closing the last overlay restores the same view.
Modal occlusion never contributes to the hidden connection quota.

A newly created native view remains hidden while its readiness promise is
pending. The role host reports that deferred visibility in its mount reply;
RoleSurface then rechecks the current geometry and modal ownership before
showing it. A menu opened during connection cannot be covered by that child,
and readiness cannot bypass an overlay that opened during the awaited mount.

Gate: overlap owners, close them in either order, and observe the native view
hide/show calls without another mount. Negative control: a single boolean flag
clears too early when an inner owner remains active.

## Hidden connection quota

The initial limit is four [TARGET] retained hidden live views. Settings exposes
Hidden live sessions; the preference key is `mv.hiddenLiveSessionLimit`. Valid
values are nonnegative integers. Invalid values are refused without replacing
the active limit. Reducing the limit immediately prunes the pool.

The shared pool records the order in which connected views were last shown.
Geometrically hidden views above the limit release their oldest connection;
currently shown views are excluded, including a fresh geometry check immediately
before eviction. Releasing closes the view and bridge, while preserving the
capsule and its presentation record. A restored released tile displays
Disconnected to save resources, click to reconnect and requires that explicit
action before mounting again.

Gate: hide five [TARGET] role views under the default quota, restore the released
view, and require an explicit reconnect. Negative controls reverse eviction
order and admit a shown view as a victim. A synthetic role fixture can exercise
this gate without creating additional native capsules.

## Hidden shell and connection wording

SurfacePanel reads the kit's window presentation state using the existing
presentation instance identity. Hidden applies to the entire tile, including its
capture rail and panel header. The enclosing floating/group shell is hidden
when it contains only hidden tiles. A shown sibling prevents group hiding.
The retained marker survives re-layout and remains in Hidden capsules.

Gate: minimize an agent panel, introduce another presentation row, and confirm
that neither its shell nor its toolbar appears. Negative control: hide only the
body and leave the root shell visible.

The native client initially displays Connecting. The recovery publisher changes
the label to Reconnecting only after a failed health probe, including after a
recovery reload. Ready hides that status overlay.

Gate: exercise initial attachment and a simulated connection loss/recovery.
Negative control: initialize the client document with Reconnecting.

## Runtime isolation

Runtime checks use only the separately configured dev application and its own
non-operator identity. The execution header permits one [TARGET] owned native
capsule at a time; a simultaneous native quota demonstration requires additional
operator authorization. Renderer fixtures exercise the full quota independently.
All started runtime processes and owned containers are recorded by the bounded
supervisor and cleaned up by identity, never by a broad process or container match.

## Bounded regression diagnostics and service lifetime

The old input assertions compared a renderer node with null after the emergency
action moved into the role menu. That node is retained as a disabled entry when
input is unavailable or already interactive. Expanding the failed assertion's
cyclic parent/VNode graph exhausted memory while formatting its diagnostic.
Assertions now compare scalar admission properties, including an enabled
positive control; they do not send renderer graphs to assertion diffs.

The mounted App guard toggles More repeatedly and checks bounded render work,
constant tree size, constant document listener count, and listener disposal after
unmount. RoleSurface also rechecks its lifetime after an awaited native mount,
so an unmounted component cannot start a polling timer. A late-mount mutant
removes that lifetime check and must fail the timer oracle.

The multi-fixture input harness unmounts each application against its own window
and document before restoring globals. This prevents an earlier cleanup hook
from aborting a later component's unmount and leaving its polling timer alive.

Gate: execute the input and role suites with a bounded V8 heap inside the capped
user scope. Negative contrasts are an available action incorrectly disabled,
a listener count that grows between menu transitions, render work continuing
at idle, and polling allocated after component retirement.

Renderer presentation services use the existing fixture-runtime export seam.
The entry registers RoleSurface asynchronously through Vue's existing import,
preserving its closed static dependency surface. Real boots install the counted
overlay and hidden-session providers; boot doubles can omit the named factories.
The services release observers and overlay ownership on application unmount.
