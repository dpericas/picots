'use strict';
// Generador dels vídeos d'entrada: de les fotos i la cançó de cada nen a un MP4
// amb moviment suau a cada foto, transicions i la música amb fos de sortida.
//
// Fonts: <fonts>/<id del nen>/  amb les fotos (per ordre de nom de fitxer) i una cançó.
// Opcional: <fonts>/<id>/config.yaml amb  inici (segon de la cançó on comença),
//           durada (segons del vídeo) i transicio (segons de cada transició).

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { parseDuration } = require('../engine/timing');

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const AUDIO_EXT = ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac'];
const TRANSITIONS = ['fade', 'smoothleft', 'circleopen', 'slideup', 'fadeblack', 'smoothright', 'radial', 'slidedown'];
const MIN_PHOTO = 1.0; // segons mínims que es veu cada foto
const MAX_PHOTO = 4.0;
const FADE_OUT = 2.5;

const DEFAULTS = { duration: 30, transition: 0.6, width: 1920, height: 1080, fps: 30, start: 0 };

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// Segons a partir de 45, "1:05" o "0,5" (coma decimal). null si no és vàlid.
function seconds(value) {
  if (value == null) return null;
  const v = typeof value === 'string' ? value.trim().replace(',', '.') : value;
  const n = parseDuration(v);
  return n != null && isFinite(n) ? n : null;
}

function readConfig(dir, warnings, id) {
  const file = path.join(dir, 'config.yaml');
  if (!fs.existsSync(file)) return {};
  const raw = YAML.parse(fs.readFileSync(file, 'utf8')) || {};
  const out = {};
  [['inici', 'start'], ['durada', 'duration'], ['transicio', 'transition']].forEach(([key, prop]) => {
    if (raw[key] == null) return;
    const v = seconds(raw[key]);
    if (v == null) warnings.push(id + ': config.yaml "' + key + '" no és vàlid (' + raw[key] + '); s\'usa el valor per defecte.');
    else out[prop] = v;
  });
  return out;
}

// Fitxers ocults (p. ex. "._01.jpg" dels Mac) no són fotos ni cançons.
const hidden = (f) => f.startsWith('.');

/**
 * Feines a fer: una per cada carpeta de fonts que correspon a un participant.
 * @returns {{ jobs: object[], warnings: string[] }}
 */
function listJobs(opts) {
  const { sourcesDir, participants, only } = opts;
  const warnings = [];
  const jobs = [];
  if (!fs.existsSync(sourcesDir)) {
    return { jobs, warnings: ['No existeix la carpeta de fonts: ' + sourcesDir] };
  }
  const byId = new Map(participants.map((p) => [p.id, p]));
  const dirs = fs.readdirSync(sourcesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const id of dirs.sort(naturalSort)) {
    if (!byId.has(id)) {
      warnings.push('La carpeta "' + id + '" no correspon a cap participant del guió (el nom ha de ser l\'id).');
      continue;
    }
    if (only && !only.includes(id)) continue;
    const dir = path.join(sourcesDir, id);
    const files = fs.readdirSync(dir).filter((f) => !hidden(f)).sort(naturalSort);
    const heic = files.filter((f) => /\.hei[cf]$/i.test(f));
    if (heic.length) warnings.push(id + ': ' + heic.length + ' fotos HEIC (iPhone) no es fan servir; converteix-les a JPG.');
    const images = files.filter((f) => IMAGE_EXT.includes(path.extname(f).toLowerCase())).map((f) => path.join(dir, f));
    const songs = files.filter((f) => AUDIO_EXT.includes(path.extname(f).toLowerCase())).map((f) => path.join(dir, f));
    if (images.length === 0) {
      warnings.push(id + ': no hi ha cap foto (' + IMAGE_EXT.join(', ') + ').');
      continue;
    }
    if (songs.length === 0) warnings.push(id + ': no hi ha cap cançó; el vídeo sortirà sense música.');
    if (songs.length > 1) warnings.push(id + ': hi ha ' + songs.length + ' cançons; s\'usa ' + path.basename(songs[0]) + '.');
    let config;
    try {
      config = readConfig(dir, warnings, id);
    } catch (err) {
      warnings.push(id + ': config.yaml no és vàlid (' + err.message + '); s\'usen els valors per defecte.');
      config = {};
    }
    jobs.push({ id, name: byId.get(id).name, dir, images, music: songs[0] || null, config });
  }
  const withDir = new Set(dirs);
  participants.filter((p) => !withDir.has(p.id)).forEach((p) => {
    if (!only || only.includes(p.id)) warnings.push(p.name + ' (' + p.id + ') no té carpeta de fonts.');
  });
  return { jobs, warnings };
}

/**
 * Durades: cada foto es veu `photo` segons i les transicions s'encavalquen.
 * total = n * photo - (n - 1) * transition
 */
function plan(imageCount, settings) {
  const s = Object.assign({}, DEFAULTS, settings);
  const n = imageCount;
  const transition = n > 1 ? Math.max(0, Math.min(s.transition, 1.5)) : 0;
  const ideal = (s.duration + (n - 1) * transition) / n;
  const photo = Math.max(MIN_PHOTO + transition, Math.min(MAX_PHOTO, ideal));
  const total = n * photo - (n - 1) * transition;
  const notes = [];
  if (ideal < MIN_PHOTO + transition) {
    notes.push('massa fotos per a ' + s.duration + ' s: el vídeo farà ' + total.toFixed(1) + ' s');
  } else if (ideal > MAX_PHOTO) {
    notes.push('poques fotos per a ' + s.duration + ' s: el vídeo farà ' + total.toFixed(1) + ' s');
  }
  return { photo, transition, total, notes, settings: s };
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}

// Clip d'una foto: fons difuminat (per a fotos verticals) i la foto sencera
// a sobre, amb un zoom lent que alterna entre apropar-se i allunyar-se.
function clipArgs(image, index, p, out) {
  const { width: W, height: H, fps } = p.settings;
  const frames = Math.round(p.photo * fps);
  // Es treballa a més resolució perquè el zoom no faci salts de píxel.
  const BW = Math.round(W * 1.25 / 2) * 2;
  const BH = Math.round(H * 1.25 / 2) * 2;
  const step = (0.12 / frames).toFixed(6);
  const zoom = index % 2 === 0 ? 'min(1+' + step + '*on,1.12)' : 'max(1.12-' + step + '*on,1)';
  const filter = [
    '[0:v]split[a][b]',
    '[a]scale=' + BW + ':' + BH + ':force_original_aspect_ratio=increase,crop=' + BW + ':' + BH +
      ',boxblur=30:2,eq=brightness=-0.12[bg]',
    '[b]scale=' + BW + ':' + BH + ':force_original_aspect_ratio=decrease[fg]',
    '[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,zoompan=z=\'' + zoom + '\':x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\'' +
      ':d=' + frames + ':s=' + W + 'x' + H + ':fps=' + fps + ',format=yuv420p[v]',
  ].join(';');
  return [
    '-i', image, '-filter_complex', filter, '-map', '[v]', '-frames:v', String(frames),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-r', String(fps), out,
  ];
}

// Uneix els clips amb transicions i hi posa la música (fos d'entrada i de sortida i volum igualat).
function joinArgs(clips, music, p, out) {
  const args = [];
  clips.forEach((c) => args.push('-i', c));
  const chains = [];
  let last = '[0:v]';
  for (let i = 1; i < clips.length; i++) {
    const offset = round(i * (p.photo - p.transition));
    const label = i === clips.length - 1 ? '[vx]' : '[x' + i + ']';
    chains.push(last + '[' + i + ':v]xfade=transition=' + TRANSITIONS[(i - 1) % TRANSITIONS.length] +
      ':duration=' + p.transition + ':offset=' + offset + label);
    last = label;
  }
  const total = round(p.total);
  chains.push((clips.length > 1 ? '[vx]' : '[0:v]') + 'fade=t=out:st=' + round(total - 0.8) + ':d=0.8,format=yuv420p[v]');
  if (music) {
    args.push('-ss', String(p.settings.start || 0), '-i', music);
    const a = clips.length;
    chains.push('[' + a + ':a]afade=t=in:d=0.4,afade=t=out:st=' + round(Math.max(0, total - FADE_OUT)) + ':d=' + FADE_OUT +
      ',loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad[a]');
  }
  args.push('-filter_complex', chains.join(';'), '-map', '[v]');
  if (music) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '192k');
  args.push('-t', String(total), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high',
    '-pix_fmt', 'yuv420p', '-r', String(p.settings.fps), '-movflags', '+faststart', out);
  return args;
}

// Empremta de les fonts i els ajustos: si canvia (fotos noves, esborrades, reordenades,
// una altra cançó, una altra durada o resolució), cal refer el vídeo. No depèn de les
// dates dels fitxers, que es conserven en copiar-los.
function fingerprint(job, settings) {
  const inputs = job.images.concat(job.music ? [job.music] : []);
  const cfg = path.join(job.dir, 'config.yaml');
  if (fs.existsSync(cfg)) inputs.push(cfg);
  return JSON.stringify({
    files: inputs.map((f) => {
      const st = fs.statSync(f);
      return [path.basename(f), st.size, Math.round(st.mtimeMs)];
    }),
    settings,
  });
}

const manifestOf = (out) => out + '.fonts.json';

function isStale(out, job, settings) {
  if (!fs.existsSync(out)) return true;
  try {
    return fs.readFileSync(manifestOf(out), 'utf8') !== fingerprint(job, settings || {});
  } catch (err) {
    return true;
  }
}

function writeManifest(out, job, settings) {
  fs.writeFileSync(manifestOf(out), fingerprint(job, settings || {}));
}

/**
 * Posa video_entrada als participants del guió (respectant comentaris i format).
 * @param {object} mapping  id -> ruta relativa al guió
 * @returns {string[]} ids canviats
 */
function updateShowText(text, mapping) {
  const doc = YAML.parseDocument(text);
  const list = doc.get('participants');
  const changed = [];
  if (!list || !list.items) return { text, changed };
  for (const item of list.items) {
    const id = item.get('id') != null ? String(item.get('id')) : null;
    if (id && mapping[id] && item.get('video_entrada') !== mapping[id]) {
      item.set('video_entrada', mapping[id]);
      changed.push(id);
    }
  }
  return { text: changed.length ? doc.toString({ lineWidth: 0 }) : text, changed };
}

module.exports = { listJobs, plan, clipArgs, joinArgs, isStale, writeManifest, updateShowText, seconds, DEFAULTS, TRANSITIONS };
