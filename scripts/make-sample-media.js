'use strict';
// Genera vídeos i fotos de prova per al guió d'exemple (cal ffmpeg al PATH).
// Ús: node scripts/make-sample-media.js [carpeta del guió]

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { makeLogger } = require('../src/common/log');

const log = makeLogger('mostres');
const showDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'show'));

const VIDEOS = [
  { file: 'media/video/cap1.mp4', color: '0x3355aa', freq: 440, seconds: 8 },
  { file: 'media/video/cap2a.mp4', color: '0x2e8b57', freq: 523, seconds: 8 },
  { file: 'media/video/cap2b.mp4', color: '0x8b3a3a', freq: 587, seconds: 8 },
  { file: 'media/video/cap3.mp4', color: '0x6a3d9a', freq: 698, seconds: 6 },
  { file: 'media/video/final.mp4', color: '0xb8860b', freq: 659, seconds: 10 },
];
const PHOTOS = { dir: 'media/records/P3', count: 5 };
// Retrats de prova per a l'entrada triomfal (en real: la foto actual de cada nen).
const PORTRAITS = [
  { id: 'anna', c0: '0xe84a5f', c1: '0x5b2a86' },
  { id: 'biel', c0: '0x2a9df4', c1: '0x123c69' },
  { id: 'carla', c0: '0x3cb371', c1: '0x1d4e35' },
  { id: 'dani', c0: '0xf39c12', c1: '0x7a3e0c' },
  { id: 'emma', c0: '0xd35fb7', c1: '0x3b1f5e' },
  { id: 'ferran', c0: '0x1abc9c', c1: '0x0e3b4a' },
];

// Només alguns nens tenen vídeo d'entrada a l'exemple, per provar els dos casos.
const ENTRY_VIDEOS = 4;

function fontFile() {
  try {
    return execFileSync('fc-match', ['-f', '%{file}', 'DejaVu Sans:bold']).toString().trim() || null;
  } catch (err) {
    return null;
  }
}

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y'].concat(args), { stdio: 'inherit' });
}

function main() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch (err) {
    log.error('No es troba ffmpeg. Instal·la\'l i torna-ho a provar.');
    process.exit(1);
  }
  for (const v of VIDEOS) {
    const out = path.join(showDir, v.file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // Fons de color + rellotge de prova + to, en H.264/AAC 1280x720 (el format recomanat).
    ffmpeg([
      '-f', 'lavfi', '-i', 'color=c=' + v.color + ':s=1280x720:r=30:d=' + v.seconds,
      '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=' + v.seconds,
      '-f', 'lavfi', '-i', 'sine=frequency=' + v.freq + ':duration=' + v.seconds,
      '-filter_complex', '[0][1]overlay=(W-w)/2:(H-h)/2[v]',
      '-map', '[v]', '-map', '2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-preset', 'veryfast',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-shortest', out,
    ]);
    log.info('Vídeo creat: ' + v.file);
  }
  const photoDir = path.join(showDir, PHOTOS.dir);
  fs.mkdirSync(photoDir, { recursive: true });
  for (let i = 1; i <= PHOTOS.count; i++) {
    const out = path.join(photoDir, 'foto' + String(i).padStart(2, '0') + '.jpg');
    const hue = (i * 70) % 360;
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720', '-frames:v', '1', '-vf', 'hue=h=' + hue, out]);
  }
  log.info('Fotos creades a ' + PHOTOS.dir);

  const font = fontFile();
  const portraitDir = path.join(showDir, 'media', 'fotos');
  fs.mkdirSync(portraitDir, { recursive: true });
  for (const p of PORTRAITS) {
    const out = path.join(portraitDir, p.id + '.jpg');
    let vf = 'format=yuv420p';
    if (font) {
      const text = p.id.slice(0, 1).toUpperCase() + p.id.slice(1, 2);
      vf = "drawtext=fontfile='" + font + "':text='" + text + "':fontsize=260:fontcolor=white@0.85:x=(w-tw)/2:y=(h-th)/2," + vf;
    }
    ffmpeg(['-f', 'lavfi', '-i', 'gradients=s=600x800:c0=' + p.c0 + ':c1=' + p.c1 + ':x0=0:y0=0:x1=600:y1=800:d=1',
      '-frames:v', '1', '-vf', vf, out]);
  }
  log.info('Retrats creats a media/fotos' + (font ? '' : ' (sense inicials: no s\'ha trobat cap font)'));

  // Vídeos d'entrada de prova (en real: resum del pas de cada nen per l'escola amb la seva música).
  const entryDir = path.join(showDir, 'media', 'entrada');
  fs.mkdirSync(entryDir, { recursive: true });
  PORTRAITS.slice(0, ENTRY_VIDEOS).forEach((p, i) => {
    const out = path.join(entryDir, p.id + '.mp4');
    ffmpeg([
      '-loop', '1', '-framerate', '30', '-t', '5', '-i', path.join(portraitDir, p.id + '.jpg'),
      '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=5',
      '-f', 'lavfi', '-i', 'sine=frequency=' + (330 + i * 110) + ':duration=5',
      '-filter_complex',
      '[0]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=' + p.c1 +
      ',format=yuv420p[bg];[bg][1]overlay=W-w-40:40[v]',
      '-map', '[v]', '-map', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-shortest', out,
    ]);
  });
  log.info('Vídeos d\'entrada creats a media/entrada (' + ENTRY_VIDEOS + ' de ' + PORTRAITS.length + ')');

  const effect = path.join(showDir, 'media', 'so', 'entrada.mp3');
  fs.mkdirSync(path.dirname(effect), { recursive: true });
  // "Ding" curt de dues notes per a cada nen que entra.
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.25', '-f', 'lavfi', '-i', 'sine=frequency=1320:duration=0.5',
    '-filter_complex', '[0][1]concat=n=2:v=0:a=1,afade=t=out:st=0.45:d=0.3,volume=0.4', effect]);
  log.info('Efecte de so creat: media/so/entrada.mp3');
}

main();
