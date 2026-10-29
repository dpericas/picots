'use strict';
// Munta els vídeos del conte i els muntatges a partir de fonts-conte/<nom>/guio.yaml
// (vegeu src/tools/story-video.js per al format). S'executa amb Electron (per
// dibuixar subtítols, rètols i títols) i cal ffmpeg 5+.
//
// Ús: npm run story-video -- [opcions]
//   --show=carpeta      guió de l'app (per defecte ./show; la sortida és relativa a show/)
//   --fonts=carpeta     per defecte fonts-conte, al costat de show/
//   --nomes=cap1,altres només aquests
//   --res=1920x1080     resolució
//   --ffmpeg=ruta       si ffmpeg no és al PATH (també FFMPEG_PATH)

const { app, BrowserWindow } = require('electron');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeLogger } = require('../src/common/log');
const sv = require('../src/tools/story-video');

const log = makeLogger('conte');
const FPS = 30;
const CAPTION_START = 0.4;
const CAPTION_SECONDS = 7;

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

function esc(t) {
  return String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// --- Capes de text (PNG; transparents excepte la targeta de títol) ---
const BASE_CSS = 'html,body{margin:0;width:100vw;height:100vh;overflow:hidden;font-family:"Segoe UI",system-ui,sans-serif}';
function overlayHtml(kind, text) {
  if (kind === 'title') {
    return '<!doctype html><meta charset="utf-8"><style>' + BASE_CSS +
      'body{background:radial-gradient(ellipse 60% 70% at 50% 45%,#3a2d5c 0%,#05040b 100%);display:flex;align-items:center;' +
      'justify-content:center;text-align:center;color:#ffcc33}h1{font-size:10vh;margin:0 8vw;text-shadow:0 0 4vh rgba(255,204,51,.5)}' +
      '</style><body><h1>' + esc(text) + '</h1></body>';
  }
  if (kind === 'subtitle') {
    return '<!doctype html><meta charset="utf-8"><style>' + BASE_CSS +
      'body{background:transparent;display:flex;align-items:flex-end;justify-content:center}' +
      'div{margin:0 8vw 7vh;padding:1.2vh 2.4vw;border-radius:1vh;background:rgba(0,0,0,.62);color:#fff;font-size:4.6vh;' +
      'font-weight:600;line-height:1.3;text-align:center;text-shadow:0 .2vh .6vh #000}</style><body><div>' + esc(text) + '</div></body>';
  }
  return '<!doctype html><meta charset="utf-8"><style>' + BASE_CSS +
    'body{background:transparent}div{position:absolute;left:5vw;bottom:8vh;padding:1.4vh 2.4vw;border-radius:1vh;' +
    'background:rgba(10,8,25,.78);border-left:.8vh solid #ffcc33;color:#fff;font-size:4.2vh;font-weight:700;' +
    'text-shadow:0 .3vh 1vh #000;max-width:80vw}</style><body><div>' + esc(text) + '</div></body>';
}

async function renderPng(win, html, file) {
  const htmlFile = file.replace(/\.png$/, '.html');
  fs.writeFileSync(htmlFile, html);
  await win.loadFile(htmlFile);
  await new Promise((r) => setTimeout(r, 150));
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
}

// --- Escenes normalitzades (mateixos paràmetres: es poden concatenar sense recodificar) ---
const VOUT = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS),
  '-video_track_timescale', '15360', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];
const AFMT = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
const fit = (W, H) => 'scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease,pad=' + W + ':' + H +
  ':(ow-iw)/2:(oh-ih)/2,setsar=1,fps=' + FPS + ',format=yuv420p';

function fades(seconds, fade) {
  if (!(fade > 0)) return { v: '', a: '' };
  const out = Math.max(0, seconds - fade).toFixed(3);
  return {
    v: ',fade=t=in:d=' + fade + ',fade=t=out:st=' + out + ':d=' + fade,
    a: ',afade=t=in:d=' + fade + ',afade=t=out:st=' + out + ':d=' + fade,
  };
}

function encodeImage(scene, seconds, overlay, out, W, H, fade, index) {
  const frames = Math.round(seconds * FPS);
  const BW = Math.round(W * 1.25 / 2) * 2;
  const BH = Math.round(H * 1.25 / 2) * 2;
  const step = (0.1 / frames).toFixed(6);
  const zoom = !scene.motion ? '1' : index % 2 === 0 ? 'min(1+' + step + '*on,1.1)' : 'max(1.1-' + step + '*on,1)';
  const f = fades(seconds, fade);
  const args = ['-i', scene.file];
  let n = 1;
  let audioIn;
  if (scene.voice) {
    args.push('-i', scene.voice);
    audioIn = n++;
  } else {
    args.push('-f', 'lavfi', '-t', String(seconds), '-i', 'anullsrc=r=48000:cl=stereo');
    audioIn = n++;
  }
  let ov = '';
  if (overlay) {
    args.push('-loop', '1', '-t', String(seconds), '-i', overlay);
    ov = '[v0][' + n + ':v]overlay=0:0[v1];';
    n++;
  }
  const filter = '[0:v]split[a][b];' +
    '[a]scale=' + BW + ':' + BH + ':force_original_aspect_ratio=increase,crop=' + BW + ':' + BH + ',boxblur=30:2,eq=brightness=-0.15[bg];' +
    '[b]scale=' + BW + ':' + BH + ':force_original_aspect_ratio=decrease[fg];' +
    '[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,zoompan=z=\'' + zoom + '\':x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':d=' +
    frames + ':s=' + W + 'x' + H + ':fps=' + FPS + ',format=yuv420p[v0];' + ov +
    '[' + (overlay ? 'v1' : 'v0') + ']null' + f.v + '[v];' +
    '[' + audioIn + ':a]' + AFMT + (scene.voice ? ',adelay=200|200' : '') + ',apad' + f.a + '[aout]';
  ffmpeg(args.concat(['-filter_complex', filter, '-map', '[v]', '-map', '[aout]', '-t', String(seconds)], VOUT, [out]));
}

function encodeTitle(card, seconds, out, W, H, fade) {
  const f = fades(seconds, fade);
  ffmpeg(['-loop', '1', '-framerate', String(FPS), '-t', String(seconds), '-i', card,
    '-f', 'lavfi', '-t', String(seconds), '-i', 'anullsrc=r=48000:cl=stereo',
    '-filter_complex', '[0:v]' + fit(W, H) + f.v + '[v];[1:a]' + AFMT + '[aout]',
    '-map', '[v]', '-map', '[aout]', '-t', String(seconds)].concat(VOUT, [out]));
}

function encodeVideo(scene, overlay, out, W, H, fade) {
  const info = probe(scene.file);
  const seconds = info.duration;
  const f = fades(seconds, fade);
  const args = ['-i', scene.file];
  let n = 1;
  let audio = '[0:a]';
  if (!info.audio) {
    args.push('-f', 'lavfi', '-t', String(seconds), '-i', 'anullsrc=r=48000:cl=stereo');
    audio = '[' + n++ + ':a]';
  }
  let v = '[0:v]' + fit(W, H) + '[v0];';
  let last = '[v0]';
  if (overlay) {
    // El rètol entra amb un fos i se'n va sol al cap de CAPTION_SECONDS.
    const end = Math.min(seconds, CAPTION_START + CAPTION_SECONDS);
    args.push('-loop', '1', '-t', String(seconds), '-i', overlay);
    v += '[' + n + ':v]format=rgba,fade=t=in:st=' + CAPTION_START + ':d=0.5:alpha=1,fade=t=out:st=' +
      Math.max(CAPTION_START, end - 0.5).toFixed(3) + ':d=0.5:alpha=1[cap];[v0][cap]overlay=0:0:shortest=1[v1];';
    last = '[v1]';
    n++;
  }
  v += last + 'null' + f.v + '[v];' + audio + AFMT + ',apad' + f.a + '[aout]';
  ffmpeg(args.concat(['-filter_complex', v, '-map', '[v]', '-map', '[aout]', '-t', String(seconds)], VOUT, [out]));
}

// Música de fons en bucle: baixa sola quan hi ha veu (sidechain) i volum final igualat.
function finish(base, story, out) {
  const total = probe(base).duration;
  const fadeOut = Math.max(0, total - 2).toFixed(3);
  if (story.music) {
    ffmpeg(['-i', base, '-stream_loop', '-1', '-i', story.music, '-filter_complex',
      '[0:a]asplit=2[k][v];[1:a]' + AFMT + ',volume=' + story.musicVolume + '[m];' +
      '[m][k]sidechaincompress=threshold=0.02:ratio=12:attack=20:release=400[duck];' +
      '[v][duck]amix=inputs=2:duration=first:normalize=0,afade=t=out:st=' + fadeOut + ':d=2,' +
      'loudnorm=I=-16:TP=-1.5:LRA=11,' + AFMT + '[a]',
      '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(total),
      '-movflags', '+faststart', out]);
  } else {
    ffmpeg(['-i', base, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,' + AFMT, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart', out]);
  }
  return total;
}

async function buildStory(story, showDir, W, H, win, tmpRoot) {
  const tmp = fs.mkdtempSync(path.join(tmpRoot, story.name + '-'));
  const segs = [];
  for (let i = 0; i < story.scenes.length; i++) {
    const s = story.scenes[i];
    const seg = path.join(tmp, 'escena' + String(i).padStart(3, '0') + '.mp4');
    const png = path.join(tmp, 'capa' + String(i).padStart(3, '0') + '.png');
    if (s.kind === 'title') {
      await renderPng(win, overlayHtml('title', s.title), png);
      encodeTitle(png, sv.sceneSeconds(s, null), seg, W, H, story.fade);
    } else if (s.kind === 'image') {
      const voice = s.voice ? probe(s.voice).duration : null;
      if (s.text) await renderPng(win, overlayHtml('subtitle', s.text), png);
      encodeImage(s, sv.sceneSeconds(s, voice), s.text ? png : null, seg, W, H, story.fade, i);
    } else {
      if (s.caption) await renderPng(win, overlayHtml('caption', s.caption), png);
      encodeVideo(s, s.caption ? png : null, seg, W, H, story.fade);
    }
    segs.push(seg);
  }
  const list = path.join(tmp, 'llista.txt');
  fs.writeFileSync(list, segs.map((f) => 'file \'' + f.replace(/'/g, '\'\\\'\'') + '\'').join('\n'));
  const base = path.join(tmp, 'base.mp4');
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', base]);
  const out = path.join(showDir, story.output);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const partial = out + '.part.mp4';
  let total;
  try {
    total = finish(base, story, partial);
    fs.renameSync(partial, out);
  } finally {
    fs.rmSync(partial, { force: true });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return { out, total };
}

async function main() {
  try {
    run(ffmpegBin, ['-version']);
  } catch (err) {
    log.error('No es troba ffmpeg ("' + ffmpegBin + '"). Indica\'l amb --ffmpeg=ruta.');
    return 1;
  }
  const showDir = path.resolve(arg('show') || path.join(__dirname, '..', 'show'));
  const sourcesDir = path.resolve(arg('fonts') || path.join(path.dirname(showDir), 'fonts-conte'));
  const only = arg('nomes') ? arg('nomes').split(',').map((x) => x.trim()).filter(Boolean) : null;
  const [W, H] = (arg('res') || '1920x1080').split('x').map((x) => Number(x) - (Number(x) % 2));
  const names = sv.listStories(sourcesDir, only);
  if (names.length === 0) {
    log.error('No hi ha cap carpeta amb guio.yaml a ' + sourcesDir);
    return 1;
  }
  const win = new BrowserWindow({
    show: false, width: W, height: H, useContentSize: true, transparent: true, backgroundColor: '#00000000',
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
  });
  win.webContents.setAudioMuted(true);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gala-conte-'));
  process.on('SIGINT', () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.exit(130);
  });
  let failed = 0;
  try {
    for (const name of names) {
      const dir = path.join(sourcesDir, name);
      const r = sv.parseStoryboard(fs.readFileSync(path.join(dir, 'guio.yaml'), 'utf8'), dir, name);
      r.warnings.forEach((w) => log.warn(name + ': ' + w));
      if (!r.story) {
        r.errors.forEach((e) => log.error(name + ': ' + e));
        failed += 1;
        continue;
      }
      const t0 = Date.now();
      try {
        const res = await buildStory(r.story, showDir, W, H, win, tmpRoot);
        log.info(name + ': ' + r.story.scenes.length + ' escenes, ' + res.total.toFixed(1) + ' s, fet en ' +
          ((Date.now() - t0) / 1000).toFixed(1) + ' s -> ' + r.story.output);
      } catch (err) {
        failed += 1;
        log.error(name + ': ' + err.message);
      }
    }
  } finally {
    win.destroy();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  return failed ? 1 : 0;
}

app.disableHardwareAcceleration();
app.whenReady().then(main).then((code) => app.exit(code), (err) => {
  log.error(err.stack || String(err));
  app.exit(1);
});
