// WebGL2 プレビュー描画。
// QGCore.layerBox / shiftAt を使い、ffmpeg 書き出しと同じ配置・視差で各ビューを描く。
'use strict';

const VS = `#version 300 es
in vec2 aPos;           // 0..1（左上原点）
uniform vec2 uCenter;   // 作業px
uniform vec2 uSize;     // 作業px（回転前）
uniform float uRot;     // 度、時計回り
uniform vec2 uCanvas;   // 作業キャンバス (dw, vh)
out vec2 vUV;
void main() {
  vec2 p = (aPos - 0.5) * uSize;
  float a = radians(uRot);
  p = vec2(p.x * cos(a) - p.y * sin(a), p.x * sin(a) + p.y * cos(a)) + uCenter;
  gl_Position = vec4(p.x / uCanvas.x * 2.0 - 1.0, 1.0 - p.y / uCanvas.y * 2.0, 0.0, 1.0);
  vUV = aPos;
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec4 uCrop;     // u0, v0, u1, v1
uniform vec2 uFlip;
uniform float uOpacity;
uniform int uKey;
uniform vec2 uKeyUV;
uniform float uSim;
uniform float uBlend;
out vec4 outColor;
void main() {
  vec2 q = vUV;
  if (uFlip.x > 0.5) q.x = 1.0 - q.x;
  if (uFlip.y > 0.5) q.y = 1.0 - q.y;
  vec4 c = texture(uTex, mix(uCrop.xy, uCrop.zw, q));
  float a = c.a;
  if (uKey == 1) {
    // ffmpeg chromakey と同じく YUV の UV 平面上の距離で判定
    float u = -0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b + 0.5;
    float v = 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b + 0.5;
    vec2 d = vec2(u, v) - uKeyUV;
    float diff = sqrt(dot(d, d) / 2.0);
    float k = uBlend > 0.0001 ? clamp((diff - uSim) / uBlend, 0.0, 1.0) : (diff > uSim ? 1.0 : 0.0);
    a *= k;
  }
  a *= uOpacity;
  outColor = vec4(c.rgb * a, a);
}`;

class QuiltPreview {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 が使えません');
    this.gl = gl;
    this.prog = this._program(VS, FS);
    this.loc = {};
    for (const n of ['uCenter', 'uSize', 'uRot', 'uCanvas', 'uTex', 'uCrop', 'uFlip', 'uOpacity', 'uKey', 'uKeyUV', 'uSim', 'uBlend']) {
      this.loc[n] = gl.getUniformLocation(this.prog, n);
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const aPos = gl.getAttribLocation(this.prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    this.textures = new Map(); // layerId -> { tex, stamp }
  }

  _program(vs, fs) {
    const gl = this.gl;
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos'); // 全プログラムで同じ VAO を使う
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  // source: HTMLVideoElement | HTMLImageElement | ImageBitmap。stamp が変わったときだけ転送する
  updateTexture(id, source, stamp) {
    const gl = this.gl;
    let t = this.textures.get(id);
    if (!t) {
      t = { tex: gl.createTexture(), stamp: null };
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.textures.set(id, t);
    }
    if (t.stamp === stamp) return true;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      t.stamp = stamp;
      return true;
    } catch (e) {
      return false;
    }
  }

  dropTexture(id) {
    const t = this.textures.get(id);
    if (t) {
      this.gl.deleteTexture(t.tex);
      this.textures.delete(id);
    }
  }

  // ビュー i を、現在バインド中のフレームバッファの (x, y, w, h) 領域に描く
  // items: [{ layer, media }]（奥→手前の順、テクスチャ準備済みのもの）
  drawView(project, geo, items, i, x, y, w, h) {
    const gl = this.gl;
    const bg = QGCore.hexToRgb(project.bgColor);
    gl.viewport(x, y, w, h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, y, w, h);
    gl.clearColor(bg[0] / 255, bg[1] / 255, bg[2] / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(this.loc.uCanvas, geo.dw, geo.vh);
    gl.uniform1i(this.loc.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    for (const { layer, media } of items) {
      const t = this.textures.get(layer.id);
      if (!t) continue;
      const box = QGCore.layerBox(layer, media, project, geo);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.uniform2f(this.loc.uCenter, box.cx + QGCore.shiftAt(layer, project, geo, i), box.cy);
      gl.uniform2f(this.loc.uSize, box.w, box.h);
      gl.uniform1f(this.loc.uRot, box.rot);
      gl.uniform4f(this.loc.uCrop, box.crop.u0, box.crop.v0, box.crop.u1, box.crop.v1);
      gl.uniform2f(this.loc.uFlip, layer.flipH ? 1 : 0, layer.flipV ? 1 : 0);
      gl.uniform1f(this.loc.uOpacity, layer.opacity / 100);
      gl.uniform1i(this.loc.uKey, layer.key.enabled ? 1 : 0);
      if (layer.key.enabled) {
        const [r, g, b] = QGCore.hexToRgb(layer.key.color).map((v) => v / 255);
        gl.uniform2f(this.loc.uKeyUV, -0.168736 * r - 0.331264 * g + 0.5 * b + 0.5, 0.5 * r - 0.418688 * g - 0.081312 * b + 0.5);
        gl.uniform1f(this.loc.uSim, layer.key.similarity);
        gl.uniform1f(this.loc.uBlend, layer.key.blend);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  // 画面表示用
  // mode: 'view'（1ビュー）| 'quilt'（全体）| 'sbs'（左右端ビューの並列表示）
  render(project, geo, items, mode, viewIndex) {
    const gl = this.gl;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0.08, 0.09, 0.11, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (mode === 'quilt') {
      const r = fitRect(geo.qw, geo.qh, cw, ch);
      const tw = r.w / geo.cols;
      const th = r.h / geo.rows;
      for (let i = 0; i < geo.n; i++) {
        const col = i % geo.cols;
        const row = Math.floor(i / geo.cols);
        // GL は左下原点なので、view 0 = 左下 がそのまま quilt の並びになる
        const x0 = Math.round(r.x + col * tw);
        const y0 = Math.round(r.y + row * th);
        this.drawView(project, geo, items, i, x0, y0, Math.round(r.x + (col + 1) * tw) - x0, Math.round(r.y + (row + 1) * th) - y0);
      }
    } else if (mode === 'sbs') {
      const gap = 12;
      const r = fitRect(geo.dw * 2, geo.vh, cw - gap, ch);
      const w = Math.floor(r.w / 2);
      this.drawView(project, geo, items, 0, Math.round(r.x), Math.round(r.y), w, Math.round(r.h));
      this.drawView(project, geo, items, geo.n - 1, Math.round(r.x + w + gap), Math.round(r.y), w, Math.round(r.h));
    } else {
      const r = fitRect(geo.dw, geo.vh, cw, ch);
      this.drawView(project, geo, items, viewIndex, Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
    }
  }

  // 実機キャスト用: 書き出しと同じ解像度の quilt 画像（JPEG）を作る
  async renderQuiltImage(project, geo, items, quality = 0.95) {
    const gl = this.gl;
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const s = Math.min(1, maxSize / Math.max(geo.qw, geo.qh));
    const W = Math.floor(geo.qw * s);
    const H = Math.floor(geo.qh * s);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const tw = W / geo.cols;
    const th = H / geo.rows;
    for (let i = 0; i < geo.n; i++) {
      const col = i % geo.cols;
      const row = Math.floor(i / geo.cols);
      const x0 = Math.round(col * tw);
      const y0 = Math.round(row * th);
      this.drawView(project, geo, items, i, x0, y0, Math.round((col + 1) * tw) - x0, Math.round((row + 1) * th) - y0);
    }
    const px = new Uint8ClampedArray(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
    // readPixels は下から上の順なので上下を反転
    const flipped = new Uint8ClampedArray(px.length);
    const row = W * 4;
    for (let y = 0; y < H; y++) flipped.set(px.subarray((H - 1 - y) * row, (H - y) * row), y * row);
    const oc = new OffscreenCanvas(W, H);
    oc.getContext('2d').putImageData(new ImageData(flipped, W, H), 0, 0);
    const blob = await oc.convertToBlob({ type: 'image/jpeg', quality });
    return blob.arrayBuffer();
  }
}

// ---------------------------------------------------------------- 実機（レンチキュラー）描画
// quilt を作業用テクスチャに描いてから、実機のキャリブレーション値でサブピクセルごとにビューを選んで出力する。
// 計算式は Looking Glass WebXR / HoloPlay.js と同じ。
const LENTI_VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0); }`;

const LENTI_FS = `#version 300 es
precision highp float;
uniform sampler2D uQuilt;
uniform vec2 uRes;       // 出力キャンバス（物理ピクセル）
uniform float uPitch;
uniform float uTilt;
uniform float uCenter;
uniform float uSubp;
uniform float uInvView;
uniform int uRi;
uniform int uBi;
uniform vec3 uTile;      // cols, rows, viewCount
out vec4 outColor;
vec2 texArr(vec3 uvz) {
  float z = floor(uvz.z * uTile.z);
  float x = (mod(z, uTile.x) + uvz.x) / uTile.x;
  float y = (floor(z / uTile.x) + uvz.y) / uTile.y;
  return vec2(x, y);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 rgb[3];
  for (int i = 0; i < 3; i++) {
    float z = (uv.x + float(i) * uSubp + uv.y * uTilt) * uPitch - uCenter;
    z = mod(z + ceil(abs(z)), 1.0);
    z = (1.0 - uInvView) * z + uInvView * (1.0 - z);
    rgb[i] = texture(uQuilt, texArr(vec3(uv, z)));
  }
  outColor = vec4(rgb[uRi].r, rgb[1].g, rgb[uBi].b, 1.0);
}`;

// Bridge のキャリブレーション → シェーダーの値
function lenticularParams(cal) {
  const screenInches = cal.screenW / cal.DPI;
  return {
    pitch: cal.pitch * screenInches * Math.cos(Math.atan(1 / cal.slope)),
    tilt: (cal.screenH / (cal.screenW * cal.slope)) * (cal.flipImageX ? -1 : 1),
    center: cal.center,
    subp: 1 / (cal.screenW * 3),
    invView: cal.invView ? 1 : 0,
    ri: cal.flipSubp ? 2 : 0,
    bi: cal.flipSubp ? 0 : 2,
  };
}

QuiltPreview.prototype.renderLenticular = function renderLenticular(project, geo, items, cal) {
  const gl = this.gl;
  if (!this.lenti) {
    this.lenti = { prog: this._program(LENTI_VS, LENTI_FS), loc: {} };
    for (const n of ['uQuilt', 'uRes', 'uPitch', 'uTilt', 'uCenter', 'uSubp', 'uInvView', 'uRi', 'uBi', 'uTile']) {
      this.lenti.loc[n] = gl.getUniformLocation(this.lenti.prog, n);
    }
  }
  const L = this.lenti;
  // quilt 用の描画先（サイズが変わったときだけ作り直す）
  const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const s = Math.min(1, maxSize / Math.max(geo.qw, geo.qh));
  const W = Math.floor(geo.qw * s);
  const H = Math.floor(geo.qh * s);
  if (!L.fb || L.w !== W || L.h !== H) {
    if (L.fb) {
      gl.deleteFramebuffer(L.fb);
      gl.deleteTexture(L.tex);
    }
    L.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, L.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    L.fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, L.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, L.tex, 0);
    L.w = W;
    L.h = H;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, L.fb);
  const tw = W / geo.cols;
  const th = H / geo.rows;
  for (let i = 0; i < geo.n; i++) {
    const col = i % geo.cols;
    const row = Math.floor(i / geo.cols);
    const x0 = Math.round(col * tw);
    const y0 = Math.round(row * th);
    this.drawView(project, geo, items, i, x0, y0, Math.round((col + 1) * tw) - x0, Math.round((row + 1) * th) - y0);
  }
  // レンチキュラー合成
  const p = lenticularParams(cal);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  gl.disable(gl.BLEND);
  gl.useProgram(L.prog);
  gl.bindVertexArray(this.vao);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, L.tex);
  gl.uniform1i(L.loc.uQuilt, 0);
  gl.uniform2f(L.loc.uRes, this.canvas.width, this.canvas.height);
  gl.uniform1f(L.loc.uPitch, p.pitch);
  gl.uniform1f(L.loc.uTilt, p.tilt);
  gl.uniform1f(L.loc.uCenter, p.center);
  gl.uniform1f(L.loc.uSubp, p.subp);
  gl.uniform1f(L.loc.uInvView, p.invView);
  gl.uniform1i(L.loc.uRi, p.ri);
  gl.uniform1i(L.loc.uBi, p.bi);
  gl.uniform3f(L.loc.uTile, geo.cols, geo.rows, geo.n);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
};

function fitRect(w, h, cw, ch, pad = 8) {
  const s = Math.min((cw - pad * 2) / w, (ch - pad * 2) / h);
  const rw = w * s;
  const rh = h * s;
  return { x: (cw - rw) / 2, y: (ch - rh) / 2, w: rw, h: rh };
}

window.QuiltPreview = QuiltPreview;
