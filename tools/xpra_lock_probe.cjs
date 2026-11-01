const {app} = require('electron');
const path = require('node:path');
const fresh = process.env.XPRA_PROBE_ROOT;
if (!fresh || !fresh.startsWith('/tmp/claude-1000/xpra-spike/')) throw Error('isolated home required');
app.setName('MetaViewer');
app.setPath('userData', path.join(fresh, 'config', 'MetaViewer') + '-nested-depth-1');
if (!app.requestSingleInstanceLock()) { console.error('SINGLE_INSTANCE'); app.exit(1); }
else app.whenReady().then(() => { console.log('SPIKE_LOCK_ISOLATED'); app.exit(0); });
