// [TARGET, unit decision] Control the I/O boundaries rather than assume an
// initial offer happened during a sleep. Product modules remain unmodified.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installDisplayPortRouter } from '../src/frames/displayPortRouter.js';
import { DISPLAY_PORT_NOTICE_TYPE, DISPLAY_PORT_NOTICE_SCHEMA } from '../electron/framePort.js';

const source = readFileSync(new URL('../electron/displayReader.js', import.meta.url), 'utf8');
let moduleId = 0;
async function controlledHost() {
  // Test-only barriers before the first asynchronous lookup and between slot
  // and validating header reads. All actual filesystem validation still runs.
  const code = source.replace(
    "import { lstat, open, statfs as nodeStatfs } from 'node:fs/promises';",
    `import { lstat as realLstat, open, statfs as nodeStatfs } from 'node:fs/promises';
export const lookupEntered = Promise.withResolvers();
export const lookupRelease = Promise.withResolvers();
let firstLookup = true;
async function lstat(...args) {
  if (firstLookup) {
    firstLookup = false;
    lookupEntered.resolve();
    await lookupRelease.promise;
  }
  return realLstat(...args);
}`,
  ).replace('        onRingOpened:', '        onBeforeHeaderReRead: options.beforeRead,\n        onRingOpened:')
    .replace("'./framePort.js'", JSON.stringify(new URL('../electron/framePort.js', import.meta.url).href));
  assert.notEqual(code, source);
  return import('data:text/javascript;base64,' + Buffer.from(code + `\n// instance ${++moduleId}`).toString('base64'));
}

function ringFixture() {
  const root = mkdtempSync('/dev/shm/mv-pull-order-');
  const display = join(root, 'metaviewer', 'display');
  mkdirSync(join(root, 'metaviewer'), { mode: 0o700 });
  mkdirSync(display, { mode: 0o700 });
  const path = join(display, 'ordering.ring');
  let seq = 0n;
  function write() {
    const ring = Buffer.alloc(76);
    Buffer.from('MVDISP1\0').copy(ring);
    ring.writeUInt32LE(2, 8);
    ring.writeUInt32LE(1, 12);
    ring.writeUInt32LE(6, 16);
    ring.writeUInt32LE(1, 20);
    seq += 2n;
    ring.writeBigUInt64LE(seq, 24);
    ring.writeBigUInt64LE(seq, 32);
    ring.writeBigUInt64LE(1n, 40);
    ring.fill(73, 64);
    writeFileSync(path, ring, { mode: 0o600 });
  }
  write();
  return { root, write, close: () => rmSync(root, { recursive: true, force: true }) };
}

const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  // This is only a hang guard; correctness uses explicit state/barriers.
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'controlled operation completed');
    await turn();
  }
}

for (const boundary of ['before lookup', 'guarded open', 'slot read', 'idle', 'parked']) {
  for (const delayedNotice of [false, true]) {
    for (const advanceFrame of [false, true]) {
      test(`DISPLAY pull ordering: ${boundary}, notice ${delayedNotice ? 'after' : 'before'} replay, ${advanceFrame ? 'advancing' : 'static'} capture`, async t => {
        const mod = await controlledHost();
        const fixture = ringFixture();
        const timers = new Map(), notices = [], retired = [];
        const slotEntered = Promise.withResolvers(), slotRelease = Promise.withResolvers();
        const openEntered = Promise.withResolvers(), openRelease = Promise.withResolvers();
        let now = 0, next = 0, offers = 0, painted = 0;
        const router = installDisplayPortRouter({ target: null });
        router.bindSurface({ surfaceId: 'ordering', onFrame: () => { painted++; return true; } });
        const host = mod.createDisplayHost({ root: fixture.root, clock: () => now,
          setTimer: cb => { timers.set(++next, cb); return next; }, clearTimer: id => timers.delete(id),
          statfs: async () => { openEntered.resolve(); await openRelease.promise; return { type: 0x01021994 }; },
          beforeRead: async () => { slotEntered.resolve(); await slotRelease.promise; },
        });
        function deliver(port) {
          router.receiveNotice({ type: DISPLAY_PORT_NOTICE_TYPE, schema: DISPLAY_PORT_NOTICE_SCHEMA, surface_id: 'ordering' }, [port]);
        }
        host.subscribePorts(({ port }) => {
          if (++offers === 1) retired.push(port); // same lost-first-offer harness
          else if (delayedNotice) notices.push(port);
          else deliver(port);
        });
        async function poll() {
          await until(() => timers.size === 1);
          const [id, cb] = [...timers][0];
          timers.delete(id);
          now += 100;
          cb();
          await until(() => timers.size === 1);
          await turn();
        }
        try {
          host.updateSurface({ surface_id: 'ordering', state: 'active', visibility: 'unfolded' });
          host.setSubscribed(true);
          await mod.lookupEntered.promise;
          if (boundary !== 'before lookup') {
            mod.lookupRelease.resolve();
            await openEntered.promise;
            assert.equal(offers, 1);
          }
          if (boundary === 'slot read' || boundary === 'idle' || boundary === 'parked') {
            openRelease.resolve();
            await slotEntered.promise;
          }
          if (boundary === 'idle' || boundary === 'parked') {
            slotRelease.resolve();
            await until(() => timers.size === 1);
          }
          if (boundary === 'parked') {
            retired[0].postMessage({ schema: 'display_ack/v1', kind: 'display_ack',
              surfaceId: 'ordering', seq: '2', outcome: 'HIDDEN' });
            await until(() => !host.getReaderInstrumentation('ordering').visible);
            assert.equal(timers.size, 0, 'hidden sender has no scheduled poll');
          }
          assert.equal(host.requestPort('ordering'), true);
          if (advanceFrame) fixture.write(); // same ordering as the unchanged CI regression
          mod.lookupRelease.resolve(); openRelease.resolve(); slotRelease.resolve();
          await until(() => timers.size === 1);
          await poll(); // also handles a torn read when replacement occurs at slot read
          if (boundary === 'before lookup') {
            // The first request is itself the first offer: the harness discards it.
            assert.equal(offers, 1);
            for (let i = 0; i < 40; i++) await poll();
            assert.equal(painted, 0, 'lost first offer cannot paint despite completed reader polls');
            assert.equal(host.getReaderInstrumentation('ordering').framesRead, 1);
            t.diagnostic(`harness gap: offers=${offers}, reads=${host.getReaderInstrumentation('ordering').readsAttempted}, fake elapsed=${now}ms, painted=${painted}`);
            assert.equal(host.requestPort('ordering'), true, 'a subsequent real pull repairs the lost first offer');
            await poll();
          }
          for (const port of notices.splice(0)) deliver(port);
          await until(() => painted > 0);
          const prior = painted;
          await poll();
          assert.equal(painted, prior, 'static capture remains deduplicated after replacement replay');
          assert.equal(offers, 2);
          assert.equal(host.getReaderInstrumentation('ordering').visible, true);
        } finally {
          mod.lookupRelease.resolve(); openRelease.resolve(); slotRelease.resolve();
          router.dispose();
          for (const port of [...retired, ...notices]) port.close();
          await host.dispose(); fixture.close();
        }
      });
    }
  }
}
