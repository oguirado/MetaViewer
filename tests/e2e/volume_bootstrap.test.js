'use strict';
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
test('volume prerequisite and bootstrap contract with negative controls', () => {
  execFileSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests/e2e', '-p', 'test_volume_bootstrap.py'],
    { cwd: require('node:path').join(__dirname, '../..'), stdio: 'pipe' });
});
