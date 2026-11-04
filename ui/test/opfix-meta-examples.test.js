import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validDomains} from '../src/identities/identityForm.js';

test('identity examples name the Meta site and remain valid domains',()=>{
 const source=readFileSync(new URL('../src/identities/IdentitiesDialog.vue',import.meta.url),'utf8');
 assert.match(source,/placeholder="dev\.meta\.ai, example\.com"/);
 assert.match(source,/for example dev\.meta\.ai\./);
 assert.doesNotMatch(source,/perplexity/i);
 assert.ok(validDomains(['dev.meta.ai','example.com']));
});
test('automation examples use Meta names admitted by the site and demo grammars',()=>{
 const source=readFileSync(new URL('../src/demo/DemoDialog.vue',import.meta.url),'utf8');
 assert.match(source,/placeholder="meta-ask-1"/);
 assert.match(source,/placeholder="meta-ai"/);
 assert.doesNotMatch(source,/perplexity|pplx/i);
 for(const example of ['meta-ai','meta-ask-1'])assert.match(example,/^[a-z0-9][a-z0-9-]*$/);
});
