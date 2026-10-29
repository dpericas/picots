'use strict';
// Client WebSocket comú: reconnexió automàtica, ordres amb confirmació
// i correcció del rellotge respecte del servidor.

(function () {
  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* mode privat */ }
  }

  function deviceId() {
    let id = storageGet('gala.device');
    if (!id) {
      id = 'd-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      storageSet('gala.device', id);
    }
    return id;
  }

  function GalaSocket(role, opts) {
    this.role = role;
    this.opts = opts || {};
    this.ws = null;
    this.pending = {};
    this.nextId = 1;
    this.delay = 500;
    this.clockOffset = 0;
    this.connected = false;
    this.connect();
  }

  GalaSocket.prototype.connect = function () {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({ role: this.role });
    if (this.opts.device) params.set('device', this.opts.device);
    if (this.opts.pin) params.set('pin', this.opts.pin);
    const ws = new WebSocket(proto + '//' + location.host + '/ws?' + params.toString());
    this.ws = ws;
    ws.onopen = () => {
      this.delay = 500;
      this.setConnected(true);
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (msg.type === 'state') {
        if (msg.state && msg.state.serverNow) this.clockOffset = msg.state.serverNow - Date.now();
        if (this.opts.onState) this.opts.onState(msg.state);
      } else if (msg.type === 'ack' && this.pending[msg.id]) {
        const p = this.pending[msg.id];
        delete this.pending[msg.id];
        clearTimeout(p.timer);
        p.resolve(msg);
      } else if (this.opts.onMessage) {
        this.opts.onMessage(msg);
      }
    };
    ws.onclose = (e) => {
      this.setConnected(false);
      Object.keys(this.pending).forEach((id) => {
        clearTimeout(this.pending[id].timer);
        this.pending[id].resolve({ ok: false, error: 'Sense connexió' });
      });
      this.pending = {};
      // onClose pot aturar la reconnexió (p. ex. PIN incorrecte) retornant false.
      if (this.opts.onClose && this.opts.onClose(e.code) === false) return;
      setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 5000);
    };
  };

  GalaSocket.prototype.setConnected = function (v) {
    this.connected = v;
    if (this.opts.onConnection) this.opts.onConnection(v);
  };

  // Envia una ordre; retorna una promesa amb {ok, error}.
  GalaSocket.prototype.cmd = function (cmd) {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== 1) return resolve({ ok: false, error: 'Sense connexió' });
      const id = this.nextId++;
      const timer = setTimeout(() => {
        delete this.pending[id];
        resolve({ ok: false, error: 'Sense resposta' });
      }, 5000);
      this.pending[id] = { resolve, timer };
      this.ws.send(JSON.stringify({ type: 'cmd', id, cmd }));
    });
  };

  // Ordre sense esperar resposta (p. ex. la posició del vídeo).
  GalaSocket.prototype.notify = function (cmd) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'cmd', cmd }));
  };

  GalaSocket.prototype.serverNow = function () {
    return Date.now() + this.clockOffset;
  };

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] != null && attrs[k] !== false) node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach((c) => { if (c != null) node.append(c); });
    return node;
  }

  window.Gala = { GalaSocket, deviceId, el, storageGet, storageSet };
})();
