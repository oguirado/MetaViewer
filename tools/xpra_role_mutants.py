#!/usr/bin/env python3
"""Temporary mutants with unconditional byte restoration and command receipts."""
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
OSROOT = pathlib.Path('/home/admin/Documentos/OpenSuperficies-wt-xverb')
NODE = '/home/admin/.nvm/versions/node/v24.14.0/bin/node'
UI = [NODE, '--test', '--test-force-exit', '--test-timeout=2500', 'test/xpra-role-tiles.test.js']
GO = '/usr/local/go/bin/go'
CORE_GUARD = '        if self.human_roles.contains(&p.surface_id) {\n            return Ok(Some(Refusal::Policy));\n        }'
mutants = [
    ('role-mutant-client-readiness', ROOT/'ui/electron/xpraHumanTile.js',
     'await waitForXpraClient(wc, {writable, isActive});',
     '// MUTANT: HTML load is treated as readiness', ROOT/'ui', UI),
    ('role-mutant-client-connect', ROOT/'ui/electron/xpraClient.js',
     '?connect=1&username=worker', '?username=worker', ROOT/'ui', UI),
    ('role-mutant-forward-click', ROOT/'ui/electron/xpraHumanTile.js',
     "wc.on('before-mouse-event', event => event.preventDefault());",
     "wc.on('before-mouse-event', () => {});", ROOT/'ui', UI),
    ('role-mutant-forward-key', ROOT/'ui/electron/xpraHumanTile.js',
     "wc.on('before-input-event', event => event.preventDefault());",
     "wc.on('before-input-event', () => {});", ROOT/'ui', UI),
    ('role-mutant-human-canvas', ROOT/'ui/src/surfaces/RoleSurface.vue',
     'v-if="role === \'agent\'"', 'v-if="role === \'agent\' || role === \'human\'"', ROOT/'ui', UI),
    ('role-mutant-key-redaction', ROOT/'ui/electron/humanTrace.js',
     'key: !sensitive && navKeys.has(event.key) ? event.key : null,', 'key: event.key,', ROOT/'ui', UI),
    ('role-mutant-delayed-trace', ROOT/'ui/electron/humanTrace.js',
     'const count = writeSync(fd, bytes, offset, bytes.length - offset);',
     'const count = bytes.length - offset;', ROOT/'ui', UI),
    ('role-mutant-token-url', ROOT/'ui/electron/xpraHumanTile.js',
     "await wc.loadURL(origin + '/metaviewer-tile.html' + clientQuery);",
     "await wc.loadURL(origin + '/?token=' + Object.values(bridge.requestHeaders)[0]);", ROOT/'ui', UI),
    ('role-mutant-open-websocket', ROOT/'ui/electron/xpraHumanBridge.js',
     'for (const socket of connections) socket.destroy();',
     '// MUTANT: leave upgraded connections alive', ROOT/'ui', UI),
    ('role-mutant-writable-watch', ROOT/'ui/electron/xpraHumanSession.js',
     "host.setReadonly(host.role === 'agent')", 'host.setReadonly(false)', ROOT/'ui', UI),
    ('role-mutant-adapter-policy', ROOT/'daemon-adapter/internal/capsule/manager.go',
     'if m.cfg.Profiles[b.Surface.ProfileID].Role == "human" {', 'if false {',
     ROOT/'daemon-adapter', [GO, 'test', './internal/capsule', '-run', 'TestHumanRoleCreatedWithoutAgentWindow', '-count=1']),
    ('role-mutant-core-policy', ROOT/'core/src/admission/mod.rs', CORE_GUARD, '', ROOT,
     ['/home/admin/.cargo/bin/cargo', 'test', '-p', 'metaviewer-core', '--test', 'xpra_role_tiles']),
    ('role-mutant-tokenless-listener', OSROOT/'src/browserid/surface/human.go',
     'if err = t.xpra(ctx, c, writable); err != nil {',
     'if t.Listen != nil { t.Listen(ctx, "tcp", "127.0.0.1:0") }; if err = t.xpra(ctx, c, writable); err != nil {', OSROOT,
     [GO, 'test', './src/browserid/surface', '-run', 'TestHumanXpraModeAndPersistentExclusion', '-count=1']),
    ('role-mutant-server-readonly', OSROOT/'src/browserid/surface/human.go',
     't.xpra(ctx, c, writable)', 't.xpra(ctx, c, true)', OSROOT,
     [GO, 'test', './src/browserid/surface', '-run', 'TestHumanXpraModeAndPersistentExclusion', '-count=1']),
]
results = []
for label, path, old, new, cwd, argv in mutants:
    original = path.read_bytes()
    if old.encode() not in original:
        raise RuntimeError('mutation anchor absent: ' + label)
    try:
        path.write_bytes(original.replace(old.encode(), new.encode(), 1))
        p = subprocess.run([sys.executable, str(ROOT/'tools/xpra_role_run.py'), label, '--', *argv], cwd=cwd)
        results.append({'mutant': label, 'rc': p.returncode, 'killed': p.returncode != 0})
    finally:
        path.write_bytes(original)
(ROOT/'.xpra-evidence/role-mutants.json').write_text(json.dumps(results, indent=2)+'\n')
print(json.dumps(results))
if not all(row['killed'] for row in results):
    raise SystemExit(1)
