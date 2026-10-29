'use strict';
// Generador de vídeos d'entrada: planificació, ordres d'ffmpeg i actualització del guió.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ev = require('../src/tools/entry-videos');

test('plan: la durada total quadra amb les fotos i les transicions', () => {
  const p = ev.plan(10, { duration: 30, transition: 0.6 });
  assert.ok(Math.abs(p.total - 30) < 1e-9);
  assert.ok(Math.abs(p.photo - (30 + 9 * 0.6) / 10) < 1e-9);
  assert.deepStrictEqual(p.notes, []);
  // Massa fotos: cada foto es veu com a mínim 1 s i el vídeo s'allarga.
  const many = ev.plan(60, { duration: 30, transition: 0.6 });
  assert.strictEqual(many.photo, 1.6);
  assert.ok(many.total > 30);
  assert.match(many.notes[0], /massa fotos/);
  // Una sola foto: sense transicions, com a molt 4 s.
  const one = ev.plan(1, { duration: 30 });
  assert.deepStrictEqual([one.transition, one.photo, one.total], [0, 4, 4]);
});

test('joinArgs: transicions encadenades, música amb fos i volum igualat', () => {
  const p = ev.plan(3, { duration: 10, transition: 0.5, start: 12 });
  const args = ev.joinArgs(['a.mp4', 'b.mp4', 'c.mp4'], 'song.mp3', p, 'out.mp4');
  const filter = args[args.indexOf('-filter_complex') + 1];
  const step = p.photo - p.transition;
  assert.ok(filter.includes('xfade=transition=fade:duration=0.5:offset=' + (Math.round(step * 1000) / 1000)));
  assert.ok(filter.includes('offset=' + (Math.round(2 * step * 1000) / 1000) + '[vx]'));
  assert.ok(filter.includes('loudnorm'));
  assert.ok(filter.includes('afade=t=out:st=7.5:d=2.5'));
  assert.deepStrictEqual(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 4), ['-ss', '12', '-i', 'song.mp3']);
  assert.strictEqual(args[args.indexOf('-t') + 1], '10');
  assert.ok(args.includes('+faststart'));
  // Sense música: cap entrada ni mapa d'àudio.
  const silent = ev.joinArgs(['a.mp4'], null, ev.plan(1, {}), 'out.mp4');
  assert.ok(!silent.includes('-ss'));
  assert.ok(!silent.includes('[a]'));
});

test('listJobs: carpetes per id, fotos per ordre natural i avisos', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gala-fonts-'));
  try {
    const mk = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text || 'x');
    };
    mk('anna/10.jpg'); mk('anna/2.jpg'); mk('anna/1.JPG'); mk('anna/canco.mp3'); mk('anna/notes.txt');
    mk('anna/config.yaml', 'inici: 45\ndurada: 25\n');
    mk('biel/1.png');
    mk('desconegut/1.jpg');
    fs.mkdirSync(path.join(root, 'buit'));
    const participants = [{ id: 'anna', name: 'Anna' }, { id: 'biel', name: 'Biel' }, { id: 'carla', name: 'Carla' }];
    const r = ev.listJobs({ sourcesDir: root, participants });
    assert.deepStrictEqual(r.jobs.map((j) => j.id), ['anna', 'biel']);
    const anna = r.jobs[0];
    assert.deepStrictEqual(anna.images.map((f) => path.basename(f)), ['1.JPG', '2.jpg', '10.jpg']);
    assert.strictEqual(path.basename(anna.music), 'canco.mp3');
    assert.deepStrictEqual(anna.config, { start: 45, duration: 25 });
    const w = r.warnings.join('\n');
    assert.match(w, /biel: no hi ha cap cançó/);
    assert.match(w, /"desconegut" no correspon/);
    assert.match(w, /Carla \(carla\) no té carpeta/);
    const only = ev.listJobs({ sourcesDir: root, participants, only: ['biel'] });
    assert.deepStrictEqual(only.jobs.map((j) => j.id), ['biel']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('updateShowText: posa video_entrada i conserva els comentaris', () => {
  const text = [
    '# Guió de prova',
    'participants:',
    '  # comentari de la llista',
    '  - { id: anna, nom: Anna }',
    '  - { id: biel, nom: Biel, video_entrada: media/entrada/biel.mp4 }',
    'cues: []',
    '',
  ].join('\n');
  const r = ev.updateShowText(text, { anna: 'media/entrada/anna.mp4', biel: 'media/entrada/biel.mp4' });
  assert.deepStrictEqual(r.changed, ['anna']);
  assert.ok(r.text.includes('# Guió de prova'));
  assert.ok(r.text.includes('# comentari de la llista'));
  assert.ok(r.text.includes('video_entrada: media/entrada/anna.mp4'));
  assert.strictEqual(ev.updateShowText(r.text, { anna: 'media/entrada/anna.mp4' }).changed.length, 0);
});
