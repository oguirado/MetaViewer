const {app,BrowserWindow,protocol}=require('electron');
const assert=require('node:assert/strict');
const path=require('node:path');
protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true}}]);
const deadline=setTimeout(()=>app.exit(1),90000);
const failures=[];
async function probe(name,fn){try{await fn();console.log('PASS '+name);}catch(error){failures.push(name);console.error('FAIL '+name+': '+error.message);}}
void app.whenReady().then(async()=>{
  const {serveBundled}=await import('../electron/main.js');
  serveBundled(protocol,path.join(__dirname,'../dist/renderer'),{styleNonce:true});
  const win=new BrowserWindow({width:1280,height:720,useContentSize:true,show:false,
    webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  const evaluate=fn=>win.webContents.executeJavaScript(`(${fn.toString()})()`);
  async function load(state){
    await win.loadURL('app://metaviewer/index.html?'+new URLSearchParams({state}));
    for(let i=0;i<200;i++){
      if(await evaluate(()=>document.querySelector('[data-wall-settled="true"]')&&document.querySelector('.mv-tile')))return;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw new Error('Wall did not settle');
  }
  async function measure(){return evaluate(()=>{
    const rgba=s=>{const v=s.match(/[\d.]+/g).map(Number);return s.startsWith('color(srgb')?[...v.slice(0,3).map(c=>c*255),v[3]??1]:[...v.slice(0,3),v[3]??1];};
    const blend=(fg,bg)=>fg.slice(0,3).map((c,i)=>c*fg[3]+bg[i]*(1-fg[3]));
    function background(node){if(!node)return [255,255,255];return blend(rgba(getComputedStyle(node).backgroundColor),background(node.parentElement));}
    const luminance=rgb=>rgb.map(c=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;}).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
    function contrast(node){const css=getComputedStyle(node),bg=background(node);const fg=rgba(css.color);fg[3]*=Number(css.opacity);const x=luminance(blend(fg,bg)),y=luminance(bg);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
    const tiles=[...document.querySelectorAll('.mv-tile')];
    const bounds=[];const colours=[];
    for(const tile of tiles){
      const r=tile.getBoundingClientRect();
      const targets=[...tile.querySelectorAll('.mv-tile-chrome,.mv-tile-chrome button,.mv-tile-chrome__badge,.cuk-capsule-panel__header,.cuk-capsule-panel__header button')];
      for(const n of targets){const b=n.getBoundingClientRect();if(b.width&&b.height&&(b.left<r.left-.5||b.right>r.right+.5||b.top<r.top-.5||b.bottom>r.bottom+.5))bounds.push(n.className);}
      const label=tile.querySelector('.cuk-capsule-panel__title');
      const header=tile.querySelector('.cuk-capsule-panel__header');
      const record=tile.querySelector('.saas-record');
      colours.push({title:contrast(label),record:contrast(record),
        actions:[...tile.querySelectorAll('.cuk-capsule-panel__action-btn:not(:disabled)')].map(n=>({label:n.textContent.trim(),ratio:contrast(n)}))});
    }
    return {scheme:document.documentElement.dataset.themeScheme,tiles:tiles.length,bounds,colours};
  });}
  async function boundsOracle(){const r=await measure();assert.equal(r.tiles,9);assert.deepEqual(r.bounds,[]);}
  async function labelOracle(axis){const r=await measure();assert.equal(r.tiles,9);for(const row of r.colours){
    if(axis==='record')assert.ok(row.record>=4.5,JSON.stringify(row));
    else {assert.ok(row.actions.length>0);for(const action of row.actions)assert.ok(action.ratio>=4.5,JSON.stringify(action));}
  }}
  async function rejectCssMutant(name,css,oracle){
    const key=await win.webContents.insertCSS(css);
    try{await probe(name,async()=>assert.rejects(oracle,{code:'ERR_ASSERTION'}));}
    finally{await win.webContents.removeInsertedCSS(key);}
  }
  try{
    for(const scheme of ['mv-light','mv-dark']){
      await load('nine');
      await win.webContents.executeJavaScript(`document.documentElement.dataset.themeScheme='${scheme}'`);
      await probe('M8 narrow rails and header controls stay within nine tiles '+scheme,async()=>{
        await boundsOracle();
      });
      await probe('L5 M8 title and Record contrast reaches AA '+scheme,async()=>{
        const result=await measure();assert.equal(result.tiles,9);assert.equal(result.scheme,scheme);
        for(const row of result.colours){assert.ok(row.title>=4.5,JSON.stringify(row));assert.ok(row.record>=4.5,JSON.stringify(row));for(const action of row.actions)assert.ok(action.ratio>=4.5,JSON.stringify(action));}
      });
    }
    await load('nine');
    await rejectCssMutant('negative control: bounds oracle rejects original fixed single-row header',
      '.mv-shell .mv-tile .ui-capsule-toolbar{flex-wrap:nowrap!important}.mv-shell .mv-tile .cuk-capsule-panel__header{height:var(--cuk-component-s1-capsule-header-height)!important;padding-inline:var(--cuk-primitive-space-6)!important}.mv-shell .mv-tile .cuk-capsule-panel__actions{flex-wrap:nowrap!important}',boundsOracle);
    await rejectCssMutant('negative control: AA oracle rejects disabled token on enabled header actions',
      '.mv-shell .mv-tile .cuk-capsule-panel__action-btn:not(:disabled){color:var(--cuk-semantic-text-disabled)!important}',()=>labelOracle('actions'));
    await rejectCssMutant('negative control: AA oracle rejects original Record colour pair',
      '.mv-shell .mv-tile .mv-tile-chrome .saas-record{color:var(--cuk-primitive-color-rose-500)!important;background:color-mix(in srgb,var(--cuk-primitive-color-rose-500) 10%,transparent)!important}',()=>labelOracle('record'));
    await load('one');
    await probe('L6 one capsule fills the wall without an empty group',async()=>{
      const result=await evaluate(()=>{
        const wall=document.querySelector('.wall-workspace').getBoundingClientRect(),tile=document.querySelector('.mv-tile').getBoundingClientRect();
        return {wall:wall.width,tile:tile.width};
      });
      assert.ok(result.tile>=result.wall-4,JSON.stringify(result));
    });
    for(const [anchor,selector] of [['settings/open','.mv-settings-screen'],['capsule/open-multislot','.mv-multislot-screen']]){
      await load('four');
      await win.webContents.executeJavaScript(`document.querySelector('[data-semantic-anchor="${anchor}"]').click()`);
      const screenOracle=async()=>{
        const result=await win.webContents.executeJavaScript(`(()=>{const screen=document.querySelector('${selector}');const sashes=[...document.querySelectorAll('.dv-sash')];let checked=0;for(const sash of sashes){const r=sash.getBoundingClientRect();if(!r.width||!r.height)continue;const x=r.left+r.width/2,y=r.top+r.height/2;const b=screen.getBoundingClientRect();if(x<b.left||x>b.right||y<b.top||y>b.bottom)continue;checked++;if(!screen.contains(document.elementFromPoint(x,y)))return {checked,covered:false};}return {checked,covered:true};})()`);
        assert.ok(result.checked>0,'must inspect a visible sash');assert.equal(result.covered,true);
      };
      await probe('L7 app screen covers dock sashes '+selector,screenOracle);
      await rejectCssMutant('negative control: sash oracle rejects uncontained dock '+selector,
        '.wall-workspace{position:static!important;z-index:auto!important}',screenOracle);
    }
  }catch(error){failures.push(error.message);console.error(error.stack);}
  finally{win.destroy();clearTimeout(deadline);app.exit(failures.length?1:0);}
});
