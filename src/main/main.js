'use strict';
// Procés principal d'Electron: arrenca el servidor local i obre
// el panell de control (pantalla del portàtil) i el projector (segona pantalla).

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, dialog, powerSaveBlocker, screen, shell } = require('electron');

const { makeLogger, setLogFile, timestamp } = require('../common/log');
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

// Diplomes: es carrega la pàgina /diplomes en una finestra oculta i es desa en PDF.
async function exportDiplomas() {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    const ready = new Promise((resolve) => {
      const check = () => (win.getTitle() === 'ready' ? resolve() : setTimeout(check, 100));
      win.webContents.once('did-finish-load', check);
    });
    await win.loadURL(server.localUrl + '/diplomes');
    await Promise.race([ready, new Promise((r) => setTimeout(r, 10000))]);
    const pdf = await win.webContents.printToPDF({
      landscape: true, pageSize: 'A4', printBackground: true, margins: { marginType: 'none' }, preferCSSPageSize: true,
    });
    const r = await dialog.showSaveDialog(controlWin, {
      title: 'Desar els diplomes',
      defaultPath: path.join(server.dataDir, 'diplomes.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return;
    fs.writeFileSync(r.filePath, pdf);
    log.info('Diplomes desats a ' + r.filePath);
    shell.openPath(r.filePath);
  } catch (err) {
    log.error('No s\'han pogut exportar els diplomes: ' + err.message);
    dialog.showErrorBox('Diplomes', 'No s\'han pogut exportar els diplomes:\n\n' + err.message);
  } finally {
    win.destroy();
  }
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
        { label: 'Obrir carpeta de l\'espectacle', click: () => shell.openPath(server.showDir) },
        { label: 'Obrir carpeta de dades i registres', click: () => shell.openPath(server.dataDir) },
        { label: 'Exportar diplomes a PDF…', click: exportDiplomas },
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
