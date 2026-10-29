'use strict';
// Panell de control del tècnic.

(function () {
  const $ = (id) => document.getElementById(id);
  const el = Gala.el;
  const TYPE_LABEL = {
    video: 'VÍDEO', slides: 'FOTOS', vote: 'VOTACIÓ', hold: 'ESPERA', parade: 'ENTRADA',
    quiz: 'QÜESTIONARI', challenge: 'REPTE', awards: 'MENCIONS', wall: 'MUR',
  };
  const STEPS_TEXT = {
    parade: ['ENTRADA TRIOMFAL', 'GO = següent nen · ENRERE = l\'anterior · clic per saltar a qualsevol.'],
    awards: ['MENCIONS', 'GO = següent nen · ENRERE = l\'anterior · clic per saltar a qualsevol.'],
    quiz: ['PASSOS DEL QÜESTIONARI', 'Clic per saltar a qualsevol pas (obrir una pregunta torna a posar el temps).'],
  };
  const GO_LABEL = {
    'vote.open': 'obrir votació',
    'vote.close': 'tancar votació',
    'challenge.open': 'començar el repte',
    'challenge.close': 'aturar el repte',
    end: 'acabar l\'espectacle',
  };

  let state = null;
  let selected = null;
  let recoveredDismissed = false;

  const pin = new URLSearchParams(location.search).get('pin');
  const socket = new Gala.GalaSocket('control', {
    pin,
    onState: (s) => { state = s; render(); },
    onConnection: (ok) => {
      $('conn').textContent = ok ? 'Connectat' : 'Desconnectat';
      $('conn').className = 'pill ' + (ok ? 'ok' : 'bad');
    },
  });

  function toast(msg, kind) {
    const node = el('div', { class: 'toast ' + (kind || ''), text: msg });
    $('toasts').append(node);
    setTimeout(() => node.remove(), 4000);
  }

  async function send(cmd) {
    const r = await socket.cmd(cmd);
    if (!r.ok) {
      toast(r.error || 'Error');
      if (r.problems) r.problems.forEach((p) => toast((p.cueId ? '[' + p.cueId + '] ' : '') + p.msg));
    }
    return r;
  }

  // Botons perillosos: cal clicar dues vegades en 3 segons.
  function armed(button, action) {
    let timer = null;
    const original = button.textContent;
    button.addEventListener('click', () => {
      if (button.classList.contains('armed')) {
        clearTimeout(timer);
        button.classList.remove('armed');
        button.textContent = original;
        action();
        return;
      }
      button.classList.add('armed');
      button.textContent = 'Segur? Clica de nou';
      timer = setTimeout(() => {
        button.classList.remove('armed');
        button.textContent = original;
      }, 3000);
    });
  }

  function cueById(id) {
    return state && state.cues.find((c) => c.id === id);
  }

  function cueLabel(c) {
    return c ? (c.title || c.id) : '—';
  }

  // --- Accions ---
  // expectNav: si el presentador ja ha avançat, aquest GO no en fa un altre.
  const go = () => send({ name: 'go', expectNav: state && state.state.navSeq });
  const back = () => send({ name: 'back', expectNav: state && state.state.navSeq });
  const pause = () => send({ name: 'pause' });
  const overlay = (mode) => send({ name: 'overlay', mode: state && state.state.overlay === mode ? 'none' : mode });

  $('btn-go').addEventListener('click', go);
  $('btn-back').addEventListener('click', back);
  $('btn-pause').addEventListener('click', pause);
  armed($('btn-restart'), () => send({ name: 'restart' }));
  $('btn-black').addEventListener('click', () => overlay('black'));
  $('btn-hold').addEventListener('click', () => overlay('hold'));
  $('btn-normal').addEventListener('click', () => send({ name: 'overlay', mode: 'none' }));
  $('btn-vote-open').addEventListener('click', () => send({ name: 'vote.open' }));
  $('btn-vote-close').addEventListener('click', () => send({ name: 'vote.close' }));
  $('btn-vote-extend').addEventListener('click', () => send({ name: 'vote.extend', seconds: 15 }));
  armed($('btn-vote-reset'), () => send({ name: 'vote.reset' }));
  $('btn-quiz-extend').addEventListener('click', () => send({ name: 'quiz.extend', seconds: 15 }));
  armed($('btn-quiz-reset'), () => send({ name: 'quiz.reset' }));
  $('btn-ch-open').addEventListener('click', () => send({ name: 'challenge.open' }));
  $('btn-ch-close').addEventListener('click', () => send({ name: 'challenge.close' }));
  $('btn-ch-extend').addEventListener('click', () => send({ name: 'challenge.extend', seconds: 10 }));
  $('btn-ch-success').addEventListener('click', () => send({ name: 'challenge.force', result: 'success', source: 'manual' }));
  $('btn-ch-fail').addEventListener('click', () => send({ name: 'challenge.force', result: 'fail', source: 'manual' }));
  armed($('btn-ch-reset'), () => send({ name: 'challenge.reset' }));
  $('btn-wall-approve-all').addEventListener('click', () => {
    (state.wall ? state.wall.posts : []).filter((m) => m.status === 'pending')
      .forEach((m) => send({ name: 'wall.moderate', id: m.id, status: 'approved' }));
  });
  $('btn-reload').addEventListener('click', async () => {
    const r = await send({ name: 'show.reload' });
    if (r.ok) toast('Guió recarregat', 'info');
  });
  armed($('btn-reset'), () => send({ name: 'session.reset' }));
  armed($('btn-rehearsal'), () => send({ name: 'mode.set', mode: 'assaig', fresh: true }));
  armed($('btn-rehearsal-new'), () => send({ name: 'mode.set', mode: 'assaig', fresh: true }));
  armed($('btn-gala'), () => send({ name: 'mode.set', mode: 'gala' }));

  // --- Comprovació prèvia ---
  const ICON = { ok: '✅', warn: '⚠️', error: '❌' };
  async function batteryItem() {
    if (!navigator.getBattery) return null;
    try {
      const b = await navigator.getBattery();
      const pct = Math.round(b.level * 100);
      if (b.charging || b.level === 1) return { level: 'ok', title: 'Portàtil endollat (' + pct + '%)', detail: '' };
      return {
        level: 'error', title: 'El portàtil va amb BATERIA (' + pct + '%)',
        detail: 'Endolla\'l: la gala dura hores i la bateria pot reduir el rendiment.',
      };
    } catch (err) {
      return null;
    }
  }
  async function preflight() {
    const list = $('preflight-list');
    list.textContent = '';
    list.append(el('li', { class: 'hint', text: 'Comprovant…' }));
    if (!$('preflight-dialog').open) $('preflight-dialog').showModal();
    const r = await send({ name: 'preflight' });
    if (!r.ok) return;
    const items = r.report.items.slice();
    const bat = await batteryItem();
    if (bat) items.push(bat);
    const rank = { error: 0, warn: 1, ok: 2 };
    items.sort((a, b) => rank[a.level] - rank[b.level]);
    list.textContent = '';
    items.forEach((it) => list.append(el('li', { class: it.level }, [
      el('div', { class: 't', text: ICON[it.level] + ' ' + it.title }),
      it.detail ? el('div', { class: 'd', text: it.detail }) : null,
    ])));
  }
  $('btn-preflight').addEventListener('click', preflight);
  const openPrint = (page) => window.open(page + (pin ? '?pin=' + encodeURIComponent(pin) : ''), '_blank');
  $('btn-diplomas').addEventListener('click', () => openPrint('/diplomes'));
  $('btn-cards').addEventListener('click', () => openPrint('/targetes'));
  $('btn-preflight-again').addEventListener('click', preflight);
  $('btn-preflight-close').addEventListener('click', () => $('preflight-dialog').close());
  $('btn-test-sound').addEventListener('click', () => send({ name: 'screen.test', what: 'sound' }));
  $('btn-test-pattern').addEventListener('click', () => send({ name: 'screen.test', what: 'pattern' }));
  $('btn-test-off').addEventListener('click', () => send({ name: 'screen.test', what: 'off' }));
  $('recovered-ok').addEventListener('click', () => {
    recoveredDismissed = true;
    $('recovered').classList.add('hidden');
  });
  $('qr-dialog-close').addEventListener('click', () => $('qr-dialog').close());
  $('btn-remote-lock').addEventListener('click', () => {
    send({ name: 'remote.enable', enabled: !(state && state.remote.enabled) });
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select') || e.repeat) return;
    if (e.code === 'Space') { e.preventDefault(); go(); }
    else if (e.code === 'ArrowLeft' && e.shiftKey) { e.preventDefault(); back(); }
    else if (e.code === 'KeyP') pause();
    else if (e.code === 'KeyN') overlay('black');
    else if (e.code === 'KeyE') overlay('hold');
    else if (e.code === 'Escape') send({ name: 'overlay', mode: 'none' });
  });

  function showQr(url, text) {
    $('qr-dialog-img').src = '/api/qr.svg?text=' + encodeURIComponent(url);
    $('qr-dialog-text').textContent = text + ' — ' + url;
    $('qr-dialog').showModal();
  }

  // --- Pintat ---
  function renderRundown() {
    const s = state.state;
    const goTarget = state.go.action === 'enter' ? state.go.cueId : null;
    const visited = new Set(s.history.concat(s.cueId ? [s.cueId] : []));
    const list = $('rundown');
    list.textContent = '';
    state.cues.forEach((c, i) => {
      const classes = [];
      if (c.id === s.cueId) classes.push('current');
      if (c.id === goTarget) classes.push('next');
      if (visited.has(c.id)) classes.push('visited');
      if (c.id === selected) classes.push('selected');
      let branchText = null;
      if (c.options) branchText = c.options.map((o, j) => String.fromCharCode(65 + j) + '→' + o.goto).join('  ');
      if (c.outcomes) branchText = '✔→' + c.outcomes.success + '  ✘→' + (c.outcomes.fail || 'fi');
      const branches = branchText ? el('span', { class: 'branches', text: branchText }) : null;
      const li = el('li', { class: classes.join(' '), title: c.notes || '' }, [
        el('span', { class: 'type', text: (i + 1) + ' ' + (TYPE_LABEL[c.type] || c.type) }),
        el('span', {}, [cueLabel(c), branches]),
      ]);
      li.addEventListener('click', () => { selected = c.id; renderRundown(); });
      li.addEventListener('dblclick', () => send({ name: 'jump', cueId: c.id }));
      list.append(li);
    });
  }

  function renderNow() {
    const s = state.state;
    const cue = cueById(s.cueId);
    $('now-title').textContent = !s.started ? 'Encara no ha començat' : cueLabel(cue) + (s.ended ? ' (FI)' : '');
    const meta = [];
    if (cue) meta.push(TYPE_LABEL[cue.type] || cue.type, 'id: ' + cue.id);
    if (s.paused) meta.push('EN PAUSA');
    if (state.position) meta.push('posició ' + formatTime(state.position.t));
    if (cue && cue.steps) meta.push('pas ' + s.step + '/' + (cue.steps.length - 1) + ': ' + cue.steps[s.step]);
    $('now-meta').textContent = meta.join(' · ');
    $('now-notes').textContent = (cue && cue.notes) || '';
    $('now-script').textContent = cue && cue.script ? 'Presentador: «' + cue.script + '»' : '';

    const g = state.go;
    $('go-label').textContent = g.action === 'enter' ? '→ ' + cueLabel(cueById(g.cueId))
      : g.action === 'step' ? '→ ' + g.label
        : (GO_LABEL[g.action] || g.reason || '');
    $('btn-go').disabled = g.action === 'none';
    $('btn-back').disabled = !s.started || (s.history.length === 0 && !s.ended && !(s.step > 0));
    $('btn-pause').classList.toggle('active', s.paused);
    $('btn-black').classList.toggle('active', s.overlay === 'black');
    $('btn-hold').classList.toggle('active', s.overlay === 'hold');
    const ov = { none: '', black: 'PANTALLA NEGRA', hold: 'PANTALLA D\'ESPERA' }[s.overlay];
    $('overlay-state').textContent = ov;
    $('overlay-state').className = 'pill' + (ov ? ' warn' : ' hidden');
    $('next-title').textContent = g.action === 'enter' ? cueLabel(cueById(g.cueId))
      : g.action === 'step' ? g.label
        : (g.action === 'end' ? 'Fi de l\'espectacle' : '—');
    $('recovered').classList.toggle('hidden', !state.recovered || recoveredDismissed);
  }

  function renderVote() {
    const cue = cueById(state.state.cueId);
    const v = state.vote;
    $('vote-panel').classList.toggle('hidden', !v);
    if (!v) return;
    const statusText = { pending: 'pendent', open: 'OBERTA', closed: 'tancada', tie: 'EMPAT – tria el resultat' }[v.status];
    $('vote-status').textContent = '– ' + statusText + (v.reason ? ' (' + reasonText(v.reason) + ')' : '');
    $('vote-question').textContent = cue.title || cue.id;
    const table = $('vote-table');
    table.textContent = '';
    cue.options.forEach((o, i) => {
      const forceBtn = el('button', { text: 'Forçar', title: 'Decidir aquest resultat' });
      forceBtn.addEventListener('click', () => send({ name: 'vote.force', option: i, source: 'operator' }));
      const handBtn = el('button', { text: 'Mà alçada', title: 'Resultat del vot a mà alçada' });
      handBtn.addEventListener('click', () => send({ name: 'vote.force', option: i, source: 'manual' }));
      table.append(el('tr', { class: v.result === i && v.status === 'closed' ? 'winner' : '' }, [
        el('td', { text: String.fromCharCode(65 + i) + '. ' + o.text }),
        el('td', { class: 'hint', text: '→ ' + o.goto }),
        el('td', { class: 'n', text: String(v.counts[i] || 0) }),
        el('td', {}, [forceBtn, ' ', handBtn]),
      ]));
    });
    $('btn-vote-open').disabled = v.status !== 'pending';
    $('btn-vote-close').disabled = v.status !== 'open';
    $('btn-vote-extend').disabled = v.status !== 'open';
    $('btn-vote-reset').disabled = v.status === 'pending';
    updateTimer();
  }

  function renderSteps() {
    const cue = cueById(state.state.cueId);
    const steps = cue && cue.steps;
    $('steps-panel').classList.toggle('hidden', !steps);
    if (!steps) return;
    const texts = STEPS_TEXT[cue.type] || STEPS_TEXT.parade;
    $('steps-title').textContent = texts[0];
    $('steps-hint').textContent = texts[1];
    const current = state.state.step;
    $('steps-pos').textContent = '– ' + current + ' / ' + (steps.length - 1);
    const box = $('steps');
    box.textContent = '';
    steps.forEach((label, i) => {
      const cls = i === current ? 'current' : i === current + 1 ? 'next' : i < current ? 'done' : '';
      const hasVideo = cue.stepVideos && cue.stepVideos[i];
      const b = el('button', {
        class: cls,
        text: (i > 0 && i < steps.length - 1 ? i + '. ' : '') + label + (hasVideo ? ' 🎬' : ''),
        title: hasVideo ? 'Amb vídeo d\'entrada' : null,
      });
      b.addEventListener('click', () => send({ name: 'step', step: i }));
      box.append(b);
    });
  }

  function reasonText(r) {
    return {
      timer: 'temps esgotat', operator: 'operador', manual: 'mà alçada', no_votes: 'sense vots', goal: 'objectiu assolit',
    }[r] || r;
  }

  function renderQuiz() {
    const q = state.quiz;
    $('quiz-panel').classList.toggle('hidden', !q);
    if (!q) return;
    const KIND = { intro: 'inici', question: 'es llegeix', open: 'OBERTA', reveal: 'solució', ranking: 'classificació' };
    $('quiz-status').textContent = '– ' + (q.q != null ? 'P' + (q.q + 1) + '/' + q.total + ' ' : '') + KIND[q.kind] +
      (q.answeredBy ? ' · ' + q.answeredBy.length + '/' + q.expected + ' respostes' : '');
    $('quiz-question').textContent = q.question ? q.question.text : '';
    const table = $('quiz-table');
    table.textContent = '';
    if (q.question) {
      q.question.options.forEach((text, i) => {
        table.append(el('tr', { class: q.correct === i ? 'correct' : '' }, [
          el('td', { text: String.fromCharCode(65 + i) + '. ' + text + (q.correct === i ? '  ✔ correcta' : '') }),
          el('td', { class: 'n', text: String(q.counts ? q.counts[i] : 0) }),
        ]));
      });
    }
    $('btn-quiz-extend').disabled = q.kind !== 'open';
    $('btn-quiz-reset').disabled = q.q == null || !(q.answeredBy && q.answeredBy.length);
    const list = $('quiz-ranking');
    list.textContent = '';
    (q.top || []).forEach((r) => list.append(el('li', { text: r.name + ' – ' + r.points })));
  }

  function renderChallenge() {
    const c = state.challenge;
    $('challenge-panel').classList.toggle('hidden', !c);
    if (!c) return;
    const STATUS = { pending: 'pendent', open: 'EN MARXA', closed: c.result === 'success' ? 'SUPERAT' : 'NO SUPERAT' };
    $('ch-status').textContent = '– ' + STATUS[c.status] + (c.reason ? ' (' + reasonText(c.reason) + ')' : '');
    $('ch-progress').textContent = c.total + ' / ' + c.goal + (c.mode === 'all' ? ' nens a punt' : ' tocs') +
      ' · ' + c.players.length + ' participants';
    const cue = cueById(state.state.cueId);
    if (cue && cue.outcomes) {
      $('ch-routes').textContent = 'Superat → ' + cueLabel(cueById(cue.outcomes.success)) +
        ' · No superat → ' + (cue.outcomes.fail ? cueLabel(cueById(cue.outcomes.fail)) : 'fi');
    }
    $('btn-ch-open').disabled = c.status !== 'pending';
    $('btn-ch-close').disabled = c.status !== 'open';
    $('btn-ch-extend').disabled = c.status !== 'open';
    $('btn-ch-reset').disabled = c.status === 'pending';
  }

  function wallItem(m) {
    const buttons = [];
    const add = (text, status) => {
      const b = el('button', { text });
      b.addEventListener('click', () => send({ name: 'wall.moderate', id: m.id, status }));
      buttons.push(b);
    };
    if (m.status !== 'approved') add('✔ Aprovar', 'approved');
    if (m.status !== 'rejected') add(m.status === 'approved' ? 'Treure' : '✘ Rebutjar', 'rejected');
    return el('div', { class: 'wall-item ' + m.status }, [
      m.drawing ? el('img', { src: m.drawing, alt: 'dibuix' }) : null,
      el('div', { class: 'body' }, [
        el('div', { class: 'who', text: m.author.name + ' · ' + new Date(m.at).toLocaleTimeString('ca-ES') }),
        m.drawing ? null : el('div', { text: m.text }),
      ]),
    ].concat(buttons));
  }

  function renderWall() {
    const w = state.wall;
    $('wall-panel').classList.toggle('hidden', !w);
    if (!w) return;
    $('wall-status').textContent = '– ' + w.pending + ' pendents · ' + w.approved + ' a la pantalla' +
      (w.moderation ? '' : ' (sense moderació)');
    const pending = $('wall-pending');
    const done = $('wall-done');
    // No es repinta si no hi ha canvis, per no perdre el clic mentre es modera.
    const key = w.posts.map((m) => m.id + m.status).join(',');
    if (pending.dataset.key === key) return;
    pending.dataset.key = key;
    pending.textContent = '';
    done.textContent = '';
    w.posts.filter((m) => m.status === 'pending').forEach((m) => pending.append(wallItem(m)));
    if (!w.pending) pending.append(el('p', { class: 'hint', text: 'Cap missatge pendent.' }));
    w.posts.filter((m) => m.status !== 'pending').reverse().forEach((m) => done.append(wallItem(m)));
    $('btn-wall-approve-all').disabled = !w.pending;
  }

  function renderPhones() {
    $('join-url').textContent = state.joinUrl;
    const qrSrc = '/api/qr.svg?text=' + encodeURIComponent(state.joinUrl);
    if ($('join-qr').getAttribute('src') !== qrSrc) $('join-qr').src = qrSrc;
    const online = new Set(state.clients.filter((c) => c.role === 'play').map((c) => c.deviceId));
    const list = $('participants');
    list.textContent = '';
    let connected = 0;
    state.participants.forEach((p) => {
      const isOnline = p.deviceId && online.has(p.deviceId);
      if (isOnline) connected += 1;
      const qrBtn = el('button', { text: 'QR', title: 'QR personal' });
      qrBtn.addEventListener('click', () => showQr(p.personalUrl, p.name));
      const releaseBtn = el('button', { text: 'Alliberar', title: 'Deslliga el mòbil d\'aquest nen' });
      releaseBtn.disabled = !p.deviceId;
      releaseBtn.addEventListener('click', () => send({ name: 'release', participantId: p.id }));
      const voted = (state.vote && state.vote.voters.some((x) => x.id === p.id)) ||
        (state.quiz && state.quiz.answeredBy && state.quiz.answeredBy.some((x) => x.id === p.id));
      list.append(el('li', {}, [
        el('span', { class: 'dot' + (isOnline ? ' online' : p.deviceId ? ' claimed' : ''),
          title: isOnline ? 'connectat' : p.deviceId ? 'assignat però desconnectat' : 'sense mòbil' }),
        el('span', { class: 'name', text: p.name + (voted ? ' ✔' : '') }),
        qrBtn, releaseBtn,
      ]));
    });
    $('phones-count').textContent = connected + '/' + state.participants.length;
    const roles = {};
    state.clients.forEach((c) => { roles[c.role] = (roles[c.role] || 0) + 1; });
    $('client-roles').textContent = 'projector ' + (roles.screen || 0) + ', panells ' + (roles.control || 0) +
      ', mòbils ' + (roles.play || 0);
  }

  function renderRemote() {
    const r = state.remote;
    $('remote-status').textContent = r.connected ? '– connectat (' + r.connected + ')' : '– no connectat';
    $('remote-url').textContent = r.url;
    $('remote-hint').textContent = r.pinSet
      ? 'Escaneja-ho amb el mòbil del presentador i entra el PIN (xarxa.pin_presentador).'
      : 'Cal definir xarxa.pin_presentador a show.yaml per poder-lo fer servir.';
    const qrSrc = '/api/qr.svg?text=' + encodeURIComponent(r.url);
    if ($('remote-qr').getAttribute('src') !== qrSrc) $('remote-qr').src = qrSrc;
    $('btn-remote-lock').textContent = r.enabled ? '🔒 Bloquejar comandament' : '🔓 Desbloquejar comandament';
    $('btn-remote-lock').classList.toggle('locked', !r.enabled);

    const box = $('alerts');
    box.textContent = '';
    r.alerts.forEach((a) => {
      const ok = el('button', { text: 'Entesos' });
      ok.addEventListener('click', () => send({ name: 'alert.dismiss', id: a.id }));
      const time = new Date(a.at).toLocaleTimeString('ca-ES');
      box.append(el('div', { class: 'alert' }, [el('span', { text: '🆘 PRESENTADOR (' + time + '): ' + a.msg }), ok]));
    });
  }

  function renderProblems() {
    const list = $('problems');
    list.textContent = '';
    state.problems.forEach((p) => list.append(el('li', { class: p.level, text: (p.cueId ? '[' + p.cueId + '] ' : '') + p.msg })));
    if (state.problems.length === 0) list.append(el('li', { class: 'hint', text: 'Guió revisat: cap problema.' }));
    const errs = $('media-errors');
    errs.textContent = '';
    state.mediaErrors.forEach((m) => errs.append(el('li', { text: 'Projector: ' + (m.src || '') + ' ' + m.msg })));
  }

  function formatTime(t) {
    const s = Math.floor(t);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function left(endsAt) {
    return Math.max(0, Math.ceil((endsAt - socket.serverNow()) / 1000)) + ' s';
  }

  function updateTimer() {
    if (!state) return;
    const v = state.vote;
    $('vote-timer').textContent = v && v.status === 'open' && v.endsAt ? left(v.endsAt) : '';
    const q = state.quiz;
    $('quiz-timer').textContent = q && q.kind === 'open' && q.endsAt ? left(q.endsAt) : '';
    const c = state.challenge;
    $('ch-timer').textContent = c && c.status === 'open' && c.endsAt ? left(c.endsAt) : '';
  }

  setInterval(() => {
    $('clock').textContent = new Date().toLocaleTimeString('ca-ES');
    updateTimer();
  }, 250);

  function renderMode() {
    const rehearsal = state.mode === 'assaig';
    $('rehearsal-banner').classList.toggle('hidden', !rehearsal);
    $('mode-label').textContent = rehearsal ? 'ASSAIG' : 'GALA';
    $('btn-rehearsal').classList.toggle('hidden', rehearsal);
    $('btn-rehearsal-new').classList.toggle('hidden', !rehearsal);
    $('btn-gala').classList.toggle('hidden', !rehearsal);
  }

  function render() {
    $('title').textContent = state.title + ' – Control';
    renderMode();
    renderRundown();
    renderNow();
    renderVote();
    renderQuiz();
    renderChallenge();
    renderWall();
    renderSteps();
    renderPhones();
    renderRemote();
    renderProblems();
  }
})();
