// Host-only authenticated bridge between role views and the capsule Unix socket.
import http from 'node:http';
import { xpraTileDocument } from './xpraClient.js';
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const AUTH = 'x-metaviewer-xpra-session';
const forbidden = new Set(['cookie', 'authorization', 'proxy-authorization', AUTH]);
/** @param {import('node:fs').Stats} st */
const identity = st => `${st.dev}:${st.ino}:${st.uid}:${st.mode}`;

/** Host supplies an already-authorized capsule and its private view root.
 * This function never discovers capsules or accepts a renderer pathname.
 * expectedSocketUid is explicit: absence must never mean "current uid".
 * jquery is a host-supplied asset for Debian's missing client symlink.
 * @param {{viewRoot:string,capsule:string,expectedSocketUid:number,jquery?:Uint8Array}} options
 */
export async function openXpraHumanBridge({ viewRoot, capsule, expectedSocketUid, jquery }) {
  if (!Number.isInteger(expectedSocketUid) || expectedSocketUid < 0 ||
      typeof viewRoot !== 'string' || resolve(viewRoot) !== viewRoot ||
      !/^srf-id-[a-z0-9-]+$/.test(capsule)) throw Error('XPRA_BINDING_REFUSED');
  if (typeof process.getuid !== 'function') throw Error('XPRA_HOST_UID_ABSENT');
  const hostUid = process.getuid();
  const outer = join(viewRoot, capsule);
  const inner = join(outer, 's');
  const socketPath = join(inner, 'xpra.sock');
  const paths = [viewRoot, outer, inner, socketPath];
  async function inspect() {
    const stats = [];
    for (const path of paths) {
      const st = await lstat(path);
      if (st.isSymbolicLink() || await realpath(path) !== path) throw Error('XPRA_PATH_REFUSED');
      stats.push(st);
    }
    if (stats.slice(0, 2).some(st => !st.isDirectory() || st.uid !== hostUid || (st.mode & 0o777) !== 0o700) ||
        !stats[2].isDirectory() || (stats[2].mode & 0o777) !== 0o777 ||
        !stats[3].isSocket() || stats[3].uid !== expectedSocketUid || (stats[3].mode & 0o777) !== 0o666) {
      throw Error('XPRA_PERMISSIONS_REFUSED');
    }
    return stats.map(identity).join('/');
  }
  const pinned = await inspect();
  const token = randomBytes(32).toString('hex');
  /** @type {Set<import('node:stream').Duplex>} */ const connections = new Set();
  let closed = false;
  let authority = '';
  /** @param {import('node:stream').Duplex} socket */
  const track = socket => {
    if (closed) { socket.destroy(); return socket; }
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    return socket;
  };
  /** @param {import('node:http').IncomingHttpHeaders} incoming */
  const headers = incoming => Object.fromEntries(Object.entries(incoming)
    .filter(([name]) => !forbidden.has(name.toLowerCase())));
  /** @param {import('node:http').IncomingMessage} req */
  async function admit(req) {
    if (closed || req.method !== 'GET' || req.headers.host !== authority ||
        req.socket.remoteAddress !== '127.0.0.1' ||
        (req.headers.origin !== undefined && req.headers.origin !== `http://${authority}`) ||
        req.headers['transfer-encoding'] !== undefined ||
        (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') ||
        typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')) return false;
    const supplied = req.headers[AUTH];
    if (typeof supplied !== 'string' || supplied.length !== token.length ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return false;
    return await inspect() === pinned;
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (!await admit(req) || closed) { res.writeHead(403).end(); return; }
      if (req.url?.split('?')[0] === '/metaviewer-tile.html') {
        res.writeHead(200, { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store',
          'referrer-policy':'no-referrer', 'x-frame-options':'SAMEORIGIN' });
        res.end(xpraTileDocument);
        return;
      }
      if (req.url === '/js/lib/jquery.js' && jquery !== undefined) {
        res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store',
          'referrer-policy': 'no-referrer' });
        res.end(jquery);
        return;
      }
      const upstream = http.request({ socketPath, path: req.url, method: 'GET',
        headers: { ...headers(req.headers), host: authority } }, response => {
        const outHeaders = { ...response.headers, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
        delete outHeaders['set-cookie'];
        // Do not allow an upstream redirect to navigate a privileged child view.
        const status = response.statusCode;
        if (status === undefined || (status >= 300 && status < 400)) {
          response.destroy(); res.writeHead(502).end(); return;
        }
        res.writeHead(status, outHeaders);
        response.pipe(res);
      });
      upstream.setTimeout(10000, () => upstream.destroy());
      upstream.on('socket', track);
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => upstream.destroy());
      upstream.end();
    } catch { res.writeHead(403).end(); }
  });
  server.on('connection', track);
  server.on('upgrade', async (req, client, head) => {
    try {
      if (!await admit(req) || closed || req.headers.upgrade?.toLowerCase() !== 'websocket' ||
          !req.headers.connection?.toLowerCase().split(/\s*,\s*/).includes('upgrade')) {
        client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
      }
      const upstream = net.createConnection({ path: socketPath });
      track(upstream);
      upstream.setTimeout(10000, () => upstream.destroy());
      upstream.once('connect', () => {
        const lines = Object.entries({ ...headers(req.headers), host: authority })
          .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
        upstream.write(`GET ${req.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
        if (head.length) upstream.write(head);
        upstream.setTimeout(0);
        client.pipe(upstream).pipe(client);
      });
      upstream.on('error', () => client.destroy());
      upstream.on('close', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
    } catch { client.destroy(); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 64;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('XPRA_LOOPBACK_BIND_UNPROVEN');
  authority = `127.0.0.1:${address.port}`;
  const origin = `http://${authority}`;
  return Object.freeze({
    origin,
    // Main-process capability only. Never return these headers over renderer IPC.
    requestHeaders: Object.freeze({ [AUTH]: token }),
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of connections) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  });
}
