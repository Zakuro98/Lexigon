'use strict';

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

const duelScore = engine.calcWordScore('duel', [
  { letter: 'a', mod: 'X2' },
  { letter: 'b', mod: 'X3' },
]);
assert(duelScore.letterSum === 4, 'Duel base damage mismatch');
assert(duelScore.boostPercent === 30, 'Duel additive boost mismatch');
assert(duelScore.total === 6, 'Duel boosted damage should round up');
assert(duelScore.lengthBonus === 0, 'Duel must not have a length damage bonus');
assert(engine.resolveWord('_') === 'a', 'Wildcard resolution mismatch');

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
const duelPlayStatus = room.chat?.find(message => message.kind === 'system' && message.text === 'Player 1 played "cat", dealing 4 dmg');
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

console.log('Lexigon status-message self-tests passed.');
