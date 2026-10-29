"""Default-gate regression for the display-only startup defect found by U20.

Mutation: change nesting.js's `['metaviewer:nested.depth', 1]` to depth zero;
the admitted metadata assertion fails. Foreign senders/extra args are negative
controls for every read, and all action channels must refuse explicitly.
"""
import os
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class NestedBootstrapTests(unittest.TestCase):
    def test_read_only_bootstrap_is_complete_and_every_action_or_foreign_sender_refuses(self):
        node = shutil.which(os.environ.get("NODE", "node"))
        self.assertIsNotNone(node, "E2E_PREREQ: Node absent")
        script = r"""
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {installReadOnlyLayout}=await import(pathToFileURL(process.argv[1]));
const handlers=new Map();
const frame={origin:'app://metaviewer',url:'app://metaviewer/index.html'};
const contents={id:1,mainFrame:frame,isDestroyed:()=>false};
const event={sender:contents,senderFrame:frame};
installReadOnlyLayout({handle:(name,handler)=>{
  assert.equal(handlers.has(name),false);handlers.set(name,handler);
}},contents);
const reads={'metaviewer:layout.load':null,'metaviewer:nested.depth':1,
  'metaviewer:nested.self':null,'metaviewer:recording.destination':null,
  'metaviewer:settings.load':null};
const writes=['metaviewer:layout.save','metaviewer:settings.save',
  'metaviewer:authority.propose','metaviewer:authority.intent',
  'metaviewer:authority.subscribe','metaviewer:authority.unsubscribe',
  'metaviewer:side-terminal.open','metaviewer:side-terminal.enabled',
  'metaviewer:side-terminal.attach','metaviewer:side-terminal.resize',
  'metaviewer:side-terminal.close','metaviewer:side-terminal.providers',
  'metaviewer:side-terminal.copy'];
assert.deepEqual([...handlers.keys()].sort(),[...Object.keys(reads),...writes].sort());
for(const [channel,expected] of Object.entries(reads)) {
  const read=handlers.get(channel);
  assert.equal(read(event),expected);
  assert.throws(()=>read(event,'extra'),/DISPLAY_ONLY/);
  assert.throws(()=>read({sender:{},senderFrame:frame}),/DISPLAY_ONLY/);
  assert.throws(()=>read({sender:contents,senderFrame:{...frame}}),/DISPLAY_ONLY/);
}
for(const channel of writes) assert.throws(()=>handlers.get(channel)(event,'{}'),/DISPLAY_ONLY/);
"""
        result = subprocess.run([node, "--input-type=module", "-e", script,
                                 str(ROOT / "ui/electron/nesting.js")],
                                cwd=ROOT, text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
