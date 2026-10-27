import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';
import { declarationsFor } from './mvui8-css-rules.js';

const source = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
const { descriptor } = parse(source);
const elements = node => [node, ...(node.children ?? []).flatMap(elements)];
const prop = (node, name) => node.props?.find(p => p.type === 6 && p.name === name)?.value?.content;
const tree = elements(descriptor.template.ast);
const shell = tree.find(n => prop(n, 'class') === 'metaviewer mv-shell');
const notice = tree.find(n => prop(n, 'class') === 'mv-layout-notice');
const body = tree.find(n => prop(n, 'class') === 'mv-shell-body');
const wall = tree.find(n => prop(n, 'id') === 'shell-wall');
const alert = tree.find(n => prop(n, 'id') === 'mv-layout-unavailable');
const rule = selector => declarationsFor(descriptor.styles.map(s => s.content).join('\n'), selector);

test('notice occupies a separate flow row outside the wall and all dock tabs at every viewport, including 1280x720 and 1920x1080', () => {
  assert.ok(notice && body && wall && alert);
  assert.ok(shell.children.includes(notice));
  assert.ok(shell.children.includes(body));
  assert.ok(shell.children.indexOf(notice) < shell.children.indexOf(body));
  assert.ok(elements(notice).includes(alert));
  assert.ok(elements(body).includes(wall));
  assert.ok(!elements(wall).includes(alert), 'negative contrast: the original wall overlay is rejected');
  assert.match(rule('.mv-shell'), /grid-template-rows:var\(--cuk-component-app-shell-topbar-height\) auto minmax\(0,1fr\)/);
  assert.match(rule('.mv-layout-notice'), /display:grid/);
  assert.match(rule('.mv-layout-unavailable'), /grid-area:1 \/ 1/);
  assert.doesNotMatch(rule('.mv-layout-unavailable'), /position:|z-index:|transform:/);
});

test('longest outcome reserves space before any failure and while panels open', () => {
  const reserve = elements(notice).find(n => prop(n, 'class') === 'mv-layout-notice-reserve');
  assert.equal(prop(reserve, 'aria-hidden'), 'true');
  assert.equal(reserve.props.some(p => p.type === 7), false, 'reserve must not depend on outcome or panel state');
  assert.match(rule('.mv-layout-notice-reserve'), /visibility:hidden/);
  assert.match(rule('.mv-layout-notice-reserve'), /grid-area:1 \/ 1/);
  assert.match(rule('.mv-layout-unavailable'), /grid-area:1 \/ 1/);
  const content = n => [n.type === 2 ? n.content : '', ...(n.children ?? []).map(content)].join(' ');
  assert.match(content(reserve).replace(/\s+/g, ' '), /Layout unavailable\. The default layout is shown read-only\. Changes will not be saved\./);
  assert.equal(prop(alert, 'role'), 'alert');
  assert.equal(prop(alert, 'data-semantic-anchor'), 'layout/unavailable');
});


test('normal and nested bodies explicitly occupy their flexible track', () => {
  assert.match(rule('.mv-shell-body'), /grid-row:3(?:;|$)/);
  assert.match(rule('.mv-layout-notice'), /grid-row:2(?:;|$)/);
  assert.match(rule('.mv-shell--nested'), /grid-template-rows:minmax\(0,1fr\)/);
  assert.match(rule('.mv-shell--nested > .mv-shell-body'), /grid-row:1(?:;|$)/);
});

test('stylesheet assertions accept either selector order and separate rules, but reject suffix matches', () => {
  for (const css of [
    '.mv-layout-notice-reserve, .mv-layout-unavailable { grid-area:1 / 1; }',
    '.mv-layout-unavailable, .mv-layout-notice-reserve { grid-area:1 / 1; }',
    '.mv-layout-unavailable { grid-area:1 / 1; } .mv-layout-notice-reserve { grid-area:1 / 1; }',
  ]) {
    for (const selector of ['.mv-layout-unavailable', '.mv-layout-notice-reserve']) {
      assert.match(declarationsFor(css, selector), /grid-area:1 \/ 1/);
    }
  }
  assert.equal(declarationsFor('.other.mv-layout-unavailable { grid-area:1 / 1; }', '.mv-layout-unavailable'), '');
  assert.match(declarationsFor('.mv-layout-unavailable { grid-area:1 / 1; } .mv-layout-unavailable { position:absolute; }', '.mv-layout-unavailable'), /position:absolute/);
});
