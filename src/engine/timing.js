'use strict';
// Estimació de la durada de l'espectacle. Els vídeos es mesuren de debò; la resta
// depèn del ritme de la sala i s'estima amb valors raonables, que es poden
// substituir per cue amb `durada_estimada` (segons o "m:ss").

const fs = require('fs');

// Segons de referència per a les parts que depenen de la sala.
const GUESS = {
  hold: 60, // espera / benvinguda: el que es parli
  voteExtra: 30, // llegir la pregunta i comentar el resultat
  quizIntro: 20, quizPerQuestion: 25, quizRanking: 30, // a més del temps de cada pregunta
  challengeExtra: 40, wall: 180,
  paradeIntro: 20, paradeKid: 20, paradeVideoExtra: 15, paradeFinal: 30, // caminar i aplaudir
  awardsIntro: 20, awardsKid: 35, awardsFinal: 30, // recollir el diploma
  slidesMin: 0,
};

// Durada d'un MP4 a partir de la caixa mvhd (sense ffmpeg). null si no es pot llegir.
function mp4Duration(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    const find = (start, end, type) => {
      let pos = start;
      while (pos + 8 <= end) {
        fs.readSync(fd, head, 0, 16, pos);
        let len = head.readUInt32BE(0);
        let hdr = 8;
        if (len === 1) { len = Number(head.readBigUInt64BE(8)); hdr = 16; } else if (len === 0) len = end - pos;
        if (len < 8) return null;
        if (head.toString('latin1', 4, 8) === type) return { start: pos + hdr, end: pos + len };
        pos += len;
      }
      return null;
    };
    const moov = find(0, size, 'moov');
    const mvhd = moov && find(moov.start, moov.end, 'mvhd');
    if (!mvhd) return null;
    const b = Buffer.alloc(32);
    fs.readSync(fd, b, 0, 32, mvhd.start);
    const v1 = b[0] === 1;
    const timescale = v1 ? b.readUInt32BE(20) : b.readUInt32BE(12);
    const duration = v1 ? Number(b.readBigUInt64BE(24)) : b.readUInt32BE(16);
    return timescale > 0 ? duration / timescale : null;
  } catch (err) {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Durada estimada d'una cue.
 * @param {function} videoSeconds  ruta relativa -> segons | null
 * @returns {{ seconds: number, approx: boolean }}  approx: depèn del ritme de la sala
 */
function estimateCue(cue, show, videoSeconds) {
  if (cue.estimate != null) return { seconds: cue.estimate, approx: false, manual: true };
  const vid = (rel) => (rel ? videoSeconds(rel) : null);
  switch (cue.type) {
    case 'video': {
      const s = vid(cue.file);
      return s != null ? { seconds: s, approx: false } : { seconds: 0, approx: true, unknown: true };
    }
    case 'slides':
      return { seconds: cue.images.length * cue.interval, approx: false };
    case 'vote':
      return { seconds: (cue.duration || 30) + GUESS.voteExtra, approx: true };
    case 'quiz':
      return {
        seconds: GUESS.quizIntro + GUESS.quizRanking +
          cue.questions.reduce((a, q) => a + q.duration + GUESS.quizPerQuestion, 0),
        approx: true,
      };
    case 'challenge':
      return { seconds: cue.duration + GUESS.challengeExtra, approx: true };
    case 'wall':
      return { seconds: GUESS.wall, approx: true };
    case 'parade': {
      let total = GUESS.paradeIntro + GUESS.paradeFinal;
      for (const id of cue.people) {
        const p = show.participants.find((x) => x.id === id);
        const s = p && vid(p.entryVideo);
        total += s != null ? s + GUESS.paradeVideoExtra : GUESS.paradeKid;
      }
      return { seconds: total, approx: true };
    }
    case 'awards':
      return { seconds: GUESS.awardsIntro + GUESS.awardsFinal + cue.people.length * GUESS.awardsKid, approx: true };
    default:
      return { seconds: GUESS.hold, approx: true };
  }
}

// Temps real de cada cue a partir de les entrades del diari (timeline: [{cueId, t}]).
// Si s'hi ha entrat més d'un cop (ENRERE, salts), se sumen.
function actualTimes(timeline, now) {
  const out = {};
  timeline.forEach((e, i) => {
    if (!e.cueId) return;
    const end = i + 1 < timeline.length ? timeline[i + 1].t : now;
    out[e.cueId] = (out[e.cueId] || 0) + Math.max(0, end - e.t) / 1000;
  });
  return out;
}

// "m:ss" o segons -> segons (null si no és vàlid).
function parseDuration(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value >= 0 ? value : null;
  const m = String(value).trim().match(/^(?:(\d+):)?(\d+):(\d{1,2})$|^(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  if (m[4] != null) return Number(m[4]);
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

module.exports = { mp4Duration, estimateCue, actualTimes, parseDuration, GUESS };
