import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { workflowPrompt } from '../src/terminal/workflowPrompts.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sources = [
  ['tools/mw_run_browser_goal.md', s => s],
  ['tools/mw_run_program.md', s => s.split('The normal app creation hook')[0]],
  ['docs/AI_OPERATOR_GUIDE.md', s => s.split('### E. Browser Goal Runs')[1].split('\n---\n')[0]],
];

test('V027 documented goal commands pass the public CLI without connecting or requiring Muse', () => {
  const blocks = sources.flatMap(([path, select]) => {
    const source = select(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
    return [...source.matchAll(/```sh\n([\s\S]*?)```/g)].map(match => match[1]);
  });
  blocks.push(readFileSync(new URL('../../docs/AGENT_ENTRY.md',import.meta.url),'utf8').split('## Direct task')[1].split('## Run automation')[0].split('\n').find(line => line.startsWith('PYTHONPATH=agents python3')));
  assert.equal(blocks.length, 9, 'all goal command examples and the Terminal command are covered');
  for (const block of blocks) {
    const syntax = spawnSync('bash', ['-n'], { input: block, encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
  const python = String.raw`
import contextlib, io, json, shlex
from metaviewer_agents.mw_run import main
blocks = json.loads(input())
for block in blocks:
    command = block[block.index('PYTHONPATH=agents python3'):].replace('\\\n', ' ')
    if '\n)' in command:
        command = command.split('\n)')[0]
    argv = shlex.split(command)[4:]
    calls = []
    def runner(args):
        calls.append(args)
        return 0
    assert main(argv, runner=runner) == 0
    assert len(calls) == 1 and calls[0].planner == 'rules'
    assert calls[0].goal and not calls[0].site and not calls[0].workflow
    assert calls[0].surface_kind in ('browser', 'program')
    # Navigation is explicit rules-only input; other documented goals retain Muse opt-in.
    muse = argv.copy()
    muse[muse.index('rules')] = 'muse'
    if calls[0].goal == 'focused-key':
        assert calls[0].key == 'Right' and calls[0].steps == 1 and calls[0].text is None
        with contextlib.redirect_stderr(io.StringIO()):
            try:
                main(muse + ['--model-timeout-ms', '60000'], runner=runner)
            except SystemExit as error:
                assert error.code == 2
            else:
                raise AssertionError('model navigation accepted')
        assert len(calls) == 1
    else:
        assert main(muse + ['--model-timeout-ms', '60000'], runner=runner) == 0
    # Invalid mixed stored/goal mode must fail before the injected runner.
    before = len(calls)
    with contextlib.redirect_stderr(io.StringIO()):
        try:
            main(argv + ['--site', 'foreign'], runner=runner)
        except SystemExit as error:
            assert error.code == 2
        else:
            raise AssertionError('mixed goal/workflow command accepted')
    assert len(calls) == before
# Keys outside the explicit Host navigation goal still refuse before dispatch.
for extra in (['--key', 'Enter'], ['--text', 'value', '--key', 'Enter']):
    with contextlib.redirect_stderr(io.StringIO()):
        try:
            main(['--surface-kind', 'program', '--identity', 'fixture', '--goal', 'Square'] + extra,
                 runner=lambda _: (_ for _ in ()).throw(AssertionError('input dispatched')))
        except SystemExit as error:
            assert error.code == 2
        else:
            raise AssertionError('program key accepted')
`;
  const result = spawnSync('python3', ['-c', python], {
    cwd: root, env: { ...process.env, PYTHONPATH: 'agents', PYTHONDONTWRITEBYTECODE: '1' },
    input: JSON.stringify(blocks), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('V027 earlier automation examples use the shipped authoring and stored-workflow parsers', () => {
  const guide = readFileSync(new URL('../../docs/AI_OPERATOR_GUIDE.md', import.meta.url), 'utf8')
    .split('## 12. Automation with')[1].split('### E. Browser Goal Runs')[0];
  const blocks = [...guide.matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1]);
  const python = String.raw`
import argparse, json, runpy, shlex, sys
from unittest.mock import patch
sys.path.insert(0, 'tools')
class Parsed(BaseException):
    pass
original = argparse.ArgumentParser.parse_args
parsed = []
def stop_at_parser(parser, argv=None, namespace=None):
    parsed.append(original(parser, argv, namespace))
    raise Parsed()
for block in json.loads(input()):
    tokens = shlex.split(block.replace('\\\n', ' '))
    tokens = tokens[tokens.index('python3') + 1:]
    if tokens[:2] == ['-m', 'metaviewer_agents.mw_run']:
        from metaviewer_agents.mw_run import main
        calls = []
        assert main(tokens[2:], runner=lambda args: calls.append(args) or 0) == 0
        assert len(calls) == 1 and calls[0].site == 'example-site'
        assert calls[0].goal is None and calls[0].slot == []
    else:
        main = runpy.run_path(tokens[0])['main']
        before = len(parsed)
        with patch.object(argparse.ArgumentParser, 'parse_args', stop_at_parser):
            try:
                main(tokens[1:])
            except Parsed:
                pass
            else:
                raise AssertionError('parser was not intercepted; possible real execution')
        assert len(parsed) == before + 1
assert len(parsed) == 5
`;
  assert.equal(blocks.length, 5);
  const result = spawnSync('python3', ['-c', python], {
    cwd: root, env: { ...process.env, PYTHONPATH: 'agents', PYTHONDONTWRITEBYTECODE: '1' },
    input: JSON.stringify(blocks.flatMap(block => block.trim().split(/\n(?=python3 )/))), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
