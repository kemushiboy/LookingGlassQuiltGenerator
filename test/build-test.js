// 書き出しロジックの動作確認: テスト素材を生成 → プロジェクトを組む → ffmpeg で書き出し → 結果を検査
// 実行: npm test   （ffmpeg / ffprobe が PATH にあること）
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const core = require('../src/core');
const ff = require('../src/ffmpeg');

const dir = path.join(__dirname, 'tmp');
fs.mkdirSync(dir, { recursive: true });
const P = (n) => path.join(dir, n);
const sh = (args) => execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args]);

function makeMedia() {
  if (!fs.existsSync(P('fg_alpha.mov'))) {
    // アルファ付き前景（ProRes 4444 相当として qtrle）＋ PCM 音声
    sh(['-f', 'lavfi', '-i', "color=c=red:s=480x640:r=30,format=rgba,geq=r='255':g='60':b='60':a='if(lt(hypot(X-240-120*sin(T*3),Y-320),110),255,0)'",
      '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000', '-t', '3', '-c:v', 'qtrle', '-c:a', 'pcm_s24le', P('fg_alpha.mov')]);
  }
  if (!fs.existsSync(P('bg.png'))) sh(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080', '-frames:v', '1', P('bg.png')]);
  if (!fs.existsSync(P('mid.mp4'))) {
    sh(['-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=660:sample_rate=44100:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', P('mid.mp4')]);
  }
  if (!fs.existsSync(P('music.wav'))) sh(['-f', 'lavfi', '-i', 'sine=f=330:sample_rate=48000:d=10', '-c:a', 'pcm_s16le', P('music.wav')]);
}

async function main() {
  ff.setPaths('ffmpeg');
  const info = await ff.checkFfmpeg();
  console.log(info.version, info.encoders);
  makeMedia();

  const project = core.defaultProject();
  project.preset = process.argv[2] || 'portrait';
  project.durationMode = 'custom';
  project.durationCustom = 5;
  project.output.name = process.env.QG_FORMAT ? `test_${process.env.QG_FORMAT}` : 'test';
  if (process.env.QG_FORMAT) project.video.format = process.env.QG_FORMAT;

  const bg = core.defaultLayer(P('bg.png'), 'image');
  Object.assign(bg, { z: 6, fit: 'cover', overscan: true });
  const mid = core.defaultLayer(P('mid.mp4'), 'video');
  Object.assign(mid, { z: 2, scale: 45, x: -20, y: 25, rotation: 10, opacity: 85, in: 1, out: 2.5, endMode: 'loop', start: 0.5, crop: { l: 10, r: 0, t: 0, b: 10 } });
  const fg = core.defaultLayer(P('fg_alpha.mov'), 'video');
  Object.assign(fg, { z: 0, endMode: 'hold' });
  project.layers = [fg, mid, bg];
  project.audio = Object.assign(project.audio, { mode: 'file', path: P('music.wav'), start: 0.25, fadeOut: 1, codec: 'auto' });

  const mediaMap = {};
  for (const p of [P('bg.png'), P('mid.mp4'), P('fg_alpha.mov'), P('music.wav')]) mediaMap[p] = await ff.probe(p);

  const out = path.join(dir, core.outputFileName(project, project.video.format === 'prores422hq' ? 'mov' : 'mp4'));
  const desc = ff.describeCommand(project, mediaMap, out, info.encoders);
  fs.writeFileSync(path.join(dir, 'filter.txt'), desc.filterText);
  console.log(desc.command);
  console.log(desc.summary);

  const r = await ff.startExport(project, mediaMap, out, info.encoders, (p) => {
    if (p.ratio !== undefined) process.stdout.write(`\r${(p.ratio * 100).toFixed(1)}%   `);
  });
  console.log('\n', r.ok ? 'OK' : r.log, r.elapsed, 's', r.warnings);
  if (!r.ok) process.exit(1);
  const o = await ff.probe(r.outPath);
  console.log(o.width, 'x', o.height, o.fps, 'fps', o.duration, 's', o.videoCodec, o.audioCodec);
  for (const t of [0.2, 1.2, 4.5]) {
    sh(['-ss', String(t), '-i', r.outPath, '-frames:v', '1', '-vf', 'scale=1024:-1', P(`frame_${t}.png`)]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
