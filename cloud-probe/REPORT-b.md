# Cloud probe report B

Base: `ci/assets-6871e94f9` at `6871e94`; branch `cloud/probe-b`. Product code not edited.
Labels: [MEASURED] = run in this session; [ASSUMED] = read from code or config, not executed.

## Part 1: environment

| Item | Result | Basis |
|---|---|---|
| `uname -m` | x86_64 | [MEASURED] |
| CPU count (`nproc`) | 4 | [MEASURED] |
| RAM | 15 GiB total, about 15 GiB available | [MEASURED] |
| Disk free on `/` | 30 GiB available (allowance, not `Size`) | [MEASURED] |
| `/dev/kvm` | absent | [MEASURED] |
| Docker | client installed; daemon not running (`/var/run/docker.sock` missing) | [MEASURED] |
| `gh` | present at `/usr/local/bin/gh`; `gh auth status` rc=1 (not authenticated) | [MEASURED] |
| github.com | reachable over HTTPS (HTTP 400 from proxy for a bare GET, 0.33 s); `git fetch` worked | [MEASURED] |
| crates.io | API returned 403 to plain curl, but `cargo test --locked` resolved crates through `index.crates.io` (proxy bypass list) | [MEASURED] |
| npm | `registry.npmjs.org` HTTP 200, 0.09 s | [MEASURED] |
| Toolchains | go 1.24.7 (auto-downloaded go 1.26.0 per `go.mod`), cargo 1.97.0, node 22.23.4, npm 10.9.9, pnpm 10.28.0 | [MEASURED] |
| Runs as | uid 0 inside the container | [MEASURED] |

All outbound HTTPS goes through an agent proxy. No token or secret was printed.

## Part 2: what can run here

| Step | rc | Duration | Basis |
|---|---|---|---|
| `cd daemon-adapter && go vet ./... && go test ./internal/capsule/...` | 0 | 63 s (includes the go 1.26.0 toolchain download) | [MEASURED] |
| `cargo test --locked -p metaviewer-core` | 101 | 208 s (cold build) | [MEASURED] |
| UI tests (`ci.yml` js job) | not run | — | blocked, see below |

Rust: 210 passed, 1 failed: `verify::ownership_tests::foreign_uid_is_rejected`
(`core/src/verify/ownership_tests.rs:85`). The test re-runs itself under `unshare --user`
and needs a root-owned private file (default `/etc/ssh/ssh_host_ed25519_key`, or
`MV_VERIFY_FOREIGN_FRAME`). That file does not exist in this container [MEASURED], and
`unshare --user --map-root-user --mount true` succeeds here [MEASURED]. So the failure is
an environment prerequisite, not a product regression [ASSUMED from the test source; child
output was not captured in full].

UI tests are blocked: the js job stops at "Require kit access token" unless the
`KIT_REPO_TOKEN` secret is set, then checks out `oguirado/capsule-ui-kit` with that token
[ASSUMED from `.github/workflows/ci.yml`]. The task said not to try private
repositories, so I did not try to reach the kit. Without it, `tools/sync_kit.mjs`
cannot stage the pinned kit. The job also pins node 24.14.0, but this container has
node 22.23.4.

## Part 3: review of the installed-app launcher

Scope: `ui/electron/rolePreload.cjs:11` (`listApps` → IPC `list-apps`),
`ui/electron/roleHost.js:1039` → `ui/electron/desktopApplications.js` (inventory, icons),
`ui/electron/roleHost.js:88-114` (`resolveHostBinary`), `roleHost.js:800,866,902`
(create-program), and `daemon-adapter/internal/capsule/host_xpra.go:129-141,278`
(`xpraChild` → `xpra --start-child=`).

How Exec becomes a program [ASSUMED from code, parser parts MEASURED]: `desktopEntry`
keeps only the first Exec token, which may be bare or in double quotes. It rejects `%`,
backslashes and `env`/`sh`/`bash`/`zsh`/`fish`, and drops every argument.
`resolveHostBinary` refuses shell metacharacters, control characters, relative paths
and unclean absolute paths, and requires an executable regular file. The adapter
single-quotes each argv element (`'` becomes `'"'"'`) before passing it as xpra's
`--start-child` shell string.

**No command injection, argument injection or path escape found.** Exec arguments
never reach the launch. The quoting in `xpraChild` is correct, and control characters
(including newline) are refused before it. The renderer displays icons only as `<img>`
data URLs (`ui/src/catalog/CatalogLauncher.vue:444`), so SVG script is inert anyway.
No finding is a serious security hole, so nothing is withheld from this report.

Concrete defects (all low severity, none security-critical):

1. **Symlinked `.desktop` files are silently dropped**. Low, functional.
   `ui/electron/desktopApplications.js:30` (`O_NOFOLLOW`), used at `:77`. Failing
   input: `applications/link.desktop -> ../real/r.desktop`. A test with one copy and
   one symlink of the same valid entry listed only the copy [MEASURED].
2. **Exec arguments are dropped, so the wrong program can launch**. Low, functional
   (fails safe). `desktopApplications.js:17-20`. Failing input:
   `Exec=flatpak run org.gimp.GIMP %U` parses to `binary: "flatpak"` [MEASURED].
   The launcher then starts bare `flatpak`. `Exec=/usr/bin/python3 /opt/app/main.py`
   would start a bare interpreter in the capsule [ASSUMED].
3. **Keys with spaces around `=` are ignored**. Low, functional. `desktopApplications.js:12`.
   Failing input: `Name = Spaced`. The whole entry is rejected (`null`) [MEASURED].
   The Desktop Entry spec allows this spacing.
4. **Unthrottled icon probing on every `list-apps`**. Low, resource use.
   `desktopApplications.js:46-52`, with no rate limit at `roleHost.js:1039`. Each
   relative icon name produces up to 2 roots × 26 themes × 4 sizes × 2 extensions +
   3 pixmaps = 419 `realpath` candidates. Across 256 apps that is about 107k syscalls
   per call [ASSUMED, derived from code, not measured]. Also, `readdir(root)` at `:72`
   reads the whole directory before `.slice(0,1024)`. The `iconThemes` cache at `:38`
   is never refreshed.
5. **Absolute icon paths are allowed under broad roots**. Informational.
   `desktopApplications.js:42-43,53-55`. Any `.png`/`.svg`/`.xpm` of 256 KiB or less
   under `/usr/share`, `/usr/lib`, `/opt` or the user icon directory is read. Files there
   are normally world-readable, and the result goes only to the same-user renderer.
   I found no confidentiality impact.

## Run metadata

- Model: Claude Opus 5.5 (configured `claude-opus-5-5`); effort: low (reasoning effort setting as given to this session).
- Tool calls: 20, including the commit and push [MEASURED, counted by hand].
- Token usage: ABSENT — do not invent (not visible to this session).
- Wall time: about 15 minutes [ASSUMED].
- `[skip ci]` effect: see the commit message; the result is given in the session's final message, because checking it needs the push to have happened.
