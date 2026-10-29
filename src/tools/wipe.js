'use strict';
// Esborrat després de la gala (privacitat).
//   dades: carpeta de dades (diaris, assajos, registres, clau dels QR personals, posicions…)
//   tot:   a més, la carpeta de l'espectacle (guió, fotos i vídeos) i les fonts dels
//          vídeos d'entrada i el vídeo de reserva, si són al costat.

const fs = require('fs');
const path = require('path');

/**
 * Llista del que s'esborrarà. Comprova que les carpetes semblen les de l'app
 * per no esborrar mai res que no toca.
 * @returns {{ targets: string[], refused: string[] }}
 */
function wipeTargets(opts) {
  const { dataDir, showDir, level } = opts;
  const targets = [];
  const refused = [];
  const unsafe = (dir) => {
    const resolved = path.resolve(dir);
    return resolved === path.parse(resolved).root || resolved === path.resolve(require('os').homedir());
  };
  const consider = (dir, looksRight, label) => {
    if (!dir || !fs.existsSync(dir)) return;
    if (unsafe(dir) || !looksRight(dir)) refused.push(label + ': ' + dir);
    else targets.push(path.resolve(dir));
  };
  const has = (dir, names) => names.some((n) => fs.existsSync(path.join(dir, n)));
  consider(dataDir, (d) => has(d, ['journal.jsonl', 'assaig.jsonl', 'secret', 'registres']), 'dades');
  if (level === 'tot') {
    consider(showDir, (d) => has(d, ['show.yaml']), 'espectacle');
    const parent = path.dirname(path.resolve(showDir));
    consider(path.join(parent, 'fonts-entrada'), () => true, 'fonts dels vídeos d\'entrada');
    consider(path.join(parent, 'reserva'), (d) => fs.readdirSync(d).every((f) => /^gala-reserva/.test(f)), 'vídeo de reserva');
  }
  return { targets, refused };
}

function performWipe(targets) {
  const done = [];
  const failed = [];
  for (const t of targets) {
    try {
      fs.rmSync(t, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      done.push(t);
    } catch (err) {
      failed.push(t + ' (' + err.message + ')');
    }
  }
  return { done, failed };
}

module.exports = { wipeTargets, performWipe };
