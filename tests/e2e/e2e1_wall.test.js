'use strict';

/**
 * E2E1 wall journey (roadmap AC-02: live wall).
 *
 * Runs under node --test; locates the repo root from its own path. Two layers:
 *
 * 1. Harness contract tests: pure validation of selectors, the
 *    fake-capsule manifest, and the closed probe report, each paired
 *    with mutant fixtures that must FAIL the same assertions a broken
 *    wall would trip. These run on every host with node alone.
 * 2. The live wall journey: boots the product under xvfb with a
 *    scratch profile, observes the wall through stable ids, and
 *    refuses cross-capsule frame routing. It fails closed with a
 *    typed E2E_* error when a prerequisite is missing (live flag,
 *    xvfb, Electron binary, built renderer); it never skips.
 *
 * CI entry (tests/e2e/run.py): exec `node --test tests/e2e/e2e1_wall.test.js` under
 * `xvfb-run -a -s "-screen 0 1280x900x24"` with MV_E2E_LIVE=1 and the
 * repository root as cwd, and exit nonzero on any failure.
 *
 * @module e2e1_wall
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chmodSync, mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const {
  E2EError,
  MANIFEST_SCHEMA,
  MIN_WALL_TILES,
  REPORT_SCHEMA,
  WALL_PHASE,
  XVFB_ARGV,
  assertPid,
  checkFakeCapsuleSpec,
  electronBinary,
  findRepoRoot,
  makeScratch,
  readFakeManifest,
  readProbeReport,
  removeScratch,
  renderProbeFile,
  requireXvfb,
  runUnderXvfb,
  terminate,
  tileSelector,
  validateWallReport,
  wallTileListSelector,
  whichBinary,
  writeFakeManifest,
  writeProbeFile,
} = require('./harness.js');

/** Env flag arming the live journey; anything else refuses the run. */
const LIVE_FLAG = 'MV_E2E_LIVE';

/** Four fake capsules mirroring the AC-02 minimum wall. */
const FOUR_FAKES = Object.freeze([
  { capsuleId: 'wall-e2e-a', kind: 'browser', w: 640, h: 400 },
  { capsuleId: 'wall-e2e-b', kind: 'desktop_capsule', w: 640, h: 400 },
  { capsuleId: 'wall-e2e-c', kind: 'game_capsule', w: 640, h: 400 },
  { capsuleId: 'wall-e2e-d', kind: 'vm', w: 640, h: 400 },
]);

/**
 * Build a valid probe report object for size tiles.
 * @param {number} size Tile count.
 * @returns {{ schema: string, phase: string, tiles: object[], errors: string[] }}
 */
function validReport(size) {
  return {
    schema: REPORT_SCHEMA,
    phase: WALL_PHASE,
    tiles: FOUR_FAKES.slice(0, size).map((fake) => ({
      capsuleId: fake.capsuleId,
      visible: true,
      frameId: `frame-${fake.capsuleId}-gen7`,
    })),
    errors: [],
  };
}

/**
 * Assert a thunk throws E2EError with one of the expected codes.
 * @param {() => unknown} thunk Failing thunk.
 * @param {ReadonlyArray<string>} codes Accepted codes.
 */
function rejectsWith(thunk, codes) {
  assert.throws(
    thunk,
    (error) => error instanceof E2EError && codes.includes(error.code),
    `expected E2EError with code in ${codes.join(',')}`,
  );
}

/**
 * Assert a promise rejects with E2EError with one of the expected codes.
 * @param {Promise<unknown>} promise Failing promise.
 * @param {ReadonlyArray<string>} codes Accepted codes.
 * @returns {Promise<void>} Resolves once the rejection is witnessed.
 */
async function rejectsAsyncWith(promise, codes) {
  await assert.rejects(
    promise,
    (error) => error instanceof E2EError && codes.includes(error.code),
    `expected E2EError with code in ${codes.join(',')}`,
  );
}

describe('e2e1 wall harness contract', () => {
  it('pins the xvfb geometry shared with the CI e2e job', () => {
    assert.deepEqual([...XVFB_ARGV], ['-a', '-s', '-screen 0 1280x900x24']);
  });

  it('requires at least four visible tiles', () => {
    assert.equal(MIN_WALL_TILES, 4);
  });

  it('selects tiles by stable id, never by index or text', () => {
    assert.equal(wallTileListSelector(), '[data-capsule-id]');
    assert.equal(tileSelector('wall-e2e-a'), '[data-capsule-id="wall-e2e-a"]');
  });

  it('negative control: malformed capsule ids cannot build a selector', () => {
    for (const bad of ['', 'has space', 'quote"break', 'bracket]break', 'x'.repeat(129), 7, null]) {
      rejectsWith(() => tileSelector(bad), ['E2E_ARGS']);
    }
  });

  it('accepts a valid four-tile report', () => {
    const summary = validateWallReport(validReport(4));
    assert.equal(summary.visible, 4);
    assert.deepEqual(
      summary.tiles.map((tile) => tile.capsuleId),
      ['wall-e2e-a', 'wall-e2e-b', 'wall-e2e-c', 'wall-e2e-d'],
    );
  });

  it('negative control: cross-routed frame is refused (AC-02 negative)', () => {
    const mutant = validReport(4);
    mutant.tiles[1].frameId = mutant.tiles[0].frameId;
    rejectsWith(() => validateWallReport(mutant), ['E2E_ROUTING']);
  });

  it('negative control: reciprocal distinct frame swaps are refused', () => {
    const mutant = validReport(4);
    [mutant.tiles[0].frameId, mutant.tiles[1].frameId] =
      [mutant.tiles[1].frameId, mutant.tiles[0].frameId];
    rejectsWith(() => validateWallReport(mutant), ['E2E_ROUTING']);
  });

  it('binds opaque frame IDs to an independent publisher ownership map', () => {
    const report = validReport(4);
    const owners = new Map(report.tiles.map((tile, i) => [`opaque-${i}`, tile.capsuleId]));
    report.tiles.forEach((tile, i) => { tile.frameId = `opaque-${i}`; });
    assert.equal(validateWallReport(report, { frameOwners: owners }).visible, 4);
    [report.tiles[0].frameId, report.tiles[1].frameId] =
      [report.tiles[1].frameId, report.tiles[0].frameId];
    rejectsWith(() => validateWallReport(report, { frameOwners: owners }), ['E2E_ROUTING']);
    report.tiles[0].frameId = 'unpublished';
    rejectsWith(() => validateWallReport(report, { frameOwners: owners }), ['E2E_ROUTING']);
  });

  it('negative control: duplicate tile id is refused', () => {
    const mutant = validReport(4);
    mutant.tiles[3].capsuleId = mutant.tiles[0].capsuleId;
    mutant.tiles[3].frameId = 'frame-wall-e2e-d-gen7';
    rejectsWith(() => validateWallReport(mutant), ['E2E_REPORT']);
  });

  it('negative control: fewer than four visible tiles is refused', () => {
    const mutant = validReport(4);
    mutant.tiles[3].visible = false;
    rejectsWith(() => validateWallReport(mutant), ['E2E_TILES']);
  });

  it('negative control: report with an extra key is refused (closed object)', () => {
    const mutant = { ...validReport(4), debug: true };
    rejectsWith(() => validateWallReport(mutant), ['E2E_REPORT']);
  });

  it('negative control: wrong schema tag is refused', () => {
    const mutant = validReport(4);
    mutant.schema = 'wall-report/v9';
    rejectsWith(() => validateWallReport(mutant), ['E2E_REPORT']);
  });

  it('negative control: non-object and malformed reports are refused', () => {
    for (const bad of [null, [], 'text', 42, { schema: REPORT_SCHEMA }]) {
      rejectsWith(() => validateWallReport(bad), ['E2E_REPORT']);
    }
  });

  it('negative control: malformed report file is refused', () => {
    const scratch = makeScratch('mv0-e2e1');
    try {
      const badPath = join(scratch, 'report.json');
      writeFileSync(badPath, '{not json', 'utf8');
      rejectsWith(() => readProbeReport(badPath), ['E2E_REPORT']);
      rejectsWith(() => readProbeReport(join(scratch, 'missing.json')), ['E2E_REPORT']);
    } finally {
      removeScratch(scratch);
    }
  });

  it('round-trips the fake-capsule manifest', () => {
    const scratch = makeScratch('mv0-e2e1');
    try {
      const path = writeFakeManifest(scratch, FOUR_FAKES);
      const manifest = readFakeManifest(path);
      assert.equal(manifest.schema, MANIFEST_SCHEMA);
      assert.equal(manifest.capsules.length, 4);
    } finally {
      removeScratch(scratch);
    }
  });

  it('negative control: fake manifest rejects bad rows and dup ids', () => {
    rejectsWith(() => checkFakeCapsuleSpec({ capsuleId: 'ok-id', kind: 'browser', w: 1 }), ['E2E_SHAPE']);
    rejectsWith(
      () => checkFakeCapsuleSpec({ capsuleId: 'ok-id', kind: 'spaceship', w: 640, h: 400 }),
      ['E2E_SHAPE'],
    );
    rejectsWith(() => checkFakeCapsuleSpec({ capsuleId: 'bad id', kind: 'browser', w: 640, h: 400 }), ['E2E_SHAPE']);
    const scratch = makeScratch('mv0-e2e1');
    try {
      rejectsWith(() => writeFakeManifest(scratch, []), ['E2E_ARGS']);
      rejectsWith(
        () => writeFakeManifest(scratch, [FOUR_FAKES[0], { ...FOUR_FAKES[1], capsuleId: FOUR_FAKES[0].capsuleId }]),
        ['E2E_SHAPE'],
      );
    } finally {
      removeScratch(scratch);
    }
  });

  it('renders the probe file with the config as inert JSON', () => {
    const text = renderProbeFile({
      profile: '/tmp/mv0-profile',
      mainUrl: 'file:///repo/ui/electron/main.js',
      manifestPath: '/tmp/mv0-manifest.json',
      reportPath: '/tmp/mv0-report.json',
    });
    assert.ok(text.includes('e2e-fake-manifest/v1'));
    assert.ok(text.includes('/tmp/mv0-report.json'));
    rejectsWith(
      () =>
        renderProbeFile({
          profile: '/tmp/p',
          mainUrl: 'https://example.invalid/main.js',
          manifestPath: '/tmp/m.json',
          reportPath: '/tmp/r.json',
        }),
      ['E2E_ARGS'],
    );
  });

  it('writes the probe file into scratch', () => {
    const scratch = makeScratch('mv0-e2e1');
    try {
      const path = writeProbeFile(scratch, {
        profile: join(scratch, 'profile'),
        mainUrl: 'file:///repo/ui/electron/main.js',
        manifestPath: join(scratch, 'fake-manifest.json'),
        reportPath: join(scratch, 'report.json'),
      });
      assert.equal(path, join(scratch, 'probe.cjs'));
    } finally {
      removeScratch(scratch);
    }
  });

  it('finds binaries on a synthetic PATH fixture', () => {
    const scratch = makeScratch('mv0-e2e1');
    try {
      const bin = join(scratch, 'bin');
      mkdirSync(bin);
      const stub = join(bin, 'stub-tool');
      writeFileSync(stub, '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(stub, 0o755);
      assert.equal(whichBinary('stub-tool', bin), stub);
      assert.equal(whichBinary('absent-tool', bin), null);
      assert.equal(whichBinary('has/slash', bin), null);
      assert.equal(whichBinary('', bin), null);
    } finally {
      removeScratch(scratch);
    }
  });

  it('negative control: invalid pids are refused before any signal', () => {
    for (const bad of [0, 1, -5, 1.5, '42', null, Number.NaN, process.pid]) {
      rejectsWith(() => assertPid(bad), ['E2E_PID']);
    }
  });

  it('terminates only its own spawned child within budget', async () => {
    // Detached so the child leads its own group; same-group kills refuse.
    // No unref: the test awaits the exit event explicitly below.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      stdio: 'ignore',
      detached: true,
    });
    assert.ok(typeof child.pid === 'number');
    const pid = assertPid(child.pid);
    // Boolean sentinel: a signalled child exits with code null.
    const exited = new Promise((done) => child.on('exit', () => done(true)));
    await terminate(pid, { waitMs: 2000 });
    const deadline = Date.now() + 5000;
    let done = false;
    while (!done && Date.now() < deadline) {
      done = await Promise.race([exited, new Promise((wake) => setTimeout(() => wake(false), 100))]);
    }
    assert.ok(done, 'spawned child must exit after terminate');
  });

  it('negative control: terminate refuses invalid pids without signalling', async () => {
    await rejectsAsyncWith(terminate(1), ['E2E_PID']);
    await rejectsAsyncWith(terminate(process.pid), ['E2E_PID']);
  });

  it('negative control: scratch removal refuses paths outside temp', () => {
    rejectsWith(() => removeScratch('/definitely/not/temp/mv0'), ['E2E_ARGS']);
    rejectsWith(() => makeScratch('bad prefix!'), ['E2E_ARGS']);
  });

  it('negative control: spawn validates its options before forking', () => {
    rejectsWith(() => runUnderXvfb({ electron: '/bin/true', appDir: '/tmp/x', extraArgs: ['ok', 7] }), ['E2E_ARGS']);
    rejectsWith(() => runUnderXvfb({ electron: '', appDir: '/tmp/x' }), ['E2E_ARGS']);
  });

  it('captures a startup abort before any probe report exists', () => {
    const scratch = makeScratch('mv0-e2e1');
    try {
      const stub = join(scratch, 'electron');
      writeFileSync(stub, '#!/bin/sh\nprintf "startup stdout\\n"\nprintf "sandbox startup failed\\n" >&2\nexit 37\n');
      chmodSync(stub, 0o755);
      const diagnosticsPath = join(scratch, 'electron-process.json');
      const outcome = runUnderXvfb({ electron: stub, appDir: join(scratch, 'probe.cjs'), diagnosticsPath });
      assert.equal(outcome.status, 37);
      assert.equal(outcome.signal, null);
      assert.equal(outcome.error, null);
      assert.equal(outcome.timedOut, false);
      assert.match(outcome.stdout, /startup stdout/);
      assert.match(outcome.stderr, /sandbox startup failed/);
      assert.deepEqual(JSON.parse(readFileSync(diagnosticsPath, 'utf8')), outcome);
      assert.equal(existsSync(join(scratch, 'report.json')), false);
    } finally {
      removeScratch(scratch);
    }
  });
});

describe('e2e1 live wall journey', () => {
  it('wall renders four tiles without cross-routing (AC-02)', () => {
    if (process.env[LIVE_FLAG] !== '1') {
      throw new E2EError('E2E_GATE', `live journey needs ${LIVE_FLAG}=1 under the G-E2E gate`);
    }
    requireXvfb();
    const root = findRepoRoot(__dirname);
    const electron = electronBinary(root);
    const scratch = makeScratch('mv0-e2e1-live');
    try {
      const manifestPath = writeFakeManifest(scratch, FOUR_FAKES);
      const reportPath = join(scratch, 'report.json');
      const mainEntry = join(root, 'tests', 'e2e', 'live-main.cjs');
      const mainUrl = `file://${mainEntry}`;
      writeProbeFile(scratch, {
        profile: join(scratch, 'profile'),
        mainUrl,
        manifestPath,
        reportPath,
      });
      const outcome = runUnderXvfb({ electron, appDir: join(scratch, 'probe.cjs'),
        diagnosticsPath: join(scratch, 'electron-process.json') });
      // Preserve startup diagnostics in the CI report before scratch cleanup,
      // including successful launches and reports rejected by the validator.
      const diagnostic = JSON.stringify({ ...outcome,
        stdout: outcome.stdout.slice(-2000), stderr: outcome.stderr.slice(-4000) });
      console.log(`E2E_PROCESS: ${diagnostic}`);
      let summary;
      try {
        summary = readProbeReport(reportPath, { frameOwners: new Map(
          FOUR_FAKES.map(({ capsuleId }) => [`frame-${capsuleId}-gen7`, capsuleId]),
        ) });
      } catch (error) {
        if (!(error instanceof E2EError)) throw error;
        throw new E2EError(error.code, `${error.message} | report: ${(existsSync(reportPath) ? readFileSync(reportPath, "utf8").slice(0, 3000) : "absent")} | process: ${diagnostic}`);
      }
      assert.equal(outcome.timedOut, false, diagnostic);
      assert.equal(outcome.status, 0, `report errors: ${summary.errors.join(' | ').slice(0, 2000)} | process: ${diagnostic}`);
      assert.equal(summary.visible, 4);
      assert.ok(summary.tiles.every((tile) => tile.frameId !== null), "every live tile needs a frame");
    } finally {
      removeScratch(scratch);
    }
  });
});

it('malformed publisher ledger refuses with E2E_ROUTING', () => {
  assert.throws(() => validateWallReport({}, { frameOwners: {} }), { code: 'E2E_ROUTING' });
});
