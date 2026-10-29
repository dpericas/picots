'use strict';
// Durada estimada de l'espectacle i temps real dels assajos.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const timing = require('../src/engine/timing');
const { parseShow } = require('../src/engine/show');
const { Engine } = require('../src/engine/engine');
const { MemoryJournal } = require('../src/engine/journal');

function box(type, payload) {
  const b = Buffer.alloc(8);
  b.writeUInt32BE(8 + payload.length, 0);
  b.write(type, 4, 'latin1');
  return Buffer.concat([b, payload]);
}

test('mp4Duration: llegeix la caixa mvhd (versions 0 i 1)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gala-mvhd-'));
  try {
    const v0 = Buffer.alloc(100);
    v0.writeUInt32BE(1000, 12); // timescale
    v0.writeUInt32BE(83500, 16); // durada
    const v1 = Buffer.alloc(112);
    v1[0] = 1;
    v1.writeUInt32BE(600, 20);
    v1.writeBigUInt64BE(BigInt(600 * 125), 24);
    const f0 = path.join(dir, 'a.mp4');
    const f1 = path.join(dir, 'b.mp4');
    fs.writeFileSync(f0, Buffer.concat([box('ftyp', Buffer.alloc(8)), box('mdat', Buffer.alloc(50)),
      box('moov', Buffer.concat([box('mvhd', v0), box('trak', Buffer.alloc(20))]))]));
    fs.writeFileSync(f1, Buffer.concat([box('ftyp', Buffer.alloc(8)), box('moov', box('mvhd', v1))]));
    assert.strictEqual(timing.mp4Duration(f0), 83.5);
    assert.strictEqual(timing.mp4Duration(f1), 125);
    fs.writeFileSync(path.join(dir, 'c.mp4'), 'no és un mp4');
    assert.strictEqual(timing.mp4Duration(path.join(dir, 'c.mp4')), null);
    assert.strictEqual(timing.mp4Duration(path.join(dir, 'no-hi-és.mp4')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseDuration: segons, m:ss i h:mm:ss', () => {
  assert.strictEqual(timing.parseDuration(90), 90);
  assert.strictEqual(timing.parseDuration('90'), 90);
  assert.strictEqual(timing.parseDuration('2:30'), 150);
  assert.strictEqual(timing.parseDuration('1:02:03'), 3723);
  assert.strictEqual(timing.parseDuration('dos minuts'), null);
  assert.strictEqual(timing.parseDuration(null), null);
});

const SHOW = `
participants:
  - { id: a, nom: A, video_entrada: a.mp4 }
  - { id: b, nom: B }
cues:
  - { id: ent, tipus: entrada }
  - { id: v, tipus: video, fitxer: v.mp4 }
  - { id: fotos, tipus: diapositives, imatges: [1.jpg, 2.jpg, 3.jpg], segons: 5 }
  - { id: hola, tipus: espera, durada_estimada: "3:00" }
  - id: q
    tipus: questionari
    preguntes: [{ pregunta: P, opcions: [x, y], correcta: A, temps: 15 }]
  - { id: r, tipus: repte, temps: 20, si_exit: m }
  - { id: m, tipus: mencions }
  - { id: x, tipus: espera }
`;

test('estimateCue: vídeos mesurats, fotos exactes i la resta estimada', () => {
  const r = parseShow(SHOW);
  assert.deepStrictEqual(r.problems.filter((p) => p.level === 'error'), []);
  const show = r.show;
  const secs = { 'a.mp4': 30, 'v.mp4': 95 };
  const est = (id) => timing.estimateCue(show.cues.find((c) => c.id === id), show, (rel) => (rel in secs ? secs[rel] : null));
  const G = timing.GUESS;
  assert.deepStrictEqual(est('v'), { seconds: 95, approx: false });
  assert.deepStrictEqual(est('fotos'), { seconds: 15, approx: false });
  assert.deepStrictEqual(est('hola'), { seconds: 180, approx: false, manual: true });
  assert.strictEqual(est('ent').seconds, G.paradeIntro + G.paradeFinal + 30 + G.paradeVideoExtra + G.paradeKid);
  assert.strictEqual(est('q').seconds, G.quizIntro + G.quizRanking + 15 + G.quizPerQuestion);
  assert.strictEqual(est('r').seconds, 20 + G.challengeExtra);
  assert.strictEqual(est('m').seconds, G.awardsIntro + G.awardsFinal + 2 * G.awardsKid);
  assert.ok(est('ent').approx);
  const missing = timing.estimateCue(show.cues.find((c) => c.id === 'v'), show, () => null);
  assert.ok(missing.unknown);
  assert.match(parseShow(SHOW.replace('"3:00"', 'molt')).problems.map((p) => p.msg).join(), /durada_estimada/);
});

test('actualTimes: temps real per cue a partir del diari, sumant les tornades', () => {
  let clock = 1000;
  const e = new Engine({ show: parseShow(SHOW).show, journal: new MemoryJournal(), now: () => clock, timers: false });
  e.dispatch({ name: 'go' });
  clock += 40000;
  e.dispatch({ name: 'jump', cueId: 'v' });
  clock += 100000;
  e.dispatch({ name: 'jump', cueId: 'ent' });
  clock += 5000;
  e.dispatch({ name: 'jump', cueId: 'x' });
  clock += 2000;
  const t = timing.actualTimes(e.state.timeline, clock);
  assert.deepStrictEqual(t, { ent: 45, v: 100, x: 2 });
  e.dispatch({ name: 'go' }); // fi
  clock += 60000;
  assert.strictEqual(timing.actualTimes(e.state.timeline, clock).x, 2, 'després de la fi ja no compta');
});
