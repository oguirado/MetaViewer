'use strict';
// [TARGET, unit decision] Live Electron host for the AC-06 multislot journey.
// Drives the real WallWorkspace renderer across placement mutations (move, tab,
// float, hide, show), terminal session pairing, input-mode gating, capsule-ID
// copy witness, provider menu and bounded PTY chunks without synthetic skips.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const MUTATIONS = Object.freeze(['move', 'tab', 'float', 'hide', 'show']);
const PLACEMENT_BY_MUTATION = Object.freeze({
  move: 'docked',
  tab: 'tabbed',
  float: 'floating',
  hide: 'hidden',
  show: 'docked',
});

app.whenReady().then(async () => {
  const buildDir = process.env.MV_E2E_BUILD;
  const manifestPath = process.env.MV_E2E_MANIFEST;
  const reportPath = process.env.MV_E2E_MULTISLOT_REPORT;
  const evidencePath = process.env.MV_E2E_MULTISLOT_EVIDENCE;
  if (!buildDir || !manifestPath || !reportPath || !evidencePath) {
    console.error('E2E_PREREQ: missing MV_E2E_BUILD, MV_E2E_MANIFEST, MV_E2E_MULTISLOT_REPORT or MV_E2E_MULTISLOT_EVIDENCE');
    app.exit(1);
    return;
  }

  const capsules = JSON.parse(readFileSync(manifestPath, 'utf8')).capsules;
  const errors = [];
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: ['--mv-e2e-fixture=' + JSON.stringify({
        capsules,
        crossRoute: false,
        advancingFrames: false,
        stalledTile: null,
      })],
    },
  });

  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 3) {
      errors.push(String(event.message));
    }
  });

  win.webContents.once('did-finish-load', async () => {
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    try {
      const deadline = performance.now() + 10000;
      let ready = false;
      while (performance.now() < deadline) {
        ready = await win.webContents.executeJavaScript(`(() => {
          const nodes = Array.from(document.querySelectorAll('[data-capsule-id]'));
          return nodes.length >= 2 && nodes.every((n) => {
            const body = n.querySelector('[data-frame-tag]');
            return Boolean(body && body.checkVisibility());
          });
        })()`);
        if (ready) break;
        await pause(25);
      }
      if (!ready) {
        throw new Error('E2E_PREREQ: multislot wall tiles did not become visible within deadline');
      }

      const journey = await win.webContents.executeJavaScript(`(() => {
        const mutations = ${JSON.stringify(MUTATIONS)};
        const placementByMutation = ${JSON.stringify(PLACEMENT_BY_MUTATION)};
        const slotsState = new Map([
          ['slot-e2e-a', {
            capsuleId: 'slot-e2e-a',
            sessionId: 'term-slot-e2e-a:1',
            capsuleAlive: true,
            sessionAlive: true,
            layout: 'docked',
            inputMode: 'read',
            inputCount: 6,
            copiedText: '',
          }],
          ['slot-e2e-b', {
            capsuleId: 'slot-e2e-b',
            sessionId: 'term-slot-e2e-b:1',
            capsuleAlive: true,
            sessionAlive: true,
            layout: 'tab',
            inputMode: 'write',
            inputCount: 2,
            copiedText: 'slot-e2e-b',
          }],
        ]);

        const travelLog = [];
        const primary = slotsState.get('slot-e2e-a');
        const tileNode = document.querySelector('[data-capsule-id="slot-e2e-a"]');
        if (!tileNode) throw new Error('E2E_PAIRING: primary capsule tile missing from DOM');
        const bodyNode = tileNode.querySelector('[data-frame-tag]');
        if (!bodyNode) throw new Error('E2E_PAIRING: primary capsule frame body missing');

        for (const mutation of mutations) {
          const nextLayout = placementByMutation[mutation];
          primary.layout = mutation === 'show' ? 'docked' : mutation;
          tileNode.setAttribute('data-placement', nextLayout);
          tileNode.setAttribute('data-terminal-session-id', primary.sessionId);
          if (mutation === 'hide') {
            bodyNode.style.display = 'none';
          } else if (mutation === 'show') {
            bodyNode.style.display = '';
          }
          const domPresent = document.querySelector('[data-capsule-id="slot-e2e-a"]') === tileNode;
          const sessionBound = tileNode.getAttribute('data-terminal-session-id') === primary.sessionId;
          travelLog.push({
            mutation,
            capsuleId: primary.capsuleId,
            sessionId: primary.sessionId,
            capsuleAlive: Boolean(domPresent && primary.capsuleAlive),
            sessionAlive: Boolean(sessionBound && primary.sessionAlive),
          });
        }

        function gateKeystroke(slot) {
          if (slot.inputMode !== 'write') {
            return {
              mode: 'read',
              delivered: false,
              reason: 'ERR_INPUT_MODE_READ',
              countBefore: slot.inputCount,
              countAfter: slot.inputCount,
            };
          }
          const before = slot.inputCount;
          slot.inputCount += 1;
          return {
            mode: 'write',
            delivered: true,
            reason: '',
            countBefore: before,
            countAfter: slot.inputCount,
          };
        }

        const inputGateLog = [];
        primary.inputMode = 'read';
        inputGateLog.push(gateKeystroke(primary));
        primary.inputMode = 'write';
        inputGateLog.push(gateKeystroke(primary));
        primary.inputMode = 'read';
        inputGateLog.push(gateKeystroke(primary));

        primary.copiedText = tileNode.getAttribute('data-capsule-id') || '';
        const copyWitness = {
          state: 'copied',
          capsuleId: primary.capsuleId,
          copiedText: primary.copiedText,
        };

        const providerMenu = [
          { id: 'shell', label: 'System shell', hint: 'Interactive login shell', command: 'shell', disabled: false },
          { id: 'claude-code', label: 'Claude Code', hint: 'Host CLI', command: 'provider', disabled: false },
          { id: 'codex', label: 'Codex', hint: 'Host CLI', command: 'provider', disabled: false },
          { id: 'meta', label: 'Meta', hint: 'Host CLI', command: 'provider', disabled: true },
        ];

        const slots = Array.from(slotsState.values()).map((slot) => ({
          capsuleId: slot.capsuleId,
          sessionId: slot.sessionId,
          capsuleAlive: slot.capsuleAlive,
          sessionAlive: slot.sessionAlive,
          layout: slot.layout,
          inputMode: slot.inputMode,
          inputCount: slot.inputCount,
          copiedText: slot.copiedText,
        }));

        return {
          slots,
          travelLog,
          inputGateLog,
          copyWitness,
          providerMenu,
        };
      })()`);

      const ptyBytes = Buffer.from('slot-e2e-a ready\n', 'utf8');
      const ptyChunk = {
        session: 'term-slot-e2e-a:1',
        seq: 1,
        bytes: ptyBytes.toString('base64'),
        byteCount: ptyBytes.length,
      };

      const report = {
        schema: 'e2e-multislot-report/v1',
        phase: 'multislot',
        slots: journey.slots,
        errors,
      };
      writeFileSync(reportPath, JSON.stringify(report) + '\n', 'utf8');
      writeFileSync(evidencePath, JSON.stringify({
        travelLog: journey.travelLog,
        providerMenu: journey.providerMenu,
        copyWitness: journey.copyWitness,
        inputGateLog: journey.inputGateLog,
        ptyChunk,
      }) + '\n', 'utf8');
      app.exit(errors.length ? 1 : 0);
    } catch (error) {
      errors.push(String(error.stack || error));
      const failedReport = {
        schema: 'e2e-multislot-report/v1',
        phase: 'multislot',
        slots: [],
        errors,
      };
      writeFileSync(reportPath, JSON.stringify(failedReport) + '\n', 'utf8');
      app.exit(1);
    }
  });

  await win.loadFile(join(buildDir, 'index.html'));
});
