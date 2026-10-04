// 共有ロジック: プレビュー(レンダラー)と ffmpeg 書き出し(メイン)の両方で使う。
// ここで計算した配置・視差・タイミングを両者が使うことで、プレビューと書き出し結果を一致させる。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QGCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 公式ドキュメントのデバイス別 quilt 設定。
  // yuv420p で書き出すため、quilt 全体の幅・高さが偶数になるようビューサイズを調整している。
  const PRESETS = {
    portrait: { label: 'Looking Glass Portrait', cols: 8, rows: 6, vw: 420, vh: 560, aspect: 0.75, aspectStr: '0.75' },
    go: { label: 'Looking Glass Go', cols: 11, rows: 6, vw: 372, vh: 682, aspect: 0.5625, aspectStr: '0.5625' },
    '16l': { label: '16" Spatial Display (横)', cols: 7, rows: 7, vw: 856, vh: 856, aspect: 16 / 9, aspectStr: '1.7778' },
    '16p': { label: '16" Spatial Display (縦)', cols: 11, rows: 6, vw: 544, vh: 1000, aspect: 0.5625, aspectStr: '0.5625' },
    '27l': { label: '27" Spatial Display (横)', cols: 8, rows: 6, vw: 960, vh: 720, aspect: 16 / 9, aspectStr: '1.7778' },
    '27p': { label: '27" Spatial Display (縦)', cols: 12, rows: 4, vw: 640, vh: 1080, aspect: 0.5625, aspectStr: '0.5625' },
    '32l': { label: '32" Spatial Display (横)', cols: 7, rows: 7, vw: 1170, vh: 1170, aspect: 16 / 9, aspectStr: '1.7778' },
    '32p': { label: '32" Spatial Display (縦)', cols: 11, rows: 6, vw: 744, vh: 1364, aspect: 0.5625, aspectStr: '0.5625' },
    '65': { label: '65" Spatial Display', cols: 8, rows: 9, vw: 1024, vh: 910, aspect: 16 / 9, aspectStr: '1.7778' },
    custom: { label: 'カスタム', cols: 8, rows: 6, vw: 420, vh: 560, aspect: 0.75, aspectStr: '0.75' },
  };

  const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff', 'webp', 'tga', 'exr', 'avif', 'jxl', 'dpx'];

  let idCounter = 0;
  function newId(prefix) {
    idCounter += 1;
    return `${prefix}${Date.now().toString(36)}${idCounter}`;
  }

  function isImagePath(p) {
    const m = /\.([^.\\/]+)$/.exec(p || '');
    return !!m && IMAGE_EXT.includes(m[1].toLowerCase());
  }

  function baseName(p) {
    return String(p || '').split(/[\\/]/).pop();
  }

  function defaultProject() {
    return {
      version: 1,
      preset: 'portrait',
      custom: { cols: 8, rows: 6, vw: 420, vh: 560, aspect: 0.75 },
      fps: 0, // 0 = 最初の動画素材に合わせる
      durationMode: 'longest', // longest | layer | custom
      durationLayer: '',
      durationCustom: 10,
      focus: 0, // この Z 値の面がスクリーン面（視差ゼロ）になる
      depthScale: 1, // 全レイヤーの視差に掛かる倍率
      bgColor: '#000000',
      layers: [],
      audio: { mode: 'none', layerId: '', path: '', start: 0, in: 0, volume: 0, fadeIn: 0, fadeOut: 0, codec: 'auto' },
      // format: hevc420（推奨）| h264（互換性重視）| hevc_lossless（Studio 変換用） / encoder: auto | cpu | gpu
      video: { format: 'hevc420', encoder: 'auto', crf: 12, speed: 'slow' },
      output: { dir: '', name: 'quilt' },
    };
  }

  function defaultLayer(path, kind) {
    return {
      id: newId('L'),
      name: baseName(path),
      path,
      kind, // video | image
      visible: true,
      z: 0,
      x: 0,
      y: 0,
      scale: 100,
      fit: 'contain', // contain | cover | stretch | width | height
      overscan: false, // 視差で端に隙間ができないよう自動で拡大
      rotation: 0,
      flipH: false,
      flipV: false,
      opacity: 100,
      crop: { l: 0, r: 0, t: 0, b: 0 },
      key: { enabled: false, color: '#00ff00', similarity: 0.12, blend: 0.06 },
      start: 0, // タイムライン上の開始時刻
      in: 0, // 素材の使用開始位置
      out: 0, // 素材の使用終了位置（0 = 最後まで）
      duration: 0, // 静止画の表示時間（0 = ずっと）
      endMode: 'hide', // hide | hold | loop
    };
  }

  // ---------------------------------------------------------------- geometry
  function geometry(project) {
    const p = project.preset === 'custom' ? Object.assign({}, PRESETS.custom, project.custom) : PRESETS[project.preset] || PRESETS.portrait;
    const cols = Math.max(1, Math.round(p.cols));
    const rows = Math.max(1, Math.round(p.rows));
    const vw = Math.max(2, Math.round(p.vw));
    const vh = Math.max(2, Math.round(p.vh));
    const aspect = Number(p.aspect) || vw / vh;
    // 合成は表示上の正しいアスペクト比を持つ作業解像度 dw x vh で行い、最後に vw x vh へ変換する
    const dw = Math.max(2, Math.round((vh * aspect) / 2) * 2);
    const aspectStr = project.preset === 'custom' ? String(+aspect.toFixed(4)) : p.aspectStr;
    return { cols, rows, n: cols * rows, vw, vh, dw, qw: cols * vw, qh: rows * vh, aspect, aspectStr };
  }

  // view 0（左端のカメラ）で -1、最後のビュー（右端）で +1
  function viewFactor(i, n) {
    return n > 1 ? (i / (n - 1)) * 2 - 1 : 0;
  }

  // 両端のビューでの横ずれ量 [作業px]。Z は「両端ビューでのずれ量（ビュー幅に対する%）」。
  // 奥にあるもの（Z > focus）は左のカメラから見ると左へずれる。
  function maxShift(layer, project, geo) {
    return ((Number(layer.z) - Number(project.focus)) / 100) * geo.dw * Number(project.depthScale);
  }

  function shiftAt(layer, project, geo, i) {
    return viewFactor(i, geo.n) * maxShift(layer, project, geo);
  }

  // レイヤーの配置（回転前のサイズと中心）[作業px]
  function layerBox(layer, media, project, geo) {
    const sw = media && media.width ? media.width : 16;
    const sh = media && media.height ? media.height : 9;
    const c = layer.crop || { l: 0, r: 0, t: 0, b: 0 };
    const cw = Math.max(1, sw * (1 - (c.l + c.r) / 100));
    const ch = Math.max(1, sh * (1 - (c.t + c.b) / 100));
    let kx;
    let ky;
    switch (layer.fit) {
      case 'cover': kx = ky = Math.max(geo.dw / cw, geo.vh / ch); break;
      case 'stretch': kx = geo.dw / cw; ky = geo.vh / ch; break;
      case 'width': kx = ky = geo.dw / cw; break;
      case 'height': kx = ky = geo.vh / ch; break;
      default: kx = ky = Math.min(geo.dw / cw, geo.vh / ch);
    }
    const s = Number(layer.scale) / 100;
    let w = cw * kx * s;
    let h = ch * ky * s;
    if (layer.overscan) {
      const m = 2 * Math.abs(maxShift(layer, project, geo));
      const k = (w + m) / w;
      w *= k;
      h *= k;
    }
    return {
      w: Math.max(1, Math.round(w)),
      h: Math.max(1, Math.round(h)),
      cx: geo.dw / 2 + (Number(layer.x) / 100) * geo.dw,
      cy: geo.vh / 2 - (Number(layer.y) / 100) * geo.vh,
      rot: Number(layer.rotation) || 0,
      crop: { u0: c.l / 100, v0: c.t / 100, u1: 1 - c.r / 100, v1: 1 - c.b / 100 },
    };
  }

  // 奥から手前の順（Z が大きいほど奥）。同じ Z ならリストの上にあるものを手前に描く。
  function drawOrder(project) {
    return project.layers
      .map((l, idx) => ({ l, idx }))
      .filter((e) => e.l.visible && e.l.path)
      .sort((a, b) => (b.l.z - a.l.z) || (b.idx - a.idx))
      .map((e) => e.l);
  }

  // ---------------------------------------------------------------- timing
  function segLength(layer, media) {
    if (layer.kind === 'image') return layer.duration > 0 ? Number(layer.duration) : Infinity;
    const dur = media && media.duration ? media.duration : 0;
    const end = layer.out > 0 ? Math.min(Number(layer.out), dur || Infinity) : dur;
    return Math.max(0.001, end - Number(layer.in || 0));
  }

  // 「尺を合わせる」ときに使う、そのレイヤー本来の終了時刻
  function naturalEnd(layer, media) {
    return Number(layer.start || 0) + segLength(layer, media);
  }

  function projectFps(project, mediaMap) {
    if (project.fps > 0) return Number(project.fps);
    for (const l of project.layers) {
      const m = mediaMap[l.path];
      if (l.kind === 'video' && m && m.fps > 0) return m.fps;
    }
    return 30;
  }

  function projectDuration(project, mediaMap) {
    if (project.durationMode === 'custom') return Math.max(0.1, Number(project.durationCustom) || 1);
    if (project.durationMode === 'layer') {
      const l = project.layers.find((x) => x.id === project.durationLayer);
      if (l) {
        const e = naturalEnd(l, mediaMap[l.path]);
        if (isFinite(e)) return e;
      }
    }
    let d = 0;
    for (const l of project.layers) {
      if (!l.visible || !l.path) continue;
      const e = naturalEnd(l, mediaMap[l.path]);
      if (isFinite(e)) d = Math.max(d, e);
    }
    if (project.audio.mode === 'file' && project.audio.path) {
      const m = mediaMap[project.audio.path];
      if (m && m.duration) d = Math.max(d, project.audio.start + m.duration - project.audio.in);
    }
    return d > 0 ? d : Math.max(0.1, Number(project.durationCustom) || 10);
  }

  // タイムライン時刻 t に表示する素材内の時刻。表示しない場合は null。
  function sourceTime(layer, media, t, fps) {
    const local = t - Number(layer.start || 0);
    if (local < 0) return null;
    const L = segLength(layer, media);
    const inP = Number(layer.in || 0);
    if (layer.kind === 'image') return local < L || layer.endMode !== 'hide' ? 0 : null;
    if (local < L) return inP + local;
    if (layer.endMode === 'hold') return inP + Math.max(0, L - 1 / (fps || 30));
    if (layer.endMode === 'loop') return inP + (local % L);
    return null;
  }

  // ---------------------------------------------------------------- utils
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const v = m ? parseInt(m[1], 16) : 0;
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  function outputFileName(project, ext) {
    const geo = geometry(project);
    const name = (project.output.name || 'quilt').replace(/[\\/:*?"<>|]/g, '_');
    return `${name}_qs${geo.cols}x${geo.rows}a${geo.aspectStr}.${ext}`;
  }

  function formatTime(sec) {
    if (!isFinite(sec)) return '∞';
    const s = Math.max(0, sec);
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return `${m}:${r.toFixed(2).padStart(5, '0')}`;
  }

// 旧バージョンのプロジェクト（video.encoder にコーデック名）を新形式に変換
function migrateVideo(v) {
  const old = { libx264: ['h264', 'cpu'], h264_nvenc: ['h264', 'gpu'], libx265: ['hevc420', 'cpu'], hevc_nvenc: ['hevc420', 'gpu'] };
  if (v && !v.format) {
    const m = old[v.encoder];
    v.format = m ? m[0] : 'hevc420';
    v.encoder = m ? m[1] : 'auto';
  }
  // HEVC 4:4:4 は Studio で緑色に表示されるため廃止（4:2:0 に置き換え）
  if (v && v.format === 'hevc444') v.format = 'hevc420';
  // Studio が読み込めない ProRes と、画質が頭打ちだった品質4 マスターはロスレスに置き換え
  if (v && ['hevc444_master', 'hevc420_master', 'prores422hq'].includes(v.format)) v.format = 'hevc_lossless';
  return v;
}

  return {
    PRESETS, migrateVideo, IMAGE_EXT, newId, isImagePath, baseName, defaultProject, defaultLayer,
    geometry, viewFactor, maxShift, shiftAt, layerBox, drawOrder,
    segLength, naturalEnd, projectFps, projectDuration, sourceTime,
    hexToRgb, outputFileName, formatTime,
  };
});
