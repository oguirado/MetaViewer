import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, stat, readFile, writeFile, readdir, chmod, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSettingsStore, WIRE_MAX_BYTES} from '../ui/electron/authorityWire.js';
import {encodeMvSettings, decodeMvSettings} from '../ui/src/settings/settingsModel.js';
import {createPreloadFacade} from '../ui/electron/preload.js';

async function fixture(t, fallback=false) {
  const root=await mkdtemp(join(tmpdir(),'mv-settings-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root, dir:join(root,fallback?'.config/metaviewer':'metaviewer'),
    store:createSettingsStore(fallback?{HOME:root}:{XDG_CONFIG_HOME:root})};
}

test('XDG and HOME fallback are private, atomic and preserve exact renderer payloads',async t=>{
  for(const fallback of [false,true]) {
    const {store,dir}=await fixture(t,fallback),path=join(dir,'settings.json');
    assert.equal(await store.load(),null);
    for(const scheme of ['mv-light','mv-dark']) {
      const json=encodeMvSettings({scheme,density:'compact'});
      assert.equal(await store.save(json),true);
      assert.equal(await store.load(),json);
    }
    const first=await stat(path);
    assert.equal(first.mode&0o777,0o600);
    assert.equal((await stat(dir)).mode&0o777,0o700);
    const legacy='{"scheme":"mv-dark","density":"compact"}';
    await store.save(legacy);
    assert.notEqual((await stat(path)).ino,first.ino);
    assert.equal(await store.load(),legacy);
    assert.deepEqual(await readdir(dir),['settings.json']);

  }
});

test('closed schema and byte cap reject input without replacing the previous file',async t=>{
  const {store,dir}=await fixture(t);
  const valid=encodeMvSettings({scheme:'mv-light',density:'compact'});await store.save(valid);
  for(const value of ['{broken','[]','null','{"unknown":true}','{"theme":"next"}',
    '{"theme":null}','{"scheme":"dark"}','{"density":"regular"}','{"schema":"other"}',
    '{"theme":"light","scheme":"mv-dark"}',
    '{"providers":[{"id":"x","label":"X","enabled":true,"model":"m","unknown":0}]}',
    '{"providers":{}}','{"limits":{"max_fps":30}}',
    '{"limits":{"memory_bytes":1,"max_fps":121,"ring_bytes":1}}',
    '{"recording_destination":{"path":"relative"}}',
    '{"recording_destination":{"path":"/tmp/a","extra":0}}',
    '{"recording_destination":{"path":"/tmp/a","capability_id":""}}',
    JSON.stringify({theme:'é'.repeat(WIRE_MAX_BYTES)})]) {
    await assert.rejects(store.save(value));
    assert.equal(await readFile(join(dir,'settings.json'),'utf8'),valid);
    assert.deepEqual(await readdir(dir),['settings.json']);
  }
});

test('corrupt, unknown and oversized files log a safe reason and resolve renderer defaults',async t=>{
  const {store,dir}=await fixture(t);await store.save('{}');
  const warnings=[],original=console.warn;
  console.warn=(message)=>warnings.push(message);
  try {
    for(const value of ['{secret-corruption','{"unknown":"secret"}','{"theme":"next"}',' '.repeat(WIRE_MAX_BYTES+1)]) {
      await writeFile(join(dir,'settings.json'),value,{mode:0o600});
      assert.equal(await store.load(),null);
    }
  } finally {console.warn=original;}
  assert.equal(warnings.length,4);
  for(const reason of warnings) {assert.match(reason,/using defaults/);assert.doesNotMatch(reason,/secret/);}
});

test('repo and symlink aliases refuse before any settings write; unsafe permissions refuse',async t=>{
  const {root,store,dir}=await fixture(t);
  const repo=fileURLToPath(new URL('..',import.meta.url));
  const before=await readdir(join(repo,'ui'));
  assert.throws(()=>createSettingsStore({XDG_CONFIG_HOME:repo}),/SETTINGS_IN_REPO/);
  assert.throws(()=>createSettingsStore({XDG_CONFIG_HOME:'.'}),/CONFIG_PATH/);
  await symlink(repo,join(root,'metaviewer'));
  await assert.rejects(store.save('{}'),/SETTINGS_IN_REPO/);
  await rm(dir);
  // A parent alias must also be caught by realpath, not only the final directory.
  await symlink(repo,join(root,'alias'));
  const alias=createSettingsStore({XDG_CONFIG_HOME:join(root,'alias','ui')});
  // Use a pre-existing source directory to avoid mkdir touching the repository.
  // The store checks canonical base containment before mkdir (negative control).
  await assert.rejects(alias.save('{}'),/SETTINGS_IN_REPO/);
  assert.deepEqual(await readdir(join(repo,'ui')),before);
  await store.save('{}');await chmod(join(dir,'settings.json'),0o644);
  await assert.rejects(store.load(),/SETTINGS_FILE/);
  await chmod(join(dir,'settings.json'),0o600);await chmod(dir,0o755);
  await assert.rejects(store.save('{}'),/SETTINGS_DIRECTORY/);
});

test('preload settings facade reaches the validated host store',async t=>{
  const {store}=await fixture(t),calls=[];
  const api=createPreloadFacade({transport:{invoke:async(channel,args)=>{
    calls.push(channel);
    if(channel==='metaviewer:settings.load') return store.load();
    if(channel==='metaviewer:settings.save') return store.save(args[0]);
    throw new Error('unexpected channel');
  }},bridge:{exposeInMainWorld(){}}});
  const payload=encodeMvSettings({scheme:'mv-dark',density:'compact'});
  await api.saveSettings(payload);
  assert.equal(await api.loadSettings(),payload);
  assert.deepEqual(decodeMvSettings(await store.load()),{ok:true,settings:{scheme:'mv-dark',density:'compact'}});
  await assert.rejects(api.saveSettings('{"theme":"next"}'),/SETTINGS_UNKNOWN_KEY/);
  assert.deepEqual(calls,['metaviewer:settings.save','metaviewer:settings.load','metaviewer:settings.save']);
});

test('missing keys default exactly as renderer decode; explicit invalid values refuse',async t=>{
  const {store}=await fixture(t);
  for(const value of [{},{scheme:'mv-dark'},{density:'compact'}]) {
    const text=JSON.stringify(value);
    await store.save(text);
    assert.deepEqual(decodeMvSettings(await store.load()),decodeMvSettings(text));
  }
  for(const value of [{scheme:'next'},{scheme:null},{density:null},{density:'regular'}]) {
    const text=JSON.stringify(value);
    assert.equal(decodeMvSettings(text).ok,false);
    await assert.rejects(store.save(text),/SETTINGS_SCHEME|SETTINGS_DENSITY/);
  }
});
