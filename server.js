'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
let WebSocketServer;
let WebSocket;
try {
  ({ WebSocketServer, WebSocket } = require('ws'));
} catch {
  // Allows the pure game engine to be tested without installed dependencies.
  WebSocket = { OPEN: 1 };
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_PATH = path.join(PUBLIC_DIR, 'index.html');
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 4;
const RACK_SIZE = 16;
const MIN_WORD_LENGTH = 1;
const WILDCARD = '_';
const WILDCARD_RATE = 0.02;
const DUEL_POOL_SIZE = 160;
const DEFAULT_BAG_BY_PLAYERS = { 2: 160, 3: 192, 4: 224 };
const MOD_RATES = { DL: 0.025, TL: 0.0125, DW: 0.025, TW: 0.0125 };
const WORD_MULTS = new Set(['DW', 'TW']);
const DUEL_MODS = new Set(['X2', 'X3', 'X4', 'X5']);
const DUEL_BOOST_PERCENTS = { X2: 10, X3: 20, X4: 30, X5: 50 };
const CHAT_MAX_LENGTH = 300;
const CHAT_HISTORY_LIMIT = 100;
const CHAT_RATE_LIMIT_MS = 350;

const LETTER_FREQS = {
  e: 0.10467, i: 0.08898, a: 0.08838, o: 0.07503, r: 0.07135,
  n: 0.07028, t: 0.06738, s: 0.06172, l: 0.05788, c: 0.04552,
  u: 0.03900, p: 0.03436, m: 0.03136, d: 0.03051, h: 0.02820,
  y: 0.02283, g: 0.02097, b: 0.01807, f: 0.01091, v: 0.00903,
  k: 0.00731, w: 0.00631, z: 0.00375, x: 0.00311, q: 0.00167,
  j: 0.00141,
};

const POINTS = {
  e: 1, i: 1, a: 1, o: 1, r: 1, n: 1, t: 1, s: 1,
  l: 2, c: 2,
  u: 3, p: 3,
  m: 4, d: 4, h: 4,
  y: 5, g: 5, b: 5,
  f: 6, v: 6,
  k: 7, w: 7,
  z: 8, x: 8,
  j: 9, q: 10,
  _: 0,
};

const rooms = new Map();

// The browser and server intentionally use the exact same embedded dictionary.
// The base list is gzip/base64 inside public/index.html; the small runtime extra
// word arrays are parsed from that same file too, so they cannot silently drift.
function loadDictionaryFromClient() {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const b64Match = html.match(/<script\s+id=["']dictData["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!b64Match) throw new Error('Could not find embedded dictionary in public/index.html');
  const text = zlib.gunzipSync(Buffer.from(b64Match[1].trim(), 'base64')).toString('utf8');
  const dictionary = new Set(text.split('\n').map(w => w.trim()).filter(w => w.length >= MIN_WORD_LENGTH));

  for (const constName of ['ONE_LETTER_WORDS', 'EXTRA_WORDS']) {
    const block = html.match(new RegExp(`const\\s+${constName}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
    if (!block) continue;
    for (const match of block[1].matchAll(/'([^']+)'/g)) dictionary.add(match[1].toLowerCase());
  }

  const byLength = Array.from({ length: RACK_SIZE + 1 }, () => []);
  for (const word of dictionary) {
    if (word.length <= RACK_SIZE) byLength[word.length].push(word);
  }
  return { dictionary, byLength };
}

const { dictionary: DICTIONARY, byLength: DICTIONARY_BY_LENGTH } = loadDictionaryFromClient();
const RACK_PLAYABILITY_CACHE = new Map();
console.log(`Loaded ${DICTIONARY.size.toLocaleString()} Lexigon words for authoritative validation.`);

function clampInteger(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function cleanUsername(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, 20);
}

function cleanRoomCode(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function cleanChatMessage(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LENGTH);
}

function randomRoomCode(length = 4) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = '';
    for (let i = 0; i < length; i++) code += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Could not allocate a unique room code');
}

function defaultSettings() {
  return { mode: 'classic', playerCount: 2, bagSize: 160, minPerLetter: 1, startingHP: 200 };
}

function roomCapacity(room) {
  return room.settings.mode === 'duel' ? 2 : room.settings.playerCount;
}

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function sendError(ws, message) {
  send(ws, { type: 'error', message });
}

function shuffleArr(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeTileDistribution(totalTiles, minPerLetter) {
  const letters = Object.keys(LETTER_FREQS);
  const reserved = letters.length * minPerLetter;
  const wildcards = totalTiles >= 1 ? Math.max(1, Math.round(totalTiles * WILDCARD_RATE)) : 0;
  const letterTiles = totalTiles - wildcards;
  if (letterTiles < reserved) return null;

  const counts = Object.fromEntries(letters.map(letter => [letter, minPerLetter]));
  const remaining = letterTiles - reserved;
  if (remaining > 0) {
    const totalFreq = letters.reduce((sum, letter) => sum + LETTER_FREQS[letter], 0);
    const shares = letters.map(letter => {
      const ideal = (remaining * LETTER_FREQS[letter]) / totalFreq;
      return { letter, floor: Math.floor(ideal), remainder: ideal - Math.floor(ideal) };
    });
    let allocated = 0;
    for (const share of shares) {
      counts[share.letter] += share.floor;
      allocated += share.floor;
    }
    const leftover = remaining - allocated;
    shares.sort((a, b) => b.remainder - a.remainder)
      .slice(0, leftover)
      .forEach(share => { counts[share.letter] += 1; });
  }
  if (wildcards > 0) counts[WILDCARD] = wildcards;
  return counts;
}

function makeBag(counts) {
  const bag = [];
  for (const [letter, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i++) bag.push({ letter, mod: null });
  }
  return bag;
}

function assignModifiers(bag, totalTiles) {
  const remaining = {
    DL: totalTiles >= 1 ? Math.max(1, Math.round(totalTiles * MOD_RATES.DL)) : 0,
    TL: totalTiles >= 1 ? Math.max(1, Math.round(totalTiles * MOD_RATES.TL)) : 0,
    DW: totalTiles >= 1 ? Math.max(1, Math.round(totalTiles * MOD_RATES.DW)) : 0,
    TW: totalTiles >= 1 ? Math.max(1, Math.round(totalTiles * MOD_RATES.TW)) : 0,
  };

  function candidatesFor(eligible) {
    const candidates = [];
    for (let i = 0; i < bag.length; i++) {
      if (bag[i].mod === null && eligible(bag[i])) candidates.push(i);
    }
    return shuffleArr(candidates);
  }
  function assignAt(index, modType) {
    if (index === undefined || remaining[modType] <= 0 || bag[index].mod !== null) return false;
    bag[index].mod = modType;
    remaining[modType] -= 1;
    return true;
  }
  function assignPreferredFirst(modType, eligible) {
    if (remaining[modType] < 2) return;
    const candidates = candidatesFor(eligible);
    if (candidates.length) assignAt(candidates[0], modType);
  }
  function assignRemaining(modType, eligible) {
    const candidates = candidatesFor(eligible);
    const count = Math.min(remaining[modType], candidates.length);
    for (let i = 0; i < count; i++) assignAt(candidates[i], modType);
  }

  assignPreferredFirst('DW', tile => tile.letter !== WILDCARD && POINTS[tile.letter] === 1);
  assignPreferredFirst('TW', tile => tile.letter !== WILDCARD && POINTS[tile.letter] === 1);
  assignPreferredFirst('DL', tile => tile.letter !== WILDCARD && POINTS[tile.letter] >= 5);
  assignPreferredFirst('TL', tile => tile.letter !== WILDCARD && POINTS[tile.letter] >= 5);
  assignRemaining('DL', tile => tile.letter !== WILDCARD);
  assignRemaining('TL', tile => tile.letter !== WILDCARD);
  assignRemaining('DW', () => true);
  assignRemaining('TW', () => true);
}

function duelBaseValue(letter) {
  const points = POINTS[letter] || 0;
  if (points <= 0) return 0;
  if (points === 1) return 1;
  if (points <= 3) return 2;
  if (letter === 'm') return 2;
  if (points <= 5) return 3;
  if (points <= 7) return 4;
  return 5;
}

function duelBoostPercent(mod) {
  return mod && DUEL_MODS.has(mod) ? (DUEL_BOOST_PERCENTS[mod] || 0) : 0;
}

function calcWordScore(mode, tiles) {
  let letterSum = 0;
  let wordMult = 1;
  let boostPercent = 0;
  for (const tile of tiles) {
    let points = mode === 'duel' ? duelBaseValue(tile.letter) : POINTS[tile.letter];
    if (mode === 'duel') {
      boostPercent += duelBoostPercent(tile.mod);
    } else {
      if (tile.mod === 'DL') points *= 2;
      else if (tile.mod === 'TL') points *= 3;
      if (tile.mod === 'DW') wordMult *= 2;
      else if (tile.mod === 'TW') wordMult *= 3;
    }
    letterSum += points;
  }

  const baseLengthBonus = Math.max(0, (tiles.length - 6) * 5) + (tiles.length === 16 ? 10 : 0);
  if (mode === 'duel') {
    return {
      letterSum,
      wordMult: 1,
      lengthBonus: 0,
      boostPercent,
      total: Math.ceil(letterSum * (1 + boostPercent / 100)),
    };
  }
  return {
    letterSum,
    wordMult,
    lengthBonus: baseLengthBonus,
    boostPercent: 0,
    total: letterSum * wordMult + baseLengthBonus,
  };
}

function duelRewardForLength(length) {
  if (length >= 10) return 'X5';
  if (length === 9) return 'X4';
  if (length === 8) return 'X3';
  if (length === 7) return 'X2';
  return null;
}

function duelRewardForBaseDamage(baseDamage) {
  if (baseDamage >= 17) return 'X5';
  if (baseDamage >= 15) return 'X4';
  if (baseDamage >= 13) return 'X3';
  if (baseDamage >= 12) return 'X2';
  return null;
}

function tryResolutions(word, startIdx = 0) {
  const idx = word.indexOf(WILDCARD, startIdx);
  if (idx === -1) return DICTIONARY.has(word) ? word : null;
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(97 + i);
    const candidate = word.substring(0, idx) + letter + word.substring(idx + 1);
    const result = tryResolutions(candidate, idx + 1);
    if (result) return result;
  }
  return null;
}

function resolveWord(word) {
  if (!word.includes(WILDCARD)) return DICTIONARY.has(word) ? word : null;
  return tryResolutions(word, 0);
}

function rackHasPlayableWord(targetRack) {
  if (!targetRack) return false;
  const cacheKey = targetRack.filter(Boolean).map(tile => tile.letter).sort().join('');
  if (RACK_PLAYABILITY_CACHE.has(cacheKey)) return RACK_PLAYABILITY_CACHE.get(cacheKey);

  const rackCounts = new Uint8Array(26);
  const needCounts = new Uint8Array(26);
  const touched = [];
  let blanks = 0;
  let tileCount = 0;

  for (const tile of targetRack) {
    if (!tile) continue;
    tileCount++;
    if (tile.letter === WILDCARD) blanks++;
    else {
      const code = tile.letter.charCodeAt(0) - 97;
      if (code >= 0 && code < 26) rackCounts[code]++;
    }
  }

  for (let len = MIN_WORD_LENGTH; len <= Math.min(tileCount, RACK_SIZE); len++) {
    for (const word of DICTIONARY_BY_LENGTH[len]) {
      touched.length = 0;
      let validLetters = true;
      for (let i = 0; i < word.length; i++) {
        const code = word.charCodeAt(i) - 97;
        if (code < 0 || code >= 26) { validLetters = false; break; }
        if (needCounts[code] === 0) touched.push(code);
        needCounts[code]++;
      }
      let missing = 0;
      if (validLetters) {
        for (const code of touched) {
          if (needCounts[code] > rackCounts[code]) missing += needCounts[code] - rackCounts[code];
        }
      } else {
        missing = blanks + 1;
      }
      for (const code of touched) needCounts[code] = 0;
      if (missing <= blanks) {
        RACK_PLAYABILITY_CACHE.set(cacheKey, true);
        return true;
      }
    }
  }
  RACK_PLAYABILITY_CACHE.set(cacheKey, false);
  return false;
}

function calcTilePenalty(tile) {
  if (!tile) return 0;
  const base = tile.letter === WILDCARD ? 10 : (POINTS[tile.letter] || 0);
  let mult = 1;
  if (tile.mod === 'DL' || tile.mod === 'DW') mult = 2;
  else if (tile.mod === 'TL' || tile.mod === 'TW') mult = 3;
  return base * mult;
}

function rackIsEmpty(rack) {
  return rack.every(tile => tile === null);
}

function computeClassicEndResult(game, reason) {
  const penalties = game.racks.map(rack => rack.reduce((sum, tile) => sum + calcTilePenalty(tile), 0));
  const emptyPlayerIdx = reason === 'empty_rack' ? game.racks.findIndex(rackIsEmpty) : -1;
  const finalScores = game.scores.slice();
  for (let i = 0; i < game.numPlayers; i++) finalScores[i] -= penalties[i];
  if (emptyPlayerIdx >= 0) {
    let bonus = 0;
    for (let i = 0; i < game.numPlayers; i++) if (i !== emptyPlayerIdx) bonus += penalties[i];
    finalScores[emptyPlayerIdx] += bonus;
  }
  return {
    reason,
    emptyPlayerIdx: emptyPlayerIdx >= 0 ? emptyPlayerIdx : null,
    penalties,
    finalScores,
  };
}

function classicEndReason(game) {
  if (game.mode !== 'classic' || game.gameOver) return null;
  if (game.racks.some(rackIsEmpty)) return 'empty_rack';
  if (game.racks.length && !game.racks.some(rackHasPlayableWord)) return 'no_valid_words';
  return null;
}

function rackHasWordMult(rack) {
  return rack.some(tile => tile && WORD_MULTS.has(tile.mod));
}

function drawFromClassicBag(game, restrictMults) {
  for (let i = 0; i < game.bag.length; i++) {
    const tile = game.bag[i];
    if (restrictMults && WORD_MULTS.has(tile.mod)) continue;
    return game.bag.splice(i, 1)[0];
  }
  return null;
}

function refillDuelBag(game) {
  game.bag = makeBag(game.distribution);
  shuffleArr(game.bag);
  return game.bag.length > 0;
}

function drawDuelTile(game) {
  if (game.bag.length === 0 && !refillDuelBag(game)) return null;
  const raw = game.bag.pop();
  if (!raw) return null;
  const roll = crypto.randomInt(64);
  const mod = roll === 0 ? 'X3' : roll <= 2 ? 'X2' : null; // 1/64 purple, 2/64 blue.
  return { letter: raw.letter, mod };
}

function refillRack(game, targetRack, guaranteedMods = []) {
  const newIndices = [];
  if (game.mode === 'duel') {
    const emptyIndices = [];
    for (let i = 0; i < RACK_SIZE; i++) if (targetRack[i] === null) emptyIndices.push(i);
    for (const index of emptyIndices) {
      const tile = drawDuelTile(game);
      if (tile) {
        targetRack[index] = tile;
        newIndices.push(index);
      }
    }

    const rewards = (Array.isArray(guaranteedMods) ? guaranteedMods : [guaranteedMods]).filter(Boolean);
    const rewardCandidates = emptyIndices.filter(index => targetRack[index]);
    const modRank = { X2: 1, X3: 2, X4: 3, X5: 4 };
    for (const guaranteedMod of rewards) {
      if (!rewardCandidates.length) break;
      const candidatePos = crypto.randomInt(rewardCandidates.length);
      const rewardIndex = rewardCandidates.splice(candidatePos, 1)[0];
      const existingMod = targetRack[rewardIndex].mod;
      if (!existingMod || (modRank[guaranteedMod] || 0) > (modRank[existingMod] || 0)) {
        targetRack[rewardIndex].mod = guaranteedMod;
      }
    }
    return newIndices;
  }

  for (let i = 0; i < RACK_SIZE; i++) {
    if (targetRack[i] !== null) continue;
    const tile = drawFromClassicBag(game, rackHasWordMult(targetRack));
    if (tile) {
      targetRack[i] = tile;
      newIndices.push(i);
    }
  }
  return newIndices;
}

function createGame(settings, playerCount) {
  const mode = settings.mode;
  const game = {
    mode,
    numPlayers: playerCount,
    startingHP: settings.startingHP,
    distribution: null,
    modSummary: { DL: 0, TL: 0, DW: 0, TW: 0 },
    bag: [],
    racks: [],
    scores: new Array(playerCount).fill(0),
    words: new Array(playerCount).fill(0),
    health: new Array(playerCount).fill(settings.startingHP),
    currentPlayer: 0,
    discardUsedThisTurn: false,
    history: [],
    lastPlay: null,
    gameOver: false,
    endResult: null,
    newlyDrawn: Array.from({ length: playerCount }, () => []),
    revision: 1,
    startedAt: Date.now(),
  };

  if (mode === 'duel') {
    game.distribution = makeTileDistribution(DUEL_POOL_SIZE, 1);
    if (!game.distribution) throw new Error('Could not construct Duel letter distribution.');
    refillDuelBag(game);
  } else {
    game.distribution = makeTileDistribution(settings.bagSize, settings.minPerLetter);
    if (!game.distribution) {
      const wildcards = settings.bagSize >= 1 ? Math.max(1, Math.round(settings.bagSize * WILDCARD_RATE)) : 0;
      const needed = 26 * settings.minPerLetter + wildcards;
      throw new Error(`Bag is too small. Need at least ${needed} tiles for that minimum-per-letter setting.`);
    }
    game.bag = makeBag(game.distribution);
    assignModifiers(game.bag, settings.bagSize);
    for (const tile of game.bag) if (tile.mod) game.modSummary[tile.mod]++;
    shuffleArr(game.bag);
  }

  for (let i = 0; i < playerCount; i++) {
    const rack = new Array(RACK_SIZE).fill(null);
    game.racks.push(rack);
    game.newlyDrawn[i] = refillRack(game, rack);
  }
  return game;
}

function sanitizeIndices(value, { max = RACK_SIZE, maxCount = RACK_SIZE } = {}) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxCount) return null;
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= max || seen.has(index)) return null;
    seen.add(index);
    out.push(index);
  }
  return out;
}

function clearNewlyDrawn(game) {
  game.newlyDrawn = Array.from({ length: game.numPlayers }, () => []);
}

function finishClassicIfNeeded(game, room = null) {
  const reason = classicEndReason(game);
  if (!reason) return false;
  game.gameOver = true;
  game.endResult = computeClassicEndResult(game, reason);

  if (room && game.endResult?.finalScores?.length) {
    let winnerIdx = 0;
    for (let i = 1; i < game.endResult.finalScores.length; i++) {
      if (game.endResult.finalScores[i] > game.endResult.finalScores[winnerIdx]) winnerIdx = i;
    }
    const winner = room.players[winnerIdx];
    if (winner) addSystemMessage(room, `Game Over. ${winner.username} won!`, 'classic_game_over', { winnerId: winner.id });
  }
  return true;
}

function advanceTurn(game) {
  game.currentPlayer = (game.currentPlayer + 1) % game.numPlayers;
  game.discardUsedThisTurn = false;
}

function requireGameTurn(ws) {
  const membership = requireMembership(ws);
  if (!membership) return null;
  const { room, player } = membership;
  if (room.phase !== 'game' || !room.game) {
    sendError(ws, 'There is no match in progress.');
    return null;
  }
  const playerIndex = room.players.findIndex(candidate => candidate.id === player.id);
  if (playerIndex < 0) return null;
  if (room.game.gameOver) {
    sendError(ws, 'The match is already over.');
    return null;
  }
  if (room.game.currentPlayer !== playerIndex) {
    sendError(ws, 'It is not your turn.');
    return null;
  }
  return { room, player, playerIndex, game: room.game };
}

function playWord(ws, msg) {
  const turn = requireGameTurn(ws);
  if (!turn) return;
  const { room, playerIndex, game } = turn;
  const indices = sanitizeIndices(msg.indices);
  if (!indices) return sendError(ws, 'Choose at least one valid rack tile.');

  const rack = game.racks[playerIndex];
  const tiles = indices.map(index => rack[index]);
  if (tiles.some(tile => !tile)) return sendError(ws, 'One of those rack tiles is no longer available.');

  const word = tiles.map(tile => tile.letter).join('');
  const resolved = resolveWord(word);
  if (!resolved) return sendError(ws, 'That is not a valid word.');

  clearNewlyDrawn(game);
  const score = calcWordScore(game.mode, tiles);
  game.scores[playerIndex] += score.total;
  game.words[playerIndex] += 1;

  if (game.mode === 'duel') {
    const opponent = playerIndex === 0 ? 1 : 0;
    game.health[opponent] = Math.max(0, game.health[opponent] - score.total);
    const lengthRewardMod = duelRewardForLength(tiles.length);
    const damageRewardMod = duelRewardForBaseDamage(score.letterSum);
    const rewardMods = [lengthRewardMod, damageRewardMod].filter(Boolean);

    game.lastPlay = {
      player: playerIndex,
      target: opponent,
      type: 'word',
      tiles: tiles.map(tile => ({ letter: tile.letter, mod: tile.mod })),
      word,
      resolved,
      score: score.total,
      baseDamage: score.letterSum,
      wordMult: 1,
      lengthBonus: 0,
      boostPercent: score.boostPercent,
      lengthRewardMod,
      damageRewardMod,
      rewardMods,
      usedWildcard: word.includes(WILDCARD),
    };

    for (const index of indices) rack[index] = null;
    game.newlyDrawn[playerIndex] = refillRack(game, rack, rewardMods);
    game.history.push(game.lastPlay);
    addSystemMessage(room, `${room.players[playerIndex].username} played "${resolved}", dealing ${score.total} dmg`, 'duel_play', {
      actorId: room.players[playerIndex].id,
      word: resolved,
      damage: score.total,
    });

    if (game.health[opponent] <= 0) {
      game.gameOver = true;
      game.endResult = { reason: 'knockout', winnerIdx: playerIndex, loserIdx: opponent };
      addSystemMessage(room, `Game Over. ${room.players[playerIndex].username} defeated ${room.players[opponent].username}!`, 'duel_game_over', {
        winnerId: room.players[playerIndex].id,
        loserId: room.players[opponent].id,
        winnerName: room.players[playerIndex].username,
        loserName: room.players[opponent].username,
      });
    } else {
      advanceTurn(game);
      addTurnMessage(room);
    }
  } else {
    game.lastPlay = {
      player: playerIndex,
      type: 'word',
      tiles: tiles.map(tile => ({ letter: tile.letter, mod: tile.mod })),
      word,
      resolved,
      score: score.total,
      wordMult: score.wordMult,
      lengthBonus: score.lengthBonus,
      usedWildcard: word.includes(WILDCARD),
    };

    for (const index of indices) rack[index] = null;
    game.newlyDrawn[playerIndex] = refillRack(game, rack);
    game.history.push(game.lastPlay);
    addSystemMessage(room, `${room.players[playerIndex].username} played "${resolved}". +${score.total} pts`, 'classic_play', {
      actorId: room.players[playerIndex].id,
      word: resolved,
      score: score.total,
    });
    if (!finishClassicIfNeeded(game, room)) {
      advanceTurn(game);
      addTurnMessage(room);
    }
  }

  game.revision++;
  broadcastRoom(room);
}

function discardTiles(ws, msg) {
  const turn = requireGameTurn(ws);
  if (!turn) return;
  const { room, playerIndex, game } = turn;
  if (game.discardUsedThisTurn) return sendError(ws, 'You already discarded tiles this turn.');
  if (game.mode === 'classic' && game.bag.length === 0) return sendError(ws, 'You cannot discard after the Classic bag is empty.');

  const indices = sanitizeIndices(msg.indices, { maxCount: 4 });
  if (!indices) return sendError(ws, 'Choose between 1 and 4 tiles to discard.');
  const rack = game.racks[playerIndex];
  const discarded = indices.map(index => rack[index]);
  if (discarded.some(tile => !tile)) return sendError(ws, 'One of those rack tiles is no longer available.');

  clearNewlyDrawn(game);
  if (game.mode === 'classic') {
    game.bag.push(...discarded);
    shuffleArr(game.bag);
  }
  for (const index of indices) rack[index] = null;
  game.newlyDrawn[playerIndex] = refillRack(game, rack);
  game.discardUsedThisTurn = true;

  // A discard changes the current rack and, in Classic, can also change whether
  // the whole table is stuck. Re-evaluate immediately.
  if (game.mode === 'classic') finishClassicIfNeeded(game, room);
  game.revision++;
  broadcastRoom(room);
}

function skipTurn(ws) {
  const turn = requireGameTurn(ws);
  if (!turn) return;
  const { room, playerIndex, game } = turn;
  const rack = game.racks[playerIndex];
  if (rackHasPlayableWord(rack)) return sendError(ws, 'You still have at least one valid word to play.');

  clearNewlyDrawn(game);
  game.lastPlay = { player: playerIndex, type: 'skip' };
  game.history.push(game.lastPlay);
  addSystemMessage(room, `${room.players[playerIndex].username} skipped their turn.`, 'skip', {
    actorId: room.players[playerIndex].id,
  });
  if (game.mode === 'classic' && finishClassicIfNeeded(game, room)) {
    // No turn advance when this skip proves the entire table is stuck.
  } else {
    advanceTurn(game);
    addTurnMessage(room);
  }
  game.revision++;
  broadcastRoom(room);
}

function storeRoomMessage(room, { playerId = null, username = '', text, kind = 'chat', systemType = null, meta = null }) {
  if (!Array.isArray(room.chat)) room.chat = [];
  const message = {
    id: crypto.randomUUID(),
    playerId,
    username,
    text,
    kind,
    timestamp: Date.now(),
  };
  if (systemType) message.systemType = systemType;
  if (meta && typeof meta === 'object') message.meta = { ...meta };
  room.chat.push(message);
  if (room.chat.length > CHAT_HISTORY_LIMIT) {
    room.chat.splice(0, room.chat.length - CHAT_HISTORY_LIMIT);
  }
  return message;
}

function addSystemMessage(room, text, systemType = null, meta = null) {
  return storeRoomMessage(room, { text, kind: 'system', systemType, meta });
}

function addTurnMessage(room) {
  const game = room.game;
  if (!game || game.gameOver) return;
  const player = room.players[game.currentPlayer];
  if (player) addSystemMessage(room, `It's ${player.username}'s turn.`, 'turn', { actorId: player.id });
}

function publicRoomState(room) {
  const chat = Array.isArray(room.chat) ? room.chat : [];
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    players: room.players.map(player => ({
      id: player.id,
      username: player.username,
      connected: !!player.ws && player.ws.readyState === WebSocket.OPEN,
    })),
    settings: { ...room.settings },
    chat: chat.map(message => ({
      id: message.id,
      playerId: message.playerId,
      username: message.username,
      text: message.text,
      kind: message.kind || 'chat',
      timestamp: message.timestamp,
      systemType: message.systemType || null,
      meta: message.meta ? { ...message.meta } : null,
    })),
  };
}

function publicGameStateFor(room, viewerIndex) {
  const game = room.game;
  if (!game) return null;
  const viewerRack = game.racks[viewerIndex] || new Array(RACK_SIZE).fill(null);
  const viewerTurn = viewerIndex === game.currentPlayer && !game.gameOver;
  const canDiscard = viewerTurn
    && !game.discardUsedThisTurn
    && viewerRack.some(Boolean)
    && (game.mode === 'duel' || game.bag.length > 0);
  const canSkip = viewerTurn && !rackHasPlayableWord(viewerRack);

  return {
    revision: game.revision,
    mode: game.mode,
    currentPlayer: game.currentPlayer,
    yourPlayerIndex: viewerIndex,
    startingHP: game.startingHP,
    players: room.players.map((player, index) => ({
      id: player.id,
      username: player.username,
      connected: !!player.ws && player.ws.readyState === WebSocket.OPEN,
      score: game.scores[index],
      words: game.words[index],
      health: game.health[index],
    })),
    yourRack: viewerRack.map(tile => tile ? { letter: tile.letter, mod: tile.mod } : null),
    bagRemaining: game.mode === 'classic' ? game.bag.length : null,
    distribution: { ...game.distribution },
    modSummary: { ...game.modSummary },
    // Whether the current player already discarded is private turn state.
    // Other clients should only know that they themselves cannot act right now.
    discardUsedThisTurn: viewerTurn ? game.discardUsedThisTurn : false,
    canDiscard,
    canSkip,
    history: game.history,
    lastPlay: game.lastPlay,
    newlyDrawnIndices: game.newlyDrawn[viewerIndex] || [],
    gameOver: game.gameOver,
    endResult: game.endResult,
  };
}

function broadcastRoom(room) {
  const publicState = publicRoomState(room);
  room.players.forEach((player, index) => {
    send(player.ws, {
      type: 'room_state',
      room: publicState,
      game: room.phase === 'game' ? publicGameStateFor(room, index) : null,
      you: { id: player.id },
    });
  });
}

function broadcastChatMessage(room, message) {
  room.players.forEach(player => {
    send(player.ws, {
      type: 'chat_message',
      message: {
        id: message.id,
        playerId: message.playerId,
        username: message.username,
        text: message.text,
        kind: message.kind || 'chat',
        timestamp: message.timestamp,
        systemType: message.systemType || null,
        meta: message.meta ? { ...message.meta } : null,
      },
    });
  });
}

function sendPrivateSystemMessage(player, text) {
  if (!player?.ws) return;
  send(player.ws, {
    type: 'chat_message',
    private: true,
    message: {
      id: crypto.randomUUID(),
      playerId: null,
      username: '',
      text,
      kind: 'system',
      timestamp: Date.now(),
      private: true,
    },
  });
}

function removeSocketFromRoom(ws, { acknowledge = false } = {}) {
  const code = ws.roomCode;
  if (!code) {
    if (acknowledge) send(ws, { type: 'left_room' });
    return;
  }

  const room = rooms.get(code);
  ws.roomCode = null;
  ws.playerId = null;
  if (!room) {
    if (acknowledge) send(ws, { type: 'left_room' });
    return;
  }

  const leavingIndex = room.players.findIndex(player => player.ws === ws);
  const leavingPlayer = leavingIndex >= 0 ? room.players[leavingIndex] : null;
  const leavingWasHost = !!leavingPlayer && leavingPlayer.id === room.hostId;
  if (leavingPlayer) {
    addSystemMessage(room, `${leavingPlayer.username} left.`, 'leave', { actorId: leavingPlayer.id });
    room.players.splice(leavingIndex, 1);
  }

  // Reconnection is a later feature. For now, if anybody leaves during a match,
  // safely return the remaining players to the lobby instead of corrupting player indices.
  if (room.phase === 'game') {
    room.phase = 'lobby';
    room.game = null;
  }

  if (room.players.length === 0) {
    rooms.delete(code);
  } else {
    let newHost = null;
    if (!room.players.some(player => player.id === room.hostId)) {
      room.hostId = room.players[0].id;
      newHost = room.players[0];
    }
    if (room.settings.mode === 'classic' && room.settings.playerCount < room.players.length) {
      room.settings.playerCount = Math.min(MAX_PLAYERS, room.players.length);
    }
    broadcastRoom(room);
    if (leavingWasHost && newHost) sendPrivateSystemMessage(newHost, 'You are now the host.');
  }

  if (acknowledge) send(ws, { type: 'left_room' });
}

function attachPlayer(ws, room, username, makeHost = false) {
  const player = { id: crypto.randomUUID(), username, ws };
  room.players.push(player);
  if (makeHost) room.hostId = player.id;
  ws.roomCode = room.code;
  ws.playerId = player.id;
  return player;
}

function currentMembership(ws) {
  if (!ws.roomCode || !ws.playerId) return null;
  const room = rooms.get(ws.roomCode);
  if (!room) return null;
  const player = room.players.find(candidate => candidate.id === ws.playerId && candidate.ws === ws);
  return player ? { room, player } : null;
}

function requireMembership(ws) {
  const membership = currentMembership(ws);
  if (!membership) sendError(ws, 'You are not currently in a room.');
  return membership;
}

function requireHost(ws) {
  const membership = requireMembership(ws);
  if (!membership) return null;
  if (membership.room.hostId !== membership.player.id) {
    sendError(ws, 'Only the room host can do that.');
    return null;
  }
  return membership;
}

function createRoom(ws, msg) {
  const username = cleanUsername(msg.username);
  if (!username) return sendError(ws, 'Choose a username first.');
  removeSocketFromRoom(ws);

  const code = randomRoomCode();
  const room = {
    code,
    phase: 'lobby',
    hostId: null,
    players: [],
    settings: defaultSettings(),
    createdAt: Date.now(),
    game: null,
    chat: [],
  };
  rooms.set(code, room);
  const player = attachPlayer(ws, room, username, true);
  addSystemMessage(room, `${username} joined.`, 'join', { actorId: player.id });
  broadcastRoom(room);
}

function joinRoom(ws, msg) {
  const username = cleanUsername(msg.username);
  const code = cleanRoomCode(msg.roomCode);
  if (!username) return sendError(ws, 'Choose a username first.');
  if (!code) return sendError(ws, 'Enter a room code.');

  const room = rooms.get(code);
  if (!room) return sendError(ws, 'That room does not exist.');
  if (room.phase !== 'lobby') return sendError(ws, 'That match has already started.');
  if (room.players.length >= roomCapacity(room)) return sendError(ws, 'That room is full.');
  if (room.players.some(player => player.username.toLocaleLowerCase() === username.toLocaleLowerCase())) {
    return sendError(ws, 'That username is already being used in this room.');
  }

  removeSocketFromRoom(ws);
  const player = attachPlayer(ws, room, username, false);
  addSystemMessage(room, `${username} joined.`, 'join', { actorId: player.id });
  broadcastRoom(room);
}

function updateSettings(ws, msg) {
  const membership = requireHost(ws);
  if (!membership) return;
  const { room } = membership;
  if (room.phase !== 'lobby') return sendError(ws, 'Room rules are locked after the match starts.');

  const patch = msg.settings && typeof msg.settings === 'object' ? msg.settings : {};
  const next = { ...room.settings };

  if (Object.hasOwn(patch, 'mode')) {
    const mode = patch.mode === 'duel' ? 'duel' : patch.mode === 'classic' ? 'classic' : null;
    if (!mode) return sendError(ws, 'Invalid game mode.');
    if (mode === 'duel' && room.players.length > 2) return sendError(ws, 'Duel only supports two players.');
    next.mode = mode;
    if (mode === 'duel') next.playerCount = 2;
  }

  if (Object.hasOwn(patch, 'playerCount') && next.mode !== 'duel') {
    const count = clampInteger(patch.playerCount, 2, 4, next.playerCount);
    if (count < room.players.length) return sendError(ws, `There are already ${room.players.length} players in the room.`);
    if (count !== next.playerCount) {
      next.playerCount = count;
      next.bagSize = DEFAULT_BAG_BY_PLAYERS[count];
    }
  }

  if (Object.hasOwn(patch, 'bagSize')) next.bagSize = clampInteger(patch.bagSize, 0, 2000, next.bagSize);
  if (Object.hasOwn(patch, 'minPerLetter')) next.minPerLetter = clampInteger(patch.minPerLetter, 0, 50, next.minPerLetter);
  if (Object.hasOwn(patch, 'startingHP')) next.startingHP = clampInteger(patch.startingHP, 1, 9999, next.startingHP);

  room.settings = next;
  broadcastRoom(room);
}

function startGame(ws) {
  const membership = requireHost(ws);
  if (!membership) return;
  const { room } = membership;
  if (room.phase !== 'lobby') return sendError(ws, 'The match has already started.');

  const needed = roomCapacity(room);
  if (room.players.length !== needed) return sendError(ws, `This match needs exactly ${needed} players before it can start.`);

  try {
    room.game = createGame(room.settings, room.players.length);
  } catch (error) {
    return sendError(ws, error.message || 'Could not start that game.');
  }
  room.phase = 'game';
  addSystemMessage(room, `${membership.player.username} started the game.`, 'start', { actorId: membership.player.id });
  addTurnMessage(room);
  broadcastRoom(room);
}

function returnToLobby(ws) {
  const membership = requireHost(ws);
  if (!membership) return;
  const { room } = membership;
  if (room.phase !== 'game' || !room.game?.gameOver) return sendError(ws, 'You can return to the lobby after the match ends.');
  room.phase = 'lobby';
  room.game = null;
  addSystemMessage(room, `${membership.player.username} returned the room to the lobby.`, 'return_lobby', { actorId: membership.player.id });
  broadcastRoom(room);
}

function sendChatMessage(ws, msg) {
  const membership = requireMembership(ws);
  if (!membership) return;
  const { room, player } = membership;
  const text = cleanChatMessage(msg.text);
  if (!text) return sendError(ws, 'Chat message cannot be empty.');

  const now = Date.now();
  if (now - (player.lastChatAt || 0) < CHAT_RATE_LIMIT_MS) {
    return sendError(ws, 'You are sending chat messages too quickly.');
  }
  player.lastChatAt = now;

  const message = storeRoomMessage(room, {
    playerId: player.id,
    username: player.username,
    text,
    kind: 'chat',
  });
  // Preserve the timestamp captured for rate limiting as closely as possible.
  message.timestamp = now;
  broadcastChatMessage(room, message);
}

function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return sendError(ws, 'Malformed message.');
  }
  if (!msg || typeof msg.type !== 'string') return sendError(ws, 'Malformed message.');

  switch (msg.type) {
    case 'create_room': return createRoom(ws, msg);
    case 'join_room': return joinRoom(ws, msg);
    case 'update_settings': return updateSettings(ws, msg);
    case 'start_game': return startGame(ws);
    case 'play_word': return playWord(ws, msg);
    case 'discard_tiles': return discardTiles(ws, msg);
    case 'skip_turn': return skipTurn(ws);
    case 'return_to_lobby': return returnToLobby(ws);
    case 'chat_message': return sendChatMessage(ws, msg);
    case 'leave_room': return removeSocketFromRoom(ws, { acknowledge: true });
    default: return sendError(ws, `Unknown action: ${msg.type}`);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const requestPath = decodeURIComponent((req.url || '/').split('?')[0]);

  if (requestPath === '/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (statErr, stat) => {
    const resolved = !statErr && stat.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    fs.readFile(resolved, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
});

function startServer() {
  if (!WebSocketServer) {
    throw new Error('Missing dependency: run npm install before starting Lexigon.');
  }
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', ws => {
    ws.roomCode = null;
    ws.playerId = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', data => handleMessage(ws, data));
    ws.on('close', () => removeSocketFromRoom(ws));
  });

  // Keep long-lived room connections healthy and discard dead sockets promptly.
  // WebSocket clients automatically answer protocol-level ping frames with pong.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));

  server.listen(PORT, HOST, () => {
    console.log(`Lexigon listening on http://${HOST}:${PORT}`);
  });
  return { server, wss };
}

if (require.main === module) startServer();

module.exports = {
  createGame,
  calcWordScore,
  resolveWord,
  rackHasPlayableWord,
  duelRewardForLength,
  duelRewardForBaseDamage,
  playWord,
  discardTiles,
  skipTurn,
  publicGameStateFor,
  publicRoomState,
  sendChatMessage,
  startServer,
  _handleMessage: handleMessage,
  _rooms: rooms,
};
