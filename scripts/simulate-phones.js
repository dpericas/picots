'use strict';
// Simulador de mòbils: connecta N participants falsos que voten a l'atzar
// quan s'obre una votació. Serveix per a proves de càrrega i assajos.
// Ús: node scripts/simulate-phones.js [--url=http://127.0.0.1:8080] [--n=6] [--delay=8]

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

function bot(i) {
  const device = 'sim-' + i;
  let ws;
  let lastVoted = null;
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
    });
    ws.on('close', () => setTimeout(connect, 1000));
    ws.on('error', () => {});
  }
  connect();
}

log.info('Connectant ' + count + ' mòbils simulats a ' + base);
for (let i = 0; i < count; i++) bot(i);
