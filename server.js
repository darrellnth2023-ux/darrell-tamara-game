const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Create 106-tile Rummikub deck
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
let tableSets = [];

io.on('connection', (socket) => {
  socket.on('joinGame', (name) => {
    // Deal 14 tiles on join
    if (!players[socket.id]) {
      let hand = pool.splice(0, 14);
      players[socket.id] = { id: socket.id, name: name || 'Player', rack: hand };
    }
    io.emit('gameUpdate', { players, poolCount: pool.length, tableSets });
  });

  socket.on('drawTile', () => {
    if (pool.length > 0 && players[socket.id]) {
      const tile = pool.pop();
      players[socket.id].rack.push(tile);
      io.emit('gameUpdate', { players, poolCount: pool.length, tableSets });
    }
  });

  socket.on('playTileToBoard', (tileId) => {
    const player = players[socket.id];
    if (player) {
      const tileIdx = player.rack.findIndex(t => t.id === tileId);
      if (tileIdx !== -1) {
        const [tile] = player.rack.splice(tileIdx, 1);
        tableSets.push([tile]);
        io.emit('gameUpdate', { players, poolCount: pool.length, tableSets });
      }
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    if (Object.keys(players).length === 0) {
      pool = createDeck();
      tableSets = [];
    }
    io.emit('gameUpdate', { players, poolCount: pool.length, tableSets });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server live on port ${PORT}`));
