'use strict';

const fs = require('fs');
const path = require('path');
const engine = require('./server.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fakeSocket(id, roomCode) {
  return {
    roomCode,
    playerId: id,
    readyState: 1,
    sent: [],
    send(raw) { this.sent.push(JSON.parse(raw)); },
  };
}

function makeRoom(code, settings) {
  const count = settings.mode === 'duel' ? 2 : settings.playerCount;
  const sockets = [];
  const players = [];
  for (let i = 0; i < count; i++) {
    sockets[i] = fakeSocket(`p${i}`, code);
    players[i] = { id: `p${i}`, username: `Player ${i + 1}`, ws: sockets[i] };
  }
  const room = {
    code,
    phase: 'game',
    hostId: 'p0',
    settings,
    players,
    game: engine.createGame(settings, count),
  };
  engine._rooms.set(code, room);
  return { room, sockets };
}


// Application-level latency pings are echoed without requiring room membership.
{
  const ws = fakeSocket('ping', null);
  engine._handleMessage(ws, Buffer.from(JSON.stringify({ type: 'latency_ping', id: 42 })));
  assert(ws.sent.length === 1, 'Latency ping did not receive exactly one response');
  assert(ws.sent[0].type === 'latency_pong' && ws.sent[0].id === 42, 'Latency pong did not echo the ping id');
}

const duelScore = engine.calcWordScore('duel', [
  { letter: 'a', mod: 'X2' },
  { letter: 'b', mod: 'X3' },
]);
assert(duelScore.letterSum === 4, 'Duel base damage mismatch');
assert(duelScore.boostPercent === 30, 'Duel additive boost mismatch');
assert(duelScore.total === 6, 'Duel boosted damage should round up');
assert(duelScore.lengthBonus === 0, 'Duel must not have a length damage bonus');
assert(engine.resolveWord('_') === 'a', 'Wildcard resolution mismatch');

// Modern slang/manual dictionary additions should be accepted by the authoritative server.
for (const word of [
  'unc', 'uncs', 'lowkey', 'highkey', 'copium', 'crashout', 'crashouts',
  'maxxing', 'maxxed', 'maxxes', 'maxxer', 'maxxers',
  'looksmaxxing', 'looksmaxxed', 'looksmaxxes', 'looksmaxxer', 'looksmaxxers',
  'algospeak', 'babygirl', 'babygirls', 'opp', 'opps', 'op', 'ops',
  'enshittify', 'enshittifies', 'enshittified', 'enshittifying', 'enshittification', 'rizzed', 'rizzing', 'rizzes',
  'situationships', 'doomscrolls', 'girlboss', 'girlbosses', 'girlbossed', 'girlbossing',
  'pookie', 'pookies', 'ratioed', 'ratioing', 'chud', 'chuds',
  'bimbofication', 'bimbofications', 'bimbofied', 'bimbofying',
  'sendy', 'sendier', 'sendiest', 'blud', 'bluds', 'brainrot', 'brainrotted', 'brainrotting',
  'boyfailure', 'boyfailures', 'failwife', 'failwives',
  'girlfailure', 'girlfailures', 'malewife', 'malewives',
  'girlblog', 'girlblogging', 'girlposting', 'girlrot', 'girlrotting',
  'girlflop', 'girlflops', 'girlflopped', 'girlflopping',
  'cheugy', 'cheugier', 'cheugiest', 'clanker', 'clankers', 'glizzy', 'glizzies',
  'gyat', 'gyats', 'gyatt', 'gyatts', 'oomf', 'oomfs',
  'bimbofy', 'bimbofies', 'chestfeed', 'chestfeeds', 'delulus',
  'donghuas', 'doujinshis', 'fediverses', 'girlblogs', 'girlblogged',
  'girlpost', 'girlposts', 'girlposted', 'girlrots', 'girlrotted',
  'isekais', 'jjigaes', 'latinxs', 'looksmaxx', 'maxx',
  'manhuas', 'manhwas', 'mukbangs', 'neurodivergents', 'permadeaths',
  'phrog', 'phrogs', 'phrogged', 'sealion', 'sealions', 'sealioned',
  'timeboxed', 'timeboxing', 'tsunderes', 'yanderes', 'yassifications',
  'ragebait', 'ragebaits', 'ragebaited', 'ragebaiting',
  'shadowban', 'shadowbans', 'shadowbanned', 'shadowbanning',
  'tradwife', 'tradwives', 'romantasy', 'romantasies',
  'sanewash', 'sanewashes', 'sanewashed', 'sanewashing',
  'finsta', 'finstas', 'unalived', 'unalives', 'unaliving',
  'yass', 'yassify', 'yassifies', 'yassified', 'yassifying', 'yassification',
  'gacha', 'gachas', 'vtuber', 'vtubers', 'waifu', 'waifus',
  'husbando', 'husbandos', 'headcanon', 'headcanons', 'permadeath',
  'deinfluence', 'deinfluences', 'deinfluenced', 'deinfluencing',
  'deinfluencer', 'deinfluencers', 'bedrotting', 'femcel', 'femcels',
]) {
  assert(engine.resolveWord(word) === word, `Expected ${word} to be valid`);
}


// Final vocabulary pass: established modern single-word additions, all playable within 16 tiles.
for (const word of [
  'underresource',
  'underresources',
  'underresourced',
  'underresourcing',
  'neurodivergent',
  'neurodivergence',
  'minoritize',
  'minoritizes',
  'minoritized',
  'minoritizing',
  'offboard',
  'offboards',
  'offboarded',
  'offboarding',
  'latinx',
  'latine',
  'latines',
  'enby',
  'enbies',
  'polycule',
  'polycules',
  'neopronoun',
  'neopronouns',
  'allosexual',
  'allosexuals',
  'queerplatonic',
  'cishet',
  'cishets',
  'fatphobia',
  'fatphobic',
  'chestfeeding',
  'chestfed',
  'phub',
  'phubs',
  'phubbed',
  'phubbing',
  'phubber',
  'phubbers',
  'sharent',
  'sharents',
  'sharented',
  'sharenting',
  'nomophobia',
  'nomophobic',
  'finfluencer',
  'finfluencers',
  'deboost',
  'deboosts',
  'deboosted',
  'deboosting',
  'parasocial',
  'fancam',
  'fancams',
  'dudebro',
  'dudebros',
  'edgelord',
  'edgelords',
  'fediverse',
  'subreddit',
  'subreddits',
  'sealioning',
  'phrogging',
  'kiki',
  'kikis',
  'overprompts',
  'overprompted',
  'overprompting',
  'agrivoltaics',
  'speedran',
  'roguelike',
  'roguelikes',
  'roguelite',
  'roguelites',
  'metroidvania',
  'metroidvanias',
  'soulslike',
  'soulslikes',
  'isekai',
  'tsundere',
  'yandere',
  'mukbang',
  'manhwa',
  'manhua',
  'donghua',
  'webtoon',
  'webtoons',
  'esports',
  'respawn',
  'respawns',
  'respawned',
  'respawning',
  'microtransaction',
  'femtech',
  'timebox',
  'timeboxes',
  'smashburger',
  'smashburgers',
  'furikake',
  'jjigae',
  'noraebang',
  'noraebangs',
  'vaporwave',
  'synthwave',
  'hyperpop',
  'otherkin',
  'fursona',
  'fursonas',
  'doujinshi',
  'shonen',
  'seinen',
  'josei',
  'otome',
  'bleisure',
  'workation',
  'workations',
  'funemployment',
  'polywork',
  'resenteeism',
  'greedflation',
  'tipflation',
  'skimpflation',
  'grindset',
  'grindsets',
  'brainrots',
  'rizzler',
  'rizzlers',
  'rizzless',
]) {
  assert(engine.resolveWord(word) === word, `Expected final dictionary addition ${word} to be valid`);
}


// Explicit/lewd vocabulary is intentionally unfiltered when the spelling is a legitimate word.
for (const word of [
  'autofellatio', 'cameltoe', 'cameltoes', 'coomer', 'coomers',
  'creampie', 'creampies', 'cumshot', 'cumshots',
  'deepthroat', 'deepthroats', 'deepthroated', 'deepthroating',
  'domme', 'dommes', 'ecchi', 'eroge', 'femdom', 'femdoms', 'findom',
  'fuckboy', 'fuckboys', 'futanari', 'gooner', 'gooners', 'gooning',
  'handjob', 'handjobs', 'hentai', 'rimjob', 'rimjobs', 'sextech', 'shibari',
  'throuple', 'throuples', 'tribbing', 'yaoi', 'yuri',
  'bazonga', 'bazongas', 'booba', 'boobage', 'boobjob', 'boobjobs',
  'fansub', 'fansubbed', 'fansubbing', 'fansubs',
  'gazonga', 'gazongas', 'lolicon', 'lolicons', 'netorare', 'oppai', 'paizuri',
  'ragequit', 'ragequits', 'ragequitting', 'scanlation', 'scanlations', 'scanlator', 'scanlators',
  'shitpost', 'shitposted', 'shitposting', 'shitposts', 'shotacon', 'shotacons',
  'titfuck', 'titfucked', 'titfucking', 'titfucks', 'titjob', 'titjobs',
  'titwank', 'titwanked', 'titwanking', 'titwanks',
]) {
  assert(engine.resolveWord(word) === word, `Expected explicit vocabulary ${word} to be valid`);
}

// Dictionary / word-finder screen is part of the shipped frontend.
{
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  for (const id of ['dictionaryBtn', 'dictionaryScreen', 'dictionaryInput', 'dictionaryModeGroup', 'dictionaryPossibleDetails']) {
    assert(html.includes(`id=\"${id}\"`), `Missing dictionary UI element: ${id}`);
  }
  assert(html.includes('function findDictionaryToolWords('), 'Missing dictionary subset-word search');
  assert(html.includes('function dictionaryPatternMatches('), 'Missing dictionary wildcard validation');
  assert(html.includes('dictionary-length-header'), 'Dictionary results are not grouped into collapsible length sections');
  assert(html.includes('dictionaryToolOpenLengths'), 'Dictionary length-group collapse state is missing');
  assert(!html.includes('function dictionaryLengthBonus('), 'Dictionary scoring should not include the Classic gameplay length bonus');
  assert(html.includes('<sub>${result.score}</sub>'), 'Dictionary result scores are not rendered as subscripts');
}

// Every manual dictionary extra must be playable on a 16-tile rack and resolve correctly.
{
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const block = html.match(/const\s+EXTRA_WORDS\s*=\s*\[([\s\S]*?)\];/);
  assert(block, 'Could not find EXTRA_WORDS in frontend');
  const extras = Array.from(block[1].matchAll(/'([^']+)'/g), m => m[1].toLowerCase());
  assert(new Set(extras).size === extras.length, 'EXTRA_WORDS contains duplicates');
  for (const word of extras) {
    assert(word.length <= 16, `Manual word exceeds 16-tile rack: ${word}`);
    assert(engine.resolveWord(word) === word, `Manual word failed authoritative validation: ${word}`);
  }
}

// Duel base-damage reward thresholds: Aqua 12, Purple 13, Pink 15, Gold 17.
assert(engine.duelRewardForBaseDamage(11) === null, '11 damage should not earn a special');
assert(engine.duelRewardForBaseDamage(12) === 'X2', '12 damage should earn Aqua');
assert(engine.duelRewardForBaseDamage(13) === 'X3', '13 damage should earn Purple');
assert(engine.duelRewardForBaseDamage(14) === 'X3', '14 damage should remain Purple');
assert(engine.duelRewardForBaseDamage(15) === 'X4', '15 damage should earn Pink');
assert(engine.duelRewardForBaseDamage(16) === 'X4', '16 damage should remain Pink');
assert(engine.duelRewardForBaseDamage(17) === 'X5', '17 damage should earn Gold');

const { room, sockets } = makeRoom('TEST', {
  mode: 'duel', playerCount: 2, bagSize: 160, minPerLetter: 1, startingHP: 200,
});
room.game.racks[0][0] = { letter: 'c', mod: null };
room.game.racks[0][1] = { letter: 'a', mod: null };
room.game.racks[0][2] = { letter: 't', mod: null };
engine.playWord(sockets[0], { indices: [0, 1, 2] });
assert(room.game.lastPlay.word === 'cat', 'Valid word was not accepted');
assert(room.game.currentPlayer === 1, 'Turn did not advance');
assert(room.game.health[1] === 196, 'Duel damage mismatch');
const duelPlayStatus = room.chat?.find(message => message.kind === 'system' && message.text === 'Player 1 played "cat", dealing 4 dmg.');
assert(duelPlayStatus, 'Duel play status was not added to room chat');
assert(duelPlayStatus.systemType === 'duel_play' && duelPlayStatus.meta?.actorId === 'p0', 'Duel play status metadata mismatch');
const turnStatus = room.chat?.find(message => message.kind === 'system' && message.text === "It's Player 2's turn.");
assert(turnStatus, 'Turn status was not added to room chat');
assert(turnStatus.systemType === 'turn' && turnStatus.meta?.actorId === 'p1', 'Turn status metadata mismatch');
const privateState = sockets[0].sent.at(-1).game;
assert(privateState.yourRack && !Object.hasOwn(privateState, 'racks'), 'Opponent racks leaked to client');

// Discard usage is private turn state: only the current player may learn that
// they already used their discard for this turn.
room.game.currentPlayer = 0;
room.game.discardUsedThisTurn = true;
assert(engine.publicGameStateFor(room, 0).discardUsedThisTurn === true, 'Current player should see their discard as used');
assert(engine.publicGameStateFor(room, 1).discardUsedThisTurn === false, 'Opponent discard usage leaked to another player');

// Room chat is server-relayed, attributed from authenticated room membership,
// normalized, and included in room history for players who join/re-render later.
room.chat = [];
sockets[0].sent = [];
sockets[1].sent = [];
engine.sendChatMessage(sockets[0], { text: '  hello   world <b>  ' });
assert(room.chat.length === 1, 'Chat message was not stored');
assert(room.chat[0].username === 'Player 1', 'Chat username must come from server membership');
assert(room.chat[0].text === 'hello world <b>', 'Chat message normalization mismatch');
assert(room.chat[0].kind === 'chat', 'Player chat should be marked as chat');
assert(sockets[1].sent.at(-1)?.type === 'chat_message', 'Chat message was not relayed to the other player');
assert(engine.publicRoomState(room).chat.length === 1, 'Chat history was not included in room state');

console.log('Lexigon server engine self-test passed.');

// Game-over activity messages use the requested Classic and Duel wording.
{
  const duel = makeRoom('KOUT', {
    mode: 'duel', playerCount: 2, bagSize: 160, minPerLetter: 1, startingHP: 200,
  });
  duel.room.chat = [];
  duel.room.game.currentPlayer = 0;
  duel.room.game.health[1] = 1;
  duel.room.game.racks[0] = new Array(16).fill(null);
  duel.room.game.racks[0][0] = { letter: 'a', mod: null };
  engine.playWord(duel.sockets[0], { indices: [0] });
  const gameOver = duel.room.chat.find(message => message.text === 'Game Over. Player 1 defeated Player 2!');
  assert(gameOver, 'Duel game-over status mismatch');
  assert(gameOver.systemType === 'duel_game_over', 'Duel game-over system type mismatch');
  assert(gameOver.meta?.winnerId === 'p0' && gameOver.meta?.loserId === 'p1', 'Duel game-over player metadata mismatch');
  assert(gameOver.meta?.winnerName === 'Player 1' && gameOver.meta?.loserName === 'Player 2', 'Duel game-over name metadata mismatch');
}

{
  const classic = makeRoom('CEND', {
    mode: 'classic', playerCount: 2, bagSize: 160, minPerLetter: 1, startingHP: 200,
  });
  classic.room.chat = [];
  classic.room.game.currentPlayer = 0;
  classic.room.game.bag = [];
  classic.room.game.racks[0] = new Array(16).fill(null);
  classic.room.game.racks[0][0] = { letter: 'a', mod: null };
  engine.playWord(classic.sockets[0], { indices: [0] });
  const gameOver = classic.room.chat.find(message => message.text === 'Game Over. Player 1 won!');
  assert(gameOver, 'Classic game-over status mismatch');
  assert(gameOver.systemType === 'classic_game_over' && gameOver.meta?.winnerId === 'p0', 'Classic game-over metadata mismatch');
}

// When the host leaves, only the newly promoted host receives the private notice.
{
  const code = 'HOST';
  const hostSocket = fakeSocket('host', code);
  const newHostSocket = fakeSocket('next', code);
  const otherSocket = fakeSocket('other', code);
  const room = {
    code,
    phase: 'lobby',
    hostId: 'host',
    settings: { mode: 'classic', playerCount: 3, bagSize: 192, minPerLetter: 1, startingHP: 200 },
    players: [
      { id: 'host', username: 'Host', ws: hostSocket },
      { id: 'next', username: 'Next', ws: newHostSocket },
      { id: 'other', username: 'Other', ws: otherSocket },
    ],
    game: null,
    chat: [],
  };
  engine._rooms.set(code, room);
  engine._handleMessage(hostSocket, Buffer.from(JSON.stringify({ type: 'leave_room' })));
  const privateNotice = newHostSocket.sent.find(message => message.type === 'chat_message' && message.private === true);
  assert(privateNotice?.message?.text === 'You are now the host.', 'New host did not receive private host notice');
  assert(!otherSocket.sent.some(message => message.type === 'chat_message' && message.message?.text === 'You are now the host.'), 'Host notice leaked to another player');
  assert(!engine.publicRoomState(room).chat.some(message => message.text === 'You are now the host.'), 'Private host notice leaked into public chat history');
}


// Classic skips are always allowed once the finite bag is empty, even if the
// current rack still contains a valid word. Before the bag is empty, a playable
// rack still cannot skip.
{
  const classic = makeRoom('SKIP', {
    mode: 'classic', playerCount: 2, bagSize: 160, minPerLetter: 1, startingHP: 200,
  });
  classic.room.chat = [];
  classic.room.game.currentPlayer = 0;
  classic.room.game.racks[0] = new Array(16).fill(null);
  classic.room.game.racks[0][0] = { letter: 'c', mod: null };
  classic.room.game.racks[0][1] = { letter: 'a', mod: null };
  classic.room.game.racks[0][2] = { letter: 't', mod: null };
  classic.room.game.racks[1] = new Array(16).fill(null);
  classic.room.game.racks[1][0] = { letter: 'a', mod: null };

  classic.room.game.bag = [{ letter: 'e', mod: null }];
  assert(engine.publicGameStateFor(classic.room, 0).canSkip === false, 'Playable Classic rack should not skip while the bag still has tiles');

  classic.room.game.bag = [];
  assert(engine.publicGameStateFor(classic.room, 0).canSkip === true, 'Classic skip should be available once the bag is empty');
  engine.skipTurn(classic.sockets[0]);
  assert(classic.room.game.currentPlayer === 1, 'Classic empty-bag skip did not advance the turn');
  assert(classic.room.game.lastPlay?.type === 'skip', 'Classic empty-bag skip was not recorded');
  assert(classic.room.game.gameOver === false, 'Classic should not end after only one player skips');

  engine.skipTurn(classic.sockets[1]);
  assert(classic.room.game.gameOver === true, 'Classic did not end after every player skipped consecutively');
  assert(classic.room.game.endResult?.reason === 'all_skipped', 'Classic consecutive-skip ending used the wrong reason');
  assert(classic.room.game.endResult?.emptyPlayerIdx === null, 'Consecutive skips must not award a going-out bonus');
}

// Any real Classic word play breaks the consecutive-skip streak.
{
  const classic = makeRoom('SRESET', {
    mode: 'classic', playerCount: 2, bagSize: 160, minPerLetter: 1, startingHP: 200,
  });
  classic.room.chat = [];
  classic.room.game.currentPlayer = 0;
  classic.room.game.bag = [];
  classic.room.game.racks[0] = new Array(16).fill(null);
  classic.room.game.racks[0][0] = { letter: 'c', mod: null };
  classic.room.game.racks[0][1] = { letter: 'a', mod: null };
  classic.room.game.racks[0][2] = { letter: 't', mod: null };
  classic.room.game.racks[1] = new Array(16).fill(null);
  classic.room.game.racks[1][0] = { letter: 'a', mod: null };
  classic.room.game.racks[1][1] = { letter: 'x', mod: null };

  engine.skipTurn(classic.sockets[0]);
  assert(classic.room.game.consecutiveSkips === 1, 'First Classic skip did not start the skip streak');

  engine.playWord(classic.sockets[1], { indices: [0] });
  assert(classic.room.game.gameOver === false, 'Classic incorrectly ended after a word interrupted the skip streak');
  assert(classic.room.game.consecutiveSkips === 0, 'Classic word play did not reset the skip streak');
  assert(classic.room.game.currentPlayer === 0, 'Classic word play did not return the turn correctly');

  engine.skipTurn(classic.sockets[0]);
  assert(classic.room.game.gameOver === false, 'One skip after a played word incorrectly counted with the old streak');
  assert(classic.room.game.consecutiveSkips === 1, 'Classic skip streak did not restart after a played word');
}

console.log('Lexigon status-message self-tests passed.');

// Unexpected disconnects retain the player's seat and live match. The room pauses
// until the same private reconnect token claims that seat again.
{
  const reconnect = makeRoom('RCNT', {
    mode: 'duel', playerCount: 2, bagSize: 160, minPerLetter: 1, startingHP: 200,
  });
  reconnect.room.chat = [];
  reconnect.room.players[0].reconnectToken = 'token-player-0';
  reconnect.room.players[1].reconnectToken = 'token-player-1';
  const originalGame = reconnect.room.game;
  const disconnectedSocket = reconnect.sockets[1];

  engine.disconnectSocketFromRoom(disconnectedSocket);
  assert(reconnect.room.players.length === 2, 'Disconnect incorrectly removed the player seat');
  assert(reconnect.room.game === originalGame && reconnect.room.phase === 'game', 'Disconnect incorrectly aborted the live match');
  assert(reconnect.room.hostId === 'p0', 'Disconnect incorrectly reassigned the host');
  assert(reconnect.room.players[1].ws === null, 'Disconnected player still has a live socket');
  assert(engine.publicRoomState(reconnect.room).players[1].connected === false, 'Disconnected player is still public as connected');
  assert(engine.publicGameStateFor(reconnect.room, 0).pausedForDisconnect === true, 'Match did not pause for a disconnected player');
  const disconnectStatus = reconnect.room.chat.find(message => message.systemType === 'disconnect' && message.meta?.actorId === 'p1');
  assert(disconnectStatus?.text === 'Player 2 disconnected.', 'Disconnect status message mismatch');

  const badSocket = fakeSocket('bad', null);
  engine.resumeRoom(badSocket, { roomCode: 'RCNT', playerId: 'p1', reconnectToken: 'wrong-token' });
  assert(badSocket.sent.at(-1)?.type === 'error' && badSocket.sent.at(-1)?.code === 'resume_failed', 'Bad reconnect token was not rejected');
  assert(reconnect.room.players[1].ws === null, 'Bad reconnect token reclaimed the player seat');

  // A valid reconnect token must not displace an already-connected player.
  const connectedPlayer = reconnect.room.players[0];
  const connectedSocket = connectedPlayer.ws;
  const connectedToken = connectedPlayer.reconnectToken;
  const duplicateSocket = fakeSocket('duplicate', null);
  engine.resumeRoom(duplicateSocket, { roomCode: 'RCNT', playerId: connectedPlayer.id, reconnectToken: connectedToken });
  assert(duplicateSocket.sent.at(-1)?.type === 'error' && duplicateSocket.sent.at(-1)?.code === 'already_connected', 'Duplicate reconnect was not rejected');
  assert(connectedPlayer.ws === connectedSocket, 'Duplicate reconnect displaced the existing socket');
  assert(connectedPlayer.reconnectToken === connectedToken, 'Duplicate reconnect rotated the active player token');
  assert(duplicateSocket.roomCode !== 'RCNT' && duplicateSocket.playerId !== connectedPlayer.id, 'Rejected duplicate socket gained room membership');

  const resumedSocket = fakeSocket('fresh', null);
  engine.resumeRoom(resumedSocket, { roomCode: 'RCNT', playerId: 'p1', reconnectToken: 'token-player-1' });
  assert(reconnect.room.players[1].ws === resumedSocket, 'Reconnect did not attach the replacement socket');
  assert(resumedSocket.roomCode === 'RCNT' && resumedSocket.playerId === 'p1', 'Reconnect socket membership mismatch');
  assert(reconnect.room.players[1].reconnectToken !== 'token-player-1', 'Reconnect token was not rotated');
  assert(engine.publicGameStateFor(reconnect.room, 0).pausedForDisconnect === false, 'Match stayed paused after everybody reconnected');
  const rejoinStatus = reconnect.room.chat.find(message => message.systemType === 'rejoin' && message.meta?.actorId === 'p1');
  assert(rejoinStatus?.text === 'Player 2 rejoined.', 'Rejoin status message mismatch');
  const resumedState = resumedSocket.sent.at(-1);
  assert(resumedState?.type === 'room_state' && resumedState.you?.id === 'p1', 'Reconnected player did not receive room state');
  assert(typeof resumedState.you?.reconnectToken === 'string' && resumedState.you.reconnectToken.length > 20, 'Reconnected player did not receive the rotated reconnect token');
}

console.log('Lexigon reconnection self-tests passed.');


// Frontend reconnect policy: a duplicate-tab resume failure leaves the shared
// localStorage seat intact, same-room Join retries that seat, and a different
// room is blocked until the existing browser room is explicitly left.
{
  const frontend = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  assert(frontend.includes("if (msg.code === 'already_connected')"), 'Frontend does not handle already_connected separately');
  assert(frontend.includes('function handleExistingBrowserRoomSession(targetRoomCode = null)'), 'Frontend browser-room guard is missing');
  assert(frontend.includes('if (targetRoomCode && session.roomCode === targetRoomCode)'), 'Same-room explicit Join does not retry the saved seat');
  assert(frontend.includes('Leave that room before creating or joining another room.'), 'Different-room browser guard message is missing');
}

console.log('Lexigon frontend reconnect-policy self-tests passed.');

// Fully disconnected rooms remain reconnectable for a grace period, then expire.
{
  const expiry = makeRoom('EXPR', {
    mode: 'classic', playerCount: 2, bagSize: 160, minPerLetter: 1, startingHP: 200,
  });
  expiry.room.allDisconnectedAt = 1_000;
  expiry.room.players.forEach(player => { player.ws = null; });
  engine.cleanupExpiredRooms(1_000 + engine._roomDisconnectedTtlMs - 1);
  assert(engine._rooms.has('EXPR'), 'Fully disconnected room expired before the grace period ended');
  engine.cleanupExpiredRooms(1_000 + engine._roomDisconnectedTtlMs);
  assert(!engine._rooms.has('EXPR'), 'Fully disconnected room did not expire after the grace period');
}

// The host can end a live game early without destroying the room.
{
  const early = makeRoom('ENDG', {
    mode: 'classic', playerCount: 2, bagSize: 160, minPerLetter: 1, startingHP: 200,
  });
  early.room.chat = [];
  engine._handleMessage(early.sockets[0], Buffer.from(JSON.stringify({ type: 'end_game' })));
  assert(engine._rooms.has('ENDG'), 'Ending a game early incorrectly destroyed the room');
  assert(early.room.phase === 'lobby' && early.room.game === null, 'Ending a game early did not return the room to the lobby');
  const earlyEndStatus = early.room.chat.find(message => message.systemType === 'end_game' && message.meta?.actorId === 'p0');
  assert(earlyEndStatus, 'Early game end was not recorded in room chat');
  assert(earlyEndStatus.text === 'Player 1 ended the game early.', 'Early game end status text mismatch');
}

// Only the host can close a lobby, and closing it removes everybody at once.
{
  const closable = makeRoom('CLOS', {
    mode: 'classic', playerCount: 2, bagSize: 160, minPerLetter: 1, startingHP: 200,
  });
  closable.room.phase = 'lobby';
  closable.room.game = null;
  closable.room.chat = [];
  engine._handleMessage(closable.sockets[1], Buffer.from(JSON.stringify({ type: 'close_room' })));
  assert(engine._rooms.has('CLOS'), 'Non-host was able to close the room');
  assert(closable.sockets[1].sent.at(-1)?.type === 'error', 'Non-host close attempt was not rejected');

  engine._handleMessage(closable.sockets[0], Buffer.from(JSON.stringify({ type: 'close_room' })));
  assert(!engine._rooms.has('CLOS'), 'Host close did not delete the room');
  for (const socket of closable.sockets) {
    assert(socket.sent.some(message => message.type === 'room_closed'), 'Connected player did not receive room_closed');
    assert(socket.roomCode === null && socket.playerId === null, 'Closed-room socket retained room membership');
  }
}

// Frontend exposes the host-only close/end controls and handles a closed room by
// clearing the saved reconnect identity and returning to Home.
{
  const frontend = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  assert(frontend.includes('id="closeRoomBtn"'), 'Lobby close-room control is missing');
  assert(frontend.includes('id="endOnlineGameBtn"'), 'Online end-game control is missing');
  assert(frontend.includes("sendOnline({ type: 'close_room' })"), 'Close-room control is not wired to the server');
  assert(frontend.includes("sendOnline({ type: 'end_game' })"), 'End-game control is not wired to the server');
  assert(frontend.includes("if (msg.type === 'room_closed')"), 'Frontend does not handle server room closure');
  assert(frontend.includes("case 'end_game':"), 'Frontend does not format early game-end status messages');
  assert(frontend.includes("You ended the game early."), 'Frontend lacks viewer-relative early game-end status text');
  assert(frontend.includes("setOnlineStatus(els.homeOnlineStatus, msg.message || 'The room was closed.')"), 'Closed-room notice is not shown on Home');
}

console.log('Lexigon room lifecycle self-tests passed.');
