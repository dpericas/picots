'use strict';
// Simulador de mòbils: connecta N participants falsos que voten i responen el
// qüestionari a l'atzar, toquen el botó del repte i envien un missatge al mur.
// Serveix per a proves de càrrega i assajos.
// Ús: node scripts/simulate-phones.js [--url=http://127.0.0.1:8080] [--n=6] [--delay=8] [--taps=6]
//   --taps: tocs per segon de cada mòbil durant un repte

const WebSocket = require('ws');
const { makeLogger } = require('../src/common/log');

const log = makeLogger('simulador');

function arg(name, def) {
  const prefix = '--' + name + '=';
  const a = process.argv.find((x) => x.startsWith(prefix));
  return a ? a.slice(prefix.length) : def;
}

const base = arg('url', 'http://127.0.0.1:8080').replace(/^http/, 'ws');
const count = Number(arg('n', '6'));
const maxDelay = Number(arg('delay', '8')) * 1000;
const tapsPerSecond = Number(arg('taps', '6'));
const MESSAGES = ['Gràcies profes! ❤️', 'Us estimem 🎉', 'Ha estat genial!', 'Visca els Picots!'];

function bot(i) {
  const device = 'sim-' + i;
  let ws;
  let lastVoted = null;
  let lastAnswered = null;
  let lastPosted = null;
  let tapTimer = null;
  let nextId = 1;
  const send = (cmd) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'cmd', id: nextId++, cmd }));

  function connect() {
    ws = new WebSocket(base + '/ws?role=play&device=' + device);
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type === 'ack' && !msg.ok) log.warn('bot ' + i + ': ' + msg.error);
      if (msg.type !== 'state') return;
      const s = msg.state;
      if (!s.me) {
        // Agafa el participant número i si està lliure, o qualsevol de lliure.
        const free = s.participants.filter((p) => !p.taken);
        const mine = s.participants[i] && !s.participants[i].taken ? s.participants[i] : free[0];
        if (mine) send({ name: 'claim', participantId: mine.id });
        return;
      }
      const v = s.vote;
      if (v && v.status === 'open' && lastVoted !== v.cueId) {
        lastVoted = v.cueId;
        const option = Math.floor(Math.random() * v.options.length);
        setTimeout(() => send({ name: 'ballot', option }), Math.random() * maxDelay);
      }
      if (v && v.status === 'pending' && lastVoted === v.cueId) lastVoted = null; // votació reiniciada

      const q = s.quiz;
      const qKey = q && q.cueId + ':' + q.q;
      if (q && q.kind === 'open' && q.myAnswer == null && lastAnswered !== qKey) {
        lastAnswered = qKey;
        const option = Math.floor(Math.random() * q.question.options.length);
        const left = q.endsAt ? Math.max(0, q.endsAt - s.serverNow - 500) : maxDelay;
        setTimeout(() => send({ name: 'answer', option }), Math.random() * Math.min(maxDelay, left));
      }

      // Repte: toca a ritme constant mentre està en marxa (els tocs s'envien en grup, com el mòbil).
      const c = s.challenge;
      const tapping = !!(c && c.status === 'open');
      if (tapping && !tapTimer) {
        if (c.mode === 'all') {
          setTimeout(() => send({ name: 'tap', n: 1 }), Math.random() * maxDelay);
          tapTimer = true;
        } else {
          tapTimer = setInterval(() => send({ name: 'tap', n: Math.max(1, Math.round(tapsPerSecond / 4)) }), 250);
        }
      } else if (!tapping && tapTimer) {
        if (tapTimer !== true) clearInterval(tapTimer);
        tapTimer = null;
      }

      const w = s.wall;
      if (w && w.left > 0 && lastPosted !== w.cueId) {
        lastPosted = w.cueId;
        const text = MESSAGES[i % MESSAGES.length];
        setTimeout(() => send({ name: 'wall.post', text }), Math.random() * maxDelay);
      }
    });
    ws.on('close', () => setTimeout(connect, 1000));
    ws.on('error', () => {});
  }
  connect();
}

log.info('Connectant ' + count + ' mòbils simulats a ' + base);
for (let i = 0; i < count; i++) bot(i);
