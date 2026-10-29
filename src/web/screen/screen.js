'use strict';
// Pantalla del projector: només mostra l'estat que li envia el servidor.

(function () {
  const $ = (id) => document.getElementById(id);
  const el = Gala.el;
  const music = $('music');

  let state = null;
  let cueKey = null;
  let slideTimer = null;
  let slideIndex = 0;
  let lastPositionSent = 0;
  const LAYER_HIDE_DELAY_MS = 80;
  // Capa que es veu. En entrar a un vídeo, la capa anterior es manté fins que
  // el vídeo ja es veu (onSwap), per no mostrar negre mentre es carrega.
  let visualType = 'welcome';
  let renderedVoters = new Set();

  const socket = new Gala.GalaSocket('screen', {
    onState: (s) => { state = s; render(); },
    onConnection: (ok) => $('offline').classList.toggle('hidden', ok),
  });

  const deck = new VideoDeck($('videos'), {
    onEnded: () => {
      if (!state || !state.cue) return;
      if (state.cue.type === 'parade') {
        // Vídeo d'entrada d'un nen acabat: surt la seva targeta (es queda fins al GO).
        parade.videoEnded();
        deck.release(400);
        render();
        return;
      }
      socket.cmd({ name: 'video.ended', cueId: state.cue.id, enterSeq: state.enterSeq });
    },
    onTime: (t) => {
      const now = Date.now();
      if (now - lastPositionSent < 1000 || !state || !state.cue) return;
      lastPositionSent = now;
      socket.notify({ name: 'video.position', cueId: state.cue.id, enterSeq: state.enterSeq, step: state.step, t });
    },
    onError: (src, msg) => reportMediaError(src, msg),
    onMutedFallback: () => show('sound-hint', true),
    onSwap: () => {
      // Marge perquè el compositor tingui el fotograma a la pantalla abans de treure la capa.
      setTimeout(() => {
        if (!state || !state.cue) return;
        if (state.cue.type === 'parade') parade.showVideo();
        else if (state.cue.type === 'video') visualType = 'video';
        else return;
        render();
      }, LAYER_HIDE_DELAY_MS);
    },
  });
  window.galaDeck = deck; // per a diagnòstic des de les eines de desenvolupament
  const parade = new Parade($('parade'), { onError: (src, msg) => reportMediaError(src, msg) });

  function show(id, visible) {
    $(id).classList.toggle('hidden', !visible);
  }

  function reportMediaError(src, msg) {
    socket.cmd({ name: 'media.error', cueId: state && state.cue && state.cue.id, src, msg });
  }

  // Música: si el navegador bloqueja el so (fora d'Electron), prova sense so.
  function safePlay(media) {
    const p = media.play();
    if (p && p.catch) {
      p.catch((err) => {
        if (err.name === 'NotAllowedError') {
          media.muted = true;
          show('sound-hint', true);
          media.play().catch(() => {});
        }
      });
    }
  }
  $('sound-hint').addEventListener('click', () => {
    deck.setMuted(false);
    parade.setMuted(false);
    music.muted = false;
    show('sound-hint', false);
  });
  music.addEventListener('error', () => {
    if (music.getAttribute('src')) reportMediaError(music.getAttribute('src'), 'no es pot reproduir la música');
  });

  function setMusic(src) {
    if (!src) {
      music.pause();
      music.removeAttribute('src');
      return;
    }
    if (music.getAttribute('src') !== src) {
      music.setAttribute('src', src);
      music.currentTime = 0;
    }
  }

  function stopSlides() {
    clearInterval(slideTimer);
    slideTimer = null;
  }

  function showSlide(cue, i) {
    const imgs = [$('slide-a'), $('slide-b')];
    const target = imgs[i % 2];
    const other = imgs[(i + 1) % 2];
    target.onerror = () => reportMediaError(cue.images[i], 'no es pot carregar la imatge');
    target.src = cue.images[i];
    target.classList.add('on');
    other.classList.remove('on');
    // Precarrega la següent.
    const next = new Image();
    next.src = cue.images[(i + 1) % cue.images.length];
  }

  function startSlides(cue) {
    stopSlides();
    slideIndex = 0;
    showSlide(cue, 0);
    slideTimer = setInterval(() => {
      if (state.paused) return;
      slideIndex = (slideIndex + 1) % cue.images.length;
      showSlide(cue, slideIndex);
    }, cue.interval * 1000);
  }

  // S'executa només quan canvia la cue (o es torna a entrar a la mateixa).
  function enterCue(cue) {
    stopSlides();
    renderedVoters = new Set();
    $('vote-voters').textContent = '';
    if (!cue) {
      deck.release(0);
      setMusic(null);
      return;
    }
    if (cue.type === 'video') {
      const r = state.resume;
      const resume = r && r.cueId === cue.id && r.enterSeq === state.enterSeq;
      deck.play(cue.src, { startAt: resume ? r.t : 0, fade: cue.fade, paused: state.paused });
    } else {
      // L'últim fotograma queda sota la capa nova mentre aquesta apareix (fos de les fotos).
      deck.release(1000);
    }
    if (cue.type === 'slides') startSlides(cue);
    if (cue.type === 'parade') parade.enter(cue);
    setMusic(['slides', 'hold', 'parade'].includes(cue.type) ? cue.music : null);
    if (cue.type === 'hold') $('hold-text').textContent = cue.text || '';
  }

  function renderVote(cue, vote) {
    $('vote-question').textContent = cue.question;
    const box = $('vote-options');
    if (box.childElementCount !== cue.options.length || box.dataset.cue !== cue.id) {
      box.textContent = '';
      box.dataset.cue = cue.id;
      cue.options.forEach((text, i) => {
        box.append(el('div', { class: 'opt opt-' + (i % 4) }, [
          el('div', { class: 'bar' }),
          el('div', { class: 'label', text: String.fromCharCode(65 + i) + '. ' + text }),
          el('div', { class: 'count' }),
        ]));
      });
    }
    const total = vote.counts.reduce((a, b) => a + b, 0);
    const decided = vote.status === 'closed';
    Array.from(box.children).forEach((node, i) => {
      const n = vote.counts[i] || 0;
      node.querySelector('.count').textContent = vote.status === 'pending' ? '' : n;
      node.querySelector('.bar').style.height = (total ? (n / total) * 100 : 0) + '%';
      node.classList.toggle('winner', decided && vote.result === i);
      node.classList.toggle('loser', decided && vote.result !== i);
    });
    const voters = $('vote-voters');
    vote.voters.forEach((p) => {
      if (renderedVoters.has(p.id)) return;
      renderedVoters.add(p.id);
      const chip = el('div', { class: 'voter', title: p.name }, p.avatar ? [] : [p.name.slice(0, 2)]);
      if (p.avatar) chip.style.backgroundImage = 'url("' + p.avatar + '")';
      voters.append(chip);
    });
    const qr = $('vote-qr');
    qr.classList.toggle('hidden', vote.status !== 'open');
    if (vote.status === 'open' && !qr.getAttribute('src')) qr.src = '/api/qr.svg?text=' + encodeURIComponent(state.joinUrl);
    updateTimer();
  }

  function updateTimer() {
    const t = $('vote-timer');
    const vote = state && state.vote;
    if (!vote || vote.status !== 'open' || !vote.endsAt) {
      t.textContent = vote && vote.status === 'tie' ? 'Empat!' : '';
      return;
    }
    const left = Math.max(0, Math.ceil((vote.endsAt - socket.serverNow()) / 1000));
    t.textContent = left;
  }
  setInterval(updateTimer, 250);

  function render() {
    const s = state;
    $('welcome-title').textContent = s.title;
    if (!s.started) {
      $('welcome-qr').src = '/api/qr.svg?text=' + encodeURIComponent(s.joinUrl);
      $('welcome-url').textContent = s.joinUrl;
    }
    const key = s.cue ? s.cue.id + ':' + s.enterSeq : null;
    if (key !== cueKey) {
      cueKey = key;
      enterCue(s.cue);
    }
    const cue = s.cue;
    const type = cue ? cue.type : null;
    if (!s.started) visualType = 'welcome';
    else if (type !== 'video') visualType = type;
    show('welcome', visualType === 'welcome');
    show('slides', visualType === 'slides');
    show('hold', visualType === 'hold');
    show('vote', visualType === 'vote');
    show('parade', visualType === 'parade');
    if (type === 'parade') {
      const src = parade.setStep(s.step);
      if (src) {
        const r = s.resume;
        const resume = r && r.cueId === cue.id && r.enterSeq === s.enterSeq && r.step === s.step;
        deck.play(src, { startAt: resume ? r.t : 0, paused: s.paused });
      } else if (src === null) {
        deck.release(300); // pas sense vídeo: la capa ja tapa el vídeo anterior
      }
    }
    if (type === 'vote' && s.vote) renderVote(cue, s.vote);

    deck.preload(s.preload);

    // Pausa global: afecta vídeo, música i diapositives.
    // Les capes de negre/espera només tapen la imatge; el so el controla la pausa.
    if (type === 'video' || (type === 'parade' && parade.busyWithVideo())) deck.setPaused(s.paused);
    if (music.getAttribute('src')) {
      // La música de fons de l'entrada calla mentre sona el vídeo d'un nen.
      if (s.paused || (type === 'parade' && parade.busyWithVideo())) music.pause();
      else if (music.paused) safePlay(music);
    }
    show('overlay-hold', s.overlay === 'hold');
    show('overlay-black', s.overlay === 'black');
  }
})();
