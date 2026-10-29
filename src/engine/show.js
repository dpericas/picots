'use strict';
// Càrrega i validació del guió (show.yaml).
// El fitxer fa servir claus en català; aquí es normalitza a un model intern.

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const CUE_TYPES = { video: 'video', diapositives: 'slides', votacio: 'vote', espera: 'hold', entrada: 'parade' };
const TIE_RULES = { aleatori: 'random', primera: 'first', operador: 'operator' };
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

function problem(level, cueId, msg) {
  return { level, cueId: cueId || null, msg };
}

// Converteix una ruta relativa al directori del guió en URL servida a /show/.
function mediaUrl(rel) {
  if (!rel) return null;
  return '/show/' + rel.split(/[\\/]+/).map(encodeURIComponent).join('/');
}

function normalizeCue(raw, index, problems) {
  const id = raw && raw.id != null ? String(raw.id) : null;
  if (!id) {
    problems.push(problem('error', null, 'La cue número ' + (index + 1) + ' no té "id".'));
  }
  const type = CUE_TYPES[raw && raw.tipus];
  if (!type) {
    problems.push(problem('error', id, 'Tipus desconegut: "' + (raw && raw.tipus) + '". Vàlids: ' +
      Object.keys(CUE_TYPES).join(', ') + '.'));
  }
  const cue = {
    id: id || '#' + (index + 1),
    type: type || 'hold',
    title: raw.titol != null ? String(raw.titol) : null,
    next: raw.seguent != null ? String(raw.seguent) : null,
    notes: raw.notes != null ? String(raw.notes) : null,
    script: raw.guio != null ? String(raw.guio) : null,
  };
  if (cue.type === 'video') {
    cue.file = raw.fitxer || null;
    cue.auto = raw.auto === true;
    cue.fade = raw.fos != null ? Number(raw.fos) : 0;
    if (!cue.file) problems.push(problem('error', cue.id, 'La cue de vídeo no té "fitxer".'));
    if (!(cue.fade >= 0 && cue.fade <= 10)) {
      problems.push(problem('error', cue.id, '"fos" ha de ser un número de segons entre 0 i 10.'));
    }
  } else if (cue.type === 'slides') {
    cue.folder = raw.carpeta || null;
    cue.images = Array.isArray(raw.imatges) ? raw.imatges.map(String) : [];
    cue.interval = Number(raw.segons) > 0 ? Number(raw.segons) : 4;
    cue.music = raw.musica || null;
    if (!cue.folder && cue.images.length === 0) {
      problems.push(problem('error', cue.id, 'Les diapositives necessiten "carpeta" o "imatges".'));
    }
  } else if (cue.type === 'vote') {
    cue.question = raw.pregunta != null ? String(raw.pregunta) : '';
    cue.duration = raw.temps != null ? Number(raw.temps) : 30;
    cue.tie = TIE_RULES[raw.empat || 'aleatori'];
    cue.defaultOption = raw.per_defecte != null ? Number(raw.per_defecte) : 0;
    cue.options = (Array.isArray(raw.opcions) ? raw.opcions : []).map((o) => ({
      text: o && o.text != null ? String(o.text) : '',
      goto: o && o.va_a != null ? String(o.va_a) : null,
    }));
    if (!cue.tie) problems.push(problem('error', cue.id, 'Regla d\'empat desconeguda: "' + raw.empat + '".'));
    if (!(cue.duration >= 0)) problems.push(problem('error', cue.id, '"temps" ha de ser un número >= 0.'));
    if (cue.options.length < 2) problems.push(problem('error', cue.id, 'Una votació necessita almenys 2 opcions.'));
    if (!(cue.defaultOption >= 0 && cue.defaultOption < cue.options.length)) {
      problems.push(problem('error', cue.id, '"per_defecte" ha de ser l\'índex d\'una opció (0..' +
        (cue.options.length - 1) + ').'));
    }
  } else if (cue.type === 'parade') {
    cue.text = raw.text != null ? String(raw.text) : '';
    cue.finalText = raw.text_final != null ? String(raw.text_final) : '';
    cue.music = raw.musica || null;
    cue.effect = raw.efecte || null;
    cue.nameOverVideo = raw.nom_sobre_video !== false;
    cue.order = Array.isArray(raw.ordre) ? raw.ordre.map(String) : null;
    cue.people = [];
  } else {
    cue.text = raw.text != null ? String(raw.text) : '';
    cue.music = raw.musica || null;
  }
  return cue;
}

function normalize(doc, problems) {
  const participants = (Array.isArray(doc.participants) ? doc.participants : []).map((p, i) => ({
    id: p && p.id != null ? String(p.id) : 'p' + (i + 1),
    name: p && p.nom != null ? String(p.nom) : 'Participant ' + (i + 1),
    avatar: (p && p.avatar) || null,
    photo: (p && p.foto) || null,
    entryVideo: (p && p.video_entrada) || null,
  }));
  const cues = (Array.isArray(doc.cues) ? doc.cues : []).map((c, i) => normalizeCue(c || {}, i, problems));
  const net = doc.xarxa || {};
  return {
    title: doc.titol != null ? String(doc.titol) : 'Gala',
    participants,
    cues,
    network: {
      port: net.port != null ? Number(net.port) : 8080,
      publicHost: net.ip_publica || null,
      controlPin: net.pin_control != null ? String(net.pin_control) : null,
      presenterPin: net.pin_presentador != null ? String(net.pin_presentador) : null,
    },
  };
}

function validateRefs(show, problems) {
  const ids = new Set();
  for (const cue of show.cues) {
    if (ids.has(cue.id)) problems.push(problem('error', cue.id, 'Id de cue repetit.'));
    ids.add(cue.id);
  }
  for (const cue of show.cues) {
    if (cue.next && !ids.has(cue.next)) {
      problems.push(problem('error', cue.id, '"seguent" apunta a una cue que no existeix: ' + cue.next));
    }
    if (cue.type === 'vote') {
      cue.options.forEach((o, i) => {
        if (!o.goto) problems.push(problem('error', cue.id, 'L\'opció ' + i + ' no té "va_a".'));
        else if (!ids.has(o.goto)) {
          problems.push(problem('error', cue.id, 'L\'opció ' + i + ' apunta a una cue que no existeix: ' + o.goto));
        }
      });
    }
  }
  const pids = new Set();
  for (const p of show.participants) {
    if (pids.has(p.id)) problems.push(problem('error', null, 'Participant amb id repetit: ' + p.id));
    pids.add(p.id);
  }
  // Entrada triomfal: per defecte, tots els participants en l'ordre de la llista.
  for (const cue of show.cues) {
    if (cue.type !== 'parade') continue;
    const ids = cue.order || show.participants.map((p) => p.id);
    const seen = new Set();
    for (const id of ids) {
      if (!pids.has(id)) problems.push(problem('error', cue.id, '"ordre" inclou un participant que no existeix: ' + id));
      else if (seen.has(id)) problems.push(problem('error', cue.id, '"ordre" repeteix un participant: ' + id));
      else cue.people.push(id);
      seen.add(id);
    }
    if (cue.order) {
      show.participants.filter((p) => !seen.has(p.id)).forEach((p) => {
        problems.push(problem('warn', cue.id, p.name + ' no surt a l\'"ordre" de l\'entrada.'));
      });
    }
    if (cue.people.length === 0) problems.push(problem('error', cue.id, 'L\'entrada no té cap participant.'));
  }
  if (show.cues.length === 0) problems.push(problem('error', null, 'El guió no té cap cue.'));
}

// Comprova que els fitxers existeixen i resol les carpetes de diapositives.
function resolveMedia(show, showDir, problems) {
  const exists = (rel) => rel && fs.existsSync(path.join(showDir, rel));
  for (const cue of show.cues) {
    if (cue.type === 'video' && cue.file && !exists(cue.file)) {
      problems.push(problem('error', cue.id, 'No es troba el vídeo: ' + cue.file));
    }
    if (cue.type === 'slides' && cue.folder) {
      const dir = path.join(showDir, cue.folder);
      if (!fs.existsSync(dir)) {
        problems.push(problem('error', cue.id, 'No es troba la carpeta: ' + cue.folder));
      } else {
        const files = fs.readdirSync(dir)
          .filter((f) => IMAGE_EXT.includes(path.extname(f).toLowerCase()))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        cue.images = cue.images.concat(files.map((f) => path.posix.join(cue.folder.replace(/\\/g, '/'), f)));
      }
    }
    if (cue.type === 'slides') {
      if (cue.images.length === 0) problems.push(problem('error', cue.id, 'Les diapositives no tenen cap imatge.'));
      cue.images.filter((img) => !exists(img)).forEach((img) => {
        problems.push(problem('error', cue.id, 'No es troba la imatge: ' + img));
      });
    }
    if (cue.music && !exists(cue.music)) {
      problems.push(problem('warn', cue.id, 'No es troba la música: ' + cue.music));
    }
    if (cue.effect && !exists(cue.effect)) {
      problems.push(problem('warn', cue.id, 'No es troba l\'efecte de so: ' + cue.effect));
    }
    if (cue.type === 'parade') {
      cue.people.map((id) => show.participants.find((p) => p.id === id))
        .filter((p) => !p.photo && !p.avatar)
        .forEach((p) => problems.push(problem('warn', cue.id, p.name + ' no té foto ni avatar: sortiran les inicials.')));
    }
  }
  for (const p of show.participants) {
    if (p.avatar && !exists(p.avatar)) {
      problems.push(problem('warn', null, 'No es troba l\'avatar de ' + p.name + ': ' + p.avatar));
    }
    if (p.entryVideo && !exists(p.entryVideo)) {
      problems.push(problem('error', null, 'No es troba el vídeo d\'entrada de ' + p.name + ': ' + p.entryVideo));
    }
    if (p.photo && !exists(p.photo)) {
      problems.push(problem('warn', null, 'No es troba la foto de ' + p.name + ': ' + p.photo));
    }
  }
}

function parseShow(text, showDir) {
  const problems = [];
  let doc;
  try {
    doc = YAML.parse(text) || {};
  } catch (err) {
    return { show: null, problems: [problem('error', null, 'Error de sintaxi YAML: ' + err.message)] };
  }
  const show = normalize(doc, problems);
  validateRefs(show, problems);
  if (showDir) resolveMedia(show, showDir, problems);
  return { show, problems };
}

function loadShow(showDir) {
  const file = path.join(showDir, 'show.yaml');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { show: null, problems: [problem('error', null, 'No es pot llegir ' + file + ': ' + err.message)] };
  }
  return parseShow(text, showDir);
}

function hasErrors(problems) {
  return problems.some((p) => p.level === 'error');
}

module.exports = { loadShow, parseShow, hasErrors, mediaUrl };
