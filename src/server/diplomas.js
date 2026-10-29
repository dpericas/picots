'use strict';
// Diplomes per imprimir: una pàgina A4 apaïsada per nen, amb la foto, el nom i
// la menció de la cue de mencions. Es desa en PDF des del menú Gala de l'app
// o amb el botó «Imprimir» de la pàgina.

const { mediaUrl } = require('../engine/show');

function esc(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
  }[c]));
}

function initials(name) {
  return name.split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase();
}

const STYLE = `
@page { size: A4 landscape; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #ddd; font-family: Georgia, "Times New Roman", serif; color: #2b2112; }
.toolbar { position: sticky; top: 0; padding: 10px; background: #222; color: #fff; font: 14px system-ui, sans-serif;
  display: flex; gap: 12px; align-items: center; z-index: 2; }
.toolbar button { font: inherit; font-weight: 700; padding: 6px 14px; border-radius: 6px; border: 0; cursor: pointer; }
.page { width: 297mm; height: 210mm; margin: 10mm auto; background: #fffdf6; position: relative; overflow: hidden;
  page-break-after: always; break-after: page; box-shadow: 0 2mm 6mm #0004; }
.frame { position: absolute; inset: 9mm; border: 2.2mm double #b8860b; border-radius: 3mm; }
.frame::after { content: ""; position: absolute; inset: 3mm; border: 0.4mm solid #d9b45a; border-radius: 2mm; }
.content { position: absolute; inset: 20mm 26mm; display: flex; flex-direction: column; align-items: center; text-align: center; }
.title { font-size: 26mm; letter-spacing: 3mm; color: #9a6b00; text-transform: uppercase; margin: 2mm 0 0; line-height: 1; }
.intro { font-size: 7mm; font-style: italic; margin: 5mm 0 3mm; }
.who { display: flex; align-items: center; gap: 10mm; }
.photo { width: 42mm; height: 42mm; border-radius: 50%; object-fit: cover; object-position: center 30%;
  border: 1.4mm solid #b8860b; display: flex; align-items: center; justify-content: center; font-size: 16mm;
  background: #efe4c4; color: #9a6b00; font-weight: 700; }
.name { font-size: 18mm; font-weight: 700; }
.mention { font-size: 10mm; color: #7a4f00; margin-top: 6mm; padding: 2mm 10mm; border-top: 0.5mm solid #d9b45a;
  border-bottom: 0.5mm solid #d9b45a; }
.footer { margin-top: auto; width: 100%; display: flex; justify-content: space-between; align-items: flex-end; font-size: 5mm; }
.signs { display: flex; gap: 18mm; }
.sign { width: 55mm; border-top: 0.4mm solid #2b2112; padding-top: 2mm; font-size: 4.5mm; }
@media print {
  html, body { background: none; }
  .toolbar { display: none; }
  .page { margin: 0; box-shadow: none; }
}
`;

/**
 * @returns {{ status: number, html: string }}
 */
function renderDiplomas(show, cueId) {
  const cues = show.cues.filter((c) => c.type === 'awards');
  const cue = cueId ? cues.find((c) => c.id === cueId) : cues[0];
  if (!cue) {
    return {
      status: 404,
      html: '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif">El guió no té cap cue de tipus ' +
        '<b>mencions</b>' + (cueId ? ' amb id «' + esc(cueId) + '»' : '') + '.</p>',
    };
  }
  const d = cue.diploma;
  const footer = d.footer != null ? d.footer : show.title;
  const pages = cue.people.map((id) => {
    const p = show.participants.find((x) => x.id === id);
    const photo = mediaUrl(p.photo || p.avatar);
    return '<section class="page"><div class="frame"></div><div class="content">' +
      '<h1 class="title">' + esc(d.title) + '</h1>' +
      '<div class="intro">' + esc(d.intro) + '</div>' +
      '<div class="who">' + (photo ? '<img class="photo" src="' + esc(photo) + '" alt="">'
        : '<div class="photo">' + esc(initials(p.name)) + '</div>') +
      '<div class="name">' + esc(p.name) + '</div></div>' +
      (cue.mentionFor[id] ? '<div class="mention">' + esc(cue.mentionFor[id]) + '</div>' : '') +
      '<div class="footer"><div>' + esc(footer) + (d.date ? '<br>' + esc(d.date) : '') + '</div>' +
      '<div class="signs">' + d.signatures.map((s) => '<div class="sign">' + esc(s) + '</div>').join('') + '</div></div>' +
      '</div></section>';
  });
  const script = `
<script>
  // "ready" quan totes les fotos s'han carregat (o han fallat): l'app espera això per fer el PDF.
  const imgs = Array.from(document.images);
  Promise.all(imgs.map((i) => i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; })))
    .then(() => { document.title = 'ready'; });
  document.getElementById('print').onclick = () => window.print();
</script>`;
  const html = '<!doctype html><html lang="ca"><head><meta charset="utf-8"><title>Diplomes</title><style>' + STYLE +
    '</style></head><body><div class="toolbar"><button id="print">🖨 Imprimir / Desar com a PDF</button>' +
    '<span>' + cue.people.length + ' diplomes · ' + esc(cue.title || cue.id) + ' · A4 apaïsat</span></div>' +
    pages.join('') + script + '</body></html>';
  return { status: 200, html };
}

module.exports = { renderDiplomas };
