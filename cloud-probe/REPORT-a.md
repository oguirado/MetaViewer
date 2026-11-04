# Cloud probe report A

Base: branch `cloud/probe-a` created from `FETCH_HEAD` of `origin/ci/assets-6871e94f9`
(commit `6871e94`, "core: add x64 browser automation, program text and bug fixes").
Scope: environment, runnable checks, read-only review of the installed-app launcher.
No product code was edited.

## 1. Environment

| Item | Result | Basis |
|---|---|---|
| `uname -m` | `x86_64` | [MEASURED] |
| CPU count (`nproc`) | 4 | [MEASURED] |
| RAM (`free -h`) | 15 GiB total, ~15 GiB available | [MEASURED] |
| Disk free (`df -h /home/user`) | 30 GiB available (252 GiB device, 23% used); the session allowance may be lower than `df` shows | [MEASURED] |
| `/dev/kvm` | absent | [MEASURED] |
| Docker | client installed; daemon unreachable (`/var/run/docker.sock` missing) | [MEASURED] |
| `gh` | present at `/usr/local/bin/gh`; `gh auth status` rc=1 (not authenticated) | [MEASURED] |
| github.com | `git fetch` over HTTPS through the agent proxy works; plain `curl https://github.com` returned HTTP 400 and `https://api.github.com` returned 403 through the proxy | [MEASURED] |
| crates.io | `index.crates.io` 200, `static.crates.io` 200; API returns 403 without a User-Agent and 200 with one; `cargo` downloaded 27 crates successfully | [MEASURED] |
| npm | `registry.npmjs.org` 200 | [MEASURED] |
| Toolchains | go 1.24.7 (auto-fetched go1.26.0 per `go.mod`), cargo 1.97.0, node v22.23.4, npm 10.9.9 | [MEASURED] |
| Running user | root | [MEASURED] |

Assumed rather than measured: that the outbound proxy policy stays the same for the
rest of the session.

## 2. What can run here

| Step | rc | Duration | Basis |
|---|---|---|---|
| `cd daemon-adapter && go vet ./... && go test ./internal/capsule/...` | 0 | 38 s (including go1.26.0 download) | [MEASURED] |
| `cargo test --locked -p metaviewer-core` | 101 | 123 s (cold build) | [MEASURED] |
| UI tests (`ci.yml` job `js`) | not run (blocked) | n/a | see below |

Cargo detail [MEASURED]: lib tests 210 passed, 1 failed:
`verify::ownership_tests::foreign_uid_is_rejected` (`core/src/verify/ownership_tests.rs:97`)
panics with "provide MV_VERIFY_FOREIGN_FRAME: root-owned private regular fixture required".
This is an environment precondition: the test needs an externally supplied root-owned
fixture, and this container runs as root without one. It does not show a product regression.
Integration test targets after the failing lib target were not reached, because cargo
stops at the first failing target without `--no-fail-fast`.

UI tests blocked [MEASURED from `ci.yml`]: the `js` job needs repository secret
`KIT_REPO_TOKEN` to check out the pinned `oguirado/capsule-ui-kit`. It fails closed with
"kit absent" when the secret is missing. Because a token is needed, the kit is
probably private (assumed). The task said not to access private repositories, so I made
no anonymous attempt, and the UI suite was not run.

## 3. Review: installed-app launcher

Files read: `ui/electron/desktopApplications.js` (inventory, `.desktop` parsing, icons),
`ui/electron/roleHost.js` (`resolveHostBinary` at lines 85-115, IPC dispatch for
`list-apps` at line 1039, `createProgram` at line 788), `ui/electron/rolePreload.cjs:11`
(`listApps`).

How an `Exec` value turns into a launched program [read from code]:
1. `desktopEntry` (`desktopApplications.js:17-19`) keeps only the first `Exec` token,
   either a bare token or a double-quoted token with no backslash. It rejects any `%`
   field code and the wrappers `env`, `sh`, `bash`, `zsh`, `fish`. All arguments are dropped.
2. `list()` resolves the token with `resolveHostBinary` (`roleHost.js:91`). That
   rejects shell metacharacters and quotes. It only accepts absolute paths that are
   already normalized, and it rejects relative paths. Bare names are looked up only in
   absolute `PATH` entries and fixed standard directories, and the result must be a
   regular file with an execute bit.
3. A launch (`create-program`) sends `{binary}` back. `createProgram` resolves it again
   (`roleHost.js:800`) and passes only the resolved path to the adapter. No arguments
   and no shell are involved.

Result: I found **no command injection, argument injection, or `.desktop`/icon path escape**.

- Shell metacharacters such as `Exec=sh -c "x; y"` or ``Exec=foo;rm`` are refused
  at step 1 or step 2.
- `Exec=/usr/bin/../../tmp/x` is refused because the path is not normalized.
- Icon paths are canonicalised with `realpath` and checked against the allowed roots.
  They are opened with `O_NOFOLLOW`, capped at 256 KiB, and limited to png/svg/xpm.
  SVGs containing scripts or external references are dropped.
- `.desktop` files are read with `O_NOFOLLOW`, capped at 64 KiB, and at most 1024 are
  read per directory and 256 are kept.

Minor findings (both low severity, neither a security hole):

| # | File:line | Defect | Failing input | Severity |
|---|---|---|---|---|
| 1 | `ui/electron/desktopApplications.js:45-50` (cost multiplied at `:81`) | The number of icon lookups grows without a useful cap. A bare icon name generates 2 icon roots x up to 26 themes x 4 sizes x 2 extensions + 3 pixmaps = up to 419 `realpath` calls. That runs for each of up to 256 entries on **every** `list-apps` IPC call, with no caching of results and no rate limit. | 256 `.desktop` files with `Icon=nonexistent-name`, plus 24+ themes under `/usr/share/icons`: about 107k failing syscalls per `listApps()` call [TARGET estimate from code, not measured] | Low (local responsiveness only; the attacker must already be able to write user files) |
| 2 | `ui/electron/desktopApplications.js:15` | The `Name` filter rejects only C0 controls and DEL. It accepts C1 controls (U+0080-U+009F), bidi overrides (U+202E) and zero-width characters, so a displayed name can be visually spoofed. | `Name=Files‮exe.txt` | Low (display spoofing; the resolved binary path is still returned) |

Not a defect, but a design note: `create-program` accepts any binary that resolves on
the host. It is not limited to the inventory that `list-apps` returns, so the launcher list
is a convenience, not an allow-list. This matches the existing free-form "program"
feature. Arguments are never passed.

Measured versus assumed: the code paths above were read, not executed. No dynamic test
of the launcher was run, because the UI kit is unavailable (section 2). The lookup count in
finding 1 is derived from the code.

## 4. Push and CI

The branch `cloud/probe-a` was pushed with a commit whose message contains `[skip ci]`.
`ci.yml` triggers on `push` to all branches (`branches: ['**']`). GitHub skips
push-triggered workflows when the head commit message contains `[skip ci]`. Whether a
run actually started is recorded in the final session message, not in this file,
because it can only be observed after the push.

## 5. Run metadata

- Model: Opus 5.5 (`claude-opus-5-5`); reasoning effort: low.
- Tool calls: about 16 at the time of writing (including this file and the commit/push).
- Token usage: ABSENT — do not invent (not visible to the agent).
- Wall time for parts 1-3: about 10 minutes [MEASURED, approximate].
- Commit identity: the requested address contained a full-width at sign (U+FF20).
  The ASCII `@` form `247666607+oguirado@users.noreply.github.com` was used so
  that the noreply address is valid.
