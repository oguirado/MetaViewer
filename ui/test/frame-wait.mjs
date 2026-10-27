// MVUI21 lane W: shared wall-clock-bounded async waits for the frame tests.
// `until` polls the condition until a WALL-CLOCK deadline (default 5000 ms),
// yielding with setImmediate plus a short 3 ms timer between polls, so real
// async work (WebCrypto digests, validation) completes on loaded hosts while
// real hangs still fail at the deadline. `tick` keeps the original fast
// quiescence (5 immediates) for synchronous negative controls.

export const FRAME_WAIT_TIMEOUT_MS = 5000;
const POLL_SLEEP_MS = 3;

export const flush = () => new Promise((resolve) => setImmediate(resolve));

export async function tick() {
  for (let i = 0; i < 5; i += 1) await flush();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(condition, label, timeoutMs = FRAME_WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() >= deadline) break;
    await flush();
    if (condition()) return;
    if (Date.now() >= deadline) break;
    await sleep(POLL_SLEEP_MS);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export async function untilAcks(port, count, timeoutMs = FRAME_WAIT_TIMEOUT_MS) {
  await until(() => port.acks.length >= count, `${count} acks`, timeoutMs);
}
