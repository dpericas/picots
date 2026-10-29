'use strict';
// Esborrat després de la gala (privacitat).
//   dades: carpeta de dades (diaris, assajos, registres, clau dels QR personals, posicions…)
//   tot:   a més, la carpeta de l'espectacle (guió, fotos i vídeos) i les fonts dels
//          vídeos i el vídeo de reserva, si són al costat.
//
// Per seguretat només s'esborra una carpeta si té l'aspecte exacte de les de l'app:
// mai una carpeta personal (Escriptori, Documents…), mai carpetes que es contenen
// entre elles, i la de dades només si tot el que hi ha és de l'app.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Contingut que l'app crea a la carpeta de dades (i els PDF/HTML que s'hi exporten).
const DATA_ENTRY = /^(journal(-.+)?\.jsonl|assaig(-.+)?\.jsonl|position(-assaig)?\.json|secret|mode\.json|pantalla\.json|registres|guio-copies|.+\.pdf|.+\.html)$/i;
const DATA_MARKERS = ['journal.jsonl', 'assaig.jsonl', 'secret'];
const PERSONAL = /^(desktop|escriptori|escritorio|documents|documentos|mis documentos|downloads|baixades|descargas|pictures|imatges|imágenes|videos|vídeos|music|música|onedrive|home|users|usuaris)$/i;

function real(dir) {
  try {
    return fs.realpathSync(dir);
  } catch (err) {
    return path.resolve(dir);
  }
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Llista del que s'esborrarà (rutes reals, després de resoldre enllaços).
 * @returns {{ targets: string[], refused: string[] }}
 */
function wipeTargets(opts) {
  const { level } = opts;
  const dataDir = opts.dataDir ? real(opts.dataDir) : null;
  const showDir = opts.showDir ? real(opts.showDir) : null;
  const targets = [];
  const refused = [];
  const home = real(os.homedir());
  const unsafe = (dir) => dir === path.parse(dir).root || dir === home || PERSONAL.test(path.basename(dir)) ||
    inside(home, dir);
  const consider = (dir, check, label) => {
    if (!dir || !fs.existsSync(dir)) return;
    const reason = unsafe(dir) ? 'és una carpeta del sistema o personal' : check(dir);
    if (reason) refused.push(label + ': ' + dir + ' (' + reason + ')');
    else targets.push(dir);
  };
  const overlap = dataDir && showDir && (inside(dataDir, showDir) || inside(showDir, dataDir));

  consider(dataDir, (d) => {
    if (overlap) return 'conté la carpeta de l\'espectacle o hi és a dins';
    const entries = fs.readdirSync(d);
    if (!DATA_MARKERS.some((m) => entries.includes(m))) return 'no té les dades de l\'app';
    const foreign = entries.filter((e) => !DATA_ENTRY.test(e));
    return foreign.length ? 'hi ha fitxers que no són de l\'app: ' + foreign.slice(0, 5).join(', ') : null;
  }, 'dades');

  if (level === 'tot') {
    consider(showDir, (d) => {
      if (overlap) return 'conté la carpeta de dades o hi és a dins';
      if (!fs.existsSync(path.join(d, 'show.yaml'))) return 'no hi ha show.yaml';
      if (['package.json', '.git', 'src'].some((n) => fs.existsSync(path.join(d, n)))) return 'sembla una carpeta de programa, no de l\'espectacle';
      return null;
    }, 'espectacle');
    // Les carpetes del costat només si la de l'espectacle s'ha acceptat.
    const parent = showDir && targets.includes(showDir) ? path.dirname(showDir) : null;
    if (parent) {
      consider(real(path.join(parent, 'fonts-entrada')), () => null, 'fonts dels vídeos d\'entrada');
      consider(real(path.join(parent, 'fonts-conte')), () => null, 'fonts dels vídeos del conte');
      consider(real(path.join(parent, 'reserva')), (d) => (fs.readdirSync(d).every((f) => /^gala-reserva/.test(f))
        ? null : 'hi ha altres fitxers'), 'vídeo de reserva');
    }
  }
  return { targets, refused };
}

// Esborra les carpetes; si una de les originals era un enllaç, també l'enllaç.
function performWipe(targets, links) {
  const done = [];
  const failed = [];
  for (const t of targets.concat(links || [])) {
    try {
      fs.rmSync(t, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      if (fs.existsSync(t)) throw new Error('encara hi és');
      done.push(t);
    } catch (err) {
      failed.push(t + ' (' + err.message + ')');
    }
  }
  return { done, failed };
}

module.exports = { wipeTargets, performWipe };
