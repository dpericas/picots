'use strict';
// Càrrega i validació del guió (show.yaml).
// El fitxer fa servir claus en català; aquí es normalitza a un model intern.

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { parseDuration } = require('./timing');

const CUE_TYPES = {
  video: 'video',
  diapositives: 'slides',
  votacio: 'vote',
  espera: 'hold',
  entrada: 'parade',
  questionari: 'quiz',
  'qüestionari': 'quiz',
  repte: 'challenge',
  mencions: 'awards',
  mur: 'wall',
};
const CHALLENGE_MODES = { tocs: 'taps', tots: 'all' };
const MAX_QUIZ_OPTIONS = 4;
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
    estimate: parseDuration(raw.durada_estimada),
  };
  if (raw.durada_estimada != null && cue.estimate == null) {
    problems.push(problem('error', cue.id, '"durada_estimada" ha de ser segons o "m:ss" (p. ex. 2:30).'));
  }
  if (cue.type === 'video') {
    cue.file = raw.fitxer || null;
    cue.auto = raw.auto === true;
    cue.fade = raw.fos != null ? Number(raw.fos) : 0;
    cue.caption = raw.rotol != null ? String(raw.rotol) : null; // rètol a la part de baix (p. ex. qui parla)
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
  } else if (cue.type === 'awards') {
    cue.text = raw.text != null ? String(raw.text) : '';
    cue.finalText = raw.text_final != null ? String(raw.text_final) : '';
    cue.music = raw.musica || null;
    cue.effect = raw.efecte || null;
    cue.order = Array.isArray(raw.ordre) ? raw.ordre.map(String) : null;
    cue.mentions = raw.mencions && typeof raw.mencions === 'object' ? raw.mencions : {};
    cue.people = [];
    // Diploma imprès (pàgina /diplomes): textos opcionals.
    const d = raw.diploma && typeof raw.diploma === 'object' ? raw.diploma : {};
    cue.diploma = {
      title: d.titol != null ? String(d.titol) : 'Diploma',
      intro: d.text != null ? String(d.text) : 's\'atorga a',
      footer: d.peu != null ? String(d.peu) : null,
      date: d.data != null ? String(d.data) : '',
      signatures: Array.isArray(d.signatures) ? d.signatures.map(String) : [],
    };
  } else if (cue.type === 'quiz') {
    normalizeQuiz(cue, raw, problems);
  } else if (cue.type === 'challenge') {
    cue.text = raw.text != null ? String(raw.text) : '';
    cue.music = raw.musica || null;
    cue.mode = CHALLENGE_MODES[raw.modalitat || 'tocs'];
    cue.goal = raw.objectiu != null ? Number(raw.objectiu) : 200;
    cue.duration = raw.temps != null ? Number(raw.temps) : 20;
    cue.successGoto = raw.si_exit != null ? String(raw.si_exit) : null;
    cue.failGoto = raw.si_no != null ? String(raw.si_no) : null;
    if (!cue.mode) problems.push(problem('error', cue.id, 'Modalitat desconeguda: "' + raw.modalitat + '". Vàlides: tocs, tots.'));
    if (cue.mode === 'taps' && !(Number.isInteger(cue.goal) && cue.goal > 0)) {
      problems.push(problem('error', cue.id, '"objectiu" ha de ser un nombre de tocs més gran que 0.'));
    }
    if (!(cue.duration > 0)) problems.push(problem('error', cue.id, '"temps" ha de ser un número de segons > 0.'));
    if (!cue.successGoto) problems.push(problem('error', cue.id, 'El repte necessita "si_exit" (on anem si el superen).'));
  } else if (cue.type === 'wall') {
    cue.text = raw.text != null ? String(raw.text) : '';
    cue.music = raw.musica || null;
    cue.moderation = raw.moderacio !== false;
    cue.drawings = raw.dibuixos !== false;
    cue.maxPerPerson = raw.maxim_per_nen != null ? Number(raw.maxim_per_nen) : 3;
    if (!(Number.isInteger(cue.maxPerPerson) && cue.maxPerPerson > 0)) {
      problems.push(problem('error', cue.id, '"maxim_per_nen" ha de ser un enter > 0.'));
    }
  } else {
    cue.text = raw.text != null ? String(raw.text) : '';
    cue.music = raw.musica || null;
  }
  return cue;
}

// "correcta" admet la lletra de l'opció (A, B, C, D) o l'índex (0, 1, 2, 3).
function parseCorrect(value) {
  if (typeof value === 'number') return value;
  const t = String(value == null ? '' : value).trim().toUpperCase();
  if (/^[A-D]$/.test(t)) return t.charCodeAt(0) - 65;
  if (/^\d+$/.test(t)) return Number(t);
  return -1;
}

function normalizeQuiz(cue, raw, problems) {
  cue.text = raw.text != null ? String(raw.text) : '';
  cue.music = raw.musica || null;
  cue.ranking = raw.classificacio != null ? Number(raw.classificacio) : 5;
  cue.closeWhenAll = raw.tancar_quan_tots !== false;
  const defaultTime = raw.temps != null ? Number(raw.temps) : 20;
  cue.questions = (Array.isArray(raw.preguntes) ? raw.preguntes : []).map((q, i) => {
    q = q || {};
    const out = {
      text: q.pregunta != null ? String(q.pregunta) : '',
      options: (Array.isArray(q.opcions) ? q.opcions : []).map(String),
      correct: parseCorrect(q.correcta),
      duration: q.temps != null ? Number(q.temps) : defaultTime,
      image: q.imatge || null,
    };
    const where = 'Pregunta ' + (i + 1) + ': ';
    if (!out.text) problems.push(problem('error', cue.id, where + 'falta "pregunta".'));
    if (out.options.length < 2 || out.options.length > MAX_QUIZ_OPTIONS) {
      problems.push(problem('error', cue.id, where + 'ha de tenir entre 2 i ' + MAX_QUIZ_OPTIONS + ' opcions.'));
    }
    if (!(out.correct >= 0 && out.correct < out.options.length)) {
      problems.push(problem('error', cue.id, where + '"correcta" ha de ser la lletra d\'una opció (A, B…).'));
    }
    if (!(out.duration > 0)) problems.push(problem('error', cue.id, where + '"temps" ha de ser un número de segons > 0.'));
    return out;
  });
  if (cue.questions.length === 0) problems.push(problem('error', cue.id, 'El qüestionari no té cap pregunta ("preguntes").'));
  if (!(Number.isInteger(cue.ranking) && cue.ranking >= 0)) {
    problems.push(problem('error', cue.id, '"classificacio" ha de ser un enter >= 0 (0 = no mostrar punts).'));
  }
}

function normalize(doc, problems) {
  const participants = (Array.isArray(doc.participants) ? doc.participants : []).map((p, i) => ({
    id: p && p.id != null ? String(p.id) : 'p' + (i + 1),
    name: p && p.nom != null ? String(p.nom) : 'Participant ' + (i + 1),
    avatar: (p && p.avatar) || null,
    photo: (p && p.foto) || null,
    entryVideo: (p && p.video_entrada) || null,
    mention: p && p.mencio != null ? String(p.mencio) : null,
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
    if (cue.type === 'challenge') {
      [['si_exit', cue.successGoto], ['si_no', cue.failGoto]].forEach(([key, target]) => {
        if (target && !ids.has(target)) {
          problems.push(problem('error', cue.id, '"' + key + '" apunta a una cue que no existeix: ' + target));
        }
      });
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
  // Entrada triomfal i mencions: per defecte, tots els participants en l'ordre de la llista.
  for (const cue of show.cues) {
    if (cue.type !== 'parade' && cue.type !== 'awards') continue;
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
    if (cue.people.length === 0) problems.push(problem('error', cue.id, 'La cue no té cap participant.'));
    if (cue.type === 'awards') {
      Object.keys(cue.mentions).filter((id) => !pids.has(id)).forEach((id) => {
        problems.push(problem('error', cue.id, '"mencions" inclou un participant que no existeix: ' + id));
      });
      // La menció de la cue té preferència sobre la del participant.
      cue.mentionFor = {};
      cue.people.forEach((id) => {
        const p = show.participants.find((x) => x.id === id);
        const text = cue.mentions[id] != null ? String(cue.mentions[id]) : p.mention;
        cue.mentionFor[id] = text || '';
        if (!text) problems.push(problem('warn', cue.id, p.name + ' no té menció (mencio o mencions).'));
      });
    }
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
    if (cue.type === 'quiz') {
      cue.questions.forEach((q, i) => {
        if (q.image && !exists(q.image)) {
          problems.push(problem('error', cue.id, 'Pregunta ' + (i + 1) + ': no es troba la imatge ' + q.image));
        }
      });
    }
    if (cue.type === 'parade' || cue.type === 'awards') {
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
