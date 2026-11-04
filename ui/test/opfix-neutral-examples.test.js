import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validDomains} from '../src/identities/identityForm.js';

const AI_SITE = /perplexity|pplx|meta\.ai|meta-ai|chatgpt|gemini/i;

test('identity examples name reserved example sites and remain valid domains',()=>{
 const source=readFileSync(new URL('../src/identities/IdentitiesDialog.vue',import.meta.url),'utf8');
 assert.match(source,/placeholder="example\.com, example\.org"/);
 assert.match(source,/for example example\.com\./);
 assert.doesNotMatch(source,AI_SITE);
 assert.ok(validDomains(['example.com','example.org']));
});
test('automation examples use neutral names admitted by the site and demo grammars',()=>{
 const source=readFileSync(new URL('../src/demo/DemoDialog.vue',import.meta.url),'utf8');
 assert.match(source,/placeholder="sample-ask-1"/);
 assert.match(source,/placeholder="sample-chat"/);
 assert.doesNotMatch(source,AI_SITE);
 for(const example of ['sample-chat','sample-ask-1'])assert.match(example,/^[a-z0-9][a-z0-9-]*$/);
});
