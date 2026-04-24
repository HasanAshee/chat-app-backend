require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');
const cors = require('cors');

const dbURI = process.env.MONGODB_URI;
mongoose.connect(dbURI)
.then(() => console.log('MongoDB conectado exitosamente...'))
.catch(err => console.error('Error de conexión a MongoDB:', err));

const frontendURL = "https://chap-appdemo.netlify.app";

const Message = mongoose.model('Message', new mongoose.Schema({
  text: String,
  username: String,
  type: String,
  room: String,
  createdAt: { type: Date, default: Date.now },
  reactions: {
    type: Map,
    of: [String],
    default: {}
  }
}));

const app = express();
const server = http.createServer(app);
const roomUsers = {};

//app.use(cors({
//  origin: ["http://localhost:4200", "https://TU-FUTURO-SITIO.netlify.app"]
//}));

app.use(cors({
  origin: ["http://localhost:4200", "https://chap-appdemo.netlify.app"]
}));

app.get('/rooms', (req, res) => {
  const rooms = Object.entries(roomUsers)
    .filter(([_, users]) => users.length > 0)
    .map(([name, users]) => ({
      name,
      userCount: users.length
    }))
    .sort((a, b) => b.userCount - a.userCount);

  res.json(rooms);
});

const io = new Server(server, {
  cors: {
    origin: ["http://localhost:4200", "https://chap-appdemo.netlify.app"],
    methods: ["GET", "POST"]
  }
});
//const io = new Server(server, {
//  cors: {
//    origin: ["http://localhost:4200", "https://TU-FUTURO-SITIO.netlify.app"],
//    methods: ["GET", "POST"]
//  }
//});

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
      const messagesWithReactions = messages.reverse().map(msg => ({
        _id: msg._id,
        text: msg.text,
        username: msg.username,
        type: msg.type,
        room: msg.room,
        createdAt: msg.createdAt,
        reactions: msg.reactions ? Object.fromEntries(msg.reactions) : {}
      }));
      socket.emit('history', messagesWithReactions);
    } catch (err) { /* ... */ }

    io.to(room).emit('update user list', roomUsers[room]);

    const joinMessage = {
      text: `¡${username} se ha unido al chat!`,
      type: 'notification'
    };
    socket.broadcast.to(room).emit('chat message', joinMessage);
  });

  socket.on('chat message', async ({ room, message, username }) => {
    try {
      const msgToSave = new Message({ text: message, username, type: 'message', room });
      await msgToSave.save();

      io.to(room).emit('chat message', {
        _id: msgToSave._id.toString(),
        text: msgToSave.text,
        username: msgToSave.username,
        type: msgToSave.type,
        room: msgToSave.room,
        createdAt: msgToSave.createdAt,
        reactions: {}
      });
    } catch (err) {
      console.error('Error al guardar el mensaje:', err);
    }
  });

  socket.on('toggle reaction', async ({ messageId, emoji, username, room }) => {
    try {
      const message = await Message.findById(messageId);
      if (!message) return;

      if (!message.reactions) {
        message.reactions = new Map();
      }

      const users = message.reactions.get(emoji) || [];
      const hasReacted = users.includes(username);

      if (hasReacted) {
        const filtered = users.filter(u => u !== username);
        if (filtered.length === 0) {
          message.reactions.delete(emoji);
        } else {
          message.reactions.set(emoji, filtered);
        }
      } else {
        message.reactions.set(emoji, [...users, username]);
      }

      await message.save();

      const reactionsObj = Object.fromEntries(message.reactions);

      io.to(room).emit('message reaction updated', {
        messageId: message._id.toString(),
        reactions: reactionsObj
      });
    } catch (err) {
      console.error('Error al actualizar reacción:', err);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
