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
the scanner still uses the pinned tool’s default rules without overrides.

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
