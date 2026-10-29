'use strict';
// Reductor pur: estat + event -> estat nou. Tota la lògica no determinista
// (rellotge, atzar) es resol abans i viatja dins l'event, de manera que
// reproduir el diari sempre dona el mateix estat.

function initialState() {
  return {
    seq: 0,
    started: false,
    ended: false,
    cueId: null,
    enterSeq: 0,
    history: [],
    paused: false,
    overlay: 'none', // none | black | hold
    votes: {}, // cueId -> { status, endsAt, ballots, result, reason, tied, counts }
    claims: {}, // participantId -> deviceId
  };
}

function applyEvent(state, ev) {
  const s = structuredClone(state);
  s.seq = ev.seq;
  switch (ev.type) {
    case 'cue.enter':
      if (ev.via === 'back') s.history.pop();
      else if (ev.via !== 'reenter' && s.cueId) s.history.push(s.cueId);
      s.cueId = ev.cueId;
      s.enterSeq = ev.seq;
      s.started = true;
      s.ended = false;
      s.paused = false;
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
