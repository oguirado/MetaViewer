# v0.2 contract fixtures

Proving fixtures for the schemas in `contracts/v0.2/`. The contract
gate pairs each schema with its fixtures by file name; a schema without
both sides fails the run.

## Naming

- `<name>.valid.json` — at least one per schema; must validate.
- `<name>.invalid.<reason>.json` — at least one per schema; must fail.
  The base invalid fixture is `<name>.invalid.schema.json` and flips
  only the `schema` discriminator (for example `hello/v0.2` becomes a
  wrong discriminator); every other field stays valid.
- Any other `*.json` file in this directory fails the gate as a stray
  example. Keep scratch data out of here.

## Style

Fixtures use realistic bounded values: short ids, small integers inside
the schema bounds, shared-memory paths under `/dev/shm/`, digests as
64 lowercase hex characters. The v0.1 `frame_ref` triple
(`contracts/v0.1/frame_ref.schema.json`,
`contracts/examples/frame_ref.valid.json`,
`contracts/examples/frame_ref.invalid.schema.json`) is the style
reference for the valid/invalid pairing.

## Coverage

Beyond the base pair, add fixtures that prove the negative paths:

- unknown property added → refused (object closure);
- required property dropped → refused;
- integer or string one step outside its bound → refused;
- value off its `pattern` → refused;
- `oneOf` matching zero branches, or more than one → refused;
- boolean/integer/string swaps → refused.

Every `enum` value and every `oneOf` dispatch variant needs at least
one passing fixture, so coverage, not only the base pair, guards the
contract.

## Gate

```sh
python3 tools/check_contracts.py
```

The run passes only when every valid fixture validates and every
invalid fixture is rejected. Swapping the labels of a pair must turn
the run red; that mislabelled-example control is the gate's proof that
rejection works (`tests/test_check_contracts.py`).
