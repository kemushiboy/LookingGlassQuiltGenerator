'use strict';
/* global QGCore, QuiltPreview, LayerSource, api */
// 実機ディスプレイ上の全画面ウィンドウ。メインウィンドウから送られるプロジェクトと再生位置に合わせて、
// 自前で素材を再生し、レンチキュラー描画してリアルタイムに表示する。

const canvas = document.getElementById('c');
const msg = document.getElementById('msg');
const preview = new QuiltPreview(canvas);
const sources = new Map(); // layerId -> { path, src }
let project = null;
let mediaMap = {};
let cal = null;
let playing = false;
let baseTime = 0;
let baseWall = 0;
let dirty = true;

const fps = () => (project ? QGCore.projectFps(project, mediaMap) : 30);

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  // レンチキュラーは物理ピクセル単位で合わせる必要があるため、ずれていたら知らせる
  if (cal && (canvas.width !== cal.screenW || canvas.height !== cal.screenH)) {
    msg.textContent = `解像度が一致しません: ${canvas.width}×${canvas.height}（実機 ${cal.screenW}×${cal.screenH}）`;
  } else msg.textContent = '';
  api.lkgReport({ width: canvas.width, height: canvas.height, dpr });
  dirty = true;
}

function syncSources() {
  const ids = new Set(project.layers.map((l) => l.id));
  for (const [id, s] of sources) {
    const l = project.layers.find((x) => x.id === id);
    if (!ids.has(id) || !l || l.path !== s.path) {
      s.src.dispose();
      preview.dropTexture(id);
      sources.delete(id);
    }
  }
  for (const l of project.layers) {
    const s = sources.get(l.id);
    if (s) {
      s.src.layer = l;
      continue;
    }
    const src = new LayerSource(l, { fps, onFrame: () => { dirty = true; }, onError: () => {} });
    sources.set(l.id, { path: l.path, src });
    src.init().then(() => { dirty = true; });
  }
}

api.onLkgState((m) => {
  if (m.calibration) cal = m.calibration;
  if (m.project) {
    project = m.project;
    mediaMap = m.mediaMap || mediaMap;
    syncSources();
  }
  if (m.time !== undefined) {
    baseTime = m.time;
    baseWall = performance.now();
    playing = !!m.playing;
  }
  if (m.calibration) resize();
  dirty = true;
});

function currentTime(now) {
  if (!playing || !project) return baseTime;
  const dur = QGCore.projectDuration(project, mediaMap);
  let t = baseTime + (now - baseWall) / 1000;
  if (t >= dur) t %= dur;
  return t;
}

function frame(now) {
  requestAnimationFrame(frame);
  if (!project || !cal) return;
  if (!playing && !dirty) return;
  dirty = false;
  const t = currentTime(now);
  const f = fps();
  const items = [];
  for (const layer of QGCore.drawOrder(project)) {
    const s = sources.get(layer.id);
    const media = mediaMap[layer.path];
    if (!s || !media) continue;
    const st = QGCore.sourceTime(layer, media, t, f);
    const r = s.src.prepare(st, playing, false);
    if (r && preview.updateTexture(layer.id, r.src, r.stamp)) items.push({ layer, media });
  }
  for (const l of project.layers) {
    if (!l.visible) {
      const s = sources.get(l.id);
      if (s) s.src.prepare(null);
    }
  }
  preview.renderLenticular(project, QGCore.geometry(project), items, cal);
}

window.addEventListener('resize', resize);
resize();
requestAnimationFrame(frame);
api.lkgReady();
