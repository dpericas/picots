'use strict';
// Targetes per retallar amb el QR personal de cada nen (8 per full A4) i
// targetes de reserva amb el QR genèric. Escanejar-la identifica el nen directament.

const QRCode = require('qrcode');
const { mediaUrl } = require('../engine/show');

const PER_PAGE = 8;
const GENERIC_CARDS = 2;

function esc(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
  }[c]));
}

function initials(name) {
  return name.split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase();
}

const STYLE = `
@page { size: A4 portrait; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #ddd; font-family: "Segoe UI", system-ui, sans-serif; color: #1b1f3a; }
.toolbar { position: sticky; top: 0; padding: 10px; background: #222; color: #fff; font-size: 14px; z-index: 2; }
.toolbar button { font: inherit; font-weight: 700; padding: 6px 14px; border-radius: 6px; border: 0; cursor: pointer; margin-right: 10px; }
.toolbar .warn { display: block; margin-top: 6px; color: #ffcc66; }
.page { width: 210mm; height: 297mm; margin: 10mm auto; background: #fff; padding: 12mm 10mm;
  display: grid; grid-template-columns: repeat(2, 1fr); grid-template-rows: repeat(4, 1fr);
  page-break-after: always; break-after: page; box-shadow: 0 2mm 6mm #0004; }
.card { border: 0.3mm dashed #999; padding: 5mm; display: flex; gap: 4mm; align-items: center; position: relative; overflow: hidden; }
.card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2.5mm; background: #ffcc33; }
.side { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 2mm; }
.photo { width: 24mm; height: 24mm; border-radius: 50%; object-fit: cover; object-position: center 30%;
  border: 0.8mm solid #ffcc33; display: flex; align-items: center; justify-content: center; font-size: 10mm;
  font-weight: 800; background: #2e3563; color: #fff; }
.name { font-size: 7mm; font-weight: 800; line-height: 1.05; overflow-wrap: anywhere; }
.how { font-size: 3mm; color: #555; }
.qr { width: 42mm; height: 42mm; flex: none; }
.qr svg { width: 100%; height: 100%; display: block; }
.gala { font-size: 2.8mm; color: #888; }
.generic .name { font-size: 5.5mm; }
@media print {
  html, body { background: none; }
  .toolbar { display: none; }
  .page { margin: 0; box-shadow: none; }
}
`;

async function qrSvg(text) {
  return QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
}

/**
 * @param {object} opts
 * @param {object} opts.show
 * @param {function} opts.personalUrl  id -> URL amb la clau
 * @param {string} opts.joinUrl
 * @param {boolean} opts.fixedHost     xarxa.ip_publica definida al guió
 */
async function renderCards(opts) {
  const { show, personalUrl, joinUrl, fixedHost } = opts;
  const cards = [];
  for (const p of show.participants) {
    const photo = mediaUrl(p.photo || p.avatar);
    cards.push('<div class="card"><div class="side">' +
      (photo ? '<img class="photo" src="' + esc(photo) + '" alt="">' : '<div class="photo">' + esc(initials(p.name)) + '</div>') +
      '<div class="name">' + esc(p.name) + '</div>' +
      '<div class="how">Escaneja\'m amb la càmera del mòbil o la tauleta</div>' +
      '<div class="gala">' + esc(show.title) + '</div></div>' +
      '<div class="qr">' + (await qrSvg(personalUrl(p.id))) + '</div></div>');
  }
  const generic = await qrSvg(joinUrl);
  for (let i = 0; i < GENERIC_CARDS; i++) {
    cards.push('<div class="card generic"><div class="side"><div class="photo">?</div>' +
      '<div class="name">QR de reserva</div>' +
      '<div class="how">Escaneja\'l i tria el teu nom</div>' +
      '<div class="gala">' + esc(show.title) + '</div></div>' +
      '<div class="qr">' + generic + '</div></div>');
  }
  const pages = [];
  for (let i = 0; i < cards.length; i += PER_PAGE) {
    pages.push('<section class="page">' + cards.slice(i, i + PER_PAGE).join('') + '</section>');
  }
  const warn = fixedHost ? ''
    : '<span class="warn">⚠ Aquests QR porten l\'adreça ' + esc(joinUrl.replace(/\/play$/, '')) +
      '. Si a la sala el portàtil té una altra IP, no funcionaran: reserva una IP fixa al router i posa-la a ' +
      'xarxa.ip_publica del show.yaml abans d\'imprimir-los.</span>';
  const script = `
<script>
  const imgs = Array.from(document.images);
  Promise.all(imgs.map((i) => i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; })))
    .then(() => { document.title = 'ready'; });
  document.getElementById('print').onclick = () => window.print();
</script>`;
  return '<!doctype html><html lang="ca"><head><meta charset="utf-8"><title>Targetes QR</title><style>' + STYLE +
    '</style></head><body><div class="toolbar"><button id="print">🖨 Imprimir / Desar com a PDF</button>' +
    show.participants.length + ' targetes personals + ' + GENERIC_CARDS + ' de reserva · A4, retallar per la línia' +
    warn + '</div>' + pages.join('') + script + '</body></html>';
}

module.exports = { renderCards };
