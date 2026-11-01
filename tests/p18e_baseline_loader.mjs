// Prove stale tests fail against the supplied baseline, without altering production files.
import fs from 'node:fs';
import {registerHooks,syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const baseline=new Map(['IdentitiesDialog.vue','identityForm.js'].map(name=>[root+'ui/src/identities/'+name,execFileSync('git',['show','f936e5bac5e31d35fe68af9e0b0e7b723c23a299:ui/src/identities/'+name],{cwd:root,encoding:'utf8'})]));
const original=fs.readFileSync;
fs.readFileSync=function(path,...args){
  const name=path instanceof URL?fileURLToPath(path):String(path);
  return baseline.has(name)?baseline.get(name):original.call(this,path,...args);
};
syncBuiltinESMExports();
registerHooks({load(url,context,next){const result=next(url,context);return url.startsWith('file:')&&baseline.has(fileURLToPath(url))?{...result,source:baseline.get(fileURLToPath(url))}:result;}});
