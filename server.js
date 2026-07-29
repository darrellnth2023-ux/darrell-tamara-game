const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

function createDeck() {
  const colors = ['red', 'blue', 'yellow', 'black'];
  let deck = [];
  let id = 1;
  colors.forEach(color => {
    for (let num = 1; num <= 13; num++) {
      deck.push({ id: id++, num, color });
      deck.push({ id: id++, num, color });
    }
  });
  // Unique Wildcards: Yellow Heart and Purple Heart
  deck.push({ id: id++, num: '💛', color: 'wild-yellow', joker: true });
  deck.push({ id: id++, num: '💜', color: 'wild-purple', joker: true });
  return deck.sort(() => Math.random() - 0.5);
}

let pool = createDeck();
let players = {};
let playerOrder = [];
let turnIndex = 0;
let tableSets = []; // Current board state
let turnTimer = null;
let timeLeft = 60;
let turnSnapshot = null; // Backup state captured at start of turn

function startTurnTimer() {
  clearInterval(turnTimer);
  timeLeft = 60;
  io.emit('timerUpdate', timeLeft);
  turnTimer = setInterval(() => {
    timeLeft--;
    io.emit('timerUpdate', timeLeft);
    if (timeLeft <= 0) {
      clearInterval(turnTimer);
      handleTimeExpired();
    }
  }, 1000);
}

// Check every set on the board for validity
function isEntireBoardValid(sets) {
  for (let set of sets) {
    if (!isValidSet(set)) return false;
  }
  return true;
}

function handleTimeExpired() {
  const activePlayerId = playerOrder[turnIndex];
  // If board is valid when timer expires, keep changes.
  // If ANY sequence is incomplete/invalid (e.g. "1 3 4 5"), REVERT board & draw penalty tile.
  if (isEntireBoardValid(tableSets)) {
    nextTurn();
  } else {
    revertTurnAndDrawPenalty(activePlayerId);
  }
}

function revertTurnAndDrawPenalty(activeId) {
  if (turnSnapshot) {
    tableSets = JSON.parse(JSON.stringify(turnSnapshot.tableSets));
    if (players[activeId]) {
      players[activeId].rack = JSON.parse(JSON.stringify(turnSnapshot.rack));
      // Penalty: Auto-draw a tile from pool for letting time run out on an invalid board
      if (pool.length > 0) {
        players[activeId].rack.push(pool.pop());
      }
    }
  }
  nextTurn();
}

function nextTurn() {
  if (playerOrder.length === 0) return;
  turnIndex = (turnIndex + 1) % playerOrder.length;
  saveSnapshot();
  startTurnTimer();
  io.emit('gameUpdate', getGameState());
}

function saveSnapshot() {
  const activeId = playerOrder[turnIndex];
  if (activeId && players[activeId]) {
    turnSnapshot = {
      activePlayerId: activeId,
      tableSets: JSON.parse(JSON.stringify(tableSets)),
      rack: JSON.parse(JSON.stringify(players[activeId].rack))
    };
  }
}

function isValidSet(set) {
  if (set.length < 3) return false;

  const realTiles = set.filter(t => !t.joker);
  if (realTiles.length === 0) return true; // All wildcards

  // Check 1: Same Number, All Different Colors
  const allSameNum = realTiles.every(t => t.num === realTiles[0].num);
  if (allSameNum) {
    const colors = realTiles.map(t => t.color);
    const uniqueColors = new Set(colors);
    return colors.length === uniqueColors.size; 
  }

  // Check 2: Same Color, Exact Consecutive Numbers (No gaps allowed!)
  const allSameColor = realTiles.every(t => t.color === realTiles[0].color);
  if (allSameColor) {
    // Map non-wildcard numbers to their positions
    let nums = set.map(t => t.joker ? null : t.num);
    let firstKnownIdx = nums.findIndex(n => n !== null);
    if (firstKnownIdx === -1) return true;
    
    let startVal = nums[firstKnownIdx] - firstKnownIdx;

    for (let i = 0; i < nums.length; i++) {
      let expected = startVal + i;
      if (expected < 1 || expected > 13) return false;
      // If a position doesn't match expected consecutive sequence (gap found), set is INVALID
      if (nums[i] !== null && nums[i] !== expected) return false;
    }
    return true;
  }

  return false;
}

function getGameState() {
  return {
    players,
    playerOrder,
    activePlayerId: playerOrder[turnIndex],
    poolCount: pool.length,
    tableSets,
    timeLeft
  };
}

io.on('connection', (socket) => {
  socket.on('joinGame', (name) => {
    if (!players[socket.id]) {
      let hand = pool.splice(0, 14);
      players[socket.id] = { id: socket.id, name: name || 'Player', rack: hand, initialMeldMade: false };
      playerOrder.push(socket.id);
      if (playerOrder.length === 1) {
        saveSnapshot();
        startTurnTimer();
      }
    }
    io.emit('gameUpdate', getGameState());
  });

  socket.on('updateBoardState', (newTableSets) => {
    const activePlayerId = playerOrder[turnIndex];
    if (socket.id !== activePlayerId) return;
    tableSets = newTableSets;
    io.emit('gameUpdate', getGameState());
  });

  socket.on('submitTurn', (data) => {
    const activePlayerId = playerOrder[turnIndex];
    if (socket.id !== activePlayerId) return;

    // Reject turn if any set on the board has gaps or invalid sequences
    for (let set of data.tableSets) {
      if (!isValidSet(set)) {
        socket.emit('errorMessage', 'Invalid sequence on board! Make sure there are no gaps or incomplete sets.');
        return;
      }
    }

    tableSets = data.tableSets;
    players[activePlayerId].rack = data.rack;
    nextTurn();
  });

  socket.on('drawTile', () => {
    const activePlayerId = playerOrder[turnIndex];
    if (socket.id !== activePlayerId) return;

    // Reset board before drawing if player manual-draws
    if (turnSnapshot) {
      tableSets = JSON.parse(JSON.stringify(turnSnapshot.tableSets));
      players[activePlayerId].rack = JSON.parse(JSON.stringify(turnSnapshot.rack));
    }

    if (pool.length > 0) {
      players[activePlayerId].rack.push(pool.pop());
    }
    nextTurn();
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    playerOrder = playerOrder.filter(id => id !== socket.id);
    if (playerOrder.length === 0) {
      pool = createDeck();
      tableSets = [];
      clearInterval(turnTimer);
    } else {
      turnIndex = turnIndex % playerOrder.length;
    }
    io.emit('gameUpdate', getGameState());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server live on port ${PORT}`));
