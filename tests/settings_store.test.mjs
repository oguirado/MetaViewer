import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, stat, readFile, writeFile, readdir, chmod, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSettingsStore, validateSettings, WIRE_MAX_BYTES} from '../ui/electron/authorityWire.js';
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
  const payload=encodeMvSettings({scheme:'mv-dark',density:'compact',wallFps:30,recordingFps:3});
  await api.saveSettings(payload);
  assert.equal(await api.loadSettings(),payload);
  const loaded=await store.load();
  assert.deepEqual(decodeMvSettings(loaded),{
    ok:true,
    settings:{scheme:'mv-dark',density:'compact',wallFps:30,recordingFps:3},
  });
  assert.deepEqual(validateSettings(loaded),{
    scheme:'mv-dark',density:'compact',wallFps:30,recordingFps:3,
  });
  await assert.rejects(api.saveSettings('{"theme":"next"}'),/SETTINGS_UNKNOWN_KEY/);
  assert.deepEqual(calls,['metaviewer:settings.save','metaviewer:settings.load','metaviewer:settings.save']);
});

test('missing keys default exactly as renderer decode; explicit invalid values refuse',async t=>{
  const {store}=await fixture(t);
  // Full 4-key parity across schemes, densities, wallFps presets, and recordingFps bounds.
  // Fails if either side drops a key, mutates a value, or diverges in decoded shape.
  for(const full of [
    {scheme:'mv-light',density:'compact',wallFps:30,recordingFps:3},
    {scheme:'mv-dark',density:'comfortable',wallFps:3,recordingFps:1},
    {scheme:'mv-dark',density:'compact',wallFps:60,recordingFps:60},
    {scheme:'mv-light',density:'comfortable',wallFps:60,recordingFps:15},
  ]) {
    const text=encodeMvSettings(full);
    await store.save(text);
    const loaded=await store.load();
    assert.equal(loaded,text);
    const rendererDecoded=decodeMvSettings(loaded);
    const hostDecoded=validateSettings(loaded);
    assert.deepEqual(rendererDecoded,{ok:true,settings:full});
    assert.deepEqual(hostDecoded,full);
    assert.deepEqual(rendererDecoded.settings,hostDecoded);
  }
  // Missing keys and legacy 2-key {scheme, density} objects default identically on both sides:
  // scheme -> 'mv-light', density -> 'compact', wallFps -> 30, recordingFps -> 3.
  // Fails on any mutation of per-field defaults on host or renderer.
  for(const [partial,expected] of [
    [{},{scheme:'mv-light',density:'compact',wallFps:30,recordingFps:3}],
    [{density:'comfortable',wallFps:60,recordingFps:12},{scheme:'mv-light',density:'comfortable',wallFps:60,recordingFps:12}],
    [{scheme:'mv-dark',wallFps:60,recordingFps:12},{scheme:'mv-dark',density:'compact',wallFps:60,recordingFps:12}],
    [{scheme:'mv-dark',density:'comfortable',recordingFps:12},{scheme:'mv-dark',density:'comfortable',wallFps:30,recordingFps:12}],
    [{scheme:'mv-dark',density:'comfortable',wallFps:3},{scheme:'mv-dark',density:'comfortable',wallFps:3,recordingFps:3}],
    [{scheme:'mv-dark'},{scheme:'mv-dark',density:'compact',wallFps:30,recordingFps:3}],
    [{density:'compact'},{scheme:'mv-light',density:'compact',wallFps:30,recordingFps:3}],
    [{density:'comfortable'},{scheme:'mv-light',density:'comfortable',wallFps:30,recordingFps:3}],
    [{wallFps:3},{scheme:'mv-light',density:'compact',wallFps:3,recordingFps:3}],
    [{recordingFps:24},{scheme:'mv-light',density:'compact',wallFps:30,recordingFps:24}],
    [{scheme:'mv-dark',density:'compact'},{scheme:'mv-dark',density:'compact',wallFps:30,recordingFps:3}],
    [{scheme:'mv-light',density:'comfortable'},{scheme:'mv-light',density:'comfortable',wallFps:30,recordingFps:3}],
  ]) {
    const text=JSON.stringify(partial);
    await store.save(text);
    const loaded=await store.load();
    const rendererDecoded=decodeMvSettings(loaded);
    const hostDecoded=validateSettings(loaded);
    assert.deepEqual(rendererDecoded,decodeMvSettings(text));
    assert.deepEqual(rendererDecoded,{ok:true,settings:expected});
    assert.deepEqual(hostDecoded,expected);
  }
  // Unknown keys refuse with SETTINGS_UNKNOWN_KEY on the host and ERR_SETTINGS_UNKNOWN_KEY on the renderer.
  // Fails if either side ignores or admits an unknown property on save/decode.
  for(const value of [
    {unknown:true},
    {theme:'next'},
    {scheme:'mv-light',density:'compact',wallFps:30,recordingFps:3,extra:1},
    {max_fps:30},
  ]) {
    const text=JSON.stringify(value);
    const rendererDecoded=decodeMvSettings(text);
    assert.equal(rendererDecoded.ok,false);
    assert.equal(rendererDecoded.error.code,'ERR_SETTINGS_UNKNOWN_KEY');
    assert.throws(()=>validateSettings(text),{code:'SETTINGS_UNKNOWN_KEY'});
    await assert.rejects(store.save(text),{code:'SETTINGS_UNKNOWN_KEY'});
  }
  // Invalid scheme or density refuses on both sides.
  for(const [value,hostCode,rendererCode] of [
    [{scheme:'next'},'SETTINGS_SCHEME','ERR_SETTINGS_UNKNOWN_SCHEME'],
    [{scheme:null},'SETTINGS_SCHEME','ERR_SETTINGS_UNKNOWN_SCHEME'],
    [{density:null},'SETTINGS_DENSITY','ERR_SETTINGS_UNKNOWN_DENSITY'],
    [{density:'regular'},'SETTINGS_DENSITY','ERR_SETTINGS_UNKNOWN_DENSITY'],
  ]) {
    const text=JSON.stringify(value);
    const rendererDecoded=decodeMvSettings(text);
    assert.equal(rendererDecoded.ok,false);
    assert.equal(rendererDecoded.error.code,rendererCode);
    assert.throws(()=>validateSettings(text),{code:hostCode});
    await assert.rejects(store.save(text),{code:hostCode});
  }
  // wallFps outside {3, 30, 60} refuses on both sides (fails if e.g. host accepts wallFps 45).
  for(const badWallFps of [0,1,2,4,15,29,31,45,61,120,-30,30.5,'30',null,true,{},[]]) {
    const text=JSON.stringify({scheme:'mv-light',density:'compact',wallFps:badWallFps,recordingFps:3});
    const rendererDecoded=decodeMvSettings(text);
    assert.equal(rendererDecoded.ok,false);
    assert.equal(rendererDecoded.error.code,'ERR_SETTINGS_UNKNOWN_WALL_FPS');
    assert.throws(()=>validateSettings(text),{code:'SETTINGS_WALL_FPS'});
    await assert.rejects(store.save(text),{code:'SETTINGS_WALL_FPS'});
  }
  // recordingFps outside integer 1..60 (including 0, 61, 2.5, "3") refuses on both sides
  // (fails if e.g. host or renderer accepts float 2.5, string "3", 0, or 61).
  for(const badRecordingFps of [0,61,2.5,'3',-1,100,null,true,{},[]]) {
    const text=JSON.stringify({scheme:'mv-light',density:'compact',wallFps:30,recordingFps:badRecordingFps});
    const rendererDecoded=decodeMvSettings(text);
    assert.equal(rendererDecoded.ok,false);
    assert.equal(rendererDecoded.error.code,'ERR_SETTINGS_UNKNOWN_RECORDING_FPS');
    assert.throws(()=>validateSettings(text),{code:'SETTINGS_RECORDING_FPS'});
    await assert.rejects(store.save(text),{code:'SETTINGS_RECORDING_FPS'});
  }
});
