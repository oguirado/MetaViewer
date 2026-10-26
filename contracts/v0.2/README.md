# Contracts v0.2

Versioned wire contracts for MetaViewer processes. Every message on the
Unix-socket IPC carries an `envelope/v0.2` with a typed body; the body
variants are the schemas in this directory. Contract-first law L3
(`LAWS.md`): a schema and its examples land before any producer or
consumer code, and a breaking change opens a new version directory while
old versions stay until no pin uses them.

## Layout

- `contracts/v0.2/*.schema.json` — this directory: the v0.2 schema set.
- `contracts/examples/v0.2/` — valid and invalid fixtures, at least one
  of each per schema (L3.3). Naming and style are documented in
  `contracts/examples/v0.2/README.md`.
- `contracts/v0.1/` and the flat `contracts/examples/` fixtures stay
  untouched; the checker keeps validating them (version isolation).

## Schema set

The conductor decision carries the nine non-envelope v0.1 schemas into
v0.2, with sibling references and discriminators updated to v0.2, and
a valid/invalid fixture pair each. The envelope is updated separately.
The ten new body schemas remain integrated. v0.1 is untouched.

Carried from v0.1 (purposes per `docs/ARCHITECTURE.md`):

| Schema | Producer → consumer | Purpose |
|---|---|---|
| `envelope` | any process ↔ core | identity, session, ordered sender sequence, nonce, typed body |
| `surface` | core → UI; adapter → core | authoritative snapshot after validation |
| `surface_request` | core → adapter | closed per-operation parameters |
| `surface_event` | adapter → core | created, lifecycle, captured frame, applied input, error |
| `frame_ref` | capture adapter → core | immutable RGB frame locator and integrity metadata |
| `observation` | agent adapter → core | frame, optional grounded elements, optional state witness |
| `action_proposal` | agent → core → executor | frame-bound action, next-observation predicate, bounded retries |
| `action_verdict` | core → agent | admission or refusal with authoritative sequence |
| `action_receipt` | executor via core → log | execution time, next frame, verification result |
| `session_record` | core → journal | ordered append-only journal event; also an envelope body in v0.2 |

New in v0.2:

| Schema | Producer → consumer | Purpose |
|---|---|---|
| `hello` | every process ↔ core | handshake: contract version, component name, pinned version and commit |
| `capsule_meta` | adapter → core | container, display, framebuffer path, lane socket, ready line from the capsule CLI, never guessed |
| `ui_intent` | UI → core | closed UI ops: fold, unfold, pin, hide, show, move, tab, float, layout save/load |
| `catalog_entry` | core → UI | New Capsule kinds and allowed profiles |
| `terminal_session` | UI broker ↔ core | spawn spec by provider id with server-owned argv, resize, byte-plane `{session, seq, bytes}`, cumulative ACK, resync |
| `record_request` | UI → core → adapter | RAM recording, disk recording (destination required), screenshot |
| `record_event` | adapter → core | recording lifecycle and capture events |
| `settings` | UI ↔ core | theme, providers, record destination, limits; no secrets |
| `mv_tool_call` | mvctl/MCP → core | observe, list, propose, wait-verify for provider CLIs |
| `mv_tool_result` | core → mvctl/MCP | terminal outcomes for tool calls |

## Identity

The checker enforces these for every file in this directory
(`tools/check_contracts.py`):

- `$schema` is exactly `https://json-schema.org/draft/2020-12/schema`.
- `$id` is exactly `https://metaviewer.local/contracts/v0.2/<file>`,
  where `<file>` is the schema file name.
- `title` is present and nonempty.
- Every message value carries a `schema` discriminator const
  `<name>/v0.2` (for example `hello/v0.2`); the envelope const is
  `envelope/v0.2`. Cross-version discriminators are refused.

## Closure and subset

`tools/check_contracts.py` implements a documented subset, not full JSON
Schema. It audits every schema and rejects anything outside the subset:

- every object sets `additionalProperties: false`;
- `required` names declared properties only;
- `$ref` names a sibling `*.schema.json` file, optionally with a
  `#/$defs/...` fragment; no cross-directory references;
- `oneOf` is a nonempty array and must match exactly one branch;
- `integer` excludes booleans and booleans are never numbers;
- validator reference traversal is bounded at 100 [MEASURED, checker constant];
  this internal guard is separate from the wire JSON depth cap below;
- only these keywords are accepted: `$schema`, `$id`, `title`,
  `description`, `$defs`, `$ref`, `type`, `properties`, `required`,
  `additionalProperties`, `enum`, `const`, `oneOf`, `items`,
  `minItems`, `maxItems`, `maxProperties`, `minimum`, `maximum`,
  `minLength`, `maxLength`, `pattern`.

Write every id, sequence and counter as `integer` with explicit
`minimum`/`maximum`; units in field names are normative. All bounds are
part of the contract: unknown properties, unknown versions and
out-of-range values are refused before any effect.

## Envelope body union

`envelope.schema.json` dispatches `body` over all 19 [TARGET, conductor
decision] v0.2 body types: the carried schemas below plus the new schemas.
`session_record` is included by the binding conductor decision; the older
exclusion is superseded. `envelope` itself cannot be nested as a body.

| Group | Body types |
|---|---|
| Carried | surface, frame_ref, surface_request, surface_event, observation, action_proposal, action_verdict, action_receipt, session_record |
| New | hello, capsule_meta, ui_intent, catalog_entry, terminal_session, record_request, record_event, settings, mv_tool_call, mv_tool_result |

## Wire rules

Wire behavior is defined in `docs/ARCHITECTURE.md`: reject unknown
versions and unknown properties; `seq` strictly increases per sender
instance; accepted nonce/sequence pairs are recorded and duplicates are
refused before execution; `ts_ns` is a nonnegative session-clock
timestamp with sequence order authoritative.

## Transport limits — binding conductor decision

All limits below are [TARGET, conductor decision, judge gap #1]. Core
and adapter units must enforce them before effects. This repository's
schema checker is not an IPC transport implementation.

| Resource | Maximum / behavior | Enforcement |
|---|---|---|
| NDJSON line | 1048576 bytes, including the terminating LF | Core and adapters bound the input buffer before parsing |
| JSON nesting | 32 container levels; root object/array is level one | Core and adapters count parsed object/array nesting |
| Any string | 65536 UTF-8 bytes, including object keys | Schema `maxLength` bounds value code points; runtime also bounds decoded UTF-8 bytes and keys |
| Any array | 4096 items | Every typed array schema carries `maxItems`, preserving tighter existing limits |
| Any object | 256 keys | Every typed object schema carries `maxProperties`; closure also rejects unknown keys |
| Handshake | hello within 5 s of connection acceptance | Core and adapters enforce a monotonic deadline |
| Idle connection | 30 s without a complete received message | Core and adapters enforce a monotonic deadline |
| Per-connection send queue | 256 messages | Overflow closes the connection with a typed error |

Schema `maxLength` retains JSON Schema code-point semantics. It cannot
express UTF-8 byte length, line framing, container depth, timers or queue
state. Schema acceptance therefore does not prove wire-limit acceptance.
The core and adapter units must check those remaining conditions.
The exact typed transport error discriminator/code is AUSENTE — no inventar;
units must agree on it before implementing queue-overflow signaling.

The terminal base64 string is ASCII and is capped at 65536 encoded bytes
[TARGET]. Its decoded `byte_count` is capped at 49152 bytes [TARGET,
derived from the encoded cap]. Producers split larger PTY output into
sequenced chunks without truncation. Adapters must verify decoded length
against `byte_count`; the schema subset cannot express that relationship.
Existing tighter field limits remain effective. Carried schemas receive
these bounds only in v0.2.

## Gate

```sh
python3 tools/check_contracts.py
```

Exit code is 0 with `Contracts check: OK` on stdout when every schema
audits clean, every valid fixture passes and every invalid fixture
fails; otherwise nonzero with `ERROR:` lines on stderr. The gate counts
only together with its negative control: a mislabelled example must
fail the run (`tests/test_check_contracts.py`).

## Change rule

Do not edit a schema in place for a breaking change: open
`contracts/v0.3/`. Additive, backward-compatible work still ships the
schema and both fixtures before the code that uses them.
