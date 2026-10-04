'use strict';
/* global QGCore, QuiltPreview, LayerSource, toFileUrl, api */

const $ = (id) => document.getElementById(id);
// window.api は preload.js が公開する（グローバル変数 api として参照できる）

const state = {
  project: QGCore.defaultProject(),
  mediaMap: {}, // path -> probe 結果
  sources: new Map(), // layerId -> LayerSource
  selectedId: '',
  time: 0,
  playing: false,
  playWall: 0,
  playFrom: 0,
  viewMode: 'view',
  viewIndex: 23,
  projectPath: '',
  dirty: false,
  version: 0, // 見た目が変わるたびに増える
  bridge: { connected: false, displays: [] },
  live: false,
  lastCastVersion: -1,
  lastChangeAt: 0,
  casting: false,
  exporting: false,
  lastOutput: '',
  ffmpeg: null,
  lkg: { open: false, ready: false, sentVersion: -1, sentAt: 0 }, // 実機リアルタイム表示
};

let preview;
let audioEl = null; // 別ファイル音声のプレビュー用

// ================================================================ util

let toastTimer;
function toast(msg, isError) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', !!isError);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), isError ? 6000 : 3000);
}

function modal(title, bodyEl) {
  $('modalTitle').textContent = title;
  const b = $('modalBody');
  b.innerHTML = '';
  b.appendChild(bodyEl);
  $('modal').classList.remove('hidden');
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

function getPath(obj, p) {
  return p.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
}
function setPath(obj, p, v) {
  const ks = p.split('.');
  const last = ks.pop();
  const o = ks.reduce((a, k) => a[k], obj);
  o[last] = v;
}

function geo() {
  return QGCore.geometry(state.project);
}
function fps() {
  return QGCore.projectFps(state.project, state.mediaMap);
}
function duration() {
  return QGCore.projectDuration(state.project, state.mediaMap);
}

function touch(structural) {
  state.version++;
  state.lastChangeAt = performance.now();
  state.dirty = true;
  updateTitle();
  if (structural) {
    renderLayerList();
    renderTimeline();
  } else {
    updateTimelineBars();
  }
  updateTransport();
  updateExportSummary();
}

// ================================================================ フォーム生成
// def: { key, label, type: range|number|select|check|color|text|file|info, min, max, step, unit, options, help, show(obj) }
function buildForm(container, defs, obj, onChange) {
  container.innerHTML = '';
  const controls = [];
  for (const d of defs) {
    if (d.section) {
      const s = el('div', { class: 'section-title' }, d.section, d.extra || null);
      container.appendChild(s);
      continue;
    }
    if (d.show && !d.show(obj)) continue;
    if (d.help && !d.key) {
      container.appendChild(el('div', { class: 'field help' }, d.help));
      continue;
    }
    const ctl = el('div', { class: 'ctl' });
    const row = el('div', { class: 'field' }, el('span', { class: 'label' }, d.label), ctl);
    const val = getPath(obj, d.key);
    const commit = (v, structural) => {
      setPath(obj, d.key, v);
      onChange(d, v, structural);
    };
    if (d.type === 'range') {
      const r = el('input', { type: 'range', min: d.min, max: d.max, step: d.step || 1 });
      const n = el('input', { type: 'number', step: d.step || 1 });
      r.value = val;
      n.value = val;
      r.addEventListener('input', () => { n.value = r.value; commit(Number(r.value)); });
      n.addEventListener('change', () => { const v = Number(n.value) || 0; r.value = v; commit(v); });
      r.addEventListener('dblclick', () => { if (d.def !== undefined) { r.value = d.def; n.value = d.def; commit(d.def); } });
      ctl.append(r, n);
      if (d.unit) ctl.append(el('span', { class: 'unit' }, d.unit));
    } else if (d.type === 'number') {
      const n = el('input', { type: 'number', min: d.min, max: d.max, step: d.step || 1 });
      n.value = val;
      n.addEventListener('change', () => commit(Number(n.value) || 0, d.structural));
      ctl.append(n);
      if (d.unit) ctl.append(el('span', { class: 'unit' }, d.unit));
    } else if (d.type === 'select') {
      const s = el('select');
      const opts = typeof d.options === 'function' ? d.options() : d.options;
      for (const [v, label] of opts) s.append(el('option', { value: v }, label));
      s.value = val;
      s.addEventListener('change', () => commit(d.numeric ? Number(s.value) : s.value, true));
      ctl.append(s);
    } else if (d.type === 'check') {
      const c = el('input', { type: 'checkbox' });
      c.checked = !!val;
      c.addEventListener('change', () => commit(c.checked, d.structural));
      ctl.append(c);
      if (d.text) ctl.append(el('span', { class: 'small muted' }, d.text));
    } else if (d.type === 'color') {
      const c = el('input', { type: 'color' });
      c.value = val;
      c.addEventListener('input', () => commit(c.value));
      ctl.append(c);
    } else if (d.type === 'text') {
      const t = el('input', { type: 'text' });
      t.value = val || '';
      t.addEventListener('change', () => commit(t.value, true));
      ctl.append(t);
    } else if (d.type === 'file') {
      ctl.append(el('span', { class: 'path', title: val || '' }, val ? QGCore.baseName(val) : '（未選択）'));
      ctl.append(el('button', { onclick: async () => { const p = await d.pick(); if (p) commit(p, true); } }, '選択…'));
    } else if (d.type === 'info') {
      ctl.append(el('span', { class: 'small' }, d.value(obj)));
    }
    container.appendChild(row);
    if (d.help) container.appendChild(el('div', { class: 'field help' }, d.help));
    controls.push(row);
  }
  return controls;
}

// LayerSource / toFileUrl は sources.js

// ================================================================ 素材の追加・削除
async function ensureMedia(p) {
  if (state.mediaMap[p]) return state.mediaMap[p];
  const info = await api.probe(p);
  if (info.error) throw new Error(info.error.split('\n')[0]);
  state.mediaMap[p] = info;
  return info;
}

async function addMedia(paths) {
  let firstVideoAdded = false;
  for (const p of paths) {
    try {
      const info = await ensureMedia(p);
      if (!info.hasVideo) {
        // 音声だけのファイルは音声トラックとして設定
        state.project.audio.mode = 'file';
        state.project.audio.path = p;
        toast(`音声ファイルとして設定: ${QGCore.baseName(p)}`);
        renderAudioTab();
        continue;
      }
      const kind = info.isImage ? 'image' : 'video';
      const layer = QGCore.defaultLayer(p, kind);
      // 最初の素材は前景（Z=0）、以降は少しずつ奥へ。静止画は背景として画面を覆う設定に
      const n = state.project.layers.length;
      layer.z = n === 0 ? 0 : Math.min(30, n * 4);
      if (kind === 'image' && n > 0) {
        layer.fit = 'cover';
        layer.overscan = true;
      }
      state.project.layers.push(layer);
      await attachSource(layer);
      state.selectedId = layer.id;
      if (kind === 'video' && !firstVideoAdded && state.project.audio.mode === 'none' && info.hasAudio) {
        state.project.audio.mode = 'layer';
        state.project.audio.layerId = layer.id;
        firstVideoAdded = true;
      }
      if (!state.project.output.dir) state.project.output.dir = p.replace(/[\\/][^\\/]*$/, '');
    } catch (e) {
      toast(`読み込めません: ${QGCore.baseName(p)} — ${e.message}`, true);
    }
  }
  touch(true);
  renderAll();
}

async function attachSource(layer) {
  const s = new LayerSource(layer, { fps, onFrame: requestRender, onError: renderLayerList });
  state.sources.set(layer.id, s);
  await s.init();
  requestRender();
  return s;
}

function removeLayer(id) {
  const i = state.project.layers.findIndex((l) => l.id === id);
  if (i < 0) return;
  const s = state.sources.get(id);
  if (s) s.dispose();
  state.sources.delete(id);
  preview.dropTexture(id);
  state.project.layers.splice(i, 1);
  if (state.project.audio.layerId === id) state.project.audio.mode = 'none';
  if (state.selectedId === id) state.selectedId = (state.project.layers[i] || state.project.layers[i - 1] || {}).id || '';
  touch(true);
  renderAll();
}

async function duplicateLayer(id) {
  const src = state.project.layers.find((l) => l.id === id);
  if (!src) return;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = QGCore.newId('L');
  copy.name = `${src.name} (コピー)`;
  state.project.layers.splice(state.project.layers.indexOf(src), 0, copy);
  await attachSource(copy);
  state.selectedId = copy.id;
  touch(true);
  renderAll();
}

function moveLayer(id, dir) {
  const ls = state.project.layers;
  const i = ls.findIndex((l) => l.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ls.length) return;
  [ls[i], ls[j]] = [ls[j], ls[i]];
  touch(true);
}

function selectedLayer() {
  return state.project.layers.find((l) => l.id === state.selectedId);
}

// ================================================================ レイヤー一覧
function renderLayerList() {
  const ul = $('layerList');
  ul.innerHTML = '';
  for (const l of state.project.layers) {
    const m = state.mediaMap[l.path];
    const src = state.sources.get(l.id);
    const meta = m ? `${l.kind === 'image' ? '静止画' : '動画'} ${m.width}×${m.height}${l.kind === 'video' ? ` / ${m.duration.toFixed(1)}s` : ''}` : '';
    const li = el('li', { class: `layer-item${l.id === state.selectedId ? ' sel' : ''}${l.visible ? '' : ' off'}`, onclick: () => { state.selectedId = l.id; renderLayerList(); renderLayerTab(); renderTimeline(); showTab('layer'); } },
      el('button', { class: 'eye', title: '表示/非表示', onclick: (e) => { e.stopPropagation(); l.visible = !l.visible; touch(true); } }, l.visible ? '👁' : '—'),
      el('div', {},
        el('div', { class: 'name', title: l.path }, l.name),
        el('div', { class: 'meta' }, meta, src && src.mode === 'ffmpeg' ? ' · ffmpegプレビュー' : '', src && src.mode === 'error' ? el('span', { class: 'err' }, ' · 読込失敗') : '')),
      el('div', {},
        el('div', { class: 'z', title: 'Z（奥行き）' }, `Z ${Number(l.z).toFixed(1)}`),
        el('div', { class: 'ops' },
          el('button', { title: '上へ', onclick: (e) => { e.stopPropagation(); moveLayer(l.id, -1); } }, '▲'),
          el('button', { title: '下へ', onclick: (e) => { e.stopPropagation(); moveLayer(l.id, 1); } }, '▼'),
          el('button', { title: '複製', onclick: (e) => { e.stopPropagation(); duplicateLayer(l.id); } }, '⧉'),
          el('button', { title: '削除', onclick: (e) => { e.stopPropagation(); removeLayer(l.id); } }, '✕'))));
    ul.appendChild(li);
  }
  $('emptyState').classList.toggle('hidden', state.project.layers.length > 0);
  $('dropHint').classList.toggle('hidden', state.project.layers.length > 3);
}

// ================================================================ 素材タブ
function renderLayerTab() {
  const c = $('tab-layer');
  const l = selectedLayer();
  if (!l) {
    c.innerHTML = '<p class="muted">レイヤーを選択してください。</p>';
    return;
  }
  const m = state.mediaMap[l.path] || {};
  const isImg = l.kind === 'image';
  const ms = QGCore.maxShift(l, state.project, geo());
  const defs = [
    { section: '基本' },
    { key: 'name', label: '名前', type: 'text' },
    { key: 'visible', label: '表示', type: 'check', structural: true },
    { section: '奥行き' },
    { key: 'z', label: 'Z（奥行き）', type: 'range', min: -30, max: 30, step: 0.1, def: 0, help: `0 = スクリーン面 / プラス = 奥 / マイナス = 手前。両端ビューでのずれ量（ビュー幅の%）。現在 ±${Math.abs(ms).toFixed(1)}px` },
    { section: '配置' },
    { key: 'fit', label: 'フィット', type: 'select', options: [['contain', '全体を収める'], ['cover', '画面を覆う'], ['stretch', '引き伸ばす'], ['width', '幅に合わせる'], ['height', '高さに合わせる']] },
    { key: 'overscan', label: '端の補正', type: 'check', text: '視差で端に隙間が出ないよう拡大' },
    { key: 'scale', label: 'スケール', type: 'range', min: 1, max: 400, step: 0.5, unit: '%', def: 100 },
    { key: 'x', label: '位置 X', type: 'range', min: -100, max: 100, step: 0.1, unit: '%', def: 0 },
    { key: 'y', label: '位置 Y', type: 'range', min: -100, max: 100, step: 0.1, unit: '%', def: 0 },
    { key: 'rotation', label: '回転', type: 'range', min: -180, max: 180, step: 0.5, unit: '°', def: 0 },
    { key: 'opacity', label: '不透明度', type: 'range', min: 0, max: 100, step: 1, unit: '%', def: 100 },
    { key: 'flipH', label: '左右反転', type: 'check' },
    { key: 'flipV', label: '上下反転', type: 'check' },
    { section: '切り抜き' },
    { key: 'crop.l', label: '左', type: 'range', min: 0, max: 49, step: 0.5, unit: '%', def: 0 },
    { key: 'crop.r', label: '右', type: 'range', min: 0, max: 49, step: 0.5, unit: '%', def: 0 },
    { key: 'crop.t', label: '上', type: 'range', min: 0, max: 49, step: 0.5, unit: '%', def: 0 },
    { key: 'crop.b', label: '下', type: 'range', min: 0, max: 49, step: 0.5, unit: '%', def: 0 },
    { section: 'クロマキー' },
    { key: 'key.enabled', label: '有効', type: 'check', structural: true, text: 'アルファの無い素材の背景色を抜く' },
    { key: 'key.color', label: 'キー色', type: 'color', show: (o) => o.key.enabled },
    { key: 'key.similarity', label: '類似度', type: 'range', min: 0.01, max: 1, step: 0.005, def: 0.12, show: (o) => o.key.enabled },
    { key: 'key.blend', label: 'ぼかし', type: 'range', min: 0, max: 1, step: 0.005, def: 0.06, show: (o) => o.key.enabled },
    { section: 'タイミング' },
    { key: 'start', label: '開始時刻', type: 'number', min: 0, step: 0.01, unit: '秒', help: 'タイムライン上でこの素材が現れる時刻' },
  ];
  if (isImg) {
    defs.push({ key: 'duration', label: '表示時間', type: 'number', min: 0, step: 0.01, unit: '秒', help: '0 = 最後まで表示' });
  } else {
    defs.push(
      { key: 'in', label: '使用開始', type: 'number', min: 0, max: m.duration, step: 0.01, unit: '秒' },
      { key: 'out', label: '使用終了', type: 'number', min: 0, max: m.duration, step: 0.01, unit: '秒', help: '0 = 素材の最後まで' },
      { key: 'endMode', label: '終了後', type: 'select', options: [['hide', '消える'], ['hold', '最終フレームで静止'], ['loop', '区間をループ']] },
    );
  }
  defs.push(
    { section: '素材情報' },
    { label: 'ファイル', type: 'info', key: 'path', value: () => l.path },
    { label: '形式', type: 'info', key: 'path', value: () => `${m.width}×${m.height} ${m.videoCodec || ''} ${m.pixFmt || ''}` },
    { label: '長さ / fps', type: 'info', key: 'path', value: () => (isImg ? '静止画' : `${QGCore.formatTime(m.duration)} / ${(m.fps || 0).toFixed(3)}fps`) },
    { label: '音声', type: 'info', key: 'path', value: () => (m.hasAudio ? `${m.audioCodec} ${m.sampleRate}Hz ${m.channels}ch` : 'なし') },
    { label: 'プレビュー', type: 'info', key: 'path', value: () => ({ video: 'ブラウザで再生', image: 'ブラウザで表示', ffmpeg: 'ffmpeg でフレーム取得（再生はコマ落ちします）', error: '読み込み失敗', loading: '読み込み中' })[(state.sources.get(l.id) || {}).mode] },
  );
  buildForm(c, defs, l, (d, v, structural) => {
    if (d.key === 'z' || d.key === 'name' || d.key === 'visible' || d.key === 'endMode') renderLayerList();
    if (d.key === 'z') {
      const help = c.querySelector('.field.help');
      if (help) help.textContent = `0 = スクリーン面 / プラス = 奥 / マイナス = 手前。両端ビューでのずれ量（ビュー幅の%）。現在 ±${Math.abs(QGCore.maxShift(l, state.project, geo())).toFixed(1)}px`;
    }
    touch(structural);
    if (structural) renderLayerTab();
  });
}

// ================================================================ 全体タブ
function presetOptions() {
  return Object.entries(QGCore.PRESETS).map(([k, p]) => [k, k === 'custom' ? 'カスタム' : `${p.label}（${p.cols}×${p.rows}）`]);
}

function renderProjectTab() {
  const p = state.project;
  const g = geo();
  const defs = [
    { section: 'quilt 設定' },
    { key: 'preset', label: 'デバイス', type: 'select', options: presetOptions() },
    { key: 'custom.cols', label: '列', type: 'number', min: 1, max: 20, structural: true, show: (o) => o.preset === 'custom' },
    { key: 'custom.rows', label: '行', type: 'number', min: 1, max: 20, structural: true, show: (o) => o.preset === 'custom' },
    { key: 'custom.vw', label: 'ビュー幅', type: 'number', min: 16, max: 4096, unit: 'px', structural: true, show: (o) => o.preset === 'custom' },
    { key: 'custom.vh', label: 'ビュー高さ', type: 'number', min: 16, max: 4096, unit: 'px', structural: true, show: (o) => o.preset === 'custom' },
    { key: 'custom.aspect', label: '表示アスペクト', type: 'number', min: 0.1, max: 4, step: 0.0001, structural: true, show: (o) => o.preset === 'custom', help: '幅÷高さ（Portrait 0.75 / Go 0.5625 / 16:9 は 1.7778）' },
    { help: `quilt ${g.qw}×${g.qh}px / ${g.cols}×${g.rows} = ${g.n} ビュー / 1ビュー ${g.vw}×${g.vh}px` },
    { section: '奥行き' },
    { key: 'focus', label: 'フォーカス Z', type: 'range', min: -30, max: 30, step: 0.1, def: 0, help: 'この Z の面がスクリーン面（ずれゼロ）になります' },
    { key: 'depthScale', label: '奥行き倍率', type: 'range', min: 0, max: 4, step: 0.01, def: 1, help: 'すべてのレイヤーの視差にかかる倍率' },
    { key: 'bgColor', label: '背景色', type: 'color' },
    { section: '尺・フレームレート' },
    { key: 'durationMode', label: '全体の尺', type: 'select', options: [['longest', '一番長い素材に合わせる'], ['layer', '指定した素材に合わせる'], ['custom', '秒数を指定']] },
    {
      key: 'durationLayer', label: '基準の素材', type: 'select', show: (o) => o.durationMode === 'layer',
      options: () => [['', '（選択）'], ...p.layers.map((l) => [l.id, l.name])],
    },
    { key: 'durationCustom', label: '秒数', type: 'number', min: 0.1, step: 0.01, unit: '秒', structural: true, show: (o) => o.durationMode === 'custom' },
    { key: 'fps', label: 'fps', type: 'number', min: 0, max: 120, step: 0.001, structural: true, help: `0 = 最初の動画素材に合わせる（現在 ${fps().toFixed(3)}fps）` },
    { help: `現在の尺: ${QGCore.formatTime(duration())}（${Math.round(duration() * fps())} フレーム）。ループ/静止を使うと素材より長い尺も作れます。` },
  ];
  buildForm($('tab-project'), defs, p, (d, v, structural) => {
    if (d.key === 'preset') syncPresetTop();
    if (structural || d.key === 'preset') {
      onGeometryChanged();
      renderProjectTab();
    }
    if (d.key === 'focus' || d.key === 'depthScale') renderLayerTab();
    touch(structural);
  });
}

function onGeometryChanged() {
  const g = geo();
  const vi = $('viewIndex');
  vi.max = g.n - 1;
  state.viewIndex = Math.min(state.viewIndex, g.n - 1);
  if (state.viewIndex < 0) state.viewIndex = Math.floor((g.n - 1) / 2);
  vi.value = state.viewIndex;
  $('viewIndexLabel').textContent = state.viewIndex;
  resizeCanvas();
}

function syncPresetTop() {
  $('presetTop').value = state.project.preset;
}

// ================================================================ 音声タブ
function renderAudioTab() {
  const a = state.project.audio;
  const m = a.mode === 'file' ? state.mediaMap[a.path] : null;
  const defs = [
    { section: '音声トラック' },
    { key: 'mode', label: '音声', type: 'select', options: [['none', 'なし'], ['layer', '動画素材の音声を使う'], ['file', '別の音声ファイル']] },
    {
      key: 'layerId', label: '素材', type: 'select', show: (o) => o.mode === 'layer',
      options: () => [['', '（選択）'], ...state.project.layers.filter((l) => l.kind === 'video').map((l) => [l.id, `${l.name}${(state.mediaMap[l.path] || {}).hasAudio ? '' : '（音声なし）'}`])],
    },
    { help: '動画素材の音声は、その素材の開始時刻・使用区間・ループ設定に追従します。', show: (o) => o.mode === 'layer' },
    { key: 'path', label: 'ファイル', type: 'file', show: (o) => o.mode === 'file', pick: () => api.pickAudio() },
    { key: 'start', label: '開始時刻', type: 'number', min: 0, step: 0.01, unit: '秒', structural: true, show: (o) => o.mode === 'file' },
    { key: 'in', label: '使用開始', type: 'number', min: 0, step: 0.01, unit: '秒', structural: true, show: (o) => o.mode === 'file' },
    { section: '調整' },
    { key: 'volume', label: '音量', type: 'range', min: -30, max: 12, step: 0.5, unit: 'dB', def: 0 },
    { key: 'fadeIn', label: 'フェードイン', type: 'number', min: 0, step: 0.1, unit: '秒' },
    { key: 'fadeOut', label: 'フェードアウト', type: 'number', min: 0, step: 0.1, unit: '秒' },
    { section: '音質' },
    { key: 'codec', label: '形式', type: 'select', options: [['auto', '自動（可能なら無劣化コピー / それ以外は AAC 320k）'], ['aac', 'AAC 320kbps'], ['alac', 'ALAC（無劣化・MP4）'], ['pcm', 'PCM 24bit（無劣化・MOV）'], ['copy', 'コピー（再エンコードしない）']] },
    { help: '元が AAC で加工（開始ずらし・トリム・音量・フェード）が無ければ、自動で無劣化コピーになります。ALAC/PCM は Looking Glass Studio で再生できるか事前に確認してください。' },
  ];
  if (m) defs.splice(6, 0, { label: '情報', type: 'info', key: 'path', value: () => `${m.audioCodec} ${m.sampleRate}Hz ${m.channels}ch / ${QGCore.formatTime(m.duration)}` });
  buildForm($('tab-audio'), defs, a, async (d, v, structural) => {
    if (d.key === 'path' && v) {
      try {
        await ensureMedia(v);
      } catch (e) {
        toast(e.message, true);
      }
    }
    setupAudioPreview();
    if (structural) renderAudioTab();
    touch(false);
  });
}

function setupAudioPreview() {
  const a = state.project.audio;
  if (audioEl) {
    audioEl.pause();
    audioEl = null;
  }
  if (a.mode === 'file' && a.path) {
    audioEl = new Audio(toFileUrl(a.path));
    audioEl.preload = 'auto';
  }
}

// ================================================================ 書き出しタブ
function renderExportTab() {
  const v = QGCore.migrateVideo(state.project.video);
  const enc = (state.ffmpeg && state.ffmpeg.encoders) || [];
  const gpuOk = enc.includes('hevc_nvenc') || enc.includes('hevc_videotoolbox');
  const defs = [
    { section: '映像' },
    {
      key: 'format', label: '形式', type: 'select',
      options: [
        ['hevc420', 'HEVC 4:2:0 8bit（実機再生用・推奨）'],
        ['h264', 'H.264 4:2:0 8bit（実機再生用・互換性重視）'],
        ['hevc420_master', 'Studio変換用 HEVC 品質4（実機再生も可）'],
        ['prores422hq', 'Studio変換用 ProRes 422 HQ（.mov・実機での直接再生は不可）'],
      ],
      help: '実機再生用: Bridge（PC接続時の表示）で再生できる形式。Studio変換用: Studio に読み込んで本体へ転送（変換）する前提のマスター。ProRes は Bridge では再生できないため「実機で再生」「Bridge確認」には使えません。',
    },
    { key: 'encoder', label: 'エンコーダ', type: 'select', show: (o) => o.format !== 'prores422hq', options: [['auto', gpuOk ? '自動（GPU）' : '自動（CPU）'], ['gpu', 'GPU（NVENC / VideoToolbox・高速）'], ['cpu', 'CPU（x264/x265・低速だが同じ容量でより高画質）']] },
    { key: 'crf', label: '品質', type: 'range', min: 1, max: 30, step: 1, def: 12, show: (o) => !['prores422hq', 'hevc420_master'].includes(o.format), help: '小さいほど高画質・大容量（目安: 最高画質 8〜12 / 公式推奨 20）' },
    { key: 'speed', label: '圧縮速度', type: 'select', options: [['fast', 'fast'], ['medium', 'medium'], ['slow', 'slow（推奨）'], ['slower', 'slower']], show: (o) => o.format !== 'prores422hq' && (o.encoder === 'cpu' || (o.encoder === 'auto' && !gpuOk)) },
    { section: '出力' },
  ];
  buildForm($('exportForm'), defs, v, (d) => {
    if (d.key === 'encoder' || d.key === 'format') renderExportTab();
    touch(false);
  });
  const out = state.project.output;
  const f2 = el('div');
  buildForm(f2, [
    { key: 'dir', label: 'フォルダ', type: 'file', pick: () => api.pickOutDir(out.dir) },
    { key: 'name', label: 'ファイル名', type: 'text', help: '末尾に Looking Glass Studio 用の _qs列x行a比率 が自動で付きます' },
  ], out, () => { renderExportTab(); touch(false); });
  $('exportForm').appendChild(f2);
  updateExportSummary();
}

function outputExt() {
  if (state.project.video.format === 'prores422hq') return 'mov';
  return state.project.audio.mode !== 'none' && state.project.audio.codec === 'pcm' ? 'mov' : 'mp4';
}

function outputPath() {
  const dir = state.project.output.dir;
  if (!dir) return '';
  const sep = dir.includes('\\') ? '\\' : '/'; // Windows / macOS どちらのパスにも対応
  return `${dir.replace(/[\\/]+$/, '')}${sep}${QGCore.outputFileName(state.project, outputExt())}`;
}

let summaryTimer;
function updateExportSummary() {
  $('outName').textContent = outputPath() || '（出力フォルダを選択してください）';
  clearTimeout(summaryTimer);
  summaryTimer = setTimeout(async () => {
    if (!state.project.layers.length) {
      $('exportSummary').innerHTML = '<span class="warn">素材がありません</span>';
      return;
    }
    try {
      const d = await api.describeExport(state.project, state.mediaMap, outputPath() || 'out.mp4');
      const s = d.summary;
      $('exportSummary').innerHTML = [
        `${s.geo.qw}×${s.geo.qh} / ${s.fps.toFixed(3)}fps / ${QGCore.formatTime(s.dur)}（${Math.round(s.dur * s.fps)}フレーム）`,
        `映像: ${s.enc} / 音声: ${s.audio}`,
        ...s.warnings.map((w) => `<span class="warn">⚠ ${w}</span>`),
      ].join('<br>');
    } catch (e) {
      $('exportSummary').innerHTML = `<span class="warn">${e.message}</span>`;
    }
  }, 150);
}

async function startExport() {
  if (state.exporting) return;
  if (!state.ffmpeg || !state.ffmpeg.ok) return toast('ffmpeg が見つかりません', true);
  if (!state.project.layers.length) return toast('素材を追加してください', true);
  if (!state.project.output.dir) {
    const d = await api.pickOutDir('');
    if (!d) return;
    state.project.output.dir = d;
    renderExportTab();
  }
  setPlaying(false);
  state.exporting = true;
  $('btnExport').disabled = true;
  $('btnCancel').disabled = false;
  $('progressBar').style.width = '0%';
  $('progressText').textContent = '書き出し開始…';
  $('exportLog').classList.add('hidden');
  const r = await api.startExport(state.project, state.mediaMap, outputPath());
  state.exporting = false;
  $('btnExport').disabled = false;
  $('btnCancel').disabled = true;
  if (r.ok) {
    state.lastOutput = r.outPath;
    $('progressBar').style.width = '100%';
    $('progressText').textContent = `完了（${r.elapsed.toFixed(1)}秒）: ${r.outPath}`;
    $('btnShowOutput').disabled = false;
    $('btnCastOutput').disabled = !(state.bridge.connected && state.bridge.displays.length);
    toast('書き出しが完了しました');
  } else if (r.cancelled) {
    $('progressText').textContent = '中止しました';
  } else {
    $('progressText').textContent = 'エラーが発生しました（ログ参照）';
    $('exportLog').textContent = r.error || r.log || '';
    $('exportLog').classList.remove('hidden');
    toast('書き出しに失敗しました', true);
  }
}

// ================================================================ タイムライン
let tlDrag = null;
function renderTimeline() {
  const tl = $('timeline');
  tl.innerHTML = '';
  const dur = duration();
  for (const l of state.project.layers) {
    const track = el('div', { class: 'tl-track', 'data-id': l.id });
    track.append(el('div', { class: 'tl-ext' }), el('div', { class: 'tl-bar' }));
    const row = el('div', { class: `tl-row${l.id === state.selectedId ? ' sel' : ''}` }, el('div', { class: 'tl-name', title: l.name }, l.name), track);
    tl.appendChild(row);
    track.addEventListener('mousedown', (e) => {
      const rect = track.getBoundingClientRect();
      if (e.target.classList.contains('tl-bar')) {
        state.selectedId = l.id;
        tlDrag = { layer: l, x0: e.clientX, start0: l.start, w: rect.width, dur };
        renderLayerList();
        renderLayerTab();
      } else {
        seek(((e.clientX - rect.left) / rect.width) * dur);
      }
    });
  }
  tl.appendChild(el('div', { class: 'tl-head', id: 'tlHead' }));
  updateTimelineBars();
}

function updateTimelineBars() {
  const dur = duration();
  for (const track of document.querySelectorAll('.tl-track')) {
    const l = state.project.layers.find((x) => x.id === track.dataset.id);
    if (!l) continue;
    const m = state.mediaMap[l.path];
    const s = Math.max(0, l.start);
    const L = QGCore.segLength(l, m);
    const e = Math.min(dur, s + (isFinite(L) ? L : dur));
    const bar = track.querySelector('.tl-bar');
    bar.style.left = `${(s / dur) * 100}%`;
    bar.style.width = `${Math.max(0.3, ((e - s) / dur) * 100)}%`;
    bar.style.opacity = l.visible ? 1 : 0.35;
    const ext = track.querySelector('.tl-ext');
    const extended = (l.endMode === 'hold' || l.endMode === 'loop') && e < dur;
    ext.style.display = extended ? 'block' : 'none';
    if (extended) {
      ext.style.left = `${(e / dur) * 100}%`;
      ext.style.width = `${((dur - e) / dur) * 100}%`;
    }
  }
  updatePlayhead();
}

function updatePlayhead() {
  const head = $('tlHead');
  const track = document.querySelector('.tl-track');
  if (!head || !track) return;
  const tl = $('timeline').getBoundingClientRect();
  const r = track.getBoundingClientRect();
  head.style.left = `${r.left - tl.left + (state.time / duration()) * r.width}px`;
}

window.addEventListener('mousemove', (e) => {
  if (!tlDrag) return;
  const dt = ((e.clientX - tlDrag.x0) / tlDrag.w) * tlDrag.dur;
  tlDrag.layer.start = Math.max(0, Math.round((tlDrag.start0 + dt) * 100) / 100);
  touch(false);
});
window.addEventListener('mouseup', () => {
  if (tlDrag) {
    tlDrag = null;
    renderLayerTab();
  }
});

// ================================================================ 再生
function setPlaying(on) {
  if (on === state.playing) return;
  state.playing = on;
  if (on) {
    if (state.time >= duration() - 1e-3) state.time = 0;
    state.playWall = performance.now();
    state.playFrom = state.time;
  } else {
    for (const s of state.sources.values()) if (s.el && s.mode === 'video') s.el.pause();
    if (audioEl) audioEl.pause();
    state.version++;
    state.lastChangeAt = performance.now();
  }
  $('btnPlay').textContent = on ? '⏸' : '▶';
  lkgPush(false);
  requestRender();
}

function seek(t) {
  state.time = Math.max(0, Math.min(duration(), t));
  if (state.playing) {
    state.playWall = performance.now();
    state.playFrom = state.time;
  }
  state.version++;
  state.lastChangeAt = performance.now();
  updateTransport();
  requestRender();
}

function updateTransport() {
  const dur = duration();
  $('timeLabel').textContent = QGCore.formatTime(state.time);
  $('durLabel').textContent = QGCore.formatTime(dur);
  $('timeSlider').value = Math.round((state.time / dur) * 1000);
  updatePlayhead();
}

function syncAudioPreview() {
  if (!audioEl) return;
  const a = state.project.audio;
  const st = state.time - a.start + a.in;
  const m = state.mediaMap[a.path];
  if (!state.playing || st < 0 || (m && st > m.duration)) {
    if (!audioEl.paused) audioEl.pause();
    return;
  }
  audioEl.volume = Math.min(1, Math.pow(10, a.volume / 20));
  if (audioEl.paused) {
    audioEl.currentTime = st;
    audioEl.play().catch(() => {});
  } else if (Math.abs(audioEl.currentTime - st) > 0.25) audioEl.currentTime = st;
}

// ================================================================ 描画ループ
let renderRequested = true;
function requestRender() {
  renderRequested = true;
}

function collectItems() {
  const items = [];
  const f = fps();
  const audio = state.project.audio;
  for (const layer of QGCore.drawOrder(state.project)) {
    const src = state.sources.get(layer.id);
    const media = state.mediaMap[layer.path];
    if (!src || !media) continue;
    const st = QGCore.sourceTime(layer, media, state.time, f);
    const audible = state.playing && audio.mode === 'layer' && audio.layerId === layer.id;
    const r = src.prepare(st, state.playing, audible);
    if (r && preview.updateTexture(layer.id, r.src, r.stamp)) items.push({ layer, media });
  }
  // 非表示レイヤーの動画は止める
  for (const l of state.project.layers) {
    if (!l.visible) {
      const s = state.sources.get(l.id);
      if (s) s.prepare(null);
    }
  }
  return items;
}

function frame(now) {
  requestAnimationFrame(frame);
  lkgTick(now);
  if (state.playing) {
    const dur = duration();
    state.time = state.playFrom + (now - state.playWall) / 1000;
    if (state.time >= dur) {
      state.time = 0;
      state.playFrom = 0;
      state.playWall = now;
    }
    updateTransport();
    syncAudioPreview();
  }
  const wiggle = state.viewMode === 'wiggle';
  if (!state.playing && !wiggle && !renderRequested) {
    maybeLiveCast(now);
    return;
  }
  renderRequested = false;
  const g = geo();
  let vi = state.viewIndex;
  if (wiggle) {
    vi = Math.round(((Math.sin(now / 1000 * 2.2) + 1) / 2) * (g.n - 1));
    $('viewIndexLabel').textContent = vi;
  }
  const items = collectItems();
  preview.render(state.project, g, items, state.viewMode === 'wiggle' ? 'view' : state.viewMode, vi);
  maybeLiveCast(now);
}

function resizeCanvas() {
  const wrap = $('canvasWrap');
  const c = $('preview');
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.max(1, Math.floor(wrap.clientWidth * dpr));
  c.height = Math.max(1, Math.floor(wrap.clientHeight * dpr));
  requestRender();
}

// ================================================================ Looking Glass Bridge
async function refreshBridge(silent) {
  $('bridgeText').textContent = 'Bridge 確認中…';
  const s = await api.bridgeStatus();
  state.bridge = s;
  const dot = $('bridgeDot');
  dot.className = 'dot';
  if (s.connected && s.displays.length) {
    dot.classList.add('on');
    const d = s.displays[0];
    $('bridgeText').textContent = `Bridge ${s.version} / ${d.hwid}${d.quilt.cols ? `（${d.quilt.cols}×${d.quilt.rows}）` : ''}`;
  } else if (s.connected) {
    dot.classList.add('warn');
    $('bridgeText').textContent = `Bridge ${s.version} / 実機が見つかりません`;
  } else {
    $('bridgeText').textContent = 'Bridge 未接続';
    if (!silent) toast('Looking Glass Bridge に接続できません。Bridge が起動しているか確認してください。', true);
  }
  const ok = s.connected && s.displays.length > 0;
  $('btnCast').disabled = !ok;
  $('liveCast').disabled = !ok || state.lkg.open;
  $('btnLkg').disabled = !(s.connected && s.displays.some((d) => d.calibration)) && !state.lkg.open;
  $('btnMatchDevice').disabled = !ok;
  $('btnCastOutput').disabled = !ok || !state.lastOutput;
  $('btnBridge').textContent = s.connected ? '再確認' : '接続';
  if (!ok) {
    state.live = false;
    $('liveCast').checked = false;
  }
}

function matchDevice() {
  const d = state.bridge.displays[0];
  if (!d || !d.quilt.cols) return toast('実機の quilt 設定を取得できませんでした', true);
  const q = d.quilt;
  const hit = Object.entries(QGCore.PRESETS).find(([k, p]) => k !== 'custom' && p.cols === q.cols && p.rows === q.rows && Math.abs(p.aspect - q.aspect) < 0.01);
  if (hit) {
    state.project.preset = hit[0];
  } else {
    state.project.preset = 'custom';
    state.project.custom = { cols: q.cols, rows: q.rows, vw: Math.floor(q.width / q.cols / 2) * 2, vh: Math.floor(q.height / q.rows / 2) * 2, aspect: q.aspect };
  }
  syncPresetTop();
  onGeometryChanged();
  renderProjectTab();
  touch(true);
  toast(`実機の設定に合わせました: ${q.cols}×${q.rows} / aspect ${q.aspect}`);
}

async function castCurrentFrame() {
  if (state.casting) return;
  state.casting = true;
  const castVersion = state.version;
  try {
    const g = geo();
    const items = collectItems();
    const buf = await preview.renderQuiltImage(state.project, g, items);
    const r = await api.bridgeCastImage(buf, { cols: g.cols, rows: g.rows, aspect: g.aspectStr });
    if (!r.ok) toast(`実機への表示に失敗: ${r.error || ''}`, true);
    state.lastCastVersion = castVersion;
  } catch (e) {
    toast(`実機への表示に失敗: ${e.message}`, true);
  } finally {
    state.casting = false;
    requestRender();
  }
}

// ---------------------------------------------------------------- 実機リアルタイム表示
// 実機ウィンドウ（lkg.html）にプロジェクトと再生位置を送り、向こうで素材を再生・レンチキュラー描画する
async function toggleLkg() {
  if (state.lkg.open) {
    await api.lkgClose();
    return;
  }
  $('btnLkg').disabled = true;
  $('btnLkg').textContent = '起動中…';
  const r = await api.lkgOpen();
  $('btnLkg').disabled = false;
  if (!r.ok) {
    $('btnLkg').textContent = '実機リアルタイム表示';
    toast(r.error || '実機ウィンドウを開けません', true);
    return;
  }
  state.lkg.open = true;
  state.live = false;
  $('liveCast').checked = false;
  $('liveCast').disabled = true;
  $('btnLkg').textContent = 'リアルタイム表示を終了';
}

function onLkgEvent(m) {
  if (m.type === 'ready') {
    state.lkg.ready = true;
    lkgPush(true);
  } else if (m.type === 'closed') {
    state.lkg = { open: false, ready: false, sentVersion: -1, sentAt: 0 };
    $('btnLkg').textContent = '実機リアルタイム表示';
    $('liveCast').disabled = !(state.bridge.connected && state.bridge.displays.length);
  } else if (m.type === 'report' && m.expected && (m.info.width !== m.expected.w || m.info.height !== m.expected.h)) {
    toast(`実機ウィンドウの解像度が一致しません（${m.info.width}×${m.info.height} / 実機 ${m.expected.w}×${m.expected.h}）`, true);
  }
}

function lkgPush(full) {
  if (!state.lkg.ready) return;
  const m = { time: state.time, playing: state.playing };
  if (full) {
    m.project = state.project;
    m.mediaMap = state.mediaMap;
    state.lkg.sentVersion = state.version;
  }
  api.lkgSend(m);
  state.lkg.sentAt = performance.now();
}

function lkgTick(now) {
  if (!state.lkg.ready) return;
  if (state.version !== state.lkg.sentVersion) lkgPush(true);
  else if (state.playing && now - state.lkg.sentAt > 1000) lkgPush(false); // 再生中は定期的に時刻を合わせる
}

function maybeLiveCast(now) {
  if (!state.live || state.playing || state.casting) return;
  if (state.version === state.lastCastVersion) return;
  if (now - state.lastChangeAt < 450) return;
  castCurrentFrame();
}

async function castOutput() {
  if (!state.lastOutput) return;
  if (/.mov$/i.test(state.lastOutput) && state.project.video.format === 'prores422hq') {
    toast('ProRes は Bridge で再生できません。Studio に読み込んで変換してください', true);
    return;
  }
  const g = geo();
  const r = await api.bridgeCastFile(state.lastOutput, { cols: g.cols, rows: g.rows, aspect: g.aspect });
  if (r.ok) toast('実機で再生しています');
  else toast(`再生に失敗: ${r.error || ''}`, true);
}

// ================================================================ プロジェクト
function updateTitle() {
  const name = state.projectPath ? QGCore.baseName(state.projectPath) : '無題';
  $('projectName').textContent = `${name}${state.dirty ? ' *' : ''}`;
  document.title = `${name}${state.dirty ? ' *' : ''} - Looking Glass Quilt Generator`;
}

async function saveProject(saveAs) {
  const json = JSON.stringify(state.project, null, 2);
  const p = await api.saveProject(json, saveAs ? '' : state.projectPath);
  if (p) {
    state.projectPath = p;
    state.dirty = false;
    updateTitle();
    toast('保存しました');
  }
}

async function loadProject(given) {
  const r = await api.openProject(given);
  if (!r) return;
  let proj;
  try {
    proj = JSON.parse(r.json);
  } catch (e) {
    return toast('プロジェクトファイルを読み込めません', true);
  }
  await resetProject(Object.assign(QGCore.defaultProject(), proj, {
    audio: Object.assign(QGCore.defaultProject().audio, proj.audio),
    video: Object.assign(QGCore.defaultProject().video, QGCore.migrateVideo(Object.assign({}, proj.video || {}))),
    output: Object.assign(QGCore.defaultProject().output, proj.output),
  }));
  state.projectPath = r.path;
  for (const l of state.project.layers) {
    Object.assign(l, Object.assign(QGCore.defaultLayer(l.path, l.kind), l));
    try {
      await ensureMedia(l.path);
      await attachSource(l);
    } catch (e) {
      toast(`素材が見つかりません: ${l.path}`, true);
    }
  }
  if (state.project.audio.path) {
    try {
      await ensureMedia(state.project.audio.path);
    } catch { /* noop */ }
  }
  state.selectedId = (state.project.layers[0] || {}).id || '';
  state.dirty = false;
  setupAudioPreview();
  renderAll();
}

async function resetProject(proj) {
  setPlaying(false);
  for (const [id, s] of state.sources) {
    s.dispose();
    preview.dropTexture(id);
  }
  state.sources.clear();
  state.project = proj || QGCore.defaultProject();
  state.selectedId = '';
  state.time = 0;
  state.projectPath = '';
  state.dirty = false;
  state.lastOutput = '';
  setupAudioPreview();
}

function renderAll() {
  syncPresetTop();
  onGeometryChanged();
  renderLayerList();
  renderLayerTab();
  renderProjectTab();
  renderAudioTab();
  renderExportTab();
  renderTimeline();
  updateTransport();
  updateTitle();
  requestRender();
}

function showTab(name) {
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const t of ['layer', 'project', 'audio', 'export']) $(`tab-${t}`).classList.toggle('hidden', t !== name);
  if (name === 'project') renderProjectTab();
  if (name === 'audio') renderAudioTab();
  if (name === 'export') renderExportTab();
}

// ================================================================ 初期化
async function init() {
  preview = new QuiltPreview($('preview'));

  // 上部
  const pt = $('presetTop');
  for (const [v, label] of presetOptions()) pt.append(el('option', { value: v }, label));
  pt.addEventListener('change', () => {
    state.project.preset = pt.value;
    onGeometryChanged();
    renderProjectTab();
    renderLayerTab();
    touch(true);
  });
  $('btnNew').onclick = async () => {
    if (state.dirty && !confirm('保存されていない変更を破棄しますか？')) return;
    await resetProject();
    renderAll();
  };
  $('btnOpen').onclick = () => loadProject();
  $('btnSave').onclick = (e) => saveProject(e.shiftKey);
  $('btnBridge').onclick = () => refreshBridge(false);
  $('btnMatchDevice').onclick = matchDevice;
  $('btnCast').onclick = castCurrentFrame;
  $('btnLkg').onclick = toggleLkg;
  api.onLkgEvent(onLkgEvent);
  $('liveCast').onchange = (e) => {
    state.live = e.target.checked;
    state.lastCastVersion = -1;
  };

  // レイヤー
  $('btnAddMedia').onclick = async () => {
    const ps = await api.pickMedia();
    if (ps.length) addMedia(ps);
  };
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) document.body.classList.remove('dragging');
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    const proj = paths.find((p) => /\.json$/i.test(p));
    if (proj) loadProject(proj);
    else if (paths.length) addMedia(paths);
  });

  // プレビュー
  for (const b of document.querySelectorAll('#viewModes button')) {
    b.onclick = () => {
      state.viewMode = b.dataset.mode;
      for (const x of document.querySelectorAll('#viewModes button')) x.classList.toggle('on', x === b);
      $('viewIndex').disabled = state.viewMode !== 'view';
      $('viewIndexLabel').textContent = state.viewIndex;
      requestRender();
    };
  }
  $('viewIndex').oninput = (e) => {
    state.viewIndex = Number(e.target.value);
    $('viewIndexLabel').textContent = state.viewIndex;
    requestRender();
  };
  $('btnPlay').onclick = () => setPlaying(!state.playing);
  $('btnStart').onclick = () => seek(0);
  $('timeSlider').oninput = (e) => seek((Number(e.target.value) / 1000) * duration());
  new ResizeObserver(resizeCanvas).observe($('canvasWrap'));

  // タブ
  for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => showTab(b.dataset.tab);

  // 書き出し
  $('btnExport').onclick = startExport;
  $('btnCancel').onclick = () => api.cancelExport();
  $('btnShowOutput').onclick = () => state.lastOutput && api.showInFolder(state.lastOutput);
  $('btnCastOutput').onclick = castOutput;
  $('btnCommand').onclick = async () => {
    const d = await api.describeExport(state.project, state.mediaMap, outputPath() || 'out.mp4');
    const box = el('div', {},
      el('p', { class: 'small muted' }, 'コマンド（filter.txt にフィルタグラフを保存して実行）'),
      el('textarea', { readonly: true }, d.command),
      el('p', { class: 'small muted' }, `filter.txt（${d.filterText.split('\n').length} 行）`),
      el('textarea', { readonly: true }, d.filterText));
    modal('ffmpeg コマンド', box);
  };
  api.onExportProgress((p) => {
    if (p.ratio !== undefined) {
      $('progressBar').style.width = `${(p.ratio * 100).toFixed(1)}%`;
      $('progressText').textContent = `${(p.ratio * 100).toFixed(1)}%  ${QGCore.formatTime(p.time)} / ${QGCore.formatTime(duration())}  経過 ${p.elapsed.toFixed(0)}秒${p.eta !== null ? ` / 残り約 ${Math.ceil(p.eta)}秒` : ''}`;
    }
  });
  $('btnPickFfmpeg').onclick = async () => {
    const p = await api.pickFfmpeg();
    if (p) applyFfmpegInfo(await api.setFfmpeg(p));
  };
  $('btnResetFfmpeg').onclick = async () => applyFfmpegInfo(await api.setFfmpeg(''));

  $('modalClose').onclick = () => $('modal').classList.add('hidden');

  // キーボード
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== 'range' && document.activeElement.type !== 'checkbox';
    const mod = e.ctrlKey || e.metaKey; // macOS は Cmd
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveProject(e.shiftKey);
    } else if (mod && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      loadProject();
    } else if (typing) {
      // 入力中は他のショートカットを無効に
    } else if (e.code === 'Space') {
      e.preventDefault();
      setPlaying(!state.playing);
    } else if (e.key === 'Home') {
      seek(0);
    } else if (e.key === 'ArrowLeft') {
      seek(state.time - (e.shiftKey ? 1 : 1 / fps()));
    } else if (e.key === 'ArrowRight') {
      seek(state.time + (e.shiftKey ? 1 : 1 / fps()));
    } else if (e.key === 'Delete' && state.selectedId) {
      removeLayer(state.selectedId);
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty && state.project.layers.length && !window.__allowClose) {
      e.returnValue = false;
      setTimeout(() => {
        if (confirm('保存されていない変更があります。終了しますか？')) {
          window.__allowClose = true;
          window.close();
        }
      }, 0);
    }
  });

  const info = await api.info();
  applyFfmpegInfo(info.ffmpeg);
  renderAll();
  requestAnimationFrame(frame);
  refreshBridge(true);
  if (info.startupProject) await loadProject(info.startupProject);
  if (info.selftestMode) {
    const [mode, t] = info.selftestMode.split(':');
    const btn = document.querySelector(`#viewModes button[data-mode="${mode}"]`);
    if (btn) btn.click();
    seek(Number(t || 0));
    if (mode === 'lkg') {
      await refreshBridge(true);
      await toggleLkg();
      setTimeout(() => setPlaying(true), 3000);
    }
    if (mode === 'export') {
      document.querySelector('#viewModes button[data-mode="quilt"]').click();
      showTab('export');
      await startExport();
      console.log('selftest export:', $('progressText').textContent);
    }
  }
}

function applyFfmpegInfo(f) {
  state.ffmpeg = f;
  $('ffmpegInfo').textContent = f.ok ? `${f.version}\n${f.path}\nエンコーダ: ${f.encoders.join(', ')}` : f.error;
  if (!f.ok) toast(f.error, true);
  renderExportTab();
}

init().catch((e) => {
  console.error(e);
  toast(`初期化エラー: ${e.message}`, true);
});
