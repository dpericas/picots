'use strict';
// Vídeo lineal de reserva: tot l'espectacle en un sol MP4 (amb capítols) per
// reproduir-lo amb VLC des d'un USB si falla el portàtil.
// S'executa amb Electron (per dibuixar les targetes) i cal ffmpeg 5+.
//
// Ús: npm run backup-video -- [opcions]
//   --show=carpeta         guió (per defecte ./show)
//   --out=fitxer.mp4       per defecte reserva/gala-reserva.mp4 (al costat de show/)
//   --branques=vot1:B,vot2:0   opció de cada votació (lletra o índex); per defecte, per_defecte
//   --repte=exit|no        com acaben els reptes (per defecte exit)
//   --res=1920x1080        resolució
//   --ffmpeg=ruta          si ffmpeg no és al PATH (també FFMPEG_PATH)

const { app, BrowserWindow } = require('electron');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { makeLogger } = require('../src/common/log');
const { loadShow, hasErrors } = require('../src/engine/show');
const bv = require('../src/tools/backup-video');

const log = makeLogger('reserva');

function arg(name) {
  const prefix = '--' + name + '=';
  const a = process.argv.find((x) => x.startsWith(prefix));
  return a ? a.slice(prefix.length) : null;
}

const ffmpegBin = arg('ffmpeg') || process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobeBin = path.basename(ffmpegBin).startsWith('ffmpeg')
  ? path.join(path.dirname(ffmpegBin), path.basename(ffmpegBin).replace(/^ffmpeg/, 'ffprobe')) : 'ffprobe';

function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || '').trim().split('\n').slice(-3).join(' | ') || bin + ' ha fallat');
  return r.stdout;
}
const ffmpeg = (args) => run(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-y'].concat(args));

function probe(file) {
  const out = JSON.parse(run(ffprobeBin, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file]));
  return { duration: Number(out.format.duration) || 0, audio: (out.streams || []).some((s) => s.codec_type === 'audio') };
}

function parseChoices(show) {
  const votes = {};
  (arg('branques') || '').split(',').filter(Boolean).forEach((pair) => {
    const [id, value] = pair.split(':');
    const v = String(value || '').trim().toUpperCase();
    if (!v) {
      log.warn('--branques: «' + id + '» sense opció; s\'usa la per defecte.');
      return;
    }
    votes[id] = /^[A-D]$/.test(v) ? v.charCodeAt(0) - 65 : Number(v);
    if (!show.cues.some((c) => c.id === id && c.type === 'vote')) log.warn('--branques: «' + id + '» no és cap votació.');
  });
  return { votes, challenge: arg('repte') === 'no' ? 'fail' : 'success' };
}

// --- Targetes (HTML -> PNG amb una finestra fora de pantalla) ---
const TONES = {
  hold: ['#000', '#000'], vote: ['#283050', '#0b0d16'], parade: ['#3a2d5c', '#05040b'], awards: ['#5c4a1d', '#0b0803'],
  quiz: ['#2b2350', '#0b0916'], challenge: ['#1d4e35', '#07140d'], wall: ['#23305a', '#090c18'],
};

function esc(t) {
  return String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function cardHtml(c) {
  const [c0, c1] = TONES[c.tone] || TONES.hold;
  const photo = c.photo && fs.existsSync(c.photo)
    ? '<img class="photo" src="' + esc(pathToFileURL(c.photo).href) + '">' : '';
  const items = (c.items || []).map((it) => '<li class="' + (it.mark ? 'mark' : '') + '">' + esc(it.text) + '</li>').join('');
  return '<!doctype html><meta charset="utf-8"><style>' +
    'html,body{margin:0;width:100vw;height:100vh;overflow:hidden;color:#fff;font-family:"Segoe UI",system-ui,sans-serif}' +
    'body{background:radial-gradient(ellipse 60% 70% at 50% 40%,' + c0 + ' 0%,' + c1 + ' 100%);display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;text-align:center;gap:3vh;padding:0 6vw;box-sizing:border-box}' +
    '.sub{font-size:4vh;color:#ffcc33;font-weight:700}h1{font-size:' + (c.items ? '6vh' : '9vh') + ';margin:0;line-height:1.15}' +
    '.photo{height:46vh;max-width:60vw;border-radius:2vh;border:.8vh solid #ffcc33;object-fit:cover}' +
    'ul{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:1fr 1fr;gap:2vh 2vw;width:80vw}' +
    'li{font-size:4vh;font-weight:700;padding:2vh 2vw;border-radius:1.5vh;background:rgba(255,255,255,.1);text-align:left}' +
    'li.mark{background:#ffcc33;color:#000}' +
    '</style><body>' + (c.subtitle && c.tone !== 'awards' ? '<div class="sub">' + esc(c.subtitle) + '</div>' : '') + photo +
    '<h1>' + esc(c.title) + '</h1>' + (c.subtitle && c.tone === 'awards' ? '<div class="sub">' + esc(c.subtitle) + '</div>' : '') +
    (items ? '<ul>' + items + '</ul>' : '') + '</body>';
}

async function renderCard(win, card, file, tmp) {
  const html = path.join(tmp, path.basename(file, '.png') + '.html');
  fs.writeFileSync(html, cardHtml(card));
  await win.loadFile(html);
  await win.webContents.executeJavaScript(
    'Promise.all(Array.from(document.images).map((i) => i.complete ? 0 : new Promise((r) => { i.onload = r; i.onerror = r; })))');
  await new Promise((r) => setTimeout(r, 120));
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
}

// --- Segments normalitzats (mateix còdec i paràmetres per poder-los concatenar sense recodificar) ---
function videoOut(W, H) {
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
    '-video_track_timescale', '15360', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'];
}
const SCALE = (W, H) => 'scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease,pad=' + W + ':' + H +
  ':(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p';
const AFMT = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';

function audioInput(audio, seconds) {
  if (audio && fs.existsSync(audio)) {
    return {
      args: ['-t', String(seconds), '-i', audio],
      filter: AFMT + ',afade=t=in:d=0.3,afade=t=out:st=' + Math.max(0, seconds - 1) + ':d=1,apad',
    };
  }
  return { args: ['-f', 'lavfi', '-t', String(seconds), '-i', 'anullsrc=r=48000:cl=stereo'], filter: AFMT };
}

function encodeSegment(seg, out, W, H) {
  if (seg.kind === 'video') {
    const info = probe(seg.file);
    const args = ['-i', seg.file];
    let a = '[0:a]' + AFMT + ',apad[a]'; // àudio més curt que la imatge: s'omple de silenci
    if (!info.audio) {
      args.push('-f', 'lavfi', '-t', String(info.duration), '-i', 'anullsrc=r=48000:cl=stereo');
      a = '[1:a]' + AFMT + '[a]';
    }
    ffmpeg(args.concat(['-filter_complex', '[0:v]' + SCALE(W, H) + '[v];' + a, '-map', '[v]', '-map', '[a]',
      '-t', String(info.duration)], videoOut(W, H), [out]));
    return;
  }
  if (seg.kind === 'card') {
    const au = audioInput(seg.audio, seg.seconds);
    ffmpeg(['-loop', '1', '-framerate', '30', '-t', String(seg.seconds), '-i', seg.png].concat(au.args,
      ['-filter_complex', '[0:v]' + SCALE(W, H) + '[v];[1:a]' + au.filter + '[a]',
        '-map', '[v]', '-map', '[a]', '-t', String(seg.seconds)], videoOut(W, H), [out]));
    return;
  }
  // Diapositives: cada foto `interval` segons, amb la música de la cue. Les fotos van en una
  // llista (concat) perquè l'ordre no passi del límit de llargada de Windows amb moltes fotos.
  const total = seg.images.length * seg.interval;
  const list = out + '.fotos.txt';
  const q = (f) => 'file \'' + f.replace(/'/g, '\'\\\'\'') + '\'';
  fs.writeFileSync(list, seg.images.map((img) => q(img) + '\nduration ' + seg.interval).join('\n') +
    '\n' + q(seg.images[seg.images.length - 1]) + '\n');
  const au = audioInput(seg.audio, total);
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', list].concat(au.args, ['-filter_complex',
    '[0:v]' + SCALE(W, H) + '[v];[1:a]' + au.filter + '[a]', '-map', '[v]', '-map', '[a]',
    '-t', String(total)], videoOut(W, H), [out]));
}

async function main() {
  try {
    run(ffmpegBin, ['-version']);
  } catch (err) {
    log.error('No es troba ffmpeg ("' + ffmpegBin + '"). Indica\'l amb --ffmpeg=ruta.');
    return 1;
  }
  const showDir = path.resolve(arg('show') || path.join(__dirname, '..', 'show'));
  const out = path.resolve(arg('out') || path.join(path.dirname(showDir), 'reserva', 'gala-reserva.mp4'));
  const [W, H] = (arg('res') || '1920x1080').split('x').map((x) => Number(x) - (Number(x) % 2));
  const loaded = loadShow(showDir);
  if (!loaded.show || hasErrors(loaded.problems)) {
    log.error('El guió té errors; corregeix-los abans:\n' + loaded.problems.map((p) => '  ' + p.msg).join('\n'));
    return 1;
  }
  const show = loaded.show;
  const choices = parseChoices(show);
  const route = bv.linearPath(show, choices);
  route.warnings.forEach((w) => log.warn(w));
  log.info('Camí: ' + route.ids.join(' → '));
  const segs = bv.buildSegments(show, route.ids, showDir, choices);
  const missing = segs.filter((s) => s.kind === 'video' && !fs.existsSync(s.file));
  if (missing.length) {
    log.error('Falten vídeos: ' + missing.map((s) => s.file).join(', '));
    return 1;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gala-reserva-'));
  process.on('SIGINT', () => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(130);
  });
  let win = null;
  try {
    win = new BrowserWindow({
      show: false, width: W, height: H, useContentSize: true,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
    });
    win.webContents.setAudioMuted(true);
    const t0 = Date.now();
    const files = [];
    const entries = [];
    let at = 0;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const file = path.join(tmp, 'seg' + String(i).padStart(4, '0') + '.mp4');
      if (seg.kind === 'card') {
        seg.png = path.join(tmp, 'card' + String(i).padStart(4, '0') + '.png');
        await renderCard(win, seg.card, seg.png, tmp);
      }
      encodeSegment(seg, file, W, H);
      if (seg.chapter) entries.push({ startMs: at * 1000, title: seg.chapter });
      at += probe(file).duration;
      files.push(file);
      if ((i + 1) % 10 === 0 || i === segs.length - 1) log.info('Segments: ' + (i + 1) + '/' + segs.length + ' (' + bv.hms(at) + ')');
    }
    const list = path.join(tmp, 'llista.txt');
    fs.writeFileSync(list, files.map((f) => 'file \'' + f.replace(/'/g, '\'\\\'\'') + '\'').join('\n'));
    const ch = bv.chapters(entries, at * 1000);
    const metaFile = path.join(tmp, 'capitols.txt');
    fs.writeFileSync(metaFile, ch.meta);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const partial = out + '.part.mp4';
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-i', metaFile, '-map', '0', '-map_metadata', '1', '-map_chapters', '1',
      '-c', 'copy', '-movflags', '+faststart', partial]);
    fs.renameSync(partial, out);
    const indexFile = out.replace(/\.mp4$/i, '') + '-index.txt';
    fs.writeFileSync(indexFile, 'Vídeo de reserva: ' + show.title + '\nCamí: ' + route.ids.join(' → ') +
      '\nA VLC: menú Reproducció › Capítol per saltar.\n\n' + ch.index);
    log.info('Fet en ' + Math.round((Date.now() - t0) / 1000) + ' s: ' + out + ' (' + bv.hms(at) + ', ' +
      Math.round(fs.statSync(out).size / 1048576) + ' MB). Índex: ' + indexFile);
    return 0;
  } finally {
    if (win) win.destroy();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(out + '.part.mp4', { force: true });
  }
}

app.disableHardwareAcceleration();
app.whenReady().then(main).then((code) => app.exit(code), (err) => {
  log.error(err.stack || String(err));
  app.exit(1);
});
