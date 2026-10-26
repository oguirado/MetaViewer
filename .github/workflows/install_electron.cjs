// [TARGET, unit decision] CI installs only the admitted Electron package;
// the package installer verifies downloads against its bundled checksums.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PIN = '44.9.2';

function validatePins(ui) {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(ui, name), 'utf8'));
  assert.equal(read('package.json').dependencies.electron, PIN);
  const locked = read('package-lock.json').packages['node_modules/electron'];
  assert.equal(locked.version, PIN);
  assert.ok(locked.integrity, 'Electron package integrity is required');
  assert.equal(read('node_modules/electron/package.json').version, PIN);
  const checksums = read('node_modules/electron/checksums.json');
  const archive = `electron-v${PIN}-linux-${process.arch}.zip`;
  assert.match(checksums[archive] || '', /^[a-f0-9]{64}$/, 'pinned archive checksum absent');
}

function install(ui, exec = execFileSync) {
  validatePins(ui);
  const env = { ...process.env };
  // Prevent remote checksum or alternate-dist overrides from bypassing the
  // locked package's checksum set and expected install location.
  for (const key of Object.keys(env)) {
    if (/^(electron_|npm_config_(electron_|platform$|arch$))/i.test(key)) delete env[key];
  }
  exec(process.execPath, [path.join(ui, 'node_modules/electron/install.js')], {
    env, stdio: 'inherit', timeout: 240000,
  });
  const binary = path.join(ui, 'node_modules/electron/dist/electron');
  fs.accessSync(binary, fs.constants.X_OK);
  const version = exec('xvfb-run', ['-a', binary, '--no-sandbox', '--version'], {
    env, encoding: 'utf8', timeout: 30000,
  }).trim();
  assert.equal(version, `v${PIN}`, 'installed Electron version differs');
  console.log(`Verified Electron ${version} (${process.arch})`);
}

if (require.main === module) install(path.resolve(__dirname, '../../ui'));
module.exports = { install, validatePins };
