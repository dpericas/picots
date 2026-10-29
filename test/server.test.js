'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const { startServer } = require('../src/server/server');

const SHOW = `
titol: Test
participants: [{ id: a, nom: A }, { id: b, nom: B }]
cues:
  - { id: intro, tipus: video, fitxer: media/v.mp4 }
  - id: v1
    tipus: votacio
    pregunta: Q
    temps: 0
    opcions: [{ text: X, va_a: intro }, { text: Y, va_a: intro }]
`;

const quiet = { info() {}, warn() {}, error() {} };

function tmpShow() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gala-test-'));
  const showDir = path.join(root, 'show');
  fs.mkdirSync(path.join(showDir, 'media'), { recursive: true });
  fs.writeFileSync(path.join(showDir, 'show.yaml'), SHOW);
  fs.writeFileSync(path.join(showDir, 'media', 'v.mp4'), Buffer.from('0123456789'));
  return { root, showDir, dataDir: path.join(root, 'dades') };
}

function get(port, p, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

// Client de proves: guarda l'últim estat i permet esperar condicions.
function connect(port, query) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?' + query);
  const c = { ws, state: null, acks: {}, nextId: 1, waiters: [] };
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.type === 'state') c.state = msg.state;
    if (msg.type === 'ack') c.acks[msg.id] = msg;
    c.waiters = c.waiters.filter((w) => !w());
  });
  c.until = (pred) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout esperant condició')), 2000);
    const check = () => {
      if (c.state && pred(c.state)) { clearTimeout(timer); resolve(c.state); return true; }
      return false;
    };
    if (!check()) c.waiters.push(check);
  });
  c.cmd = (cmd) => new Promise((resolve) => {
    const id = c.nextId++;
    const wait = () => { if (c.acks[id]) { resolve(c.acks[id]); return true; } return false; };
    c.waiters.push(wait);
    ws.send(JSON.stringify({ type: 'cmd', id, cmd }));
  });
  c.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  return new Promise((resolve) => ws.on('open', () => resolve(c)));
}

test('Servidor: pàgines, fitxers amb Range, protecció de rutes i QR', async () => {
  const t = tmpShow();
  const srv = await startServer({ showDir: t.showDir, dataDir: t.dataDir, port: 0, host: '127.0.0.1', log: quiet });
  try {
    for (const p of ['/control', '/screen', '/play', '/static/common/client.js']) {
      assert.strictEqual((await get(srv.port, p)).status, 200, p);
    }
    const root = await get(srv.port, '/');
    assert.strictEqual(root.status, 302);
    const full = await get(srv.port, '/show/media/v.mp4');
    assert.strictEqual(full.body, '0123456789');
    const part = await get(srv.port, '/show/media/v.mp4', { Range: 'bytes=2-5' });
    assert.strictEqual(part.status, 206);
    assert.strictEqual(part.body, '2345');
    assert.strictEqual(part.headers['content-range'], 'bytes 2-5/10');
    const tail = await get(srv.port, '/show/media/v.mp4', { Range: 'bytes=-3' });
    assert.strictEqual(tail.body, '789');
    assert.strictEqual((await get(srv.port, '/show/media/v.mp4', { Range: 'bytes=50-' })).status, 416);
    assert.strictEqual((await get(srv.port, '/show/..%2f..%2fdades%2fsecret')).status, 404);
    assert.strictEqual((await get(srv.port, '/static/..%2f..%2fserver%2fserver.js')).status, 404);
    assert.strictEqual((await get(srv.port, '/show/%E0%A4%A')).status, 404);
    const qr = await get(srv.port, '/api/qr.svg?text=hola');
    assert.strictEqual(qr.status, 200);
    assert.match(qr.body, /<svg/);
  } finally {
    await srv.close();
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('Servidor: mòbils reclamen nom i voten; el control veu el recompte; permisos per rol', async () => {
  const t = tmpShow();
  const srv = await startServer({ showDir: t.showDir, dataDir: t.dataDir, port: 0, host: '127.0.0.1', log: quiet });
  try {
    const control = await connect(srv.port, 'role=control');
    const phone = await connect(srv.port, 'role=play&device=dev1');
    await phone.until((s) => s.participants.length === 2);

    let r = await phone.cmd({ name: 'go' });
    assert.strictEqual(r.ok, false, 'un mòbil no pot fer GO');
    r = await phone.cmd({ name: 'claim', participantId: 'a', deviceId: 'altre' });
    assert.ok(r.ok);
    await phone.until((s) => s.me === 'a');
    assert.strictEqual(srv.engine.state.claims.a, 'dev1', 'el servidor imposa el deviceId de la connexió');

    assert.ok((await control.cmd({ name: 'jump', cueId: 'v1' })).ok);
    assert.ok((await control.cmd({ name: 'vote.open' })).ok);
    await phone.until((s) => s.vote && s.vote.status === 'open');
    assert.ok((await phone.cmd({ name: 'ballot', option: 1 })).ok);
    const cs = await control.until((s) => s.vote && s.vote.counts[1] === 1);
    assert.strictEqual(cs.participants.find((p) => p.id === 'a').deviceId, 'dev1');
    assert.match(cs.participants[0].personalUrl, /\/play\?k=a\.[0-9a-f]{12}$/);
    await phone.until((s) => s.vote.myBallot === 1);

    const noDevice = await connect(srv.port, 'role=play');
    assert.strictEqual(await noDevice.closed, 4000);
  } finally {
    await srv.close();
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('Servidor: recarregar guió amb errors manté l\'anterior; nova sessió arxiva el diari', async () => {
  const t = tmpShow();
  const srv = await startServer({ showDir: t.showDir, dataDir: t.dataDir, port: 0, host: '127.0.0.1', log: quiet });
  try {
    const control = await connect(srv.port, 'role=control');
    assert.ok((await control.cmd({ name: 'go' })).ok);
    fs.writeFileSync(path.join(t.showDir, 'show.yaml'), SHOW.replace('va_a: intro }, {', 'va_a: res }, {'));
    const bad = await control.cmd({ name: 'show.reload' });
    assert.strictEqual(bad.ok, false);
    assert.ok(bad.problems.some((p) => /res/.test(p.msg)));
    fs.writeFileSync(path.join(t.showDir, 'show.yaml'), SHOW.replace('titol: Test', 'titol: Nou'));
    assert.ok((await control.cmd({ name: 'show.reload' })).ok);
    await control.until((s) => s.title === 'Nou');

    assert.ok((await control.cmd({ name: 'session.reset' })).ok);
    await control.until((s) => s.state.started === false);
    const archived = fs.readdirSync(t.dataDir).filter((f) => /^journal-.+\.jsonl$/.test(f));
    assert.strictEqual(archived.length, 1);
  } finally {
    await srv.close();
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('Servidor: en reiniciar es recupera l\'estat del diari', async () => {
  const t = tmpShow();
  let srv = await startServer({ showDir: t.showDir, dataDir: t.dataDir, port: 0, host: '127.0.0.1', log: quiet });
  const control = await connect(srv.port, 'role=control');
  await control.cmd({ name: 'jump', cueId: 'v1' });
  await control.cmd({ name: 'vote.force', option: 1, source: 'manual' });
  await srv.close();
  srv = await startServer({ showDir: t.showDir, dataDir: t.dataDir, port: 0, host: '127.0.0.1', log: quiet });
  try {
    assert.strictEqual(srv.engine.recovered, true);
    assert.strictEqual(srv.engine.state.cueId, 'v1');
    assert.strictEqual(srv.engine.state.votes.v1.result, 1);
  } finally {
    await srv.close();
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('Servidor: el projector rep la llista de vídeos a precarregar', async () => {
  const t = tmpShow();
  const srv = await startServer({ showDir: t.showDir, dataDir: t.dataDir, port: 0, host: '127.0.0.1', log: quiet });
  try {
    const screen = await connect(srv.port, 'role=screen');
    await screen.until((s) => s.preload.length === 1 && s.preload[0] === '/show/media/v.mp4');
    await srv.engine.dispatch({ name: 'jump', cueId: 'v1' });
    const s = await screen.until((st) => st.cue && st.cue.id === 'v1');
    assert.deepStrictEqual(s.preload, ['/show/media/v.mp4'], 'les dues branques són el mateix vídeo');
  } finally {
    await srv.close();
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('Servidor: comandament del presentador (PIN, ordres permeses, bloqueig i avisos)', async () => {
  const t = tmpShow();
  fs.writeFileSync(path.join(t.showDir, 'show.yaml'),
    SHOW.replace('titol: Test', 'titol: Test\nxarxa: { pin_presentador: "2027" }'));
  const srv = await startServer({ showDir: t.showDir, dataDir: t.dataDir, port: 0, host: '0.0.0.0', log: quiet });
  try {
    const control = await connect(srv.port, 'role=control');
    const remote = await connect(srv.port, 'role=remote');
    let s = await remote.until((st) => st.go && st.go.action === 'enter');
    assert.strictEqual(s.go.label, 'intro');
    assert.strictEqual((await remote.cmd({ name: 'jump', cueId: 'v1' })).ok, false, 'el presentador no pot saltar');
    assert.strictEqual((await remote.cmd({ name: 'vote.force', option: 0 })).ok, false);
    assert.ok((await remote.cmd({ name: 'go', expectNav: s.navSeq })).ok);
    assert.strictEqual((await remote.cmd({ name: 'go', expectNav: s.navSeq })).ok, false, 'doble GO rebutjat');

    assert.ok((await control.cmd({ name: 'remote.enable', enabled: false })).ok);
    s = await remote.until((st) => st.enabled === false);
    const locked = await remote.cmd({ name: 'go', expectNav: s.navSeq });
    assert.match(locked.error, /bloquejat/);
    assert.ok((await remote.cmd({ name: 'remote.alert', msg: 'Necessito ajuda' })).ok, 'avisar funciona encara que estigui bloquejat');
    const cs = await control.until((st) => st.remote.alerts.length === 1);
    assert.strictEqual(cs.remote.alerts[0].msg, 'Necessito ajuda');
    assert.strictEqual(cs.remote.connected, 1);
    assert.ok((await control.cmd({ name: 'alert.dismiss', id: cs.remote.alerts[0].id })).ok);
    await control.until((st) => st.remote.alerts.length === 0);

    // Des d'una altra màquina (IP de la xarxa local) cal el PIN.
    const lan = require('../src/server/net').pickLanAddress();
    if (lan !== '127.0.0.1') {
      const open = (q) => new Promise((resolve) => {
        const ws = new WebSocket('ws://' + lan + ':' + srv.port + '/ws?' + q);
        ws.on('message', () => { ws.close(); resolve('ok'); });
        ws.on('close', (code) => resolve(code));
        ws.on('error', () => {});
      });
      assert.strictEqual(await open('role=remote&pin=0000'), 4003);
      assert.strictEqual(await open('role=remote&pin=2027'), 'ok');
      assert.strictEqual(await open('role=control&pin=2027'), 4003, 'el PIN del presentador no obre el panell');
    }
  } finally {
    await srv.close();
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('Servidor: qüestionari, repte i mur des dels mòbils', async () => {
  const t = tmpShow();
  fs.writeFileSync(path.join(t.showDir, 'show.yaml'), SHOW + `
  - id: q
    tipus: questionari
    preguntes: [{ pregunta: P, opcions: [x, y], correcta: B, temps: 30 }]
  - { id: r, tipus: repte, objectiu: 25, temps: 30, si_exit: intro }
  - { id: m, tipus: mur }
`);
  const srv = await startServer({ showDir: t.showDir, dataDir: t.dataDir, port: 0, host: '127.0.0.1', log: quiet });
  try {
    const control = await connect(srv.port, 'role=control');
    const screen = await connect(srv.port, 'role=screen');
    const phone = await connect(srv.port, 'role=play&device=dev1');
    assert.ok((await phone.cmd({ name: 'claim', participantId: 'a' })).ok);

    assert.ok((await control.cmd({ name: 'jump', cueId: 'q' })).ok);
    assert.ok((await control.cmd({ name: 'step', step: 2 })).ok);
    await phone.until((s) => s.quiz && s.quiz.kind === 'open');
    assert.ok((await phone.cmd({ name: 'answer', option: 1 })).ok);
    // L'únic nen amb mòbil ja ha respost: solució automàtica.
    const sq = await screen.until((s) => s.quiz && s.quiz.kind === 'reveal');
    assert.strictEqual(sq.quiz.correct, 1);
    await phone.until((s) => s.quiz.myPoints > 0);

    assert.ok((await control.cmd({ name: 'jump', cueId: 'r' })).ok);
    assert.ok((await control.cmd({ name: 'go' })).ok);
    await phone.until((s) => s.challenge && s.challenge.status === 'open');
    phone.ws.send(JSON.stringify({ type: 'cmd', cmd: { name: 'tap', n: 10 } })); // com fa el mòbil (sense resposta)
    await screen.until((s) => s.challenge && s.challenge.total === 10);
    phone.ws.send(JSON.stringify({ type: 'cmd', cmd: { name: 'tap', n: 15 } }));
    await screen.until((s) => s.challenge.status === 'closed' && s.challenge.result === 'success');
    await control.until((s) => s.go.action === 'enter' && s.go.cueId === 'intro');

    assert.ok((await control.cmd({ name: 'jump', cueId: 'm' })).ok);
    const png = 'data:image/png;base64,' + Buffer.from('fake-png').toString('base64');
    assert.ok((await phone.cmd({ name: 'wall.post', drawing: png })).ok);
    const cs = await control.until((s) => s.wall && s.wall.posts.length === 1);
    const post = cs.wall.posts[0];
    assert.strictEqual(post.status, 'pending');
    const img = await get(srv.port, post.drawing);
    assert.strictEqual(img.status, 200);
    assert.strictEqual(img.headers['content-type'], 'image/png');
    assert.strictEqual(img.body, 'fake-png');
    assert.strictEqual((await phone.cmd({ name: 'wall.moderate', id: post.id, status: 'approved' })).ok, false,
      'un mòbil no pot moderar');
    assert.ok((await control.cmd({ name: 'wall.moderate', id: post.id, status: 'approved' })).ok);
    await screen.until((s) => s.wall && s.wall.posts.length === 1);
    assert.strictEqual((await get(srv.port, '/api/mur/999')).status, 404);
  } finally {
    await srv.close();
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});
