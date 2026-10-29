'use strict';
// Entrada triomfal al projector: pas 0 = pantalla d'inici, 1..N = cada nen
// (foto + nom, amb esclat de confeti), N+1 = mosaic amb tots.
//
// Si el nen té vídeo d'entrada, el seu pas té dues fases: primer el vídeo (el
// reprodueix el VideoDeck de screen.js, a sota d'aquesta capa, que es torna
// transparent i hi posa el nom a sobre) i, quan s'acaba, la targeta amb la foto.

(function () {
  const el = Gala.el;
  const LEAVE_MS = 600;
  const BURST_PIECES = 28;

  function initials(name) {
    return name.split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase();
  }

  function Parade(root, opts) {
    this.root = root;
    this.opts = opts || {};
    this.intro = root.querySelector('.parade-intro');
    this.introText = root.querySelector('.parade-intro-text');
    this.stage = root.querySelector('.parade-stage');
    this.mosaic = root.querySelector('.parade-mosaic');
    this.finalText = root.querySelector('.parade-final-text');
    this.grid = root.querySelector('.parade-grid');
    this.burst = root.querySelector('.parade-burst');
    this.effect = root.querySelector('audio');
    this.banner = root.querySelector('.parade-banner');
    this.cue = null;
    this.step = null;
    this.pendingVideo = null; // vídeo demanat que encara no es veu
    this.inVideo = null; // nen el vídeo del qual s'està veient
    this.preloaded = [];
  }

  Parade.prototype.photo = function (person, className) {
    if (!person.photo) return el('div', { class: className + ' initials', text: initials(person.name) });
    const img = el('img', { class: className, src: person.photo, alt: person.name });
    img.addEventListener('error', () => {
      if (this.opts.onError) this.opts.onError(person.photo, 'no es pot carregar la foto de ' + person.name);
      img.replaceWith(el('div', { class: className + ' initials', text: initials(person.name) }));
    });
    return img;
  };

  // Nova cue d'entrada (o s'hi torna a entrar).
  Parade.prototype.enter = function (cue) {
    this.cue = cue;
    this.step = null;
    this.pendingVideo = null;
    this.leaveVideoMode();
    this.stage.textContent = '';
    this.burst.textContent = '';
    this.introText.textContent = cue.text || '';
    this.finalText.textContent = cue.finalText || '';
    this.grid.textContent = '';
    cue.people.forEach((p, i) => {
      const tile = el('div', { class: 'tile' }, [this.photo(p, 'tile-photo'), el('div', { class: 'tile-name', text: p.name })]);
      tile.style.animationDelay = (i * 70) + 'ms';
      this.grid.append(tile);
    });
    // Files i columnes del mosaic segons quants nens hi ha (més ample que alt).
    const cols = Math.ceil(Math.sqrt(cue.people.length * 1.8));
    const rows = Math.ceil(cue.people.length / cols);
    this.grid.style.setProperty('--cols', String(cols));
    this.grid.style.setProperty('--rows', String(rows));
    // Precarrega totes les fotos perquè cada pas sigui instantani.
    this.preloaded = cue.people.filter((p) => p.photo).map((p) => {
      const img = new Image();
      img.src = p.photo;
      return img;
    });
    if (cue.effect && this.effect.getAttribute('src') !== cue.effect) this.effect.setAttribute('src', cue.effect);
    if (!cue.effect) this.effect.removeAttribute('src');
  };

  /**
   * Canvia de pas. Retorna undefined si el pas no ha canviat, el src del vídeo
   * si el nen en té (cal reproduir-lo i cridar showVideo() quan ja es vegi), o null.
   */
  Parade.prototype.setStep = function (step) {
    if (!this.cue || step === this.step) return undefined;
    const forward = this.step === null || step > this.step;
    this.step = step;
    const n = this.cue.people.length;
    const person = step >= 1 && step <= n ? this.cue.people[step - 1] : null;
    this.pendingVideo = null;
    if (person && person.video) {
      // Es manté el que hi ha a la pantalla fins que el vídeo ja es vegi.
      this.pendingVideo = { person, forward };
      return person.video;
    }
    this.leaveVideoMode();
    this.showStep(step, person, forward);
    return null;
  };

  // El vídeo del nen ja es veu a sota: capa transparent i nom a sobre.
  Parade.prototype.showVideo = function () {
    const pv = this.pendingVideo;
    if (!pv) return;
    this.pendingVideo = null;
    this.inVideo = pv.person;
    this.intro.classList.add('hidden');
    this.mosaic.classList.add('hidden');
    this.retireCards();
    this.root.classList.add('video-mode');
    if (this.cue.nameOverVideo) {
      this.banner.textContent = pv.person.name;
      this.banner.classList.remove('hidden', 'show');
      void this.banner.offsetWidth; // reinicia l'animació
      this.banner.classList.add('show');
    }
    if (pv.forward) this.fireBurst();
  };

  // S'ha acabat el vídeo del nen: es queda la seva targeta fins al GO següent.
  Parade.prototype.videoEnded = function () {
    const person = this.inVideo;
    if (!person) return;
    this.leaveVideoMode();
    this.showStep(this.step, person, false);
  };

  Parade.prototype.leaveVideoMode = function () {
    this.inVideo = null;
    this.root.classList.remove('video-mode');
    this.banner.classList.add('hidden');
    this.banner.classList.remove('show');
  };

  // Hi ha un vídeo d'entrada en marxa o a punt d'entrar.
  Parade.prototype.busyWithVideo = function () {
    return !!(this.inVideo || this.pendingVideo);
  };

  Parade.prototype.retireCards = function () {
    Array.from(this.stage.children).forEach((card) => {
      card.classList.add('leave');
      setTimeout(() => card.remove(), LEAVE_MS);
    });
  };

  Parade.prototype.showStep = function (step, person, forward) {
    const n = this.cue.people.length;
    this.intro.classList.toggle('hidden', step !== 0);
    this.mosaic.classList.toggle('hidden', step !== n + 1);
    if (this.mosaic.classList.contains('hidden')) {
      this.grid.classList.remove('play');
    } else {
      void this.grid.offsetWidth; // reinicia les animacions del mosaic
      this.grid.classList.add('play');
    }
    this.retireCards();
    if (person) {
      const card = el('div', { class: 'card' }, [
        el('div', { class: 'card-frame' }, [this.photo(person, 'card-photo')]),
        el('div', { class: 'card-name', text: person.name }),
      ]);
      this.stage.append(card);
      if (forward) {
        this.fireBurst();
        this.playEffect();
      }
    } else if (step === n + 1 && forward) {
      this.fireBurst();
    }
  };

  Parade.prototype.fireBurst = function () {
    this.burst.textContent = '';
    const colors = ['#ffcc33', '#e84a5f', '#2a9df4', '#3cb371', '#ffffff', '#f39c12'];
    for (let i = 0; i < BURST_PIECES; i++) {
      const angle = (i / BURST_PIECES) * Math.PI * 2 + Math.random() * 0.4;
      const dist = 30 + Math.random() * 25; // en vmin
      const piece = el('span');
      piece.style.setProperty('--dx', (Math.cos(angle) * dist).toFixed(1) + 'vmin');
      piece.style.setProperty('--dy', (Math.sin(angle) * dist).toFixed(1) + 'vmin');
      piece.style.setProperty('--rot', Math.round(Math.random() * 720 - 360) + 'deg');
      piece.style.background = colors[i % colors.length];
      piece.style.animationDelay = Math.round(Math.random() * 120) + 'ms';
      this.burst.append(piece);
    }
  };

  Parade.prototype.playEffect = function () {
    if (!this.effect.getAttribute('src')) return;
    this.effect.currentTime = 0;
    const p = this.effect.play();
    if (p && p.catch) p.catch(() => {});
  };

  Parade.prototype.setMuted = function (muted) {
    this.effect.muted = muted;
  };

  window.Parade = Parade;
})();
