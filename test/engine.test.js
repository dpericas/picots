'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Engine } = require('../src/engine/engine');
const { MemoryJournal } = require('../src/engine/journal');
const { parseShow } = require('../src/engine/show');

const YAML_SHOW = `
titol: Prova
participants:
  - { id: a, nom: A }
  - { id: b, nom: B }
  - { id: c, nom: C }
cues:
  - { id: intro, tipus: video, fitxer: x.mp4, auto: true }
  - id: v1
    tipus: votacio
    pregunta: Quina?
    temps: 30
    empat: TIE
    per_defecte: 1
    opcions:
      - { text: Bosc, va_a: bosc }
      - { text: Castell, va_a: castell }
  - { id: bosc, tipus: video, fitxer: b.mp4, seguent: fi }
  - { id: castell, tipus: video, fitxer: c.mp4 }
  - { id: fi, tipus: espera, text: Fi }
`;

function makeShow(tie) {
  const r = parseShow(YAML_SHOW.replace('TIE', tie || 'aleatori'));
  assert.deepStrictEqual(r.problems, []);
  return r.show;
}

function makeEngine(opts) {
  opts = opts || {};
  let clock = 1000000;
  const journal = opts.journal || new MemoryJournal();
  const engine = new Engine({
    show: makeShow(opts.tie),
    journal,
    now: () => clock,
    random: opts.random || (() => 0),
    timers: false,
    keyFor: (pid) => 'key-' + pid,
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
  assert.strictEqual(r.ok, false);
  if (pattern) assert.match(r.error, pattern);
}

function claimAll(engine) {
  ok(engine, { name: 'claim', deviceId: 'da', participantId: 'a' });
  ok(engine, { name: 'claim', deviceId: 'db', participantId: 'b' });
  ok(engine, { name: 'claim', deviceId: 'dc', participantId: 'c' });
}

test('GO recorre les cues en ordre i acaba amb show.end', () => {
  const e = makeEngine();
  ok(e, { name: 'go' });
  assert.strictEqual(e.state.cueId, 'intro');
  ok(e, { name: 'jump', cueId: 'bosc' });
  ok(e, { name: 'go' });
  assert.strictEqual(e.state.cueId, 'fi', 'seguent explícit');
  ok(e, { name: 'go' });
  assert.strictEqual(e.state.ended, true);
  fail(e, { name: 'go' });
});

test('ENRERE desfà el camí seguit, inclosos els salts', () => {
  const e = makeEngine();
  ok(e, { name: 'go' });
  ok(e, { name: 'go' }); // -> v1
  ok(e, { name: 'jump', cueId: 'castell' });
  ok(e, { name: 'back' });
  assert.strictEqual(e.state.cueId, 'v1');
  ok(e, { name: 'back' });
  assert.strictEqual(e.state.cueId, 'intro');
  fail(e, { name: 'back' }, /anterior/);
});

test('ENRERE després del final torna a la darrera cue', () => {
  const e = makeEngine();
  ok(e, { name: 'jump', cueId: 'fi' });
  ok(e, { name: 'go' });
  assert.strictEqual(e.state.ended, true);
  ok(e, { name: 'back' });
  assert.strictEqual(e.state.ended, false);
  assert.strictEqual(e.state.cueId, 'fi');
});

test('Flux complet de votació amb GO: obrir, tancar i seguir la branca guanyadora', () => {
  const e = makeEngine();
  claimAll(e);
  ok(e, { name: 'jump', cueId: 'v1' });
  fail(e, { name: 'ballot', deviceId: 'da', option: 0 }, /cap votació oberta/);
  ok(e, { name: 'go' });
  assert.strictEqual(e.state.votes.v1.status, 'open');
  assert.strictEqual(e.state.votes.v1.endsAt, 1000000 + 30000);
  ok(e, { name: 'ballot', deviceId: 'da', option: 1 });
  ok(e, { name: 'ballot', deviceId: 'db', option: 1 });
  ok(e, { name: 'ballot', deviceId: 'dc', option: 0 });
  ok(e, { name: 'go' });
  assert.strictEqual(e.state.votes.v1.status, 'closed');
  assert.deepStrictEqual(e.state.votes.v1.counts, [1, 2]);
  assert.strictEqual(e.state.votes.v1.result, 1);
  ok(e, { name: 'go' });
  assert.strictEqual(e.state.cueId, 'castell');
});

test('Un participant pot canviar el vot mentre està oberta; un dispositiu sense nom no pot votar', () => {
  const e = makeEngine();
  claimAll(e);
  ok(e, { name: 'jump', cueId: 'v1' });
  ok(e, { name: 'vote.open' });
  ok(e, { name: 'ballot', deviceId: 'da', option: 0 });
  ok(e, { name: 'ballot', deviceId: 'da', option: 1 });
  fail(e, { name: 'ballot', deviceId: 'desconegut', option: 0 }, /triar qui ets/);
  fail(e, { name: 'ballot', deviceId: 'da', option: 7 }, /Opció/);
  ok(e, { name: 'vote.close' });
  assert.deepStrictEqual(e.state.votes.v1.counts, [0, 1]);
  fail(e, { name: 'ballot', deviceId: 'db', option: 0 });
});

test('Sense vots: s\'aplica per_defecte', () => {
  const e = makeEngine();
  ok(e, { name: 'jump', cueId: 'v1' });
  ok(e, { name: 'vote.open' });
  ok(e, { name: 'vote.close', reason: 'timer' });
  assert.strictEqual(e.state.votes.v1.result, 1);
  assert.strictEqual(e.state.votes.v1.reason, 'no_votes');
});

test('Empat: regles aleatori, primera i operador', () => {
  for (const [tie, expected] of [['aleatori', 1], ['primera', 0], ['operador', null]]) {
    const e = makeEngine({ tie, random: () => 0.99 });
    claimAll(e);
    ok(e, { name: 'jump', cueId: 'v1' });
    ok(e, { name: 'vote.open' });
    ok(e, { name: 'ballot', deviceId: 'da', option: 0 });
    ok(e, { name: 'ballot', deviceId: 'db', option: 1 });
    ok(e, { name: 'vote.close' });
    assert.strictEqual(e.state.votes.v1.result, expected, tie);
    assert.strictEqual(e.state.votes.v1.tied, true);
    if (tie === 'operador') {
      assert.strictEqual(e.state.votes.v1.status, 'tie');
      fail(e, { name: 'go' }, /Empat/);
      ok(e, { name: 'vote.force', option: 0 });
      ok(e, { name: 'go' });
      assert.strictEqual(e.state.cueId, 'bosc');
    }
  }
});

test('Pla B: resultat a mà alçada sense obrir la votació', () => {
  const e = makeEngine();
  ok(e, { name: 'jump', cueId: 'v1' });
  ok(e, { name: 'vote.force', option: 0, source: 'manual' });
  assert.strictEqual(e.state.votes.v1.reason, 'manual');
  ok(e, { name: 'go' });
  assert.strictEqual(e.state.cueId, 'bosc');
});

test('Reiniciar i allargar una votació', () => {
  const e = makeEngine();
  claimAll(e);
  ok(e, { name: 'jump', cueId: 'v1' });
  ok(e, { name: 'vote.open' });
  e.advance(25000);
  ok(e, { name: 'vote.extend', seconds: 15 });
  assert.strictEqual(e.state.votes.v1.endsAt, 1000000 + 30000 + 15000);
  ok(e, { name: 'ballot', deviceId: 'da', option: 0 });
  ok(e, { name: 'vote.close' });
  fail(e, { name: 'vote.open' }, /Reinicia/);
  ok(e, { name: 'vote.reset' });
  assert.strictEqual(e.state.votes.v1, undefined);
  ok(e, { name: 'vote.open' });
  assert.deepStrictEqual(e.state.votes.v1.ballots, {});
});

test('Reclamar participants: un dispositiu = un nen, i la clau personal permet recuperar-lo', () => {
  const e = makeEngine();
  ok(e, { name: 'claim', deviceId: 'd1', participantId: 'a' });
  fail(e, { name: 'claim', deviceId: 'd2', participantId: 'a' }, /ja l'ha agafat/);
  ok(e, { name: 'claim', deviceId: 'd2', participantId: 'a', key: 'key-a' });
  assert.strictEqual(e.state.claims.a, 'd2');
  ok(e, { name: 'claim', deviceId: 'd2', participantId: 'b' });
  assert.strictEqual(e.state.claims.a, undefined, 'un dispositiu només té un participant');
  fail(e, { name: 'release', deviceId: 'd9', participantId: 'b' }, /no representa/);
  ok(e, { name: 'release', participantId: 'b' });
  assert.deepStrictEqual(e.state.claims, {});
});

test('video.ended avança només si la cue és auto i l\'avís és de l\'entrada actual', () => {
  const e = makeEngine();
  ok(e, { name: 'go' });
  const seq = e.state.enterSeq;
  ok(e, { name: 'video.ended', cueId: 'intro', enterSeq: seq - 1 });
  assert.strictEqual(e.state.cueId, 'intro', 'avís antic ignorat');
  ok(e, { name: 'video.ended', cueId: 'intro', enterSeq: seq });
  assert.strictEqual(e.state.cueId, 'v1');
  ok(e, { name: 'video.ended', cueId: 'intro', enterSeq: seq });
  assert.strictEqual(e.state.cueId, 'v1', 'avís repetit ignorat');
  ok(e, { name: 'jump', cueId: 'bosc' });
  ok(e, { name: 'video.ended', cueId: 'bosc', enterSeq: e.state.enterSeq });
  assert.strictEqual(e.state.cueId, 'bosc', 'sense auto no avança');
});

test('Recuperació: reproduir el diari dona exactament el mateix estat, i es reprèn la posició', () => {
  const journal = new MemoryJournal();
  const e1 = makeEngine({ journal, random: () => 0.7 });
  claimAll(e1);
  ok(e1, { name: 'go' });
  ok(e1, { name: 'go' });
  ok(e1, { name: 'vote.open' });
  ok(e1, { name: 'ballot', deviceId: 'da', option: 0 });
  ok(e1, { name: 'ballot', deviceId: 'db', option: 1 });
  ok(e1, { name: 'vote.close' });
  ok(e1, { name: 'go' });
  ok(e1, { name: 'overlay', mode: 'hold' });
  const position = { cueId: e1.state.cueId, enterSeq: e1.state.enterSeq, t: 3.5 };
  const e2 = new Engine({
    show: makeShow(), journal: new MemoryJournal(journal.readAll()), timers: false, position,
  });
  assert.deepStrictEqual(e2.state, e1.state);
  assert.strictEqual(e2.recovered, true);
  assert.deepStrictEqual(e2.resume, position);
  const stale = new Engine({
    show: makeShow(), journal: new MemoryJournal(journal.readAll()), timers: false,
    position: { cueId: 'intro', enterSeq: 1, t: 2 },
  });
  assert.strictEqual(stale.resume, null, 'una posició d\'una altra cue no es fa servir');
});

test('Pantalla negra / espera, pausa i ordres desconegudes', () => {
  const e = makeEngine();
  fail(e, { name: 'pause' }, /no ha començat/);
  ok(e, { name: 'go' });
  ok(e, { name: 'pause' });
  assert.strictEqual(e.state.paused, true);
  ok(e, { name: 'overlay', mode: 'black' });
  assert.strictEqual(e.state.overlay, 'black');
  fail(e, { name: 'overlay', mode: 'rosa' });
  ok(e, { name: 'restart' });
  assert.strictEqual(e.state.paused, false, 'reiniciar la cue treu la pausa');
  assert.strictEqual(e.state.overlay, 'black', 'però no la pantalla negra');
  fail(e, { name: 'jump', cueId: 'noexisteix' }, /no existeix/);
  fail(e, { name: 'xyz' }, /desconeguda/);
});

test('El temporitzador tanca la votació automàticament', async () => {
  const show = makeShow();
  show.cues.find((c) => c.id === 'v1').duration = 0.05;
  const e = new Engine({ show, journal: new MemoryJournal() });
  ok(e, { name: 'jump', cueId: 'v1' });
  ok(e, { name: 'vote.open' });
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(e.state.votes.v1.status, 'closed');
  assert.strictEqual(e.state.votes.v1.reason, 'no_votes');
  e.dispose();
});

test('Precàrrega: cues que poden venir després de l\'actual', () => {
  const e = makeEngine();
  claimAll(e);
  assert.deepStrictEqual(e.upcomingCueIds(), ['intro'], 'abans de començar, la primera');
  ok(e, { name: 'go' });
  assert.deepStrictEqual(e.upcomingCueIds(), ['v1']);
  ok(e, { name: 'go' });
  assert.deepStrictEqual(e.upcomingCueIds(), ['bosc', 'castell'], 'votació pendent: totes les branques');
  ok(e, { name: 'vote.open' });
  ok(e, { name: 'ballot', deviceId: 'da', option: 1 });
  assert.deepStrictEqual(e.upcomingCueIds(), ['bosc', 'castell'], 'votació oberta: totes les branques');
  ok(e, { name: 'vote.close' });
  assert.deepStrictEqual(e.upcomingCueIds(), ['castell'], 'votació decidida: només la guanyadora');
  ok(e, { name: 'jump', cueId: 'fi' });
  assert.deepStrictEqual(e.upcomingCueIds(), []);
});

const PARADE_SHOW = `
participants: [{ id: a, nom: Anna }, { id: b, nom: Biel }, { id: c, nom: Carla }]
cues:
  - { id: abans, tipus: espera, text: x }
  - { id: ent, tipus: entrada, ordre: [c, a, b] }
  - { id: despres, tipus: espera, text: y }
`;

function paradeEngine() {
  const r = parseShow(PARADE_SHOW);
  assert.deepStrictEqual(r.problems.filter((p) => p.level === 'error'), []);
  return new Engine({ show: r.show, journal: new MemoryJournal(), timers: false });
}

test('Entrada triomfal: GO passa nen a nen segons "ordre", després mosaic i després la cue següent', () => {
  const e = paradeEngine();
  ok(e, { name: 'jump', cueId: 'ent' });
  assert.strictEqual(e.state.step, 0);
  const labels = [];
  while (e.state.cueId === 'ent') {
    const go = e.describeGo();
    labels.push(go.action === 'step' ? go.label : '→' + go.cueId);
    ok(e, { name: 'go' });
  }
  assert.deepStrictEqual(labels, ['Carla', 'Anna', 'Biel', 'Tots junts', '→despres']);
  assert.strictEqual(e.state.step, 0, 'el pas es reinicia en canviar de cue');
});

test('Entrada triomfal: ENRERE torna al nen anterior; des de la cue següent torna al mosaic', () => {
  const e = paradeEngine();
  ok(e, { name: 'jump', cueId: 'abans' });
  ok(e, { name: 'go' });
  ok(e, { name: 'go' });
  ok(e, { name: 'go' });
  assert.strictEqual(e.state.step, 2);
  ok(e, { name: 'back' });
  assert.strictEqual(e.state.step, 1);
  ok(e, { name: 'back' });
  ok(e, { name: 'back' });
  assert.strictEqual(e.state.cueId, 'abans', 'des del pas 0, ENRERE surt de la cue');
  ok(e, { name: 'go' }); // -> ent
  ok(e, { name: 'step', step: 4 });
  ok(e, { name: 'go' }); // -> despres
  assert.strictEqual(e.state.cueId, 'despres');
  ok(e, { name: 'back' });
  assert.strictEqual(e.state.cueId, 'ent');
  assert.strictEqual(e.state.step, 4, 'torna al mosaic final');
});

test('Entrada triomfal: saltar a un pas concret, validació i recuperació', () => {
  const journal = new MemoryJournal();
  const r = parseShow(PARADE_SHOW);
  const e = new Engine({ show: r.show, journal, timers: false });
  fail(e, { name: 'step', step: 1 }, /no té passos/);
  ok(e, { name: 'jump', cueId: 'ent' });
  ok(e, { name: 'step', step: 3 });
  assert.strictEqual(e.state.step, 3);
  fail(e, { name: 'step', step: 5 }, /Pas no vàlid/);
  fail(e, { name: 'step', step: 1.5 }, /Pas no vàlid/);
  ok(e, { name: 'restart' });
  assert.strictEqual(e.state.step, 0, 'reiniciar la cue torna a l\'inici');
  ok(e, { name: 'step', step: 2 });
  const e2 = new Engine({ show: r.show, journal: new MemoryJournal(journal.readAll()), timers: false });
  assert.deepStrictEqual(e2.state, e.state);
});

test('Entrada amb vídeos: precarrega el vídeo del nen següent i la posició va lligada al pas', () => {
  const { screenView } = require('../src/engine/views');
  const r = parseShow(`
participants:
  - { id: a, nom: Anna, video_entrada: v/a.mp4 }
  - { id: b, nom: Biel }
  - { id: c, nom: Carla, video_entrada: v/c.mp4 }
cues:
  - { id: ent, tipus: entrada }
  - { id: fi, tipus: video, fitxer: v/fi.mp4 }
`);
  const e = new Engine({ show: r.show, journal: new MemoryJournal(), timers: false });
  const preload = () => screenView(e, {}).preload;
  ok(e, { name: 'jump', cueId: 'ent' });
  assert.deepStrictEqual(preload(), ['/show/v/a.mp4'], 'a l\'inici, el vídeo de l\'Anna');
  ok(e, { name: 'go' });
  assert.deepStrictEqual(screenView(e, {}).cue.people.map((p) => p.video), ['/show/v/a.mp4', null, '/show/v/c.mp4']);
  assert.deepStrictEqual(preload(), [], 'en Biel no té vídeo');
  ok(e, { name: 'go' });
  assert.deepStrictEqual(preload(), ['/show/v/c.mp4']);
  ok(e, { name: 'go' });
  assert.deepStrictEqual(preload(), ['/show/v/fi.mp4'], 'des de l\'últim nen, la cue següent');

  // Posició: només s'accepta la del pas actual i s'esborra en canviar de pas.
  e.setPosition({ cueId: 'ent', enterSeq: e.state.enterSeq, step: 2, t: 4 });
  assert.strictEqual(e.position, null, 'posició d\'un altre pas ignorada');
  e.setPosition({ cueId: 'ent', enterSeq: e.state.enterSeq, step: 3, t: 4 });
  assert.strictEqual(e.position.t, 4);
  const resumed = new Engine({
    show: r.show, journal: new MemoryJournal(e.journal.readAll()), timers: false, position: e.position,
  });
  assert.strictEqual(resumed.resume.step, 3, 'després d\'una caiguda es reprèn el vídeo del mateix nen');
  ok(e, { name: 'go' });
  assert.strictEqual(e.position, null);
});

test('Doble GO (tècnic i presentador alhora): només s\'avança una vegada', () => {
  const e = makeEngine();
  claimAll(e);
  ok(e, { name: 'go' });
  const seen = e.state.navSeq;
  ok(e, { name: 'go', expectNav: seen }); // el primer arriba: intro -> v1
  fail(e, { name: 'go', expectNav: seen }, /Ja s'ha avançat/); // el segon, amb l'estat vell
  assert.strictEqual(e.state.cueId, 'v1');
  fail(e, { name: 'back', expectNav: seen }, /Ja s'ha avançat/);
  // Els vots no compten com a "avançar": un GO pensat abans dels vots continua valent.
  ok(e, { name: 'vote.open' });
  const before = e.state.navSeq;
  ok(e, { name: 'ballot', deviceId: 'da', option: 0 });
  ok(e, { name: 'ballot', deviceId: 'db', option: 1 });
  assert.strictEqual(e.state.navSeq, before);
  ok(e, { name: 'go', expectNav: before });
  assert.strictEqual(e.state.votes.v1.status, 'closed');
  ok(e, { name: 'go' }, 'sense expectNav (p. ex. avançament automàtic) no hi ha comprovació');
});
