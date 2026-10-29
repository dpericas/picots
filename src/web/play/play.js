'use strict';
// App del mòbil: triar qui ets i votar.

(function () {
  const $ = (id) => document.getElementById(id);
  const el = Gala.el;
  const device = Gala.deviceId();

  let state = null;
  let errorTimer = null;
  let notMeArmed = false;

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

  function updateTimer() {
    const v = state && state.vote;
    $('timer').textContent = v && v.status === 'open' && v.endsAt
      ? Math.max(0, Math.ceil((v.endsAt - socket.serverNow()) / 1000)) : '';
  }
  setInterval(updateTimer, 250);

  function render() {
    const me = state.participants.find((p) => p.id === state.me);
    document.title = state.title;
    const showVote = !!(me && state.vote);
    $('pick').classList.toggle('hidden', !!me);
    $('wait').classList.toggle('hidden', !me || showVote);
    $('vote').classList.toggle('hidden', !showVote);
    $('not-me').classList.toggle('hidden', !me);
    if (!me) renderPick();
    else {
      $('me-name').textContent = 'Hola, ' + me.name + '!';
      avatar($('me-avatar'), me);
      if (showVote) renderVote(state.vote);
    }
  }
})();
