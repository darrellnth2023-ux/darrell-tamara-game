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
  // Wildcards: White background, yellow/purple heart with "WILD" text
  deck.push({ id: id++, num: 'WILD', symbol: '💛', color: 'wild-yellow', joker: true });
  deck.push({ id: id++, num: 'WILD', symbol: '💜', color: 'wild-purple', joker: true });
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
  const jokers = set.filter(t => t.joker);

  if (realTiles.length === 0) return { valid: true };

  // 1. Check Match Set (Same number, different colors)
  const allSameNum = realTiles.every(t => t.num === realTiles[0].num);
  if (allSameNum) {
    const colors = realTiles.map(t => t.color);
    const uniqueColors = new Set(colors);
    if (colors.length !== uniqueColors.size) {
      return { valid: false, reason: "Invalid Match Set! Duplicate colors detected." };
    }
    if (set.length > 4) {
      return { valid: false, reason: "Invalid Match Set! A match set cannot exceed 4 colors." };
    }
    return { valid: true };
  }

  // 2. Check Run Sequence (Consecutive numbers, same color)
  const allSameColor = realTiles.every(t => t.color === realTiles[0].color);
  if (allSameColor) {
    let nums = set.map(t => t.joker ? null : t.num);
    let firstKnownIdx = nums.findIndex(n => n !== null);
    if (firstKnownIdx === -1) return { valid: true };

    let startVal = nums[firstKnownIdx] - firstKnownIdx;

    for (let i = 0; i < nums.length; i++) {
      let expected = startVal + i;
      if (expected < 1 || expected > 13) {
        return { valid: false, reason: "Invalid Sequence! Sequence numbers must stay between 1 and 13." };
      }
      if (nums[i] !== null && nums[i] !== expected) {
        return { valid: false, reason: "Invalid Sequence! Gaps detected. Wildcards cannot jump numbers in a sequence." };
      }
    }
    return { valid: true };
  }

  return { valid: false, reason: "Invalid Set! Tiles must be either matching numbers in different colors, or consecutive numbers in the same color." };
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

    // 1. Verify every set on table is valid
    for (let set of data.tableSets) {
      const check = validateSet(set);
      if (!check.valid) {
        socket.emit('errorMessage', check.reason);
        return;
      }
    }

    // 2. Check Initial 30 Point Meld Rule
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
        socket.emit('errorMessage', `Initial play requires at least 30 points from your rack! You played ${pointsPlayed} points.`);
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
