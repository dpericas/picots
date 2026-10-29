'use strict';
// Vistes públiques de l'estat per a cada tipus de client.
// Cada client només rep el que necessita (els mòbils no veuen claus ni dispositius).

const { countBallots } = require('./reducer');
const { mediaUrl } = require('./show');

function participantPublic(p) {
  return { id: p.id, name: p.name, avatar: mediaUrl(p.avatar) };
}

function cuePublic(cue, show) {
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
  } else if (cue.type === 'parade') {
    out.text = cue.text;
    out.finalText = cue.finalText;
    out.music = mediaUrl(cue.music);
    out.effect = mediaUrl(cue.effect);
    out.nameOverVideo = cue.nameOverVideo;
    out.people = cue.people.map((id) => {
      const p = show.participants.find((x) => x.id === id);
      return { id, name: p.name, photo: mediaUrl(p.photo || p.avatar), video: mediaUrl(p.entryVideo) };
    });
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
    cue: cuePublic(cue, engine.show),
    enterSeq: s.enterSeq,
    step: s.step,
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
  const cue = engine.currentCue();
  const step = engine.state.step;
  // Entrada triomfal: el vídeo del nen següent (el pas k mostra people[k-1]).
  if (cue && cue.type === 'parade' && step < cue.people.length) {
    const next = engine.show.participants.find((p) => p.id === cue.people[step]);
    return next && next.entryVideo ? [mediaUrl(next.entryVideo)] : [];
  }
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

// Comandament del presentador: on som, què ve, què ha de dir i l'estat de la votació.
function remoteView(engine, extra) {
  const s = engine.state;
  const cue = engine.currentCue();
  const go = engine.describeGo();
  let nextLabel = null;
  if (go.action === 'enter') {
    const next = engine.cue(go.cueId);
    nextLabel = next ? (next.title || next.id) : go.cueId;
  } else if (go.action === 'step') nextLabel = go.label;
  else if (go.action === 'vote.open') nextLabel = 'Obrir la votació';
  else if (go.action === 'vote.close') nextLabel = 'Tancar la votació';
  else if (go.action === 'end') nextLabel = 'Fi de l\'espectacle';
  const vote = voteSummary(engine, cue);
  return {
    serverNow: engine.now(),
    title: engine.show.title,
    navSeq: s.navSeq || 0,
    enabled: extra.enabled,
    started: s.started,
    ended: s.ended,
    paused: s.paused,
    overlay: s.overlay,
    cue: cue ? {
      id: cue.id,
      type: cue.type,
      title: cue.title || cue.id,
      script: cue.script,
      stepLabel: engine.stepCount(cue) ? engine.stepLabel(cue, s.step) : null,
      stepPos: engine.stepCount(cue) ? s.step + '/' + (engine.stepCount(cue) - 1) : null,
    } : null,
    go: { action: go.action, label: nextLabel, reason: go.reason || null },
    canBack: s.started && (s.history.length > 0 || s.ended || s.step > 0),
    vote: vote && Object.assign({}, vote, {
      question: cue.question,
      options: cue.options.map((o) => o.text),
      voters: vote.voters.length,
      expected: Object.keys(s.claims).length,
    }),
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
      script: c.script,
      options: c.type === 'vote' ? c.options.map((o) => ({ text: o.text, goto: o.goto })) : undefined,
      next: c.type === 'vote' ? null : engine.linearNext(c),
      steps: engine.stepCount(c) ? Array.from({ length: engine.stepCount(c) }, (_, i) => engine.stepLabel(c, i)) : undefined,
      stepVideos: c.type === 'parade'
        ? [false].concat(c.people.map((id) => !!engine.show.participants.find((p) => p.id === id).entryVideo), [false])
        : undefined,
    })),
    state: {
      seq: s.seq,
      navSeq: s.navSeq || 0,
      started: s.started,
      ended: s.ended,
      cueId: s.cueId,
      step: s.step,
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
    remote: extra.remote,
    clients: extra.clients,
    mediaErrors: extra.mediaErrors,
    joinUrl: extra.joinUrl,
  };
}

module.exports = { screenView, playView, controlView, remoteView };
