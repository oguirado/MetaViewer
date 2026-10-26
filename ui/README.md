# MetaViewer Electron shell

Use Node 24 or newer. All authored source is JavaScript with JSDoc; `npm run check`
checks the renderer, Vue components, Electron source and Vite configuration.
Select that Node runtime on `PATH` before running npm; the host default may be
older than Vite supports. The kit's OpenVue, theme and icon peers are pinned
in `package.json` and installed from the offline cache.

Stage the exact kit pinned by `kit.lock.json` before checking or building:

```sh
node ../tools/sync_kit.mjs "$CAPSULE_UI_KIT_REPO"
npm ci --offline
npm test
npm run check
npm run build
```

Run the sync command from `ui/`. Set `CAPSULE_UI_KIT_REPO` to the local kit
checkout. The sync tool rejects a different commit or content digest. The ignored
`.kit/` tree is consumed by both Vite aliases and JSDoc type resolution. Do not
change the pin to make a different checkout pass.

Electron's local developer setting is `ELECTRON_OVERRIDE_DIST_PATH`: set it to an
existing local distribution matching the version pinned in `package.json`.
The smoke runner requires this variable before loading Electron's npm wrapper,
so an absent binary cannot trigger its automatic downloader. No host path is
stored in the repository.

```sh
export ELECTRON_OVERRIDE_DIST_PATH="/absolute/path/to/local/electron/dist"
npm run smoke
```

The smoke runner uses `xvfb-run -a`, a temporary user profile and a process-group
deadline. It requires the built HTML and CommonJS preload, validates the runtime
version, loads the bundled app through its privileged protocol and strict CSP,
and exits successfully only after the isolated preload and settled wall are
observed. Its read-only layout fixture returns no saved profile and refuses
writes. It exercises shell integration; production startup still refuses until
the Rust core transport and layout contract are connected.

Text contrast uses the existing exhaustive pair matrix. General UI border
contrast is also checked against every general surface, including hover and
active states. CSS is generated from `src/design/metaviewer.tokens.json`; the
oracle verifies byte-for-byte parity and rejects planted low-contrast values.
