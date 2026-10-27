'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const { runInNewContext } = require('node:vm');

// Register the real journey without booting Electron. Inject a broken cadence
// so the negative control remains independent of future adapter fixes.
it('ARG-s_ci-3: broken cadence is a mandatory failing soak oracle', () => {
  const filename = join(__dirname, 'ac02_wall.test.js');
  const localRequire = createRequire(filename);
  const registrations = new Map();
  runInNewContext(readFileSync(filename, 'utf8'), {
    __dirname,
    process,
    console,
    require(id) {
      if (id === 'node:test') return {
        describe(_name, body) { body(); },
        it(name, options, body) {
          registrations.set(name, {
            options: typeof options === 'function' ? {} : options,
            body: typeof options === 'function' ? options : body,
          });
        },
      };
      if (id === 'node:fs') return {
        ...localRequire(id),
        readFileSync() { return 'timer.Reset(s.cfg.PollInterval)'; },
      };
      return localRequire(id);
    },
  }, { filename });
  const soak = registrations.get('live folded capture and fps soak reports telemetry');
  assert.ok(soak, 'the live soak must remain registered');
  assert.ok(!soak.options.todo, 'a todo would mask the cadence failure');
  assert.ok(!soak.options.skip, 'the soak must not be skipped');
  assert.throws(soak.body, /GAP-AC02-CADENCE/);
});
