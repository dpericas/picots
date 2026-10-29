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
  { file: 'media/video/final.mp4', color: '0xb8860b', freq: 659, seconds: 10 },
];
const PHOTOS = { dir: 'media/records/P3', count: 5 };

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
}

main();
