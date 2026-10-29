'use strict';
// Resum de la gala: una pàgina HTML autònoma (sense fitxers externs) amb el camí
// seguit, els resultats de les votacions, el qüestionari i els reptes, i els
// missatges aprovats del mur amb els dibuixos. Es pot desar abans d'esborrar-ho tot.

const { countBallots } = require('../engine/reducer');
const quiz = require('../engine/quiz');

function esc(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
  }[c]));
}

const STYLE = `
body { font-family: "Segoe UI", system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 24px; color: #1b1f3a; }
h1 { margin-bottom: 4px; } .meta { color: #666; margin-bottom: 24px; }
h2 { border-bottom: 3px solid #ffcc33; padding-bottom: 4px; margin-top: 32px; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; }
td, th { border-bottom: 1px solid #ddd; padding: 6px 8px; text-align: left; }
td.n { text-align: right; width: 60px; font-weight: 700; }
tr.win td { color: #15803d; font-weight: 700; }
.path { line-height: 1.8; }
.wall { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.msg { border: 1px solid #ddd; border-radius: 10px; padding: 10px; }
.msg .who { font-weight: 700; color: #666; font-size: 13px; margin-bottom: 4px; }
.msg img { width: 100%; border-radius: 6px; background: #fff; }
`;

function renderSummary(engine, opts) {
  const show = engine.show;
  const s = engine.state;
  const name = (pid) => {
    const p = show.participants.find((x) => x.id === pid);
    return p ? p.name : pid;
  };
  const cueTitle = (id) => {
    const c = show.cues.find((x) => x.id === id);
    return c ? c.title || c.id : id;
  };
  const parts = [];
  const route = s.history.concat(s.cueId ? [s.cueId] : []);
  parts.push('<h2>Camí de l\'espectacle</h2><p class="path">' +
    (route.length ? route.map((id) => esc(cueTitle(id))).join(' → ') : 'L\'espectacle no ha començat.') + '</p>');

  const votes = show.cues.filter((c) => c.type === 'vote' && s.votes[c.id]);
  if (votes.length) {
    parts.push('<h2>Votacions</h2>');
    votes.forEach((c) => {
      const v = s.votes[c.id];
      const counts = v.counts || countBallots(v.ballots, c.options.length);
      parts.push('<h3>' + esc(c.question || c.title) + '</h3><table>' + c.options.map((o, i) =>
        '<tr class="' + (v.result === i ? 'win' : '') + '"><td>' + esc(o.text) + (v.result === i ? ' ✔' : '') +
        '</td><td class="n">' + counts[i] + '</td></tr>').join('') + '</table>');
    });
  }

  const quizzes = show.cues.filter((c) => c.type === 'quiz' && s.quiz[c.id]);
  quizzes.forEach((c) => {
    const rows = quiz.ranking(quiz.scores(c, s.quiz[c.id]));
    parts.push('<h2>' + esc(c.title || 'Qüestionari') + '</h2><table>' + rows.map((r) =>
      '<tr><td>' + r.rank + '. ' + esc(name(r.id)) + '</td><td class="n">' + r.points + '</td></tr>').join('') + '</table>');
  });

  const challenges = show.cues.filter((c) => c.type === 'challenge' && s.challenges[c.id]);
  if (challenges.length) {
    parts.push('<h2>Reptes</h2><ul>' + challenges.map((c) => {
      const ch = s.challenges[c.id];
      const p = engine.challengeProgress(c);
      return '<li>' + esc(c.title || c.id) + ': ' + (ch.result === 'success' ? '🎉 superat' : ch.result === 'fail' ? 'no superat' : 'en marxa') +
        ' (' + p.total + ' / ' + p.goal + ')</li>';
    }).join('') + '</ul>');
  }

  const posts = s.wall.filter((m) => m.status === 'approved');
  if (posts.length) {
    parts.push('<h2>Mur de missatges</h2><div class="wall">' + posts.map((m) => {
      const drawing = m.drawing ? engine.drawings.get(m.id) : null;
      return '<div class="msg"><div class="who">' + esc(name(m.participantId)) + '</div>' +
        (drawing ? '<img src="' + esc(drawing) + '" alt="dibuix">' : esc(m.text)) + '</div>';
    }).join('') + '</div>');
  }

  return '<!doctype html><html lang="ca"><head><meta charset="utf-8"><title>' + esc(show.title) + ' – Resum</title><style>' +
    STYLE + '</style></head><body><h1>' + esc(show.title) + '</h1><div class="meta">Resum desat el ' + esc(opts.date) +
    (opts.mode === 'assaig' ? ' · <b>MODE ASSAIG</b> (no és la gala)' : '') + '</div>' + parts.join('') + '</body></html>';
}

module.exports = { renderSummary };
