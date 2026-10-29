'use strict';
// Vídeo lineal de reserva (pla B si falla el portàtil): tot l'espectacle en un sol
// MP4 per a VLC, seguint la branca per defecte de cada votació. Les parts
// interactives es converteixen en targetes fixes. Aquí hi ha la lògica pura;
// el muntatge (Electron + ffmpeg) és a scripts/make-backup-video.js.

const path = require('path');

// Segons de cada targeta fixa.
const SECONDS = {
  hold: 8, voteQuestion: 10, paradeIntro: 5, kid: 6, paradeFinal: 6, quizIntro: 5, question: 10, answer: 5,
  quizEnd: 5, challenge: 8, challengeResult: 4, wall: 8, award: 7,
};

function linearNext(show, cue) {
  if (cue.next) return cue.next;
  const i = show.cues.indexOf(cue);
  return i >= 0 && i + 1 < show.cues.length ? show.cues[i + 1].id : null;
}

/**
 * Camí de l'espectacle sense interacció.
 * @param {object} choices  { votes: {cueId: índex}, challenge: 'success' | 'fail' }
 * @param {string} [startId] cue des d'on començar (per defecte, la primera)
 * @returns {{ ids: string[], warnings: string[] }}
 */
function linearPath(show, choices, startId) {
  const votes = (choices && choices.votes) || {};
  const challenge = (choices && choices.challenge) || 'success';
  const ids = [];
  const warnings = [];
  const byId = new Map(show.cues.map((c) => [c.id, c]));
  let cue = startId ? byId.get(startId) || null : show.cues[0] || null;
  while (cue) {
    if (ids.includes(cue.id)) {
      warnings.push('El camí torna a «' + cue.id + '» (bucle): s\'atura aquí.');
      break;
    }
    ids.push(cue.id);
    let next;
    if (cue.type === 'vote') {
      const choice = votes[cue.id] != null ? votes[cue.id] : cue.defaultOption;
      const option = cue.options[choice] || cue.options[cue.defaultOption];
      if (votes[cue.id] != null && !cue.options[choice]) warnings.push(cue.id + ': opció ' + choice + ' no vàlida, s\'usa la per defecte.');
      next = option.goto;
    } else if (cue.type === 'challenge') {
      next = challenge === 'success' ? cue.successGoto : (cue.failGoto || linearNext(show, cue));
    } else {
      next = linearNext(show, cue);
    }
    cue = next ? byId.get(next) || null : null;
  }
  return { ids, warnings };
}

const LETTERS = 'ABCD';

/**
 * Segments del vídeo: { kind: 'video', file } | { kind: 'card', card, seconds, audio } |
 * { kind: 'slides', images, interval, audio }, cadascun amb `chapter` si comença un capítol.
 * card: { title, subtitle, photo, items: [{ text, mark }], tone }
 * Rutes de fitxers: absolutes (showDir + relativa).
 */
function buildSegments(show, ids, showDir, choices) {
  const abs = (rel) => (rel ? path.join(showDir, rel) : null);
  const person = (id) => show.participants.find((p) => p.id === id);
  const votes = (choices && choices.votes) || {};
  const challenge = (choices && choices.challenge) || 'success';
  const segs = [];
  const add = (seg, chapter) => segs.push(Object.assign(seg, chapter ? { chapter } : {}));
  const card = (c, seconds, audio, chapter) => add({ kind: 'card', card: c, seconds, audio: audio || null }, chapter);

  for (const id of ids) {
    const cue = show.cues.find((c) => c.id === id);
    const title = cue.title || cue.id;
    if (cue.type === 'video') {
      add({ kind: 'video', file: abs(cue.file) }, title);
    } else if (cue.type === 'slides') {
      add({ kind: 'slides', images: cue.images.map(abs), interval: cue.interval, audio: abs(cue.music) }, title);
    } else if (cue.type === 'hold') {
      card({ title: cue.text || title, tone: 'hold' }, SECONDS.hold, abs(cue.music), title);
    } else if (cue.type === 'vote') {
      const choice = votes[cue.id] != null && cue.options[votes[cue.id]] ? votes[cue.id] : cue.defaultOption;
      card({
        title: cue.question, subtitle: 'Hem triat:',
        items: cue.options.map((o, i) => ({ text: LETTERS[i] + '. ' + o.text, mark: i === choice })),
        tone: 'vote',
      }, SECONDS.voteQuestion, null, title);
    } else if (cue.type === 'parade' || cue.type === 'awards') {
      const awards = cue.type === 'awards';
      const tone = awards ? 'awards' : 'parade';
      card({ title: cue.text || title, tone }, SECONDS.paradeIntro, abs(cue.music), title);
      cue.people.forEach((pid) => {
        const p = person(pid);
        const chapter = title + ' · ' + p.name;
        if (!awards && p.entryVideo) add({ kind: 'video', file: abs(p.entryVideo) }, chapter);
        else {
          card({
            title: p.name, subtitle: awards ? cue.mentionFor[pid] : null, photo: abs(p.photo || p.avatar), tone,
          }, awards ? SECONDS.award : SECONDS.kid, abs(cue.effect), chapter);
        }
      });
      card({ title: cue.finalText || title, tone }, SECONDS.paradeFinal, abs(cue.music));
    } else if (cue.type === 'quiz') {
      card({ title: title, subtitle: cue.text, tone: 'quiz' }, SECONDS.quizIntro, abs(cue.music), title);
      cue.questions.forEach((q, i) => {
        const items = q.options.map((o, k) => ({ text: LETTERS[k] + '. ' + o, mark: false }));
        card({ title: q.text, subtitle: 'Pregunta ' + (i + 1) + ' de ' + cue.questions.length, items, photo: abs(q.image), tone: 'quiz' },
          SECONDS.question, null, title + ' · P' + (i + 1));
        card({
          title: q.text, subtitle: 'Resposta correcta',
          items: q.options.map((o, k) => ({ text: LETTERS[k] + '. ' + o, mark: k === q.correct })), tone: 'quiz',
        }, SECONDS.answer);
      });
      card({ title: 'Molt bé a tots! 👏', tone: 'quiz' }, SECONDS.quizEnd);
    } else if (cue.type === 'challenge') {
      card({ title: cue.text || title, subtitle: 'Repte', tone: 'challenge' }, SECONDS.challenge, abs(cue.music), title);
      card({ title: challenge === 'success' ? '🎉 REPTE SUPERAT! 🎉' : 'Gairebé! 💪', tone: 'challenge' }, SECONDS.challengeResult);
    } else if (cue.type === 'wall') {
      card({ title: cue.text || title, tone: 'wall' }, SECONDS.wall, abs(cue.music), title);
    }
  }
  return segs;
}

function hms(seconds) {
  const s = Math.floor(seconds);
  const p = (n) => String(n).padStart(2, '0');
  return Math.floor(s / 3600) + ':' + p(Math.floor(s / 60) % 60) + ':' + p(s % 60);
}

// Metadades de capítols (format FFMETADATA1) i índex llegible.
function chapters(entries, totalMs) {
  let meta = ';FFMETADATA1\n';
  let index = '';
  entries.forEach((e, i) => {
    const end = i + 1 < entries.length ? entries[i + 1].startMs : totalMs;
    meta += '\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=' + Math.round(e.startMs) + '\nEND=' + Math.round(end) +
      '\ntitle=' + String(e.title).replace(/[=;#\\\n]/g, ' ') + '\n';
    index += hms(e.startMs / 1000) + '  ' + e.title + '\n';
  });
  return { meta, index };
}

module.exports = { linearPath, buildSegments, chapters, hms, SECONDS };
