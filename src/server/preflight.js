'use strict';
// Comprovació prèvia («Tot a punt?»): el que convé revisar abans que entri el públic.
// Cada punt: { id, level: ok | warn | error, title, detail }.

const fs = require('fs');
const path = require('path');

const MIN_FREE_BYTES = 500 * 1024 * 1024;
const VIDEO_EXT = ['.mp4', '.m4v', '.mov'];

// Caixes de primer nivell d'un MP4: comprova que és un MP4 i si té el "moov"
// al principi (faststart: comença a reproduir-se sense llegir tot el fitxer).
function inspectMp4(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    const order = [];
    let pos = 0;
    while (pos + 8 <= size && order.length < 50) {
      fs.readSync(fd, head, 0, 16, pos);
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (boxSize === 1) boxSize = Number(head.readBigUInt64BE(8));
      else if (boxSize === 0) boxSize = size - pos;
      if (boxSize < 8) break;
      order.push(type);
      pos += boxSize;
    }
    const moov = order.indexOf('moov');
    const mdat = order.indexOf('mdat');
    return { mp4: order[0] === 'ftyp', moov: moov >= 0, faststart: moov >= 0 && (mdat < 0 || moov < mdat) };
  } finally {
    fs.closeSync(fd);
  }
}

// Tots els fitxers que fa servir el guió, amb on es fan servir.
function referencedMedia(show) {
  const refs = new Map();
  const add = (rel, where) => {
    if (!rel) return;
    if (!refs.has(rel)) refs.set(rel, []);
    refs.get(rel).push(where);
  };
  for (const c of show.cues) {
    add(c.file, c.id);
    add(c.music, c.id);
    add(c.effect, c.id);
    (c.images || []).forEach((img) => add(img, c.id));
    (c.questions || []).forEach((q, i) => add(q.image, c.id + ' P' + (i + 1)));
  }
  for (const p of show.participants) {
    add(p.photo, p.name);
    add(p.avatar, p.name);
    add(p.entryVideo, p.name);
  }
  return refs;
}

function checkMedia(show, showDir) {
  const refs = referencedMedia(show);
  const missing = [];
  const empty = [];
  const notMp4 = [];
  const slow = [];
  let bytes = 0;
  for (const [rel, where] of refs) {
    const file = path.join(showDir, rel);
    let st;
    try {
      st = fs.statSync(file);
    } catch (err) {
      missing.push(rel + ' (' + where.join(', ') + ')');
      continue;
    }
    bytes += st.size;
    if (st.size === 0) {
      empty.push(rel);
      continue;
    }
    if (VIDEO_EXT.includes(path.extname(rel).toLowerCase())) {
      try {
        const info = inspectMp4(file);
        if (!info.mp4 || !info.moov) notMp4.push(rel);
        else if (!info.faststart) slow.push(rel);
      } catch (err) {
        notMp4.push(rel);
      }
    }
  }
  const items = [];
  const total = refs.size;
  if (missing.length || empty.length || notMp4.length) {
    const detail = []
      .concat(missing.map((m) => 'Falta: ' + m))
      .concat(empty.map((m) => 'Buit: ' + m))
      .concat(notMp4.map((m) => 'No és un MP4 vàlid: ' + m));
    items.push({ id: 'media', level: 'error', title: 'Fitxers: ' + (missing.length + empty.length + notMp4.length) + ' amb problemes', detail: detail.join('\n') });
  } else {
    items.push({ id: 'media', level: 'ok', title: 'Fitxers: tots els ' + total + ' hi són', detail: Math.round(bytes / 1048576) + ' MB en total' });
  }
  if (slow.length) {
    items.push({
      id: 'faststart', level: 'warn', title: slow.length + ' vídeos sense «faststart»',
      detail: 'Poden trigar més a començar. Torna\'ls a exportar amb -movflags +faststart:\n' + slow.join('\n'),
    });
  }
  return items;
}

function freeSpace(dir) {
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch (err) {
    return null;
  }
}

function runPreflight(ctx) {
  const { show, problems, showDir, dataDir, engine, mode, joinUrl, presenterPin, clients, system } = ctx;
  const items = [];

  const errors = problems.filter((p) => p.level === 'error').length;
  const warns = problems.filter((p) => p.level === 'warn').length;
  items.push({
    id: 'show',
    level: errors ? 'error' : warns ? 'warn' : 'ok',
    title: errors ? 'Guió: ' + errors + ' errors' : warns ? 'Guió: ' + warns + ' avisos' : 'Guió revisat, sense problemes',
    detail: problems.map((p) => (p.cueId ? '[' + p.cueId + '] ' : '') + p.msg).join('\n'),
  });
  items.push.apply(items, checkMedia(show, showDir));

  const s = engine.state;
  if (mode === 'assaig') {
    items.push({ id: 'mode', level: 'error', title: 'Esteu en MODE ASSAIG', detail: 'Abans de començar la gala, «Tornar a la gala» (targeta SESSIÓ).' });
  } else if (s.started) {
    const cue = engine.currentCue();
    items.push({
      id: 'mode', level: 'warn', title: 'La sessió de la gala ja ha començat (' + (cue ? cue.title || cue.id : '—') + ')',
      detail: 'Si era una prova, fes «Nova sessió» perquè la gala comenci de zero.',
    });
  } else {
    items.push({ id: 'mode', level: 'ok', title: 'Mode GALA, a punt per començar', detail: '' });
  }

  const screens = clients.filter((c) => c.role === 'screen');
  if (screens.length === 0) {
    items.push({ id: 'projector', level: 'error', title: 'Projector desconnectat', detail: 'Menú Projector › Recarregar projector (Ctrl+Shift+R).' });
  } else {
    const info = screens[0].info;
    const res = info ? Math.round(info.width * info.dpr) + 'x' + Math.round(info.height * info.dpr) : 'resolució desconeguda';
    const small = info && info.width * info.dpr < 1280;
    items.push({
      id: 'projector', level: small ? 'warn' : 'ok', title: 'Projector connectat (' + res + ')',
      detail: small ? 'Resolució baixa: comprova que és a la pantalla del projector i a pantalla completa.' : '',
    });
  }
  if (system && system.displays) {
    items.push({
      id: 'displays',
      level: system.projectorExternal ? 'ok' : 'warn',
      title: system.projectorExternal ? 'Projector a la segona pantalla' : 'El projector NO és a una pantalla externa',
      detail: system.displays.map((d) => (d.projector ? '▶ ' : '   ') + d.name).join('\n') +
        (system.projectorExternal ? '' : '\nConnecta el projector (mode «Ampliar») o tria la pantalla al menú Projector.'),
    });
  }

  const host = (joinUrl.match(/^https?:\/\/([^:/]+)/) || [])[1];
  if (!host || host === '127.0.0.1' || host === 'localhost') {
    items.push({ id: 'network', level: 'error', title: 'Sense xarxa', detail: 'El portàtil no té cap adreça a la xarxa local: els mòbils no s\'hi podran connectar.' });
  } else {
    items.push({ id: 'network', level: 'ok', title: 'Xarxa: ' + joinUrl, detail: 'Els mòbils i tauletes han d\'estar a la mateixa WiFi.' });
  }

  const online = new Set(clients.filter((c) => c.role === 'play').map((c) => c.deviceId));
  const claimed = Object.keys(s.claims);
  const ready = claimed.filter((pid) => online.has(s.claims[pid])).length;
  const n = show.participants.length;
  items.push({
    id: 'phones', level: ready === n ? 'ok' : 'warn',
    title: 'Mòbils i tauletes: ' + ready + ' de ' + n + ' connectats amb nom',
    detail: ready === n ? '' : 'Falten: ' + show.participants.filter((p) => !(s.claims[p.id] && online.has(s.claims[p.id])))
      .map((p) => p.name).join(', '),
  });

  const remotes = clients.filter((c) => c.role === 'remote').length;
  if (presenterPin) {
    items.push({
      id: 'remote', level: remotes ? 'ok' : 'warn',
      title: remotes ? 'Comandament del presentador connectat' : 'El comandament del presentador no està connectat',
      detail: remotes ? '' : 'Escaneja el QR de la targeta PRESENTADOR amb el mòbil del presentador.',
    });
  }

  const free = freeSpace(dataDir);
  if (free != null) {
    items.push({
      id: 'disk', level: free < MIN_FREE_BYTES ? 'warn' : 'ok',
      title: 'Espai lliure al disc: ' + (free / 1073741824).toFixed(1) + ' GB',
      detail: free < MIN_FREE_BYTES ? 'Allibera espai: el diari i els registres en necessiten.' : '',
    });
  }
  return { at: engine.now(), items };
}

module.exports = { runPreflight, inspectMp4, referencedMedia };
