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
const { loadShow, parseShow, hasErrors } = require('../engine/show');
const { screenView, playView, controlView, remoteView } = require('../engine/views');
const { safeResolve, serveFile, sendError } = require('./static');
const { pickLanAddress, isLoopback } = require('./net');
const { runPreflight } = require('./preflight');
const { mp4Duration, estimateCue, actualTimes } = require('../engine/timing');
const { linearPath } = require('../tools/backup-video');
const { mergeShow } = require('../tools/yaml-merge');
const YAML = require('yaml');
const { renderDiplomas } = require('./diplomas');
const { renderCards } = require('./cards');
const { renderSummary } = require('./summary');
const { renderScript } = require('./script');

const WEB_DIR = path.join(__dirname, '..', 'web');
const PAGES = { '/screen': 'screen', '/control': 'control', '/play': 'play', '/remote': 'remote', '/editor': 'editor' };
const MEDIA_LIST_MAX = 5000;
// Intents de PIN: després de PIN_MAX_FAILS errors seguits, l'adreça queda bloquejada un temps.
const PIN_MAX_FAILS = 8;
const PIN_LOCK_MS = 60000;
// Fitxers de la carpeta de l'espectacle que no s'han de servir (el guió té els PIN).
const PRIVATE_SHOW_FILE = /(^|\/)show\.yaml|\.tmp$|\.part\.mp4$|\.bak$/i;

// Només s'accepten noms d'amfitrió que siguin una IP o "localhost" (evita el DNS rebinding).
function hostAllowed(hostHeader) {
  if (!hostHeader) return true;
  const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':');
}
const SHOW_BACKUPS = 20;
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
  // Els PIN es llegeixen del guió actual: si es canvien a l'editor, valen al moment.
  const controlPin = () => opts.controlPin || show.network.controlPin;
  const presenterPin = () => opts.presenterPin || show.network.presenterPin;
  const pinFailures = new Map(); // adreça -> { count, until }
  function pinLocked(addr) {
    const f = pinFailures.get(addr);
    return !!f && f.until > Date.now();
  }
  function pinResult(addr, ok) {
    if (ok) {
      pinFailures.delete(addr);
      return;
    }
    const f = pinFailures.get(addr) || { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= PIN_MAX_FAILS) {
      f.until = Date.now() + PIN_LOCK_MS;
      f.count = 0;
      log.warn('Massa intents de PIN des de ' + addr + ': bloquejat ' + PIN_LOCK_MS / 1000 + ' s.');
    }
    pinFailures.set(addr, f);
  }
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
      pinSet: !!presenterPin(),
      url: publicBase + '/remote',
    };
  }

  // --- Durada: estimació (es recalcula si canvia el guió) i temps real del diari ---
  const videoCache = new Map();
  function videoSeconds(rel) {
    const file = path.join(showDir, rel);
    try {
      const st = fs.statSync(file);
      const c = videoCache.get(file);
      if (c && c.mtime === st.mtimeMs) return c.seconds;
      const seconds = mp4Duration(file);
      videoCache.set(file, { mtime: st.mtimeMs, seconds });
      return seconds;
    } catch (err) {
      return null;
    }
  }
  let estimates = null;
  function timingInfo() {
    if (!estimates || estimates.show !== show) {
      const perCue = {};
      show.cues.forEach((c) => { perCue[c.id] = estimateCue(c, show, videoSeconds); });
      const route = linearPath(show).ids;
      estimates = { show, perCue, route, total: route.reduce((a, id) => a + perCue[id].seconds, 0) };
    }
    const s = engine.state;
    const now = engine.now();
    const timeline = s.timeline || [];
    const last = timeline[timeline.length - 1];
    const startedAt = timeline.length ? timeline[0].t : null;
    let remaining = estimates.total;
    if (s.started && !s.ended && s.cueId) {
      // El que queda: el que falta de la cue actual i el camí per defecte des d'aquí.
      const inCue = last ? (now - last.t) / 1000 : 0;
      const rest = linearPath(show, null, s.cueId).ids.slice(1);
      const sec = (id) => (estimates.perCue[id] ? estimates.perCue[id].seconds : 0);
      remaining = Math.max(0, sec(s.cueId) - inCue) + rest.reduce((a, id) => a + sec(id), 0);
    } else if (s.ended) {
      remaining = 0;
    }
    return {
      perCue: estimates.perCue,
      route: estimates.route,
      total: estimates.total,
      actual: actualTimes(timeline, now),
      elapsed: startedAt != null ? ((s.ended && last ? last.t : now) - startedAt) / 1000 : 0,
      remaining,
    };
  }

  function viewFor(client) {
    if (client.role === 'screen') return screenView(engine, { joinUrl: joinUrl(), mode });
    if (client.role === 'remote') return remoteView(engine, { enabled: remote.enabled, mode });
    if (client.role === 'play') return playView(engine, client.deviceId);
    return controlView(engine, {
      joinUrl: joinUrl(), personalUrl, problems, clients: clientList(), mediaErrors, remote: remoteInfo(), mode,
      timing: timingInfo(),
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
      for (const c of clients) {
        // Un error en la vista d'un client no ha de deixar sense estat els altres.
        try {
          send(c, { type: 'state', state: viewFor(c) });
        } catch (err) {
          log.error('No s\'ha pogut preparar l\'estat per a ' + c.role + ' #' + c.id + ': ' + err.stack);
        }
      }
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
    e.replayWarnings.forEach((msg) => log.warn(msg));
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
  function savePositionNow() {
    const p = engine.position;
    try {
      if (p) fs.writeFileSync(positionFile, JSON.stringify(p));
      else fs.rmSync(positionFile, { force: true });
    } catch (err) {
      log.warn('No es pot desar la posició: ' + err.message);
    }
  }

  function switchMode(target, fresh) {
    const claims = Object.assign({}, engine.state.claims);
    const previous = mode;
    savePositionNow(); // la posició del vídeo del mode que es deixa, al dia
    engine.dispose();
    engine.removeAllListeners();
    journal.close();
    try {
      engine = openEngine(target);
    } catch (err) {
      // No s'ha pogut obrir el diari del mode nou: es torna al d'abans.
      log.error('No es pot canviar al mode ' + target + ': ' + err.message);
      engine = openEngine(previous);
      broadcast();
      throw err;
    }
    mode = target;
    try {
      if (mode === 'gala') fs.rmSync(modeFile, { force: true });
      else fs.writeFileSync(modeFile, JSON.stringify({ mode }));
    } catch (err) {
      log.warn('No es pot desar el mode: ' + err.message);
    }
    if (fresh) {
      const archived = engine.reset(fileStamp());
      if (archived) log.info('Assaig anterior arxivat: ' + archived);
    }
    Object.keys(claims).forEach((pid) => {
      if (!engine.state.claims[pid]) engine.dispatch({ name: 'claim', deviceId: claims[pid], participantId: pid, key: keyFor(pid) });
    });
    lastSavedPosition = undefined; // força desar (o esborrar) la posició del mode nou
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

  // --- Editor del guió ---
  const showFile = path.join(showDir, 'show.yaml');

  // Fitxers de la carpeta de l'espectacle, per triar-los a l'editor.
  function mediaList() {
    const files = [];
    const dirs = [];
    const walk = (rel) => {
      let entries;
      try {
        entries = fs.readdirSync(path.join(showDir, rel), { withFileTypes: true });
      } catch (err) {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || files.length >= MEDIA_LIST_MAX) continue;
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) {
          dirs.push(r);
          walk(r);
        } else if (!/^show\.yaml/.test(r)) {
          files.push(r);
        }
      }
    };
    walk('');
    return { files: files.sort(), dirs: dirs.sort() };
  }

  function showText() {
    return fs.readFileSync(showFile, 'utf8');
  }

  function validateRaw(raw) {
    const text = mergeShow(showText(), raw);
    const r = parseShowText(text);
    return { text, problems: r.problems, ok: !!r.show && !hasErrors(r.problems) };
  }

  function parseShowText(text) {
    return parseShow(text, showDir);
  }

  function backupShow() {
    const dir = path.join(dataDir, 'guio-copies');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(showFile, path.join(dir, 'show-' + fileStamp() + '.yaml'));
    const old = fs.readdirSync(dir).filter((f) => /^show-.+\.yaml$/.test(f)).sort();
    old.slice(0, Math.max(0, old.length - SHOW_BACKUPS)).forEach((f) => fs.rmSync(path.join(dir, f), { force: true }));
  }

  function handleEditorCommand(cmd) {
    if (cmd.name === 'show.get') {
      const text = showText();
      let raw = null;
      try {
        raw = YAML.parse(text) || {};
      } catch (err) {
        return { ok: false, error: 'El show.yaml té un error de sintaxi: ' + err.message };
      }
      return { ok: true, raw, mtime: fs.statSync(showFile).mtimeMs, media: mediaList(), problems };
    }
    if (cmd.name === 'show.validate') {
      if (!isPlainObject(cmd.raw)) return { ok: false, error: 'Guió no vàlid.' };
      const v = validateRaw(cmd.raw);
      return { ok: true, valid: v.ok, problems: v.problems };
    }
    if (cmd.name === 'show.save') {
      if (cmd.mtime != null && fs.statSync(showFile).mtimeMs !== cmd.mtime && !cmd.force) {
        return { ok: false, conflict: true, error: 'El show.yaml ha canviat des que l\'has obert (algú l\'ha editat).' };
      }
      if (!isPlainObject(cmd.raw)) return { ok: false, error: 'Guió no vàlid.' };
      const v = validateRaw(cmd.raw);
      if (!v.ok) return { ok: false, error: 'El guió té errors: corregeix-los abans de desar.', problems: v.problems };
      backupShow();
      const tmp = showFile + '.tmp';
      fs.writeFileSync(tmp, v.text);
      try {
        fs.renameSync(tmp, showFile);
      } catch (err) {
        // A Windows falla si un altre programa té el fitxer obert.
        fs.rmSync(tmp, { force: true });
        return { ok: false, error: 'No es pot escriure el show.yaml (el té obert un altre programa?): ' + err.message };
      }
      const r = handleServerCommand({ name: 'show.reload' });
      log.info('Guió desat des de l\'editor' + (r.ok ? ' i aplicat.' : ': ' + r.error));
      return Object.assign({}, r, { mtime: fs.statSync(showFile).mtimeMs, problems: r.ok ? problems : r.problems });
    }
    return null;
  }

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
          show, problems, showDir, dataDir, engine, mode, joinUrl: joinUrl(), presenterPin: presenterPin(),
          fixedHost: !!(opts.publicHost || show.network.publicHost),
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
      const r = handleServerCommand(cmd) || handleEditorCommand(cmd);
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
      const rel = p.slice('/show/'.length);
      let decoded = '';
      try {
        decoded = decodeURIComponent(rel);
      } catch (err) {
        return sendError(res, 404);
      }
      if (PRIVATE_SHOW_FILE.test(decoded.replace(/\\/g, '/'))) return sendError(res, 404);
      const file = safeResolve(showDir, rel);
      return file ? serveFile(req, res, file, { cache: true }) : sendError(res, 404);
    }
    // Pàgines d'impressió: com el panell, des d'aquest ordinador o amb el PIN de control.
    const controlAllowed = () => {
      if (!hostAllowed(req.headers.host)) return false;
      if (isLoopback(req.socket.remoteAddress)) return true;
      const addr = req.socket.remoteAddress;
      const given = url.searchParams.get('pin');
      if (!given || pinLocked(addr)) return false;
      const ok = !!controlPin() && given === controlPin();
      pinResult(addr, ok);
      return ok;
    };
    if (p === '/guio') {
      if (!controlAllowed()) return sendError(res, 403);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(renderScript(show, timingInfo()));
    }
    if (p === '/resum') {
      if (!controlAllowed()) return sendError(res, 403);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(renderSummary(engine, { date: timestamp().slice(0, 16), mode }));
    }
    if (p === '/diplomes' || p === '/targetes') {
      if (!controlAllowed()) return sendError(res, 403);
      const r = p === '/diplomes' ? renderDiplomas(show, url.searchParams.get('cue')) : {
        status: 200,
        html: await renderCards({ show, personalUrl, joinUrl: joinUrl(), fixedHost: !!(opts.publicHost || show.network.publicHost) }),
      };
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
    // Només pàgines servides per aquest mateix servidor (una web qualsevol no pot fer de panell).
    const origin = req.headers.origin;
    let originOk = !origin;
    try {
      originOk = originOk || new URL(origin).host === req.headers.host;
    } catch (err) {
      originOk = false;
    }
    if (!originOk || !hostAllowed(req.headers.host)) {
      log.warn('Connexió ' + role + ' rebutjada: origen ' + origin);
      return ws.close(4003, 'origen no autoritzat');
    }
    let pinOk = false;
    if (role !== 'play' && !isLoopback(addr)) {
      if (pinLocked(addr)) {
        log.warn('Connexió ' + role + ' rebutjada (massa intents) des de ' + addr);
        return ws.close(4003, 'massa intents');
      }
      pinOk = !!pin && ((!!controlPin() && pin === controlPin()) || (role === 'remote' && !!presenterPin() && pin === presenterPin()));
      pinResult(addr, pinOk);
    }
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
    // Les peticions de vídeo en curs (Range) mantenen connexions obertes: es tanquen totes.
    const closed = new Promise((resolve) => httpServer.close(resolve));
    if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections();
    await closed;
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

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
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
