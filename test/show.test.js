'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { parseShow, loadShow, hasErrors, mediaUrl } = require('../src/engine/show');

function msgs(r) {
  return r.problems.map((p) => p.msg).join('\n');
}

test('El guió d\'exemple del projecte és vàlid', () => {
  const r = loadShow(path.join(__dirname, '..', 'show'));
  assert.ok(r.show, msgs(r));
  assert.strictEqual(hasErrors(r.problems), false, msgs(r));
  const slides = r.show.cues.find((c) => c.type === 'slides');
  assert.ok(slides.images.length > 0, 'la carpeta de fotos es resol');
});

test('Detecta referències trencades, ids repetits i tipus desconeguts', () => {
  const r = parseShow(`
cues:
  - { id: a, tipus: video, fitxer: a.mp4, seguent: zz }
  - { id: a, tipus: festa }
  - id: v
    tipus: votacio
    per_defecte: 5
    opcions: [{ text: X, va_a: nope }]
`);
  const text = msgs(r);
  assert.match(text, /seguent.*zz/);
  assert.match(text, /Id de cue repetit/);
  assert.match(text, /Tipus desconegut/);
  assert.match(text, /almenys 2 opcions/);
  assert.match(text, /per_defecte/);
  assert.match(text, /nope/);
  assert.ok(hasErrors(r.problems));
});

test('Error de sintaxi YAML no peta', () => {
  const r = parseShow('cues: [ { id: a');
  assert.strictEqual(r.show, null);
  assert.match(msgs(r), /YAML/);
});

test('Fitxers inexistents: error per vídeo, avís per avatar', () => {
  const r = parseShow(`
participants: [{ id: p, nom: P, avatar: no/hi/es.png }]
cues: [{ id: a, tipus: video, fitxer: no/hi/es.mp4 }]
`, __dirname);
  const levels = r.problems.map((p) => p.level).sort();
  assert.deepStrictEqual(levels, ['error', 'warn']);
});

test('mediaUrl codifica cada tram i accepta barres de Windows', () => {
  assert.strictEqual(mediaUrl('media\\vídeos\\cap 1.mp4'), '/show/media/v%C3%ADdeos/cap%201.mp4');
  assert.strictEqual(mediaUrl(null), null);
});
