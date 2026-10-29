'use strict';
// Detecta talls en negre entre cues: captura el projector en bucle (~60 per segon)
// mentre es fan canvis de cue, i compta les captures negres. Els vídeos de prova
// tenen fons de color, així que qualsevol negre és un tall. Sense so.
// Ús: npx electron scripts/check-transitions.js --scenario=auto|jump|layers|parade [--out=carpeta]
// Amb --out, desa captures PNG en moments clau.
// (cal `npm run sample-media` abans). Surt amb codi 1 si troba negres.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const rootArg = process.argv.find((a) => a.startsWith('--root='));
const root = rootArg ? rootArg.slice(7) : path.join(__dirname, '..');
const scenarioArg = process.argv.find((a) => a.startsWith('--scenario='));
const scenario = scenarioArg ? scenarioArg.slice(11) : 'jump';
const outArg = process.argv.find((a) => a.startsWith('--out='));
const outDir = outArg ? outArg.slice(6) : null;
const { startServer } = require(path.join(root, 'src/server/server'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const quiet = { info() {}, warn() {}, error() {} };

app.whenReady().then(async () => {
  const dataDir = path.join(os.tmpdir(), 'gala-transicions-' + scenario);
  require('fs').rmSync(dataDir, { recursive: true, force: true });
  const srv = await startServer({ showDir: path.join(root, 'show'), dataDir, port: 0, host: '127.0.0.1', log: quiet });
  const win = new BrowserWindow({ width: 640, height: 360, show: true, useContentSize: true });
  win.webContents.setAudioMuted(true);
  await win.loadURL(srv.localUrl + '/screen');
  const e = srv.engine;
  const events = [];
  e.on('change', (ev) => ev && ev.type === 'cue.enter' && events.push({ t: Date.now(), cue: ev.cueId }));
  const samples = [];
  let sampling = true;
  (async function loop() {
    while (sampling) {
      const img = await win.webContents.capturePage();
      const bmp = img.toBitmap();
      let sum = 0; let n = 0;
      for (let i = 0; i < bmp.length; i += 4 * 97) { sum += bmp[i] + bmp[i + 1] + bmp[i + 2]; n++; }
      const avg = [0, 1, 2].map((c) => { let a = 0; let k = 0; for (let i = c; i < bmp.length; i += 4 * 97) { a += bmp[i]; k++; } return Math.round(a / k); });
      samples.push({ t: Date.now(), lum: n ? sum / n / 3 : 0, rgb: avg });
    }
  })();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const snap = async (name) => {
    if (!outDir) return;
    const img = await win.webContents.capturePage();
    require('fs').mkdirSync(outDir, { recursive: true });
    require('fs').writeFileSync(path.join(outDir, scenario + '-' + name + '.png'), img.toPNG());
  };
  await wait(800);
  if (scenario === 'auto') {
    e.dispatch({ name: 'jump', cueId: 'cap2a' });   // 8 s, auto -> cap3 (fos 0.8)
    await wait(10500);
  } else if (scenario === 'layers') {
    e.dispatch({ name: 'jump', cueId: 'benvinguda' });
    await wait(1500);
    e.dispatch({ name: 'jump', cueId: 'final' });    // espera -> vídeo no precarregat
    await wait(1500);
    e.dispatch({ name: 'jump', cueId: 'records' });  // vídeo -> fotos
    await wait(2500);
    e.dispatch({ name: 'jump', cueId: 'cap2b' });    // fotos -> vídeo no precarregat
    await wait(1500);
  } else if (scenario === 'parade') {
    // Entrada amb vídeos (Anna, Biel, Carla i Dani en tenen; Emma i Ferran no).
    e.dispatch({ name: 'jump', cueId: 'entrada' });
    await wait(1200);
    e.dispatch({ name: 'go' });                      // Anna: vídeo de 5 s
    await wait(2500); await snap('1-anna-video');
    await wait(3500); await snap('2-anna-targeta');  // el vídeo ja ha acabat
    e.dispatch({ name: 'go' });                      // Biel: vídeo, confeti a l'inici
    await wait(1500); await snap('3-biel-video');
    e.dispatch({ name: 'go' });                      // Carla: vídeo
    await wait(2000);
    e.dispatch({ name: 'go' });                      // Dani: vídeo, interromp el de la Carla
    await wait(1500); await snap('4-dani-video');
    e.dispatch({ name: 'back' });                    // torna a la Carla (vídeo des de l'inici)
    await wait(1500);
    e.dispatch({ name: 'step', step: 5 });           // Emma: sense vídeo, targeta directa
    await wait(1500); await snap('5-emma-sense-video');
    e.dispatch({ name: 'step', step: 7 });           // mosaic
    await wait(2000); await snap('6-mosaic');
  } else if (scenario === 'jump') {
    e.dispatch({ name: 'jump', cueId: 'cap2a' });
    await wait(2500);
    e.dispatch({ name: 'jump', cueId: 'final' });   // no precarregat
    await wait(2500);
    e.dispatch({ name: 'back' });                   // torna a cap2a
    await wait(2500);
  }
  sampling = false;
  await wait(200);
  const firstVideo = events[0] ? events[0].t : 0;
  const after = samples.filter((s) => s.t > firstVideo + (scenario === 'layers' || scenario === 'parade' ? 300 : 600));
  const black = after.filter((s) => s.lum < 3);
  const gaps = after.slice(1).map((s, i) => s.t - after[i].t);
  console.log(JSON.stringify({
    scenario,
    events: events.map((x) => ({ cue: x.cue, at: x.t - firstVideo })),
    samples: after.length,
    medianIntervalMs: gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)],
    blackFrames: black.map((s) => ({ at: s.t - firstVideo, lum: Math.round(s.lum) })),
    minLum: Math.round(Math.min.apply(null, after.map((s) => s.lum))),
    timeline: events.map((ev) => ({ cue: ev.cue, at: ev.t - firstVideo,
      rgbAround: samples.filter((s) => s.t - ev.t > -40 && s.t - ev.t < 120).map((s) => [s.t - ev.t, s.rgb.join('/')]) })),
  }));
  await srv.close();
  app.exit(black.length ? 1 : 0);
});
