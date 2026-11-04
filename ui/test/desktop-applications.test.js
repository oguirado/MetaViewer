import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { desktopEntry, desktopApplications } from '../electron/desktopApplications.js';
const entry = extra => '\n[Desktop Entry]\nType=Application\nName=Text Editor\nExec=gedit %U\n'+extra;
test('desktop entries admit binary-only launchers and file placeholders, never dropped arguments',()=>{
  assert.equal(desktopEntry(entry('')).binary,'gedit');
  assert.equal(desktopEntry('\n[Desktop Entry]\nType=Application\nName=Editor\nExec="/opt/my editor" %f').binary,'/opt/my editor');
  for(const extra of ['Hidden=true','NoDisplay=true','Terminal=true','Terminal=TRUE','Terminal=1']) assert.equal(desktopEntry(entry(extra)),null);
  for(const exec of ['env X=1 gedit','sh -c gedit','%f','"broken','gedit --new-window %U','flatpak run org.gimp.GIMP','snap run editor','gedit %i','gedit %%']) assert.equal(desktopEntry(entry('').replace('gedit %U',exec)),null);
  assert.equal(desktopEntry(entry('')).icon,'');
});
test('host inventory masks hidden system entries, resolves availability, and remembers only own successful launches',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mv-apps-'));
  try {
    const user=join(root,'user'),system=join(root,'system'),state=join(root,'state');
    await Promise.all([mkdir(user),mkdir(system)]);
    await writeFile(join(user,'masked.desktop'),entry('Hidden=true'));
    await writeFile(join(system,'masked.desktop'),entry(''));
    await writeFile(join(system,'editor.desktop'),entry(''));
    await writeFile(join(system,'missing.desktop'),entry('TryExec=missing'));
    await symlink(join(system,'editor.desktop'),join(system,'linked.desktop'));
    const catalog=desktopApplications({stateDir:state,directories:[user,system],resolve:binary=>{if(binary==='missing')throw Error('missing');return {path:'/usr/bin/'+binary,name:binary};}});
    let list=await catalog.list();assert.equal(list.apps.length,1);assert.equal(list.apps[0].name,'Text Editor');assert.deepEqual(list.recent,[]);
    await catalog.launched('/usr/bin/not-installed');assert.deepEqual((await catalog.list()).recent,[]);
    await catalog.launched('/usr/bin/gedit');list=await catalog.list();assert.deepEqual(list.recent,[list.apps[0].id]);
    await catalog.launched('/usr/bin/gedit');assert.equal((await catalog.list()).recent.length,1);
    assert.deepEqual(JSON.parse(await readFile(join(state,'recent-apps.json'),'utf8')),list.recent);
    await writeFile(join(state,'recent-apps.json'),'not json');assert.deepEqual((await catalog.list()).recent,[]);
  } finally {await rm(root,{recursive:true,force:true});}
});
test('local SVG icons allow internal paint references and refuse external resources',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mv-icons-'));
 try{
  const apps=join(root,'applications'),icons=join(root,'icons','test-theme','scalable','apps');
  await mkdir(apps,{recursive:true});await mkdir(icons,{recursive:true});
  await writeFile(join(apps,'editor.desktop'),entry('Icon=editor'));
  await writeFile(join(icons,'editor.svg'),'<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><path fill="url(#g)"/></svg>');
  const make=()=>desktopApplications({env:{XDG_DATA_HOME:root},stateDir:join(root,'state'),directories:[apps],resolve:binary=>({path:'/usr/bin/'+binary,name:binary}),nativeImage:{createFromBuffer:()=>({isEmpty:()=>true})}});
  assert.match((await make().list()).apps[0].icon,/^data:image\/svg\+xml;base64,/);
  await writeFile(join(icons,'editor.svg'),'<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/private.png"/></svg>');
  assert.equal((await make().list()).apps[0].icon,'');
  await writeFile(join(icons,'editor.svg'),'<svg xmlns="http://www.w3.org/2000/svg" onload="bad()"/>');
  assert.equal((await make().list()).apps[0].icon,'');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('desktop names use the bounded display-label rules and reject C1 and bidi controls',()=>{
 for(const name of ['Bad\u0085name','Bad\u009bname','Bad\u202ename','Bad\u2066name','Bad\u007fname','x'.repeat(81)]) assert.equal(desktopEntry(entry('').replace('Name=Text Editor','Name='+name)),null);
 assert.equal(desktopEntry(entry('').replace('Name=Text Editor','Name=Éditeur 文書')).name,'Éditeur 文書');
});
