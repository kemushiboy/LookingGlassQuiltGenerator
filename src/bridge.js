// Looking Glass Bridge 連携（メインプロセス専用）
// 公式 Bridge.js SDK (@lookingglass/bridge) と同じ HTTP API (localhost:33334) を直接呼ぶ。
// quilt 画像 / 動画のファイルパスを1件だけのプレイリストとして Bridge に再生させる。
'use strict';

const BASE = 'http://localhost:33334/';
const ORCH_NAME = 'LookingGlassQuiltGenerator';

let orchestration = '';
let lastPlaylist = '';
let version = '';

async function call(endpoint, body, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(BASE + endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`Bridge ${endpoint}: HTTP ${r.status}`);
    const j = await r.json();
    const st = j && j.status ? j.status.value : '';
    if (st && st !== 'Completion' && st !== 'Pending') throw new Error(`Bridge ${endpoint}: ${st}`);
    return j;
  } finally {
    clearTimeout(t);
  }
}

async function connect() {
  const v = await call('bridge_version', {});
  version = v.payload.value;
  const o = await call('enter_orchestration', { name: ORCH_NAME });
  orchestration = o.payload.value;
  return { version, orchestration };
}

async function ensure() {
  if (!orchestration) await connect();
}

function parseJson(s) {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

async function displays() {
  await ensure();
  const r = await call('available_output_devices', { orchestration });
  const list = [];
  const map = (r.payload && r.payload.value) || {};
  for (const k of Object.keys(map)) {
    const d = map[k].value;
    const hwid = d.hwid ? d.hwid.value : '';
    if (!hwid.includes('LKG')) continue;
    const q = parseJson(d.defaultQuilt && d.defaultQuilt.value) || {};
    const raw = parseJson(d.calibration && d.calibration.value) || {};
    // { DPI: { value: 324 }, ... } → { DPI: 324, ... }
    const cal = {};
    for (const [k, v] of Object.entries(raw)) cal[k] = v && typeof v === 'object' && 'value' in v ? v.value : v;
    list.push({
      index: d.index.value,
      hwid,
      hardwareVersion: d.hardwareVersion ? d.hardwareVersion.value : '',
      serial: cal.serial || '',
      screenW: cal.screenW,
      screenH: cal.screenH,
      calibration: cal.pitch ? cal : null,
      windowCoords: d.windowCoords ? d.windowCoords.value : null,
      quilt: {
        width: q.quiltX || q.quiltWidth || 0,
        height: q.quiltY || q.quiltHeight || 0,
        cols: q.tileX || q.columns || 0,
        rows: q.tileY || q.rows || 0,
        aspect: q.quiltAspect || 0,
      },
    });
  }
  return list;
}

async function status() {
  try {
    await connect();
    const ds = await displays();
    return { connected: true, version, displays: ds };
  } catch (e) {
    orchestration = '';
    return { connected: false, error: String(e.message || e), displays: [] };
  }
}

// quilt（画像 or 動画）を Bridge で表示する
async function cast(uri, { cols, rows, aspect, focus = 0 }) {
  await ensure();
  const name = `QG_${Date.now().toString(36)}`;
  await call('instance_playlist', { orchestration, name, loop: true });
  await call('insert_playlist_entry', {
    orchestration,
    id: 0,
    name,
    index: 0,
    uri,
    rows,
    cols,
    focus,
    aspect,
    view_count: rows * cols,
    isRGBD: 0,
    tag: '',
  });
  await call('play_playlist', { orchestration, name, head_index: -1 });
  if (lastPlaylist && lastPlaylist !== name) {
    call('delete_playlist', { orchestration, name: lastPlaylist, loop: true }).catch(() => {});
  }
  lastPlaylist = name;
  return { ok: true };
}

async function showWindow(show) {
  await ensure();
  await call('show_window', { orchestration, show_window: !!show, head_index: -1 });
  return { ok: true };
}

async function disconnect() {
  if (!orchestration) return;
  try {
    if (lastPlaylist) await call('delete_playlist', { orchestration, name: lastPlaylist, loop: true }, 1500);
    await call('exit_orchestration', { orchestration }, 1500);
  } catch { /* noop */ }
  orchestration = '';
  lastPlaylist = '';
}

module.exports = { status, displays, cast, showWindow, disconnect };
