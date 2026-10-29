'use strict';
// Procés principal d'Electron: arrenca el servidor local i obre
// el panell de control (pantalla del portàtil) i el projector (segona pantalla).

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
let screenDisplayIndex = null; // null = automàtic (la primera pantalla externa)
let quitting = false;

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

function targetDisplay() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  if (screenDisplayIndex !== null) return displays[screenDisplayIndex % displays.length];
  return displays.find((d) => d.id !== primary.id) || null;
}

function placeScreenWindow() {
  if (!screenWin || screenWin.isDestroyed()) return;
  const display = targetDisplay();
  if (display) {
    screenWin.setFullScreen(false);
    screenWin.setBounds(display.bounds);
    screenWin.setFullScreen(true);
    log.info('Projector a la pantalla ' + display.id + ' (' + display.bounds.width + 'x' + display.bounds.height + ')');
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
        { type: 'separator' },
        { role: 'quit', label: 'Sortir' },
      ],
    },
    {
      label: 'Projector',
      submenu: [
        {
          label: 'Moure a la pantalla següent',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => {
            const n = screen.getAllDisplays().length;
            const current = screenDisplayIndex === null ? 0 : screenDisplayIndex;
            screenDisplayIndex = (current + 1) % n;
            placeScreenWindow();
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
        { role: 'toggleDevTools', label: 'Eines de desenvolupament' },
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
    setLogFile(path.join(dataDir, 'registres', 'gala-' + timestamp().slice(0, 10) + '.log'));
    log.info('Iniciant Gala Manager. Guió: ' + showDir + ' | Dades: ' + dataDir);
    try {
      server = await startServer({ showDir, dataDir });
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
    screen.on('display-added', placeScreenWindow);
    screen.on('display-removed', placeScreenWindow);
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
