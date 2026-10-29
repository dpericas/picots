'use strict';
// Vistes públiques de l'estat per a cada tipus de client.
// Cada client només rep el que necessita (els mòbils no veuen claus ni dispositius).

const { countBallots } = require('./reducer');
const { mediaUrl } = require('./show');
const quiz = require('./quiz');

// Missatges del mur que es mostren com a màxim a la pantalla.
const WALL_SCREEN_MAX = 24;

// Si no hi ha avatar del conte, la foto de l'entrada (millor que les inicials).
function participantPublic(p) {
  return { id: p.id, name: p.name, avatar: mediaUrl(p.avatar || p.photo) };
}

function cuePublic(cue, show) {
  if (!cue) return null;
  const out = { id: cue.id, type: cue.type, title: cue.title };
  if (cue.type === 'video') {
    out.src = mediaUrl(cue.file);
    out.auto = cue.auto;
    out.fade = cue.fade;
    out.caption = cue.caption;
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
  } else if (cue.type === 'awards') {
    out.text = cue.text;
    out.finalText = cue.finalText;
    out.music = mediaUrl(cue.music);
    out.effect = mediaUrl(cue.effect);
    out.people = cue.people.map((id) => {
      const p = show.participants.find((x) => x.id === id);
      return { id, name: p.name, photo: mediaUrl(p.photo || p.avatar), mention: cue.mentionFor[id] || '' };
    });
  } else if (cue.type === 'quiz') {
    out.text = cue.text;
    out.music = mediaUrl(cue.music);
    out.questionCount = cue.questions.length;
    out.ranking = cue.ranking;
  } else if (cue.type === 'challenge') {
    out.text = cue.text;
    out.music = mediaUrl(cue.music);
    out.mode = cue.mode;
  } else {
    // espera i mur
    out.text = cue.text;
    out.music = mediaUrl(cue.music);
  }
  return out;
}

function participantMap(engine) {
  return new Map(engine.show.participants.map((p) => [p.id, p]));
}

// Estat del qüestionari. `full` (panell del tècnic) inclou la resposta correcta sempre.
function quizSummary(engine, cue, full) {
  if (!cue || cue.type !== 'quiz') return null;
  const s = engine.state;
  const info = quiz.stepInfo(cue, s.step);
  const answersByQ = s.quiz[cue.id] || {};
  const byId = participantMap(engine);
  const out = {
    cueId: cue.id,
    kind: info.kind,
    q: info.q,
    total: cue.questions.length,
    endsAt: info.kind === 'open' ? s.stepEndsAt : null,
    expected: Object.keys(s.claims).length,
  };
  if (info.q != null) {
    const question = cue.questions[info.q];
    const answers = answersByQ[info.q] || {};
    out.question = {
      text: question.text,
      options: question.options,
      image: mediaUrl(question.image),
      duration: question.duration,
    };
    out.answeredBy = Object.keys(answers).filter((pid) => byId.has(pid)).map((pid) => participantPublic(byId.get(pid)));
    if (info.kind === 'reveal' || full) {
      out.correct = question.correct;
      out.counts = countBallots(Object.keys(answers).reduce((acc, pid) => {
        acc[pid] = answers[pid].option;
        return acc;
      }, {}), question.options.length);
    }
  }
  const showScores = info.kind === 'reveal' || info.kind === 'ranking' || full;
  if (showScores && (cue.ranking > 0 || full)) {
    const upTo = info.kind === 'reveal' || (full && info.q != null) ? info.q : null;
    const rows = quiz.ranking(quiz.scores(cue, answersByQ, upTo));
    out.top = (full ? rows : rows.slice(0, cue.ranking)).filter((r) => byId.has(r.id))
      .map((r) => Object.assign(participantPublic(byId.get(r.id)), { points: r.points, rank: r.rank }));
  }
  return out;
}

function challengeSummary(engine, cue) {
  if (!cue || cue.type !== 'challenge') return null;
  const c = engine.state.challenges[cue.id];
  const p = engine.challengeProgress(cue);
  const byId = participantMap(engine);
  return {
    cueId: cue.id,
    status: c ? c.status : 'pending',
    mode: cue.mode,
    duration: cue.duration,
    endsAt: c ? c.endsAt : null,
    total: p.total,
    goal: p.goal,
    result: c ? c.result : null,
    reason: c ? c.reason : null,
    players: p.pids.filter((pid) => byId.has(pid)).map((pid) => participantPublic(byId.get(pid))),
  };
}

function wallPost(engine, m, byId) {
  const p = byId.get(m.participantId);
  return {
    id: m.id,
    status: m.status,
    at: m.at,
    text: m.text,
    drawing: m.drawing ? '/api/mur/' + m.id : null,
    author: p ? participantPublic(p) : { id: m.participantId, name: m.participantId, avatar: null },
  };
}

// Mur: el projector només veu els missatges aprovats; el panell, tots.
function wallSummary(engine, cue, full) {
  if (!cue || cue.type !== 'wall') return null;
  const byId = participantMap(engine);
  const posts = engine.state.wall.filter((m) => m.cueId === cue.id);
  const approved = posts.filter((m) => m.status === 'approved');
  return {
    cueId: cue.id,
    moderation: cue.moderation,
    pending: posts.filter((m) => m.status === 'pending').length,
    approved: approved.length,
    posts: (full ? posts : approved.slice(-WALL_SCREEN_MAX)).map((m) => wallPost(engine, m, byId)),
  };
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
    quiz: quizSummary(engine, cue, false),
    challenge: challengeSummary(engine, cue),
    wall: wallSummary(engine, cue, false),
    resume: engine.resume,
    preload: preloadSources(engine),
    joinUrl: extra.joinUrl,
    mode: extra.mode || 'gala',
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
    quiz: meId ? playQuiz(engine, cue, meId) : null,
    challenge: meId ? playChallenge(engine, cue, meId) : null,
    wall: meId ? playWall(engine, cue, meId) : null,
  };
}

// Mòbil: la pregunta, la resposta pròpia i, a la solució, els punts propis.
function playQuiz(engine, cue, meId) {
  if (!cue || cue.type !== 'quiz') return null;
  const s = engine.state;
  const info = quiz.stepInfo(cue, s.step);
  const answersByQ = s.quiz[cue.id] || {};
  const out = { cueId: cue.id, kind: info.kind, q: info.q, total: cue.questions.length, endsAt: null };
  if (info.q != null) {
    const question = cue.questions[info.q];
    const mine = (answersByQ[info.q] || {})[meId];
    out.question = { text: question.text, options: question.options };
    out.myAnswer = mine ? mine.option : null;
    if (info.kind === 'open') out.endsAt = s.stepEndsAt;
    if (info.kind === 'reveal') {
      out.correct = question.correct;
      out.myPoints = quiz.points(question, mine);
    }
  }
  if ((info.kind === 'reveal' || info.kind === 'ranking') && cue.ranking > 0) {
    const upTo = info.kind === 'reveal' ? info.q : null;
    const rows = quiz.ranking(quiz.scores(cue, answersByQ, upTo));
    const row = rows.find((r) => r.id === meId);
    out.myTotal = row ? row.points : 0;
    out.myRank = row && row.rank <= cue.ranking ? row.rank : null;
  }
  return out;
}

function playChallenge(engine, cue, meId) {
  if (!cue || cue.type !== 'challenge') return null;
  const c = engine.state.challenges[cue.id];
  const p = engine.challengeProgress(cue);
  return {
    cueId: cue.id,
    status: c ? c.status : 'pending',
    mode: cue.mode,
    text: cue.text,
    endsAt: c ? c.endsAt : null,
    total: p.total,
    goal: p.goal,
    mine: p.taps[meId] || 0,
    result: c ? c.result : null,
  };
}

function playWall(engine, cue, meId) {
  if (!cue || cue.type !== 'wall') return null;
  const mine = engine.state.wall.filter((m) => m.cueId === cue.id && m.participantId === meId);
  return {
    cueId: cue.id,
    text: cue.text,
    drawings: cue.drawings,
    left: Math.max(0, cue.maxPerPerson - mine.filter((m) => m.status !== 'rejected').length),
    mine: mine.map((m) => ({ id: m.id, text: m.text, drawing: m.drawing, status: m.status })),
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
  else if (go.action === 'challenge.open') nextLabel = 'Començar el repte';
  else if (go.action === 'challenge.close') nextLabel = 'Aturar el repte';
  else if (go.action === 'end') nextLabel = 'Fi de l\'espectacle';
  const vote = voteSummary(engine, cue);
  return {
    serverNow: engine.now(),
    title: engine.show.title,
    navSeq: s.navSeq || 0,
    enabled: extra.enabled,
    mode: extra.mode || 'gala',
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
    quiz: remoteQuiz(engine, cue),
    challenge: remoteChallenge(engine, cue),
    wall: (() => {
      const w = wallSummary(engine, cue, true);
      return w && { pending: w.pending, approved: w.approved };
    })(),
  };
}

function remoteQuiz(engine, cue) {
  const q = quizSummary(engine, cue, true);
  if (!q) return null;
  return {
    kind: q.kind,
    q: q.q,
    total: q.total,
    endsAt: q.endsAt,
    question: q.question ? q.question.text : null,
    correct: q.question ? String.fromCharCode(65 + q.correct) + '. ' + q.question.options[q.correct] : null,
    answered: q.answeredBy ? q.answeredBy.length : 0,
    expected: q.expected,
    top: (q.top || []).slice(0, 3).map((r) => r.rank + '. ' + r.name + ' (' + r.points + ')'),
  };
}

function remoteChallenge(engine, cue) {
  const c = challengeSummary(engine, cue);
  return c && { status: c.status, total: c.total, goal: c.goal, endsAt: c.endsAt, result: c.result, mode: c.mode };
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
      outcomes: c.type === 'challenge'
        ? { success: engine.challengeTarget(c, 'success'), fail: engine.challengeTarget(c, 'fail') } : undefined,
      next: c.type === 'vote' || c.type === 'challenge' ? null : engine.linearNext(c),
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
    quiz: quizSummary(engine, cue, true),
    challenge: challengeSummary(engine, cue),
    wall: wallSummary(engine, cue, true),
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
    mode: extra.mode || 'gala',
    timing: extra.timing || null,
  };
}

module.exports = { screenView, playView, controlView, remoteView };
