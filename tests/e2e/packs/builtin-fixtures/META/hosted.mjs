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
const { HostedWebCapsuleFake, HostedCoreAdmissionFake, makeProposal, loadPageSpec } = require('../../../asm_web_fakes.cjs');
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const runner = path.join(root, 'tests/e2e/e2e1_slice/asm_web_live.py');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// The runner sends the shorter of the percent-encoded and base64 data URLs.
const dataUrlHtml = url => {
  const [head, ...rest] = url.split(',');
  const body = rest.join(',');
  return head.endsWith(';base64') ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body);
};
async function hosted(t, mutation = '') {
  const secret = 'private prompt Ω';
  const wenderRoot = process.env.MV_MW_WENDER_ROOT || process.env.MV_WENDER_ROOT;
  assert.ok(wenderRoot, 'MV_MW_WENDER_ROOT or MV_WENDER_ROOT must identify the locked checkout');
  const environment = { ...process.env, MV_WENDER_ROOT: wenderRoot, PYTHONDONTWRITEBYTECODE: '1' };
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-memoryweb-Música-'));
  t.after(() => fs.rmSync(checkout, { recursive: true, force: true }));
  const capsule = new HostedWebCapsuleFake({ identity: 'mv-live-1' });
  const html = fs.readFileSync(new URL('pages/meta-chat.html', import.meta.url), 'utf8');
  // Execute the pinned page script for both initial and submitted AX names.
  const fixtureTransform = source => mutation === 'MUT-META-OUTPUT-NO-SYNC'
    ? source.replace("output.setAttribute('aria-label', value);",
      "if (value === 'EMPTY') output.setAttribute('aria-label', value);") : source;
  capsule.loadPage = () => {
    const spec = loadPageSpec(fileURLToPath(new URL('pages/meta-chat.html', import.meta.url)), fixtureTransform);
    assert.equal(spec.elements.length, 3);
    capsule.spec = spec;
    capsule.pageState = { pageKey: 'form', width: 640, height: 360, focusedId: null,
      inputValue: '', resultText: 'EMPTY', submitted: false, elements: spec.elements };
  };
  capsule._submitForm = () => {
    capsule.spec.submit(capsule.pageState.inputValue);
    capsule.pageState.resultText = capsule.pageState.elements.find(e => e.id === 'result-text').text;
  };
  let core, latest, report, stderr = '';
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
mw_owner.ReplayOwner = InvocationOwner
sys.argv = sys.argv[2:]
runtime = runpy.run_path(sys.argv[0])
sys.exit(runtime['main']())
`;
  const prefix = ['-c', bootstrap, root, runner];
  const axControl = ['MUT-META-OUTPUT-NO-SYNC', 'AX-META-BASELINE'].includes(mutation);
  const child = spawn(process.env.PYTHON || 'python3', [...prefix, '--hosted-rpc',
    '--pack', fileURLToPath(new URL('./', import.meta.url)),
    ...(axControl ? [] : ['--mw-root', path.join(root, 'memoryweb-builtin'), '--mw-workflow', mutation === 'draft-new-chat' ? 'meta-ai/new-chat' : mutation === 'draft-ask' ? 'meta-ai/ask' : 'meta-ai/ask-fixture'])], {
    env: { ...environment, MV_LIVE_WEB: '', TMPDIR: checkout },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.write(JSON.stringify({ prompt: secret }) + '\n');
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
        if (!axControl) assert.ok(calls.includes('offline_proof'));
        else assert.deepEqual(calls, ['start']);
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
        'meta-chat': 'EMPTY', form: 'EMPTY', flow_a: 'FLOW_STAGE_A_READY', table: 'auth-gateway',
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
        assert.equal(args.page, 'meta-chat');
        assert.equal(dataUrlHtml(args.url), html);
        assert.equal(args.marker, 'EMPTY');
        assert.ok(dataUrlHtml(args.url).includes("default-src 'none'"));
        capsule.loadPage('form');
        core = new HostedCoreAdmissionFake(capsule, { stepBudget: 8 });
        return [];
      case 'observe':
        latest = core.observe();
        latest.observation.frame_ref = latest.frameRef;
        if (mutation === 'captcha') latest.observation.url = 'https://google.com/sorry?secret=private';
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
      case 'plan': {
        const [kind, ...parts] = args.goal.split(':');
        const value = parts.join(':');
        if (kind === 'read') return { values: args.sensed.state.nodes.map(n => n.name)
          .filter(name => args.sensed.read_expected.includes(name)) };
        if (kind === 'type') return { action: { type: kind, text: value } };
        if (kind === 'key') return { action: { type: kind, keys: [value] } };
        const target = capsule.pageState.elements.find(e => e.name === value);
        assert.ok(target);
        const {x,y,w,h} = target.bbox;
        return { action: { type: 'click', x: x + w / 2, y: y + h / 2, button: 'left' }, bbox: target.bbox };
      }
      case 'propose': {
        assert.equal(args.plan.action.type, ['click', 'type', 'key'][proposals.length]);
        if (args.plan.action.type === 'key') assert.deepEqual(args.plan.action.keys, ['Return']);
        if (args.plan.action.type === 'type') assert.equal(args.plan.action.text, axControl ? 'Offline question' : secret);
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
        const receipt = { ...r, proposal_id: (mutation === 'text-receipt' && proposals.length === 2) ? 'foreign-proposal' : args.admitted.proposal_id,
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
    if (report.memoryweb) {
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

const mutation = process.argv[2] || '';
const cleanups = [];
try {
  const r = await hosted({ after: fn => cleanups.push(fn) }, mutation);
  if (!mutation) {
    assert.equal(r.rc, 0, JSON.stringify({error:r.report.error, memoryweb:r.report.memoryweb}));
    assert.equal(r.report.status, 'DONE');
    assert.equal(r.report.memoryweb.summary_schema_validated, true);
    assert.equal(r.report.memoryweb.summary.steps_verified, 3);
    assert.deepEqual(r.proposals.map(p => p.action.kind), ['click', 'type', 'key']);
    assert.equal(r.receipts.length, 3);
  } else if (mutation === 'AX-META-BASELINE') {
    assert.equal(r.rc, 0, JSON.stringify(r.report.error));
    assert.equal(r.report.status, 'DONE');
    assert.deepEqual(r.report.tasks.at(-1).ax_proofs.at(-1).expected, ['ANSWER_READY']);
  } else if (mutation === 'MUT-META-OUTPUT-NO-SYNC') {
    assert.equal(r.rc, 1);
    assert.equal(r.report.error.detail, 'AX differs from perceived Wender state');
    assert.deepEqual(r.report.tasks.at(-1).ax_failure_evidence[0].expected, ['ANSWER_READY']);
    console.log(mutation + ': ' + r.report.error.detail);
  } else if (mutation.startsWith('draft-')) {
    assert.notEqual(r.rc, 0);
    assert.equal(r.report.error.code, 'MW_UNSUPPORTED_WORKFLOW');
    assert.equal(r.calls.length, 0);
    assert.equal(r.proposals.length, 0);
  } else if (mutation === 'no-proof') {
    assert.notEqual(r.rc, 0);
    assert.equal(r.report.error.code, 'MW_NETWORK');
    assert.equal(r.calls.includes('start'), false);
    assert.equal(r.proposals.length, 0);
  } else if (mutation === 'text-receipt') {
    assert.notEqual(r.rc, 0);
    assert.equal(r.report.memoryweb.verdict_code, 'INPUT_UNCERTAIN');
    assert.deepEqual(r.proposals.map(p => p.action.kind), ['click', 'type']);
  } else {
    assert.equal(r.report.memoryweb.verdict_code, 'HUMAN_HANDOFF');
    assert.equal(r.proposals.length, 0);
    assert.equal(r.handoff.schema, 'metaviewer.handoff/v1');
  }
  process.stdout.write(JSON.stringify({status:'PASS', mutation, proposals:r.proposals.length}) + '\n');
} finally { for (const fn of cleanups.reverse()) fn(); }
