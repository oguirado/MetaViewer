import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  PAGES_DIR,
  PAGE_FILES,
  VIEWPORT_WIDTH,
  VIEWPORT_HEIGHT,
  STEP_BUDGETS,
  loadPageSpec,
  validateDeterministicPageSource,
  HostedWebCapsuleFake,
  HostedCoreAdmissionFake,
  buildC2Describe,
  projectElementTable,
  runPythonAgentsBridge,
  runTask1FormFill,
  runTask2TwoPageFlow,
  runTask3ReadTable,
} = require('./asm_web_fakes.cjs');

test('asm_web_pages: static HTML fixtures satisfy determinism, CSP, and data: URI rules', () => {
  const expectedFiles = ['flow_a.html', 'flow_b.html', 'form.html', 'table.html'];
  const actualFiles = fs.readdirSync(PAGES_DIR).sort();
  assert.deepEqual(actualFiles, expectedFiles);

  for (const [key, fileName] of Object.entries(PAGE_FILES)) {
    const spec = loadPageSpec(key);
    assert.equal(spec.fileName, fileName);
    assert.equal(spec.width, VIEWPORT_WIDTH);
    assert.equal(spec.height, VIEWPORT_HEIGHT);
    assert.ok(spec.dataUrl.startsWith('data:text/html;charset=utf-8,'));
    assert.ok(spec.elements.length >= 2, `${fileName} must expose anchored elements`);
    for (const el of spec.elements) {
      assert.ok(el.bbox.x >= 0 && el.bbox.y >= 0);
      assert.ok(el.bbox.w > 0 && el.bbox.h > 0);
      assert.ok(el.bbox.x + el.bbox.w <= VIEWPORT_WIDTH);
      assert.ok(el.bbox.y + el.bbox.h <= VIEWPORT_HEIGHT);
    }
  }

  assert.throws(
    () => validateDeterministicPageSource('bad.html', '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">Math.random()'),
    /Math\.random is forbidden/,
  );
});

test('T1 (Form fill & verify result text): fills #name-input, submits, and verifies EMPTY then Hello, <value>', () => {
  const resA = runTask1FormFill({ inputText: 'Grace Hopper' });
  const resB = runTask1FormFill({ inputText: 'Grace Hopper' });

  assert.equal(resA.task, 'T1_FORM_FILL');
  assert.ok(resA.admittedActions <= STEP_BUDGETS.T1_FORM_FILL);
  assert.equal(resA.admittedActions, 4);
  assert.equal(resA.resultText, 'Hello, Grace Hopper');
  assert.notEqual(resA.preFrameRef.sha256, resA.postFrameRef.sha256);
  assert.ok(resA.postFrameRef.generation > resA.preFrameRef.generation);

  // Check element_table and wender.state/v1 contracts.
  assert.equal(resA.elementTable.schema, 'vqa.element-table/v1');
  assert.equal(resA.elementTable.frame_sha256, resA.postFrameRef.sha256);
  assert.ok(resA.elementTable.elements.some((e) => e.role === 'textbox'));
  assert.ok(resA.elementTable.elements.some((e) => e.role === 'button'));

  assert.equal(resA.wenderState.schema, 'wender.state/v1');
  assert.equal(resA.wenderState.frame_sha256, resA.postFrameRef.sha256);
  assert.ok(resA.wenderState.nodes.some((n) => n.dom_id === 'name-input' && n.actionable));
  assert.ok(resA.wenderState.nodes.some((n) => n.dom_id === 'submit-btn' && n.actionable));

  // Every admitted action has 1 verified receipt with focus_verified, input_mono_ns, and frame_sha256.
  for (const receipt of resA.receipts) {
    assert.equal(receipt.schema, 'action_receipt/v0.2');
    assert.equal(receipt.executed, true);
    assert.equal(receipt.verified, true);
    assert.equal(receipt.focus_verified, true);
    assert.equal(receipt.verified_by_wait_verify, true);
    assert.ok(receipt.input_mono_ns > 0);
    assert.equal(receipt.frame_sha256.length, 64);
  }

  // Deterministic across runs.
  assert.equal(resA.postFrameRef.sha256, resB.postFrameRef.sha256);
  assert.equal(resA.wenderState.state_sha256, resB.wenderState.state_sha256);
});

test('T2 (Two-page flow): navigates flow_a.html -> flow_b.html -> flow_a.html and verifies confirmation marker', () => {
  const res = runTask2TwoPageFlow();

  assert.equal(res.task, 'T2_TWO_PAGE_FLOW');
  assert.ok(res.admittedActions <= STEP_BUDGETS.T2_TWO_PAGE_FLOW);
  assert.equal(res.admittedActions, 2);
  assert.equal(res.confirmationText, 'FLOW_STEP_2_CONFIRMED');
  assert.equal(res.returnedText, 'FLOW_STAGE_A_READY');
  assert.notEqual(res.page1FrameRef.sha256, res.page2FrameRef.sha256);
  assert.equal(res.page1FrameRef.sha256, res.returnedFrameRef.sha256);

  assert.equal(res.page2ElementTable.schema, 'vqa.element-table/v1');
  assert.equal(res.page2ElementTable.frame_sha256, res.page2FrameRef.sha256);
  assert.ok(
    res.page2WenderState.nodes.some(
      (n) => n.dom_id === 'flow-confirmation' && n.name === 'FLOW_STEP_2_CONFIRMED',
    ),
  );

  for (const receipt of res.receipts) {
    assert.equal(receipt.verified, true);
    assert.equal(receipt.focus_verified, true);
    assert.equal(receipt.verified_by_wait_verify, true);
  }
});

test('T3 (Read table value): reads 3x3 table in document order with 0 admitted actions', () => {
  const res = runTask3ReadTable({ row: 1, col: 2 });

  assert.equal(res.task, 'T3_READ_TABLE');
  assert.equal(res.stepBudget, 0);
  assert.equal(res.admittedActions, 0);
  assert.equal(res.c2.schema, 've.cu_describe/v1');
  assert.equal(res.c2.frame_sha256, res.frameRef.sha256);
  assert.equal(res.elementTable.schema, 'vqa.element-table/v1');
  assert.equal(res.elementTable.frame_sha256, res.frameRef.sha256);
  assert.equal(res.wenderState.schema, 'wender.state/v1');
  assert.equal(res.wenderState.frame_sha256, res.frameRef.sha256);

  assert.equal(res.cellsInDocumentOrder.length, 9);
  assert.deepEqual(
    res.cellsInDocumentOrder.map((c) => c.text),
    [
      'auth-gateway', 'eu-central', '14',
      'ledger-core', 'us-east', '27',
      'stream-index', 'ap-north', '41',
    ],
  );
  assert.deepEqual(res.reportedCell, { row: 1, col: 2, value: '27' });
});

test('Real metaviewer_agents loop integration: VCorePerceptionAdapter, project_element_table, WenderSubprocessAdapter, and run_loop', () => {
  const capsule = new HostedWebCapsuleFake({ initialPage: 'flow_a' });
  const core = new HostedCoreAdmissionFake(capsule, { stepBudget: STEP_BUDGETS.T2_TWO_PAGE_FLOW });
  try {
    const obs1 = core.observe({ marks_out: '/dev/shm/vqa-cu/asm-web-marks.png' });
    capsule.loadPage('flow_b');
    const obs2 = core.observe({ marks_out: '/dev/shm/vqa-cu/asm-web-marks.png' });

    const planOut = runPythonAgentsBridge({
      mode: 'perceive_and_plan',
      capsule_id: capsule.capsuleId,
      frame_ref: obs1.observation.frame_ref,
      shm_path: obs1.frameRef.shm_path,
      observation: obs1.observation,
      c2: obs1.c2,
      goal: { kind: 'click_top' },
    });
    assert.equal(planOut.status, 0, `python bridge failed: ${planOut.stderr}`);
    const parsedPlan = JSON.parse(planOut.stdout);
    assert.equal(parsedPlan.ok, true);
    assert.equal(parsedPlan.element_table.schema, 'vqa.element-table/v1');
    assert.equal(parsedPlan.plan.action.type, 'click');
    assert.equal(parsedPlan.plan.state.schema, 'wender.state/v1');

    const loopOut = runPythonAgentsBridge({
      mode: 'run_loop',
      capsule_id: capsule.capsuleId,
      frame_ref: obs1.observation.frame_ref,
      shm_path: obs1.frameRef.shm_path,
      post_shm_path: obs2.frameRef.shm_path,
      observation: obs1.observation,
      post_observation: obs2.observation,
      c2: obs1.c2,
      post_c2: obs2.c2,
    });
    assert.equal(loopOut.status, 0, `python run_loop failed: ${loopOut.stderr}`);
    const parsedLoop = JSON.parse(loopOut.stdout);
    assert.equal(parsedLoop.ok, true);
    assert.deepEqual(parsedLoop.ops, ['observe', 'propose', 'wait_verify']);
    assert.equal(parsedLoop.receipt.verified, true);
    assert.equal(parsedLoop.receipt.focus_verified, true);
    assert.equal(parsedLoop.receipt.frame_sha256, obs2.observation.frame_ref.sha256);
  } finally {
    capsule.cleanup();
  }
});

test('Must-fail mutations M1, M2, M3 and task-specific negative controls', () => {
  // M1a: Bbox shifted out-of-frame fails hosted element_table projection AND real Python VCore/planner.
  assert.throws(
    () => runTask1FormFill({ shiftBboxOutOfFrame: true, marks_out: '/dev/shm/vqa-cu/asm-web-marks.png' }),
    (err) => err.code === 'out_of_bounds' && /out of frame bounds/.test(err.message),
  );

  const capsule = new HostedWebCapsuleFake({ initialPage: 'form' });
  try {
    const frameRef = capsule.captureFrame();
    const badC2 = buildC2Describe(capsule, frameRef, { shiftBboxOutOfFrame: true, marks_out: '/dev/shm/vqa-cu/asm-web-marks.png' });
    const pyMut = runPythonAgentsBridge({
      mode: 'perceive_and_plan',
      capsule_id: capsule.capsuleId,
      shm_path: frameRef.shm_path,
      frame_ref: {
        schema: 'frame_ref/v0.2',
        capsule_id: frameRef.capsule_id,
        fd_id: frameRef.fd_id,
        width: frameRef.width,
        height: frameRef.height,
        stride: frameRef.stride,
        format: 'RGB24',
        sha256: frameRef.sha256,
        generation: frameRef.generation,
      },
      observation: {
        schema: 'observation/v0.2',
        capsule_id: capsule.capsuleId,
        frame_ref: {
          schema: 'frame_ref/v0.2',
          capsule_id: frameRef.capsule_id,
          fd_id: frameRef.fd_id,
          width: frameRef.width,
          height: frameRef.height,
          stride: frameRef.stride,
          format: 'RGB24',
          sha256: frameRef.sha256,
          generation: frameRef.generation,
        },
        vision: null,
        degraded: false,
        budget_Warning: false,
      },
      c2: badC2,
    });
    assert.notEqual(pyMut.status, 0, 'real Python VCore/planner must reject out-of-frame bbox');
  } finally {
    capsule.cleanup();
  }

  // M1b: Planner returns wrong target coordinates outside custody bbox -> refused with OUT_OF_TARGET.
  assert.throws(
    () => runTask1FormFill({ wrongTargetMutation: true }),
    (err) => err.code === 'OUT_OF_TARGET',
  );

  // M2a: Verdict refused -> fails with POLICY before input injection.
  assert.throws(
    () => runTask1FormFill({ forceVerdictRefusal: true }),
    (err) => err.code === 'POLICY',
  );

  // M2b: Receipt verified flipped false -> wait_verify fails with WAIT_VERIFY_FAILED.
  assert.throws(
    () => runTask1FormFill({ forceReceiptUnverified: true }),
    (err) => err.code === 'WAIT_VERIFY_FAILED',
  );

  // M2c: Verification step skipped -> task fails with UNVERIFIED_ACTION_RECEIPT.
  assert.throws(
    () => runTask2TwoPageFlow({ skipWaitVerify: true }),
    (err) => err.code === 'UNVERIFIED_ACTION_RECEIPT',
  );

  // M3a: Swapped frame_sha256 between frame_ref and C2/element_table -> fails with frame_mismatch.
  assert.throws(
    () => runTask3ReadTable({ overrideFrameSha256: '0'.repeat(64) }),
    (err) => err.code === 'frame_mismatch',
  );

  // M3b: Uncorrelated surface_id -> fails with SURFACE_MISMATCH.
  assert.throws(
    () => runTask1FormFill({ overrideSurfaceId: 'surface-uncorrelated-99' }),
    (err) => err.code === 'SURFACE_MISMATCH',
  );

  // T1 specific mutations: wrong greeting text & skipped result-text check.
  assert.throws(
    () => runTask1FormFill({ wrongGreetingMutation: true }),
    (err) => err.code === 'T1_RESULT_MISMATCH',
  );
  assert.throws(
    () => runTask1FormFill({ skipResultTextCheck: true }),
    (err) => err.code === 'E2E_WITNESS',
  );

  // T2 specific mutation: corrupt based_on_frame.generation -> refused with STALE_FRAME.
  assert.throws(
    () => runTask2TwoPageFlow({ staleGenerationMutation: true }),
    (err) => err.code === 'STALE_FRAME',
  );

  // T3 specific mutations: transposed cell order & non-zero admitted actions.
  assert.throws(
    () => runTask3ReadTable({ transposeTableOrder: true }),
    (err) => err.code === 'T3_CELL_ORDER_MISMATCH',
  );
  assert.throws(
    () => runTask3ReadTable({ injectUnexpectedInputMutation: true }),
    (err) => err.code === 'RATE_LIMIT',
  );
  assert.throws(
    () => runTask3ReadTable({ allowExtraInputsMutation: true, injectUnexpectedInputMutation: true }),
    (err) => err.code === 'T3_READ_ONLY_VIOLATION',
  );
});


test('C2 without marks projects no elements on a settled frame', () => {
  const capsule = new HostedWebCapsuleFake({ initialPage: 'form' });
  try {
    const frame = capsule.captureFrame();
    const first = buildC2Describe(capsule, frame);
    assert.ok(first.crops.length > 0);
    const settled = buildC2Describe(capsule, frame);
    assert.equal(Object.hasOwn(settled, 'marks'), false);
    assert.equal(Object.hasOwn(settled, 'marks_png'), false);
    assert.equal(settled.crops.length, 0);
    assert.equal(projectElementTable(frame, settled).elements.length, 0);
    const marked = buildC2Describe(capsule, frame, { marks_out: '/dev/shm/vqa-cu/asm-web-marks.png' });
    assert.equal(marked.crops.length, 0);
    assert.ok(marked.marks.length > 0);
    assert.ok(projectElementTable(frame, marked).elements.length > 0);
  } finally {
    capsule.cleanup();
  }
});
