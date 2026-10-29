'use strict';
// Reproductor de vídeo sense talls per al projector.
//
// Manté un petit grup d'elements <video> superposats: el que es veu i els que el
// servidor indica que poden venir després, ja carregats i aturats al primer
// fotograma. Per canviar de vídeo mai es canvia el src de l'element visible (cosa que
// deixaria un instant en negre). El vídeo nou es posa a sobre de l'anterior amb fons
// transparent i l'anterior (o la capa que hi hagi: fotos, votació...) no es retira
// fins que el nou ja ha pintat fotogrames.

(function () {
  const MAX_ELEMENTS = 4;
  const READY_TIMEOUT_MS = 3000;
  const PAINT_TIMEOUT_MS = 300;
  const HIDE_DELAY_MS = 250;

  function VideoDeck(container, opts) {
    this.container = container;
    this.opts = opts || {};
    this.pool = []; // elements <video>
    this.wanted = []; // srcs a tenir precarregats
    this.active = null; // element de la cue actual (rep ended/timeupdate)
    this.shown = null; // element que es veu a la pantalla
    this.pending = null; // element que s'està carregant per entrar
    this.outgoing = new Set(); // elements que s'estan retirant
    this.token = 0;
    this.z = 1;
    this.muted = false;
  }

  VideoDeck.prototype.create = function () {
    const v = document.createElement('video');
    v.className = 'deck-video';
    v.preload = 'auto';
    v.playsInline = true;
    v.muted = this.muted;
    v.addEventListener('ended', () => {
      if (v === this.active && this.opts.onEnded) this.opts.onEnded();
    });
    v.addEventListener('timeupdate', () => {
      if (v === this.active && this.opts.onTime) this.opts.onTime(v.currentTime);
    });
    v.addEventListener('error', () => {
      const src = v.getAttribute('src');
      // El tercer paràmetre diu si és el vídeo de la cue actual (no una precàrrega).
      if (src && this.opts.onError) {
        this.opts.onError(src, v.error ? 'codi ' + v.error.code + ' ' + (v.error.message || '') : 'error',
          v === this.active || v === this.pending);
      }
    });
    this.container.append(v);
    this.pool.push(v);
    return v;
  };

  VideoDeck.prototype.isBusy = function (v) {
    return v === this.active || v === this.shown || v === this.pending || this.outgoing.has(v);
  };

  // Retorna un element amb aquest src, carregant-lo si cal.
  VideoDeck.prototype.acquire = function (src) {
    let v = this.pool.find((x) => x.getAttribute('src') === src);
    if (v) return v;
    v = this.pool.find((x) => !this.isBusy(x) && !this.wanted.includes(x.getAttribute('src')));
    if (!v && this.pool.length < MAX_ELEMENTS) v = this.create();
    if (!v) v = this.pool.find((x) => !this.isBusy(x));
    if (!v) v = this.create(); // no hauria de passar
    v.setAttribute('src', src);
    v.load();
    return v;
  };

  VideoDeck.prototype.unload = function (v) {
    v.pause();
    v.classList.remove('visible');
    v.removeAttribute('src');
    v.load();
  };

  // Llista de vídeos que poden venir després. Allibera els que ja no calen.
  VideoDeck.prototype.preload = function (srcs) {
    this.wanted = (srcs || []).slice(0, MAX_ELEMENTS - 1);
    this.wanted.forEach((src) => {
      const v = this.acquire(src);
      if (!this.isBusy(v) && v.currentTime !== 0 && v.readyState >= 1) v.currentTime = 0;
    });
    this.pool.forEach((v) => {
      const src = v.getAttribute('src');
      if (src && !this.isBusy(v) && !this.wanted.includes(src)) this.unload(v);
    });
  };

  /**
   * Passa a reproduir src.
   * @param {string} src
   * @param {object} [o]  startAt (s), fade (s), paused (bool)
   */
  VideoDeck.prototype.play = function (src, o) {
    o = o || {};
    const token = ++this.token;
    this.pending = null;
    const v = this.acquire(src);
    const startAt = o.startAt || 0;
    if (v === this.active) {
      // Mateix vídeo (reiniciar la cue): només cal tornar a l'inici.
      v.currentTime = startAt;
      if (!o.paused) this.safePlay(v);
      return;
    }
    this.pending = v;
    let started = false;
    let timer = null;
    const start = () => {
      if (started || token !== this.token) return;
      started = true;
      this.pending = null;
      clearTimeout(timer);
      v.removeEventListener('canplay', check);
      v.removeEventListener('seeked', check);
      v.removeEventListener('loadedmetadata', seek);
      this.swap(v, o.fade || 0, !o.paused);
    };
    const check = () => {
      if (v.readyState >= 3 && !v.seeking) start();
    };
    const seek = () => {
      if (Math.abs(v.currentTime - startAt) > 0.05) v.currentTime = startAt;
      check();
    };
    v.addEventListener('canplay', check);
    v.addEventListener('seeked', check);
    if (v.readyState >= 1) seek();
    else v.addEventListener('loadedmetadata', seek);
    // Si el fitxer tarda massa (o falla), canvia igualment per no quedar encallats.
    if (!started) timer = setTimeout(start, READY_TIMEOUT_MS);
  };

  VideoDeck.prototype.swap = function (v, fade, playNow) {
    const prev = this.active;
    // Un element que havia d'entrar però encara no s'havia confirmat: es retira.
    if (prev && prev !== this.shown && prev !== v) this.retire(prev, 0);
    // Tall net: el vídeo anterior es congela (sense so) mentre el nou arrenca.
    if (this.shown && fade === 0) this.shown.pause();
    this.active = v;
    v.volume = 1;
    v.style.zIndex = String(++this.z);
    v.style.transition = 'none';
    if (fade > 0) {
      v.classList.remove('visible');
      void v.offsetWidth; // aplica l'opacitat 0 abans de la transició
      v.style.transition = 'opacity ' + fade + 's linear';
    }
    // Visible de seguida: el fons és transparent, així que fins que pinti el primer
    // fotograma es continua veient el que hi ha a sota (el vídeo anterior).
    v.classList.add('visible');
    if (playNow) this.safePlay(v);
    const token = this.token;
    this.whenPainted(v, () => {
      if (token !== this.token) return;
      const old = this.shown;
      this.shown = v;
      if (old && old !== v) this.retire(old, fade);
      if (this.opts.onSwap) this.opts.onSwap(v);
    });
  };

  // Crida cb quan l'element ja pinta fotogrames a la pantalla.
  // El primer fotograma "presentat" pot no ser-hi encara: s'espera el segon.
  VideoDeck.prototype.whenPainted = function (v, cb) {
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      cb();
    };
    if (v.requestVideoFrameCallback && !v.paused) {
      v.requestVideoFrameCallback(() => v.requestVideoFrameCallback(() => requestAnimationFrame(once)));
    } else {
      requestAnimationFrame(() => requestAnimationFrame(once));
    }
    setTimeout(once, PAINT_TIMEOUT_MS); // en pausa o si el vídeo falla
  };

  // Treu un element de la pantalla quan el nou ja hi és (amb fos d'àudio si n'hi ha).
  VideoDeck.prototype.retire = function (old, fade) {
    this.outgoing.add(old);
    const finish = () => {
      this.outgoing.delete(old);
      if (old === this.active || old === this.shown) return;
      old.pause();
      old.volume = 1;
      old.classList.remove('visible');
      old.style.transition = 'none';
      const src = old.getAttribute('src');
      if (src && !this.wanted.includes(src)) this.unload(old);
    };
    if (fade > 0) {
      const t0 = performance.now();
      const step = () => {
        if (old === this.active) return finish();
        const k = Math.min(1, (performance.now() - t0) / (fade * 1000));
        old.volume = 1 - k;
        if (k < 1) requestAnimationFrame(step);
        else finish();
      };
      requestAnimationFrame(step);
    } else {
      old.pause();
      setTimeout(finish, HIDE_DELAY_MS);
    }
  };

  // Deixa de mostrar vídeo (la cue nova no n'és). Es manté l'últim fotograma
  // un moment perquè la capa nova (fotos, votació...) hi aparegui a sobre.
  VideoDeck.prototype.release = function (delayMs) {
    this.token++;
    this.pending = null;
    const active = this.active;
    const shown = this.shown;
    this.active = null;
    this.shown = null;
    if (active) active.pause();
    if (active && active !== shown) this.retire(active, 0);
    if (shown) {
      shown.pause();
      this.outgoing.add(shown);
      setTimeout(() => {
        this.outgoing.delete(shown);
        if (shown === this.active || shown === this.shown) return;
        shown.classList.remove('visible');
        const src = shown.getAttribute('src');
        if (src && !this.wanted.includes(src)) this.unload(shown);
      }, delayMs || 0);
    }
  };

  VideoDeck.prototype.setPaused = function (paused) {
    const v = this.active;
    if (!v) return;
    if (paused) v.pause();
    else if (v.paused && !v.ended) this.safePlay(v);
  };

  // Si el navegador bloqueja el so (fora d'Electron), reprodueix sense so.
  VideoDeck.prototype.safePlay = function (v) {
    const p = v.play();
    if (p && p.catch) {
      p.catch((err) => {
        if (err.name === 'NotAllowedError') {
          this.setMuted(true);
          if (this.opts.onMutedFallback) this.opts.onMutedFallback();
          v.play().catch(() => {});
        }
      });
    }
  };

  VideoDeck.prototype.setMuted = function (muted) {
    this.muted = muted;
    this.pool.forEach((v) => { v.muted = muted; });
  };

  window.VideoDeck = VideoDeck;
})();
