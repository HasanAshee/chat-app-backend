require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const dbURI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET no está definido en .env');
  process.exit(1);
}

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

const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  passwordHash: { type: String, required: true },
  nameColor: { type: String, default: '#3b82f6' },
  createdAt: { type: Date, default: Date.now }
}));

const COLOR_PALETTE = ['#d946ef', '#4ade80', '#f97316', '#3b82f6', '#ec4899', '#14b8a6'];

function generateRandomColor() {
  return COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
}

function isValidHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

const app = express();
const server = http.createServer(app);
const roomUsers = {};

app.use(cors({
  origin: ["http://localhost:4200", "https://chap-appdemo.netlify.app"]
}));
app.use(express.json());

// ========== AUTH MIDDLEWARE ==========
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token no provisto' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    req.username = payload.username;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// ========== AUTH ENDPOINTS ==========
app.post('/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username y password son requeridos' });
    }
    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: 'El username debe tener entre 3 y 20 caracteres' });
    }
    if (!/^\w+$/.test(username)) {
      return res.status(400).json({ error: 'El username solo puede contener letras, números y guiones bajos' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const existing = await User.findOne({ username });
    if (existing) {
      return res.status(409).json({ error: 'Ese username ya está registrado' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const nameColor = generateRandomColor();

    const user = new User({ username, passwordHash, nameColor });
    await user.save();

    const token = jwt.sign(
      { userId: user._id.toString(), username: user.username },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({
      token,
      user: {
        username: user.username,
        nameColor: user.nameColor
      }
    });
  } catch (err) {
    console.error('Error en /auth/register:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username y password son requeridos' });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = jwt.sign(
      { userId: user._id.toString(), username: user.username },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: {
        username: user.username,
        nameColor: user.nameColor
      }
    });
  } catch (err) {
    console.error('Error en /auth/login:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    res.json({
      username: user.username,
      nameColor: user.nameColor
    });
  } catch (err) {
    console.error('Error en /auth/me:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.patch('/users/me', authMiddleware, async (req, res) => {
  try {
    const { nameColor } = req.body;

    if (nameColor !== undefined && !isValidHexColor(nameColor)) {
      return res.status(400).json({ error: 'Color inválido. Debe ser hex de 6 dígitos (ej: #3b82f6)' });
    }

    const update = {};
    if (nameColor !== undefined) update.nameColor = nameColor;

    const user = await User.findByIdAndUpdate(
      req.userId,
      update,
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({
      username: user.username,
      nameColor: user.nameColor
    });
  } catch (err) {
    console.error('Error en /users/me:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ========== ROOMS ENDPOINT ==========
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

// ========== SOCKETS ==========
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:4200", "https://chap-appdemo.netlify.app"],
    methods: ["GET", "POST"]
  }
});

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