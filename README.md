# Chat App — Backend

REST API and WebSocket server for the [Chat App frontend](https://github.com/HasanAshee/chat-app-frontend). Handles authentication, room management, direct messaging, and real-time events via Socket.io.

**Live deployment:** [chat-app-backend-ra36.onrender.com](https://chat-app-backend-ra36.onrender.com)

---

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express
- **Real-time:** Socket.io
- **Database:** MongoDB Atlas (via Mongoose)
- **Auth:** JWT + bcrypt
- **Hosting:** Render

---

## Architecture

A single-file Express server (`server.js`) that:

- Connects to MongoDB Atlas, scoped to the `chat-db` database
- Exposes a REST API for stateless operations (auth, profiles, room config, search, DM list)
- Runs a Socket.io server on the same HTTP server for real-time events
- Authenticates Socket.io events via JWT passed in the event payload
- Maintains per-user "personal channels" (`user:USERNAME`) for delivering DMs and notifications regardless of which room the user is currently in

### Data Models

- **User** — username (unique), passwordHash, nameColor, bio
- **Message** — room messages with reactions, replies (with snapshot), and soft/hard delete fields
- **Room** — registered rooms with visibility (public/password/invite), owner, and invited users list
- **Conversation** — 1-to-1 DM container with participants and per-user unread counts
- **DirectMessage** — DM messages with the same reaction/reply/delete features as room messages

---

## REST API

### Auth

- `POST /auth/register` — create a new user account
- `POST /auth/login` — log in and receive JWT (30d expiry)
- `GET /auth/me` — get current user (requires JWT)
- `PATCH /users/me` — update name color or bio (requires JWT)
- `GET /users/:username/profile` — get a user's public profile
- `GET /users/colors?usernames=a,b,c` — bulk fetch name colors

### Rooms

- `POST /rooms` — create a private room (password or invite-only)
- `GET /rooms` — list active public rooms (with password lock indicator)
- `GET /rooms/mine` — rooms where the user is owner or invited (requires JWT)
- `GET /rooms/:name` — room details (requires JWT, permission-checked)
- `PATCH /rooms/:name` — update room config (owner only)
- `POST /rooms/:name/invite` — add a user to the invite list (owner only)
- `POST /rooms/:name/uninvite` — remove a user, kicking them in real time (owner only)
- `DELETE /rooms/:name` — delete the room and kick all participants (owner only)

### Messages & DMs

- `GET /messages/search?room=X&q=Y` — search messages within a room
- `GET /dms` — list current user's conversations (requires JWT)
- `POST /dms/open` — open or create a conversation with another user (requires JWT)
- `GET /dms/:id/messages` — load conversation history (requires JWT, permission-checked)
- `POST /dms/:id/read` — mark conversation as read (requires JWT)

---

## Socket.io Events

### Client → Server

- `register user channel` — join the user's personal channel for DMs
- `join room` — join a chat room (validates visibility, password, invitation)
- `chat message` — send a room message (supports `replyToId`)
- `toggle reaction` — add/remove reaction on a room message
- `color changed` — broadcast a name color change to the user's room
- `typing` / `stop typing` — typing indicator for room
- `delete message` — soft/hard delete a room message
- `dm send` — send a direct message
- `dm typing` / `dm stop typing` — typing indicator for DMs
- `dm delete` — soft/hard delete a DM

### Server → Client

- `join success` / `join error` / `join password required` — join feedback
- `history` — initial message history
- `chat message` / `update user list` — live messages and presence
- `message reaction updated` / `user color updated` — live updates
- `message deleted for me` / `message deleted for everyone`
- `dm message` / `dm read` / `dm typing` / `dm stop typing`
- `dm deleted for me` / `dm deleted for everyone`
- `kicked from room` / `room deleted`

---

## Permissions Summary

- **Authentication:** JWT in `Authorization: Bearer <token>` header (REST) or as a `token` field in socket payloads
- **Rooms:** Owners can edit/invite/uninvite/delete; invitees can join invite-only rooms; password rooms require the password
- **DMs:** Only participants can read or send; only the sender can delete-for-everyone within a 24h window
- **Message moderation:** Authors can delete their own messages within 24h; room owners can delete any message in their rooms with no time limit

---

## Getting Started

### Prerequisites
- Node.js 18+
- A MongoDB database (Atlas or local)

### Setup

1. Clone:
```bash
   git clone https://github.com/HasanAshee/chat-app-backend.git
   cd chat-app-backend
```

2. Install:
```bash
   npm install
```

3. Create a `.env` file in the root:
```bash
   MONGODB_URI=mongodb+srv://USER:PASS@cluster.mongodb.net/?retryWrites=true&w=majority
   JWT_SECRET=a-long-random-string
   PORT=3000
```

4. Run:
```bash
   node server.js
```

The server connects to the `chat-db` database (forced via Mongoose `dbName` option) and listens on the port from `.env` or 3000.

---

## Author

**Facundo Hasan Carrizo**
- GitHub: [@HasanAshee](https://github.com/HasanAshee)
- Email: hasan.carrizo2002@gmail.com
