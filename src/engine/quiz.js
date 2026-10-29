'use strict';
// Qüestionari: correspondència entre passos i preguntes, i càlcul de punts.
//
// Passos: 0 = inici; per a cada pregunta, tres passos (es llegeix, s'hi respon
// amb compte enrere, solució); l'últim = classificació.

const MAX_POINTS = 1000;

function stepCount(cue) {
  return 2 + cue.questions.length * 3;
}

function stepInfo(cue, step) {
  if (step <= 0) return { kind: 'intro', q: null };
  const last = stepCount(cue) - 1;
  if (step >= last) return { kind: 'ranking', q: null };
  const q = Math.floor((step - 1) / 3);
  return { kind: ['question', 'open', 'reveal'][(step - 1) % 3], q };
}

function stepLabel(cue, step) {
  const info = stepInfo(cue, step);
  if (info.kind === 'intro') return 'Inici';
  if (info.kind === 'ranking') return cue.ranking > 0 ? 'Classificació' : 'Final';
  const n = 'P' + (info.q + 1);
  return n + { question: ' · pregunta', open: ' · resposta oberta', reveal: ' · solució' }[info.kind];
}

// Resposta correcta: de 500 a 1000 punts segons la rapidesa. Incorrecta: 0.
function points(question, answer) {
  if (!answer || answer.option !== question.correct) return 0;
  const total = question.duration * 1000;
  const frac = Math.min(1, Math.max(0, answer.ms / total));
  return Math.round(MAX_POINTS * (1 - frac / 2));
}

// Punts de cada participant fins a la pregunta `upTo` inclosa (per defecte, totes).
function scores(cue, answersByQ, upTo) {
  const out = {};
  const last = upTo == null ? cue.questions.length - 1 : upTo;
  cue.questions.forEach((question, q) => {
    if (q > last) return;
    const answers = (answersByQ && answersByQ[q]) || {};
    Object.keys(answers).forEach((pid) => {
      out[pid] = (out[pid] || 0) + points(question, answers[pid]);
    });
  });
  return out;
}

// Classificació ordenada (empats: mateixa posició).
function ranking(scoreMap) {
  const rows = Object.keys(scoreMap).map((pid) => ({ id: pid, points: scoreMap[pid] }))
    .sort((a, b) => b.points - a.points || a.id.localeCompare(b.id));
  rows.forEach((r, i) => {
    r.rank = i > 0 && rows[i - 1].points === r.points ? rows[i - 1].rank : i + 1;
  });
  return rows;
}

module.exports = { stepCount, stepInfo, stepLabel, points, scores, ranking, MAX_POINTS };
