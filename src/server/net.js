'use strict';
// Tria l'adreça IP de la xarxa local que es posarà als codis QR.

const os = require('os');

function rank(addr) {
  if (addr.startsWith('192.168.')) return 0;
  if (addr.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return 2;
  return 3;
}

function pickLanAddress(interfaces) {
  const found = [];
  const ifaces = interfaces || os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      const v4 = info.family === 'IPv4' || info.family === 4;
      if (v4 && !info.internal && !info.address.startsWith('169.254.')) found.push(info.address);
    }
  }
  found.sort((a, b) => rank(a) - rank(b));
  return found[0] || '127.0.0.1';
}

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

module.exports = { pickLanAddress, isLoopback };
