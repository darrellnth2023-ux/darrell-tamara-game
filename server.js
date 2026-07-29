const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let gameState = { players: {}, pool: [], table: [] };

io.on('connection', (socket) => {
  socket.on('joinGame', (playerName) => {
    gameState.players[socket.id] = { name: playerName, rack: [] };
    io.emit('stateUpdate', gameState);
  });

  socket.on('disconnect', () => {
    delete gameState.players[socket.id];
    io.emit('stateUpdate', gameState);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
