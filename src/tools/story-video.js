'use strict';
// Vídeos del conte i muntatges a partir d'un guió senzill (fonts-conte/<nom>/guio.yaml):
// il·lustracions amb veu en off i subtítols, vídeos amb rètol (p. ex. els dels
// professors) i targetes de títol, amb música de fons que baixa quan parla algú.
// Aquí hi ha la lectura i validació del guió; el muntatge és a scripts/make-story-video.js.
//
//   sortida: media/video/cap1.mp4     # relatiu a show/ (per defecte media/video/<nom>.mp4)
//   musica: musica.mp3                # opcional, en bucle
//   volum_musica: 0.35                # 0–1
//   fos: 0.4                          # segons de fos a negre entre escenes
//   escenes:
//     - titol: "Capítol 1"            # targeta de títol (durada 3 s per defecte)
//     - imatge: 01.png                # il·lustració
//       veu: 01.mp3                   # narració: l'escena dura el que duri + 0,6 s
//       text: "Hi havia una vegada…"  # subtítol
//     - imatge: 02.png
//       durada: 4
//       moviment: no                  # sense zoom
//     - video: mireia.mp4
//       rotol: "Mireia · tutora de P3"

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const DEFAULTS = { imageSeconds: 4, titleSeconds: 3, voicePad: 0.6, fade: 0.4, musicVolume: 0.35 };

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * @param {string} text  contingut del guio.yaml
 * @param {string} dir   carpeta de les fonts (per resoldre i comprovar fitxers)
 * @param {string} name  nom de la carpeta (per a la sortida per defecte)
 * @returns {{ story: object|null, errors: string[], warnings: string[] }}
 */
function parseStoryboard(text, dir, name) {
  const errors = [];
  const warnings = [];
  let raw;
  try {
    raw = YAML.parse(text) || {};
  } catch (err) {
    return { story: null, errors: ['guio.yaml: error de sintaxi: ' + err.message], warnings };
  }
  const file = (rel, what, where) => {
    if (!rel) return null;
    const abs = path.resolve(dir, String(rel));
    if (!fs.existsSync(abs)) errors.push(where + ': no es troba ' + what + ' «' + rel + '»');
    return abs;
  };
  const num = (v, def, where, key) => {
    if (v == null) return def;
    const n = Number(v);
    if (!(n >= 0)) {
      errors.push(where + ': «' + key + '» ha de ser un número >= 0');
      return def;
    }
    return n;
  };
  const story = {
    name,
    output: raw.sortida ? String(raw.sortida).replace(/\\/g, '/') : 'media/video/' + name + '.mp4',
    music: file(raw.musica, 'la música', 'guio.yaml'),
    musicVolume: Math.min(1, num(raw.volum_musica, DEFAULTS.musicVolume, 'guio.yaml', 'volum_musica')),
    fade: Math.min(2, num(raw.fos, DEFAULTS.fade, 'guio.yaml', 'fos')),
    scenes: [],
  };
  const list = Array.isArray(raw.escenes) ? raw.escenes : [];
  if (list.length === 0) errors.push('guio.yaml: no hi ha cap escena («escenes»).');
  list.forEach((s, i) => {
    s = s || {};
    const where = 'Escena ' + (i + 1);
    const kinds = ['imatge', 'video', 'titol'].filter((k) => s[k] != null);
    if (kinds.length !== 1) {
      errors.push(where + ': ha de tenir exactament un de «imatge», «video» o «titol».');
      return;
    }
    const scene = {
      kind: { imatge: 'image', video: 'video', titol: 'title' }[kinds[0]],
      text: s.text != null ? String(s.text) : null,
      caption: s.rotol != null ? String(s.rotol) : null,
      seconds: s.durada != null ? num(s.durada, null, where, 'durada') : null,
      voice: file(s.veu, 'la veu', where),
      motion: s.moviment !== false && s.moviment !== 'no',
    };
    if (scene.kind === 'image') scene.file = file(s.imatge, 'la imatge', where);
    if (scene.kind === 'video') scene.file = file(s.video, 'el vídeo', where);
    if (scene.kind === 'title') scene.title = String(s.titol);
    if (scene.kind === 'video' && (scene.voice || scene.seconds != null)) {
      warnings.push(where + ': en un vídeo, «veu» i «durada» no s\'usen (dura el que dura el vídeo).');
    }
    if (scene.text && scene.text.length > 140) warnings.push(where + ': el subtítol és llarg (' + scene.text.length + ' caràcters); millor dividir l\'escena.');
    story.scenes.push(scene);
  });
  return { story: errors.length ? null : story, errors, warnings };
}

// Durada d'una escena d'imatge o de títol (els vídeos duren el que duren).
function sceneSeconds(scene, voiceSeconds) {
  if (scene.kind === 'image' && scene.voice && voiceSeconds != null) {
    return Math.max(scene.seconds || 0, voiceSeconds + DEFAULTS.voicePad);
  }
  if (scene.seconds != null && scene.seconds > 0) return scene.seconds;
  return scene.kind === 'title' ? DEFAULTS.titleSeconds : DEFAULTS.imageSeconds;
}

/** Carpetes de fonts-conte amb un guio.yaml. */
function listStories(sourcesDir, only) {
  if (!fs.existsSync(sourcesDir)) return [];
  return fs.readdirSync(sourcesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(sourcesDir, d.name, 'guio.yaml')))
    .map((d) => d.name)
    .filter((n) => !only || only.includes(n))
    .sort(naturalSort);
}

module.exports = { parseStoryboard, sceneSeconds, listStories, DEFAULTS };
