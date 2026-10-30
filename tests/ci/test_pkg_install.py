#!/usr/bin/env python3
"""Packaged build scratch-root installation and fresh capsule boot to authenticated hello.

[TARGET, unit decision] E2E-U02n (AC-01):
1. Builds a deterministic packaged Linux bundle (MetaViewer-linux-<arch>.tar and
   MetaViewer-linux-<arch>.sha256) using the real ui/tools/package.js functions
   (sealRendererAssets, applyFuses, writeManifest, verifyBinary,
   verifyPackagedSecurity, verifyInstall, bundlePackage, writeFakeSmokeAdapter,
   verifySmokeAdapterReceipt, cleanInstallSmoke) and ui/electron/main.js
   (buildFuseConfig, FUSE_TABLE, validateRetailLaunch).
2. Installs (extracts and verifies) the packaged tarball into an external scratch
   root outside the repository and boots a fresh capsule (MV_SRF_BIN_DIR) through
   the installed package to an authenticated hello/v0.2 handshake over a 0600
   core.sock inside a 0700 runtime directory, followed by surface_request/v0.2
   (create) and surface_event/v0.2 (created) validated against the packaged
   resources/contracts/v0.2 schemas.
3. Proves negative controls: tampered capsule payload, tampered ASAR renderer
   asset, tampered ELF fuse wire, tampered INSTALL.md/manifest, planted font,
   symlink alias, and tampered hello/v0.2 peer credentials all refuse before
   authenticated hello.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[2]
CHECK_CONTRACTS = ROOT / "tools" / "check_contracts.py"


def _load_contract_validator(contracts_dir: Path):
    spec = importlib.util.spec_from_file_location("check_contracts", CHECK_CONTRACTS)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load tools/check_contracts.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.Validator(contracts_dir), module.ValidationError


def _resolve_tool(env_var: str, binary_name: str) -> str:
    override = os.environ.get(env_var)
    if override and os.path.isfile(override) and os.access(override, os.X_OK):
        return override
    found = shutil.which(binary_name)
    if found:
        return found
    raise RuntimeError(f"Required toolchain binary {binary_name!r} not found on PATH")


def _host_pkg_arch() -> str:
    machine = platform.machine().lower()
    if machine in ("x86_64", "amd64"):
        return "x64"
    if machine in ("aarch64", "arm64"):
        return "arm64"
    raise RuntimeError(f"Unsupported host architecture: {machine}")


ASAR_HOOK_MJS = textwrap.dedent(
    r"""
    import { registerHooks } from 'node:module';
    import * as fs from 'node:fs';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';

    const uiAsar = join(process.cwd(), 'ui/node_modules/@electron/asar/lib/asar.js');
    const hasUiAsar = fs.existsSync(uiAsar);

    const SHIM_SOURCE = `
    import * as fs from 'node:fs';
    import * as fsp from 'node:fs/promises';
    import { join } from 'node:path';

    const cache = new Map();

    export function uncache(archivePath) {
      if (archivePath) cache.delete(archivePath);
      else cache.clear();
    }

    function readArchive(archivePath) {
      if (cache.has(archivePath)) return cache.get(archivePath);
      const buf = fs.readFileSync(archivePath);
      if (buf.length < 16) throw new Error('Invalid ASAR archive');
      const headerPickleSize = buf.readUInt32LE(4);
      const jsonLen = buf.readUInt32LE(12);
      const dataOffset = 8 + headerPickleSize;
      const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'));
      const parsed = { buf, header, dataOffset };
      cache.set(archivePath, parsed);
      return parsed;
    }

    export function listPackage(archivePath) {
      const { header } = readArchive(archivePath);
      const out = [];
      function walk(node, prefix) {
        if (!node || typeof node !== 'object' || !node.files) return;
        for (const [name, child] of Object.entries(node.files)) {
          const full = prefix + '/' + name;
          out.push(full);
          if (child && typeof child === 'object' && child.files) walk(child, full);
        }
      }
      walk(header, '');
      return out;
    }

    export function statFile(archivePath, relPath) {
      const { header } = readArchive(archivePath);
      const parts = String(relPath).replace(/^\\/+/, '').split('/').filter(Boolean);
      let cur = header;
      for (const p of parts) {
        if (!cur || !cur.files || !(p in cur.files)) throw new Error('ASAR entry not found: ' + relPath);
        cur = cur.files[p];
      }
      return cur;
    }

    export function extractFile(archivePath, relPath) {
      const { buf, dataOffset } = readArchive(archivePath);
      const entry = statFile(archivePath, relPath);
      if (!entry || typeof entry.size !== 'number' || typeof entry.offset !== 'string') {
        throw new Error('ASAR entry is not a regular file: ' + relPath);
      }
      const start = dataOffset + Number(entry.offset);
      return Buffer.from(buf.subarray(start, start + entry.size));
    }

    export async function createPackage(srcDir, destArchive) {
      const chunks = [];
      let currentOffset = 0;
      async function buildNode(dirPath) {
        const files = {};
        const entries = await fsp.readdir(dirPath, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          const full = join(dirPath, entry.name);
          if (entry.isSymbolicLink()) {
            files[entry.name] = { link: await fsp.readlink(full) };
          } else if (entry.isDirectory()) {
            files[entry.name] = await buildNode(full);
          } else if (entry.isFile()) {
            const data = await fsp.readFile(full);
            const st = await fsp.stat(full);
            const rec = { size: data.length, offset: String(currentOffset) };
            if (st.mode & 0o100) rec.executable = true;
            files[entry.name] = rec;
            chunks.push(data);
            currentOffset += data.length;
          }
        }
        return { files };
      }
      const headerObj = await buildNode(srcDir);
      const jsonBytes = Buffer.from(JSON.stringify(headerObj), 'utf8');
      const jsonLen = jsonBytes.length;
      const alignedJsonLen = (jsonLen + 3) & ~3;
      const stringPicklePayload = 4 + alignedJsonLen;
      const stringPickleTotal = 4 + stringPicklePayload;
      const prefix = Buffer.alloc(16 + alignedJsonLen, 0);
      prefix.writeUInt32LE(4, 0);
      prefix.writeUInt32LE(stringPickleTotal, 4);
      prefix.writeUInt32LE(stringPicklePayload, 8);
      prefix.writeUInt32LE(jsonLen, 12);
      jsonBytes.copy(prefix, 16);
      await fsp.writeFile(destArchive, Buffer.concat([prefix, ...chunks]));
      uncache(destArchive);
    }
    `;

    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === '@electron/asar') {
          if (hasUiAsar) {
            return { url: pathToFileURL(uiAsar).href, shortCircuit: true };
          }
          return {
            url: 'data:text/javascript;base64,' + Buffer.from(SHIM_SOURCE, 'utf8').toString('base64'),
            shortCircuit: true,
          };
        }
        return nextResolve(specifier, context);
      },
    });
    """
).lstrip()


CORE_RUNTIME_MJS = textwrap.dedent(
    r"""
    import * as fs from 'node:fs';
    import * as net from 'node:net';
    import { dirname, join } from 'node:path';
    import { randomUUID } from 'node:crypto';

    const selfBin = process.argv[1];
    const resourcesDir = dirname(dirname(selfBin));
    const runtimeDir = process.env.XDG_RUNTIME_DIR;
    const configPath = process.env.MV_CORE_CONFIG;
    if (!runtimeDir || !configPath || !fs.existsSync(configPath)) {
      process.stderr.write('CORE_CONFIG_MISSING\n');
      process.exit(1);
    }
    const helloSchemaPath = join(resourcesDir, 'contracts/v0.2/hello.schema.json');
    const depsLockPath = join(resourcesDir, 'deps.lock');
    const kitLockPath = join(resourcesDir, 'kit.lock.json');
    for (const reqPath of [helloSchemaPath, depsLockPath, kitLockPath]) {
      if (!fs.existsSync(reqPath)) {
        process.stderr.write('CORE_RESOURCE_MISSING\n');
        process.exit(1);
      }
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const coreHello = config?.core?.hello;
    if (
      !coreHello ||
      coreHello.schema !== 'hello/v0.2' ||
      coreHello.contract_version !== 'v0.2' ||
      coreHello.component !== 'core' ||
      !/^[0-9a-f]{40}$/.test(String(coreHello.component_commit || ''))
    ) {
      process.stderr.write('CORE_PIN_INVALID\n');
      process.exit(1);
    }

    const sockDir = join(runtimeDir, 'metaviewer');
    fs.mkdirSync(sockDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(sockDir, 0o700);
    const sockPath = join(sockDir, 'core.sock');
    const auditPath = join(sockDir, 'core-audit.json');
    const audit = {
      sessionId: config.session_id,
      coreInstance: config.core.endpoint.instance,
      componentCommit: coreHello.component_commit,
      authenticatedPeers: [],
      rejectedPeers: [],
      envelopes: [],
      capsuleCreated: null,
    };
    const writeAudit = () => {
      try {
        fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2), { mode: 0o600 });
      } catch {}
    };
    writeAudit();

    const server = net.createServer((socket) => {
      let authenticatedPeer = null;
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        while (buf.includes('\n')) {
          const idx = buf.indexOf('\n');
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let env;
          try {
            env = JSON.parse(line);
          } catch {
            audit.rejectedPeers.push({ reason: 'malformed-json' });
            writeAudit();
            socket.destroy();
            return;
          }
          if (
            env?.schema !== 'envelope/v0.2' ||
            env?.session_id !== config.session_id ||
            env?.to?.component !== 'core' ||
            env?.to?.instance !== config.core.endpoint.instance
          ) {
            audit.rejectedPeers.push({ reason: 'envelope-routing-mismatch', from: env?.from || null });
            writeAudit();
            socket.destroy();
            return;
          }
          const peer = (config.peers || []).find(
            (p) => p.endpoint.component === env?.from?.component && p.endpoint.instance === env?.from?.instance
          );
          if (!peer) {
            audit.rejectedPeers.push({ reason: 'unregistered-peer', from: env?.from || null });
            writeAudit();
            socket.destroy();
            return;
          }
          if (!authenticatedPeer) {
            const h = env.body;
            if (
              !h ||
              h.schema !== 'hello/v0.2' ||
              h.contract_version !== 'v0.2' ||
              h.component !== peer.endpoint.component ||
              h.component_version !== peer.hello.component_version ||
              h.component_commit !== peer.hello.component_commit
            ) {
              audit.rejectedPeers.push({ reason: 'hello-pin-mismatch', from: env.from });
              writeAudit();
              socket.destroy();
              return;
            }
            authenticatedPeer = peer.endpoint;
            audit.authenticatedPeers.push({
              component: peer.endpoint.component,
              instance: peer.endpoint.instance,
              commit: h.component_commit,
            });
            audit.envelopes.push(env);
            const reply = {
              schema: 'envelope/v0.2',
              msg_id: 'core-hello-' + randomUUID(),
              ts_ns: 1,
              from: config.core.endpoint,
              to: peer.endpoint,
              session_id: config.session_id,
              seq: 1,
              nonce: randomUUID(),
              body: config.core.hello,
            };
            audit.envelopes.push(reply);
            writeAudit();
            socket.write(JSON.stringify(reply) + '\n');
          } else {
            audit.envelopes.push(env);
            if (env.body?.schema === 'surface_event/v0.2' && env.body?.event === 'created') {
              audit.capsuleCreated = env.body.data?.surface || null;
            }
            writeAudit();
          }
        }
      });
    });

    server.listen(sockPath, () => {
      try {
        fs.chmodSync(sockPath, 0o600);
      } catch {}
      process.stdout.write('CORE_LISTENING\n');
    });

    const shutdown = () => {
      writeAudit();
      try {
        server.close();
      } catch {}
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    setInterval(() => {}, 1000);
    """
).lstrip()


ADAPTER_RUNTIME_MJS = textwrap.dedent(
    r"""
    import { createConnection } from 'node:net';
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import { join } from 'node:path';
    import { randomUUID } from 'node:crypto';

    const receiptPath = process.env.MV_ADAPTER_RECEIPT_PATH || join(process.env.XDG_RUNTIME_DIR || '/tmp', 'adapter-receipt.json');
    const record = {
      pid: process.pid,
      started: true,
      handshake: false,
      reaped: false,
      capsuleBooted: false,
      capsuleId: null,
      srfBinDir: process.env.MV_SRF_BIN_DIR || null,
      sessionId: process.env.MV_SESSION_ID || null,
      envKeys: Object.keys(process.env).sort(),
    };
    const save = () => {
      try {
        writeFileSync(receiptPath, JSON.stringify(record));
      } catch {}
    };
    save();
    process.on('SIGTERM', () => {
      record.reaped = true;
      save();
      process.exit(0);
    });

    const srfBinDir = process.env.MV_SRF_BIN_DIR;
    if (!srfBinDir) {
      process.stderr.write('OPENSUPERFICIES_ABSENT\n');
      process.exit(1);
    }
    const capsuleBin = join(srfBinDir, 'srf-identity-surface');
    let capsuleInfo;
    if (!existsSync(capsuleBin)) {
      if (process.env.MV_SRF_PROFILES) {
        capsuleInfo = { status: 'CAPSULE_READY', surface_id: 'srf-smoke-browser' };
      } else {
        process.stderr.write('configuration: profile map or live profile/root required\n');
        process.exit(1);
      }
    } else {
      const capsuleRun = spawnSync(capsuleBin, ['--boot-capsule'], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin',
          MV_SRF_STATE_DIR: process.env.MV_SRF_STATE_DIR || '',
          SRF_IDENTITY_STORE_ROOT: process.env.SRF_IDENTITY_STORE_ROOT || '',
          MV_SESSION_ID: process.env.MV_SESSION_ID || '',
        },
        timeout: 5000,
      });
      if (capsuleRun.status !== 0) {
        process.stderr.write('CAPSULE_BOOT_REFUSED: ' + (capsuleRun.stderr || capsuleRun.stdout || 'exit ' + capsuleRun.status) + '\n');
        process.exit(1);
      }
      try {
        capsuleInfo = JSON.parse(capsuleRun.stdout.trim());
      } catch {
        process.stderr.write('CAPSULE_BOOT_INVALID_JSON\n');
        process.exit(1);
      }
      if (capsuleInfo?.status !== 'CAPSULE_READY' || typeof capsuleInfo?.surface_id !== 'string') {
        process.stderr.write('CAPSULE_BOOT_UNVERIFIED\n');
        process.exit(1);
      }
    }
    record.capsuleBooted = true;
    record.capsuleId = capsuleInfo.surface_id;
    save();

    const config = JSON.parse(readFileSync(process.env.MV_CORE_CONFIG, 'utf8'));
    const daemon = config.peers.find((p) => p.endpoint.component === 'daemon');
    if (process.env.MV_COMPONENT_COMMIT && process.env.MV_COMPONENT_COMMIT !== daemon.hello.component_commit) {
      process.stderr.write('ADAPTER_COMMIT_PIN_MISMATCH\n');
      process.exit(1);
    }
    const sock = createConnection(join(process.env.XDG_RUNTIME_DIR, 'metaviewer/core.sock'));
    let buf = '';
    sock.on('connect', () => {
      const helloEnv = {
        schema: 'envelope/v0.2',
        msg_id: 'daemon-hello-' + randomUUID(),
        ts_ns: 1,
        from: daemon.endpoint,
        to: config.core.endpoint,
        session_id: config.session_id,
        seq: 1,
        nonce: randomUUID(),
        body: daemon.hello,
      };
      sock.write(JSON.stringify(helloEnv) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      while (buf.includes('\n')) {
        const idx = buf.indexOf('\n');
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const reply = JSON.parse(line);
        if (
          reply?.schema === 'envelope/v0.2' &&
          reply?.from?.component === 'core' &&
          reply?.body?.schema === 'hello/v0.2' &&
          reply?.body?.component_commit === daemon.hello.component_commit
        ) {
          const createdEnv = {
            schema: 'envelope/v0.2',
            msg_id: 'daemon-capsule-created-' + randomUUID(),
            ts_ns: 2,
            from: daemon.endpoint,
            to: config.core.endpoint,
            session_id: config.session_id,
            seq: 2,
            nonce: randomUUID(),
            body: {
              schema: 'surface_event/v0.2',
              event: 'created',
              data: {
                surface: {
                  schema: 'surface/v0.2',
                  surface_id: capsuleInfo.surface_id,
                  kind: 'desktop_capsule',
                  display: ':99',
                  geometry: { w: 1280, h: 720 },
                  state: 'active',
                  visibility: 'unfolded',
                  control: 'shared',
                  profile_id: 'default-capsule',
                },
              },
            },
          };
          sock.write(JSON.stringify(createdEnv) + '\n');
          record.handshake = true;
          save();
          process.stdout.write('ADAPTER_HANDSHAKE_OK\n');
        }
      }
    });
    sock.on('error', () => {});
    setInterval(() => {}, 1000);
    """
).lstrip()


METAVIEWER_RUNTIME_MJS = textwrap.dedent(
    r"""
    import { createHash, randomUUID } from 'node:crypto';
    import * as fs from 'node:fs';
    import * as fsp from 'node:fs/promises';
    import * as net from 'node:net';
    import { tmpdir } from 'node:os';
    import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';

    const selfBin = resolve(process.argv[1]);
    const userArgv = process.argv.slice(2);
    const installedRoot = dirname(selfBin);
    const resourcesPath = join(installedRoot, 'resources');

    const FORBIDDEN_ARGV_FLAGS = new Set([
      '--debug', '--debug-brk', '--debug-port', '--import', '--inspect',
      '--inspect-brk', '--inspect-port', '--inspect-publish-uid', '--inspect-wait',
      '--no-sandbox', '--remote-allow-origins', '--remote-debugging-pipe',
      '--remote-debugging-port', '--require',
    ]);
    const KNOWN_RUNTIME_SWITCHES = new Set(['--user-data-dir', '--ozone-platform']);
    const FORBIDDEN_ENV_PREFIXES = ['DYLD_', 'ELECTRON_', 'LD_', 'NODE_', 'PYTHON'];
    const FORBIDDEN_ENV_EXACT = new Set(['BASH_ENV', 'ENV', 'GCONV_PATH', 'HOSTALIASES', 'ZDOTDIR']);

    function validateRetailLaunch(argv, env) {
      for (const key of Object.keys(env || {})) {
        if (typeof env[key] !== 'string') continue;
        if (FORBIDDEN_ENV_EXACT.has(key) || FORBIDDEN_ENV_PREFIXES.some((p) => key.startsWith(p))) {
          return { ok: false, code: 'RETAIL_ENV' };
        }
      }
      for (const item of argv) {
        if (typeof item !== 'string' || item.includes('\0')) return { ok: false, code: 'RETAIL_ARGV' };
        if (item === '--nested-depth=1') continue;
        const eq = item.indexOf('=');
        const head = eq === -1 ? item : item.slice(0, eq);
        if (FORBIDDEN_ARGV_FLAGS.has(head)) return { ok: false, code: 'RETAIL_FLAG' };
        if (KNOWN_RUNTIME_SWITCHES.has(head)) {
          if (eq === -1 || item.slice(eq + 1).length < 1) return { ok: false, code: 'RETAIL_FLAG' };
          continue;
        }
        if (item.startsWith('-')) return { ok: false, code: 'RETAIL_FLAG' };
      }
      return { ok: true };
    }

    const retail = validateRetailLaunch(userArgv, process.env);
    if (!retail.ok) {
      console.error(retail.code + ': retail launch refused');
      process.exit(1);
    }

    function sha256FileSync(filePath) {
      return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    }

    function rejectFontSync(name, prefix) {
      if (
        /\.(woff2?|ttf|otf|ttc|eot|pfa|pfb)$/i.test(name) ||
        ['wOFF', 'wOF2', 'OTTO', 'ttcf', 'true', 'typ1'].includes(prefix.subarray(0, 4).toString('ascii')) ||
        prefix.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0]))
      ) {
        throw new Error('PKG_FONT_FORBIDDEN: ' + name);
      }
    }

    function readAsarSync(archivePath) {
      const st = fs.lstatSync(archivePath);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error('ASAR must be a regular file');
      const buf = fs.readFileSync(archivePath);
      if (buf.length < 16) throw new Error('Invalid ASAR archive');
      const headerPickleSize = buf.readUInt32LE(4);
      const jsonLen = buf.readUInt32LE(12);
      const dataOffset = 8 + headerPickleSize;
      const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'));
      function statEntry(relPath) {
        const parts = String(relPath).replace(/^\/+/, '').split('/').filter(Boolean);
        let cur = header;
        for (const p of parts) {
          if (!cur || !cur.files || !(p in cur.files)) throw new Error('ASAR entry missing: ' + relPath);
          cur = cur.files[p];
        }
        return cur;
      }
      function extract(relPath) {
        const entry = statEntry(relPath);
        if (!entry || typeof entry.size !== 'number' || typeof entry.offset !== 'string') {
          throw new Error('ASAR entry not regular file: ' + relPath);
        }
        const start = dataOffset + Number(entry.offset);
        return Buffer.from(buf.subarray(start, start + entry.size));
      }
      function listAll() {
        const out = [];
        function walk(node, prefix) {
          if (!node || !node.files) return;
          for (const [k, v] of Object.entries(node.files)) {
            const full = prefix + '/' + k;
            out.push([full, v]);
            if (v && v.files) walk(v, full);
          }
        }
        walk(header, '');
        return out;
      }
      return { extract, listAll };
    }

    function verifySelfInstallSync() {
      const fbytes = fs.readFileSync(selfBin);
      const sentinel = Buffer.from('dL7pKGdnNz796Pbb' + 'jQWNKmHXBZaB9tsX');
      const fidx = fbytes.indexOf(sentinel);
      if (fidx < 0 || fbytes.indexOf(sentinel, fidx + 1) !== -1) throw new Error('Fuse sentinel missing or ambiguous');
      const fhdr = fidx + sentinel.length;
      if (fbytes[fhdr] !== 1 || fbytes[fhdr + 1] !== 9) throw new Error('Fuse wire version/length mismatch');
      const wire = fbytes.subarray(fhdr + 2, fhdr + 11).toString('ascii');
      if (wire !== '010011000') throw new Error('Fuse mismatch: ' + wire);

      const manifestPath = installedRoot + '.sha256';
      if (!fs.existsSync(manifestPath)) throw new Error('PKG_MANIFEST_MISSING');
      const defaultUmaskFileMode = (() => {
        const probe = join(tmpdir(), `.mv-mode-probe-${process.pid}-${Date.now()}`);
        try {
          const fd = fs.openSync(probe, 'wx', 0o666);
          try {
            return fs.statSync(probe).mode & 0o777;
          } finally {
            fs.closeSync(fd);
            fs.unlinkSync(probe);
          }
        } catch {
          return 0o644;
        }
      })();
      const expected = new Map();
      for (const line of fs.readFileSync(manifestPath, 'utf8').trimEnd().split('\n')) {
        const m = /^([0-9a-f]{64})(?: ([0-7]{4})  | ([ *]))(.+)$/.exec(line);
        if (!m || m[4].split('/').some((p) => !p || p === '.' || p === '..') || /[\\\r\n]/.test(m[4]) || expected.has(m[4])) {
          throw new Error('PKG_MANIFEST_INVALID');
        }
        const mode = m[2] !== undefined ? Number.parseInt(m[2], 8) : (m[3] === '*' ? 0o755 : defaultUmaskFileMode);
        expected.set(m[4], { digest: m[1], mode });
      }
      const smokeAdapterSwapped = fs.existsSync(join(installedRoot, 'resources/bin/mv-daemon-adapter.real'));
      let count = 0;
      function walk(part) {
        for (const item of fs.readdirSync(join(installedRoot, part), { withFileTypes: true })) {
          const name = part ? part + '/' + item.name : item.name;
          if (smokeAdapterSwapped && name === 'resources/bin/mv-daemon-adapter.real') continue;
          if (item.isSymbolicLink()) throw new Error('PKG_ALIAS_FORBIDDEN');
          if (item.isDirectory()) {
            walk(name);
            continue;
          }
          if (!item.isFile()) throw new Error('PKG_ENTRY_INVALID');
          const fullPath = join(installedRoot, name);
          const st = fs.lstatSync(fullPath);
          const raw = fs.readFileSync(fullPath);
          rejectFontSync(name, raw.subarray(0, 4));
          if (smokeAdapterSwapped && name === 'resources/bin/mv-daemon-adapter') {
            count++;
            continue;
          }
          const actualDigest = createHash('sha256').update(raw).digest('hex');
          const record = expected.get(name);
          const actualMode = st.mode & 0o777;
          const modeMatches =
            record !== undefined &&
            (actualMode === record.mode ||
              (record.mode === defaultUmaskFileMode && actualMode === 0o644));
          if (!record || record.digest !== actualDigest || !modeMatches) {
            throw new Error('PKG_MANIFEST_MISMATCH: ' + name);
          }
          count++;
        }
      }
      walk('');
      if (count !== expected.size) throw new Error('PKG_MANIFEST_MISSING');

      const resEntries = fs.readdirSync(resourcesPath);
      if (!resEntries.includes('app.asar') || resEntries.includes('app') || resEntries.includes('app.asar.unpacked')) {
        throw new Error('ASAR-only application layout required');
      }
      const asar = readAsarSync(join(resourcesPath, 'app.asar'));
      const mainSource = asar.extract('electron/main.js').toString('utf8');
      const sealPrefix = 'const PACKAGED_ASSET_DIGESTS = /** @type {Readonly<Record<string, string>>} */ (Object.freeze(';
      const execSealPrefix = 'const PACKAGED_EXEC_DIGESTS = Object.freeze(';
      const parts = mainSource.split(sealPrefix);
      if (parts.length !== 2) throw new Error('ASAR asset seal missing');
      const end = parts[1].indexOf('));');
      const hashes = JSON.parse(parts[1].slice(0, end));
      function normalizeSealedBytes(relPath, rawBytes) {
        if (relPath === 'electron/main.js') {
          const p = rawBytes.toString('utf8').split(sealPrefix);
          if (p.length !== 2) throw new Error('ASAR seal marker mismatch');
          const e = p[1].indexOf('));');
          if (e < 0) throw new Error('ASAR seal marker mismatch');
          return Buffer.from(p[0] + sealPrefix + '{}' + p[1].slice(e), 'utf8');
        }
        if (relPath === 'electron/nesting.js') {
          const p = rawBytes.toString('utf8').split(execSealPrefix);
          if (p.length !== 2) return rawBytes;
          const e = p[1].indexOf(');');
          if (e < 0) throw new Error('ASAR entry seal marker mismatch');
          return Buffer.from(p[0] + execSealPrefix + '{}' + p[1].slice(e), 'utf8');
        }
        return rawBytes;
      }
      let assets = 0;
      for (const [name, entry] of asar.listAll()) {
        if ('link' in entry || entry.unpacked) throw new Error('ASAR alias/unpacked entry refused');
        if (typeof entry.size === 'number') {
          const relPath = name.slice(1);
          const content = asar.extract(relPath);
          rejectFontSync(name, content.subarray(0, 4));
          let sealKey = null;
          if (relPath.startsWith('dist/renderer/')) {
            sealKey = relPath.slice('dist/renderer/'.length);
          } else if (relPath.startsWith('dist/preload/') || relPath.startsWith('electron/')) {
            sealKey = relPath;
          }
          if (sealKey !== null) {
            const d = createHash('sha256').update(normalizeSealedBytes(relPath, content)).digest('hex');
            if (hashes[sealKey] !== d) throw new Error('ASAR asset mismatch: ' + sealKey);
            assets++;
          }
        }
      }
      if (!assets || Object.keys(hashes).length !== assets) throw new Error('ASAR asset inventory mismatch');
      const pin = JSON.parse(asar.extract('electron/package-pin.json').toString('utf8'));
      if (!pin || typeof pin.version !== 'string' || !/^[0-9a-f]{40}$/.test(String(pin.commit || ''))) {
        throw new Error('PKG_PIN_INVALID');
      }
      return pin;
    }

    let pin;
    try {
      pin = verifySelfInstallSync();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const runtime = await fsp.mkdtemp(join(tmpdir(), 'mv-pkg-'));
    await fsp.chmod(runtime, 0o700);
    await fsp.mkdir(join(runtime, 'metaviewer'), { mode: 0o700 });
    const stateHome = join(runtime, 'state');
    const configHome = join(runtime, 'config');
    const srfStateDir = process.env.MV_SRF_STATE_DIR || join(runtime, 'srf-state');
    const srfIdentityRoot = process.env.SRF_IDENTITY_STORE_ROOT || join(runtime, 'srf-identity');
    for (const dir of [stateHome, configHome, srfStateDir, srfIdentityRoot]) {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      await fsp.chmod(dir, 0o700);
    }

    const registration = (component) => ({
      endpoint: { component, instance: component + '-' + randomUUID() },
      hello: {
        schema: 'hello/v0.2',
        contract_version: 'v0.2',
        component,
        component_version: pin.version,
        component_commit: pin.commit,
        dependencies: [],
      },
    });
    const config = {
      session_id: 'pkg-' + randomUUID(),
      core: registration('core'),
      peers: ['daemon', 'agent', 'ui'].map(registration),
    };
    const configPath = join(runtime, 'config.json');
    await fsp.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const daemonPeer = config.peers.find((p) => p.endpoint.component === 'daemon');
    const uiPeer = config.peers.find((p) => p.endpoint.component === 'ui');

    const sanitizedPath = (process.env.PATH || '/usr/bin:/bin')
      .split(':')
      .filter((seg) => seg && isAbsolute(seg))
      .slice(0, 32)
      .join(':');
    const coreEnv = {
      PATH: sanitizedPath,
      LANG: process.env.LANG || 'C.UTF-8',
      XDG_RUNTIME_DIR: runtime,
      XDG_STATE_HOME: stateHome,
      MV_CORE_CONFIG: configPath,
    };

    const coreBin = join(resourcesPath, 'bin/metaviewer-core');
    const core = spawn(coreBin, [], { env: coreEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let coreFailure = null;
    core.on('error', (err) => { coreFailure = err; });
    core.stderr.on('data', (bytes) => process.stderr.write(bytes));

    let adapterChild = null;
    const stopAll = async () => {
      for (const child of [adapterChild, core]) {
        if (child && child.pid && child.pid > 1 && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          try { process.kill(child.pid, 'SIGTERM'); } catch {}
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              try { process.kill(child.pid, 'SIGKILL'); } catch {}
            }
          }, 1500);
          await exited;
          clearTimeout(timer);
        }
      }
      if (process.env.MV_PKG_BOOT_RECEIPT) {
        try {
          const auditPath = join(runtime, 'metaviewer/core-audit.json');
          if (fs.existsSync(auditPath)) {
            await fsp.copyFile(auditPath, process.env.MV_PKG_BOOT_RECEIPT);
          }
        } catch {}
      }
      await fsp.rm(runtime, { recursive: true, force: true });
    };

    const sockPath = join(runtime, 'metaviewer/core.sock');
    try {
      await new Promise((resolveCore, rejectCore) => {
        let coreOut = '';
        const timer = setTimeout(() => rejectCore(new Error('PKG_CORE_START_FAILED')), 8000);
        if (coreFailure || core.exitCode !== null) {
          clearTimeout(timer);
          rejectCore(new Error('PKG_CORE_START_FAILED'));
          return;
        }
        core.stdout.on('data', (chunk) => {
          coreOut += chunk.toString('utf8');
          if (coreOut.split('\n').some((l) => l.trim() === 'CORE_LISTENING')) {
            clearTimeout(timer);
            resolveCore(undefined);
          }
        });
        core.on('exit', () => {
          clearTimeout(timer);
          rejectCore(new Error('PKG_CORE_START_FAILED'));
        });
        core.on('error', () => {
          clearTimeout(timer);
          rejectCore(new Error('PKG_CORE_START_FAILED'));
        });
      });
      await fsp.access(sockPath);
      const sockStat = await fsp.stat(sockPath);
      const dirStat = await fsp.stat(join(runtime, 'metaviewer'));
      if ((sockStat.mode & 0o777) !== 0o600 || (dirStat.mode & 0o777) !== 0o700) {
        throw new Error('PKG_SOCKET_MODE_INVALID');
      }

      // Authenticate UI peer over core.sock with hello/v0.2 and issue surface_request/v0.2 create.
      await new Promise((resolveUi, rejectUi) => {
        const client = net.createConnection(sockPath);
        let buf = '';
        client.on('connect', () => {
          const uiHello = {
            schema: 'envelope/v0.2',
            msg_id: 'ui-hello-' + randomUUID(),
            ts_ns: 1,
            from: uiPeer.endpoint,
            to: config.core.endpoint,
            session_id: config.session_id,
            seq: 1,
            nonce: randomUUID(),
            body: uiPeer.hello,
          };
          client.write(JSON.stringify(uiHello) + '\n');
        });
        client.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          if (buf.includes('\n')) {
            const reply = JSON.parse(buf.slice(0, buf.indexOf('\n')));
            if (reply?.body?.schema !== 'hello/v0.2' || reply?.from?.component !== 'core') {
              rejectUi(new Error('PKG_UI_HELLO_REJECTED'));
              client.destroy();
              return;
            }
            const createReq = {
              schema: 'envelope/v0.2',
              msg_id: 'ui-create-surface-' + randomUUID(),
              ts_ns: 2,
              from: uiPeer.endpoint,
              to: config.core.endpoint,
              session_id: config.session_id,
              seq: 2,
              nonce: randomUUID(),
              body: {
                schema: 'surface_request/v0.2',
                op: 'create',
                params: {
                  kind: 'desktop_capsule',
                  geometry: { w: 1280, h: 720 },
                  profile_id: 'default-capsule',
                },
              },
            };
            client.write(JSON.stringify(createReq) + '\n', () => {
              client.end();
              resolveUi(undefined);
            });
          }
        });
        client.on('error', rejectUi);
      });

      if (process.env.MV_SRF_BIN_DIR) {
        const adapterEnv = {
          PATH: sanitizedPath,
          LANG: process.env.LANG || 'C.UTF-8',
          HOME: process.env.HOME || runtime,
          XDG_RUNTIME_DIR: runtime,
          XDG_STATE_HOME: stateHome,
          XDG_CONFIG_HOME: configHome,
          MV_CORE_CONFIG: configPath,
          MV_SESSION_ID: config.session_id,
          MV_CORE_INSTANCE: config.core.endpoint.instance,
          MV_DAEMON_INSTANCE: daemonPeer.endpoint.instance,
          MV_COMPONENT_COMMIT: pin.commit,
          MV_CONTRACT_DIR: join(resourcesPath, 'contracts/v0.2'),
          MV_SRF_BIN_DIR: process.env.MV_SRF_BIN_DIR,
          MV_SRF_STATE_DIR: srfStateDir,
          SRF_IDENTITY_STORE_ROOT: srfIdentityRoot,
          SRF_PROXY_REGISTRY: join(runtime, 'srf-proxy-registry.json'),
        };
        if (process.env.MV_ADAPTER_RECEIPT_PATH) {
          adapterEnv.MV_ADAPTER_RECEIPT_PATH = process.env.MV_ADAPTER_RECEIPT_PATH;
        }
        if (process.env.MV_SRF_PROFILES) {
          adapterEnv.MV_SRF_PROFILES = process.env.MV_SRF_PROFILES;
        }
        const adapterBin = join(resourcesPath, 'bin/mv-daemon-adapter');
        adapterChild = spawn(adapterBin, [], { env: adapterEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
        let adapterErr = '';
        adapterChild.stderr.on('data', (b) => { adapterErr += b.toString('utf8'); });
        await new Promise((resolveHandshake, rejectHandshake) => {
          let outBuf = '';
          const timer = setTimeout(() => rejectHandshake(new Error('PKG_ADAPTER_START_FAILED: timeout')), 8000);
          adapterChild.stdout.on('data', (chunk) => {
            outBuf += chunk.toString('utf8');
            if (outBuf.split('\n').some((l) => l.trim() === 'ADAPTER_HANDSHAKE_OK')) {
              clearTimeout(timer);
              resolveHandshake(undefined);
            }
          });
          adapterChild.on('exit', (code) => {
            clearTimeout(timer);
            rejectHandshake(new Error('PKG_ADAPTER_START_FAILED: exited ' + code + ' ' + adapterErr.trim()));
          });
          adapterChild.on('error', (err) => {
            clearTimeout(timer);
            rejectHandshake(err);
          });
        });
      }

      console.log('METAVIEWER_MAIN_READY');
      await stopAll();
      if (process.env.MV_PACKAGE_SMOKE === '1') {
        console.log('METAVIEWER_MAIN_SMOKE_OK');
        // [TARGET, unit decision] Simulated packaged-app smoke contract only.
        // Real renderer loading and MUT-RENDERER-FORBIDDEN are proved with
        // Electron in ui/tools/test_package_clean_install.mjs.
        console.log('METAVIEWER_RENDERER_READY');
      }
      process.exit(0);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      await stopAll();
      process.exit(1);
    }
    """
).lstrip()


CAPSULE_SURFACE_MJS = textwrap.dedent(
    r"""
    import * as fs from 'node:fs';
    import { createHash } from 'node:crypto';
    import { join } from 'node:path';

    const selfPath = process.argv[1];
    const raw = fs.readFileSync(selfPath, 'utf8');
    const expectedSeal = 'CAPSULE_PAYLOAD_SEAL_' + 'V1:AUTHENTIC';
    if (!raw.includes(expectedSeal)) {
      process.stderr.write('CAPSULE_PAYLOAD_TAMPERED\n');
      process.exit(1);
    }
    const stateDir = process.env.MV_SRF_STATE_DIR;
    const idRoot = process.env.SRF_IDENTITY_STORE_ROOT;
    if (!stateDir || !idRoot || !fs.existsSync(stateDir) || !fs.existsSync(idRoot)) {
      process.stderr.write('CAPSULE_ISOLATION_DIRS_MISSING\n');
      process.exit(1);
    }
    const surfaceId = 'srf-capsule-' + createHash('sha256').update(process.env.MV_SESSION_ID || 'pkg').digest('hex').slice(0, 12);
    fs.writeFileSync(
      join(stateDir, 'capsule-boot.json'),
      JSON.stringify({ surface_id: surfaceId, booted: true, seal: expectedSeal }),
      { mode: 0o600 }
    );
    process.stdout.write(JSON.stringify({ status: 'CAPSULE_READY', surface_id: surfaceId }) + '\n');
    """
).lstrip()


def _compile_elf_script_runner(cc_bin: str, script_source: str, output_path: Path, include_fuses: bool = False) -> None:
    """Compile a native ELF64 binary that verifies its fuse wire (if main) and runs script_source via node."""
    escaped = ", ".join(str(b) for b in script_source.encode("utf-8"))
    c_code = f"""
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

__attribute__((used)) unsigned char MV_FUSE_WIRE[] = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX\\x01\\x09" "101100011";
static const unsigned char SCRIPT_BYTES[] = {{ {escaped}, 0 }};

int main(int argc, char **argv) {{
    volatile unsigned char *fuses = MV_FUSE_WIRE;
    if ({1 if include_fuses else 0}) {{
        for (int i = 0; i < 9; i++) {{
            if (fuses[34 + i] != (unsigned char)"010011000"[i]) {{
                fprintf(stderr, "FUSE_MISMATCH: packaged fuse wire refused\\n");
                return 1;
            }}
        }}
    }} else {{
        if (fuses[0] == 0) return 2;
    }}
    char **nargv = (char **)calloc((size_t)argc + 6, sizeof(char *));
    if (!nargv) return 1;
    nargv[0] = "node";
    nargv[1] = "--input-type=module";
    nargv[2] = "-e";
    nargv[3] = (char *)SCRIPT_BYTES;
    nargv[4] = "--";
    for (int i = 0; i < argc; i++) {{
        nargv[5 + i] = argv[i];
    }}
    execvp("node", nargv);
    perror("execvp node");
    return 127;
}}
"""
    with tempfile.NamedTemporaryFile("w", suffix=".c", delete=False, encoding="utf-8") as c_file:
        c_file.write(c_code)
        c_path = Path(c_file.name)
    try:
        subprocess.run([cc_bin, "-O1", str(c_path), "-o", str(output_path)], check=True, capture_output=True, text=True, timeout=30)
        output_path.chmod(0o755)
    finally:
        c_path.unlink(missing_ok=True)


class PackagedInstallAndCapsuleBootTests(unittest.TestCase):
    """E2E-U02n: packaged build scratch-root installation and fresh capsule boot to authenticated hello."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.node_bin = _resolve_tool("NODE", "node")
        cls.cc_bin = _resolve_tool("CC", "cc")
        cls.arch = _host_pkg_arch()
        cls.pkg_name = f"MetaViewer-linux-{cls.arch}"
        cls.node_dir = str(Path(cls.node_bin).parent)
        cls.base_path = f"{cls.node_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}"

        cls.work_dir = Path(tempfile.mkdtemp(prefix="mv-pkg-u02n-build-"))
        cls.hook_path = cls.work_dir / "asar_hook.mjs"
        cls.hook_path.write_text(ASAR_HOOK_MJS, encoding="utf-8")

        cls.artifact_tar = cls._build_packaged_tarball(cls.work_dir / "dist")

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.work_dir, ignore_errors=True)

    @classmethod
    def _run_node_packaging(cls, mjs_code: str, env_extra: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        env = dict(os.environ, PATH=cls.base_path)
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            [cls.node_bin, "--import", str(cls.hook_path), "--input-type=module", "-e", mjs_code],
            cwd=str(ROOT),
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )

    @classmethod
    def _build_packaged_tarball(
        cls, dist_dir: Path, runtime_mjs: str = METAVIEWER_RUNTIME_MJS,
        *, adapter_runtime_mjs: str = ADAPTER_RUNTIME_MJS,
    ) -> Path:
        """Assemble a complete packaged MetaViewer-linux-<arch>.tar using ui/tools/package.js."""
        dist_dir.mkdir(parents=True, exist_ok=True)
        staged = dist_dir / cls.pkg_name
        (staged / "resources" / "bin").mkdir(parents=True, exist_ok=True)

        # Compile native ELF64 binaries for metaviewer, metaviewer-core, and mv-daemon-adapter.
        _compile_elf_script_runner(cls.cc_bin, runtime_mjs, staged / "metaviewer", include_fuses=True)
        _compile_elf_script_runner(cls.cc_bin, CORE_RUNTIME_MJS, staged / "resources" / "bin" / "metaviewer-core", include_fuses=False)
        _compile_elf_script_runner(cls.cc_bin, adapter_runtime_mjs, staged / "resources" / "bin" / "mv-daemon-adapter", include_fuses=False)

        # Copy contracts/v0.2, deps.lock, and ui/kit.lock.json into resources/.
        shutil.copytree(ROOT / "contracts" / "v0.2", staged / "resources" / "contracts" / "v0.2")
        shutil.copy2(ROOT / "deps.lock", staged / "resources" / "deps.lock")
        shutil.copy2(ROOT / "ui" / "kit.lock.json", staged / "resources" / "kit.lock.json")

        (staged / "INSTALL.md").write_text(
            f"# MetaViewer Linux {cls.arch}\n\n"
            "Run ./metaviewer to start the production UI with its bundled real core.\n"
            f"sha256sum -c ../{cls.pkg_name}.sha256\n",
            encoding="utf-8",
        )

        # Build the sealed ASAR archive, flip the retail fuses on metaviewer, write the manifest,
        # and bundle the deterministic .tar archive using the real ui/tools/package.js exports.
        app_src = cls.work_dir / "app-src"
        (app_src / "dist" / "renderer").mkdir(parents=True, exist_ok=True)
        (app_src / "dist" / "preload").mkdir(parents=True, exist_ok=True)
        (app_src / "electron").mkdir(parents=True, exist_ok=True)
        (app_src / "dist" / "renderer" / "index.html").write_text("<!doctype html><title>MetaViewer</title>\n", encoding="utf-8")
        (app_src / "dist" / "preload" / "preload.cjs").write_text("'use strict';\n", encoding="utf-8")
        (app_src / "electron" / "nesting.js").write_text("import './main.js';\n", encoding="utf-8")
        for fname in ("main.js", "coreLauncher.js"):
            shutil.copy2(ROOT / "ui" / "electron" / fname, app_src / "electron" / fname)

        head_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=str(ROOT), text=True).strip()
        pkg_version = json.loads((ROOT / "ui" / "package.json").read_text(encoding="utf-8"))["version"]
        (app_src / "electron" / "package-pin.json").write_text(
            json.dumps({"version": pkg_version, "commit": head_commit}),
            encoding="utf-8",
        )
        (app_src / "package.json").write_text(
            json.dumps({"name": "metaviewer", "version": pkg_version, "type": "module", "main": "electron/nesting.js"}),
            encoding="utf-8",
        )

        seal_and_bundle = f"""
        import * as fsp from 'node:fs/promises';
        import {{ join }} from 'node:path';
        import {{ createPackage }} from '@electron/asar';
        import {{ buildFuseConfig }} from './ui/electron/main.js';
        import * as pkg from './ui/tools/package.js';

        const appSrc = {json.dumps(str(app_src))};
        const staged = {json.dumps(str(staged))};
        async function normalizeModes(dir) {{
          await fsp.chmod(dir, 0o755);
          for (const item of await fsp.readdir(dir, {{ withFileTypes: true }})) {{
            const full = join(dir, item.name);
            if (item.isDirectory()) await normalizeModes(full);
            else if (item.isFile()) {{
              const st = await fsp.lstat(full);
              await fsp.chmod(full, (st.mode & 0o111) !== 0 ? 0o755 : 0o644);
            }}
          }}
        }}
        await pkg.sealRendererAssets(appSrc);
        await createPackage(appSrc, staged + '/resources/app.asar');
        await pkg.applyFuses(staged + '/metaviewer', buildFuseConfig());
        await normalizeModes(staged);
        await pkg.verifyPackagedSecurity(staged);
        await pkg.writeManifest(staged, staged + '.sha256');
        const product = await pkg.bundlePackage(staged);
        console.log(JSON.stringify(product));
        """
        proc = cls._run_node_packaging(seal_and_bundle)
        if proc.returncode != 0:
            raise RuntimeError(f"Failed to bundle test package:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")
        product = json.loads(proc.stdout.strip().splitlines()[-1])
        return Path(product["artifact"])

    def _install_to_scratch_root(self, scratch_root: Path) -> tuple[Path, Path]:
        """Extract the packaged tarball into scratch_root and prepare a fresh capsule in srf-bin."""
        subprocess.run(
            ["tar", "--no-same-owner", "-pxf", str(self.artifact_tar), "-C", str(scratch_root)],
            check=True,
            timeout=30,
        )
        installed = scratch_root / self.pkg_name
        srf_bin_dir = scratch_root / "srf-bin"
        srf_bin_dir.mkdir(mode=0o700)
        capsule_bin = srf_bin_dir / "srf-identity-surface"
        capsule_bin.write_text(
            f"#!{self.node_bin}\n// CAPSULE_PAYLOAD_SEAL_V1:AUTHENTIC\n{CAPSULE_SURFACE_MJS}",
            encoding="utf-8",
        )
        capsule_bin.chmod(0o755)
        return installed, srf_bin_dir

    def test_u02n_scratch_install_and_fresh_capsule_boot_to_authenticated_hello(self) -> None:
        """E2E-U02n positive: install packaged build into scratch root and boot fresh capsule to authenticated hello."""
        with tempfile.TemporaryDirectory(prefix="mv-scratch-install-") as tmp:
            scratch = Path(tmp)
            installed, srf_bin_dir = self._install_to_scratch_root(scratch)

            # 1. Verify delivered manifest (digest + mode fields) and ui/tools/package.js verifyInstall.
            manifest_path = scratch / f"{self.pkg_name}.sha256"
            self.assertTrue(manifest_path.is_file())
            manifest_lines = manifest_path.read_text(encoding="utf-8").splitlines()
            self.assertGreaterEqual(len(manifest_lines), 28)
            for line in manifest_lines:
                m = re.fullmatch(r"([0-9a-f]{64}) ([ *])([^\r\n\\]+)", line)
                self.assertIsNotNone(m, f"Invalid sha256sum -c manifest line: {line!r}")
                assert m is not None
                _digest_hex, mode_flag, rel_name = m.group(1), m.group(2), m.group(3)
                target_file = installed / rel_name
                self.assertTrue(target_file.is_file(), f"Missing installed file: {rel_name}")
                expected_mode = 0o755 if mode_flag == "*" else 0o644
                actual_mode = stat.S_IMODE(target_file.lstat().st_mode)
                self.assertEqual(actual_mode, expected_mode, f"Mode mismatch for {rel_name}")

            sha_proc = subprocess.run(
                ["sha256sum", "-c", f"../{self.pkg_name}.sha256"],
                cwd=str(installed),
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(sha_proc.returncode, 0, sha_proc.stdout + sha_proc.stderr)

            verify_proc = self._run_node_packaging(
                f"""
                import * as pkg from './ui/tools/package.js';
                pkg.validateOutput({json.dumps(str(scratch))}, {json.dumps(str(ROOT))});
                await pkg.verifyInstall({json.dumps(str(installed))});
                """
            )
            self.assertEqual(verify_proc.returncode, 0, verify_proc.stdout + verify_proc.stderr)

            # 2. Boot the installed package in the scratch root with a fresh capsule (MV_SRF_BIN_DIR)
            #    and verify authenticated hello/v0.2 + capsule creation + clean SIGTERM reaping.
            adapter_receipt_path = scratch / "adapter-receipt.json"
            core_audit_path = scratch / "core-audit.json"
            srf_state_dir = scratch / "capsule-state"
            srf_id_dir = scratch / "capsule-identity"
            srf_state_dir.mkdir(mode=0o700)
            srf_id_dir.mkdir(mode=0o700)

            boot_env = {
                "PATH": self.base_path,
                "HOME": str(scratch),
                "LANG": "C.UTF-8",
                "MV_PACKAGE_SMOKE": "1",
                "MV_SRF_BIN_DIR": str(srf_bin_dir),
                "MV_SRF_STATE_DIR": str(srf_state_dir),
                "SRF_IDENTITY_STORE_ROOT": str(srf_id_dir),
                "MV_ADAPTER_RECEIPT_PATH": str(adapter_receipt_path),
                "MV_PKG_BOOT_RECEIPT": str(core_audit_path),
            }
            boot_proc = subprocess.run(
                [str(installed / "metaviewer"), f"--user-data-dir={scratch / 'profile'}"],
                cwd=str(scratch),
                env=boot_env,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(boot_proc.returncode, 0, boot_proc.stdout + boot_proc.stderr)
            self.assertIn("METAVIEWER_MAIN_READY", boot_proc.stdout.splitlines())
            self.assertIn("METAVIEWER_MAIN_SMOKE_OK", boot_proc.stdout.splitlines())

            # Verify adapter receipt via ui/tools/package.js verifySmokeAdapterReceipt.
            receipt_check = self._run_node_packaging(
                f"""
                import * as pkg from './ui/tools/package.js';
                pkg.assertSmokeOutput({json.dumps(boot_proc.stdout)});
                const r = await pkg.verifySmokeAdapterReceipt(
                  {json.dumps(str(adapter_receipt_path))},
                  {json.dumps(str(srf_bin_dir))}
                );
                if (!r.capsuleBooted || typeof r.capsuleId !== 'string' || !r.capsuleId.startsWith('srf-capsule-')) {{
                  throw new Error('CAPSULE_RECEIPT_MISSING');
                }}
                """
            )
            self.assertEqual(receipt_check.returncode, 0, receipt_check.stdout + receipt_check.stderr)

            # Verify core audit record and validate every exchanged envelope against packaged v0.2 schemas.
            self.assertTrue(core_audit_path.is_file())
            core_audit = json.loads(core_audit_path.read_text(encoding="utf-8"))
            self.assertTrue(core_audit["sessionId"].startswith("pkg-"))
            self.assertEqual(core_audit["rejectedPeers"], [])
            auth_components = sorted(p["component"] for p in core_audit["authenticatedPeers"])
            self.assertEqual(auth_components, ["daemon", "ui"])
            self.assertIsNotNone(core_audit["capsuleCreated"])
            self.assertEqual(core_audit["capsuleCreated"]["kind"], "desktop_capsule")
            self.assertEqual(core_audit["capsuleCreated"]["state"], "active")

            # Check fresh capsule state file written inside MV_SRF_STATE_DIR.
            capsule_boot = json.loads((srf_state_dir / "capsule-boot.json").read_text(encoding="utf-8"))
            self.assertTrue(capsule_boot["booted"])
            self.assertEqual(capsule_boot["surface_id"], core_audit["capsuleCreated"]["surface_id"])

            validator, _ = _load_contract_validator(installed / "resources" / "contracts" / "v0.2")
            envelope_schema = validator.load("envelope.schema.json")
            self.assertGreaterEqual(len(core_audit["envelopes"]), 6)
            for env_msg in core_audit["envelopes"]:
                validator.validate(env_msg, envelope_schema)

            # Also run ui/tools/package.js cleanInstallSmoke(artifact) when xvfb-run and strace are available.
            if shutil.which("xvfb-run") and shutil.which("strace"):
                smoke_proc = self._run_node_packaging(
                    f"""
                    import * as pkg from './ui/tools/package.js';
                    const res = await pkg.cleanInstallSmoke({json.dumps(str(self.artifact_tar))});
                    console.log(JSON.stringify(res));
                    """
                )
                self.assertEqual(smoke_proc.returncode, 0, smoke_proc.stdout + smoke_proc.stderr)
                smoke_res = json.loads(smoke_proc.stdout.strip().splitlines()[-1])
                self.assertEqual(
                    smoke_res,
                    {"marker": "METAVIEWER_MAIN_SMOKE_OK", "source_access": False, "negative_controls": "PASS"},
                )

    def test_u02n_simulation_without_renderer_marker_refuses_smoke(self) -> None:
        """MUT-SIM-NO-RENDERER: a successful main-only simulation cannot pass packaged smoke."""
        marker_line = "console.log('METAVIEWER_RENDERER_READY');"
        self.assertEqual(METAVIEWER_RUNTIME_MJS.count(marker_line), 1)
        mutant_runtime = METAVIEWER_RUNTIME_MJS.replace(marker_line, "")
        with tempfile.TemporaryDirectory(prefix="mv-sim-no-renderer-") as tmp:
            artifact = self._build_packaged_tarball(Path(tmp) / "dist", mutant_runtime)
            smoke_proc = self._run_node_packaging(
                f"""
                import * as pkg from './ui/tools/package.js';
                await pkg.cleanInstallSmoke({json.dumps(str(artifact))});
                """
            )
            self.assertNotEqual(smoke_proc.returncode, 0, smoke_proc.stdout + smoke_proc.stderr)
            self.assertIn("PKG_SMOKE_MARKER_MISSING", smoke_proc.stderr)
            self.assertIn("METAVIEWER_MAIN_READY", smoke_proc.stderr)
            self.assertIn("METAVIEWER_MAIN_SMOKE_OK", smoke_proc.stderr)
            self.assertNotIn("METAVIEWER_RENDERER_READY", smoke_proc.stderr)

    def test_u02n_simulation_refusal_on_stdout_refuses_smoke(self) -> None:
        """MUT-SIM-REFUSAL-STDOUT: the exact refusal on fd 1 cannot pass packaged smoke."""
        refusal_line = r"process.stderr.write('configuration: profile map or live profile/root required\n');"
        self.assertEqual(ADAPTER_RUNTIME_MJS.count(refusal_line), 1)
        mutant_adapter = ADAPTER_RUNTIME_MJS.replace(
            refusal_line, refusal_line.replace("process.stderr", "process.stdout"),
        )
        with tempfile.TemporaryDirectory(prefix="mv-sim-refusal-stdout-") as tmp:
            artifact = self._build_packaged_tarball(
                Path(tmp) / "dist", adapter_runtime_mjs=mutant_adapter,
            )
            smoke_proc = self._run_node_packaging(
                f"""
                import * as pkg from './ui/tools/package.js';
                await pkg.cleanInstallSmoke({json.dumps(str(artifact))});
                """
            )
            self.assertNotEqual(smoke_proc.returncode, 0, smoke_proc.stdout + smoke_proc.stderr)
            self.assertIn("PKG_ADAPTER_CONFIG_REFUSAL_MISSING", smoke_proc.stderr)

    def test_u02n_negative_controls_tampered_payload_refuses_before_hello(self) -> None:
        """E2E-U02n negative: tampered payload in scratch install or capsule refuses before authenticated hello."""
        with tempfile.TemporaryDirectory(prefix="mv-scratch-neg-") as tmp:
            scratch = Path(tmp)
            installed, srf_bin_dir = self._install_to_scratch_root(scratch)

            def attempt_boot(extra_args: list[str] | None = None, env_overrides: dict[str, str] | None = None) -> tuple[subprocess.CompletedProcess[str], Path, Path]:
                run_dir = Path(tempfile.mkdtemp(prefix="mv-neg-attempt-", dir=str(scratch)))
                adapter_receipt = run_dir / "adapter-receipt.json"
                core_audit = run_dir / "core-audit.json"
                srf_state = run_dir / "srf-state"
                srf_id = run_dir / "srf-id"
                srf_state.mkdir(mode=0o700)
                srf_id.mkdir(mode=0o700)
                env = {
                    "PATH": self.base_path,
                    "HOME": str(run_dir),
                    "LANG": "C.UTF-8",
                    "MV_PACKAGE_SMOKE": "1",
                    "MV_SRF_BIN_DIR": str(srf_bin_dir),
                    "MV_SRF_STATE_DIR": str(srf_state),
                    "SRF_IDENTITY_STORE_ROOT": str(srf_id),
                    "MV_ADAPTER_RECEIPT_PATH": str(adapter_receipt),
                    "MV_PKG_BOOT_RECEIPT": str(core_audit),
                }
                if env_overrides:
                    env.update(env_overrides)
                argv = [str(installed / "metaviewer"), f"--user-data-dir={run_dir / 'profile'}"]
                if extra_args:
                    argv.extend(extra_args)
                proc = subprocess.run(argv, cwd=str(run_dir), env=env, capture_output=True, text=True, timeout=30)
                return proc, adapter_receipt, core_audit

            # Negative 1: Tampered INSTALL.md payload or mode in scratch install refuses both verifyInstall and boot before hello.
            notice = installed / "INSTALL.md"
            orig_notice = notice.read_bytes()
            orig_notice_mode = stat.S_IMODE(notice.lstat().st_mode)
            try:
                notice.write_bytes(orig_notice + b"TAMPERED_PAYLOAD\n")
                v_proc = self._run_node_packaging(
                    f"import * as pkg from './ui/tools/package.js'; await pkg.verifyInstall({json.dumps(str(installed))});"
                )
                self.assertNotEqual(v_proc.returncode, 0)
                self.assertIn("PKG_MANIFEST_MISMATCH: INSTALL.md", v_proc.stderr + v_proc.stdout)

                b_proc, adapter_rec, core_aud = attempt_boot()
                self.assertNotEqual(b_proc.returncode, 0)
                self.assertIn("PKG_MANIFEST_MISMATCH: INSTALL.md", b_proc.stderr + b_proc.stdout)
                self.assertNotIn("METAVIEWER_MAIN_SMOKE_OK", b_proc.stdout)
                self.assertFalse(adapter_rec.exists())
                self.assertFalse(core_aud.exists())

                notice.write_bytes(orig_notice)
                notice.chmod(0o600)
                m_proc = self._run_node_packaging(
                    f"import * as pkg from './ui/tools/package.js'; await pkg.verifyInstall({json.dumps(str(installed))});"
                )
                self.assertNotEqual(m_proc.returncode, 0)
                self.assertIn("PKG_MANIFEST_MISMATCH: INSTALL.md", m_proc.stderr + m_proc.stdout)

                mb_proc, mb_rec, mb_aud = attempt_boot()
                self.assertNotEqual(mb_proc.returncode, 0)
                self.assertIn("PKG_MANIFEST_MISMATCH: INSTALL.md", mb_proc.stderr + mb_proc.stdout)
                self.assertNotIn("METAVIEWER_MAIN_SMOKE_OK", mb_proc.stdout)
                self.assertFalse(mb_rec.exists())
                self.assertFalse(mb_aud.exists())
            finally:
                notice.write_bytes(orig_notice)
                notice.chmod(orig_notice_mode)

            # Negative 1b: Malformed manifest line refuses both verifyInstall and boot with PKG_MANIFEST_INVALID before hello.
            manifest_path = Path(f"{installed}.sha256")
            orig_manifest = manifest_path.read_bytes()
            try:
                manifest_path.write_bytes(b"0" * 64 + b"  ../escape\n")
                inv_v = self._run_node_packaging(
                    f"import * as pkg from './ui/tools/package.js'; await pkg.verifyInstall({json.dumps(str(installed))});"
                )
                self.assertNotEqual(inv_v.returncode, 0)
                self.assertIn("PKG_MANIFEST_INVALID", inv_v.stderr + inv_v.stdout)

                inv_b, inv_rec, inv_aud = attempt_boot()
                self.assertNotEqual(inv_b.returncode, 0)
                self.assertIn("PKG_MANIFEST_INVALID", inv_b.stderr + inv_b.stdout)
                self.assertFalse(inv_rec.exists())
                self.assertFalse(inv_aud.exists())
            finally:
                manifest_path.write_bytes(orig_manifest)

            # Negative 2: Tampered ASAR renderer payload (replacing index.html inside app.asar, even if manifest is updated)
            # refuses ASAR asset seal verification before hello.
            asar_path = installed / "resources" / "app.asar"
            manifest_path = Path(f"{installed}.sha256")
            orig_asar = asar_path.read_bytes()
            orig_manifest = manifest_path.read_bytes()
            try:
                tampered_asar = orig_asar.replace(b"<title>MetaViewer</title>", b"<title>TAMPERED!!</title>")
                self.assertNotEqual(tampered_asar, orig_asar)
                asar_path.write_bytes(tampered_asar)
                new_asar_sha = hashlib.sha256(tampered_asar).hexdigest()
                old_asar_sha = hashlib.sha256(orig_asar).hexdigest()
                manifest_path.write_bytes(orig_manifest.replace(old_asar_sha.encode("ascii"), new_asar_sha.encode("ascii")))

                v_proc = self._run_node_packaging(
                    f"import * as pkg from './ui/tools/package.js'; await pkg.verifyInstall({json.dumps(str(installed))});"
                )
                self.assertNotEqual(v_proc.returncode, 0)
                self.assertIn("ASAR asset mismatch", v_proc.stderr + v_proc.stdout)

                b_proc, adapter_rec, core_aud = attempt_boot()
                self.assertNotEqual(b_proc.returncode, 0)
                self.assertIn("ASAR asset mismatch", b_proc.stderr + b_proc.stdout)
                self.assertFalse(adapter_rec.exists())
                self.assertFalse(core_aud.exists())
            finally:
                asar_path.write_bytes(orig_asar)
                manifest_path.write_bytes(orig_manifest)

            # Negative 3: Tampered fuse wire on installed metaviewer binary refuses before hello.
            mv_bin = installed / "metaviewer"
            orig_mv = mv_bin.read_bytes()
            try:
                sentinel = b"dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX\x01\x09"
                idx = orig_mv.index(sentinel) + len(sentinel)
                tampered_mv = bytearray(orig_mv)
                tampered_mv[idx] = ord("1")  # Flip RunAsNode from '0' to '1'
                tampered_mv_bytes = bytes(tampered_mv)
                mv_bin.write_bytes(tampered_mv_bytes)
                mv_bin.chmod(0o755)
                old_mv_sha = hashlib.sha256(orig_mv).hexdigest().encode("ascii")
                new_mv_sha = hashlib.sha256(tampered_mv_bytes).hexdigest().encode("ascii")
                manifest_path.write_bytes(orig_manifest.replace(old_mv_sha, new_mv_sha))

                v_proc = self._run_node_packaging(
                    f"import * as pkg from './ui/tools/package.js'; await pkg.verifyInstall({json.dumps(str(installed))});"
                )
                self.assertNotEqual(v_proc.returncode, 0)
                self.assertIn("Fuse mismatch", v_proc.stderr + v_proc.stdout)

                b_proc, adapter_rec, core_aud = attempt_boot()
                self.assertNotEqual(b_proc.returncode, 0)
                self.assertIn("FUSE_MISMATCH", b_proc.stderr + b_proc.stdout)
                self.assertFalse(adapter_rec.exists())
                self.assertFalse(core_aud.exists())
            finally:
                mv_bin.write_bytes(orig_mv)
                mv_bin.chmod(0o755)
                manifest_path.write_bytes(orig_manifest)

            # Negative 4: Tampered capsule payload in MV_SRF_BIN_DIR refuses before daemon hello/v0.2 handshake.
            capsule_bin = srf_bin_dir / "srf-identity-surface"
            orig_capsule = capsule_bin.read_text(encoding="utf-8")
            try:
                capsule_bin.write_text(
                    orig_capsule.replace("CAPSULE_PAYLOAD_SEAL_V1:AUTHENTIC", "CAPSULE_PAYLOAD_SEAL_V1:CORRUPTED", 1),
                    encoding="utf-8",
                )
                capsule_bin.chmod(0o755)
                b_proc, adapter_rec, core_aud = attempt_boot()
                self.assertNotEqual(b_proc.returncode, 0)
                self.assertNotIn("METAVIEWER_MAIN_SMOKE_OK", b_proc.stdout)
                self.assertTrue(adapter_rec.is_file())
                rec = json.loads(adapter_rec.read_text(encoding="utf-8"))
                self.assertFalse(rec["handshake"], "tampered capsule must refuse before hello handshake")
                self.assertFalse(rec["capsuleBooted"])
                if core_aud.is_file():
                    aud = json.loads(core_aud.read_text(encoding="utf-8"))
                    daemon_peers = [p for p in aud["authenticatedPeers"] if p["component"] == "daemon"]
                    self.assertEqual(daemon_peers, [], "daemon must never authenticate hello when capsule is tampered")
                    self.assertIsNone(aud["capsuleCreated"])
            finally:
                capsule_bin.write_text(orig_capsule, encoding="utf-8")
                capsule_bin.chmod(0o755)

            # Negative 5: Tampered peer hello/v0.2 component_commit is refused by metaviewer-core before hello completion.
            b_proc, adapter_rec, core_aud = attempt_boot(
                env_overrides={"MV_COMPONENT_COMMIT": "0" * 40}
            )
            # Even if parent env carries a mismatched commit, verify that forging a peer hello on core.sock is rejected.
            self.assertEqual(b_proc.returncode, 0)
            # Now test a forged adapter script that sends a tampered component_commit over core.sock:
            adapter_bin = installed / "resources" / "bin" / "mv-daemon-adapter"
            backup_adapter = installed / "resources" / "bin" / "mv-daemon-adapter.real"
            shutil.copy2(adapter_bin, backup_adapter)
            try:
                forged_adapter = textwrap.dedent(
                    f"""#!{self.node_bin}
                    import {{ createConnection }} from 'node:net';
                    import {{ readFileSync, writeFileSync }} from 'node:fs';
                    import {{ join }} from 'node:path';
                    const receiptPath = process.env.MV_ADAPTER_RECEIPT_PATH;
                    const record = {{ pid: process.pid, started: true, handshake: false, reaped: false }};
                    writeFileSync(receiptPath, JSON.stringify(record));
                    const config = JSON.parse(readFileSync(process.env.MV_CORE_CONFIG, 'utf8'));
                    const daemon = config.peers.find((p) => p.endpoint.component === 'daemon');
                    const tamperedHello = {{ ...daemon.hello, component_commit: '{"f" * 40}' }};
                    const sock = createConnection(join(process.env.XDG_RUNTIME_DIR, 'metaviewer/core.sock'));
                    sock.on('connect', () => {{
                      sock.write(JSON.stringify({{
                        schema: 'envelope/v0.2',
                        msg_id: 'forged-hello',
                        ts_ns: 1,
                        from: daemon.endpoint,
                        to: config.core.endpoint,
                        session_id: config.session_id,
                        seq: 1,
                        nonce: 'nonce-1',
                        body: tamperedHello,
                      }}) + '\\n');
                    }});
                    sock.on('data', () => {{
                      record.handshake = true;
                      writeFileSync(receiptPath, JSON.stringify(record));
                      process.stdout.write('ADAPTER_HANDSHAKE_OK\\n');
                    }});
                    sock.on('close', () => process.exit(1));
                    """
                ).lstrip()
                adapter_bin.write_text(forged_adapter, encoding="utf-8")
                adapter_bin.chmod(0o755)

                f_proc, f_rec, f_aud = attempt_boot()
                self.assertNotEqual(f_proc.returncode, 0)
                self.assertNotIn("METAVIEWER_MAIN_SMOKE_OK", f_proc.stdout)
                self.assertTrue(f_rec.is_file())
                self.assertFalse(json.loads(f_rec.read_text(encoding="utf-8"))["handshake"])
                self.assertTrue(f_aud.is_file())
                aud_data = json.loads(f_aud.read_text(encoding="utf-8"))
                self.assertEqual(
                    [r["reason"] for r in aud_data["rejectedPeers"]],
                    ["hello-pin-mismatch"],
                )
            finally:
                shutil.move(str(backup_adapter), str(adapter_bin))


if __name__ == "__main__":
    unittest.main()
