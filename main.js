'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const ff = require('./src/ffmpeg');
const bridge = require('./src/bridge');

// プレビュー用にローカル素材を配信するプロトコル（WebGL テクスチャに使えるよう CORS 許可・シーク用の Range 対応）
protocol.registerSchemesAsPrivileged([
  { scheme: 'qgmedia', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true } },
]);

const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg',
};

function registerMediaProtocol() {
  protocol.handle('qgmedia', async (req) => {
    const u = new URL(req.url);
    const file = decodeURIComponent(u.pathname.slice(1));
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return new Response('not found', { status: 404 });
    }
    const type = MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
        status: 206,
        headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': String(end - start + 1) },
      });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(st.size) } });
  });
}

let win = null;
let ffInfo = { ok: false };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { ffmpegPath: '', lastDir: '' };

function loadSettings() {
  try {
    settings = Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8')));
  } catch { /* 初回起動 */ }
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch { /* noop */ }
}

async function initFfmpeg() {
  const candidates = settings.ffmpegPath ? [settings.ffmpegPath, ...ff.findFfmpegCandidates()] : ff.findFfmpegCandidates();
  for (const c of candidates) {
    ff.setPaths(c);
    ffInfo = await ff.checkFfmpeg();
    if (ffInfo.ok) {
      ffInfo.path = c;
      return ffInfo;
    }
  }
  ffInfo = { ok: false, error: process.platform === 'darwin' ? 'ffmpeg が見つかりません。brew install ffmpeg でインストールするか、設定から ffmpeg を指定してください。' : 'ffmpeg が見つかりません。winget install Gyan.FFmpeg でインストールするか、設定から ffmpeg.exe を指定してください。' };
  return ffInfo;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#15171c',
    title: 'Looking Glass Quilt Generator',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => {
    if (lkgWin && !lkgWin.isDestroyed()) lkgWin.close();
  });

  // 動作確認用: QG_SELFTEST=プロジェクトJSON で起動すると読み込み後に画面を保存して終了する
  if (process.env.QG_SELFTEST) {
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.message));
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        const out = process.env.QG_SELFTEST_OUT || path.join(os.tmpdir(), 'qg_selftest.png');
        fs.writeFileSync(out, img.toPNG());
        if (lkgWin && !lkgWin.isDestroyed()) fs.writeFileSync(out.replace(/.png$/, '_lkg.png'), (await lkgWin.webContents.capturePage()).toPNG());
        app.quit();
      }, Number(process.env.QG_SELFTEST_WAIT || 6000));
    });
  }
}

app.whenReady().then(async () => {
  loadSettings();
  registerMediaProtocol();
  await initFfmpeg();
  createWindow();
});

app.on('window-all-closed', async () => {
  ff.cancelExport();
  await bridge.disconnect();
  app.quit();
});

// ---------------------------------------------------------------- IPC
const MEDIA_FILTERS = [
  { name: '動画・画像', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mxf', 'gif', 'png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff', 'webp', 'tga', 'exr', 'avif'] },
  { name: 'すべて', extensions: ['*'] },
];
const AUDIO_FILTERS = [
  { name: '音声・動画', extensions: ['wav', 'aif', 'aiff', 'flac', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'mp4', 'mov', 'mkv', 'webm'] },
  { name: 'すべて', extensions: ['*'] },
];

function rememberDir(p) {
  if (p) {
    settings.lastDir = path.dirname(p);
    saveSettings();
  }
}

ipcMain.handle('app:info', () => ({ ffmpeg: ffInfo, settings, startupProject: process.env.QG_SELFTEST || '', selftestMode: process.env.QG_SELFTEST_MODE || '' }));

ipcMain.handle('settings:setFfmpeg', async (_e, p) => {
  settings.ffmpegPath = p || '';
  saveSettings();
  return initFfmpeg();
});

ipcMain.handle('dialog:ffmpeg', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'ffmpeg を選択', properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'ffmpeg', extensions: ['exe'] }] : [] });
  return r.canceled ? '' : r.filePaths[0];
});

ipcMain.handle('dialog:media', async () => {
  const r = await dialog.showOpenDialog(win, { title: '素材を追加', defaultPath: settings.lastDir || undefined, properties: ['openFile', 'multiSelections'], filters: MEDIA_FILTERS });
  if (!r.canceled) rememberDir(r.filePaths[0]);
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('dialog:audio', async () => {
  const r = await dialog.showOpenDialog(win, { title: '音声ファイルを選択', defaultPath: settings.lastDir || undefined, properties: ['openFile'], filters: AUDIO_FILTERS });
  if (!r.canceled) rememberDir(r.filePaths[0]);
  return r.canceled ? '' : r.filePaths[0];
});

ipcMain.handle('dialog:outDir', async (_e, cur) => {
  const r = await dialog.showOpenDialog(win, { title: '出力フォルダ', defaultPath: cur || settings.lastDir || undefined, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? '' : r.filePaths[0];
});

ipcMain.handle('project:save', async (_e, json, curPath) => {
  let p = curPath;
  if (!p) {
    const r = await dialog.showSaveDialog(win, { title: 'プロジェクトを保存', defaultPath: path.join(settings.lastDir || app.getPath('documents'), 'quilt-project.lgq.json'), filters: [{ name: 'Quilt プロジェクト', extensions: ['json'] }] });
    if (r.canceled) return '';
    p = r.filePath;
  }
  fs.writeFileSync(p, json, 'utf8');
  rememberDir(p);
  return p;
});

ipcMain.handle('project:open', async (_e, given) => {
  let p = given;
  if (!p) {
    const r = await dialog.showOpenDialog(win, { title: 'プロジェクトを開く', defaultPath: settings.lastDir || undefined, properties: ['openFile'], filters: [{ name: 'Quilt プロジェクト', extensions: ['json'] }] });
    if (r.canceled) return null;
    p = r.filePaths[0];
  }
  rememberDir(p);
  return { path: p, json: fs.readFileSync(p, 'utf8') };
});

ipcMain.handle('media:probe', async (_e, p) => {
  try {
    return await ff.probe(p);
  } catch (e) {
    return { error: String(e.stderr || e.message || e) };
  }
});

ipcMain.handle('media:frame', async (_e, p, t, maxW) => {
  try {
    return await ff.grabFrame(p, t, maxW || 1024);
  } catch (e) {
    return null;
  }
});

ipcMain.handle('export:describe', (_e, project, mediaMap, outPath) => {
  const d = ff.describeCommand(project, mediaMap, outPath, ffInfo.encoders);
  // 出力先ドライブの空き容量
  try {
    const st = fs.statfsSync(path.dirname(outPath));
    d.summary.freeBytes = st.bavail * st.bsize;
  } catch { /* フォルダ未作成など */ }
  return d;
});

ipcMain.handle('export:start', async (_e, project, mediaMap, outPath) => {
  if (fs.existsSync(outPath)) {
    const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['上書き', 'キャンセル'], defaultId: 0, cancelId: 1, message: '同名のファイルがあります。上書きしますか？', detail: outPath });
    if (r.response !== 0) return { ok: false, cancelled: true };
  }
  return ff.startExport(project, mediaMap, outPath, ffInfo.encoders, (p) => {
    if (win && !win.isDestroyed()) win.webContents.send('export:progress', p);
  });
});

ipcMain.handle('export:cancel', () => ff.cancelExport());

ipcMain.handle('shell:show', (_e, p) => shell.showItemInFolder(p));

let lastBridgeStatus = null;
ipcMain.handle('bridge:status', async () => {
  lastBridgeStatus = await bridge.status();
  return lastBridgeStatus;
});
ipcMain.handle('bridge:castFile', async (_e, p, settingsQ) => {
  try {
    return await bridge.cast(p, settingsQ);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// 現在フレームの quilt 画像を一時ファイルにして Bridge に表示する
let castToggle = 0;
ipcMain.handle('bridge:castImage', async (_e, buf, settingsQ) => {
  try {
    castToggle = (castToggle + 1) % 4;
    const p = path.join(os.tmpdir(), `lgqg_live_${castToggle}_qs${settingsQ.cols}x${settingsQ.rows}a${settingsQ.aspect}.jpg`);
    fs.writeFileSync(p, Buffer.from(buf));
    return await bridge.cast(p, settingsQ);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});
ipcMain.handle('bridge:show', async (_e, show) => {
  try {
    return await bridge.showWindow(show);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// ---------------------------------------------------------------- 実機リアルタイム表示
// 実機ディスプレイ上に全画面ウィンドウを開き、そこでレンチキュラー描画する（Bridge を経由しないので再生中も動く）
const { screen } = require('electron');
let lkgWin = null;
let lkgDevice = null;

function findElectronDisplay(dev) {
  const all = screen.getAllDisplays();
  return all.find((d) => d.label && d.label === dev.hwid)
    || all.find((d) => Math.round(d.size.width * d.scaleFactor) === dev.screenW && Math.round(d.size.height * d.scaleFactor) === dev.screenH)
    || null;
}

function sendToMain(ch, data) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data);
}

ipcMain.handle('lkg:open', async () => {
  if (lkgWin && !lkgWin.isDestroyed()) return { ok: true };
  // Bridge の応答は遅いことがあるので、直前に取得した情報があればそれを使う
  let dev = ((lastBridgeStatus && lastBridgeStatus.displays) || []).find((d) => d.calibration);
  if (!dev) dev = ((await bridge.status()).displays || []).find((d) => d.calibration);
  if (!dev) return { ok: false, error: 'キャリブレーション情報のある実機が見つかりません' };
  const disp = findElectronDisplay(dev);
  if (!disp) return { ok: false, error: `実機のディスプレイ（${dev.hwid}）が見つかりません` };
  lkgDevice = dev;
  // Bridge の表示ウィンドウと重ならないよう隠す
  bridge.showWindow(false).catch(() => {});
  lkgWin = new BrowserWindow({
    x: disp.bounds.x,
    y: disp.bounds.y,
    width: disp.bounds.width,
    height: disp.bounds.height,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    backgroundColor: '#000000',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  lkgWin.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') lkgWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  lkgWin.setBounds(disp.bounds);
  lkgWin.loadFile(path.join(__dirname, 'renderer', 'lkg.html'));
  lkgWin.once('ready-to-show', () => {
    lkgWin.setBounds(disp.bounds);
    lkgWin.showInactive();
    // macOS: メニューバーを避けてディスプレイ全体を覆う
    if (process.platform === 'darwin') lkgWin.setSimpleFullScreen(true);
  });
  lkgWin.on('closed', () => {
    lkgWin = null;
    sendToMain('lkg:event', { type: 'closed' });
  });
  return { ok: true, device: { hwid: dev.hwid, serial: dev.serial, screenW: dev.screenW, screenH: dev.screenH } };
});

ipcMain.handle('lkg:close', () => {
  if (lkgWin && !lkgWin.isDestroyed()) lkgWin.close();
  return { ok: true };
});

// lkg ウィンドウの準備完了 → キャリブレーションを渡し、メインウィンドウに現在の状態を送ってもらう
ipcMain.on('lkg:ready', () => {
  if (lkgWin && lkgDevice) lkgWin.webContents.send('lkg:state', { calibration: lkgDevice.calibration });
  sendToMain('lkg:event', { type: 'ready' });
});
ipcMain.on('lkg:report', (_e, info) => sendToMain('lkg:event', { type: 'report', info, expected: lkgDevice && { w: lkgDevice.screenW, h: lkgDevice.screenH } }));
ipcMain.on('lkg:send', (_e, m) => {
  if (lkgWin && !lkgWin.isDestroyed()) lkgWin.webContents.send('lkg:state', m);
});
