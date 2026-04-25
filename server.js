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

mongoose.connect(dbURI, { dbName: 'chat-db' })
.then(() => console.log('MongoDB conectado exitosamente a chat-db'))
.catch(err => console.error('Error de conexión a MongoDB:', err));

const frontendURL = "https://chap-appdemo.netlify.app";

const Message = mongoose.model('Message', new mongoose.Schema({
  text: String,
  username: String,
  nameColor: String,
  type: String,
  room: String,
  createdAt: { type: Date, default: Date.now },
  reactions: {
    type: Map,
    of: [String],
    default: {}
  },
  replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
  replyToSnapshot: {
    type: new mongoose.Schema({
      username: String,
      nameColor: String,
      text: String
    }, { _id: false }),
    default: null
  }
}));

const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  passwordHash: { type: String, required: true },
  nameColor: { type: String, default: '#3b82f6' },
  createdAt: { type: Date, default: Date.now }
}));

const Conversation = mongoose.model('Conversation', new mongoose.Schema({
  participants: { type: [String], required: true, index: true },
  lastMessageAt: { type: Date, default: Date.now },
  lastMessagePreview: { type: String, default: '' },
  lastMessageFrom: { type: String, default: '' },
  unreadCount: {
    type: Map,
    of: Number,
    default: {}
  }
}));

const DirectMessage = mongoose.model('DirectMessage', new mongoose.Schema({
  conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
  from: { type: String, required: true },
  fromColor: String,
  text: String,
  createdAt: { type: Date, default: Date.now },
  reactions: {
    type: Map,
    of: [String],
    default: {}
  },
  replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'DirectMessage', default: null },
  replyToSnapshot: {
    type: new mongoose.Schema({
      username: String,
      nameColor: String,
      text: String
    }, { _id: false }),
    default: null
  }
}));

const COLOR_PALETTE = ['#d946ef', '#4ade80', '#f97316', '#3b82f6', '#ec4899', '#14b8a6'];

function generateRandomColor() {
  return COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
}

function sortParticipants(a, b) {
  return [a, b].sort();
}

function isValidHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

function getGuestColor(username) {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash % COLOR_PALETTE.length);
  return COLOR_PALETTE[index];
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

app.get('/users/colors', async (req, res) => {
  try {
    const usernamesParam = req.query.usernames;
    if (!usernamesParam || typeof usernamesParam !== 'string') {
      return res.json({});
    }

    const usernames = usernamesParam
      .split(',')
      .map(u => u.trim())
      .filter(u => u.length > 0)
      .slice(0, 100);

    if (usernames.length === 0) {
      return res.json({});
    }

    const users = await User.find({ username: { $in: usernames } }).select('username nameColor');
    const colorMap = {};
    for (const u of users) {
      colorMap[u.username] = u.nameColor;
    }
    res.json(colorMap);
  } catch (err) {
    console.error('Error en /users/colors:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Lista todas las conversaciones del usuario logueado
app.get('/dms', authMiddleware, async (req, res) => {
  try {
    const conversations = await Conversation
      .find({ participants: req.username })
      .sort({ lastMessageAt: -1 })
      .limit(50);

    // Enriquecer con datos del otro participante (color, etc.)
    const otherUsernames = conversations.map(c =>
      c.participants.find(p => p !== req.username)
    ).filter(Boolean);

    const otherUsers = await User.find({ username: { $in: otherUsernames } })
      .select('username nameColor');
    const userMap = new Map(otherUsers.map(u => [u.username, u]));

    const result = conversations.map(c => {
      const other = c.participants.find(p => p !== req.username);
      const otherUser = userMap.get(other);
      return {
        _id: c._id.toString(),
        otherUsername: other,
        otherNameColor: otherUser?.nameColor || '#999999',
        lastMessageAt: c.lastMessageAt,
        lastMessagePreview: c.lastMessagePreview,
        lastMessageFrom: c.lastMessageFrom,
        unreadCount: c.unreadCount?.get(req.username) || 0
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Error en GET /dms:', err);
    res.status(500).json({ error: 'Error al cargar DMs' });
  }
});

// Abre o crea una conversación con un usuario
app.post('/dms/open', authMiddleware, async (req, res) => {
  try {
    const { withUsername } = req.body;
    if (!withUsername || typeof withUsername !== 'string') {
      return res.status(400).json({ error: 'Falta el username' });
    }
    if (withUsername === req.username) {
      return res.status(400).json({ error: 'No podés mandarte un DM a vos mismo' });
    }

    const otherUser = await User.findOne({ username: withUsername });
    if (!otherUser) {
      return res.status(404).json({ error: 'El usuario no existe o no está registrado' });
    }

    const participants = sortParticipants(req.username, withUsername);

    let conversation = await Conversation.findOne({
      participants: { $all: participants, $size: 2 }
    });

    if (!conversation) {
      conversation = new Conversation({
        participants,
        lastMessageAt: new Date(),
        lastMessagePreview: '',
        lastMessageFrom: '',
        unreadCount: new Map()
      });
      await conversation.save();
    }

    res.json({
      _id: conversation._id.toString(),
      otherUsername: otherUser.username,
      otherNameColor: otherUser.nameColor,
      lastMessageAt: conversation.lastMessageAt,
      lastMessagePreview: conversation.lastMessagePreview,
      lastMessageFrom: conversation.lastMessageFrom,
      unreadCount: conversation.unreadCount?.get(req.username) || 0
    });
  } catch (err) {
    console.error('Error en POST /dms/open:', err);
    res.status(500).json({ error: 'Error al abrir DM' });
  }
});

// Trae mensajes de una conversación (paginado simple, últimos 50)
app.get('/dms/:id/messages', authMiddleware, async (req, res) => {
  try {
    const conversation = await Conversation.findById(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }
    if (!conversation.participants.includes(req.username)) {
      return res.status(403).json({ error: 'No tenés acceso a esta conversación' });
    }

    const messages = await DirectMessage.find({ conversationId: conversation._id })
      .sort({ createdAt: -1 })
      .limit(50);

    const result = messages.reverse().map(m => ({
      _id: m._id.toString(),
      from: m.from,
      fromColor: m.fromColor,
      text: m.text,
      createdAt: m.createdAt,
      reactions: m.reactions ? Object.fromEntries(m.reactions) : {},
      replyTo: m.replyTo ? m.replyTo.toString() : null,
      replyToSnapshot: m.replyToSnapshot || null
    }));

    res.json(result);
  } catch (err) {
    console.error('Error en GET /dms/:id/messages:', err);
    res.status(500).json({ error: 'Error al cargar mensajes' });
  }
});

// ========== DMs ENDPOINT ==========
app.get('/dms', authMiddleware, async (req, res) => {
  try {
    const conversations = await Conversation
      .find({ participants: req.username })
      .sort({ lastMessageAt: -1 })
      .limit(50);

    const otherUsernames = conversations.map(c =>
      c.participants.find(p => p !== req.username)
    ).filter(Boolean);

    const otherUsers = await User.find({ username: { $in: otherUsernames } })
      .select('username nameColor');
    const userMap = new Map(otherUsers.map(u => [u.username, u]));

    const result = conversations.map(c => {
      const other = c.participants.find(p => p !== req.username);
      const otherUser = userMap.get(other);
      return {
        _id: c._id.toString(),
        otherUsername: other,
        otherNameColor: otherUser?.nameColor || '#999999',
        lastMessageAt: c.lastMessageAt,
        lastMessagePreview: c.lastMessagePreview,
        lastMessageFrom: c.lastMessageFrom,
        unreadCount: c.unreadCount?.get(req.username) || 0
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Error en GET /dms:', err);
    res.status(500).json({ error: 'Error al cargar DMs' });
  }
});

app.post('/dms/open', authMiddleware, async (req, res) => {
  try {
    const { withUsername } = req.body;
    if (!withUsername || typeof withUsername !== 'string') {
      return res.status(400).json({ error: 'Falta el username' });
    }
    if (withUsername === req.username) {
      return res.status(400).json({ error: 'No podés mandarte un DM a vos mismo' });
    }

    const otherUser = await User.findOne({ username: withUsername });
    if (!otherUser) {
      return res.status(404).json({ error: 'El usuario no existe o no está registrado' });
    }

    const participants = sortParticipants(req.username, withUsername);

    let conversation = await Conversation.findOne({
      participants: { $all: participants, $size: 2 }
    });

    if (!conversation) {
      conversation = new Conversation({
        participants,
        lastMessageAt: new Date(),
        lastMessagePreview: '',
        lastMessageFrom: '',
        unreadCount: new Map()
      });
      await conversation.save();
    }

    res.json({
      _id: conversation._id.toString(),
      otherUsername: otherUser.username,
      otherNameColor: otherUser.nameColor,
      lastMessageAt: conversation.lastMessageAt,
      lastMessagePreview: conversation.lastMessagePreview,
      lastMessageFrom: conversation.lastMessageFrom,
      unreadCount: conversation.unreadCount?.get(req.username) || 0
    });
  } catch (err) {
    console.error('Error en POST /dms/open:', err);
    res.status(500).json({ error: 'Error al abrir DM' });
  }
});

app.get('/dms/:id/messages', authMiddleware, async (req, res) => {
  try {
    const conversation = await Conversation.findById(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }
    if (!conversation.participants.includes(req.username)) {
      return res.status(403).json({ error: 'No tenés acceso a esta conversación' });
    }

    const messages = await DirectMessage.find({ conversationId: conversation._id })
      .sort({ createdAt: -1 })
      .limit(50);

    const result = messages.reverse().map(m => ({
      _id: m._id.toString(),
      from: m.from,
      fromColor: m.fromColor,
      text: m.text,
      createdAt: m.createdAt,
      reactions: m.reactions ? Object.fromEntries(m.reactions) : {},
      replyTo: m.replyTo ? m.replyTo.toString() : null,
      replyToSnapshot: m.replyToSnapshot || null
    }));

    res.json(result);
  } catch (err) {
    console.error('Error en GET /dms/:id/messages:', err);
    res.status(500).json({ error: 'Error al cargar mensajes' });
  }
});

app.post('/dms/:id/read', authMiddleware, async (req, res) => {
  try {
    const conversation = await Conversation.findById(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }
    if (!conversation.participants.includes(req.username)) {
      return res.status(403).json({ error: 'No tenés acceso a esta conversación' });
    }

    if (!conversation.unreadCount) conversation.unreadCount = new Map();
    conversation.unreadCount.set(req.username, 0);
    await conversation.save();

    const otherUser = conversation.participants.find(p => p !== req.username);
    io.to(`user:${otherUser}`).emit('dm read', {
      conversationId: conversation._id.toString(),
      readBy: req.username
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Error en POST /dms/:id/read:', err);
    res.status(500).json({ error: 'Error al marcar como leído' });
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

app.get('/messages/search', async (req, res) => {
  try {
    const { room, q } = req.query;

    if (!room || typeof room !== 'string') {
      return res.status(400).json({ error: 'Parámetro "room" requerido' });
    }
    if (!q || typeof q !== 'string' || q.trim().length < 2) {
      return res.json([]);
    }

    const escaped = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');

    const results = await Message.find({
      room,
      type: 'message',
      text: regex
    })
      .sort({ createdAt: -1 })
      .limit(30)
      .select('_id text username nameColor createdAt');

    res.json(results.map(msg => ({
      _id: msg._id.toString(),
      text: msg.text,
      username: msg.username,
      nameColor: msg.nameColor || '#999999',
      createdAt: msg.createdAt
    })));
  } catch (err) {
    console.error('Error en /messages/search:', err);
    res.status(500).json({ error: 'Error al buscar mensajes' });
  }
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

  socket.on('join room', async ({ room, username, token }) => {
    try {
      let resolvedUsername = username;
      let nameColor;
      let isGuest = true;

      if (token) {
        try {
          const payload = jwt.verify(token, JWT_SECRET);
          const user = await User.findById(payload.userId);
          if (!user) {
            socket.emit('join error', { message: 'Usuario no encontrado' });
            return;
          }
          resolvedUsername = user.username;
          nameColor = user.nameColor;
          isGuest = false;
        } catch (err) {
          socket.emit('join error', { message: 'Sesión inválida o expirada. Volvé a iniciar sesión.' });
          return;
        }
      } else {
        if (!username || typeof username !== 'string' || !username.trim()) {
          socket.emit('join error', { message: 'Username inválido' });
          return;
        }
        const existing = await User.findOne({ username: username.trim() });
        if (existing) {
          socket.emit('join error', {
            message: 'Ese nombre pertenece a un usuario registrado. Iniciá sesión o usá otro nombre.'
          });
          return;
        }
        resolvedUsername = username.trim();
        nameColor = getGuestColor(resolvedUsername);
        isGuest = true;
      }

      if (!room || typeof room !== 'string' || !room.trim()) {
        socket.emit('join error', { message: 'Nombre de sala inválido' });
        return;
      }

      if (roomUsers[room] && roomUsers[room].some(u => u.username === resolvedUsername)) {
        socket.emit('join error', { message: 'Ya hay alguien con ese nombre en la sala' });
        return;
      }

      socket.join(room);
      socket.username = resolvedUsername;
      socket.room = room;
      socket.isGuest = isGuest;
      socket.nameColor = nameColor;

      if (!roomUsers[room]) {
        roomUsers[room] = [];
      }
      roomUsers[room].push({ username: resolvedUsername, nameColor, isGuest });

      socket.emit('join success', {
        username: resolvedUsername,
        nameColor,
        isGuest,
        room
      });

      try {
        const messages = await Message.find({ room: room }).sort({ createdAt: -1 }).limit(50);
        const messagesWithReactions = messages.reverse().map(msg => ({
          _id: msg._id,
          text: msg.text,
          username: msg.username,
          nameColor: msg.nameColor,
          type: msg.type,
          room: msg.room,
          createdAt: msg.createdAt,
          reactions: msg.reactions ? Object.fromEntries(msg.reactions) : {},
          replyTo: msg.replyTo ? msg.replyTo.toString() : null,
          replyToSnapshot: msg.replyToSnapshot || null
        }));
        socket.emit('history', messagesWithReactions);
      } catch (err) {
        console.error('Error al cargar historial:', err);
      }

      io.to(room).emit('update user list', roomUsers[room]);

      const joinMessage = {
        text: `¡${resolvedUsername} se ha unido al chat!`,
        type: 'notification'
      };
      socket.broadcast.to(room).emit('chat message', joinMessage);
    } catch (err) {
      console.error('Error en join room:', err);
      socket.emit('join error', { message: 'Error interno al unirse a la sala' });
    }
  });

  socket.on('register user channel', async ({ token }) => {
    if (!token) return;
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(payload.userId);
      if (!user) return;
      socket.authUsername = user.username;
      socket.join(`user:${user.username}`);
    } catch (err) {
    }
  });

  socket.on('dm send', async ({ conversationId, text, replyToId, token }) => {
    try {
      if (!token) return;
      const payload = jwt.verify(token, JWT_SECRET);
      const sender = await User.findById(payload.userId);
      if (!sender) return;

      const conversation = await Conversation.findById(conversationId);
      if (!conversation) return;
      if (!conversation.participants.includes(sender.username)) return;

      const otherUser = conversation.participants.find(p => p !== sender.username);

      let replyToSnapshot = null;
      let replyToRef = null;
      if (replyToId) {
        try {
          const original = await DirectMessage.findById(replyToId);
          if (original && original.conversationId.toString() === conversationId) {
            replyToRef = original._id;
            replyToSnapshot = {
              username: original.from,
              nameColor: original.fromColor || '#999999',
              text: (original.text || '').slice(0, 200)
            };
          }
        } catch (err) {
        }
      }

      const dm = new DirectMessage({
        conversationId: conversation._id,
        from: sender.username,
        fromColor: sender.nameColor,
        text,
        replyTo: replyToRef,
        replyToSnapshot
      });
      await dm.save();

      conversation.lastMessageAt = dm.createdAt;
      conversation.lastMessagePreview = (text || '').slice(0, 80);
      conversation.lastMessageFrom = sender.username;
      if (!conversation.unreadCount) conversation.unreadCount = new Map();
      const currentUnread = conversation.unreadCount.get(otherUser) || 0;
      conversation.unreadCount.set(otherUser, currentUnread + 1);
      await conversation.save();

      const payloadOut = {
        _id: dm._id.toString(),
        conversationId: conversation._id.toString(),
        from: dm.from,
        fromColor: dm.fromColor,
        text: dm.text,
        createdAt: dm.createdAt,
        reactions: {},
        replyTo: dm.replyTo ? dm.replyTo.toString() : null,
        replyToSnapshot: dm.replyToSnapshot || null,
        conversationMeta: {
          lastMessageAt: conversation.lastMessageAt,
          lastMessagePreview: conversation.lastMessagePreview,
          lastMessageFrom: conversation.lastMessageFrom
        }
      };

      io.to(`user:${sender.username}`).emit('dm message', payloadOut);
      io.to(`user:${otherUser}`).emit('dm message', payloadOut);
    } catch (err) {
      console.error('Error en dm send:', err);
    }
  });

  socket.on('dm typing', ({ conversationId, token }) => {
    if (!token) return;
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (!socket.authUsername) return;
      Conversation.findById(conversationId).then(conv => {
        if (!conv) return;
        const other = conv.participants.find(p => p !== socket.authUsername);
        if (other) {
          io.to(`user:${other}`).emit('dm typing', {
            conversationId,
            from: socket.authUsername
          });
        }
      });
    } catch (err) {}
  });

  socket.on('dm stop typing', ({ conversationId, token }) => {
    if (!token) return;
    try {
      jwt.verify(token, JWT_SECRET);
      if (!socket.authUsername) return;
      Conversation.findById(conversationId).then(conv => {
        if (!conv) return;
        const other = conv.participants.find(p => p !== socket.authUsername);
        if (other) {
          io.to(`user:${other}`).emit('dm stop typing', { conversationId });
        }
      });
    } catch (err) {}
  });

  socket.on('chat message', async ({ room, message, username, replyToId }) => {
    try {
      const senderColor = socket.nameColor || getGuestColor(username);

      let replyToSnapshot = null;
      let replyToRef = null;

      if (replyToId) {
        try {
          const original = await Message.findById(replyToId);
          if (original && original.room === room && original.type === 'message') {
            replyToRef = original._id;
            replyToSnapshot = {
              username: original.username,
              nameColor: original.nameColor || getGuestColor(original.username),
              text: (original.text || '').slice(0, 200)
            };
          }
        } catch (err) {
          console.warn('replyToId inválido, se ignora:', err.message);
        }
      }

      const msgToSave = new Message({
        text: message,
        username,
        nameColor: senderColor,
        type: 'message',
        room,
        replyTo: replyToRef,
        replyToSnapshot
      });
      await msgToSave.save();

      io.to(room).emit('chat message', {
        _id: msgToSave._id.toString(),
        text: msgToSave.text,
        username: msgToSave.username,
        nameColor: msgToSave.nameColor,
        type: msgToSave.type,
        room: msgToSave.room,
        createdAt: msgToSave.createdAt,
        reactions: {},
        replyTo: msgToSave.replyTo ? msgToSave.replyTo.toString() : null,
        replyToSnapshot: msgToSave.replyToSnapshot || null
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

  socket.on('color changed', ({ nameColor }) => {
    if (!socket.username || !socket.room || socket.isGuest) return;
    if (!isValidHexColor(nameColor)) return;

    socket.nameColor = nameColor;

    if (roomUsers[socket.room]) {
      const userEntry = roomUsers[socket.room].find(u => u.username === socket.username);
      if (userEntry) {
        userEntry.nameColor = nameColor;
      }
    }

    io.to(socket.room).emit('user color updated', {
      username: socket.username,
      nameColor
    });

    io.to(socket.room).emit('update user list', roomUsers[socket.room]);
  });

  socket.on('disconnect', () => {
    console.log('Un usuario se ha desconectado');
    const { username, room } = socket;
    if (username && room && roomUsers[room]) {
      roomUsers[room] = roomUsers[room].filter(u => u.username !== username);
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