// ffmpeg / ffprobe まわり（メインプロセス専用）
// make_quilt.bat のフィルタ構成（素材を split → ビューごとに視差ずらしで overlay → xstack）を
// 任意枚数のレイヤー・タイミング・音声に一般化したもの。中間ファイルは作らない。
'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('./core');

let ffmpegPath = 'ffmpeg';
let ffprobePath = 'ffprobe';

function setPaths(ffmpeg) {
  ffmpegPath = ffmpeg || 'ffmpeg';
  if (!ffmpeg || ffmpeg === 'ffmpeg') {
    ffprobePath = 'ffprobe';
  } else {
    const dir = path.dirname(ffmpeg);
    const ext = path.extname(ffmpeg);
    ffprobePath = path.join(dir, `ffprobe${ext}`);
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: opts.encoding || 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else resolve(stdout);
    });
  });
}

async function checkFfmpeg() {
  try {
    const out = await run(ffmpegPath, ['-hide_banner', '-version']);
    const encoders = await run(ffmpegPath, ['-hide_banner', '-encoders']);
    return {
      ok: true,
      version: out.split('\n')[0].trim(),
      encoders: ['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc', 'h264_videotoolbox', 'hevc_videotoolbox'].filter((e) => encoders.includes(` ${e} `)),
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ffmpeg を自動で探す（PATH → OS ごとのよくあるインストール先）
// macOS では Finder から起動したアプリに Homebrew の PATH が渡らないため、絶対パスも候補にする
function findFfmpegCandidates() {
  const list = ['ffmpeg'];
  const add = (p) => {
    if (fs.existsSync(p) && !list.includes(p)) list.push(p);
  };
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) add(path.join(r, 'ffmpeg', 'bin', 'ffmpeg.exe'));
    if (process.env.LOCALAPPDATA) {
      // winget（Gyan.FFmpeg）のインストール先
      const pk = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
      try {
        for (const d of fs.readdirSync(pk).filter((n) => /ffmpeg/i.test(n))) {
          for (const sub of fs.readdirSync(path.join(pk, d))) add(path.join(pk, d, sub, 'bin', 'ffmpeg.exe'));
        }
      } catch { /* なし */ }
    }
    if (process.env.ChocolateyInstall) add(path.join(process.env.ChocolateyInstall, 'bin', 'ffmpeg.exe'));
  } else {
    for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/local/bin/ffmpeg', '/usr/bin/ffmpeg', '/snap/bin/ffmpeg']) add(p);
  }
  return list;
}

function parseRate(r) {
  if (!r || r === '0/0') return 0;
  const [a, b] = r.split('/').map(Number);
  return b ? a / b : a;
}

async function probe(file) {
  const out = await run(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const fmt = j.format || {};
  const isImage = core.isImagePath(file) || /image2|_pipe$/.test(fmt.format_name || '');
  let width = v ? v.width : 0;
  let height = v ? v.height : 0;
  // スマホ動画などの回転メタデータ（ffmpeg は自動回転するので幅・高さを入れ替える）
  const rot = v && v.side_data_list ? (v.side_data_list.find((s) => s.rotation !== undefined) || {}).rotation : 0;
  if (rot && Math.abs(rot) % 180 === 90) [width, height] = [height, width];
  return {
    path: file,
    isImage,
    hasVideo: !!v,
    width,
    height,
    fps: v ? parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) : 0,
    duration: isImage ? 0 : Number(fmt.duration || (v && v.duration) || (a && a.duration) || 0),
    videoCodec: v ? v.codec_name : '',
    pixFmt: v ? v.pix_fmt : '',
    hasAudio: !!a,
    audioCodec: a ? a.codec_name : '',
    sampleRate: a ? Number(a.sample_rate) : 0,
    channels: a ? a.channels : 0,
  };
}

// プレビュー用: 指定時刻の1フレームを PNG で取得（ブラウザで再生できない ProRes などの素材用）
function grabFrame(file, t, maxW) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-v', 'error'];
    if (t > 0) args.push('-ss', t.toFixed(3));
    args.push('-i', file, '-frames:v', '1', '-vf', `scale='min(${maxW},iw)':-2:flags=bilinear`, '-f', 'image2pipe', '-c:v', 'png', 'pipe:1');
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    const chunks = [];
    let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      if (buf.length) resolve(buf);
      else reject(new Error(err || `ffmpeg exited ${code}`));
    });
  });
}

// ---------------------------------------------------------------- build
const n3 = (x) => Number(x.toFixed(3));
const ffcolor = (hex) => `0x${core.hexToRgb(hex).map((c) => c.toString(16).padStart(2, '0')).join('')}`;
const quoteArg = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

// 最大ループ回数（ループ区間ごとに入力を1つ追加するため）
const MAX_LOOP_INPUTS = 120;

function buildExport(project, mediaMap, outPath, encoders) {
  const geo = core.geometry(project);
  const fps = core.projectFps(project, mediaMap);
  const dur = core.projectDuration(project, mediaMap);
  const N = geo.n;
  const inputs = []; // ffmpeg 引数の配列の配列
  const graph = [];
  const warnings = [];

  const addInput = (args) => {
    inputs.push(args);
    return inputs.length - 1;
  };

  // 素材の区間 [in, in+L] を入力として追加し、ループなら必要回数ぶん並べて concat する。
  // 戻り値は filter グラフ内のラベル（型 v / a）。
  function addSegmentSource(file, media, opts, type, labelBase) {
    const inP = Number(opts.in || 0);
    const L = opts.L;
    const full = inP <= 0 && (!(opts.out > 0) || opts.out >= (media.duration || Infinity));
    if (opts.loop) {
      const need = Math.max(0, dur - Number(opts.start || 0));
      const count = Math.ceil(need / L - 1e-6);
      if (full || count > MAX_LOOP_INPUTS) {
        if (!full) warnings.push(`${core.baseName(file)}: ループ回数が多いため、区間ではなく素材全体をループします`);
        const idx = addInput(['-stream_loop', '-1', ...(inP > 0 ? ['-ss', String(n3(inP))] : []), '-i', file]);
        return `${idx}:${type}`;
      }
      if (count <= 1) {
        const idx = addInput([...(inP > 0 ? ['-ss', String(n3(inP))] : []), '-t', String(n3(L)), '-i', file]);
        return `${idx}:${type}`;
      }
      const labels = [];
      for (let k = 0; k < count; k++) {
        const idx = addInput([...(inP > 0 ? ['-ss', String(n3(inP))] : []), '-t', String(n3(L)), '-i', file]);
        labels.push(`[${idx}:${type}]`);
      }
      const out = `${labelBase}cat`;
      graph.push(`${labels.join('')}concat=n=${count}:v=${type === 'v' ? 1 : 0}:a=${type === 'a' ? 1 : 0}[${out}]`);
      return out;
    }
    const args = [];
    if (inP > 0) args.push('-ss', String(n3(inP)));
    if (!full) args.push('-t', String(n3(L)));
    args.push('-i', file);
    return `${addInput(args)}:${type}`;
  }

  // ---- 背景（単色）
  const baseLabels = [];
  for (let i = 0; i < N; i++) baseLabels.push(`[base${i}]`);
  graph.push(`color=c=${ffcolor(project.bgColor)}:s=${geo.dw}x${geo.vh}:r=${fps}:d=${n3(dur)},format=gbrp${N > 1 ? `,split=${N}${baseLabels.join('')}` : '[base0]'}`);

  // ---- レイヤー
  const order = core.drawOrder(project);
  const layerInfo = [];
  order.forEach((layer, li) => {
    const media = mediaMap[layer.path];
    if (!media) {
      warnings.push(`${layer.name}: 素材情報がありません（スキップ）`);
      return;
    }
    const box = core.layerBox(layer, media, project, geo);
    const f = [];
    let src;
    if (layer.kind === 'image') {
      src = `${addInput(['-loop', '1', '-framerate', String(fps), '-i', layer.path])}:v`;
      if (layer.duration > 0 && layer.endMode === 'hide') f.push(`trim=duration=${n3(layer.duration)}`);
    } else {
      const L = core.segLength(layer, media);
      src = addSegmentSource(layer.path, media, { in: layer.in, out: layer.out, L, loop: layer.endMode === 'loop', start: layer.start }, 'v', `l${li}`);
      f.push(`fps=${fps}`);
    }
    f.push(`setpts=PTS-STARTPTS+${n3(Number(layer.start || 0))}/TB`);
    const c = layer.crop;
    if (c.l || c.r || c.t || c.b) {
      const fw = n3(1 - (c.l + c.r) / 100);
      const fh = n3(1 - (c.t + c.b) / 100);
      f.push(`crop=iw*${fw}:ih*${fh}:iw*${n3(c.l / 100)}:ih*${n3(c.t / 100)}`);
    }
    if (layer.key.enabled) f.push(`chromakey=${ffcolor(layer.key.color)}:${layer.key.similarity}:${layer.key.blend}`);
    f.push('format=rgba');
    if (layer.flipH) f.push('hflip');
    if (layer.flipV) f.push('vflip');
    f.push(`scale=${box.w}:${box.h}:flags=lanczos`);
    if (layer.opacity < 100) f.push(`colorchannelmixer=aa=${n3(layer.opacity / 100)}`);
    if (box.rot) {
      const a = `${n3(box.rot)}*PI/180`;
      f.push(`rotate=${a}:ow=rotw(${a}):oh=roth(${a}):c=none`);
    }
    const labels = [];
    for (let i = 0; i < N; i++) labels.push(`[l${li}v${i}]`);
    f.push(N > 1 ? `split=${N}${labels.join('')}` : `null${labels[0]}`);
    graph.push(`[${src}]${f.join(',')}`);
    layerInfo.push({ li, layer, box, eof: layer.endMode === 'hold' ? 'repeat' : 'pass' });
  });

  // ---- ビューごとの合成
  const viewLabels = [];
  for (let i = 0; i < N; i++) {
    let cur = `base${i}`;
    layerInfo.forEach(({ li, layer, box, eof }, k) => {
      const x = box.cx + core.shiftAt(layer, project, geo, i);
      const out = `c${i}_${k}`;
      graph.push(`[${cur}][l${li}v${i}]overlay=x=${n3(x)}-w/2:y=${n3(box.cy)}-h/2:eof_action=${eof}:format=gbrp[${out}]`);
      cur = out;
    });
    const scale = geo.dw !== geo.vw ? `scale=${geo.vw}:${geo.vh}:flags=lanczos` : 'null';
    graph.push(`[${cur}]${scale}[v${i}]`);
    viewLabels.push(`[v${i}]`);
  }
  if (N > 1) {
    // view 0 = 左下、最後のビュー = 右上
    const layout = [];
    for (let i = 0; i < N; i++) {
      const col = i % geo.cols;
      const row = Math.floor(i / geo.cols);
      layout.push(`${col * geo.vw}_${(geo.rows - 1 - row) * geo.vh}`);
    }
    graph.push(`${viewLabels.join('')}xstack=inputs=${N}:layout=${layout.join('|')}:fill=black,format=yuv420p[vout]`);
  } else {
    graph.push('[v0]format=yuv420p[vout]');
  }

  // ---- 音声
  const au = project.audio;
  let audioArgs = [];
  let ext = 'mp4';
  let audioDesc = 'なし';
  const v = core.migrateVideo(Object.assign({}, project.video));
  const isProres = v.format === 'prores422hq';
  if (isProres) ext = 'mov';
  let audioSrc = null; // { file, media, in, start, loop, L }
  if (au.mode === 'layer') {
    const layer = project.layers.find((l) => l.id === au.layerId);
    const media = layer && mediaMap[layer.path];
    if (layer && media && media.hasAudio && layer.kind === 'video') {
      audioSrc = { file: layer.path, media, in: layer.in, out: layer.out, start: layer.start, loop: layer.endMode === 'loop', L: core.segLength(layer, media) };
    } else if (layer) warnings.push('音声に指定したレイヤーに音声がありません');
  } else if (au.mode === 'file' && au.path) {
    const media = mediaMap[au.path];
    if (media && media.hasAudio) {
      audioSrc = { file: au.path, media, in: au.in, out: 0, start: au.start, loop: false, L: Math.max(0.001, media.duration - (au.in || 0)) };
    } else warnings.push('音声ファイルを読み込めません');
  }
  if (audioSrc) {
    const m = audioSrc.media;
    const processed = audioSrc.in > 0 || audioSrc.start > 0 || audioSrc.loop || audioSrc.out > 0 || au.volume || au.fadeIn > 0 || au.fadeOut > 0;
    let codec = au.codec;
    const copyable = isProres ? ['aac', 'alac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le'] : ['aac', 'mp3', 'alac', 'ac3'];
    // ProRes（マスター用）は音声も無劣化: 加工なしならコピー、それ以外は PCM 24bit
    if (codec === 'auto') codec = !processed && copyable.includes(m.audioCodec) ? 'copy' : isProres ? 'pcm' : 'aac';
    if (codec === 'copy' && (processed || !copyable.includes(m.audioCodec))) {
      warnings.push('音声に加工があるか、MP4にそのまま入れられない形式のため、コピーではなく AAC 320kbps で書き出します');
      codec = 'aac';
    }
    if (codec === 'copy') {
      const idx = addInput(['-i', audioSrc.file]);
      audioArgs = ['-map', `${idx}:a:0`, '-c:a', 'copy'];
      audioDesc = `${m.audioCodec} をそのままコピー（無劣化）`;
    } else {
      const src = addSegmentSource(audioSrc.file, m, audioSrc, 'a', 'au');
      const f = ['asetpts=PTS-STARTPTS'];
      if (audioSrc.start > 0) f.push(`adelay=${Math.round(audioSrc.start * 1000)}:all=1`);
      if (au.volume) f.push(`volume=${au.volume}dB`);
      if (au.fadeIn > 0) f.push(`afade=t=in:st=${n3(audioSrc.start || 0)}:d=${n3(au.fadeIn)}`);
      if (au.fadeOut > 0) f.push(`afade=t=out:st=${n3(Math.max(0, dur - au.fadeOut))}:d=${n3(au.fadeOut)}`);
      f.push(`atrim=end=${n3(dur)}`);
      graph.push(`[${src}]${f.join(',')}[aout]`);
      audioArgs = ['-map', '[aout]'];
      if (codec === 'pcm') {
        audioArgs.push('-c:a', 'pcm_s24le');
        ext = 'mov';
        audioDesc = 'PCM 24bit（無劣化 / .mov）';
      } else if (codec === 'alac') {
        audioArgs.push('-c:a', 'alac');
        audioDesc = 'ALAC（無劣化）';
      } else {
        audioArgs.push('-c:a', 'aac', '-b:a', '320k');
        audioDesc = 'AAC 320kbps';
      }
    }
  }

  // ---- 映像エンコーダ
  // Looking Glass Bridge / Studio は NVIDIA のハードウェアデコード（NVDEC）で再生する。
  // 実測で再生できたのは H.264 / HEVC の 4:2:0 8bit。10bit・ProRes は不可、4:4:4 は Studio で緑色に崩れる。
  const big = geo.qw > 4096 || geo.qh > 4096;
  let format = v.format;
  if (format === 'h264' && big) {
    warnings.push('quilt が 4096px を超えるため H.264 はハードウェアデコードできません。HEVC で書き出します');
    format = 'hevc420';
  }
  // Studio 変換用: HEVC 4:2:0 を品質4（ほぼ劣化なし）で
  const master = format === 'hevc420_master';
  if (master) format = 'hevc420';
  const has = (e) => !encoders || !encoders.length || encoders.includes(e);
  // GPU エンコーダ: Windows / Linux は NVENC、macOS は VideoToolbox
  const mac = process.platform === 'darwin';
  let gpuName;
  if (mac) gpuName = format === 'h264' ? 'h264_videotoolbox' : format === 'hevc420' ? 'hevc_videotoolbox' : null;
  else gpuName = format === 'h264' ? 'h264_nvenc' : 'hevc_nvenc';
  const cpuName = format === 'h264' ? 'libx264' : 'libx265';
  let useGpu = !!gpuName && (v.encoder === 'gpu' || (v.encoder === 'auto' && has(gpuName)));
  if (v.encoder === 'gpu' && !gpuName) warnings.push(`この形式は GPU エンコードに対応していないため CPU（${cpuName}）で書き出します`);
  if (useGpu && !has(gpuName)) {
    warnings.push(`${gpuName} が使えないため CPU（${cpuName}）で書き出します`);
    useGpu = false;
  }
  const enc = useGpu ? gpuName : cpuName;
  const crf = String(master ? 4 : Math.max(useGpu ? 1 : 0, Number(v.crf)));
  const pix = 'yuv420p';
  let videoArgs;
  if (isProres) {
    // ProRes 422 HQ（Studio の変換はソフトウェアデコードなので読める。Bridge での直接再生は不可）
    // prores_aw は prores_ks より約3倍速い（画質差はわずか）
    videoArgs = ['-c:v', 'prores_aw', '-profile:v', '3', '-vendor', 'apl0'];
  } else if (useGpu && mac) {
    // VideoToolbox の固定品質（1〜100、大きいほど高画質）に品質値を換算
    videoArgs = ['-c:v', enc, '-q:v', String(Math.round(Math.min(100, Math.max(1, 100 - Number(crf) * 2.5)))), '-allow_sw', '0'];
    if (format === 'hevc420') videoArgs.push('-profile:v', 'main');
  } else if (useGpu) {
    videoArgs = ['-c:v', enc, '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', crf, '-b:v', '0', '-spatial-aq', '1'];
    if (format === 'hevc420') videoArgs.push('-profile:v', 'main');
    else videoArgs.push('-profile:v', 'high');
  } else if (format === 'h264') {
    videoArgs = ['-c:v', 'libx264', '-preset', v.speed, '-crf', crf, '-profile:v', 'high'];
  } else {
    videoArgs = ['-c:v', 'libx265', '-preset', v.speed, '-crf', crf];
  }
  if (format !== 'h264' && !isProres) videoArgs.push('-tag:v', 'hvc1');
  videoArgs.push('-pix_fmt', isProres ? 'yuv422p10le' : pix);

  if (outPath && ext === 'mov' && !/\.mov$/i.test(outPath)) outPath = outPath.replace(/\.[^.\\/]+$/, '.mov');

  const filterText = graph.join(';\n');
  const args = ['-hide_banner', '-y'];
  inputs.forEach((a) => args.push(...a));
  return {
    geo, fps, dur, ext, enc: isProres ? 'ProRes 422 HQ / yuv422p10le' : `${enc} / ${pix}${master ? ' / 品質4' : ''}`, audioDesc, warnings, filterText, outPath,
    // filter は長くなるのでファイル経由で渡す（-/filter_complex は ffmpeg 7.1 以降。古い版は -filter_complex_script）
    makeArgs(filterFile, legacy) {
      return [
        ...args,
        legacy ? '-filter_complex_script' : '-/filter_complex', filterFile,
        '-map', '[vout]', ...audioArgs, ...videoArgs,
        '-r', String(fps), '-t', String(n3(dur)),
        '-movflags', '+faststart',
        '-progress', 'pipe:1', '-nostats',
        outPath,
      ];
    },
  };
}

// ---------------------------------------------------------------- export
let current = null;

async function supportsNewFilterSyntax() {
  // ffmpeg 7.1 以降は -/option file 構文に対応
  try {
    const v = await run(ffmpegPath, ['-hide_banner', '-version']);
    const m = /ffmpeg version (?:n)?(\d+)\.(\d+)/.exec(v);
    if (m) return Number(m[1]) > 7 || (Number(m[1]) === 7 && Number(m[2]) >= 1);
    return /ffmpeg version N-/.test(v); // 開発版ビルド
  } catch {
    return true;
  }
}

async function startExport(project, mediaMap, outPath, encoders, onProgress) {
  if (current) throw new Error('書き出し中です');
  const job = buildExport(project, mediaMap, outPath, encoders);
  const filterFile = path.join(os.tmpdir(), `lgqg_filter_${process.pid}_${Date.now()}.txt`);
  fs.writeFileSync(filterFile, job.filterText, 'utf8');
  const legacy = !(await supportsNewFilterSyntax());
  const args = job.makeArgs(filterFile, legacy);
  fs.mkdirSync(path.dirname(job.outPath), { recursive: true });

  return new Promise((resolve) => {
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    current = { proc: p, cancelled: false };
    const started = Date.now();
    let log = '';
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m) {
          const t = Number(m[1]) / 1e6;
          const ratio = Math.min(1, t / job.dur);
          const elapsed = (Date.now() - started) / 1000;
          onProgress({ ratio, time: t, elapsed, eta: ratio > 0.01 ? (elapsed / ratio) * (1 - ratio) : null });
        }
        const fm = /^fps=([\d.]+)/.exec(line);
        if (fm) onProgress({ fps: Number(fm[1]) });
      }
    });
    p.stderr.on('data', (d) => {
      log += d.toString();
      if (log.length > 200000) log = log.slice(-100000);
    });
    const finish = (code, error) => {
      fs.rm(filterFile, { force: true }, () => {});
      const cancelled = current && current.cancelled;
      current = null;
      if (cancelled) fs.rm(job.outPath, { force: true }, () => {});
      resolve({
        ok: code === 0 && !cancelled,
        cancelled,
        code,
        error,
        outPath: job.outPath,
        log: log.slice(-8000),
        elapsed: (Date.now() - started) / 1000,
        warnings: job.warnings,
      });
    };
    p.on('error', (e) => finish(-1, String(e.message)));
    p.on('close', (code) => finish(code));
  });
}

function cancelExport() {
  if (!current) return false;
  current.cancelled = true;
  try {
    current.proc.stdin.write('q');
  } catch { /* noop */ }
  const proc = current.proc;
  setTimeout(() => { try { proc.kill(); } catch { /* noop */ } }, 1500);
  return true;
}

function describeCommand(project, mediaMap, outPath, encoders) {
  const job = buildExport(project, mediaMap, outPath, encoders);
  const args = job.makeArgs('filter.txt', false).filter((a, i, arr) => !(a === '-progress' || arr[i - 1] === '-progress' || a === '-nostats'));
  return {
    command: [path.basename(ffmpegPath) === ffmpegPath ? ffmpegPath : quoteArg(ffmpegPath), ...args.map(quoteArg)].join(' '),
    filterText: job.filterText,
    summary: { geo: job.geo, fps: job.fps, dur: job.dur, enc: job.enc, audio: job.audioDesc, outPath: job.outPath, warnings: job.warnings, inputs: (job.filterText.match(/\[\d+:[va]\]/g) || []).length },
  };
}

module.exports = { setPaths, checkFfmpeg, findFfmpegCandidates, probe, grabFrame, buildExport, startExport, cancelExport, describeCommand, getPath: () => ffmpegPath };
