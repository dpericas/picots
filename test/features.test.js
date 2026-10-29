'use strict';
// Qüestionari, repte col·lectiu, mencions i mur de missatges.

const test = require('node:test');
const assert = require('node:assert');

const { Engine } = require('../src/engine/engine');
const { MemoryJournal } = require('../src/engine/journal');
const { parseShow } = require('../src/engine/show');
const { screenView, playView, controlView } = require('../src/engine/views');
const quiz = require('../src/engine/quiz');

const YAML_SHOW = `
titol: Prova
participants:
  - { id: a, nom: A, mencio: "La més riallera" }
  - { id: b, nom: B, mencio: "El més curiós" }
  - { id: c, nom: C }
cues:
  - id: q
    tipus: qüestionari
    temps: 10
    preguntes:
      - { pregunta: "Quin color?", opcions: [Vermell, Blau, Verd], correcta: B }
      - { pregunta: "Quants?", opcions: ["1", "2"], correcta: 0, temps: 20 }
  - id: r
    tipus: repte
    modalitat: tocs
    objectiu: 30
    temps: 15
    si_exit: extra
  - { id: normal, tipus: espera, text: Normal, seguent: m }
  - { id: extra, tipus: espera, text: Extra }
  - id: m
    tipus: mencions
    mencions: { c: "La més valenta" }
  - { id: mur, tipus: mur, text: "Envieu un missatge!", maxim_per_nen: 2 }
`;

const DRAWING = 'data:image/png;base64,iVBORw0KGgo=';

function makeShow(text) {
  const r = parseShow(text || YAML_SHOW);
  assert.deepStrictEqual(r.problems.filter((p) => p.level === 'error'), []);
  return r.show;
}

function makeEngine(opts) {
  opts = opts || {};
  let clock = 1000000;
  const engine = new Engine({
    show: makeShow(opts.yaml),
    journal: opts.journal || new MemoryJournal(),
    now: () => clock,
    timers: false,
  });
  engine.advance = (ms) => { clock += ms; };
  return engine;
}

function ok(engine, cmd) {
  const r = engine.dispatch(cmd);
  assert.ok(r.ok, 'ordre ' + cmd.name + ' ha fallat: ' + r.error);
}

function fail(engine, cmd, pattern) {
  const r = engine.dispatch(cmd);
  assert.strictEqual(r.ok, false, 'ordre ' + cmd.name + ' hauria d\'haver fallat');
  if (pattern) assert.match(r.error, pattern);
}

function claimAll(engine, ids) {
  (ids || ['a', 'b', 'c']).forEach((id) => ok(engine, { name: 'claim', deviceId: 'd-' + id, participantId: id }));
}

test('guió: qüestionari, repte, mencions i mur es normalitzen', () => {
  const show = makeShow();
  const q = show.cues.find((c) => c.id === 'q');
  assert.strictEqual(q.type, 'quiz');
  assert.strictEqual(q.questions[0].correct, 1);
  assert.strictEqual(q.questions[1].correct, 0);
  assert.strictEqual(q.questions[0].duration, 10);
  assert.strictEqual(q.questions[1].duration, 20);
  const r = show.cues.find((c) => c.id === 'r');
  assert.deepStrictEqual([r.type, r.mode, r.goal, r.successGoto, r.failGoto], ['challenge', 'taps', 30, 'extra', null]);
  const m = show.cues.find((c) => c.id === 'm');
  assert.deepStrictEqual(m.mentionFor, { a: 'La més riallera', b: 'El més curiós', c: 'La més valenta' });
  const w = show.cues.find((c) => c.id === 'mur');
  assert.deepStrictEqual([w.type, w.moderation, w.drawings, w.maxPerPerson], ['wall', true, true, 2]);
});

test('guió: errors del qüestionari i del repte', () => {
  const r = parseShow(`
participants: [{ id: a, nom: A }]
cues:
  - id: q
    tipus: questionari
    preguntes:
      - { pregunta: X, opcions: [a, b], correcta: C }
      - { pregunta: Y, opcions: [a, b, c, d, e], correcta: A }
  - { id: r, tipus: repte, modalitat: rapid, si_exit: nowhere }
  - { id: m, tipus: mencions, mencions: { zz: Hola } }
`);
  const msgs = r.problems.filter((p) => p.level === 'error').map((p) => p.msg).join('\n');
  assert.match(msgs, /Pregunta 1: "correcta"/);
  assert.match(msgs, /Pregunta 2: ha de tenir entre 2 i 4/);
  assert.match(msgs, /Modalitat desconeguda/);
  assert.match(msgs, /"si_exit" apunta a una cue que no existeix/);
  assert.match(msgs, /"mencions" inclou un participant que no existeix: zz/);
  assert.ok(r.problems.some((p) => p.level === 'warn' && /A no té menció/.test(p.msg)));
});

test('qüestionari: passos, compte enrere, punts i classificació', () => {
  const e = makeEngine();
  claimAll(e);
  ok(e, { name: 'go' }); // entra al qüestionari (inici)
  const cue = e.currentCue();
  assert.strictEqual(e.stepCount(cue), 8);
  assert.deepStrictEqual(
    Array.from({ length: 8 }, (_, i) => e.stepLabel(cue, i)),
    ['Inici', 'P1 · pregunta', 'P1 · resposta oberta', 'P1 · solució',
      'P2 · pregunta', 'P2 · resposta oberta', 'P2 · solució', 'Classificació'],
  );
  ok(e, { name: 'go' }); // P1 es llegeix
  fail(e, { name: 'answer', deviceId: 'd-a', option: 1 }, /cap pregunta oberta/);
  ok(e, { name: 'go' }); // P1 oberta
  assert.strictEqual(e.state.stepEndsAt, e.now() + 10000);
  // Sense resposta correcta al mòbil abans de la solució.
  assert.strictEqual(playView(e, 'd-a').quiz.correct, undefined);
  assert.strictEqual(screenView(e, {}).quiz.correct, undefined);

  ok(e, { name: 'answer', deviceId: 'd-a', option: 1 }); // a l'instant: 1000
  fail(e, { name: 'answer', deviceId: 'd-a', option: 0 }, /Ja has respost/);
  e.advance(5000);
  ok(e, { name: 'answer', deviceId: 'd-b', option: 1 }); // a la meitat: 750
  assert.strictEqual(e.state.step, 2, 'encara falta un nen per respondre');
  ok(e, { name: 'answer', deviceId: 'd-c', option: 0 }); // incorrecta
  assert.strictEqual(e.state.step, 3, 'quan responen tots es passa a la solució');

  const sv = screenView(e, {}).quiz;
  assert.strictEqual(sv.kind, 'reveal');
  assert.strictEqual(sv.correct, 1);
  assert.deepStrictEqual(sv.counts, [1, 2, 0]);
  assert.deepStrictEqual(sv.top.map((r) => [r.id, r.points, r.rank]), [['a', 1000, 1], ['b', 750, 2], ['c', 0, 3]]);
  const pa = playView(e, 'd-b').quiz;
  assert.deepStrictEqual([pa.myAnswer, pa.correct, pa.myPoints, pa.myTotal, pa.myRank], [1, 1, 750, 750, 2]);

  ok(e, { name: 'go' }); // P2 pregunta
  ok(e, { name: 'go' }); // P2 oberta
  e.advance(25000);
  fail(e, { name: 'answer', deviceId: 'd-c', option: 0 }, /acabat el temps/);
  ok(e, { name: 'go' }); // el tècnic tanca: solució
  ok(e, { name: 'go' }); // classificació
  assert.strictEqual(screenView(e, {}).quiz.kind, 'ranking');
  assert.strictEqual(e.describeGo().cueId, 'r');
});

test('qüestionari: ENRERE torna a obrir la pregunta, +15 s i repetir pregunta', () => {
  const e = makeEngine();
  claimAll(e, ['a', 'b']);
  ok(e, { name: 'go' });
  ok(e, { name: 'step', step: 2 }); // P1 oberta directament
  ok(e, { name: 'answer', deviceId: 'd-a', option: 0 });
  const ends = e.state.stepEndsAt;
  ok(e, { name: 'quiz.extend', seconds: 15 });
  assert.strictEqual(e.state.stepEndsAt, ends + 15000);
  ok(e, { name: 'go' }); // solució
  fail(e, { name: 'quiz.extend' }, /cap pregunta oberta/);
  ok(e, { name: 'back' }); // torna a oberta, amb temps nou
  assert.strictEqual(e.state.step, 2);
  assert.ok(e.state.stepEndsAt > e.now());
  fail(e, { name: 'answer', deviceId: 'd-a', option: 1 }, /Ja has respost/);
  ok(e, { name: 'quiz.reset' });
  ok(e, { name: 'answer', deviceId: 'd-a', option: 1 });
  assert.strictEqual(e.state.quiz.q[0].a.option, 1);
});

test('qüestionari: classificacio 0 no mostra punts', () => {
  const e = makeEngine({ yaml: YAML_SHOW.replace('    temps: 10\n', '    temps: 10\n    classificacio: 0\n') });
  claimAll(e, ['a']);
  ok(e, { name: 'go' });
  ok(e, { name: 'step', step: 2 });
  ok(e, { name: 'answer', deviceId: 'd-a', option: 1 });
  assert.strictEqual(e.state.step, 3);
  assert.strictEqual(screenView(e, {}).quiz.top, undefined);
  assert.strictEqual(playView(e, 'd-a').quiz.myTotal, undefined);
  assert.strictEqual(playView(e, 'd-a').quiz.myPoints, 1000, 'el mòbil sí que diu si l\'ha encertada');
  assert.strictEqual(e.stepLabel(e.currentCue(), 7), 'Final');
});

test('repte: els tocs arriben a l\'objectiu i s\'obre l\'escena extra', () => {
  const e = makeEngine();
  claimAll(e);
  ok(e, { name: 'jump', cueId: 'r' });
  assert.deepStrictEqual(e.upcomingCueIds().sort(), ['extra', 'normal']);
  fail(e, { name: 'tap', deviceId: 'd-a', n: 5 }, /cap repte en marxa/);
  assert.strictEqual(e.describeGo().action, 'challenge.open');
  ok(e, { name: 'go' });
  const seqBefore = e.state.seq;
  ok(e, { name: 'tap', deviceId: 'd-a', n: 10 });
  assert.strictEqual(e.state.seq, seqBefore, 'els tocs no s\'escriuen un a un al diari');
  assert.strictEqual(screenView(e, {}).challenge.total, 10);
  ok(e, { name: 'tap', deviceId: 'd-b', n: 500 }); // es limita a 20 per missatge
  assert.strictEqual(screenView(e, {}).challenge.total, 30);
  assert.strictEqual(e.state.challenges.r.status, 'closed', '10 + 20 = 30: objectiu assolit');
  assert.strictEqual(e.state.challenges.r.result, 'success');
  assert.deepStrictEqual(e.state.challenges.r.taps, { a: 10, b: 20 });
  assert.deepStrictEqual(e.describeGo(), { action: 'enter', cueId: 'extra' });
  assert.strictEqual(playView(e, 'd-a').challenge.mine, 10);
});

test('repte: sense arribar-hi va a la cue de sota; forçar i reiniciar', () => {
  const e = makeEngine();
  claimAll(e);
  ok(e, { name: 'jump', cueId: 'r' });
  ok(e, { name: 'go' });
  ok(e, { name: 'tap', deviceId: 'd-a', n: 3 });
  e.flushTaps();
  assert.deepStrictEqual(e.state.challenges.r.taps, { a: 3 });
  ok(e, { name: 'go' }); // el tècnic l'atura
  assert.strictEqual(e.state.challenges.r.result, 'fail');
  assert.deepStrictEqual(e.describeGo(), { action: 'enter', cueId: 'normal' });
  ok(e, { name: 'challenge.force', result: 'success', source: 'manual' });
  assert.deepStrictEqual(e.describeGo(), { action: 'enter', cueId: 'extra' });
  ok(e, { name: 'challenge.reset' });
  assert.strictEqual(e.describeGo().action, 'challenge.open');
  ok(e, { name: 'go' });
  assert.strictEqual(screenView(e, {}).challenge.total, 0, 'el repte reiniciat comença de zero');
});

test('repte: els tocs desats es recuperen després d\'una caiguda', () => {
  const journal = new MemoryJournal();
  const e = makeEngine({ journal });
  claimAll(e);
  ok(e, { name: 'jump', cueId: 'r' });
  ok(e, { name: 'go' });
  ok(e, { name: 'tap', deviceId: 'd-a', n: 7 });
  e.flushTaps();
  ok(e, { name: 'tap', deviceId: 'd-a', n: 2 }); // encara no desat
  const e2 = makeEngine({ journal });
  assert.strictEqual(e2.challengeProgress(e2.currentCue()).total, 7);
  ok(e2, { name: 'tap', deviceId: 'd-b', n: 4 });
  assert.strictEqual(e2.challengeProgress(e2.currentCue()).total, 11);
});

test('repte modalitat "tots": cal que premin tots els que tenen mòbil', () => {
  const e = makeEngine({ yaml: YAML_SHOW.replace('modalitat: tocs', 'modalitat: tots') });
  claimAll(e, ['a', 'b']);
  ok(e, { name: 'jump', cueId: 'r' });
  ok(e, { name: 'go' });
  ok(e, { name: 'tap', deviceId: 'd-a' });
  ok(e, { name: 'tap', deviceId: 'd-a' });
  assert.deepStrictEqual([screenView(e, {}).challenge.total, screenView(e, {}).challenge.goal], [1, 2]);
  ok(e, { name: 'tap', deviceId: 'd-b' });
  assert.strictEqual(e.state.challenges.r.result, 'success');
});

test('mencions: un pas per nen amb la seva menció', () => {
  const e = makeEngine();
  ok(e, { name: 'jump', cueId: 'm' });
  const cue = e.currentCue();
  assert.strictEqual(e.stepCount(cue), 5);
  assert.strictEqual(e.stepLabel(cue, 3), 'C');
  const people = screenView(e, {}).cue.people;
  assert.deepStrictEqual(people.map((p) => p.mention), ['La més riallera', 'El més curiós', 'La més valenta']);
  ok(e, { name: 'go' });
  ok(e, { name: 'go' });
  ok(e, { name: 'back' });
  assert.strictEqual(e.state.step, 1);
});

test('mur: moderació, límits i dibuixos', () => {
  const journal = new MemoryJournal();
  const e = makeEngine({ journal });
  claimAll(e);
  fail(e, { name: 'wall.post', deviceId: 'd-a', text: 'Hola' }, /no es poden enviar/);
  ok(e, { name: 'jump', cueId: 'mur' });
  fail(e, { name: 'wall.post', deviceId: 'd-x', text: 'Hola' }, /triar qui ets/);
  fail(e, { name: 'wall.post', deviceId: 'd-a', text: '   ' }, /Escriu alguna cosa/);
  fail(e, { name: 'wall.post', deviceId: 'd-a', text: 'x'.repeat(101) }, /massa llarg/);
  fail(e, { name: 'wall.post', deviceId: 'd-a', drawing: 'data:text/html;base64,AAAA' }, /no és vàlid/);
  ok(e, { name: 'wall.post', deviceId: 'd-a', text: 'Gràcies\nprofes!' });
  fail(e, { name: 'wall.post', deviceId: 'd-a', text: 'Un altre' }, /Espera uns segons/);
  e.advance(4000);
  ok(e, { name: 'wall.post', deviceId: 'd-a', drawing: DRAWING });
  e.advance(4000);
  fail(e, { name: 'wall.post', deviceId: 'd-a', text: 'Tercer' }, /Ja has enviat 2/);

  const [m1, m2] = e.state.wall;
  assert.strictEqual(m1.text, 'Gràcies profes!');
  assert.strictEqual(m1.status, 'pending');
  assert.strictEqual(m2.drawing, true);
  assert.strictEqual(e.drawings.get(m2.id), DRAWING);
  assert.strictEqual(screenView(e, {}).wall.posts.length, 0, 'el projector no veu res sense aprovar');
  assert.strictEqual(controlView(e, { personalUrl: () => '' }).wall.posts.length, 2);

  ok(e, { name: 'wall.moderate', id: m1.id, status: 'approved' });
  ok(e, { name: 'wall.moderate', id: m2.id, status: 'rejected' });
  const posts = screenView(e, {}).wall.posts;
  assert.deepStrictEqual(posts.map((p) => [p.text, p.author.name]), [['Gràcies profes!', 'A']]);
  // Un missatge rebutjat no compta per al límit.
  ok(e, { name: 'wall.post', deviceId: 'd-a', text: 'Tercer' });
  assert.strictEqual(playView(e, 'd-a').wall.left, 0);

  const e2 = makeEngine({ journal });
  assert.strictEqual(e2.drawings.get(m2.id), DRAWING, 'els dibuixos es recuperen del diari');
});

test('quiz.points: de 500 a 1000 segons la rapidesa', () => {
  const question = { correct: 1, duration: 10 };
  assert.strictEqual(quiz.points(question, { option: 1, ms: 0 }), 1000);
  assert.strictEqual(quiz.points(question, { option: 1, ms: 10000 }), 500);
  assert.strictEqual(quiz.points(question, { option: 0, ms: 0 }), 0);
  assert.strictEqual(quiz.points(question, null), 0);
  assert.deepStrictEqual(quiz.ranking({ x: 5, y: 9, z: 5 }).map((r) => [r.id, r.rank]), [['y', 1], ['x', 2], ['z', 2]]);
});

test('temporitzadors: la pregunta i el repte es tanquen sols', async () => {
  const yaml = YAML_SHOW.replace('    temps: 10\n', '    temps: 0.05\n').replace('temps: 15', 'temps: 0.08')
    .replace('correcta: 0, temps: 20', 'correcta: 0');
  const e = new Engine({ show: makeShow(yaml), journal: new MemoryJournal() });
  try {
    ok(e, { name: 'claim', deviceId: 'd-a', participantId: 'a' });
    ok(e, { name: 'go' });
    ok(e, { name: 'step', step: 2 });
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(e.state.step, 3, 'la pregunta passa sola a la solució');
    ok(e, { name: 'jump', cueId: 'r' });
    ok(e, { name: 'go' });
    ok(e, { name: 'tap', deviceId: 'd-a', n: 4 });
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(e.state.challenges.r.status, 'closed');
    assert.strictEqual(e.state.challenges.r.result, 'fail');
    assert.strictEqual(e.state.challenges.r.reason, 'timer');
    assert.deepStrictEqual(e.state.challenges.r.taps, { a: 4 });
  } finally {
    e.dispose();
  }
});
