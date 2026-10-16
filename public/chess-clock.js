(function (root) {
  'use strict';
  function create(seconds, players, now = Date.now(), incrementSeconds = 0, overtimeSeconds = 0) {
    return { initialMs: seconds * 1000, incrementMs: incrementSeconds * 1000,
      overtimeMs: overtimeSeconds * 1000, peakOvertimeMs: Array(players).fill(0),
      remainingMs: Array(players).fill(seconds * 1000), activePlayer: 0, startedAt: now };
  }
  function remaining(clock, player, now = Date.now()) {
    if (!clock) return null;
    const elapsed = clock.activePlayer === player && clock.startedAt !== null ? Math.max(0, now - clock.startedAt) : 0;
    return Math.max(clock.overtimeMs ? -clock.overtimeMs : 0, clock.remainingMs[player] - elapsed);
  }
  function settle(clock, now = Date.now()) {
    if (!clock || clock.activePlayer === null) return null;
    const player = clock.activePlayer;
    clock.remainingMs[player] = remaining(clock, player, now);
    if (clock.peakOvertimeMs) clock.peakOvertimeMs[player] = Math.max(clock.peakOvertimeMs[player], -clock.remainingMs[player]);
    clock.startedAt = now;
    return clock.remainingMs[player] <= -(clock.overtimeMs || 0) ? player : null;
  }
  function pause(clock, now = Date.now()) {
    const expired = settle(clock, now);
    if (clock) { clock.activePlayer = null; clock.startedAt = null; }
    return expired;
  }
  function start(clock, player, now = Date.now()) {
    if (!clock) return null;
    const expired = pause(clock, now);
    if (expired !== null) return expired;
    clock.activePlayer = player; clock.startedAt = now;
    return null;
  }
  function completeTurn(clock, now = Date.now()) {
    const player = clock?.activePlayer;
    const expired = pause(clock, now);
    // Overtime earns increment, but reaching the hard limit cannot be rescued.
    if (clock && player !== null && player !== undefined && expired === null) {
      clock.remainingMs[player] += clock.incrementMs || 0;
    }
    return expired;
  }
  function snapshot(clock, now = Date.now()) {
    if (!clock) return null;
    return { initialMs: clock.initialMs, incrementMs: clock.incrementMs || 0, overtimeMs: clock.overtimeMs || 0,
      peakOvertimeMs: clock.remainingMs.map((_, player) => Math.max(clock.peakOvertimeMs?.[player] || 0, -remaining(clock, player, now))), activePlayer: clock.activePlayer,
      remainingMs: clock.remainingMs.map((_, player) => remaining(clock, player, now)) };
  }
  function eligiblePlayers(scores, eliminated = []) {
    return scores.map((_, index) => index).filter(index => !eliminated[index]);
  }
  function winners(scores, eliminated = []) {
    const eligible = eligiblePlayers(scores, eliminated);
    const best = Math.max(...eligible.map(index => scores[index]));
    return eligible.filter(index => scores[index] === best);
  }
  function nextPlayer(player, count, eliminated = []) {
    for (let offset = 1; offset <= count; offset++) {
      const next = (player + offset) % count;
      if (!eliminated[next]) return next;
    }
    return null;
  }
  function penalties(clock) {
    return clock ? clock.remainingMs.map((_, player) => Math.ceil((clock.peakOvertimeMs?.[player] || 0) / 60000) * 10) : [];
  }
  function timeoutResult(scores, loserIdx, eliminated = [], overtimePenalties = []) {
    const excluded = eliminated.slice(); excluded[loserIdx] = true;
    const deductions = scores.map((_, index) => overtimePenalties[index] || 0);
    const finalScores = scores.map((score, index) => score - deductions[index]);
    const winnerIndices = winners(finalScores, excluded);
    return { reason: 'timeout', loserIdx, winnerIdx: winnerIndices[0], winnerIndices,
      finalScores, overtimePenalties: deductions, penalties: scores.map(() => 0), emptyPlayerIdx: null };
  }
  function format(ms) {
    const signedSeconds = Math.floor(ms / 1000);
    const seconds = Math.abs(signedSeconds);
    return `${signedSeconds < 0 ? '−' : ''}${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  const api = { create, remaining, settle, pause, start, completeTurn, snapshot, timeoutResult, format, penalties, eligiblePlayers, winners, nextPlayer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LexigonClock = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
