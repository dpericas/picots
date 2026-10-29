'use strict';
// Munta els vídeos d'entrada de cada nen a partir de les seves fotos i la seva cançó.
// Cal ffmpeg 5 o posterior (al PATH, o amb --ffmpeg=ruta o la variable FFMPEG_PATH).
//
// Ús: node scripts/make-entry-videos.js [opcions]
//   --show=carpeta          guió (per defecte ./show)
//   --fonts=carpeta         fonts (per defecte fonts-entrada, al costat del guió)
//   --nomes=anna,biel       només aquests nens
//   --durada=30             segons de cada vídeo (també per nen, a config.yaml)
//   --res=1920x1080         resolució (1280x720 és més ràpid)
//   --refes                 torna a fer-los encara que no hagin canviat
//   --actualitza-guio       posa video_entrada a cada nen del show.yaml
//
// Estructura de les fonts:
//   fonts-entrada/anna/01.jpg, 02.jpg, …   (per ordre de nom: numera-les)
//   fonts-entrada/anna/canco.mp3
//   fonts-entrada/anna/config.yaml         (opcional) inici: 45   durada: 28

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeLogger } = require('../src/common/log');
const { loadShow } = require('../src/engine/show');
const ev = require('../src/tools/entry-videos');

const log = makeLogger('entrada');

function arg(name) {
  const prefix = '--' + name + '=';
  const a = process.argv.find((x) => x.startsWith(prefix));
  return a ? a.slice(prefix.length) : null;
}
const flag = (name) => process.argv.includes('--' + name);

const ffmpegBin = arg('ffmpeg') || process.env.FFMPEG_PATH || 'ffmpeg';

function ffmpeg(args) {
  const r = spawnSync(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-y'].concat(args), { encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || '').trim().split('\n').slice(-3).join(' | ') || 'ffmpeg ha fallat');
}

function checkFfmpeg() {
  try {
    const out = execFileSync(ffmpegBin, ['-hide_banner', '-version']).toString();
    const m = out.match(/ffmpeg version n?(\d+)/);
    if (m && Number(m[1]) < 5) log.warn('ffmpeg ' + m[1] + ': es recomana la 5 o posterior (gira les fotos del mòbil).');
  } catch (err) {
    log.error('No es troba ffmpeg ("' + ffmpegBin + '"). Instal·la\'l o indica\'l amb --ffmpeg=ruta.');
    process.exit(1);
  }
}

function main() {
  checkFfmpeg();
  const showDir = path.resolve(arg('show') || path.join(__dirname, '..', 'show'));
  const sourcesDir = path.resolve(arg('fonts') || path.join(path.dirname(showDir), 'fonts-entrada'));
  const loaded = loadShow(showDir);
  if (!loaded.show) {
    log.error(loaded.problems.map((p) => p.msg).join('; '));
    process.exit(1);
  }
  const res = (arg('res') || '1920x1080').split('x').map(Number);
  const settings = {};
  if (arg('durada')) {
    settings.duration = ev.seconds(arg('durada'));
    if (settings.duration == null || settings.duration <= 0) {
      log.error('--durada no és vàlida: ' + arg('durada'));
      process.exit(1);
    }
  }
  if (res.length === 2 && res[0] > 0 && res[1] > 0) {
    settings.width = res[0] - (res[0] % 2);
    settings.height = res[1] - (res[1] % 2);
  }
  const only = arg('nomes') ? arg('nomes').split(',').map((s) => s.trim()).filter(Boolean) : null;
  const { jobs, warnings } = ev.listJobs({ sourcesDir, participants: loaded.show.participants, only });
  warnings.forEach((w) => log.warn(w));
  if (jobs.length === 0) {
    log.error('No hi ha cap vídeo per fer. Fonts: ' + sourcesDir);
    process.exit(1);
  }

  const outDir = path.join(showDir, 'media', 'entrada');
  fs.mkdirSync(outDir, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gala-entrada-'));
  // Si s'interromp (Ctrl+C), que no quedin clips amb fotos dels nens a la carpeta temporal.
  let partialFile = null;
  const cleanup = () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (partialFile) fs.rmSync(partialFile, { force: true });
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  const mapping = {};
  let made = 0;
  let failed = 0;
  try {
    for (const job of jobs) {
      const rel = 'media/entrada/' + job.id + '.mp4';
      const out = path.join(showDir, rel);
      mapping[job.id] = rel;
      const jobSettings = Object.assign({}, settings, job.config);
      if (!flag('refes') && !ev.isStale(out, job, jobSettings)) {
        log.info(job.name + ': ja està fet i al dia (--refes per tornar-lo a fer).');
        continue;
      }
      const p = ev.plan(job.images.length, jobSettings);
      log.info(job.name + ': ' + job.images.length + ' fotos, ' + p.photo.toFixed(2) + ' s per foto, ' +
        p.total.toFixed(1) + ' s' + (job.music ? ', música ' + path.basename(job.music) + ' des del segon ' + p.settings.start : '') +
        (p.notes.length ? ' (' + p.notes.join('; ') + ')' : ''));
      const t0 = Date.now();
      const tmp = path.join(tmpRoot, job.id);
      fs.mkdirSync(tmp);
      try {
        const clips = job.images.map((img, i) => {
          const clip = path.join(tmp, String(i).padStart(3, '0') + '.mp4');
          try {
            ffmpeg(ev.clipArgs(img, i, p, clip));
          } catch (err) {
            throw new Error('foto ' + path.basename(img) + ': ' + err.message);
          }
          return clip;
        });
        // Primer a un fitxer temporal: si falla, el vídeo anterior no es perd.
        const partial = out + '.part.mp4';
        partialFile = partial;
        ffmpeg(ev.joinArgs(clips, job.music, p, partial));
        fs.renameSync(partial, out);
        partialFile = null;
        ev.writeManifest(out, job, jobSettings);
        made += 1;
        log.info(job.name + ': fet en ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s -> ' + rel);
      } catch (err) {
        failed += 1;
        delete mapping[job.id];
        if (partialFile) fs.rmSync(partialFile, { force: true });
        partialFile = null;
        log.error(job.name + ': ' + err.message);
      }
    }
  } finally {
    cleanup();
  }

  if (flag('actualitza-guio')) {
    const file = path.join(showDir, 'show.yaml');
    const r = ev.updateShowText(fs.readFileSync(file, 'utf8'), mapping);
    if (r.changed.length) {
      fs.copyFileSync(file, file + '.bak');
      fs.writeFileSync(file, r.text);
      log.info('show.yaml actualitzat (' + r.changed.join(', ') + '). Còpia anterior: show.yaml.bak');
    } else {
      log.info('show.yaml ja tenia tots els video_entrada.');
    }
  } else {
    log.info('Recorda posar video_entrada a cada nen del guió (o torna-ho a executar amb --actualitza-guio).');
  }
  log.info('Fets: ' + made + ', amb error: ' + failed + ', ja al dia: ' + (jobs.length - made - failed) + '.');
  if (failed) process.exit(1);
}

main();
