'use strict';
// Procés principal d'Electron: arrenca el servidor local i obre
// el panell de control (pantalla del portàtil) i el projector (segona pantalla).

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, dialog, powerSaveBlocker, screen, session, shell } = require('electron');

const { makeLogger, setLogFile, closeLogFile, timestamp } = require('../common/log');
const { wipeTargets, performWipe } = require('../tools/wipe');
const { startServer } = require('../server/server');

const log = makeLogger('app');

// El projector ha de poder reproduir vídeo amb so sense cap clic previ.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let server = null;
let controlWin = null;
let screenWin = null;
// Pantalla triada per al projector: { id, label } o null (automàtic: la primera externa).
// Es desa a dades/pantalla.json. L'id pot canviar en reconnectar el projector, i
// llavors es busca pel nom.
let chosenDisplay = null;
let displayFile = null;
let identifyWins = [];
let quitting = false;
const IDENTIFY_MS = 4000;

function argValue(name) {
  const prefix = '--' + name + '=';
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

// Empaquetat: la carpeta "show" va al costat del .exe (versió portable en ZIP).
function resolveShowDir() {
  const fromArg = argValue('show') || process.env.GALA_SHOW_DIR;
  if (fromArg) return path.resolve(fromArg);
  if (app.isPackaged) return path.join(path.dirname(process.execPath), 'show');
  return path.join(__dirname, '..', '..', 'show');
}

function loadChosenDisplay() {
  try {
    const d = JSON.parse(fs.readFileSync(displayFile, 'utf8'));
    chosenDisplay = d && d.id != null ? { id: d.id, label: d.label || '' } : null;
  } catch (err) {
    chosenDisplay = null;
  }
}

function saveChosenDisplay() {
  try {
    if (chosenDisplay) fs.writeFileSync(displayFile, JSON.stringify(chosenDisplay));
    else if (fs.existsSync(displayFile)) fs.unlinkSync(displayFile);
  } catch (err) {
    log.warn('No es pot desar la pantalla triada: ' + err.message);
  }
}

function displayName(d, i) {
  const primary = screen.getPrimaryDisplay();
  return (i + 1) + ' · ' + (d.label || 'Pantalla') + ' (' + d.size.width + 'x' + d.size.height + ')' +
    (d.id === primary.id ? ' – principal' : '');
}

function targetDisplay() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  if (chosenDisplay) {
    const found = displays.find((d) => d.id === chosenDisplay.id) ||
      (chosenDisplay.label && displays.find((d) => d.label === chosenDisplay.label));
    if (found) return found;
    log.warn('La pantalla triada (' + (chosenDisplay.label || chosenDisplay.id) + ') no hi és: es fa servir l\'automàtica.');
  }
  return displays.find((d) => d.id !== primary.id) || null;
}

function chooseDisplay(display) {
  chosenDisplay = display ? { id: display.id, label: display.label || '' } : null;
  saveChosenDisplay();
  placeScreenWindow();
  buildMenu();
}

// Mostra un número gran a cada pantalla (el mateix que al menú) durant uns segons.
function identifyDisplays() {
  identifyWins.forEach((w) => { if (!w.isDestroyed()) w.close(); });
  identifyWins = [];
  const target = targetDisplay();
  screen.getAllDisplays().forEach((d, i) => {
    const isProjector = !!target && target.id === d.id;
    const html = '<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:flex;' +
      'flex-direction:column;align-items:center;justify-content:center;font-family:Segoe UI,sans-serif;' +
      'background:rgba(10,12,24,.88);color:#fff;border:12px solid ' + (isProjector ? '#1fa463' : '#ffcc33') + '">' +
      '<div style="font-size:34vh;font-weight:900;line-height:1">' + (i + 1) + '</div>' +
      '<div style="font-size:4vh;font-weight:700">' + escapeHtml(displayName(d, i).replace(/^\d+ · /, '')) + '</div>' +
      '<div style="font-size:3.4vh;margin-top:2vh;color:' + (isProjector ? '#7CFC9A' : '#ccd') + '">' +
      (isProjector ? '▶ Aquí hi ha el projector' : 'Projector › Pantalla del projector › ' + (i + 1)) + '</div></body>';
    const w = new BrowserWindow({
      x: d.bounds.x + Math.round(d.bounds.width * 0.2),
      y: d.bounds.y + Math.round(d.bounds.height * 0.2),
      width: Math.round(d.bounds.width * 0.6),
      height: Math.round(d.bounds.height * 0.6),
      frame: false, transparent: true, alwaysOnTop: true, focusable: false, skipTaskbar: true, show: false,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    w.once('ready-to-show', () => w.showInactive());
    identifyWins.push(w);
  });
  setTimeout(() => {
    identifyWins.forEach((w) => { if (!w.isDestroyed()) w.close(); });
    identifyWins = [];
  }, IDENTIFY_MS);
}

function escapeHtml(t) {
  return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Pàgines d'impressió (/diplomes, /targetes): es carreguen en una finestra oculta i es desen en PDF.
async function exportPdf(page, fileName, landscape) {
  if (!server) return;
  // Primer es comprova que la pàgina existeix (p. ex. sense cue de mencions no hi ha diplomes).
  const head = await fetch(server.localUrl + page);
  if (!head.ok) {
    dialog.showErrorBox('Exportar PDF', (await head.text()).replace(/<[^>]+>/g, '').trim() || 'La pàgina no està disponible.');
    return;
  }
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  let timer = null;
  try {
    const ready = new Promise((resolve) => {
      const check = () => {
        if (win.isDestroyed()) return;
        if (win.getTitle() === 'ready') resolve();
        else timer = setTimeout(check, 100);
      };
      win.webContents.once('did-finish-load', check);
    });
    await win.loadURL(server.localUrl + page);
    await Promise.race([ready, new Promise((r) => setTimeout(r, 10000))]);
    clearTimeout(timer);
    const pdf = await win.webContents.printToPDF({
      landscape, pageSize: 'A4', printBackground: true, margins: { marginType: 'none' }, preferCSSPageSize: true,
    });
    const r = await dialog.showSaveDialog(controlWin, {
      title: 'Desar el PDF',
      defaultPath: path.join(server.dataDir, fileName),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return;
    fs.writeFileSync(r.filePath, pdf);
    log.info('PDF desat a ' + r.filePath);
    shell.openPath(r.filePath);
  } catch (err) {
    log.error('No s\'ha pogut exportar ' + page + ': ' + err.message);
    dialog.showErrorBox('Exportar PDF', 'No s\'ha pogut crear el PDF:\n\n' + err.message);
  } finally {
    clearTimeout(timer);
    win.destroy();
  }
}

// Resum de la gala (HTML autònom). Retorna true si s'ha desat.
async function saveSummary() {
  if (!server) return false;
  const r = await dialog.showSaveDialog(controlWin, {
    title: 'Desar el resum de la gala',
    defaultPath: path.join(app.getPath('documents'), 'resum-gala-' + timestamp().slice(0, 10) + '.html'),
    filters: [{ name: 'Pàgina web', extensions: ['html'] }],
  });
  if (r.canceled || !r.filePath) return false;
  const res = await fetch(server.localUrl + '/resum');
  fs.writeFileSync(r.filePath, await res.text());
  log.info('Resum desat a ' + r.filePath);
  return true;
}

// Privacitat: després de la gala, esborra les dades (i, si es vol, fotos, vídeos i guió).
async function wipeAfterGala() {
  if (!server) return;
  const level = dialog.showMessageBoxSync(controlWin, {
    type: 'warning',
    title: 'Esborrar dades després de la gala',
    message: 'Què vols esborrar?',
    detail: 'Dades de la sessió: diaris de la gala i dels assajos, registres, dibuixos i missatges del mur, ' +
      'i la clau dels QR personals.\n\nTot: a més, la carpeta de l\'espectacle (guió, fotos i vídeos dels nens), ' +
      'les fonts dels vídeos d\'entrada i el vídeo de reserva.\n\nNo es pot desfer.',
    buttons: ['Cancel·lar', 'Només les dades de la sessió', 'Tot'],
    defaultId: 0,
    cancelId: 0,
  });
  if (level === 0) return;
  const plan = wipeTargets({ dataDir: server.dataDir, showDir: server.showDir, level: level === 2 ? 'tot' : 'dades' });
  if (plan.targets.length === 0) {
    dialog.showMessageBoxSync(controlWin, { type: 'info', message: 'No hi ha res per esborrar.', detail: plan.refused.join('\n') });
    return;
  }
  const keep = dialog.showMessageBoxSync(controlWin, {
    type: 'question', title: 'Resum', message: 'Vols desar abans el resum de la gala?',
    detail: 'Una pàgina amb els resultats, el camí seguit i els missatges del mur (amb els noms dels nens).',
    buttons: ['Sí, desar el resum', 'No'], defaultId: 0, cancelId: 1,
  });
  if (keep === 0 && !(await saveSummary())) return;
  const confirm = await dialog.showMessageBox(controlWin, {
    type: 'warning', title: 'Confirmació',
    message: 'S\'esborraran definitivament:',
    detail: plan.targets.join('\n') + (plan.refused.length ? '\n\nNo s\'esborrarà (no sembla de l\'app):\n' + plan.refused.join('\n') : '') +
      '\n\nL\'aplicació es tancarà.',
    checkboxLabel: 'Entenc que no es pot desfer',
    buttons: ['Cancel·lar', 'Esborrar'], defaultId: 0, cancelId: 0,
  });
  if (confirm.response !== 1) return;
  if (!confirm.checkboxChecked) {
    dialog.showMessageBoxSync(controlWin, { type: 'info', message: 'No s\'ha esborrat res.', detail: 'Cal marcar «Entenc que no es pot desfer».' });
    return;
  }
  log.warn('Esborrat després de la gala: ' + plan.targets.join(', '));
  quitting = true;
  const s = server;
  server = null;
  // Primer es tanquen les finestres (deixen de demanar fitxers) i el servidor.
  BrowserWindow.getAllWindows().filter((w) => w !== controlWin).forEach((w) => w.destroy());
  await s.close();
  await closeLogFile();
  // La memòria cau del navegador intern també té còpies de fotos i vídeos.
  try {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData();
  } catch (err) {
    // no és greu: es continua amb l'esborrat de les carpetes
  }
  const result = performWipe(plan.targets);
  dialog.showMessageBoxSync({
    type: result.failed.length ? 'error' : 'info',
    title: 'Esborrat',
    message: result.failed.length ? 'No s\'ha pogut esborrar tot.' : 'Esborrat completat.',
    detail: (result.done.length ? 'Esborrat:\n' + result.done.join('\n') : '') +
      (result.failed.length ? '\n\nError:\n' + result.failed.join('\n') : ''),
  });
  app.exit(0);
}

// Per al panell (comprovació prèvia): pantalles connectades i on és el projector.
function displayInfo() {
  const displays = screen.getAllDisplays();
  const target = targetDisplay();
  return {
    displays: displays.map((d, i) => ({ n: i + 1, name: displayName(d, i), projector: !!target && target.id === d.id })),
    projectorExternal: !!target && target.id !== screen.getPrimaryDisplay().id,
    chosen: chosenDisplay ? chosenDisplay.label || String(chosenDisplay.id) : null,
  };
}

function placeScreenWindow() {
  if (!screenWin || screenWin.isDestroyed()) return;
  const display = targetDisplay();
  if (display) {
    screenWin.setFullScreen(false);
    screenWin.setBounds(display.bounds);
    screenWin.setFullScreen(true);
    const i = screen.getAllDisplays().findIndex((d) => d.id === display.id);
    log.info('Projector a la pantalla ' + displayName(display, i) + (chosenDisplay ? ' (triada)' : ' (automàtica)'));
  } else {
    // Sense segona pantalla: finestra normal per poder provar.
    screenWin.setFullScreen(false);
    screenWin.setSize(960, 540);
    log.warn('No hi ha segona pantalla: el projector s\'obre en finestra.');
  }
}

function watchRenderer(win, name) {
  win.webContents.on('render-process-gone', (e, details) => {
    log.error('El procés de ' + name + ' ha caigut (' + details.reason + '). Recarregant...');
    setTimeout(() => { if (!win.isDestroyed()) win.reload(); }, 500);
  });
  win.on('unresponsive', () => {
    log.error(name + ' no respon. Recarregant...');
    if (!win.isDestroyed()) win.webContents.forcefullyCrashRenderer();
  });
}

function createScreenWindow() {
  screenWin = new BrowserWindow({
    title: 'Gala – Projector',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    frame: false,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  screenWin.setMenu(null);
  watchRenderer(screenWin, 'projector');
  screenWin.loadURL(server.localUrl + '/screen');
  screenWin.once('ready-to-show', () => {
    placeScreenWindow();
    screenWin.showInactive();
  });
  screenWin.on('close', (e) => {
    // El projector només es tanca en sortir de l'aplicació.
    if (!quitting) e.preventDefault();
  });
}

function createControlWindow() {
  const primary = screen.getPrimaryDisplay();
  controlWin = new BrowserWindow({
    title: 'Gala Manager – Control',
    width: Math.min(1400, primary.workAreaSize.width),
    height: Math.min(900, primary.workAreaSize.height),
    x: primary.workArea.x,
    y: primary.workArea.y,
    backgroundColor: '#14161c',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  watchRenderer(controlWin, 'panell de control');
  // Editor, diplomes i targetes s'obren en finestres pròpies, grans.
  controlWin.webContents.setWindowOpenHandler(({ url }) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      return { action: 'deny' };
    }
    if (!server || target.origin !== new URL(server.localUrl).origin) {
      // Fora de l'app, només adreces web (mai fitxers ni altres protocols).
      if (target.protocol === 'http:' || target.protocol === 'https:') shell.openExternal(url);
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: Math.min(1400, primary.workAreaSize.width), height: Math.min(900, primary.workAreaSize.height),
        autoHideMenuBar: true, backgroundColor: '#14161c', webPreferences: { contextIsolation: true, sandbox: true },
      },
    };
  });
  controlWin.loadURL(server.localUrl + '/control');
  controlWin.on('close', (e) => {
    if (quitting) return;
    const choice = dialog.showMessageBoxSync(controlWin, {
      type: 'warning',
      buttons: ['Cancel·lar', 'Tancar'],
      defaultId: 0,
      cancelId: 0,
      title: 'Tancar Gala Manager',
      message: 'Segur que vols tancar? El projector i els mòbils es desconnectaran.',
      detail: 'L\'estat es conserva: en tornar a obrir es podrà continuar on era.',
    });
    if (choice !== 1) e.preventDefault();
    else quitting = true;
  });
  controlWin.on('closed', () => app.quit());
}

function buildMenu() {
  const template = [
    {
      label: 'Gala',
      submenu: [
        { label: 'Obrir carpeta de l\'espectacle', click: () => server && shell.openPath(server.showDir) },
        { label: 'Obrir carpeta de dades i registres', click: () => server && shell.openPath(server.dataDir) },
        { label: 'Exportar targetes QR a PDF…', click: () => exportPdf('/targetes', 'targetes-qr.pdf', false) },
        { label: 'Exportar diplomes a PDF…', click: () => exportPdf('/diplomes', 'diplomes.pdf', true) },
        { label: 'Exportar guió del presentador a PDF…', click: () => exportPdf('/guio', 'guio-presentador.pdf', false) },
        { type: 'separator' },
        { label: 'Desar resum de la gala…', click: () => saveSummary() },
        { label: 'Esborrar dades després de la gala…', click: wipeAfterGala },
        { type: 'separator' },
        { role: 'quit', label: 'Sortir' },
      ],
    },
    {
      label: 'Projector',
      submenu: [
        {
          label: 'Pantalla del projector',
          submenu: [
            {
              label: 'Automàtica (la primera pantalla externa)',
              type: 'radio',
              checked: !chosenDisplay,
              click: () => chooseDisplay(null),
            },
            { type: 'separator' },
          ].concat(screen.getAllDisplays().map((d, i) => ({
            label: displayName(d, i),
            type: 'radio',
            checked: !!chosenDisplay && targetDisplay() && targetDisplay().id === d.id,
            click: () => chooseDisplay(d),
          }))),
        },
        {
          label: 'Identificar pantalles',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: identifyDisplays,
        },
        {
          label: 'Moure a la pantalla següent',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => {
            const displays = screen.getAllDisplays();
            const current = screenWin ? screen.getDisplayMatching(screenWin.getBounds()) : null;
            const i = current ? displays.findIndex((d) => d.id === current.id) : -1;
            chooseDisplay(displays[(i + 1) % displays.length]);
          },
        },
        {
          label: 'Pantalla completa sí/no',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => screenWin && screenWin.setFullScreen(!screenWin.isFullScreen()),
        },
        {
          label: 'Recarregar projector',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => screenWin && screenWin.reload(),
        },
        {
          label: 'Mostrar/amagar finestra del projector',
          click: () => {
            if (!screenWin) return;
            if (screenWin.isVisible()) screenWin.hide();
            else screenWin.showInactive();
          },
        },
      ],
    },
    {
      label: 'Vista',
      submenu: [
        { role: 'reload', label: 'Recarregar panell' },
        { role: 'toggleDevTools', label: 'Eines de desenvolupament', accelerator: 'F12' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (controlWin) {
      if (controlWin.isMinimized()) controlWin.restore();
      controlWin.focus();
    }
  });

  process.on('uncaughtException', (err) => log.error('Excepció no controlada: ' + err.stack));
  process.on('unhandledRejection', (err) => log.error('Promesa rebutjada: ' + (err && err.stack)));

  app.whenReady().then(async () => {
    const showDir = resolveShowDir();
    const dataDir = argValue('data') || path.join(path.dirname(showDir), 'dades');
    fs.mkdirSync(dataDir, { recursive: true });
    displayFile = path.join(dataDir, 'pantalla.json');
    loadChosenDisplay();
    setLogFile(path.join(dataDir, 'registres', 'gala-' + timestamp().slice(0, 10) + '.log'));
    log.info('Iniciant Gala Manager. Guió: ' + showDir + ' | Dades: ' + dataDir);
    try {
      server = await startServer({ showDir, dataDir, systemInfo: () => displayInfo() });
    } catch (err) {
      log.error('No s\'ha pogut arrencar el servidor: ' + err.stack);
      dialog.showErrorBox('Gala Manager', 'No s\'ha pogut arrencar el servidor:\n\n' + err.message +
        '\n\nComprova show.yaml i que el port no estigui ocupat.');
      app.exit(1);
      return;
    }
    powerSaveBlocker.start('prevent-display-sleep');
    buildMenu();
    createControlWindow();
    createScreenWindow();
    const displaysChanged = () => {
      placeScreenWindow();
      buildMenu();
    };
    screen.on('display-added', displaysChanged);
    screen.on('display-removed', displaysChanged);
    screen.on('display-metrics-changed', buildMenu);
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', (e) => {
    if (server) {
      e.preventDefault();
      const s = server;
      server = null;
      s.close().finally(() => app.quit());
    }
  });
}
