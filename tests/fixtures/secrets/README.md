# G-SECRETS fixtures (W0-CI-SECRETS)

Shared runner and first tests for the repository secrets gate: a pinned
scanner proves the full history clean, and four runtime plants prove the
same scanner still detects credentials.

## Files

- `gate.py` — shared runner used by CI (`.github/workflows/secrets.yml`)
  and the local hook (`.githooks/pre-push`). Standard library only.
- `test_gate.py` — `GateUnitTests` (stub-driven controller behaviour) and
  `GateIntegrationTests` (pinned-tool evidence). No test skips.
- `README.md` — this file.

## Commands (cwd repository root)

```text
python3 -I tests/fixtures/secrets/gate.py history --gitleaks <absolute-executable> --repo <absolute-root>
python3 -I tests/fixtures/secrets/gate.py controls --gitleaks <absolute-executable> --repo <absolute-root>
python3 -I tests/fixtures/secrets/gate.py gate --gitleaks <absolute-executable> --repo <absolute-root>
```

`--repo .` also selects the current repository.

`history` scans history only; `controls` runs the four isolated plants
only; `gate` runs both and passes only when both pass. Exit codes: `0`
clean, `1` rejected, `2` malformed invocation. `gate.py --help` prints
usage. Every prerequisite failure, timeout, invalid or missing report,
and undetected control rejects; there is no passing skip.

## Tests

```text
GITLEAKS_BIN=<absolute-pinned-binary> python3 -I -m unittest discover -s tests/fixtures/secrets -p 'test_*.py' -v
```

`GateIntegrationTests` requires absolute `GITLEAKS_BIN`; a missing tool
fails the suite instead of skipping it. The four plants are a token
shape, a deterministic high-entropy mixed-case key, a token appended to the checksum line of
`.github/workflows/secrets.yml`, and a private-key block. Token and key-block values are
random; the entropy key is constructed deterministically at runtime in private scratch directories; no
live credential is committed, and the generator splits token/key markers
so its own source scans clean (proven by the committed-source test).

The entropy plant avoids random hex stopword collisions (`dead`, `feed`) in
the default generic-key rule. Its assignment is assembled only in scratch;
the scanner retains every pinned default rule with the scoped exceptions below.

## Hook

```text
install -m 755 .githooks/pre-push .git/hooks/pre-push
```

The hook invokes the same `gate` command and blocks the push when the
scanner is missing or reports findings.

## Provenance limits

- CI downloads gitleaks `v8.18.4` (`linux_x64`) and verifies the pinned
  SHA-256 before extraction or execution. That digest authenticates the
  CI archive only, never an arbitrary local binary.
- Qualify a local binary independently (version plus an
  operator-recorded hash) before trusting local results as equal to CI.
- No `arm64` digest is pinned; the hosted job stays on `ubuntu-24.04`.
- Findings print only sanitized rule counts (at most 25 rows), never
  matched bytes, paths, or raw reports. Reports are never uploaded as
  CI artifacts.

## Generated digest exception

[TARGET, unit decision] `gate.py` writes a constant config, byte-identical to
root `.gitleaks.toml`, for history and controls. It never reads repository
configuration to choose its policy. Every default rule remains active; history
selection, private reports, and fail-closed checks are unchanged.

Gitleaks v8.18.4 [MEASURED] combines rule allowlist `paths` and `regexes`
with OR; setting `condition = "AND"` does not change this behavior. A single
allowlist containing both would hide real tokens on the allowed paths.
Instead, for each affected default rule, the config preserves its original
expression and keyword prefilter verbatim and uses complementary coverage:

- The original rule excludes exactly `router/index/SHA256SUMS` and
  `catalogue/router/manifest.json`.
- A companion rule uses the same expression and keywords, runs only on
  those exact paths, selects capture group `secretGroup = 1` (the token without
  its delimiter), and allowlists only `regexTarget = "secret"` matching
  `^[0-9a-f]{64}$`. Its id has the suffix `-generated-digest-files`.

This implements path AND secret scoping using the pinned scanner's supported
rule semantics. There is no global exclusion. Other router files, suffix
variants and source paths retain the original detection. A digest-shaped
value is indistinguishable from a credential with exactly those bytes; only
that requested shape is exempt. A nonhex Square token, GitHub token or PEM
key on either generated path still rejects the scan. Paths are repository
relative in history; fixture scans use `--source .` from their source directory.

The affected rules are `square-access-token` and `facebook-page-access-token`
[MEASURED]. Measurement used the default config embedded in the installed
pinned binary: 173 default rules [MEASURED], with hex-only keyword prefilters
`acca`, `eaaa`, and `eaac` [MEASURED]. Scanning 10,768 runtime-generated
lowercase digests per file [MEASURED], including each compatible prefilter
at varied offsets, in raw checksum and JSON fields found only those affected
rules. This is empirical coverage of bare digest fields, not a claim that
hex values assigned to arbitrary service-specific credential names are safe.
The integration suite repeats a bounded random/prefix experiment and tests
both digest acceptance and real-token rejection on each exact path, plus
uppercase/length and nearby-path negative controls. The existing GitHub,
entropy, appended-token and PEM runtime controls remain mandatory.

The runner's constant policy also scans current full repository history in
the integration suite. Deleted-secret and side-ref controls continue to
prove that history remains unrestricted.
The adversarial suite in `test_t7_secrets_adversarial.py` retains the held
cases and assertions, and builds every credential-shaped value at runtime
from a character-code prefix and a fresh random suffix. Neither fragment
contains a scannable credential in source; assembled values and scanner
reports are written only inside automatically cleaned temporary directories,
including the isolated stash repository. The split-token case additionally
requires the real scanner to detect the reassembled credential, and the stash
case requires history rejection without printing the generated credential.
