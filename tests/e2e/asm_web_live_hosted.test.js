import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { HostedWebCapsuleFake, HostedCoreAdmissionFake, makeProposal, loadPageSpec,
  STEP_BUDGETS } = require('./asm_web_fakes.cjs');
const runner = fileURLToPath(new URL('./e2e1_slice/asm_web_live.py', import.meta.url));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// [TARGET, unit decision] Only the backend is substituted. Task orchestration,
// budgets, frame/receipt binding, AX completion and cleanup gates run in Python.
async function dryRun(mutation = '') {
  const capsule = new HostedWebCapsuleFake({ identity: 'mv-live-1' });
  let core = new HostedCoreAdmissionFake(capsule);
  let latest, pending, report, stale = false;
  const calls = [];
  const wire = [];
  const python = process.env.PYTHON || 'python3';
  const sourceMutants = {
    'MUT-OMNIBOX-PREFOCUSED': ["[self.prelude_point(before),", "["],
    'MUT-PRELUDE-ON-BUBBLE': ["x=width // 4, y=3 * height // 4", "x=7 * width // 8, y=height // 8"],
    'MUT-PRELUDE-COUNTS': ["task['fixture_setup'] = stage(task, 'navigate', page=page, url=url)",
      "task['fixture_setup'] = stage(task, 'navigate', page=page, url=url); task['steps'] += 1"],
  };
  const args = sourceMutants[mutation]
    ? ['-c', `import sys,json; p=sys.argv[1]; a,b=json.loads(sys.argv[2]); s=open(p).read(); assert s.count(a)==1; s=s.replace(a,b); sys.argv=[p,'--hosted-rpc']; exec(compile(s,p,'exec'),{'__file__':p,'__name__':'__main__'})`, runner, JSON.stringify(sourceMutants[mutation])]
    : mutation === 'skip-final-ax'
    ? ['-c', `import sys; p=sys.argv[1]; s=open(p).read(); old='            prove_ax(task, final, final_tree, expected)'; assert s.count(old)==1; s=s.replace(old,'            pass # M-LIVE-AX-SKIP'); sys.argv=[p,'--hosted-rpc']; exec(compile(s,p,'exec'),{'__file__':p,'__name__':'__main__'})`, runner]
    : [runner, '--hosted-rpc'];
  const child = spawn(python, args, { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  const reply = result => child.stdin.write(JSON.stringify({ result }) + '\n');
  // [TARGET, unit decision] Navigation boundary fake: chrome begins with its
  // omnibox selected and retains an untouched restore bubble. Real op_navigate
  // owns the sequence and changed_region plans; this fake renders the focus cue.
  let navigation, navFrame, navPending, navGeneration = 0;
  const navigationFrame = () => {
    const pixels = Buffer.alloc(1280 * 900 * 3, 255);
    // Selection/focus cue in browser chrome, outside blank page content.
    for (let y = 30; y < 60; y++) {
      pixels.fill(navigation.focus === 'omnibox' ? 50 : 240,
        (y * 1280 + 100) * 3, (y * 1280 + 700) * 3);
    }
    for (let y = 80; y < 210; y++) {
      pixels.fill(100, (y * 1280 + 950) * 3, (y * 1280 + 1270) * 3);
    } // Persistent restore bubble.
    if (navigation.typed) pixels[0] = 10;
    if (navigation.loaded) pixels[1] = 20;
    navFrame = { surface_id: capsule.surfaceId, width: 1280, height: 900,
      generation: ++navGeneration, sha256: sha(pixels) };
    return navFrame;
  };
  const dispatch = (stage, args) => {
    calls.push(stage);
    switch (stage) {
      case 'start': return { profile: 'mv-live-1', capsules: [capsule.capsuleId] };
      case 'ownership':
        if (mutation === 'midrun-foreign' && calls.includes('propose')) {
          throw new Error('single owned profile capsule no longer proven');
        }
        return { profile: 'mv-live-1', capsules: [capsule.capsuleId] };
      case 'offline_proof': return { fixtures_offline: !(mutation === 'net-up' ||
        (mutation === 'midrun-gate-flap' && calls.includes('propose')) ) };
      case 'navigate_begin':
        assert.equal(calls.at(-2), 'offline_proof');
        navigation = { focus: 'omnibox', selected: true, typed: false,
          loaded: false, page: args.page, url: args.url };
        return {};
      case 'navigation_offline_proof': return { fixtures_offline: true };
      case 'navigation_observe': return { frame_ref: navigationFrame() };
      case 'navigation_ax': return { elements: [{ name: {
        form: 'EMPTY', flow_a: 'FLOW_STAGE_A_READY', table: 'auth-gateway',
      }[navigation.page] }] };
      case 'navigation_propose': {
        assert.deepEqual(args.sensed.frame, navFrame, 'fresh custody-bound setup frame');
        assert.equal(args.max_ms, 30000);
        assert.deepEqual(args.plan.expectation, { type: 'changed_region',
          bbox: { x: 0, y: 0, w: 1280, h: 900 } });
        const action = args.plan.action;
        if (action.type === 'click') {
          assert.ok(action.x > 0 && action.x < 640 && action.y > 450 && action.y < 900);
          navigation.focus = 'content';
          navigation.selected = false;
        } else if (action.type === 'key' && action.keys.join('+') === 'ctrl+l') {
          navigation.focus = 'omnibox'; navigation.selected = true;
        } else if (action.type === 'type') {
          assert.equal(navigation.focus, 'omnibox');
          assert.equal(navigation.selected, true);
          assert.equal(action.text, navigation.url);
          navigation.typed = true;
        } else {
          assert.deepEqual(action, { type: 'key', keys: ['Return'] });
          assert.equal(navigation.typed, true);
          navigation.loaded = true;
        }
        const id = `navigation-${navGeneration}`;
        navPending = { before: args.sensed.frame, after: navigationFrame(), id };
        return { proposal_id: id, verdict: { admitted: true },
          native_evidence: { input_mono_ns: navGeneration } };
      }
      case 'navigation_wait_verify': {
        assert.equal(args.admitted.proposal_id, navPending.id);
        if (navPending.before.sha256 === navPending.after.sha256) {
          throw Object.assign(new Error('VERIFICATION_FAILED: unchanged chrome pixels'),
            { code: 'VERIFICATION_FAILED' });
        }
        return { status: 'verified', receipt: { proposal_id: navPending.id,
          verified: true, after_frame: navPending.after }, focus_verified: true,
          input_mono_ns: navGeneration, frame_sha256: navPending.after.sha256,
          receipt_binding_negative_control: 'PASS' };
      }
      case 'navigate': {
        assert.ok(!calls.some(x => /^net(?:_|$)/.test(x)));
        assert.equal(capsule.netPolicy, 'down');
        const html = decodeURIComponent(args.url.split(',').slice(1).join(','));
        assert.ok(html.includes("default-src 'none'"));
        assert.ok(html.includes(loadPageSpec(args.page).html));
        if (args.page === 'flow_a') {
          assert.ok(html.includes('URL.createObjectURL'));
          assert.ok(html.includes('FLOW_STEP_2_CONFIRMED'));
          // Execute the runtime scripts through both document transitions:
          // nested closing script tags must survive HTML tokenization.
          const blobs = [];
          const execute = source => {
            const context = { document: { getElementById: () => ({ setAttribute() {} }) },
              URL: { createObjectURL: blob => { blobs.push(blob.source); return 'blob:local'; } },
              Blob: class { constructor(parts) { this.source = parts.join(''); } } };
            for (const script of source.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
              vm.runInNewContext(script[1], context);
            }
          };
          execute(html);
          assert.equal(blobs.length, 1);
          execute(blobs[0]);
          assert.equal(blobs.length, 2);
          assert.equal(blobs[1], loadPageSpec('flow_a').html);
        }
        capsule.loadPage(args.page);
        core = new HostedCoreAdmissionFake(capsule, { stepBudget: args.page === 'table'
          ? STEP_BUDGETS.T3_READ_TABLE : args.page === 'form'
            ? STEP_BUDGETS.T1_FORM_FILL : STEP_BUDGETS.T2_TWO_PAGE_FLOW });
        return {}; // Setup receipts come from the real Python navigation loop.
      }
      case 'observe':
        assert.equal(args.timeout_ms, 5000);
        latest = core.observe();
        wire.push(latest.observation);
        return latest.observation;
      case 'perceive': {
        const frame = latest.frameRef;
        const bytes = fs.readFileSync(frame.shm_path);
        assert.equal(sha(bytes), frame.sha256);
        return { frame, table: mutation === 'c2-mismatch'
          ? { ...latest.elementTable, frame_sha256: '0'.repeat(64) } : latest.elementTable,
        frame_witness: { sha256: sha(bytes), bytes: bytes.length, generation: frame.generation,
          surface_id: frame.surface_id, artifact: frame.shm_path } };
      }
      case 'state': return latest.wenderState;
      case 'plan': {
        const separator = args.goal.indexOf(':');
        const kind = args.goal.slice(0, separator), value = args.goal.slice(separator + 1);
        if (kind === 'read') return { row: 1, col: 2, value: '27' };
        if (kind === 'type') return { action: { kind: 'type', text: value } };
        const target = capsule.pageState.elements.find(e => e.name === value);
        assert.ok(target, `target ${value} exists`);
        const { x, y, w, h } = target.bbox;
        return { action: { kind: 'click', x: x + Math.floor(w / 2),
          y: y + Math.floor(h / 2), button: 'left' }, bbox: target.bbox };
      }
      case 'propose': {
        assert.deepEqual(calls.slice(-3), ['offline_proof', 'ownership', 'propose']);
        assert.ok(!calls.some(x => /^net(?:_|$)/.test(x)));
        assert.equal(args.max_ms, 30000);
        if (mutation === 'stale-once' && !stale) {
          stale = true;
          throw Object.assign(new Error('fresh observation required'), { code: 'STALE_FRAME' });
        }
        const proposal = makeProposal(capsule.capsuleId, args.sensed.frame,
          args.plan.action, args.plan.bbox, calls.length);
        pending = core.proposeAndExecute(proposal, args.plan.bbox, { skipWaitVerify: true });
        pending.receipt.proposal_id = proposal.nonce;
        wire.push(pending.verdict, pending.receipt);
        return { proposal_id: proposal.nonce, native_evidence: {
          input_mono_ns: pending.receipt.input_mono_ns }, verdict: pending.verdict };
      }
      case 'wait_verify': {
        assert.equal(args.timeout_ms, 30000);
        const r = core.waitVerify(args.admitted.proposal_id);
        return { status: 'verified', receipt: { ...r,
          verified: mutation !== 'unverified', after_frame: r.post_frame_ref },
        focus_verified: r.focus_verified, input_mono_ns: r.input_mono_ns,
        receipt_binding_negative_control: 'PASS',
        frame_sha256: mutation === 'receipt-mismatch' ? '0'.repeat(64) : r.frame_sha256 };
      }
      case 'ax': {
        const ax = capsule.readAxTextContainer();
        return mutation === 'ax-missing' ? { ...ax, nodes: [] } : ax;
      }
      case 'replay': return { status: 'PASS', digest: sha('hosted journal'),
        committed_records: calls.filter(x => x === 'propose').length,
        corrupt_rc: mutation === 'replay-accepted' ? 0 : 1, scope: 'hosted fake' };
      case 'cleanup':
        capsule.cleanup();
        return { container_cleanup: 'PASS', process_cleanup: { status: 'PASS',
          temporary_tree_absent: true, socket_absent: true },
        wire_evidence: wire,
        ram_cleanup: { status: 'PASS', ram_absent: mutation !== 'ram-leak' } };
      default: throw new Error(`unknown stage ${stage}`);
    }
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const data = JSON.parse(line);
      if (data.report) { report = data.report; return; }
      try { reply(dispatch(data.rpc, data.args)); }
      catch (error) { child.stdin.write(JSON.stringify({ error: error.message,
        code: error.code || 'E2E_WITNESS' }) + '\n'); }
    } catch (error) { stderr += String(error); child.kill(); }
  });
  try {
    const rc = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    assert.ok(report, `runner emitted report: ${stderr}`);
    assert.ok(!calls.some(x => /^net(?:_|$)/.test(x)));
    return { rc, report, calls };
  } finally {
    clearTimeout(timer);
    lines.close();
    capsule.cleanup();
  }
}

test('live web stays inert without its own opt-in, even with the general live gate', () => {
  const result = spawnSync(process.env.PYTHON || 'python3', [runner], {
    encoding: 'utf8', env: { ...process.env, MV_E2E_LIVE: '1', MV_LIVE_WEB: '' } });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).status, 'SKIPPED');
});

test('explicit opt-in fails before allocation when identity/prerequisites are absent', () => {
  const result = spawnSync(process.env.PYTHON || 'python3', [runner], {
    encoding: 'utf8', env: { ...process.env, MV_E2E_LIVE: '1', MV_LIVE_WEB: '1',
      MV_SRF_LIVE_PROFILE: '' } });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'E2E_PREREQ');
});

test('hosted dry-run drives all tasks on one capsule with measured stages and AX proof', async () => {
  const { rc, report, calls } = await dryRun();
  assert.equal(rc, 0, JSON.stringify(report.error));
  assert.equal(report.status, 'DONE');
  assert.equal(calls.filter(x => x === 'start').length, 1);
  assert.deepEqual(report.tasks.map(t => t.steps), [3, 2, 0]);
  assert.deepEqual(report.tasks.map(t => t.verdict), ['PASS', 'PASS', 'PASS']);
  assert.equal(report.tasks[2].reported_cell.value, '27');
  for (const task of report.tasks) {
    assert.equal(task.fixture_setup.length, 4);
    assert.equal(task.fixture_setup[0].kind, 'focus_prelude');
    assert.ok(task.fixture_setup.every(s => s.verdict.admitted &&
      s.verify_verdict.receipt.verified));
    assert.ok(task.ax_proofs.length);
    for (const values of Object.values(task.latency_ms)) {
      assert.ok(values.every(v => v.provenance === 'MEASURED' && v.value >= 0));
    }
  }
});

test('stale refusal refreshes and replans without repeating dispatched inputs', async () => {
  const { rc, report, calls } = await dryRun('stale-once');
  assert.equal(rc, 0, JSON.stringify(report.error));
  assert.equal(report.tasks[0].steps, 3);
  assert.equal(calls.filter(x => x === 'propose').length, 6);
  assert.equal(calls.filter(x => x === 'wait_verify').length, 5);
});

for (const mutation of ['skip-final-ax', 'ax-missing', 'net-up', 'c2-mismatch',
  'unverified', 'receipt-mismatch', 'replay-accepted', 'ram-leak',
  'midrun-gate-flap', 'midrun-foreign']) {
  test(`fail closed: ${mutation}`, async () => {
    const { rc, report, calls } = await dryRun(mutation);
    assert.equal(rc, 1);
    assert.equal(report.status, 'BLOCKED');
    assert.equal(calls.at(-1), 'cleanup');
    if (mutation !== 'ram-leak') assert.equal(report.error.code, 'E2E_WITNESS');
    if (mutation.startsWith('midrun-')) assert.equal(calls.filter(x => x === 'propose').length, 1);
    if (mutation === 'net-up') assert.ok(!calls.includes('navigate'));
    if (mutation === 'skip-final-ax') assert.match(report.error.detail, /mandatory final AX proof/);
  });
}

// Include Python backend security contracts in hosted JS discovery as well.
test('backend hardening contracts and named mutation controls (no live imports)', () => {
  const result = spawnSync(process.env.PYTHON || 'python3', [
    fileURLToPath(new URL('./test_asm_web_live_harden.py', import.meta.url))],
    { encoding: 'utf8', timeout: 60000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const [mutation, detail] of [
  ['MUT-OMNIBOX-PREFOCUSED', /VERIFICATION_FAILED/],
  ['MUT-PRELUDE-ON-BUBBLE', /prelude outside safe content geometry/],
  ['MUT-PRELUDE-COUNTS', /task action budget exceeded/],
]) {
  test(`navigation negative control: ${mutation}`, async () => {
    const { rc, report } = await dryRun(mutation);
    assert.equal(rc, 1);
    assert.equal(report.status, 'BLOCKED');
    assert.match(report.error.detail, detail);
    if (mutation === 'MUT-OMNIBOX-PREFOCUSED') {
      assert.equal(report.error.code, 'VERIFICATION_FAILED');
    }
  });
}
