'use strict';
// Reductor pur: estat + event -> estat nou. Tota la lògica no determinista
// (rellotge, atzar) es resol abans i viatja dins l'event, de manera que
// reproduir el diari sempre dona el mateix estat.

// Events que canvien "on som" de l'espectacle (no els vots ni la pausa).
// navSeq permet rebutjar un GO pensat per a un estat que ja ha canviat
// (p. ex. el tècnic i el presentador prement GO alhora).
const NAV_EVENTS = [
  'cue.enter', 'cue.step', 'show.end', 'vote.open', 'vote.close', 'vote.force', 'vote.reset',
  'challenge.open', 'challenge.close', 'challenge.force', 'challenge.reset',
];

function initialState() {
  return {
    seq: 0,
    navSeq: 0,
    started: false,
    ended: false,
    cueId: null,
    enterSeq: 0,
    step: 0, // pas dins la cue actual (entrada, mencions, qüestionari)
    stepAt: null, // moment d'entrar al pas actual
    stepEndsAt: null, // fi del compte enrere del pas (pregunta oberta)
    history: [],
    paused: false,
    overlay: 'none', // none | black | hold
    votes: {}, // cueId -> { status, endsAt, ballots, result, reason, tied, counts }
    claims: {}, // participantId -> deviceId
    quiz: {}, // cueId -> { [pregunta]: { participantId: { option, ms } } }
    challenges: {}, // cueId -> { status, endsAt, taps, result, reason }
    wall: [], // missatges: { id, cueId, participantId, text, drawing, at, status }
  };
}

function applyEvent(state, ev) {
  const s = structuredClone(state);
  s.seq = ev.seq;
  if (NAV_EVENTS.includes(ev.type)) s.navSeq = ev.seq;
  switch (ev.type) {
    case 'cue.enter':
      if (ev.via === 'back') s.history.pop();
      else if (ev.via !== 'reenter' && s.cueId) s.history.push(s.cueId);
      s.cueId = ev.cueId;
      s.enterSeq = ev.seq;
      s.step = 0;
      s.stepAt = ev.t;
      s.stepEndsAt = null;
      s.started = true;
      s.ended = false;
      s.paused = false;
      break;
    case 'cue.step':
      s.step = ev.step;
      s.stepAt = ev.t;
      s.stepEndsAt = ev.endsAt || null;
      break;
    case 'step.extend':
      s.stepEndsAt = ev.endsAt;
      break;
    case 'show.end':
      s.ended = true;
      break;
    case 'playback.pause':
      s.paused = ev.paused;
      break;
    case 'overlay.set':
      s.overlay = ev.mode;
      break;
    case 'vote.open':
      s.votes[ev.cueId] = {
        status: 'open', endsAt: ev.endsAt, ballots: {}, result: null, reason: null, tied: false, counts: null,
      };
      break;
    case 'vote.ballot':
      s.votes[ev.cueId].ballots[ev.participantId] = ev.option;
      break;
    case 'vote.extend':
      s.votes[ev.cueId].endsAt = ev.endsAt;
      break;
    case 'vote.close': {
      const v = s.votes[ev.cueId];
      v.status = ev.result === null ? 'tie' : 'closed';
      v.result = ev.result;
      v.reason = ev.reason;
      v.tied = ev.tied;
      v.counts = ev.counts;
      v.endsAt = null;
      break;
    }
    case 'vote.force': {
      const v = s.votes[ev.cueId] ||
        { ballots: {}, counts: null, tied: false };
      v.status = 'closed';
      v.result = ev.result;
      v.reason = ev.source;
      v.endsAt = null;
      s.votes[ev.cueId] = v;
      break;
    }
    case 'vote.reset':
      delete s.votes[ev.cueId];
      break;
    case 'quiz.answer': {
      const quiz = s.quiz[ev.cueId] || (s.quiz[ev.cueId] = {});
      const answers = quiz[ev.q] || (quiz[ev.q] = {});
      answers[ev.participantId] = { option: ev.option, ms: ev.ms };
      break;
    }
    case 'quiz.reset':
      if (s.quiz[ev.cueId]) delete s.quiz[ev.cueId][ev.q];
      break;
    case 'challenge.open':
      s.challenges[ev.cueId] = {
        status: 'open', openedSeq: ev.seq, endsAt: ev.endsAt, taps: {}, result: null, reason: null,
      };
      break;
    case 'challenge.progress':
      Object.assign(s.challenges[ev.cueId].taps, ev.taps);
      break;
    case 'challenge.extend':
      s.challenges[ev.cueId].endsAt = ev.endsAt;
      break;
    case 'challenge.close': {
      const c = s.challenges[ev.cueId];
      Object.assign(c.taps, ev.taps || {});
      c.status = 'closed';
      c.result = ev.result;
      c.reason = ev.reason;
      c.endsAt = null;
      break;
    }
    case 'challenge.force': {
      const c = s.challenges[ev.cueId] || { taps: {} };
      c.status = 'closed';
      c.result = ev.result;
      c.reason = ev.source;
      c.endsAt = null;
      s.challenges[ev.cueId] = c;
      break;
    }
    case 'challenge.reset':
      delete s.challenges[ev.cueId];
      break;
    case 'wall.post':
      s.wall.push({
        id: ev.id, cueId: ev.cueId, participantId: ev.participantId, text: ev.text,
        // El dibuix (pot ser gran) el guarda el motor a part; aquí només si n'hi ha.
        drawing: !!ev.drawing, at: ev.t, status: ev.status,
      });
      break;
    case 'wall.moderate': {
      const m = s.wall.find((x) => x.id === ev.id);
      if (m) m.status = ev.status;
      break;
    }
    case 'participant.claim':
      // Un dispositiu només pot representar un participant.
      for (const pid of Object.keys(s.claims)) {
        if (s.claims[pid] === ev.deviceId) delete s.claims[pid];
      }
      s.claims[ev.participantId] = ev.deviceId;
      break;
    case 'participant.release':
      delete s.claims[ev.participantId];
      break;
    default:
      throw new Error('Event desconegut: ' + ev.type);
  }
  return s;
}

function countBallots(ballots, optionCount) {
  const counts = new Array(optionCount).fill(0);
  for (const pid of Object.keys(ballots)) {
    const o = ballots[pid];
    if (o >= 0 && o < optionCount) counts[o] += 1;
  }
  return counts;
}

module.exports = { initialState, applyEvent, countBallots };
