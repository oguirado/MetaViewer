// [TARGET, unit decision] Optional --import preload for the unchanged pull test.
// UV_THREADPOOL_SIZE=1 holds filesystem work while event-loop timers keep running.
import { before, after } from 'node:test';
import { pbkdf2 } from 'node:crypto';
let timer, ticks = 0, maximumGap = 0, last;
before(() => {
  const start = performance.now();
  last = start;
  timer = setInterval(() => {
    const now = performance.now();
    maximumGap = Math.max(maximumGap, now-last);
    last = now;
    ticks++;
  }, 20);
  pbkdf2('display-pull', 'controlled-io-pressure', 3000000, 32, 'sha256', () => {
    console.error(`PRESSURE workerpool_busy_ms=${(performance.now()-start).toFixed(1)} event_loop_ticks=${ticks}`);
  });
});
after(() => {
  clearInterval(timer);
  console.error(`PRESSURE event_loop_ticks_total=${ticks} maximum_tick_gap_ms=${maximumGap.toFixed(1)}`);
});
