const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');


const dbURI = 'mongodb+srv://atm_user:iyQtDrRv9ROOrgPZ@cluster0.tywrrxs.mongodb.net/chat-db?retryWrites=true&w=majority&appName=Cluster0';
mongoose.connect(dbURI)
  .then(() => console.log('MongoDB conectado exitosamente...'))
  .catch(err => console.error('Error de conexión a MongoDB:', err));

const Message = mongoose.model('Message', new mongoose.Schema({
  text: String,
  username: String, 
  type: String,     
  room: String,
  createdAt: { type: Date, default: Date.now }
}));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:4200",
    methods: ["GET", "POST"]
  }
});
const roomUsers = {};

io.on('connection', (socket) => {
  console.log('Un usuario se ha conectado');

  socket.on('join room', async ({ room, username }) => {
    socket.join(room);
    socket.username = username;
    socket.room = room;

    if (!roomUsers[room]) {
      roomUsers[room] = [];
    }
    roomUsers[room].push(username);

    try {
      const messages = await Message.find({ room: room }).sort({ createdAt: -1 }).limit(50);
      socket.emit('history', messages.reverse());
    } catch (err) { /* ... */ }

    io.to(room).emit('update user list', roomUsers[room]);

    const joinMessage = {
      text: `¡${username} se ha unido al chat!`,
      type: 'notification'
    };
    socket.broadcast.to(room).emit('chat message', joinMessage);
  });

  socket.on('chat message', async ({ room, message, username }) => {
  const msgObject = { text: message, username, type: 'message', room };
  const msgToSave = new Message(msgObject);
  try {
    await msgToSave.save();
    socket.broadcast.to(room).emit('chat message', msgObject);
  } catch (err) { 
    console.error('Error al guardar el mensaje:', err);
  }
});

  socket.on('disconnect', () => {
    console.log('Un usuario se ha desconectado');
    const { username, room } = socket;
    if (username && room && roomUsers[room]) {
      roomUsers[room] = roomUsers[room].filter(user => user !== username);
      io.to(room).emit('update user list', roomUsers[room]);

      const leaveMessage = {
        text: `¡${username} ha abandonado el chat!`,
        type: 'notification'
      };
      io.to(room).emit('chat message', leaveMessage);
    }
  });
  socket.on('typing', ({ room, username }) => {
    socket.broadcast.to(room).emit('user typing', username);
  });
  socket.on('stop typing', ({ room }) => {
    socket.broadcast.to(room).emit('user stopped typing');
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
