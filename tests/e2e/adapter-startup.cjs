'use strict';

const { E2EError } = require('./harness.js');

// [TARGET, unit decision] A refused adapter never connects. Keep that refusal
// observable and bounded while preserving the lifecycle fixture's IPC checks.
async function waitForAdapterConnection(connected, adapter, diagnostics, timeoutMs = 5000) {
  let timer;
  let onExit;
  let onError;
  const stopped = new Promise((resolve, reject) => {
    onExit = (code, signal) => reject(new E2EError('E2E_STARTUP',
      `adapter exited before core connection (code=${code}, signal=${signal}, stderr=${diagnostics()})`));
    onError = (error) => reject(new E2EError('E2E_STARTUP', `adapter spawn failed: ${error.message}`));
    adapter.once('exit', onExit);
    adapter.once('error', onError);
    timer = setTimeout(() => reject(new E2EError('E2E_TIMEOUT',
      `adapter did not connect to core (stderr=${diagnostics()})`)), timeoutMs);
    if (adapter.exitCode !== null || adapter.signalCode !== null) {
      onExit(adapter.exitCode, adapter.signalCode);
    }
  });
  try {
    return await Promise.race([connected, stopped]);
  } finally {
    clearTimeout(timer);
    adapter.removeListener('exit', onExit);
    adapter.removeListener('error', onError);
  }
}

module.exports = { waitForAdapterConnection };
