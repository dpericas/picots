'use strict';
// Servidor local: HTTP (pàgines i fitxers) + WebSocket (temps real).
// Funciona igual dins d'Electron que en mode consola (scripts/dev-server.js).

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');

const { makeLogger, timestamp } = require('../common/log');
const { Engine } = require('../engine/engine');
const { FileJournal } = require('../engine/journal');
const { loadShow, hasErrors } = require('../engine/show');
const { screenView, playView, controlView, remoteView } = require('../engine/views');
const { safeResolve, serveFile, sendError } = require('./static');
const { pickLanAddress, isLoopback } = require('./net');
const { runPreflight } = require('./preflight');
const { renderDiplomas } = require('./diplomas');

const WEB_DIR = path.join(__dirname, '..', 'web');
const PAGES = { '/screen': 'screen', '/control': 'control', '/play': 'play', '/remote': 'remote' };
const ROLE_COMMANDS = {
  play: ['claim', 'ballot', 'release', 'answer', 'tap', 'wall.post'],
  remote: ['go', 'back', 'remote.alert'],
  screen: ['video.ended', 'video.position', 'media.error', 'screen.info'],
};
// Cada mode té el seu diari: un assaig no toca mai l'estat de la gala.
const MODES = {
  gala: { journal: 'journal.jsonl', position: 'position.json' },
  assaig: { journal: 'assaig.jsonl', position: 'position-assaig.json' },
};
const POSITION_SAVE_MS = 2000;
const HEARTBEAT_MS = 10000;
// Durant un repte els tocs arriben molt seguits: s'envia l'estat com a molt cada LIVE_MS.
const LIVE_MS = 150;
// Events massa freqüents per escriure'ls al registre un a un.
const QUIET_EVENTS = ['vote.ballot', 'quiz.answer', 'challenge.progress'];

function readSecret(dataDir) {
  const file = path.join(dataDir, 'secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    const secret = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(file, secret);
    return secret;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

function fileStamp() {
  return timestamp().replace(/[-: ]/g, '').replace('.', '-');
}

/**
 * Arrenca el servidor.
 * @param {object} opts
 * @param {string} opts.showDir   carpeta amb show.yaml i els fitxers multimèdia
 * @param {string} opts.dataDir   carpeta per al diari, secret i posició
 * @param {number} [opts.port]    0 = port lliure (tests); per defecte el del guió
 * @param {string} [opts.host]
 */
async function startServer(opts) {
  const log = opts.log || makeLogger('servidor');
  const showDir = path.resolve(opts.showDir);
  const dataDir = path.resolve(opts.dataDir);
  fs.mkdirSync(dataDir, { recursive: true });

  const loaded = loadShow(showDir);
  if (!loaded.show) throw new Error(loaded.problems.map((p) => p.msg).join('\n'));
  let problems = loaded.problems;
  problems.forEach((p) => log[p.level === 'error' ? 'error' : 'warn']((p.cueId ? '[' + p.cueId + '] ' : '') + p.msg));

  const secret = readSecret(dataDir);
  const keyFor = (pid) => crypto.createHmac('sha256', secret).update(pid).digest('hex').slice(0, 12);
  const modeFile = path.join(dataDir, 'mode.json');
  let mode = (readJson(modeFile) || {}).mode === 'assaig' ? 'assaig' : 'gala';
  let show = loaded.show;
  let journal = null;
  let engine = null;
  let positionFile = null;

  const network = loaded.show.network;
  const port = opts.port != null ? opts.port : network.port;
  const controlPin = opts.controlPin || network.controlPin;
  const presenterPin = opts.presenterPin || network.presenterPin;
  // Comandament del presentador: el tècnic el pot bloquejar; els avisos li arriben al panell.
  const remote = { enabled: true, alerts: [], nextAlertId: 1 };
  const mediaErrors = [];
  const clients = new Set();
  let publicBase = null;

  const joinUrl = () => publicBase + '/play';
  const personalUrl = (pid) => publicBase + '/play?k=' + encodeURIComponent(pid + '.' + keyFor(pid));

  function clientList() {
    return Array.from(clients).map((c) => ({
      id: c.id, role: c.role, deviceId: c.deviceId, addr: c.addr, since: c.since,
    }));
  }

  function remoteInfo() {
    return {
      enabled: remote.enabled,
      connected: Array.from(clients).filter((c) => c.role === 'remote').length,
      alerts: remote.alerts,
      pinSet: !!presenterPin,
      url: publicBase + '/remote',
    };
  }

  function viewFor(client) {
    if (client.role === 'screen') return screenView(engine, { joinUrl: joinUrl(), mode });
    if (client.role === 'remote') return remoteView(engine, { enabled: remote.enabled, mode });
    if (client.role === 'play') return playView(engine, client.deviceId);
    return controlView(engine, {
      joinUrl: joinUrl(), personalUrl, problems, clients: clientList(), mediaErrors, remote: remoteInfo(), mode,
    });
  }

  function send(client, msg) {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
  }

  // Agrupa canvis seguits (p. ex. 30 vots alhora) en un sol enviament.
  let broadcastPending = false;
  function broadcast() {
    if (broadcastPending) return;
    broadcastPending = true;
    setImmediate(() => {
      broadcastPending = false;
      for (const c of clients) send(c, { type: 'state', state: viewFor(c) });
    });
  }

  let liveTimer = null;
  function onLive() {
    if (liveTimer) return;
    liveTimer = setTimeout(() => {
      liveTimer = null;
      broadcast();
    }, LIVE_MS);
  }

  function openEngine(m) {
    const files = MODES[m];
    positionFile = path.join(dataDir, files.position);
    journal = new FileJournal(path.join(dataDir, files.journal), log);
    const e = new Engine({ show, journal, keyFor, position: readJson(positionFile) });
    e.on('warning', (msg) => log.warn(msg));
    e.on('change', (ev) => {
      if (ev && !QUIET_EVENTS.includes(ev.type)) log.info('Event ' + ev.seq + ': ' + ev.type + summarize(ev));
      broadcast();
    });
    e.on('live', onLive);
    if (e.recovered) {
      log.warn('Sessió de ' + m + ' recuperada del diari: cue actual "' + e.state.cueId + '", event ' + e.state.seq + '.');
    }
    return e;
  }
  engine = openEngine(mode);

  // Canvia entre gala i assaig. Els mòbils que ja tenien nom el conserven.
  function switchMode(target, fresh) {
    const claims = Object.assign({}, engine.state.claims);
    engine.dispose();
    engine.removeAllListeners();
    journal.close();
    mode = target;
    try {
      if (mode === 'gala') fs.rmSync(modeFile, { force: true });
      else fs.writeFileSync(modeFile, JSON.stringify({ mode }));
    } catch (err) {
      log.warn('No es pot desar el mode: ' + err.message);
    }
    engine = openEngine(mode);
    if (fresh) {
      const archived = engine.reset(fileStamp());
      if (archived) log.info('Assaig anterior arxivat: ' + archived);
    }
    Object.keys(claims).forEach((pid) => {
      if (!engine.state.claims[pid]) engine.dispatch({ name: 'claim', deviceId: claims[pid], participantId: pid, key: keyFor(pid) });
    });
    lastSavedPosition = null;
    mediaErrors.length = 0;
    log.warn(mode === 'assaig' ? 'MODE ASSAIG' + (fresh ? ' (de zero)' : '') : 'Tornada al mode GALA');
    broadcast();
  }

  // Desa la posició del vídeo periòdicament per poder reprendre després d'una caiguda.
  let lastSavedPosition = null;
  const positionTimer = setInterval(() => {
    const p = engine.position;
    const key = p ? JSON.stringify(p) : null;
    if (key === lastSavedPosition) return;
    lastSavedPosition = key;
    try {
      if (p) fs.writeFileSync(positionFile, key);
      else if (fs.existsSync(positionFile)) fs.unlinkSync(positionFile);
    } catch (err) {
      log.warn('No es pot desar la posició: ' + err.message);
    }
  }, POSITION_SAVE_MS);

  function handleServerCommand(cmd) {
    if (cmd.name === 'show.reload') {
      const r = loadShow(showDir);
      if (!r.show || hasErrors(r.problems)) {
        return { ok: false, error: 'El guió té errors; es manté la versió anterior.', problems: r.problems };
      }
      problems = r.problems;
      show = r.show;
      engine.setShow(r.show);
      log.info('Guió recarregat (' + r.show.cues.length + ' cues).');
      return { ok: true };
    }
    if (cmd.name === 'remote.enable') {
      remote.enabled = !!cmd.enabled;
      log.warn('Comandament del presentador ' + (remote.enabled ? 'activat' : 'BLOQUEJAT') + ' pel tècnic.');
      broadcast();
      return { ok: true };
    }
    if (cmd.name === 'alert.dismiss') {
      remote.alerts = cmd.id == null ? [] : remote.alerts.filter((a) => a.id !== cmd.id);
      broadcast();
      return { ok: true };
    }
    if (cmd.name === 'mode.set') {
      if (!MODES[cmd.mode]) return { ok: false, error: 'Mode desconegut.' };
      if (cmd.mode === mode && !cmd.fresh) return { ok: true };
      switchMode(cmd.mode, cmd.mode === 'assaig' && !!cmd.fresh);
      return { ok: true };
    }
    if (cmd.name === 'preflight') {
      return {
        ok: true,
        report: runPreflight({
          show, problems, showDir, dataDir, engine, mode, joinUrl: joinUrl(), presenterPin,
          clients: Array.from(clients), system: opts.systemInfo ? opts.systemInfo() : null,
        }),
      };
    }
    if (cmd.name === 'screen.test') {
      const what = ['sound', 'pattern', 'off'].includes(cmd.what) ? cmd.what : 'off';
      const screens = Array.from(clients).filter((c) => c.role === 'screen');
      if (screens.length === 0) return { ok: false, error: 'No hi ha cap projector connectat.' };
      screens.forEach((c) => send(c, { type: 'test', what }));
      return { ok: true };
    }
    if (cmd.name === 'session.reset') {
      const archived = engine.reset(fileStamp());
      mediaErrors.length = 0;
      log.warn('Sessió reiniciada. Diari anterior: ' + (archived || '(buit)'));
      return { ok: true };
    }
    return null;
  }

  function handleCommand(client, cmd) {
    if (!cmd || typeof cmd.name !== 'string') return { ok: false, error: 'Ordre mal formada.' };
    if (client.role !== 'control') {
      const allowed = ROLE_COMMANDS[client.role] || [];
      if (!allowed.includes(cmd.name)) return { ok: false, error: 'Ordre no permesa.' };
      // Un mòbil sempre actua en nom propi.
      cmd = Object.assign({}, cmd, { deviceId: client.deviceId });
    }
    if (client.role === 'remote') {
      if (cmd.name === 'remote.alert') {
        const msg = String(cmd.msg || 'El presentador necessita ajuda').slice(0, 120);
        remote.alerts.unshift({ id: remote.nextAlertId++, at: engine.now(), msg });
        remote.alerts.length = Math.min(remote.alerts.length, 10);
        log.warn('AVÍS DEL PRESENTADOR: ' + msg);
        broadcast();
        return { ok: true };
      }
      if (!remote.enabled) return { ok: false, error: 'El tècnic ha bloquejat el comandament.' };
      log.info('Presentador: ' + cmd.name);
    }
    if (cmd.name === 'screen.info') {
      client.info = {
        width: Number(cmd.width) || 0, height: Number(cmd.height) || 0,
        dpr: Number(cmd.dpr) || 1, fullscreen: !!cmd.fullscreen,
      };
      return null;
    }
    if (cmd.name === 'video.position') {
      engine.setPosition(cmd);
      return null;
    }
    if (cmd.name === 'media.error') {
      mediaErrors.unshift({ at: engine.now(), cueId: cmd.cueId || null, src: cmd.src || null, msg: String(cmd.msg || '') });
      mediaErrors.length = Math.min(mediaErrors.length, 20);
      log.error('Error multimèdia al projector: ' + (cmd.src || '') + ' ' + (cmd.msg || ''));
      broadcast();
      return { ok: true };
    }
    if (client.role === 'control') {
      const r = handleServerCommand(cmd);
      if (r) return r;
    }
    return engine.dispatch(cmd);
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405);
    if (p === '/') {
      res.writeHead(302, { Location: '/play' });
      return res.end();
    }
    if (PAGES[p]) return serveFile(req, res, path.join(WEB_DIR, PAGES[p], 'index.html'));
    if (p.startsWith('/static/')) {
      const file = safeResolve(WEB_DIR, p.slice('/static/'.length));
      return file ? serveFile(req, res, file) : sendError(res, 404);
    }
    if (p.startsWith('/show/')) {
      const file = safeResolve(showDir, p.slice('/show/'.length));
      return file ? serveFile(req, res, file, { cache: true }) : sendError(res, 404);
    }
    if (p === '/diplomes') {
      // Com el panell: des d'aquest ordinador o amb el PIN de control.
      if (!isLoopback(req.socket.remoteAddress) && !(controlPin && url.searchParams.get('pin') === controlPin)) {
        return sendError(res, 403);
      }
      const r = renderDiplomas(show, url.searchParams.get('cue'));
      res.writeHead(r.status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(r.html);
    }
    if (p.startsWith('/api/mur/')) return serveDrawing(req, res, Number(p.slice('/api/mur/'.length)));
    if (p === '/api/qr.svg') {
      const text = url.searchParams.get('text') || joinUrl();
      try {
        const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
        return res.end(svg);
      } catch (err) {
        return sendError(res, 400, 'Text massa llarg per a un QR');
      }
    }
    return sendError(res, 404, 'No trobat');
  }

  // Dibuix del mur. Els no aprovats només es veuen des d'aquest ordinador.
  function serveDrawing(req, res, id) {
    const m = engine.state.wall.find((x) => x.id === id);
    const data = m && engine.drawings.get(id);
    if (!data) return sendError(res, 404);
    if (m.status !== 'approved' && !isLoopback(req.socket.remoteAddress)) return sendError(res, 403);
    const comma = data.indexOf(',');
    const type = data.slice(5, data.indexOf(';'));
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' });
    return res.end(req.method === 'HEAD' ? undefined : Buffer.from(data.slice(comma + 1), 'base64'));
  }

  const httpServer = http.createServer((req, res) => {
    handleHttp(req, res).catch((err) => {
      log.error('Error HTTP ' + req.url + ': ' + err.stack);
      if (!res.headersSent) sendError(res, 500);
    });
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 128 * 1024 });
  let nextClientId = 1;

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://local');
    const role = url.searchParams.get('role');
    const addr = req.socket.remoteAddress;
    if (!['screen', 'control', 'play', 'remote'].includes(role)) return ws.close(4000, 'rol desconegut');
    // El projector i el panell només des del mateix ordinador, o amb el PIN de control.
    // El comandament del presentador accepta també el PIN del presentador.
    const pin = url.searchParams.get('pin');
    const pinOk = (controlPin && pin === controlPin) || (role === 'remote' && presenterPin && pin === presenterPin);
    if (role !== 'play' && !isLoopback(addr) && !pinOk) {
      log.warn('Connexió ' + role + ' rebutjada des de ' + addr);
      return ws.close(4003, 'no autoritzat');
    }
    const client = {
      id: nextClientId++, ws, role, addr, since: engine.now(),
      deviceId: (url.searchParams.get('device') || '').slice(0, 64) || null,
      alive: true,
    };
    if (role === 'play' && !client.deviceId) return ws.close(4000, 'falta device');
    clients.add(client);
    log.info('Connectat ' + role + ' #' + client.id + ' (' + addr + ')');
    ws.on('pong', () => { client.alive = true; });
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch (err) {
        return;
      }
      if (!msg || msg.type !== 'cmd') return;
      let reply;
      try {
        reply = handleCommand(client, msg.cmd);
      } catch (err) {
        log.error('Error executant ' + (msg.cmd && msg.cmd.name) + ': ' + err.stack);
        reply = { ok: false, error: 'Error intern: ' + err.message };
      }
      if (reply && msg.id != null) send(client, Object.assign({ type: 'ack', id: msg.id }, reply));
    });
    ws.on('close', () => {
      clients.delete(client);
      log.info('Desconnectat ' + role + ' #' + client.id);
      broadcast();
    });
    send(client, { type: 'state', state: viewFor(client) });
    broadcast();
  });

  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, HEARTBEAT_MS);

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, opts.host || '0.0.0.0', resolve);
  });
  const actualPort = httpServer.address().port;
  const host = opts.publicHost || network.publicHost || pickLanAddress();
  publicBase = 'http://' + host + ':' + actualPort;
  log.info('Servidor a punt al port ' + actualPort + '. Mòbils: ' + joinUrl());

  async function close() {
    clearInterval(heartbeat);
    clearInterval(positionTimer);
    clearTimeout(liveTimer);
    engine.dispose();
    for (const c of clients) c.ws.terminate();
    wss.close();
    journal.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }

  return {
    port: actualPort,
    localUrl: 'http://127.0.0.1:' + actualPort,
    joinUrl,
    get engine() { return engine; },
    get mode() { return mode; },
    showDir,
    dataDir,
    close,
  };
}

function summarize(ev) {
  if (ev.type === 'cue.enter') return ' -> ' + ev.cueId + ' (' + ev.via + ')';
  if (ev.type === 'vote.close') return ' ' + ev.cueId + ' resultat=' + ev.result + ' vots=' + JSON.stringify(ev.counts);
  if (ev.type === 'vote.force') return ' ' + ev.cueId + ' resultat=' + ev.result + ' (' + ev.source + ')';
  if (ev.type === 'overlay.set') return ' ' + ev.mode;
  if (ev.type === 'participant.claim') return ' ' + ev.participantId;
  if (ev.type === 'cue.step') return ' ' + ev.cueId + ' pas ' + ev.step;
  if (ev.type === 'challenge.close') return ' ' + ev.cueId + ' ' + ev.result + ' (' + ev.reason + ')';
  if (ev.type === 'challenge.force') return ' ' + ev.cueId + ' ' + ev.result + ' (' + ev.source + ')';
  if (ev.type === 'wall.post') return ' #' + ev.id + ' de ' + ev.participantId + (ev.drawing ? ' (dibuix)' : '');
  if (ev.type === 'wall.moderate') return ' #' + ev.id + ' ' + ev.status;
  return '';
}

module.exports = { startServer };
