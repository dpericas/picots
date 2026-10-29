'use strict';
// Logger amb marca de temps [YYYY-MM-DD HH:mm:ss.SSS] a cada línia.
// Escriu a consola i, opcionalment, a un fitxer (setLogFile).

const fs = require('fs');
const path = require('path');
const util = require('util');

let fileStream = null;

function pad(n, width) {
  return String(n).padStart(width || 2, '0');
}

function timestamp(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' +
    pad(d.getMilliseconds(), 3);
}

function setLogFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fileStream) fileStream.end();
  fileStream = fs.createWriteStream(file, { flags: 'a' });
}

function format(args) {
  return args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 4 }))).join(' ');
}

function makeLogger(scope) {
  function write(stream, level, args) {
    const line = '[' + timestamp() + '] ' + level + ' [' + scope + '] ' + format(args) + '\n';
    stream.write(line);
    if (fileStream) fileStream.write(line);
  }
  return {
    info: (...args) => write(process.stdout, 'INFO ', args),
    warn: (...args) => write(process.stderr, 'WARN ', args),
    error: (...args) => write(process.stderr, 'ERROR', args),
  };
}

module.exports = { makeLogger, setLogFile, timestamp };
