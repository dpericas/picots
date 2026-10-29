'use strict';
// Arrenca només el servidor (sense Electron) per desenvolupar des del navegador.
// Ús: node scripts/dev-server.js [--show=carpeta] [--data=carpeta] [--port=8080]
// Després obre http://localhost:8080/control i http://localhost:8080/screen

const path = require('path');
const { makeLogger } = require('../src/common/log');
const { startServer } = require('../src/server/server');

const log = makeLogger('dev');

function arg(name) {
  const prefix = '--' + name + '=';
  const a = process.argv.find((x) => x.startsWith(prefix));
  return a ? a.slice(prefix.length) : null;
}

async function main() {
  const showDir = path.resolve(arg('show') || path.join(__dirname, '..', 'show'));
  const dataDir = path.resolve(arg('data') || path.join(path.dirname(showDir), 'dades'));
  const server = await startServer({ showDir, dataDir, port: arg('port') ? Number(arg('port')) : undefined });
  log.info('Panell:    ' + server.localUrl + '/control');
  log.info('Projector: ' + server.localUrl + '/screen');
  log.info('Mòbils:    ' + server.joinUrl());
  const stop = () => {
    log.info('Aturant...');
    server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  log.error(err.stack);
  process.exit(1);
});
