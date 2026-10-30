import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { HostedWebCapsuleFake, HostedCoreAdmissionFake, makeProposal } = require('./asm_web_fakes.cjs');
const root = fileURLToPath(new URL('../..', import.meta.url));
const runner = path.join(root, 'tests/e2e/e2e1_slice/asm_web_live.py');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = value => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
};

async function hosted(t, mutation = '') {
  const textMode = mutation.startsWith('text');
  const paceWall = mutation === 'pace-wall';
  const secret = 'private prompt Ω';
  const wenderRoot = process.env.MV_MW_WENDER_ROOT || process.env.MV_WENDER_ROOT;
  assert.ok(wenderRoot, 'MV_MW_WENDER_ROOT or MV_WENDER_ROOT must identify the locked checkout');
  const environment = { ...process.env, MV_WENDER_ROOT: wenderRoot, PYTHONDONTWRITEBYTECODE: '1' };
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-memoryweb-Música-'));
  t.after(() => fs.rmSync(checkout, { recursive: true, force: true }));
  const fixture = spawnSync(process.env.PYTHON || 'python3',
    [path.join(root, 'agents/tests/test_mw_owner.py'), textMode ? '--fixture-text' : '--fixture', checkout],
    { encoding: 'utf8', env: environment });
  assert.equal(fixture.status, 0, fixture.stderr);
  const file = path.join(checkout, 'sites/fixture', mutation === 'schema' ? 'site.json' : 'workflows/form.json');
  if (['schema', 'drag', 'empty-oracle', 'wait-target', 'wait-no-target', 'pace-wall'].includes(mutation)) {
    const value = JSON.parse(fs.readFileSync(file));
    if (paceWall) value.execution_policy.min_action_pace_ms = 5000;
    else if (mutation === 'schema') value.domains = 'not-an-array';
    else if (mutation === 'empty-oracle') value.oracle.postconditions = [];
    else if (mutation === 'wait-target') value.steps[0].action.kind = 'wait_signal';
    else if (mutation === 'wait-no-target') value.steps[3].action.kind = 'wait_signal';
    else {
      Object.assign(value.steps[0].action, { kind: 'drag', dx_px: 1, dy_px: 1 });
    }
    fs.writeFileSync(file, canonical(value) + '\n');
  }
  const capsule = new HostedWebCapsuleFake({ identity: 'mv-live-1' });
  // This fixture adds point-free scroll to the shared fake's click/key vocabulary.
  const inject = capsule.injectInputSingleOp.bind(capsule);
  capsule.injectInputSingleOp = action => {
    if (action.kind !== 'scroll') return inject(action);
    assert.equal(action.dx, 0);
    assert.equal(action.dy, 120);
    capsule.monoNs += 5_000_000;
    const record = { kind: 'scroll', input_mono_ns: capsule.monoNs,
      focus_verified: capsule.pageState.focusedId !== null, focused_id: capsule.pageState.focusedId };
    capsule.inputLog.push(record);
    return record;
  };
  let core, latest, report, stderr = '', wallDuringPace = false;
  if (textMode) {
    const submit = capsule._submitForm.bind(capsule);
    capsule._submitForm = () => {
      submit();
      capsule.pageState.resultText = 'ANSWER_READY';
      const output = capsule.pageState.elements.find(e => e.id === 'result-text');
      output.text = 'ANSWER_READY';
      output.name = 'ANSWER_READY';
    };
  }
  const calls = [], wire = [], proposals = [], receipts = [];
  // Trusted test composition provisions the caller's mapping through stdin,
  // before HostedRPC starts; corpus, argv and environment contain no slot value.
  const bootstrap = `import json,runpy,sys
sys.path.insert(0, sys.argv[1] + '/agents')
from metaviewer_agents import mw_owner
values = json.loads(sys.stdin.readline())
Base = mw_owner.ReplayOwner
class InvocationOwner(Base):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, slot_values=values, **kwargs)
        if ${paceWall ? 'True' : 'False'}:
            def during_pace(seconds):
                self.backend.call('pace_window')
            mw_owner.time.sleep = during_pace
mw_owner.ReplayOwner = InvocationOwner
sys.argv = sys.argv[2:]
runpy.run_path(sys.argv[0], run_name='__main__')
`;
  const prefix = (textMode || paceWall) ? ['-c', bootstrap, root, runner] : [runner];
  const child = spawn(process.env.PYTHON || 'python3', [...prefix, '--hosted-rpc',
    '--mw-root', checkout, '--mw-workflow', 'fixture/form'], {
    env: { ...environment, MV_LIVE_WEB: '', TMPDIR: checkout },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (textMode || paceWall) child.stdin.write(JSON.stringify(textMode ? { prompt: secret } : {}) + '\n');
  child.stderr.on('data', bytes => { stderr += bytes; });
  const lines = createInterface({ input: child.stdout });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  // [TARGET, unit decision] Mirror the admitted navigation boundary for this hosted backend.
  const navigationUrls = [];
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
    if (navigation.typed) pixels.writeUInt32LE(navigation.text.length, 0);
    if (navigation.loaded) pixels[4] = 20;
    navFrame = { surface_id: capsule.surfaceId, width: 1280, height: 900,
      generation: ++navGeneration, sha256: sha(pixels) };
    return navFrame;
  };
  const dispatch = (stage, args) => {
    calls.push(stage);
    switch (stage) {
      case 'start':
        assert.ok(calls.includes('offline_proof'));
        return { profile: 'mv-live-1', capsules: [capsule.capsuleId] };
      case 'ownership': return { profile: 'mv-live-1', capsules: [capsule.capsuleId] };
      case 'offline_proof': return { fixtures_offline: mutation !== 'no-proof' };
      case 'navigate_begin':
        navigationUrls.push(args.url);
        assert.equal(calls.at(-2), 'offline_proof');
        navigation = { focus: 'omnibox', selected: true, typed: false,
          loaded: false, text: '', page: args.page, url: args.url };
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
        const refusal = capsule.typeRefusal({ kind: action.type, text: action.text });
        if (refusal) return refusal;
        if (action.type === 'click') {
          assert.ok(action.x > 0 && action.x < 640 && action.y > 450 && action.y < 900);
          navigation.focus = 'content';
          navigation.selected = false;
        } else if (action.type === 'key' && action.keys.join('+') === 'ctrl+l') {
          navigation.focus = 'omnibox'; navigation.selected = true;
        } else if (action.type === 'type') {
          assert.equal(navigation.focus, 'omnibox');
          assert.equal(navigation.selected, navigation.text.length === 0);
          assert.ok(Array.from(action.text).length <= 2000);
          navigation.text += action.text;
          assert.ok(navigation.url.startsWith(navigation.text));
          navigation.selected = false;
          navigation.typed = true;
        } else {
          assert.deepEqual(action, { type: 'key', keys: ['Return'] });
          assert.equal(navigation.typed, true);
          assert.equal(navigation.text, navigation.url);
          navigation.loaded = true;
        }
        const id = `navigation-${navGeneration}`;
        navPending = { before: args.sensed.frame, after: navigationFrame(), id };
        return { proposal_id: id, verdict: { admitted: true }, verified: false, error: '',
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
      case 'navigate':
        assert.ok(calls.includes('offline_proof'));
        assert.equal(args.page, 'form');
        assert.equal(args.marker, 'EMPTY');
        {
          // The runner sends the shorter of the percent-encoded and base64 data URLs.
          const head = args.url.slice(0, args.url.indexOf(','));
          const payload = args.url.slice(args.url.indexOf(',') + 1);
          const html = head.endsWith(';base64') ? Buffer.from(payload, 'base64').toString('utf8')
            : decodeURIComponent(payload);
          assert.ok(html.includes("default-src 'none'"));
        }
        capsule.loadPage('form');
        core = new HostedCoreAdmissionFake(capsule, { stepBudget: 8 });
        return [];
      case 'pace_window':
        assert.equal(proposals.length, 1);
        wallDuringPace = true;
        return {};
      case 'observe':
        latest = core.observe({ marks_out: '/dev/shm/vqa-cu/asm-web-marks.png' });
        latest.observation.frame_ref = latest.frameRef;
        if (mutation === 'captcha' || wallDuringPace) latest.observation.url = 'https://google.com/sorry?secret=private';
        if (mutation === 'login-wall') latest.observation.observed_wall = { kind: 'login_wall', observed: true };
        wire.push(latest.observation);
        return latest.observation;
      case 'perceive': {
        const frame = latest.frameRef, bytes = fs.readFileSync(frame.shm_path);
        assert.equal(sha(bytes), frame.sha256);
        return { frame, table: latest.elementTable, frame_witness: {
          sha256: sha(bytes), bytes: bytes.length, generation: frame.generation,
          surface_id: frame.surface_id, artifact: frame.shm_path } };
      }
      case 'state': {
        const state = spawnSync(process.env.PYTHON || 'python3', ['-c',
          'import json,os,sys; sys.path[:0]=[sys.argv[1]+"/agents",sys.argv[1]+"/tools"]; ' +
          'from gate_g_ai import wender_state; v=json.load(sys.stdin); ' +
          'print(json.dumps(wender_state(os.environ["MV_WENDER_ROOT"],v["table"],v["tree"])))', root], {
          input: JSON.stringify({ table: latest.elementTable, tree: { window: {},
            elements: capsule.readAxTextContainer().nodes.map(n => ({ role: n.role,
              name: n.name,
              box: [n.bbox.x, n.bbox.y, n.bbox.w, n.bbox.h],
              states: { focused: String(n.focused) } })) } }),
          encoding: 'utf8', env: environment,
        });
        assert.equal(state.status, 0, state.stderr);
        return JSON.parse(state.stdout);
      }
      case 'ax': return capsule.readAxTextContainer();
      case 'propose': {
        assert.equal(args.plan.action.type, (textMode ? ['click', 'type', 'key'] : ['click', 'click', 'key', 'scroll'])[proposals.length]);
        if (args.plan.action.type === 'key') assert.deepEqual(args.plan.action.keys, [textMode ? 'Return' : 'ArrowDown']);
        if (args.plan.action.type === 'type') assert.equal(args.plan.action.text, secret);
        const action = { ...args.plan.action, kind: args.plan.action.type };
        delete action.type;
        if (action.kind === 'key') action.key = action.keys[0];
        const proposal = makeProposal(capsule.capsuleId, args.sensed.frame, action, undefined, calls.length);
        proposals.push(proposal);
        capsule.monoNs = Number(process.hrtime.bigint()) - 5_000_000;
        const result = core.proposeAndExecute(proposal, undefined, { skipWaitVerify: true });
        wire.push(result.verdict, result.receipt);
        return { proposal_id: proposal.nonce,
          verdict: { schema: 'action_verdict/v0.2', proposal_id: proposal.nonce,
            decision: 'admitted', core_seq: proposals.length },
          native_evidence: { input_mono_ns: result.receipt.input_mono_ns } };
      }
      case 'wait_verify': {
        const r = core.waitVerify(args.admitted.proposal_id);
        const receipt = { ...r, proposal_id: (mutation === 'receipt' || mutation === 'text-receipt' && proposals.length === 2) ? 'foreign-proposal' : args.admitted.proposal_id,
          verified: true, after_frame: r.post_frame_ref,
          native_evidence: { surface_id: capsule.surfaceId, input_mono_ns: r.input_mono_ns } };
        receipts.push(receipt);
        return { status: 'verified', receipt, focus_verified: r.focus_verified,
          input_mono_ns: r.input_mono_ns, frame_sha256: r.frame_sha256,
          receipt_binding_negative_control: 'PASS' };
      }
      case 'replay': return { status: 'PASS', corrupt_rc: 1,
        committed_records: proposals.length, digest: sha(JSON.stringify(wire)) };
      case 'cleanup': capsule.cleanup(); return { container_cleanup: 'PASS', wire_evidence: wire,
        process_cleanup: { status: 'PASS', temporary_tree_absent: true, socket_absent: true },
        ram_cleanup: { status: 'PASS', ram_absent: true } };
      default: throw new Error('unexpected RPC: ' + stage);
    }
  };
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.report) { report = message.report; return; }
      try { child.stdin.write(JSON.stringify({ result: dispatch(message.rpc, message.args) }) + '\n'); }
      catch (error) { child.stdin.write(JSON.stringify({ error: error.message }) + '\n'); }
    } catch (error) { stderr += String(error); child.kill(); }
  });
  try {
    const rc = await new Promise((resolve, reject) => {
      child.on('error', reject); child.on('close', resolve);
    });
    assert.ok(report, stderr);
    if (textMode) {
      assert.ok(!JSON.stringify(report.memoryweb).includes(secret));
      const evidenceDirs = fs.readdirSync(checkout).filter(n => n.startsWith('mv-mw-evidence-'));
      assert.equal(evidenceDirs.length, 1);
      const evidenceDir = path.join(checkout, evidenceDirs[0]);
      for (const entry of fs.readdirSync(evidenceDir, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) assert.ok(!fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8').includes(secret), entry.name);
      }
    }
    const handoffPath = report.memoryweb?.summary?.evidence_refs?.find(ref => ref.endsWith('.handoff.json'));
    const evidenceDir = fs.readdirSync(checkout).find(n => n.startsWith('mv-mw-evidence-'));
    const privateHandoff = handoffPath ? path.join(checkout, evidenceDir, handoffPath) : null;
    const handoff = privateHandoff ? JSON.parse(fs.readFileSync(privateHandoff, 'utf8')) : null;
    const handoffMode = privateHandoff ? fs.statSync(privateHandoff).mode & 0o777 : null;
    return { rc, report, calls, proposals, receipts, handoffPath, handoff, handoffMode,
      focusedId: capsule.pageState.focusedId };
  } finally { clearTimeout(timer); lines.close(); capsule.cleanup(); }
}

test('MemoryWeb replay uses real Wender runner and admitted hosted RPC for every step', async t => {
  const { rc, report, proposals, receipts, focusedId } = await hosted(t);
  assert.equal(rc, 0, JSON.stringify(report));
  assert.equal(report.status, 'DONE');
  assert.equal(report.memoryweb.summary.schema, 'mw.run.v1');
  // The runner validates persisted bytes before public-report token redaction.
  assert.equal(report.memoryweb.summary_schema_validated, true);
  assert.equal(report.memoryweb.summary.steps_verified, 4);
  assert.equal(proposals.length, report.memoryweb.summary.steps_total);
  assert.equal(receipts.length, proposals.length);
  assert.ok(receipts.every(r => r.verified === true));
  assert.equal(report.memoryweb.receipts.length, proposals.length);
  assert.equal(focusedId, 'submit-btn');
  assert.deepEqual(proposals.map(p => p.action.kind), ['click', 'click', 'key', 'scroll']);
});

test('MUT-SCHEMA invalid site refuses before any backend call', async t => {
  const result = await hosted(t, 'schema');
  assert.notEqual(result.rc, 0);
  assert.equal(result.report.error.code, 'MW_SCHEMA');
  assert.deepEqual(result.calls, []);
});

test('MUT-DRAG unsupported action refuses before input', async t => {
  const result = await hosted(t, 'drag');
  assert.notEqual(result.rc, 0);
  assert.equal(result.report.error.code, 'MW_UNSUPPORTED_WORKFLOW');
  assert.equal(result.proposals.length, 0);
  assert.equal(result.calls.length, 0);
});

test('MUT-empty-oracle refuses at the corpus schema boundary', async t => {
  const result = await hosted(t, 'empty-oracle');
  assert.notEqual(result.rc, 0);
  assert.equal(result.report.error.code, 'MW_SCHEMA');
  assert.equal(result.proposals.length, 0);
  assert.deepEqual(result.calls, []);
});

for (const mutation of ['wait-target', 'wait-no-target']) {
  test(`MUT-${mutation} refuses at admission with zero proposals`, async t => {
    const result = await hosted(t, mutation);
    assert.notEqual(result.rc, 0);
    assert.equal(result.report.error.code, 'MW_UNSUPPORTED_WORKFLOW');
    assert.equal(result.proposals.length, 0);
    assert.deepEqual(result.calls, []);
  });
}

test('MUT-RECEIPT mismatched proposal receipt fails the step without retry', async t => {
  const result = await hosted(t, 'receipt');
  assert.notEqual(result.rc, 0);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.report.memoryweb.verdict_code, 'INPUT_UNCERTAIN');
  // The pinned runner fences uncertain input and deliberately emits no run receipt.
  assert.equal(result.report.memoryweb.summary, null);
  assert.equal(result.report.memoryweb.receipts.length, 0);
  assert.equal(result.calls.includes('replay'), false);
});

test('MUT-BYPASS owner has no native input import or process launcher', () => {
  const source = fs.readFileSync(path.join(root, 'agents/metaviewer_agents/mw_owner.py'), 'utf8');
  function checkSource(source) {
    assert.doesNotMatch(source, /(?:from|import)\s+[^\n]*(?:srf|docker|subprocess|xdotool)/);
    // AST allowlist and identifier checks run in the Python test; mirror forbidden
    // names here using AST identifiers, excluding comments and module paths.
    const identifiers = spawnSync(process.env.PYTHON || 'python3', ['-c',
      'import ast,json,sys; t=ast.parse(sys.stdin.read()); ' +
      'print(json.dumps([n.id for n in ast.walk(t) if isinstance(n,ast.Name)] + ' +
      '[n.attr for n in ast.walk(t) if isinstance(n,ast.Attribute)] + ' +
      '[name for n in ast.walk(t) if isinstance(n,(ast.Import,ast.ImportFrom)) for a in n.names for name in (a.name,a.asname) if name]))'],
    { encoding: 'utf8', input: source });
    assert.equal(identifiers.status, 0, identifiers.stderr);
    const body = JSON.parse(identifiers.stdout).join(' ');
    assert.doesNotMatch(body, /\b(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*|fork\w*|socket|__import__|importlib|eval|compile|ctypes|xdotool|docker|srf|injectInputSingleOp|getattr|getattribute|globals|locals|vars|__class__|__dict__|__subclasses__|__builtins__)\b/);
  }
  checkSource(source);
  const helper = fs.readFileSync(path.join(root, 'agents/metaviewer_agents/mw_handoff.py'), 'utf8');
  checkSource(helper);
  assert.throws(() => checkSource(helper + '\nos.system("solve")\n'), { code: 'ERR_ASSERTION' });
  assert.throws(() => checkSource(source + "\ngetattr(os, 'sy' + 'stem')\n"),
    { code: 'ERR_ASSERTION' });
  assert.match(source, /backend\.call\('propose'/);
  assert.match(source, /backend\.call\('wait_verify'/);
});


test('MW-TEXT private prompt uses click/type/Return and truth answer verification', async t => {
  const result = await hosted(t, 'text');
  assert.equal(result.rc, 0, JSON.stringify(result.report));
  assert.equal(result.report.memoryweb.summary_schema_validated, true);
  assert.equal(result.report.memoryweb.summary.steps_verified, 3);
  assert.deepEqual(result.proposals.map(p => p.action.kind), ['click', 'type', 'key']);
  assert.equal(result.receipts.length, 3);
  assert.equal(result.report.memoryweb.receipts.length, 3);
  assert.ok(!result.calls.some(c => /clipboard|paste/.test(c)));
});

test('MW-TEXT missing bound type receipt refuses without Return or retry', async t => {
  const result = await hosted(t, 'text-receipt');
  assert.notEqual(result.rc, 0);
  assert.deepEqual(result.proposals.map(p => p.action.kind), ['click', 'type']);
  assert.equal(result.report.memoryweb.receipts.length, 1);
  assert.equal(result.report.memoryweb.verdict_code, 'INPUT_UNCERTAIN');
});

for (const mutation of ['captcha', 'login-wall']) {
  test(`MemoryWeb ${mutation} hands off without proposals, retries, or observation polling`, async t => {
    const result = await hosted(t, mutation);
    assert.equal(result.report.memoryweb.rc, 4);
    assert.equal(result.report.memoryweb.verdict_code, 'HUMAN_HANDOFF');
    assert.equal(result.report.memoryweb.summary_schema_validated, true);
    assert.ok(result.handoffPath);
    assert.equal(result.handoff.schema, 'metaviewer.handoff/v1');
    assert.equal(result.handoff.reason, mutation === 'captcha' ? 'google_sorry' : 'login_wall');
    assert.equal(result.handoffMode, 0o600);
    assert.deepEqual(result.proposals, []);
    assert.deepEqual(result.receipts, []);
    const stopped = result.calls.indexOf('state');
    assert.ok(stopped >= 0);
    assert.deepEqual(result.calls.slice(stopped + 1), ['cleanup']);
    assert.doesNotMatch(JSON.stringify(result.handoff), /secret|private|https:|cookie|\?/);
  });
}


test('MemoryWeb wall appearing during pacing hands off before the next intent', async t => {
  const result = await hosted(t, 'pace-wall');
  assert.notEqual(result.rc, 0); // Hosted CLI maps a refused run to its own failure exit.
  assert.equal(result.report.memoryweb.rc, 4);
  assert.equal(result.report.memoryweb.verdict_code, 'HUMAN_HANDOFF');
  assert.ok(result.report.memoryweb.summary);
  assert.equal(result.report.memoryweb.summary_schema_validated, true);
  assert.ok(result.handoffPath);
  assert.equal(result.handoff.reason, 'google_sorry');
  assert.equal(result.proposals.length, 1);
  assert.equal(result.receipts.length, 1);
  const pace = result.calls.indexOf('pace_window');
  assert.ok(pace >= 0);
  assert.ok(result.calls.slice(pace + 1).includes('observe'));
  assert.ok(!result.calls.slice(pace + 1).includes('propose'));
});


test('MUT-REPLAY-NO-PROOF refuses before backend startup or input', async t => {
  const result = await hosted(t, 'no-proof');
  assert.equal(result.rc, 1);
  assert.equal(result.report.error.code, 'MW_NETWORK');
  assert.ok(!result.calls.includes('start'));
  assert.equal(result.proposals.length, 0);
});
