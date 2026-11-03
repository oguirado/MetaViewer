// Render production CSS with the real slot sibling structure. No test CSS may
// replace the canvas background or hide the Interactive banner/footer.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
app.whenReady().then(async () => {
  const source = readFileSync(join(__dirname, '../src/surfaces/SurfaceCanvas.vue'), 'utf8');
  let css = source.split('<style scoped>')[1].split('</style>')[0];
  const roleCss = readFileSync(join(__dirname, '../src/surfaces/RoleSurface.vue'), 'utf8').split('<style scoped>')[1].split('</style>')[0];
  const appCss = readFileSync(join(__dirname, '../src/App.vue'), 'utf8').split('<style>')[1].split('</style>')[0];
  const wallCss = readFileSync(join(__dirname, '../src/wall/wall.css'), 'utf8');
  if (process.env.MV_FIT_NEGATIVE === 'black-background') css += '.mv-surface__canvas{background-color:#000}';
  if (process.env.MV_FIT_NEGATIVE === 'sideways-banner') css += '.mv-role-agent-canvas{flex-direction:row}';
  const win = new BrowserWindow({width:1100,height:850,webPreferences:{nodeIntegration:false,contextIsolation:true}});
  await win.loadURL('data:text/html,' + encodeURIComponent(`<style>
    :root{--cuk-semantic-surface-canvas:#edf2f7;--cuk-semantic-surface-panel:#edf2f7;--cuk-semantic-spacing-xs:4px;--cuk-semantic-spacing-sm:8px;--cuk-semantic-border-width:1px;--cuk-semantic-typography-font-size-xs:11px;--cuk-semantic-typography-line-height-normal:1.4}
    body{margin:0;background:#edf2f7}.host{container:tile-chrome / size;width:900px;height:600px}
    ${wallCss}\n${appCss}\n${roleCss}\n${css}
    </style><div class="mv-shell"><div class="host"><div class="mv-tile-capture-host"><div class="mv-role-surface"><div class="mv-role-viewport"><div class="mv-role-agent-canvas">
    <div class="mv-input-indicator"><span class="mv-input-indicator__text">Interactive — your clicks and typing go to this window</span><button>Release to agent</button></div>
    <section class="mv-surface" data-frame-width="1280" data-frame-height="720"><canvas class="mv-surface__canvas" width="1280" height="720"></canvas><p class="mv-surface__state">live</p><div class="mv-surface__strip"><span class="mv-surface__key">FRAME: tile/surface/generation</span><span class="mv-surface__key">GEN: 93 SHA256: c4cd9471 FPS: 20 CAP: 489ms</span><span class="mv-surface__display-chip">DISPLAY · unverified</span><span class="mv-surface__guard">READ-ONLY ISOLATED EXECUTION</span></div></section>
    </div></div></div></div></div></div>`));
  const evidence = await win.webContents.executeJavaScript(`(async () => {
    const host=document.querySelector('.host'), section=document.querySelector('section'), canvas=document.querySelector('canvas'), strip=document.querySelector('.mv-surface__strip'), banner=document.querySelector('.mv-input-indicator');
    const result=[];
    for(const [w,h] of [[900,600],[450,300],[300,200],[640,480],[250,600]]) {
      host.style.width=w+'px';host.style.height=h+'px';
      for(const interactive of [false,true]) {
        banner.hidden=!interactive;banner.style.display=interactive?'flex':'none';
        for(const [fw,fh] of [[1280,720],[1280,900],[600,800],[150,100]]) {
          section.dataset.frameWidth=fw;section.dataset.frameHeight=fh;canvas.width=fw;canvas.height=fh;
          const ctx=canvas.getContext('2d');ctx.fillStyle='#579';ctx.fillRect(0,0,fw,fh);ctx.strokeStyle='#fff';ctx.lineWidth=8;ctx.strokeRect(4,4,fw-8,fh-8);
          const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
          const range=document.createRange();range.selectNodeContents(document.querySelector('.mv-surface__state'));
          result.push({w,h,fw,fh,interactive,canvas:rect(canvas),section:rect(section),footer:rect(strip),banner:rect(banner),state:rect({getBoundingClientRect:()=>range.getBoundingClientRect()}),labels:[...strip.children].map(rect),background:getComputedStyle(canvas).backgroundColor});
        }
      }
    }
    return result;
  })()`);
  const {containFit,mapClientToFrame} = await import(pathToFileURL(join(__dirname,'../src/input/frameMap.js')).href);
  for (const r of evidence) {
    const c=r.canvas;
    assert.ok(c.width > 0 && c.height > 0, 'clipped: empty canvas '+JSON.stringify(r));
    assert.notEqual(r.background,'rgb(0, 0, 0)', 'letterbox must use tile background: '+JSON.stringify(r));
    for (const box of [c,r.section,r.footer,...(r.interactive?[r.banner]:[])]) {
      assert.ok(box.x>=-.1 && box.y>=-.1 && box.right<=r.w+.1 && box.bottom<=r.h+.1, 'clipped: '+JSON.stringify(r));
    }
    assert.ok(c.bottom<=r.footer.y+.1, 'footer overlaps frame: '+JSON.stringify(r));
    if(r.interactive) assert.ok(r.banner.bottom<=c.y+.1 && r.banner.width>=r.w-.1, 'banner must occupy its own full-width row: '+JSON.stringify(r));
    for(const label of r.labels) {
      assert.ok(!(label.x < r.state.right && r.state.x < label.right && label.y < r.state.bottom && r.state.y < label.bottom), 'footer state overlaps witness: '+JSON.stringify(r));
    }
    const fit=containFit(c.width,c.height,r.fw,r.fh);
    const point=mapClientToFrame({clientX:c.x+fit.offsetX,clientY:c.y+fit.offsetY,rect:{left:c.x,top:c.y,width:c.width,height:c.height},frameWidth:r.fw,frameHeight:r.fh});
    assert.deepEqual(point,{x:0,y:0}, 'painted corner maps exactly');
  }
  const receipt = {status:'pass',cases:evidence};
  if (process.env.MV_FIT_RECEIPT) writeFileSync(process.env.MV_FIT_RECEIPT, JSON.stringify(receipt));
  console.log('V028_FIT_RENDER_OK', evidence.length);
  if (!process.env.MV_FIT_HOLD) app.quit();
}).catch(error => { console.error(error); app.exit(1); });
