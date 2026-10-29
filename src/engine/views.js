'use strict';
// Vistes públiques de l'estat per a cada tipus de client.
// Cada client només rep el que necessita (els mòbils no veuen claus ni dispositius).

const { countBallots } = require('./reducer');
const { mediaUrl } = require('./show');

function participantPublic(p) {
  return { id: p.id, name: p.name, avatar: mediaUrl(p.avatar) };
}

function cuePublic(cue) {
  if (!cue) return null;
  const out = { id: cue.id, type: cue.type, title: cue.title };
  if (cue.type === 'video') {
    out.src = mediaUrl(cue.file);
    out.auto = cue.auto;
    out.fade = cue.fade;
  } else if (cue.type === 'slides') {
    out.images = cue.images.map(mediaUrl);
    out.interval = cue.interval;
    out.music = mediaUrl(cue.music);
  } else if (cue.type === 'vote') {
    out.question = cue.question;
    out.options = cue.options.map((o) => o.text);
  } else {
    out.text = cue.text;
    out.music = mediaUrl(cue.music);
  }
  return out;
}

function voteSummary(engine, cue) {
  if (!cue || cue.type !== 'vote') return null;
  const v = engine.state.votes[cue.id];
  if (!v) return { cueId: cue.id, status: 'pending', counts: cue.options.map(() => 0), voters: [] };
  const byId = new Map(engine.show.participants.map((p) => [p.id, p]));
  return {
    cueId: cue.id,
    status: v.status,
    endsAt: v.endsAt,
    counts: v.counts || countBallots(v.ballots, cue.options.length),
    result: v.result,
    tied: v.tied,
    reason: v.reason,
    voters: Object.keys(v.ballots).filter((pid) => byId.has(pid)).map((pid) => participantPublic(byId.get(pid))),
  };
}

function screenView(engine, extra) {
  const s = engine.state;
  const cue = engine.currentCue();
  return {
    serverNow: engine.now(),
    title: engine.show.title,
    started: s.started,
    ended: s.ended,
    cue: cuePublic(cue),
    enterSeq: s.enterSeq,
    paused: s.paused,
    overlay: s.overlay,
    vote: voteSummary(engine, cue),
    resume: engine.resume,
    preload: preloadSources(engine),
    joinUrl: extra.joinUrl,
  };
}

// Vídeos que el projector ha de tenir carregats per poder-hi passar sense talls.
function preloadSources(engine) {
  return engine.upcomingCueIds()
    .map((id) => engine.cue(id))
    .filter((c) => c && c.type === 'video')
    .map((c) => mediaUrl(c.file));
}

function playView(engine, deviceId) {
  const s = engine.state;
  const cue = engine.currentCue();
  const meId = Object.keys(s.claims).find((pid) => s.claims[pid] === deviceId) || null;
  let vote = null;
  if (cue && cue.type === 'vote') {
    const v = s.votes[cue.id];
    vote = {
      cueId: cue.id,
      question: cue.question,
      options: cue.options.map((o) => o.text),
      status: v ? v.status : 'pending',
      endsAt: v ? v.endsAt : null,
      myBallot: v && meId && v.ballots[meId] != null ? v.ballots[meId] : null,
      result: v ? v.result : null,
    };
  }
  return {
    serverNow: engine.now(),
    title: engine.show.title,
    participants: engine.show.participants.map((p) => Object.assign(participantPublic(p), { taken: !!s.claims[p.id] })),
    me: meId,
    vote,
  };
}

function controlView(engine, extra) {
  const s = engine.state;
  const cue = engine.currentCue();
  return {
    serverNow: engine.now(),
    title: engine.show.title,
    cues: engine.show.cues.map((c) => ({
      id: c.id,
      type: c.type,
      title: c.title,
      notes: c.notes,
      options: c.type === 'vote' ? c.options.map((o) => ({ text: o.text, goto: o.goto })) : undefined,
      next: c.type === 'vote' ? null : engine.linearNext(c),
    })),
    state: {
      seq: s.seq,
      started: s.started,
      ended: s.ended,
      cueId: s.cueId,
      history: s.history,
      paused: s.paused,
      overlay: s.overlay,
    },
    go: engine.describeGo(),
    vote: voteSummary(engine, cue),
    position: engine.position,
    recovered: engine.recovered,
    participants: engine.show.participants.map((p) => Object.assign(participantPublic(p), {
      deviceId: s.claims[p.id] || null,
      personalUrl: extra.personalUrl(p.id),
    })),
    problems: extra.problems,
    clients: extra.clients,
    mediaErrors: extra.mediaErrors,
    joinUrl: extra.joinUrl,
  };
}

module.exports = { screenView, playView, controlView };
