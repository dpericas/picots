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
  const SHAPES = ['▲', '◆', '●', '■'];
  const WALL_SHOWN = 8;
  let quizKey = null;
  let quizVoters = new Set();
  let chPlayers = new Set();
  let chLastTotal = 0;
  let chResultShown = null;
  let wallShown = new Set();
  // Les mencions fan servir la capa de l'entrada triomfal.
  const LAYER_OF = { awards: 'parade' };

  const socket = new Gala.GalaSocket('screen', {
    onState: (s) => { state = s; render(); },
    onConnection: (ok) => $('offline').classList.toggle('hidden', ok),
  });

  const deck = new VideoDeck($('videos'), {
    onEnded: () => {
      if (!state || !state.cue) return;
      if (state.cue.type === 'parade' || state.cue.type === 'awards') {
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
        if (state.cue.type === 'parade' || state.cue.type === 'awards') parade.showVideo();
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
    quizKey = null;
    chPlayers = new Set();
    chLastTotal = 0;
    chResultShown = null;
    $('ch-players').textContent = '';
    wallShown = new Set();
    $('wall-grid').textContent = '';
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
    if (cue.type === 'parade' || cue.type === 'awards') parade.enter(cue);
    setMusic(['slides', 'hold', 'parade', 'awards', 'quiz', 'challenge', 'wall'].includes(cue.type) ? cue.music : null);
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

  function avatarChip(p, cls) {
    const chip = el('div', { class: cls || 'mini-avatar', title: p.name }, p.avatar ? [] : [p.name.slice(0, 2)]);
    if (p.avatar) chip.style.backgroundImage = 'url("' + p.avatar + '")';
    return chip;
  }

  // --- Qüestionari ---
  function renderQuiz(cue, q) {
    const playing = q.kind === 'question' || q.kind === 'open' || q.kind === 'reveal';
    show('quiz-intro', q.kind === 'intro');
    show('quiz-play', playing);
    show('quiz-ranking', q.kind === 'ranking');
    if (q.kind === 'intro') {
      $('quiz-intro-title').textContent = cue.title || 'Qüestionari';
      $('quiz-intro-text').textContent = cue.text || '';
    }
    const key = q.cueId + ':' + q.q + ':' + q.kind;
    const changed = key !== quizKey;
    if (playing) renderQuizQuestion(q, changed && (quizKey || '').split(':')[1] !== String(q.q));
    if (q.kind === 'ranking' && changed) renderQuizRanking(cue, q);
    quizKey = key;
  }

  function renderQuizQuestion(q, newQuestion) {
    const reveal = q.kind === 'reveal';
    $('quiz-num').textContent = 'Pregunta ' + (q.q + 1) + ' de ' + q.total;
    $('quiz-answered').textContent = q.kind === 'question' ? ''
      : q.answeredBy.length + ' de ' + q.expected + ' han respost';
    $('quiz-question').textContent = q.question.text;
    const img = $('quiz-image');
    const board = $('quiz-board');
    const showBoard = reveal && q.top && q.top.length > 0;
    show('quiz-image', !!q.question.image && !showBoard);
    if (q.question.image && img.getAttribute('src') !== q.question.image) img.src = q.question.image;
    show('quiz-board', showBoard);
    board.textContent = '';
    if (showBoard) {
      q.top.forEach((r, i) => {
        const li = el('li', {}, [
          el('span', { class: 'rank', text: r.rank + '.' }), avatarChip(r),
          el('span', { class: 'who', text: r.name }), el('span', { class: 'pts', text: String(r.points) }),
        ]);
        li.style.animationDelay = (i * 90) + 'ms';
        board.append(li);
      });
    }
    const box = $('quiz-options');
    if (newQuestion || box.childElementCount !== q.question.options.length) {
      box.textContent = '';
      q.question.options.forEach((text, i) => {
        box.append(el('div', { class: 'qopt opt-' + (i % 4) }, [
          el('span', { class: 'shape', text: SHAPES[i % 4] }), el('span', { text: text }), el('span', { class: 'n' }),
        ]));
      });
    }
    Array.from(box.children).forEach((node, i) => {
      node.classList.toggle('right', reveal && q.correct === i);
      node.classList.toggle('wrong', reveal && q.correct !== i);
      node.querySelector('.n').textContent = reveal && q.counts ? String(q.counts[i]) : '';
    });
    if (newQuestion) {
      quizVoters = new Set();
      $('quiz-voters').textContent = '';
    }
    (q.answeredBy || []).forEach((p) => {
      if (quizVoters.has(p.id)) return;
      quizVoters.add(p.id);
      $('quiz-voters').append(avatarChip(p, 'voter'));
    });
  }

  function renderQuizRanking(cue, q) {
    const top = q.top || [];
    $('quiz-ranking-title').textContent = top.length ? 'Classificació' : 'Molt bé a tots! 👏';
    const podium = $('quiz-podium');
    podium.textContent = '';
    // Ordre visual: 2n, 1r, 3r.
    [1, 0, 2].forEach((i) => {
      const r = top[i];
      if (!r) return;
      const pic = el('div', { class: 'pic' }, r.avatar ? [] : [r.name.slice(0, 2)]);
      if (r.avatar) pic.style.backgroundImage = 'url("' + r.avatar + '")';
      const node = el('div', { class: 'podium p' + (i + 1) }, [
        pic, el('div', { class: 'name', text: r.name }), el('div', { class: 'pts', text: r.points + ' punts' }),
        el('div', { class: 'block', text: String(r.rank) }),
      ]);
      // Primer surt el 3r, després el 2n i, per acabar, el 1r.
      node.style.animationDelay = ({ 2: 0, 1: 700, 0: 1400 })[i] + 'ms';
      podium.append(node);
    });
    const rest = $('quiz-rest');
    rest.textContent = '';
    top.slice(3).forEach((r) => rest.append(el('li', {}, [avatarChip(r), r.rank + '. ' + r.name + ' – ' + r.points])));
    setTimeout(() => Parade.burst($('quiz').querySelector('.burst'), 40), top.length ? 1600 : 0);
  }

  // --- Repte col·lectiu ---
  function renderChallenge(cue, c) {
    $('ch-text').textContent = cue.text || cue.title || 'Repte!';
    $('ch-count').textContent = c.status === 'pending' ? 'Prepareu-vos!' : c.total + ' / ' + c.goal;
    $('ch-bar').style.width = Math.min(100, (c.total / c.goal) * 100) + '%';
    const lock = $('ch-lock');
    lock.textContent = c.status === 'closed' && c.result === 'success' ? '🔓' : '🔒';
    if (c.total > chLastTotal && c.status === 'open') {
      lock.classList.remove('shake');
      void lock.offsetWidth;
      lock.classList.add('shake');
    }
    chLastTotal = c.total;
    c.players.forEach((p) => {
      if (chPlayers.has(p.id)) return;
      chPlayers.add(p.id);
      $('ch-players').append(avatarChip(p, 'voter'));
    });
    const result = $('ch-result');
    const shown = c.status === 'closed' ? c.result : null;
    if (shown !== chResultShown) {
      chResultShown = shown;
      result.className = shown ? (shown === 'success' ? '' : 'fail') : 'hidden';
      result.textContent = shown === 'success' ? '🎉 REPTE SUPERAT! 🎉' : 'Gairebé! 💪 Ho heu fet molt bé';
      if (shown === 'success') Parade.burst($('challenge').querySelector('.burst'), 48);
    }
  }

  // --- Mur de missatges: els darrers, el més nou primer ---
  function renderWall(cue, w) {
    $('wall-text').textContent = cue.text || cue.title || 'Mur de missatges';
    const qr = '/api/qr.svg?text=' + encodeURIComponent(state.joinUrl);
    if ($('wall-qr').getAttribute('src') !== qr) $('wall-qr').src = qr;
    const posts = w.posts.slice(-WALL_SHOWN).reverse();
    show('wall-empty', posts.length === 0);
    const grid = $('wall-grid');
    const ids = posts.map((m) => m.id).join(',');
    if (grid.dataset.ids === ids) return;
    grid.dataset.ids = ids;
    grid.textContent = '';
    posts.forEach((m) => {
      const card = el('div', { class: 'wall-card' }, [
        el('div', { class: 'who' }, [avatarChip(m.author), m.author.name]),
        m.drawing ? el('img', { src: m.drawing, alt: 'Dibuix de ' + m.author.name }) : el('div', { class: 'msg', text: m.text }),
      ]);
      // Només s'anima l'entrada dels missatges nous.
      if (wallShown.has(m.id)) card.style.animation = 'none';
      wallShown.add(m.id);
      grid.append(card);
    });
  }

  function updateTimer() {
    const q = state && state.quiz;
    $('quiz-timer').textContent = q && q.kind === 'open' && q.endsAt
      ? Math.max(0, Math.ceil((q.endsAt - socket.serverNow()) / 1000)) : '';
    const c = state && state.challenge;
    $('ch-timer').textContent = c && c.status === 'open' && c.endsAt
      ? Math.max(0, Math.ceil((c.endsAt - socket.serverNow()) / 1000)) : '';
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
    else if (type !== 'video') visualType = LAYER_OF[type] || type;
    ['welcome', 'slides', 'hold', 'vote', 'parade', 'quiz', 'challenge', 'wall'].forEach((id) => show(id, visualType === id));
    if (type === 'parade' || type === 'awards') {
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
    if (type === 'quiz' && s.quiz) renderQuiz(cue, s.quiz);
    if (type === 'challenge' && s.challenge) renderChallenge(cue, s.challenge);
    if (type === 'wall' && s.wall) renderWall(cue, s.wall);

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
