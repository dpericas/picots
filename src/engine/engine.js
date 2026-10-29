'use strict';
// Motor de l'espectacle: valida ordres, genera events, els desa al diari
// i manté l'estat. També gestiona el temporitzador de les votacions.

const { EventEmitter } = require('events');
const { initialState, applyEvent, countBallots } = require('./reducer');

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
    this.timer = null;
    this.state = initialState();
    const events = this.journal.readAll();
    for (const ev of events) {
      try {
        this.state = applyEvent(this.state, ev);
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
    clearTimeout(this.timer);
    this.timer = null;
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

  // Nombre de passos d'una cue (0 = no en té). Entrada: inici + un per nen + mosaic.
  stepCount(cue) {
    return cue && cue.type === 'parade' ? cue.people.length + 2 : 0;
  }

  stepLabel(cue, step) {
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
    const next = this.linearNext(cue);
    return next ? [next] : [];
  }

  record(type, data) {
    const ev = Object.assign({ seq: this.state.seq + 1, t: this.now(), type }, data);
    const nextState = applyEvent(this.state, ev);
    this.journal.append(ev);
    this.state = nextState;
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
        else if (go.action === 'step') this.record('cue.step', { cueId: s.cueId, step: go.step });
        else if (go.action === 'vote.open') this.openVote(this.currentCue());
        else if (go.action === 'vote.close') this.closeVote(this.currentCue(), 'operator');
        else if (go.action === 'end') this.record('show.end', {});
        else throw new CommandError(go.reason || 'No hi ha res a fer amb GO.');
        return;
      }
      case 'back': {
        if (s.ended) return this.enter(s.cueId, 'reenter');
        // Dins d'una cue amb passos, ENRERE torna al pas anterior.
        if (s.step > 0 && this.stepCount(this.currentCue()) > 0) {
          this.record('cue.step', { cueId: s.cueId, step: s.step - 1 });
          return;
        }
        if (s.history.length === 0) throw new CommandError('No hi ha cap cue anterior.');
        const target = s.history[s.history.length - 1];
        this.enter(target, 'back');
        // Tornant a una cue amb passos, es torna al darrer pas (on s'havia quedat).
        const count = this.stepCount(this.cue(target));
        if (count > 1) this.record('cue.step', { cueId: target, step: count - 1 });
        return;
      }
      case 'step': {
        const cue = this.currentCue();
        const count = this.stepCount(cue);
        if (!count) throw new CommandError('Aquesta cue no té passos.');
        const step = Number(cmd.step);
        if (!(Number.isInteger(step) && step >= 0 && step < count)) throw new CommandError('Pas no vàlid.');
        if (step !== s.step) this.record('cue.step', { cueId: cue.id, step });
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
    this.resume = null;
    this.position = null;
    this.recovered = false;
    this.syncTimers();
    this.emit('change', null);
    return archived;
  }

  syncTimers() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.timersEnabled) return;
    const cue = this.currentCue();
    const v = cue && cue.type === 'vote' ? this.state.votes[cue.id] : null;
    if (v && v.status === 'open' && v.endsAt) {
      const delay = Math.max(0, v.endsAt - this.now());
      this.timer = setTimeout(() => {
        this.timer = null;
        const r = this.dispatch({ name: 'vote.close', cueId: cue.id, reason: 'timer' });
        if (!r.ok) this.emit('warning', 'Tancament automàtic fallit: ' + r.error);
      }, delay);
    }
  }
}

module.exports = { Engine, CommandError };
