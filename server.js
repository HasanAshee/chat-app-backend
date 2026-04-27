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
  },
  deletedForEveryone: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
  deletedFor: { type: [String], default: [] }
}));

const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  passwordHash: { type: String, required: true },
  nameColor: { type: String, default: '#3b82f6' },
  bio: { type: String, default: '', maxlength: 200 },
  createdAt: { type: Date, default: Date.now }
}));

const Room = mongoose.model('Room', new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  visibility: { type: String, enum: ['public', 'password', 'invite'], required: true },
  passwordHash: { type: String, default: null },
  ownerUsername: { type: String, required: true },
  invitedUsernames: { type: [String], default: [] },
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
  },
  deletedForEveryone: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
  deletedFor: { type: [String], default: [] }
}));

const COLOR_PALETTE = ['#d946ef', '#4ade80', '#f97316', '#3b82f6', '#ec4899', '#14b8a6'];

function generateRandomColor() {
  return COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
}

function isValidRoomName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 32) return false;
  return /^[\w-]+$/.test(trimmed);
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

const DELETE_FOR_EVERYONE_WINDOW_MS = 24 * 60 * 60 * 1000;

function isWithinDeleteWindow(createdAt) {
  if (!createdAt) return false;
  const ageMs = Date.now() - new Date(createdAt).getTime();
  return ageMs <= DELETE_FOR_EVERYONE_WINDOW_MS;
}

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
      nameColor: user.nameColor,
      bio: user.bio || ''
    });
  } catch (err) {
    console.error('Error en /auth/me:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.patch('/users/me', authMiddleware, async (req, res) => {
  try {
    const { nameColor, bio } = req.body;

    if (nameColor !== undefined && !isValidHexColor(nameColor)) {
      return res.status(400).json({ error: 'Color inválido. Debe ser hex de 6 dígitos (ej: #3b82f6)' });
    }
    if (bio !== undefined) {
      if (typeof bio !== 'string') {
        return res.status(400).json({ error: 'Bio inválida' });
      }
      if (bio.length > 200) {
        return res.status(400).json({ error: 'La bio no puede superar los 200 caracteres' });
      }
    }

    const update = {};
    if (nameColor !== undefined) update.nameColor = nameColor;
    if (bio !== undefined) update.bio = bio;

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
      nameColor: user.nameColor,
      bio: user.bio
    });
  } catch (err) {
    console.error('Error en /users/me:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/users/:username/profile', async (req, res) => {
  try {
    const username = req.params.username;
    if (!username) {
      return res.status(400).json({ error: 'Username inválido' });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const messageCount = await Message.countDocuments({
      username: user.username,
      type: 'message'
    });

    res.json({
      username: user.username,
      nameColor: user.nameColor,
      bio: user.bio || '',
      memberSince: user.createdAt,
      messageCount
    });
  } catch (err) {
    console.error('Error en GET /users/:username/profile:', err);
    res.status(500).json({ error: 'Error al cargar el perfil' });
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

app.post('/rooms', authMiddleware, async (req, res) => {
  try {
    const { name, visibility, password, invitedUsernames } = req.body;

    if (!isValidRoomName(name)) {
      return res.status(400).json({
        error: 'Nombre de sala inválido. 2-32 caracteres, solo letras, números, _ y -'
      });
    }
    if (!['public', 'password', 'invite'].includes(visibility)) {
      return res.status(400).json({ error: 'Visibilidad inválida' });
    }
    if (visibility === 'password' && (!password || password.length < 4)) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
    }

    const trimmedName = name.trim();

    const existing = await Room.findOne({ name: trimmedName });
    if (existing) {
      return res.status(409).json({ error: 'Ya existe una sala con ese nombre' });
    }

    let passwordHash = null;
    if (visibility === 'password') {
      passwordHash = await bcrypt.hash(password, 10);
    }

    let invitedList = [];
    if (visibility === 'invite' && Array.isArray(invitedUsernames)) {
      const cleanList = invitedUsernames
        .map(u => typeof u === 'string' ? u.trim() : '')
        .filter(u => u.length > 0)
        .filter(u => u !== req.username)
        .slice(0, 50);

      if (cleanList.length > 0) {
        const users = await User.find({ username: { $in: cleanList } }).select('username');
        invitedList = users.map(u => u.username);
      }
    }

    const room = new Room({
      name: trimmedName,
      visibility,
      passwordHash,
      ownerUsername: req.username,
      invitedUsernames: invitedList
    });
    await room.save();

    res.status(201).json({
      _id: room._id.toString(),
      name: room.name,
      visibility: room.visibility,
      ownerUsername: room.ownerUsername,
      invitedUsernames: room.invitedUsernames,
      createdAt: room.createdAt
    });
  } catch (err) {
    console.error('Error en POST /rooms:', err);
    res.status(500).json({ error: 'Error al crear la sala' });
  }
});

app.get('/rooms/mine', authMiddleware, async (req, res) => {
  try {
    const rooms = await Room.find({
      $or: [
        { ownerUsername: req.username },
        { invitedUsernames: req.username }
      ]
    }).sort({ createdAt: -1 });

    res.json(rooms.map(r => ({
      _id: r._id.toString(),
      name: r.name,
      visibility: r.visibility,
      ownerUsername: r.ownerUsername,
      invitedUsernames: r.invitedUsernames,
      isOwner: r.ownerUsername === req.username,
      createdAt: r.createdAt
    })));
  } catch (err) {
    console.error('Error en GET /rooms/mine:', err);
    res.status(500).json({ error: 'Error al cargar salas' });
  }
});

app.get('/rooms/:name', authMiddleware, async (req, res) => {
  try {
    const room = await Room.findOne({ name: req.params.name });
    if (!room) {
      return res.status(404).json({ error: 'Sala no encontrada' });
    }

    const isOwner = room.ownerUsername === req.username;
    const isInvited = room.invitedUsernames.includes(req.username);

    if (!isOwner && !isInvited && room.visibility === 'invite') {
      return res.status(403).json({ error: 'No tenés acceso a esta sala' });
    }

    const response = {
      _id: room._id.toString(),
      name: room.name,
      visibility: room.visibility,
      ownerUsername: room.ownerUsername,
      isOwner,
      createdAt: room.createdAt
    };

    if (isOwner) {
      response.invitedUsernames = room.invitedUsernames;
    }

    res.json(response);
  } catch (err) {
    console.error('Error en GET /rooms/:name:', err);
    res.status(500).json({ error: 'Error al cargar la sala' });
  }
});

app.patch('/rooms/:name', authMiddleware, async (req, res) => {
  try {
    const room = await Room.findOne({ name: req.params.name });
    if (!room) return res.status(404).json({ error: 'Sala no encontrada' });
    if (room.ownerUsername !== req.username) {
      return res.status(403).json({ error: 'Solo el dueño puede editar la sala' });
    }

    const { visibility, password } = req.body;
    const update = {};

    if (visibility !== undefined) {
      if (!['public', 'password', 'invite'].includes(visibility)) {
        return res.status(400).json({ error: 'Visibilidad inválida' });
      }
      update.visibility = visibility;
      if (visibility !== 'password') {
        update.passwordHash = null;
      }
    }

    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < 4) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
      }
      update.passwordHash = await bcrypt.hash(password, 10);
      update.visibility = 'password';
    }

    const updated = await Room.findByIdAndUpdate(room._id, update, { new: true });
    res.json({
      _id: updated._id.toString(),
      name: updated.name,
      visibility: updated.visibility,
      ownerUsername: updated.ownerUsername,
      invitedUsernames: updated.invitedUsernames,
      isOwner: true
    });
  } catch (err) {
    console.error('Error en PATCH /rooms/:name:', err);
    res.status(500).json({ error: 'Error al actualizar la sala' });
  }
});

app.post('/rooms/:name/invite', authMiddleware, async (req, res) => {
  try {
    const room = await Room.findOne({ name: req.params.name });
    if (!room) return res.status(404).json({ error: 'Sala no encontrada' });
    if (room.ownerUsername !== req.username) {
      return res.status(403).json({ error: 'Solo el dueño puede invitar' });
    }

    const { username } = req.body;
    if (!username || typeof username !== 'string') {
      return res.status(400).json({ error: 'Falta el username' });
    }
    if (username === req.username) {
      return res.status(400).json({ error: 'No te podés invitar a vos mismo' });
    }

    const userToInvite = await User.findOne({ username });
    if (!userToInvite) {
      return res.status(404).json({ error: 'El usuario no existe o no está registrado' });
    }

    if (room.invitedUsernames.includes(username)) {
      return res.status(409).json({ error: 'Ese usuario ya está invitado' });
    }

    room.invitedUsernames.push(username);
    await room.save();

    res.json({
      invitedUsernames: room.invitedUsernames
    });
  } catch (err) {
    console.error('Error en POST /rooms/:name/invite:', err);
    res.status(500).json({ error: 'Error al invitar' });
  }
});

app.post('/rooms/:name/uninvite', authMiddleware, async (req, res) => {
  try {
    const room = await Room.findOne({ name: req.params.name });
    if (!room) return res.status(404).json({ error: 'Sala no encontrada' });
    if (room.ownerUsername !== req.username) {
      return res.status(403).json({ error: 'Solo el dueño puede desinvitar' });
    }

    const { username } = req.body;
    if (!username || typeof username !== 'string') {
      return res.status(400).json({ error: 'Falta el username' });
    }

    room.invitedUsernames = room.invitedUsernames.filter(u => u !== username);
    await room.save();

    const socketsInRoom = await io.in(room.name).fetchSockets();
    for (const s of socketsInRoom) {
      if (s.username === username && !s.isGuest) {
        s.leave(room.name);
        s.emit('kicked from room', { room: room.name, reason: 'Fuiste desinvitado de la sala' });
      }
    }

    res.json({
      invitedUsernames: room.invitedUsernames
    });
  } catch (err) {
    console.error('Error en POST /rooms/:name/uninvite:', err);
    res.status(500).json({ error: 'Error al desinvitar' });
  }
});

app.delete('/rooms/:name', authMiddleware, async (req, res) => {
  try {
    const room = await Room.findOne({ name: req.params.name });
    if (!room) return res.status(404).json({ error: 'Sala no encontrada' });
    if (room.ownerUsername !== req.username) {
      return res.status(403).json({ error: 'Solo el dueño puede borrar la sala' });
    }

    await Room.findByIdAndDelete(room._id);

    io.to(room.name).emit('room deleted', { room: room.name });

    const socketsInRoom = await io.in(room.name).fetchSockets();
    for (const s of socketsInRoom) {
      s.leave(room.name);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Error en DELETE /rooms/:name:', err);
    res.status(500).json({ error: 'Error al borrar la sala' });
  }
});

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

    const allMessages = await DirectMessage.find({ conversationId: conversation._id })
      .sort({ createdAt: -1 })
      .limit(50);

    const visibleMessages = allMessages.filter(m =>
      !m.deletedFor || !m.deletedFor.includes(req.username)
    );

    const result = visibleMessages.reverse().map(m => ({
      _id: m._id.toString(),
      from: m.from,
      fromColor: m.fromColor,
      text: m.deletedForEveryone ? '' : m.text,
      createdAt: m.createdAt,
      reactions: m.deletedForEveryone ? {} : (m.reactions ? Object.fromEntries(m.reactions) : {}),
      replyTo: m.replyTo ? m.replyTo.toString() : null,
      replyToSnapshot: m.replyToSnapshot || null,
      deletedForEveryone: !!m.deletedForEveryone
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
app.get('/rooms', async (req, res) => {
  try {
    const activeRoomNames = Object.entries(roomUsers)
      .filter(([_, users]) => users.length > 0)
      .map(([name]) => name);

    if (activeRoomNames.length === 0) {
      return res.json([]);
    }

    const registered = await Room.find({ name: { $in: activeRoomNames } });
    const registeredMap = new Map(registered.map(r => [r.name, r]));

    const rooms = activeRoomNames
      .map(name => {
        const reg = registeredMap.get(name);
        if (reg && reg.visibility === 'invite') return null;

        return {
          name,
          userCount: roomUsers[name].length,
          visibility: reg ? reg.visibility : 'public',
          requiresPassword: reg ? reg.visibility === 'password' : false
        };
      })
      .filter(r => r !== null)
      .sort((a, b) => b.userCount - a.userCount);

    res.json(rooms);
  } catch (err) {
    console.error('Error en GET /rooms:', err);
    res.status(500).json({ error: 'Error al cargar salas' });
  }
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
      text: regex,
      deletedForEveryone: { $ne: true }
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
  console.log('Un usuario se ha conectado, socket:', socket.id);

  // ============ REGISTER USER CHANNEL ============
  socket.on('register user channel', async ({ token }) => {
    if (!token) {
      console.log('[register user channel] sin token');
      return;
    }
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(payload.userId);
      if (!user) {
        console.log('[register user channel] user no encontrado');
        return;
      }
      socket.authUsername = user.username;
      socket.join(`user:${user.username}`);
      console.log(`[register user channel] OK: ${user.username} (socket ${socket.id})`);
    } catch (err) {
      console.log('[register user channel] error:', err.message);
    }
  });

  // ============ JOIN ROOM ============
  socket.on('join room', async ({ room, username, token, password }) => {
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

      const trimmedRoom = room.trim();

      const roomDoc = await Room.findOne({ name: trimmedRoom });

      if (roomDoc) {
        if (roomDoc.visibility === 'invite') {
          if (isGuest) {
            socket.emit('join error', {
              message: 'Esta sala es solo para usuarios registrados invitados. Iniciá sesión.'
            });
            return;
          }
          const isOwner = roomDoc.ownerUsername === resolvedUsername;
          const isInvited = roomDoc.invitedUsernames.includes(resolvedUsername);
          if (!isOwner && !isInvited) {
            socket.emit('join error', {
              message: 'No tenés acceso a esta sala. Pedile al dueño que te invite.'
            });
            return;
          }
        } else if (roomDoc.visibility === 'password') {
          if (!password || typeof password !== 'string') {
            socket.emit('join password required', { room: trimmedRoom });
            return;
          }
          const valid = await bcrypt.compare(password, roomDoc.passwordHash || '');
          if (!valid) {
            socket.emit('join error', { message: 'Contraseña incorrecta' });
            return;
          }
        }
      }

      if (roomUsers[trimmedRoom] && roomUsers[trimmedRoom].some(u => u.username === resolvedUsername)) {
        socket.emit('join error', { message: 'Ya hay alguien con ese nombre en la sala' });
        return;
      }

      socket.join(trimmedRoom);
      socket.username = resolvedUsername;
      socket.room = trimmedRoom;
      socket.isGuest = isGuest;
      socket.nameColor = nameColor;

      if (!roomUsers[trimmedRoom]) {
        roomUsers[trimmedRoom] = [];
      }
      roomUsers[trimmedRoom].push({ username: resolvedUsername, nameColor, isGuest });

      socket.emit('join success', {
        username: resolvedUsername,
        nameColor,
        isGuest,
        room: trimmedRoom,
        roomMeta: roomDoc ? {
          visibility: roomDoc.visibility,
          ownerUsername: roomDoc.ownerUsername,
          isOwner: roomDoc.ownerUsername === resolvedUsername
        } : {
          visibility: 'public',
          ownerUsername: null,
          isOwner: false
        }
      });

      try {
        const allMessages = await Message.find({ room: trimmedRoom }).sort({ createdAt: -1 }).limit(50);
        const visibleMessages = allMessages.filter(msg =>
          !msg.deletedFor || !msg.deletedFor.includes(resolvedUsername)
        );
        const messagesWithReactions = visibleMessages.reverse().map(msg => ({
          _id: msg._id,
          text: msg.deletedForEveryone ? '' : msg.text,
          username: msg.username,
          nameColor: msg.nameColor,
          type: msg.type,
          room: msg.room,
          createdAt: msg.createdAt,
          reactions: msg.deletedForEveryone ? {} : (msg.reactions ? Object.fromEntries(msg.reactions) : {}),
          replyTo: msg.replyTo ? msg.replyTo.toString() : null,
          replyToSnapshot: msg.replyToSnapshot || null,
          deletedForEveryone: !!msg.deletedForEveryone
        }));
        socket.emit('history', messagesWithReactions);
      } catch (err) {
        console.error('Error al cargar historial:', err);
      }

      io.to(trimmedRoom).emit('update user list', roomUsers[trimmedRoom]);

      const joinMessage = {
        text: `¡${resolvedUsername} se ha unido al chat!`,
        type: 'notification'
      };
      socket.broadcast.to(trimmedRoom).emit('chat message', joinMessage);
    } catch (err) {
      console.error('Error en join room:', err);
      socket.emit('join error', { message: 'Error interno al unirse a la sala' });
    }
  });

  // ============ CHAT MESSAGE (ROOM) ============
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

  socket.on('delete message', async ({ messageId, mode, room, token }) => {
    
    try {
      const message = await Message.findById(messageId);
      if (!message) return;
      if (message.type !== 'message') return;
      if (message.room !== room) return;

      let actorUsername = null;
      let isAuthenticated = false;

      if (token) {
        try {
          const payload = jwt.verify(token, JWT_SECRET);
          const user = await User.findById(payload.userId);
          if (user) {
            actorUsername = user.username;
            isAuthenticated = true;
          }
        } catch (err) {
        }
      }

      if (!actorUsername) {
        actorUsername = socket.username;
      }

      if (!actorUsername) return;

      if (mode === 'me') {
        if (!message.deletedFor.includes(actorUsername)) {
          message.deletedFor.push(actorUsername);
          await message.save();
        }
        socket.emit('message deleted for me', {
          messageId: message._id.toString(),
          room
        });
        return;
      }

      if (mode === 'everyone') {
        const isOwn = message.username === actorUsername;
        let isRoomOwner = false;
        if (isAuthenticated) {
          const roomDoc = await Room.findOne({ name: room });
          if (roomDoc && roomDoc.ownerUsername === actorUsername) {
            isRoomOwner = true;
          }
        }

        if (!isOwn && !isRoomOwner) {
          socket.emit('delete error', { message: 'No tenés permiso para borrar este mensaje' });
          return;
        }

        if (isOwn && !isRoomOwner && !isWithinDeleteWindow(message.createdAt)) {
          socket.emit('delete error', { message: 'Solo podés borrar tus mensajes dentro de las 24h' });
          return;
        }

        message.deletedForEveryone = true;
        message.deletedAt = new Date();
        message.text = '';
        message.reactions = new Map();
        await message.save();

        io.to(room).emit('message deleted for everyone', {
          messageId: message._id.toString(),
          room,
          deletedBy: actorUsername,
          wasOwn: isOwn
        });
      }
    } catch (err) {
      console.error('Error en delete message:', err);
    }
  });

  // ============ TOGGLE REACTION ============
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

  // ============ COLOR CHANGED ============
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

  // ============ TYPING (ROOM) ============
  socket.on('typing', ({ room, username }) => {
    socket.broadcast.to(room).emit('user typing', username);
  });

  socket.on('stop typing', ({ room }) => {
    socket.broadcast.to(room).emit('user stopped typing');
  });

  // ============ DM SEND ============
  socket.on('dm send', async ({ conversationId, text, replyToId, token }) => {
    try {
      if (!token) {
        console.log('[dm send] sin token');
        return;
      }
      const payload = jwt.verify(token, JWT_SECRET);
      const sender = await User.findById(payload.userId);
      if (!sender) {
        console.log('[dm send] sender no encontrado');
        return;
      }
      console.log(`[dm send] de ${sender.username}, texto: "${(text||'').slice(0,30)}"`);

      const conversation = await Conversation.findById(conversationId);
      if (!conversation) {
        console.log('[dm send] conversation no encontrada');
        return;
      }
      if (!conversation.participants.includes(sender.username)) {
        console.log('[dm send] sender no es participante');
        return;
      }

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

      const sendersInRoom = await io.in(`user:${sender.username}`).fetchSockets();
      const othersInRoom = await io.in(`user:${otherUser}`).fetchSockets();
      console.log(`[dm send] sender ${sender.username} sockets: ${sendersInRoom.length}, other ${otherUser} sockets: ${othersInRoom.length}`);

      io.to(`user:${sender.username}`).emit('dm message', payloadOut);
      io.to(`user:${otherUser}`).emit('dm message', payloadOut);
    } catch (err) {
      console.error('Error en dm send:', err);
    }
  });

  socket.on('dm delete', async ({ messageId, conversationId, mode, token }) => {
    try {
      if (!token) return;

      const payload = jwt.verify(token, JWT_SECRET);
      const actor = await User.findById(payload.userId);
      if (!actor) return;

      const message = await DirectMessage.findById(messageId);
      if (!message) return;
      if (message.conversationId.toString() !== conversationId) return;

      const conversation = await Conversation.findById(conversationId);
      if (!conversation) return;
      if (!conversation.participants.includes(actor.username)) return;

      if (mode === 'me') {
        if (!message.deletedFor.includes(actor.username)) {
          message.deletedFor.push(actor.username);
          await message.save();
        }
        io.to(`user:${actor.username}`).emit('dm deleted for me', {
          messageId: message._id.toString(),
          conversationId
        });
        return;
      }

      if (mode === 'everyone') {
        if (message.from !== actor.username) {
          socket.emit('delete error', { message: 'Solo podés borrar tus propios DMs para todos' });
          return;
        }
        if (!isWithinDeleteWindow(message.createdAt)) {
          socket.emit('delete error', { message: 'Solo podés borrar DMs dentro de las 24h' });
          return;
        }

        message.deletedForEveryone = true;
        message.deletedAt = new Date();
        message.text = '';
        message.reactions = new Map();
        await message.save();

        const other = conversation.participants.find(p => p !== actor.username);
        io.to(`user:${actor.username}`).emit('dm deleted for everyone', {
          messageId: message._id.toString(),
          conversationId,
          deletedBy: actor.username
        });
        if (other) {
          io.to(`user:${other}`).emit('dm deleted for everyone', {
            messageId: message._id.toString(),
            conversationId,
            deletedBy: actor.username
          });
        }
      }
    } catch (err) {
      console.error('Error en dm delete:', err);
    }
  });

  // ============ DM TYPING ============
  socket.on('dm typing', async ({ conversationId, token }) => {
    if (!token) return;
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(payload.userId);
      if (!user) return;

      const conv = await Conversation.findById(conversationId);
      if (!conv || !conv.participants.includes(user.username)) return;

      const other = conv.participants.find(p => p !== user.username);
      if (other) {
        io.to(`user:${other}`).emit('dm typing', {
          conversationId,
          from: user.username
        });
      }
    } catch (err) {
      console.error('Error en dm typing:', err);
    }
  });

  socket.on('dm stop typing', async ({ conversationId, token }) => {
    if (!token) return;
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(payload.userId);
      if (!user) return;

      const conv = await Conversation.findById(conversationId);
      if (!conv || !conv.participants.includes(user.username)) return;

      const other = conv.participants.find(p => p !== user.username);
      if (other) {
        io.to(`user:${other}`).emit('dm stop typing', { conversationId });
      }
    } catch (err) {
      console.error('Error en dm stop typing:', err);
    }
  });

socket.on('disconnect', () => {
    console.log('Un usuario se ha desconectado, socket:', socket.id);
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
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});