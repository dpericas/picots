'use strict';
// Comandament del presentador (mòbil): GO, ENRERE, què ve ara i el text a dir.

(function () {
  const $ = (id) => document.getElementById(id);
  const el = Gala.el;
  const STATUS = { pending: 'pendent', open: 'OBERTA', closed: 'tancada', tie: 'EMPAT (decideix el tècnic)' };

  let state = null;
  let socket = null;
  let toastTimer = null;
  let backArmed = null;

  function toast(msg, kind) {
    $('toast').textContent = msg;
    $('toast').className = kind || '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 3000);
  }

  function showLogin(error) {
    $('main').classList.add('hidden');
    $('login').classList.remove('hidden');
    $('login-error').textContent = error || '';
    $('pin').focus();
  }

  function start(pin) {
    $('login').classList.add('hidden');
    $('main').classList.remove('hidden');
    socket = new Gala.GalaSocket('remote', {
      pin,
      onState: (s) => {
        Gala.storageSet('gala.remotePin', pin); // el PIN funciona: es recorda
        state = s;
        render();
      },
      onConnection: (ok) => {
        $('conn').textContent = ok ? 'Connectat' : 'Sense connexió';
        $('conn').className = 'pill ' + (ok ? 'ok' : 'bad');
      },
      onClose: (code) => {
        if (code === 4003) {
          Gala.storageSet('gala.remotePin', '');
          socket = null;
          showLogin('PIN incorrecte.');
          return false;
        }
        return true;
      },
    });
  }

  $('pin-ok').addEventListener('click', () => {
    const pin = $('pin').value.trim();
    if (pin) start(pin);
  });
  $('pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pin-ok').click(); });

  async function send(cmd) {
    if (!socket) return { ok: false };
    const r = await socket.cmd(cmd);
    if (!r.ok) toast(r.error || 'Error');
    else if (navigator.vibrate) navigator.vibrate(60);
    return r;
  }

  // expectNav: si el tècnic acaba d'avançar, aquest GO no en fa un altre.
  $('btn-go').addEventListener('click', () => send({ name: 'go', expectNav: state && state.navSeq }));

  // ENRERE: cal tocar dues vegades en 2 s, per no fer-ho sense voler.
  $('btn-back').addEventListener('click', () => {
    const b = $('btn-back');
    if (backArmed) {
      clearTimeout(backArmed);
      backArmed = null;
      b.classList.remove('armed');
      send({ name: 'back', expectNav: state && state.navSeq });
      return;
    }
    b.classList.add('armed');
    backArmed = setTimeout(() => {
      backArmed = null;
      b.classList.remove('armed');
    }, 2000);
  });

  $('btn-help').addEventListener('click', () => $('help-options').classList.toggle('hidden'));
  Array.from(document.querySelectorAll('#help-options button')).forEach((b) => {
    b.addEventListener('click', async () => {
      $('help-options').classList.add('hidden');
      const r = await send({ name: 'remote.alert', msg: b.dataset.msg });
      if (r.ok) toast('Avís enviat al tècnic', 'info');
    });
  });

  function updateTimer() {
    const v = state && state.vote;
    $('vote-timer').textContent = v && v.status === 'open' && v.endsAt && socket
      ? Math.max(0, Math.ceil((v.endsAt - socket.serverNow()) / 1000)) + ' s' : '';
  }
  setInterval(updateTimer, 250);

  function render() {
    const s = state;
    document.title = s.title + ' – Presentador';
    $('locked').classList.toggle('hidden', s.enabled);
    $('paused').classList.toggle('hidden', !s.paused);
    const ov = { black: 'PANTALLA NEGRA', hold: 'PANTALLA D\'ESPERA' }[s.overlay];
    $('overlay').textContent = ov || '';
    $('overlay').classList.toggle('hidden', !ov);

    const cue = s.cue;
    $('now-title').textContent = !s.started ? 'Encara no ha començat' : (cue ? cue.title : '—') + (s.ended ? ' (FI)' : '');
    $('now-step').textContent = cue && cue.stepLabel ? cue.stepLabel : '';
    $('script').textContent = (cue && cue.script) || '';
    $('script').classList.toggle('hidden', !(cue && cue.script));

    const v = s.vote;
    $('vote').classList.toggle('hidden', !v);
    if (v) {
      $('vote-status').textContent = '– ' + (STATUS[v.status] || v.status);
      $('vote-question').textContent = v.question;
      const box = $('vote-options');
      box.textContent = '';
      v.options.forEach((text, i) => {
        box.append(el('div', { class: v.status === 'closed' && v.result === i ? 'winner' : '' }, [
          el('span', { text: String.fromCharCode(65 + i) + '. ' + text }),
          el('span', { text: v.status === 'pending' ? '' : String(v.counts[i] || 0) }),
        ]));
      });
      $('vote-voters').textContent = v.status === 'pending' ? '' : 'Han votat ' + v.voters + ' de ' + v.expected;
      updateTimer();
    }

    const g = s.go;
    $('go-label').textContent = g.label ? '→ ' + g.label : (g.reason || '');
    $('btn-go').disabled = !s.enabled || g.action === 'none';
    $('btn-back').disabled = !s.enabled || !s.canBack;
  }

  // Si el QR del tècnic porta el PIN (?pin=...), s'entra directament.
  const urlPin = new URLSearchParams(location.search).get('pin');
  if (urlPin) history.replaceState(null, '', '/remote');
  const saved = urlPin || Gala.storageGet('gala.remotePin');
  if (saved) start(saved);
  else showLogin();
})();
