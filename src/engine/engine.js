'use strict';
// Motor de l'espectacle: valida ordres, genera events, els desa al diari
// i manté l'estat. També gestiona el temporitzador de les votacions.

const { EventEmitter } = require('events');
const { initialState, applyEvent, countBallots } = require('./reducer');
const quiz = require('./quiz');

// Marge per a respostes que arriben just quan s'acaba el temps (latència de la xarxa).
const ANSWER_GRACE_MS = 800;
const TAP_FLUSH_MS = 1000;
const MAX_TAPS_PER_MSG = 20;
const WALL_MAX_TEXT = 100;
const WALL_MAX_DRAWING = 80000;
const WALL_COOLDOWN_MS = 3000;
const DRAWING_RE = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/;

class CommandError extends Error {}

class Engine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.show       guió normalitzat (show.js)
   * @param {object} opts.journal    FileJournal o MemoryJournal
   * @param {function} [opts.now]    rellotge (ms)
   * @param {function} [opts.random] atzar [0,1)
   * @param {boolean} [opts.timers]  false per desactivar temporitzadors (tests)
   * @param {object} [opts.position] darrera posició de vídeo coneguda
   * @param {function} [opts.keyFor] clau personal d'un participant (QR)
   */
  constructor(opts) {
    super();
    this.show = opts.show;
    this.journal = opts.journal;
    this.now = opts.now || Date.now;
    this.random = opts.random || Math.random;
    this.timersEnabled = opts.timers !== false;
    this.keyFor = opts.keyFor || null;
    this.timers = [];
    this.live = null; // tocs del repte en curs, abans de desar-los al diari
    this.drawings = new Map(); // id del missatge -> dibuix (data URL)
    this.state = initialState();
    const events = this.journal.readAll();
    for (const ev of events) {
      try {
        this.state = applyEvent(this.state, ev);
        this.absorb(ev);
      } catch (err) {
        this.emit('warning', 'Event ' + ev.seq + ' no aplicable en recuperar: ' + err.message);
      }
    }
    this.recovered = events.length > 0;
    // Punt on reprendre el vídeo després d'una recuperació.
    const p = opts.position;
    this.resume = this.matchesPosition(p) ? p : null;
    this.position = this.resume;
    this.syncTimers();
  }

  dispose() {
    this.clearTimers();
  }

  clearTimers() {
    this.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    this.timers = [];
  }

  // Dades dels events que no formen part de l'estat clonat.
  absorb(ev) {
    if (ev.type === 'wall.post' && ev.drawing) this.drawings.set(ev.id, ev.drawing);
  }

  cue(id) {
    return this.show.cues.find((c) => c.id === id) || null;
  }

  currentCue() {
    return this.state.cueId ? this.cue(this.state.cueId) : null;
  }

  // Cue que ve després en línia recta (null = fi de l'espectacle).
  linearNext(cue) {
    if (cue.next) return cue.next;
    const i = this.show.cues.indexOf(cue);
    return i >= 0 && i + 1 < this.show.cues.length ? this.show.cues[i + 1].id : null;
  }

  // Nombre de passos d'una cue (0 = no en té). Entrada i mencions: inici + un per nen + final.
  stepCount(cue) {
    if (!cue) return 0;
    if (cue.type === 'parade' || cue.type === 'awards') return cue.people.length + 2;
    if (cue.type === 'quiz') return quiz.stepCount(cue);
    return 0;
  }

  stepLabel(cue, step) {
    if (cue.type === 'quiz') return quiz.stepLabel(cue, step);
    if (step === 0) return 'Inici';
    if (step > cue.people.length) return 'Tots junts';
    const p = this.show.participants.find((x) => x.id === cue.people[step - 1]);
    return p ? p.name : cue.people[step - 1];
  }

  // Què farà el botó GO, per mostrar-ho al panell.
  describeGo() {
    const s = this.state;
    if (!s.started) return { action: 'enter', cueId: this.show.cues[0] && this.show.cues[0].id };
    if (s.ended) return { action: 'none' };
    const cue = this.currentCue();
    if (!cue) return { action: 'none' };
    if (s.step < this.stepCount(cue) - 1) {
      return { action: 'step', step: s.step + 1, label: this.stepLabel(cue, s.step + 1) };
    }
    if (cue.type === 'vote') {
      const v = s.votes[cue.id];
      if (!v) return { action: 'vote.open' };
      if (v.status === 'open') return { action: 'vote.close' };
      if (v.status === 'tie') return { action: 'none', reason: 'Empat: tria el resultat' };
      return { action: 'enter', cueId: cue.options[v.result].goto };
    }
    if (cue.type === 'challenge') {
      const c = s.challenges[cue.id];
      if (!c) return { action: 'challenge.open' };
      if (c.status === 'open') return { action: 'challenge.close' };
      const target = this.challengeTarget(cue, c.result);
      return target ? { action: 'enter', cueId: target } : { action: 'end' };
    }
    const next = this.linearNext(cue);
    return next ? { action: 'enter', cueId: next } : { action: 'end' };
  }

  // Cues que poden venir just després de l'actual (per precarregar vídeos).
  // En una votació encara no decidida, totes les branques.
  upcomingCueIds() {
    const s = this.state;
    if (!s.started) return this.show.cues.length ? [this.show.cues[0].id] : [];
    const cue = this.currentCue();
    if (!cue || s.ended) return [];
    if (cue.type === 'vote') {
      const v = s.votes[cue.id];
      if (v && v.status === 'closed') return [cue.options[v.result].goto];
      return Array.from(new Set(cue.options.map((o) => o.goto)));
    }
    if (cue.type === 'challenge') {
      const c = s.challenges[cue.id];
      const targets = c && c.status === 'closed' ? [this.challengeTarget(cue, c.result)]
        : [this.challengeTarget(cue, 'success'), this.challengeTarget(cue, 'fail')];
      return Array.from(new Set(targets.filter(Boolean)));
    }
    const next = this.linearNext(cue);
    return next ? [next] : [];
  }

  // Repte superat -> si_exit; no superat -> si_no o, si no n'hi ha, la cue de sota.
  challengeTarget(cue, result) {
    return result === 'success' ? cue.successGoto : (cue.failGoto || this.linearNext(cue));
  }

  record(type, data) {
    const ev = Object.assign({ seq: this.state.seq + 1, t: this.now(), type }, data);
    const nextState = applyEvent(this.state, ev);
    this.journal.append(ev);
    this.state = nextState;
    this.absorb(ev);
    if (type === 'cue.enter' || type === 'cue.step') {
      this.resume = null;
      this.position = null;
    }
    this.syncTimers();
    this.emit('change', ev);
    return ev;
  }

  dispatch(cmd) {
    try {
      this.execute(cmd || {});
      return { ok: true };
    } catch (err) {
      if (err instanceof CommandError) return { ok: false, error: err.message };
      throw err;
    }
  }

  participantOf(deviceId) {
    const s = this.state;
    const pid = Object.keys(s.claims).find((id) => s.claims[id] === deviceId);
    if (!pid) throw new CommandError('Primer has de triar qui ets.');
    return pid;
  }

  // Canvia de pas. Si el pas obre una pregunta del qüestionari, en fixa el final.
  goToStep(cue, step) {
    const data = { cueId: cue.id, step };
    if (cue.type === 'quiz') {
      const info = quiz.stepInfo(cue, step);
      if (info.kind === 'open') data.endsAt = this.now() + cue.questions[info.q].duration * 1000;
    }
    this.record('cue.step', data);
  }

  requireCue(type, message) {
    const cue = this.currentCue();
    if (!cue || cue.type !== type) throw new CommandError(message);
    return cue;
  }

  requireVoteCue(cueId) {
    const cue = cueId ? this.cue(cueId) : this.currentCue();
    if (!cue || cue.type !== 'vote') throw new CommandError('No hi ha cap votació en aquesta cue.');
    return cue;
  }

  enter(cueId, via) {
    if (!this.cue(cueId)) throw new CommandError('La cue "' + cueId + '" no existeix.');
    this.record('cue.enter', { cueId, via });
  }

  execute(cmd) {
    const s = this.state;
    // GO/ENRERE amb expectNav: només si ningú no ha avançat des que es va prémer.
    if ((cmd.name === 'go' || cmd.name === 'back') && cmd.expectNav != null && cmd.expectNav !== (s.navSeq || 0)) {
      throw new CommandError('Ja s\'ha avançat (algú altre ha premut). Mira on som i torna-ho a provar.');
    }
    switch (cmd.name) {
      case 'go': {
        const go = this.describeGo();
        if (go.action === 'enter') this.enter(go.cueId, s.started ? 'go' : 'start');
        else if (go.action === 'step') this.goToStep(this.currentCue(), go.step);
        else if (go.action === 'vote.open') this.openVote(this.currentCue());
        else if (go.action === 'vote.close') this.closeVote(this.currentCue(), 'operator');
        else if (go.action === 'challenge.open') this.openChallenge(this.currentCue());
        else if (go.action === 'challenge.close') this.closeChallenge(this.currentCue(), 'operator');
        else if (go.action === 'end') this.record('show.end', {});
        else throw new CommandError(go.reason || 'No hi ha res a fer amb GO.');
        return;
      }
      case 'back': {
        if (s.ended) return this.enter(s.cueId, 'reenter');
        // Dins d'una cue amb passos, ENRERE torna al pas anterior.
        if (s.step > 0 && this.stepCount(this.currentCue()) > 0) {
          this.goToStep(this.currentCue(), s.step - 1);
          return;
        }
        if (s.history.length === 0) throw new CommandError('No hi ha cap cue anterior.');
        const target = s.history[s.history.length - 1];
        this.enter(target, 'back');
        // Tornant a una cue amb passos, es torna al darrer pas (on s'havia quedat).
        const count = this.stepCount(this.cue(target));
        if (count > 1) this.goToStep(this.cue(target), count - 1);
        return;
      }
      case 'step': {
        const cue = this.currentCue();
        const count = this.stepCount(cue);
        if (!count) throw new CommandError('Aquesta cue no té passos.');
        const step = Number(cmd.step);
        if (!(Number.isInteger(step) && step >= 0 && step < count)) throw new CommandError('Pas no vàlid.');
        if (step !== s.step) this.goToStep(cue, step);
        return;
      }
      case 'jump':
        return this.enter(cmd.cueId, s.started ? 'jump' : 'start');
      case 'restart':
        if (!s.cueId) throw new CommandError('L\'espectacle no ha començat.');
        return this.enter(s.cueId, 'reenter');
      case 'pause':
        if (!s.cueId) throw new CommandError('L\'espectacle no ha començat.');
        this.record('playback.pause', { paused: cmd.paused != null ? !!cmd.paused : !s.paused });
        return;
      case 'overlay': {
        const mode = cmd.mode;
        if (!['none', 'black', 'hold'].includes(mode)) throw new CommandError('Mode de pantalla no vàlid.');
        if (mode !== s.overlay) this.record('overlay.set', { mode });
        return;
      }
      case 'vote.open':
        return this.openVote(this.requireVoteCue(cmd.cueId));
      case 'vote.close': {
        const cue = this.requireVoteCue(cmd.cueId);
        const v = s.votes[cue.id];
        if (!v || v.status !== 'open') throw new CommandError('La votació no està oberta.');
        return this.closeVote(cue, cmd.reason === 'timer' ? 'timer' : 'operator');
      }
      case 'vote.extend': {
        const cue = this.requireVoteCue(cmd.cueId);
        const v = s.votes[cue.id];
        if (!v || v.status !== 'open') throw new CommandError('La votació no està oberta.');
        const secs = Number(cmd.seconds) > 0 ? Number(cmd.seconds) : 15;
        const base = v.endsAt ? Math.max(v.endsAt, this.now()) : this.now();
        this.record('vote.extend', { cueId: cue.id, endsAt: base + secs * 1000 });
        return;
      }
      case 'vote.force': {
        const cue = this.requireVoteCue(cmd.cueId);
        const option = Number(cmd.option);
        if (!(option >= 0 && option < cue.options.length)) throw new CommandError('Opció no vàlida.');
        this.record('vote.force', {
          cueId: cue.id, result: option, source: cmd.source === 'manual' ? 'manual' : 'operator',
        });
        return;
      }
      case 'vote.reset': {
        const cue = this.requireVoteCue(cmd.cueId);
        if (s.votes[cue.id]) this.record('vote.reset', { cueId: cue.id });
        return;
      }
      case 'ballot':
        return this.ballot(cmd.deviceId, Number(cmd.option));
      case 'answer':
        return this.quizAnswer(cmd.deviceId, Number(cmd.option));
      case 'quiz.extend': {
        const cue = this.requireCue('quiz', 'No hi ha cap qüestionari en aquesta cue.');
        if (quiz.stepInfo(cue, s.step).kind !== 'open' || !s.stepEndsAt) {
          throw new CommandError('No hi ha cap pregunta oberta.');
        }
        const secs = Number(cmd.seconds) > 0 ? Number(cmd.seconds) : 15;
        this.record('step.extend', { cueId: cue.id, endsAt: Math.max(s.stepEndsAt, this.now()) + secs * 1000 });
        return;
      }
      case 'quiz.reset': {
        // Esborra les respostes d'una pregunta (p. ex. si han fallat els mòbils).
        const cue = this.requireCue('quiz', 'No hi ha cap qüestionari en aquesta cue.');
        const q = cmd.q != null ? Number(cmd.q) : quiz.stepInfo(cue, s.step).q;
        if (!(Number.isInteger(q) && q >= 0 && q < cue.questions.length)) throw new CommandError('Pregunta no vàlida.');
        if (s.quiz[cue.id] && s.quiz[cue.id][q]) this.record('quiz.reset', { cueId: cue.id, q });
        return;
      }
      case 'challenge.open':
        return this.openChallenge(this.requireCue('challenge', 'No hi ha cap repte en aquesta cue.'));
      case 'challenge.close': {
        const cue = this.requireCue('challenge', 'No hi ha cap repte en aquesta cue.');
        const c = s.challenges[cue.id];
        if (!c || c.status !== 'open') throw new CommandError('El repte no està en marxa.');
        return this.closeChallenge(cue, 'operator');
      }
      case 'challenge.extend': {
        const cue = this.requireCue('challenge', 'No hi ha cap repte en aquesta cue.');
        const c = s.challenges[cue.id];
        if (!c || c.status !== 'open') throw new CommandError('El repte no està en marxa.');
        const secs = Number(cmd.seconds) > 0 ? Number(cmd.seconds) : 10;
        this.record('challenge.extend', { cueId: cue.id, endsAt: Math.max(c.endsAt, this.now()) + secs * 1000 });
        return;
      }
      case 'challenge.force': {
        const cue = this.requireCue('challenge', 'No hi ha cap repte en aquesta cue.');
        if (!['success', 'fail'].includes(cmd.result)) throw new CommandError('Resultat no vàlid.');
        const c = s.challenges[cue.id];
        this.record('challenge.force', {
          cueId: cue.id, result: cmd.result, source: cmd.source === 'manual' ? 'manual' : 'operator',
          taps: c && c.status === 'open' ? this.liveTaps(cue) : undefined,
        });
        return;
      }
      case 'challenge.reset': {
        const cue = this.requireCue('challenge', 'No hi ha cap repte en aquesta cue.');
        if (s.challenges[cue.id]) this.record('challenge.reset', { cueId: cue.id });
        this.live = null;
        return;
      }
      case 'tap':
        return this.tap(cmd.deviceId, Number(cmd.n));
      case 'wall.post':
        return this.wallPost(cmd.deviceId, cmd.text, cmd.drawing);
      case 'wall.moderate': {
        const m = s.wall.find((x) => x.id === Number(cmd.id));
        if (!m) throw new CommandError('Missatge desconegut.');
        if (!['approved', 'rejected', 'pending'].includes(cmd.status)) throw new CommandError('Estat no vàlid.');
        if (m.status !== cmd.status) this.record('wall.moderate', { id: m.id, status: cmd.status });
        return;
      }
      case 'claim':
        return this.claim(cmd.deviceId, cmd.participantId, cmd.key);
      case 'release': {
        if (!this.show.participants.some((p) => p.id === cmd.participantId)) {
          throw new CommandError('Participant desconegut.');
        }
        if (cmd.deviceId && s.claims[cmd.participantId] !== cmd.deviceId) {
          throw new CommandError('Aquest dispositiu no representa aquest participant.');
        }
        if (s.claims[cmd.participantId]) this.record('participant.release', { participantId: cmd.participantId });
        return;
      }
      case 'video.ended': {
        // Ignora avisos endarrerits o repetits d'una cue anterior.
        const cue = this.currentCue();
        if (cue && cue.type === 'video' && cue.auto && cmd.cueId === s.cueId &&
            cmd.enterSeq === s.enterSeq && !s.ended) {
          this.execute({ name: 'go' });
        }
        return;
      }
      default:
        throw new CommandError('Ordre desconeguda: ' + cmd.name);
    }
  }

  openVote(cue) {
    const v = this.state.votes[cue.id];
    if (v) throw new CommandError('La votació ja s\'ha fet. Reinicia-la per repetir-la.');
    const endsAt = cue.duration > 0 ? this.now() + cue.duration * 1000 : null;
    this.record('vote.open', { cueId: cue.id, endsAt });
  }

  closeVote(cue, reason) {
    const v = this.state.votes[cue.id];
    const counts = countBallots(v.ballots, cue.options.length);
    const total = counts.reduce((a, b) => a + b, 0);
    let result;
    let tied = false;
    if (total === 0) {
      result = cue.defaultOption;
      reason = 'no_votes';
    } else {
      const max = Math.max.apply(null, counts);
      const winners = [];
      counts.forEach((c, i) => { if (c === max) winners.push(i); });
      if (winners.length === 1) {
        result = winners[0];
      } else {
        tied = true;
        if (cue.tie === 'first') result = winners[0];
        else if (cue.tie === 'random') result = winners[Math.floor(this.random() * winners.length)];
        else result = null;
      }
    }
    this.record('vote.close', { cueId: cue.id, counts, result, tied, reason });
  }

  ballot(deviceId, option) {
    const s = this.state;
    const participantId = Object.keys(s.claims).find((pid) => s.claims[pid] === deviceId);
    if (!participantId) throw new CommandError('Primer has de triar qui ets.');
    const cue = this.currentCue();
    const v = cue && cue.type === 'vote' ? s.votes[cue.id] : null;
    if (!v || v.status !== 'open') throw new CommandError('Ara no hi ha cap votació oberta.');
    if (!(option >= 0 && option < cue.options.length)) throw new CommandError('Opció no vàlida.');
    if (v.ballots[participantId] === option) return;
    this.record('vote.ballot', { cueId: cue.id, participantId, option });
  }

  quizAnswer(deviceId, option) {
    const s = this.state;
    const pid = this.participantOf(deviceId);
    const cue = this.currentCue();
    const info = cue && cue.type === 'quiz' ? quiz.stepInfo(cue, s.step) : null;
    if (!info || info.kind !== 'open') throw new CommandError('Ara no hi ha cap pregunta oberta.');
    const now = this.now();
    if (s.stepEndsAt && now > s.stepEndsAt + ANSWER_GRACE_MS) throw new CommandError('S\'ha acabat el temps!');
    const question = cue.questions[info.q];
    if (!(option >= 0 && option < question.options.length)) throw new CommandError('Opció no vàlida.');
    const answers = (s.quiz[cue.id] && s.quiz[cue.id][info.q]) || {};
    if (answers[pid]) throw new CommandError('Ja has respost aquesta pregunta.');
    const ms = Math.min(question.duration * 1000, Math.max(0, now - s.stepAt));
    this.record('quiz.answer', { cueId: cue.id, q: info.q, participantId: pid, option, ms });
    // Si ja han respost tots els que tenen mòbil, es passa a la solució.
    const answered = Object.keys(this.state.quiz[cue.id][info.q]).length;
    if (cue.closeWhenAll && answered >= Object.keys(s.claims).length) this.goToStep(cue, s.step + 1);
  }

  openChallenge(cue) {
    if (this.state.challenges[cue.id]) throw new CommandError('El repte ja s\'ha fet. Reinicia\'l per repetir-lo.');
    this.record('challenge.open', { cueId: cue.id, endsAt: this.now() + cue.duration * 1000 });
  }

  // Tocs del repte en curs: els desats al diari més els que encara no s'hi han desat.
  liveTaps(cue) {
    const c = this.state.challenges[cue.id];
    if (!c) return {};
    if (!this.live || this.live.cueId !== cue.id || this.live.openedSeq !== c.openedSeq) {
      this.live = { cueId: cue.id, openedSeq: c.openedSeq, taps: Object.assign({}, c.taps), dirty: false };
    }
    return this.live.taps;
  }

  challengeProgress(cue) {
    const c = this.state.challenges[cue.id];
    const taps = c && c.status === 'open' ? this.liveTaps(cue) : (c ? c.taps : {});
    const pids = Object.keys(taps).filter((pid) => taps[pid] > 0);
    const total = cue.mode === 'all' ? pids.length : pids.reduce((a, pid) => a + taps[pid], 0);
    // Modalitat "tots": l'objectiu són els nens que tenen mòbil.
    const goal = cue.mode === 'all' ? Math.max(1, Object.keys(this.state.claims).length) : cue.goal;
    return { taps, pids, total, goal, reached: total >= goal };
  }

  tap(deviceId, n) {
    const pid = this.participantOf(deviceId);
    const cue = this.currentCue();
    const c = cue && cue.type === 'challenge' ? this.state.challenges[cue.id] : null;
    if (!c || c.status !== 'open') throw new CommandError('Ara no hi ha cap repte en marxa.');
    const taps = this.liveTaps(cue);
    if (cue.mode === 'all') {
      if (taps[pid]) return;
      taps[pid] = 1;
    } else {
      const count = Number.isInteger(n) ? Math.min(MAX_TAPS_PER_MSG, Math.max(1, n)) : 1;
      taps[pid] = (taps[pid] || 0) + count;
    }
    this.live.dirty = true;
    if (this.challengeProgress(cue).reached) this.closeChallenge(cue, 'goal');
    else this.emit('live');
  }

  closeChallenge(cue, reason) {
    const p = this.challengeProgress(cue);
    this.record('challenge.close', {
      cueId: cue.id, taps: Object.assign({}, p.taps), result: p.reached ? 'success' : 'fail', reason,
    });
  }

  flushTaps() {
    const cue = this.currentCue();
    if (!this.live || !this.live.dirty || !cue || cue.id !== this.live.cueId) return;
    const c = this.state.challenges[cue.id];
    if (!c || c.status !== 'open') return;
    this.live.dirty = false;
    this.record('challenge.progress', { cueId: cue.id, taps: Object.assign({}, this.live.taps) });
  }

  wallPost(deviceId, text, drawing) {
    const s = this.state;
    const pid = this.participantOf(deviceId);
    const cue = this.requireCue('wall', 'Ara no es poden enviar missatges.');
    // Text d'una línia, sense caràcters de control.
    const clean = String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (clean.length > WALL_MAX_TEXT) throw new CommandError('El missatge és massa llarg.');
    if (drawing != null) {
      if (!cue.drawings) throw new CommandError('En aquest mur no es poden enviar dibuixos.');
      if (typeof drawing !== 'string' || drawing.length > WALL_MAX_DRAWING || !DRAWING_RE.test(drawing)) {
        throw new CommandError('El dibuix no és vàlid o és massa gran.');
      }
    }
    if (!clean && drawing == null) throw new CommandError('Escriu alguna cosa o fes un dibuix.');
    const mine = s.wall.filter((m) => m.cueId === cue.id && m.participantId === pid && m.status !== 'rejected');
    if (mine.length >= cue.maxPerPerson) {
      throw new CommandError('Ja has enviat ' + cue.maxPerPerson + ' missatges. Gràcies!');
    }
    const last = mine.length ? mine[mine.length - 1].at : 0;
    if (this.now() - last < WALL_COOLDOWN_MS) throw new CommandError('Espera uns segons abans d\'enviar-ne un altre.');
    this.record('wall.post', {
      id: s.seq + 1, cueId: cue.id, participantId: pid, text: clean,
      drawing: drawing == null ? undefined : drawing,
      status: cue.moderation ? 'pending' : 'approved',
    });
  }

  claim(deviceId, participantId, key) {
    if (!deviceId) throw new CommandError('Falta l\'identificador del dispositiu.');
    if (!this.show.participants.some((p) => p.id === participantId)) {
      throw new CommandError('Participant desconegut.');
    }
    const holder = this.state.claims[participantId];
    if (holder === deviceId) return;
    const validKey = key && this.keyFor && key === this.keyFor(participantId);
    if (holder && !validKey) throw new CommandError('Aquest nom ja l\'ha agafat un altre mòbil.');
    this.record('participant.claim', { participantId, deviceId });
  }

  // Una posició de vídeo només val per a la mateixa entrada a la cue i el mateix pas.
  matchesPosition(pos) {
    return !!pos && pos.cueId === this.state.cueId && pos.enterSeq === this.state.enterSeq &&
      (pos.step || 0) === this.state.step;
  }

  setPosition(pos) {
    if (this.matchesPosition(pos) && Number(pos.t) >= 0) {
      this.position = { cueId: pos.cueId, enterSeq: pos.enterSeq, step: pos.step || 0, t: Number(pos.t) };
    }
  }

  setShow(show) {
    this.show = show;
    this.syncTimers();
    this.emit('change', null);
  }

  // Comença una sessió nova (arxiva el diari actual).
  reset(stamp) {
    const archived = this.journal.archive(stamp);
    this.state = initialState();
    this.live = null;
    this.drawings.clear();
    this.resume = null;
    this.position = null;
    this.recovered = false;
    this.syncTimers();
    this.emit('change', null);
    return archived;
  }

  // Execució des d'un temporitzador: els errors només s'avisen.
  safely(what, fn) {
    try {
      fn();
    } catch (err) {
      this.emit('warning', what + ' fallit: ' + err.message);
    }
  }

  syncTimers() {
    this.clearTimers();
    if (!this.timersEnabled) return;
    const s = this.state;
    const cue = this.currentCue();
    if (!cue) return;
    const at = (when, fn) => this.timers.push(setTimeout(fn, Math.max(0, when - this.now())));
    const v = cue.type === 'vote' ? s.votes[cue.id] : null;
    if (v && v.status === 'open' && v.endsAt) {
      at(v.endsAt, () => {
        const r = this.dispatch({ name: 'vote.close', cueId: cue.id, reason: 'timer' });
        if (!r.ok) this.emit('warning', 'Tancament automàtic fallit: ' + r.error);
      });
    }
    // Pregunta oberta: en acabar el temps es passa a la solució.
    if (cue.type === 'quiz' && s.stepEndsAt && quiz.stepInfo(cue, s.step).kind === 'open') {
      const step = s.step;
      const enterSeq = s.enterSeq;
      at(s.stepEndsAt, () => {
        const now = this.state;
        if (now.cueId === cue.id && now.enterSeq === enterSeq && now.step === step) {
          this.safely('Tancament de la pregunta', () => this.goToStep(cue, step + 1));
        }
      });
    }
    const c = cue.type === 'challenge' ? s.challenges[cue.id] : null;
    if (c && c.status === 'open') {
      at(c.endsAt, () => {
        const cur = this.state.challenges[cue.id];
        if (this.state.cueId === cue.id && cur && cur.status === 'open') {
          this.safely('Final del repte', () => this.closeChallenge(cue, 'timer'));
        }
      });
      this.timers.push(setInterval(() => this.safely('Desar els tocs', () => this.flushTaps()), TAP_FLUSH_MS));
    }
  }
}

module.exports = { Engine, CommandError };
