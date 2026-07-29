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
  deck.push({ id: id++, num: '💛', color: 'wild-yellow', joker: true });
  deck.push({ id: id++, num: '💜', color: 'wild-purple', joker: true });
  return deck.sort(() => Math.random() - 0.5);
}

let pool = createDeck();
let players = {};
let playerOrder = [];
let turnIndex = 0;
let tableSets = [];
let turnTimer = null;
let timeLeft = 60;
let turnSnapshot = null;

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

function validateSet(set) {
  if (set.length < 3) {
    return { valid: false, reason: "A set must contain at least 3 tiles!" };
  }

  const realTiles = set.filter(t => !t.joker);
  if (realTiles.length === 0) return { valid: true };

  // Check 1: Match Set (Same Number)
  const allSameNum = realTiles.every(t => t.num === realTiles[0].num);
  if (allSameNum) {
    const colors = realTiles.map(t => t.color);
    const uniqueColors = new Set(colors);
    if (colors.length !== uniqueColors.size) {
      return { valid: false, reason: "Invalid set! Duplicate colors found in match set (e.g. two red tiles)." };
    }
    return { valid: true };
  }

  // Check 2: Run Sequence (Consecutive Numbers, Same Color)
  const allSameColor = realTiles.every(t => t.color === realTiles[0].color);
  if (allSameColor) {
    let nums = set.map(t => t.joker ? null : t.num);
    let firstKnownIdx = nums.findIndex(n => n !== null);
    if (firstKnownIdx === -1) return { valid: true };

    let startVal = nums[firstKnownIdx] - firstKnownIdx;

    for (let i = 0; i < nums.length; i++) {
      let expected = startVal + i;
      if (expected < 1 || expected > 13) {
        return { valid: false, reason: "Invalid sequence! Sequence numbers must stay between 1 and 13." };
      }
      if (nums[i] !== null && nums[i] !== expected) {
        return { valid: false, reason: "Invalid sequence! Numbers must be consecutive in the exact same color." };
      }
    }
    return { valid: true };
  }

  return { valid: false, reason: "Invalid set! Tiles must be either the same number in different colors, or consecutive numbers in the same color." };
}

function handleTimeExpired() {
  const activePlayerId = playerOrder[turnIndex];
  let allValid = tableSets.every(set => validateSet(set).valid);

  if (allValid) {
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

  socket.on('submitTurn', (data) => {
    const activePlayerId = playerOrder[turnIndex];
    if (socket.id !== activePlayerId) return;
    const player = players[activePlayerId];

    // 1. Check all sets on the board for invalid sequence or duplicate colors
    for (let set of data.tableSets) {
      const check = validateSet(set);
      if (!check.valid) {
        socket.emit('errorMessage', check.reason);
        return;
      }
    }

    // 2. Check 30-Point First Play Requirement
    if (!player.initialMeldMade) {
      let pointsPlayed = 0;
      const origRackIds = new Set(turnSnapshot.rack.map(t => t.id));

      data.tableSets.forEach(set => {
        set.forEach(t => {
          if (origRackIds.has(t.id)) {
            pointsPlayed += t.joker ? 0 : (parseInt(t.num) || 0);
          }
        });
      });

      if (pointsPlayed < 30) {
        socket.emit('errorMessage', `Not enough points for initial play! You played ${pointsPlayed} points (Must be 30 or more).`);
        return;
      }
      player.initialMeldMade = true;
    }

    tableSets = data.tableSets;
    players[activePlayerId].rack = data.rack;
    nextTurn();
  });

  socket.on('drawTile', () => {
    const activePlayerId = playerOrder[turnIndex];
    if (socket.id !== activePlayerId) return;

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
