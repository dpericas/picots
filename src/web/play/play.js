'use strict';
// App del mòbil: triar qui ets, votar, qüestionari, repte i mur de missatges.

(function () {
  const $ = (id) => document.getElementById(id);
  const el = Gala.el;
  const device = Gala.deviceId();

  const SHAPES = ['▲', '◆', '●', '■'];
  const EMOJIS = ['❤️', '😀', '🎉', '👏', '⭐', '🌈', '🙏', '😢'];
  const COLORS = ['#222222', '#e84a5f', '#2a9df4', '#3cb371', '#f39c12', '#8e44ad'];
  const TAP_SEND_MS = 250;
  const MAX_TAPS_PER_MSG = 20;

  let state = null;
  let errorTimer = null;
  let notMeArmed = false;
  let pendingTaps = 0;
  let wallMode = 'text';
  let drawn = false;

  // QR personal: /play?k=<id>.<clau>. Es reclama un cop connectats i es neteja l'URL.
  const params = new URLSearchParams(location.search);
  let personal = null;
  if (params.get('k')) {
    const raw = params.get('k');
    const dot = raw.lastIndexOf('.');
    if (dot > 0) personal = { participantId: raw.slice(0, dot), key: raw.slice(dot + 1) };
    history.replaceState(null, '', '/play');
  }

  const socket = new Gala.GalaSocket('play', {
    device,
    onState: (s) => {
      state = s;
      if (personal && s.me !== personal.participantId) {
        const p = personal;
        personal = null;
        claim(p.participantId, p.key);
      }
      render();
    },
    onConnection: (ok) => $('offline').classList.toggle('hidden', ok),
  });

  function showError(msg) {
    $('error').textContent = msg;
    $('error').classList.remove('hidden');
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => $('error').classList.add('hidden'), 3500);
  }

  async function claim(participantId, key) {
    const r = await socket.cmd({ name: 'claim', participantId, key });
    if (!r.ok) showError(r.error);
  }

  async function vote(option) {
    if (navigator.vibrate) navigator.vibrate(40);
    const r = await socket.cmd({ name: 'ballot', option });
    if (!r.ok) showError(r.error);
  }

  function avatar(node, p) {
    node.textContent = p.avatar ? '' : p.name.slice(0, 2);
    node.style.backgroundImage = p.avatar ? 'url("' + p.avatar + '")' : '';
  }

  $('not-me').addEventListener('click', async () => {
    if (!notMeArmed) {
      notMeArmed = true;
      $('not-me').textContent = 'Segur? Toca de nou';
      setTimeout(() => { notMeArmed = false; $('not-me').textContent = 'No sóc jo'; }, 3000);
      return;
    }
    notMeArmed = false;
    $('not-me').textContent = 'No sóc jo';
    const r = await socket.cmd({ name: 'release', participantId: state.me });
    if (!r.ok) showError(r.error);
  });

  function renderPick() {
    const box = $('names');
    box.textContent = '';
    state.participants.forEach((p) => {
      const a = el('div', { class: 'avatar' });
      avatar(a, p);
      const b = el('button', { disabled: p.taken }, [a, p.name]);
      b.addEventListener('click', () => claim(p.id));
      box.append(b);
    });
  }

  function renderVote(v) {
    $('question').textContent = v.question;
    const box = $('options');
    if (box.dataset.cue !== v.cueId || box.childElementCount !== v.options.length) {
      box.textContent = '';
      box.dataset.cue = v.cueId;
      v.options.forEach((text, i) => {
        const b = el('button', { class: 'opt-' + (i % 4), text: String.fromCharCode(65 + i) + '. ' + text });
        b.addEventListener('click', () => vote(i));
        box.append(b);
      });
    }
    const open = v.status === 'open';
    const highlight = open ? v.myBallot : v.result;
    Array.from(box.children).forEach((b, i) => {
      b.disabled = !open;
      b.classList.toggle('chosen', highlight === i);
      b.classList.toggle('dim', highlight != null && highlight !== i);
    });
    let msg = '';
    if (v.status === 'pending') msg = 'Prepara\'t! Encara no es pot votar.';
    else if (open) msg = v.myBallot == null ? 'Tria una opció!' : 'Has votat! Pots canviar fins que s\'acabi el temps.';
    else if (v.status === 'tie') msg = 'Empat! Mira la pantalla.';
    else msg = 'Votació tancada!';
    $('vote-msg').textContent = msg;
    updateTimer();
  }

  function secondsLeft(endsAt) {
    return endsAt ? String(Math.max(0, Math.ceil((endsAt - socket.serverNow()) / 1000))) : '';
  }

  function updateTimer() {
    if (!state) return;
    const v = state.vote;
    $('timer').textContent = v && v.status === 'open' ? secondsLeft(v.endsAt) : '';
    const q = state.quiz;
    $('quiz-timer').textContent = q && q.kind === 'open' ? secondsLeft(q.endsAt) : '';
    const c = state.challenge;
    $('ch-timer').textContent = c && c.status === 'open' ? secondsLeft(c.endsAt) : '';
  }
  setInterval(updateTimer, 250);

  // --- Qüestionari ---
  async function answer(option) {
    if (navigator.vibrate) navigator.vibrate(40);
    const r = await socket.cmd({ name: 'answer', option });
    if (!r.ok) showError(r.error);
  }

  function renderQuiz(q) {
    $('quiz-head').textContent = q.q != null ? 'Pregunta ' + (q.q + 1) + ' de ' + q.total : 'Qüestionari';
    $('quiz-question').textContent = q.question ? q.question.text : '';
    const box = $('quiz-options');
    const key = q.cueId + ':' + q.q;
    const options = q.question && q.kind !== 'intro' && q.kind !== 'ranking' ? q.question.options : [];
    if (box.dataset.key !== key || box.childElementCount !== options.length) {
      box.textContent = '';
      box.dataset.key = key;
      options.forEach((text, i) => {
        const b = el('button', { class: 'opt-' + (i % 4) }, [el('span', { class: 'shape', text: SHAPES[i % 4] }), text]);
        b.addEventListener('click', () => answer(i));
        box.append(b);
      });
    }
    const open = q.kind === 'open';
    const answered = q.myAnswer != null;
    Array.from(box.children).forEach((b, i) => {
      b.disabled = !open || answered;
      b.classList.toggle('chosen', q.myAnswer === i);
      b.classList.toggle('correct', q.kind === 'reveal' && q.correct === i);
      b.classList.toggle('dim', (answered || q.kind === 'reveal') && q.myAnswer !== i && !(q.kind === 'reveal' && q.correct === i));
    });
    const result = $('quiz-result');
    result.className = '';
    result.textContent = '';
    let msg = '';
    if (q.kind === 'intro') msg = 'Prepara\'t! Respon tan ràpid com puguis.';
    else if (q.kind === 'question') msg = 'Llegeix la pregunta… Ara mateix es podrà respondre!';
    else if (open) msg = answered ? 'Resposta enviada! 🤞' : 'Tria una resposta!';
    else if (q.kind === 'reveal') {
      if (q.myAnswer == null) {
        result.textContent = 'No has respost';
      } else if (q.myPoints > 0) {
        result.className = 'good';
        result.textContent = '✅ Correcte! +' + q.myPoints;
      } else {
        result.className = 'bad';
        result.textContent = '❌ Era la ' + String.fromCharCode(65 + q.correct);
      }
      if (q.myTotal != null) msg = 'Portes ' + q.myTotal + ' punts' + (q.myRank ? ' · ets el número ' + q.myRank + '!' : '');
    } else if (q.kind === 'ranking') {
      if (q.myTotal != null) {
        result.className = 'good';
        result.textContent = q.myRank ? '🏆 Número ' + q.myRank + '!' : '👏 Molt bé!';
        msg = 'Has fet ' + q.myTotal + ' punts';
      } else {
        result.textContent = '👏 Molt bé!';
      }
    }
    $('quiz-msg').textContent = msg;
  }

  // --- Repte: els tocs s'acumulen i s'envien en grup ---
  $('ch-tap').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const c = state && state.challenge;
    if (!c || c.status !== 'open') return;
    const b = $('ch-tap');
    b.classList.add('hit');
    setTimeout(() => b.classList.remove('hit'), 80);
    if (navigator.vibrate) navigator.vibrate(15);
    if (c.mode === 'all') {
      if (c.mine) return;
      socket.cmd({ name: 'tap', n: 1 }).then((r) => { if (!r.ok) showError(r.error); });
      return;
    }
    pendingTaps += 1;
  });
  setInterval(() => {
    if (!pendingTaps) return;
    const n = Math.min(pendingTaps, MAX_TAPS_PER_MSG);
    pendingTaps -= n;
    socket.notify({ name: 'tap', n });
  }, TAP_SEND_MS);

  function renderChallenge(c) {
    $('ch-text').textContent = c.text || 'Repte!';
    const b = $('ch-tap');
    const open = c.status === 'open';
    b.textContent = c.mode === 'all' ? (c.mine ? 'FET! ✔' : 'SÓC A PUNT!') : 'TOCA!';
    b.disabled = !open || (c.mode === 'all' && c.mine > 0);
    $('ch-bar').style.width = Math.min(100, (c.total / c.goal) * 100) + '%';
    let msg = '';
    if (c.status === 'pending') msg = 'Prepara\'t… quan comenci, toca el botó!';
    else if (open) msg = c.mode === 'all' ? c.total + ' de ' + c.goal + ' a punt' : c.total + ' / ' + c.goal;
    else msg = c.result === 'success' ? '🎉 Ho heu aconseguit!' : '💪 Gairebé! Mira la pantalla';
    $('ch-msg').textContent = msg;
  }

  // --- Mur de missatges ---
  const canvas = $('wall-canvas');
  const ctx = canvas.getContext('2d');
  let color = COLORS[0];
  let drawing = false;
  let last = null;

  function clearCanvas() {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawn = false;
  }
  clearCanvas();

  function canvasPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height };
  }
  canvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    last = canvasPoint(e);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(last.x, last.y, 3, 0, Math.PI * 2);
    ctx.fill();
    drawn = true;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const pt = canvasPoint(e);
    ctx.strokeStyle = color;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
    last = pt;
  });
  ['pointerup', 'pointercancel'].forEach((t) => canvas.addEventListener(t, () => { drawing = false; }));
  $('wall-clear').addEventListener('click', clearCanvas);
  COLORS.forEach((c, i) => {
    const b = el('button', { class: i === 0 ? 'on' : '' });
    b.style.background = c;
    b.addEventListener('click', () => {
      color = c;
      Array.from($('wall-colors').children).forEach((x) => x.classList.toggle('on', x === b));
    });
    $('wall-colors').append(b);
  });
  EMOJIS.forEach((emoji) => {
    const b = el('button', { text: emoji });
    b.addEventListener('click', () => {
      const input = $('wall-input');
      if (input.value.length + emoji.length <= 100) input.value += emoji;
    });
    $('wall-emojis').append(b);
  });

  function setWallMode(mode) {
    wallMode = mode;
    $('wall-tab-text').classList.toggle('on', mode === 'text');
    $('wall-tab-draw').classList.toggle('on', mode === 'draw');
    $('wall-write').classList.toggle('hidden', mode !== 'text');
    $('wall-draw').classList.toggle('hidden', mode !== 'draw');
  }
  $('wall-tab-text').addEventListener('click', () => setWallMode('text'));
  $('wall-tab-draw').addEventListener('click', () => setWallMode('draw'));

  $('wall-send').addEventListener('click', async () => {
    const cmd = { name: 'wall.post' };
    if (wallMode === 'draw') {
      if (!drawn) return showError('Primer fes un dibuix!');
      // Un dibuix molt atapeït pot passar del límit: es baixa la qualitat.
      let quality = 0.7;
      cmd.drawing = canvas.toDataURL('image/jpeg', quality);
      while (cmd.drawing.length > 75000 && quality > 0.3) {
        quality -= 0.15;
        cmd.drawing = canvas.toDataURL('image/jpeg', quality);
      }
    } else {
      cmd.text = $('wall-input').value;
      if (!cmd.text.trim()) return showError('Escriu alguna cosa!');
    }
    $('wall-send').disabled = true;
    const r = await socket.cmd(cmd);
    $('wall-send').disabled = false;
    if (!r.ok) return showError(r.error);
    if (navigator.vibrate) navigator.vibrate(60);
    if (wallMode === 'draw') clearCanvas();
    else $('wall-input').value = '';
  });

  function renderWall(w) {
    $('wall-text').textContent = w.text || 'Envia un missatge!';
    $('wall-tabs').classList.toggle('hidden', !w.drawings);
    if (!w.drawings && wallMode === 'draw') setWallMode('text');
    $('wall-send').disabled = w.left === 0;
    $('wall-left').textContent = w.left === 0 ? 'Ja has enviat tots els missatges. Gràcies! 💛'
      : 'Et queden ' + w.left + (w.left === 1 ? ' missatge' : ' missatges');
    const list = $('wall-mine');
    list.textContent = '';
    const STATUS = { pending: '⏳ pendent de revisar', approved: '✅ a la pantalla', rejected: '✖ no publicat' };
    w.mine.slice().reverse().forEach((m) => {
      list.append(el('li', { text: (m.drawing ? '🎨 Dibuix' : m.text) + ' — ' + STATUS[m.status] }));
    });
  }

  function render() {
    const me = state.participants.find((p) => p.id === state.me);
    document.title = state.title;
    // Què mostra el mòbil: la primera activitat que hi hagi a la cue actual.
    let view = 'pick';
    if (me) {
      if (state.quiz) view = 'quiz';
      else if (state.challenge) view = 'challenge';
      else if (state.wall) view = 'wall';
      else if (state.vote) view = 'vote';
      else view = 'wait';
    }
    ['pick', 'wait', 'quiz', 'challenge', 'wall', 'vote'].forEach((id) => $(id).classList.toggle('hidden', id !== view));
    $('not-me').classList.toggle('hidden', !me);
    if (!me) return renderPick();
    $('me-name').textContent = 'Hola, ' + me.name + '!';
    avatar($('me-avatar'), me);
    if (view === 'quiz') renderQuiz(state.quiz);
    else if (view === 'challenge') renderChallenge(state.challenge);
    else if (view === 'wall') renderWall(state.wall);
    else if (view === 'vote') renderVote(state.vote);
    updateTimer();
  }
})();
