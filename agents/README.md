# Python adapters
Future bridges for vision-engine, Muse Spark and wender-agent.
Use envelope, frame_ref, observation, action_proposal, action_verdict and action_receipt.
Translate Holdings lane witnesses and execution facts without bypassing core admission.
No application code is present.


### Wire versions and round-one bounds

The envelope codec supports v0.2 and legacy v0.1. `make_envelope` selects
v0.1 for an explicitly v0.1 body, otherwise v0.2. Each envelope accepts
only bodies of its own version; mixed and unknown versions fail with
`unknown_version`. v0.2 embeds the complete contract schema set in
`metaviewer_agents/_contracts_v02.py`; it needs no repository files at runtime.
The tools API emits and validates v0.2 discriminators throughout.
The legacy observation builder and mvctl proposal command retain their v0.1
interfaces; they do not translate payloads or silently negotiate versions.

[TARGET, unit decision] Both envelope versions reject integers outside the
JSON safe-integer range and unpaired Unicode surrogates as `bad_shape`.
MCP identifiers are capped at 128 encoded JSON bytes [TARGET] and numeric
identifiers must be safe integers. Rejected identifiers and oversized
responses produce a bounded `-32603` response; oversized identifiers become null,
while bounded identifiers are retained when the error fits.
Every final response includes its newline in the transport byte-cap check.

[TARGET, unit decision] The source `contracts/v0.2/mv_tool_result.schema.json`
still embeds v0.1 frame, observation, surface, verdict and receipt constants.
The agents' runtime copy upgrades those constants to v0.2 without changing
shapes. Tests use the independent contract checker with the same explicit
version correction. The contract owner must migrate the source constants
and the nested bodies in its valid fixture; those files are outside this
unit's `agents/**` surface.
