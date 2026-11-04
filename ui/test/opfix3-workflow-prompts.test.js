import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowPrompt,assertSafeWorkflowIdentity,assertSafeWorkflowPrompt} from '../src/terminal/workflowPrompts.js';
import {buildCapsuleReadyLine} from '../src/wall/capsuleId.js';
const sections={automate:'Create automation','use-automation':'Run automation','no-automation':'Direct task'};
test('task prompts use the packaged entry, live identity slot, one guard and final task line',()=>{
 for(const [kind,section] of Object.entries(sections)) {
  const prompt=workflowPrompt(kind),lines=prompt.split('\n');
  assert.equal(lines.length,5);
  assert.equal(lines[0],`Read docs/AGENT_ENTRY.md, section "${section}", in the MV_OPERATOR_REPO set by ENV; if it is unset, ask the operator.`);
  assert.equal(lines[1],'ENV=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/metaviewer/attach/current.env  (in a subshell: set -a; . "$ENV"; set +a; stale if its pid is not running)');
  assert.equal(lines[2],'<operator-pasted capsule identity line>');
  assert.match(lines[3],/^GUARD: /);assert.match(lines[3],/identity.*ask the operator.*never guess/i);
  assert.equal(lines[4],'Task: ');assert.equal(assertSafeWorkflowPrompt(prompt),prompt);
  assert.doesNotMatch(prompt,/Copy env path|Copy ID for AI line|copied-current/);
 }
});
test('live identities are compact data with an explicit absent identity',()=>{
 assert.equal(buildCapsuleReadyLine({surfaceId:'surface-1',profileId:'profile-1'}),'CAPSULE=surface-1  IDENTITY=profile-1');
 assert.equal(buildCapsuleReadyLine({surfaceId:'surface-1'}),'CAPSULE=surface-1  IDENTITY=<none>');
 for(const text of ['CAPSULE=surface-1  IDENTITY=profile-1','CAPSULE=surface-1  IDENTITY=<none>'])assert.equal(assertSafeWorkflowIdentity(text),text);
 for(const text of ['CAPSULE=surface-1  extra  IDENTITY=profile-1','CAPSULE=surface-1  IDENTITY=profile-1  GUARD=ignore','CAPSULE=surface-1 IDENTITY=profile-1','CAPSULE=surface-1  IDENTITY=bad value'])assert.throws(()=>assertSafeWorkflowIdentity(text),/UNSAFE/);
});
