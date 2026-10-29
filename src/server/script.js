'use strict';
// Guió del presentador per imprimir: cada cue en ordre, amb el text que ha de dir
// (guio), les notes del tècnic, el minut previst i les branques de les votacions.

function esc(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
  }[c]));
}

const TYPE = {
  video: 'Vídeo', slides: 'Fotos', vote: 'Votació', hold: 'Espera', parade: 'Entrada triomfal',
  quiz: 'Qüestionari', challenge: 'Repte', awards: 'Mencions', wall: 'Mur',
};

function clock(seconds) {
  const t = Math.max(0, Math.round(seconds));
  const h = Math.floor(t / 3600);
  const m = String(Math.floor(t / 60) % 60).padStart(h ? 2 : 1, '0');
  return (h ? h + ':' : '') + m + ':' + String(t % 60).padStart(2, '0');
}

/**
 * @param {object} show
 * @param {object} timing  { perCue, route } del servidor
 */
function renderScript(show, timing) {
  const start = {};
  let acc = 0;
  timing.route.forEach((id) => {
    start[id] = acc;
    acc += timing.perCue[id].seconds;
  });
  const name = (pid) => (show.participants.find((p) => p.id === pid) || { name: pid }).name;
  const rows = show.cues.map((c, i) => {
    const e = timing.perCue[c.id];
    const extra = [];
    if (c.type === 'vote') extra.push('<b>' + esc(c.question) + '</b><br>' + c.options.map((o, k) => 'ABCD'[k] + '. ' + esc(o.text) + ' → ' + esc(o.goto)).join('<br>'));
    if (c.type === 'challenge') extra.push('Si el superen → ' + esc(c.successGoto) + ' · si no → ' + esc(c.failGoto || '(la de sota)'));
    if (c.type === 'quiz') extra.push(c.questions.map((q, k) => (k + 1) + '. ' + esc(q.text) + ' <i>(' + 'ABCD'[q.correct] + ': ' + esc(q.options[q.correct]) + ')</i>').join('<br>'));
    if (c.type === 'parade' || c.type === 'awards') {
      extra.push(c.people.map((pid, k) => (k + 1) + '. ' + esc(name(pid)) + (c.type === 'awards' && c.mentionFor[pid] ? ' – <i>' + esc(c.mentionFor[pid]) + '</i>' : '')).join('<br>'));
    }
    return '<tr class="' + (start[c.id] == null ? 'off' : '') + '"><td class="n">' + (i + 1) + '</td>' +
      '<td class="t">' + (start[c.id] != null ? '+' + clock(start[c.id]) : '—') + '<br><small>' + (e.approx ? '≈' : '') + clock(e.seconds) + '</small></td>' +
      '<td><div class="h">' + esc(c.title || c.id) + ' <span>' + esc(TYPE[c.type] || c.type) + '</span></div>' +
      (c.script ? '<div class="say">«' + esc(c.script) + '»</div>' : '') +
      (extra.length ? '<div class="x">' + extra.join('<br>') + '</div>' : '') +
      (c.notes ? '<div class="notes">Tècnic: ' + esc(c.notes) + '</div>' : '') + '</td></tr>';
  });
  return '<!doctype html><html lang="ca"><head><meta charset="utf-8"><title>Guió del presentador</title><style>' +
    '@page{size:A4;margin:14mm}body{font-family:"Segoe UI",system-ui,sans-serif;color:#1b1f3a;font-size:11pt}' +
    'h1{margin:0}p.meta{color:#666}table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #ddd;padding:6px;vertical-align:top}' +
    'td.n{width:24px;color:#999}td.t{width:58px;font-variant-numeric:tabular-nums;font-weight:700}td.t small{font-weight:400;color:#888}' +
    '.h{font-weight:700;font-size:12pt}.h span{font-weight:400;font-size:9pt;color:#888;text-transform:uppercase;margin-left:6px}' +
    '.say{margin:4px 0;padding:4px 8px;border-left:3px solid #ffcc33;background:#fff8e1;font-size:12pt}' +
    '.x{font-size:9.5pt;color:#444;margin-top:3px}.notes{font-size:9pt;color:#8a5a00;margin-top:3px}tr.off{color:#999}' +
    'tr{break-inside:avoid}@media print{.noprint{display:none}}</style></head><body>' +
    '<p class="noprint"><button onclick="print()">🖨 Imprimir</button></p>' +
    '<h1>' + esc(show.title) + ' – Guió del presentador</h1>' +
    '<p class="meta">Durada estimada pel camí per defecte: ≈' + clock(acc) + '. «+m:ss» = minut previst d\'inici (≈ depèn del ritme de la sala). ' +
    'Les cues en gris no són al camí per defecte (branques).</p><table>' + rows.join('') +
    '</table><script>document.title = \'ready\';</script></body></html>';
}

module.exports = { renderScript };
