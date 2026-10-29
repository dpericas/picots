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
