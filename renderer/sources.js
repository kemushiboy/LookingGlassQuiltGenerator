'use strict';
/* global api */
// プレビュー用の素材ソース。メインウィンドウと実機ウィンドウ（lkg.html）の両方で使う。

// ローカル素材は main.js の qgmedia プロトコル経由で読む（WebGL で使えるよう CORS 許可付き）
function toFileUrl(p) {
  return `qgmedia://local/${encodeURIComponent(p)}`;
}

// ================================================================ レイヤー素材（プレビュー用ソース）
// ブラウザで再生できる素材は <video>/<img>、できないもの（ProRes / qtrle / TIFF など）は ffmpeg で1フレームずつ取得する
class LayerSource {
  constructor(layer, ctx) {
    this.layer = layer;
    this.ctx = ctx; // { this.ctx.fps(): number, onFrame(): void, onError(): void }
    this.mode = 'loading'; // video | image | ffmpeg | error
    this.el = null;
    this.bitmap = null;
    this.bitmapT = null;
    this.pendingT = null;
    this.inflight = false;
    this.stamp = 0;
  }

  async init() {
    const { layer } = this;
    const url = toFileUrl(layer.path);
    const ok = await new Promise((resolve) => {
      if (layer.kind === 'image') {
        const img = new Image();
        img.onload = () => { this.el = img; this.mode = 'image'; resolve(true); };
        img.onerror = () => resolve(false);
        img.src = url;
      } else {
        const v = document.createElement('video');
        v.muted = true;
        v.preload = 'auto';
        v.playsInline = true;
        v.crossOrigin = 'anonymous';
        const done = (r) => { v.onloadeddata = null; v.onerror = null; resolve(r); };
        v.onloadeddata = () => {
          if (v.videoWidth > 0) { this.el = v; this.mode = 'video'; done(true); } else done(false);
        };
        v.onerror = () => done(false);
        v.addEventListener('seeked', () => this.ctx.onFrame());
        v.src = url;
        setTimeout(() => done(false), 8000);
      }
    });
    if (!ok) {
      this.mode = 'ffmpeg';
      this.el = null;
    }
    return this.mode;
  }

  // タイムライン時刻からテクスチャ用ソースを準備。描けるなら { src, stamp } を返す
  prepare(st, playing, audible) {
    if (st === null) {
      if (this.el && this.mode === 'video' && !this.el.paused) this.el.pause();
      return null;
    }
    if (this.mode === 'image') return { src: this.el, stamp: 'img' };
    if (this.mode === 'video') {
      const v = this.el;
      v.muted = !audible;
      if (playing) {
        if (v.paused) {
          v.currentTime = st;
          v.play().catch(() => {});
        } else if (Math.abs(v.currentTime - st) > 0.25) v.currentTime = st;
        if (v.readyState >= 2) return { src: v, stamp: performance.now() };
        return null;
      }
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - st) > 0.5 / this.ctx.fps() && !v.seeking) v.currentTime = st;
      if (v.readyState >= 2) return { src: v, stamp: `p${v.currentTime}` };
      return null;
    }
    if (this.mode === 'ffmpeg') {
      const f = this.ctx.fps();
      const q = this.layer.kind === 'image' ? 0 : Math.round(st * f) / f;
      if (this.bitmapT !== q) this.request(q);
      if (this.bitmap) return { src: this.bitmap, stamp: `b${this.bitmapT}` };
      return null;
    }
    return null;
  }

  request(t) {
    this.pendingT = t;
    if (this.inflight) return;
    this.inflight = true;
    const want = t;
    api.frame(this.layer.path, want, 1280).then(async (buf) => {
      this.inflight = false;
      if (buf) {
        const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }), { premultiplyAlpha: 'none' });
        if (this.bitmap) this.bitmap.close();
        this.bitmap = bmp;
        this.bitmapT = want;
        this.ctx.onFrame();
      } else if (!this.bitmap) {
        this.mode = 'error';
        this.ctx.onError();
      }
      if (this.pendingT !== want) this.request(this.pendingT);
    });
  }

  dispose() {
    if (this.el && this.mode === 'video') {
      this.el.pause();
      this.el.removeAttribute('src');
      this.el.load();
    }
    if (this.bitmap) this.bitmap.close();
  }
}

window.LayerSource = LayerSource;
window.toFileUrl = toFileUrl;
