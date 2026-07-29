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
  deck.push({ id: id++, num: 'J', color: 'wild', joker: true });
  deck.push({ id: id++, num: 'J', color: 'wild', joker: true });
  return deck.sort(() => Math.random() - 0.5);
}

let pool = createDeck();
let players = {};
let playerOrder = [];
let turnIndex = 0;
let tableSets = [];
let stagingTiles = [];
let turnTimer = null;
let timeLeft = 60;

function startTurnTimer() {
  clearInterval(turnTimer);
  timeLeft = 60;
  io.emit('timerUpdate', timeLeft);
  turnTimer = setInterval(() => {
    timeLeft--;
    io.emit('timerUpdate', timeLeft);
    if (timeLeft <= 0) {
      clearInterval(turnTimer);
      handleTimeout();
    }
  }, 1000);
}

function handleTimeout() {
  const activePlayerId = playerOrder[turnIndex];
  if (activePlayerId && players[activePlayerId]) {
    // Return unsubmitted staging tiles back to active player's rack
    players[activePlayerId].rack.push(...stagingTiles);
    stagingTiles = [];
  }
  nextTurn();
}

function nextTurn() {
  if (playerOrder.length === 0) return;
  turnIndex = (turnIndex + 1) % playerOrder.length;
  stagingTiles = [];
  startTurnTimer();
  io.emit('gameUpdate', getGameState());
}

function getGameState() {
  return {
    players,
    playerOrder,
    activePlayerId: playerOrder[turnIndex],
    poolCount: pool.length,
    tableSets,
    stagingTiles,
    timeLeft
  };
}

io.on('connection', (socket) => {
  socket.on('joinGame', (name) => {
    if (!players[socket.id]) {
      let hand = pool.splice(0, 14);
      players[socket.id] = { id: socket.id, name: name || 'Player', rack: hand, initialMeldMade: false };
      playerOrder.push(socket.id);
      if (playerOrder.length === 1) startTurnTimer();
    }
    io.emit('gameUpdate', getGameState());
  });

  socket.on('stageTile', (tileId) => {
    const activePlayerId = playerOrder[turnIndex];
    if (socket.id !== activePlayerId) return;
    const player = players[activePlayerId];
    const tileIdx = player.rack.findIndex(t => t.id === tileId);
    if (tileIdx !== -1) {
      const [tile] = player.rack.splice(tileIdx, 1);
      stagingTiles.push(tile);
      io.emit('gameUpdate', getGameState());
    }
  });

  socket.on('recallTile', (tileId) => {
    const activePlayerId = playerOrder[turnIndex];
    if (socket.id !== activePlayerId) return;
    const tileIdx = stagingTiles.findIndex(t => t.id === tileId);
    if (tileIdx !== -1) {
      const [tile] = stagingTiles.splice(tileIdx, 1);
      players[activePlayerId].rack.push(tile);
      io.emit('gameUpdate', getGameState());
    }
  });

  socket.on('submitTurn', () => {
    const activePlayerId = playerOrder[turnIndex];
    if (socket.id !== activePlayerId) return;
    const player = players[activePlayerId];

    if (stagingTiles.length === 0) return;

    // Check Initial Meld 30 Point Rule
    if (!player.initialMeldMade) {
      const turnPoints = stagingTiles.reduce((sum, t) => sum + (t.joker ? 0 : t.num), 0);
      if (turnPoints < 30) {
        socket.emit('errorMessage', 'Initial play requires at least 30 total points!');
        return;
      }
      player.initialMeldMade = true;
    }

    tableSets.push([...stagingTiles]);
    stagingTiles = [];
    nextTurn();
  });

  socket.on('drawTile', () => {
    const activePlayerId = playerOrder[turnIndex];
    if (socket.id !== activePlayerId) return;

    // Recall any staging tiles before drawing
    if (stagingTiles.length > 0) {
      players[activePlayerId].rack.push(...stagingTiles);
      stagingTiles = [];
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
      stagingTiles = [];
      clearInterval(turnTimer);
    } else {
      turnIndex = turnIndex % playerOrder.length;
    }
    io.emit('gameUpdate', getGameState());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server live on port ${PORT}`));
