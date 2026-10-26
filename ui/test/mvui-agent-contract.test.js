// Lane U5 static contract: strict CSP, zero-DOM host, renderer-only
// imports, and no visible text in the lane surface.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCES = [
  '../src/agent/agentLane.js',
  '../src/agent/AgentLaneHost.vue',
  '../src/fixtures/states.js',
  '../src/fixtures/resolveState.js',
  '../src/fixtures/fixtureRuntime.js',
];

/** @param {string} rel */
const readSource = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const CSP_PATTERNS = [
  { name: 'static style attribute', re: /style\s*=/ },
  { name: 'vue style binding', re: /:style\b|v-bind:style/ },
  { name: 'setAttribute style', re: /setAttribute\(\s*['"]style['"]/ },
  { name: 'element style write', re: /\.style\.[A-Za-z]+\s*=/ },
  { name: 'v-show directive', re: /v-show\b/ },
];

/** @param {string} source */
function scanCspViolations(source) {
  return CSP_PATTERNS.filter((pattern) => pattern.re.test(source)).map((pattern) => pattern.name);
}

const HOST_PATTERNS = [
  { name: 'electron import', re: /\belectron\b/ },
  { name: 'node import', re: /from\s+['"]node:/ },
  { name: 'require call', re: /require\s*\(/ },
  { name: 'process env', re: /process\.env/ },
  { name: 'window member', re: /window\./ },
  { name: 'storage access', re: /localStorage|sessionStorage/ },
];

/** @param {string} source */
function scanHostViolations(source) {
  return HOST_PATTERNS.filter((pattern) => pattern.re.test(source)).map((pattern) => pattern.name);
}

describe('strict CSP scan', () => {
  test('every lane surface file is free of style writes', () => {
    for (const rel of SOURCES) {
      assert.deepEqual(scanCspViolations(readSource(rel)), [], rel);
    }
  });

  test('the scanner flags each planted violation', () => {
    const planted = [
      ['<div style="color:red">x</div>', 'static style attribute'],
      ['<div :style="{ color: c }">x</div>', 'vue style binding'],
      ["node.setAttribute('style', 'color:red')", 'setAttribute style'],
      ['node.style.display = \'none\'', 'element style write'],
      ['<div v-show="open">x</div>', 'v-show directive'],
    ];
    for (const [snippet, expected] of planted) {
      assert.ok(scanCspViolations(snippet).includes(expected), snippet);
    }
  });
});

describe('renderer-only imports', () => {
  test('lane sources never touch host or Node APIs', () => {
    for (const rel of SOURCES) {
      assert.deepEqual(scanHostViolations(readSource(rel)), [], rel);
    }
  });

  test('the scanner flags each planted host access', () => {
    const planted = [
      ["import x from 'electron'", 'electron import'],
      ["import { readFileSync } from 'node:fs'", 'node import'],
      ['const x = require("vue")', 'require call'],
      ['process.env.TOKEN', 'process env'],
      ['window.location.href', 'window member'],
      ['localStorage.getItem("k")', 'storage access'],
    ];
    for (const [snippet, expected] of planted) {
      assert.ok(scanHostViolations(snippet).includes(expected), snippet);
    }
  });
});

describe('AgentLaneHost zero-DOM contract', () => {
  const sfc = () => readSource('../src/agent/AgentLaneHost.vue');
  const templateOf = (/** @type {string} */ source) => {
    const match = source.match(/<template>([\s\S]*)<\/template>/);
    assert.ok(match, 'SFC keeps a template block');
    return match[1];
  };
  const visibleTextOf = (/** @type {string} */ template) =>
    template
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, '')
      .trim();

  test('the host template renders no visible text and no controls', () => {
    const template = templateOf(sfc());
    assert.equal(visibleTextOf(template), '');
    assert.doesNotMatch(template, /<(button|input|select|textarea|a)(\s|>)/i);
    assert.doesNotMatch(sfc(), /<style[\s>]/);
  });

  test('the template checks fail on planted content', () => {
    assert.notEqual(visibleTextOf('<span>hello</span>'), '');
    assert.match('<button id="x">go</button>', /<(button|input|select|textarea|a)(\s|>)/i);
    assert.match('<style>.a{}</style>', /<style[\s>]/);
  });

  test('the host mounts and unmounts the lane without visuals', () => {
    const source = sfc();
    assert.match(source, /onMounted\(apply\)/);
    assert.match(source, /onBeforeUnmount\(/);
    assert.match(source, /installAgentLane\(globalThis/);
  });
});
