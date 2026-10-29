'use strict';
// Diari d'events en format JSONL. Cada event es desa (amb fsync) abans d'aplicar-se,
// de manera que l'estat es pot reconstruir després d'una caiguda.

const fs = require('fs');
const path = require('path');

class FileJournal {
  constructor(file, log) {
    this.file = file;
    this.log = log;
    this.fd = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  readAll() {
    if (!fs.existsSync(this.file)) return [];
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const events = [];
    lines.forEach((line, i) => {
      try {
        events.push(JSON.parse(line));
      } catch (err) {
        // Una línia final truncada és normal després d'un tall de corrent.
        if (this.log) this.log.warn('Línia ' + (i + 1) + ' del diari il·legible, s\'ignora.');
      }
    });
    return events;
  }

  append(event) {
    if (this.fd === null) this.fd = fs.openSync(this.file, 'a');
    fs.writeSync(this.fd, JSON.stringify(event) + '\n');
    fs.fsyncSync(this.fd);
  }

  // Tanca la sessió actual movent el diari a un fitxer amb data.
  archive(stamp) {
    this.close();
    if (!fs.existsSync(this.file)) return null;
    const target = this.file.replace(/\.jsonl$/, '') + '-' + stamp + '.jsonl';
    fs.renameSync(this.file, target);
    return target;
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

class MemoryJournal {
  constructor(events) {
    this.events = events ? events.slice() : [];
  }
  readAll() { return this.events.slice(); }
  append(event) { this.events.push(event); }
  archive() { this.events = []; return null; }
  close() {}
}

module.exports = { FileJournal, MemoryJournal };
