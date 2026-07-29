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
let tableSets = []; // Array of sets currently on the board
let turnTimer = null;
let timeLeft = 60;
let turnSnapshot = null; // Backup to restore board if turn fails or timer expires

function startTurnTimer() {
  clearInterval(turnTimer);
  timeLeft = 60;
  io.emit('timerUpdate', timeLeft);
  turnTimer = setInterval(() => {
    timeLeft--;
    io.emit('timerUpdate', timeLeft);
    if (timeLeft <= 0) {
      clearInterval(turnTimer);
      revertTurn();
    }
  }, 1000);
}

function revertTurn() {
  if (turnSnapshot) {
    tableSets = JSON.parse(JSON.stringify(turnSnapshot.tableSets));
    if (players[turnSnapshot.activePlayerId]) {
      players[turnSnapshot.activePlayerId].rack = JSON.parse(JSON.stringify(turnSnapshot.rack));
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
  if (realTiles.length === 0) return true; // All jokers

  // Check 1: Same Number, All Different Colors (Match Set)
  const allSameNum = realTiles.every(t => t.num === realTiles[0].num);
  if (allSameNum) {
    const colors = realTiles.map(t => t.color);
    const uniqueColors = new Set(colors);
    return colors.length === uniqueColors.size; // No duplicate colors allowed
  }

  // Check 2: Same Color, Consecutive Numbers (Sequence Run)
  const allSameColor = realTiles.every(t => t.color === realTiles[0].color);
  if (allSameColor) {
    // Check numerical order accounting for missing gaps
    let nums = set.map(t => t.joker ? null : t.num);
    let firstKnownIdx = nums.findIndex(n => n !== null);
    let startVal = nums[firstKnownIdx] - firstKnownIdx;

    for (let i = 0; i < nums.length; i++) {
      let expected = startVal + i;
      if (expected < 1 || expected > 13) return false;
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

    const player = players[activePlayerId];

    // Validate that every set left on the table contains at least 3 valid tiles
    for (let set of data.tableSets) {
      if (!isValidSet(set)) {
        socket.emit('errorMessage', 'Invalid set on board! Sets must be 3+ tiles: either same number in DIFFERENT colors, or consecutive numbers in SAME color.');
        return;
      }
    }

    // Update state
    tableSets = data.tableSets;
    player.rack = data.rack;

    // Check Initial 30-Point Meld Requirement
    if (!player.initialMeldMade) {
      let pointsPlayed = 0;
      // Calculate total points played from rack
      const origRackIds = new Set(turnSnapshot.rack.map(t => t.id));
      data.tableSets.forEach(set => {
        set.forEach(t => {
          if (origRackIds.has(t.id)) {
            pointsPlayed += t.joker ? 0 : parseInt(t.num) || 0;
          }
        });
      });

      if (pointsPlayed < 30) {
        socket.emit('errorMessage', 'Initial play requires at least 30 points from your rack!');
        return;
      }
      player.initialMeldMade = true;
    }

    nextTurn();
  });

  socket.on('drawTile', () => {
    const activePlayerId = playerOrder[turnIndex];
    if (socket.id !== activePlayerId) return;

    revertTurn(); // Revert board modifications before drawing
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
