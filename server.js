// server.js - Main Backend Server
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy; needed for correct client IPs
const server = http.createServer(app);
const io = new Server(server);

// ---------- Config & limits ----------
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const MAX_USERNAME = 20;
const MAX_CHAT = 300;
const MAX_TITLE = 200;
const MAX_QUEUE = 100;
const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;

// In-memory room state (rooms are lost when the server restarts)
const rooms = new Map();

// ---------- Helpers ----------
function generateRoomCode() {
  let code;
  do {
    code = Math.random().toString(36).substring(2, 8).toUpperCase();
  } while (rooms.has(code) || !ROOM_CODE_RE.test(code));
  return code;
}

// Strip control characters, trim, and cap the length of user-provided text
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function isValidVideoId(id) {
  return typeof id === 'string' && VIDEO_ID_RE.test(id);
}

function thumbnailFor(videoId) {
  return `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
}

function toSeconds(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function freshMusicState() {
  return {
    videoId: null,
    title: '',
    isPlaying: false,
    currentTime: 0,
    timestamp: Date.now(),
    version: 0 // increases every time the track changes; used to ignore duplicate "ended" events
  };
}

// Where playback is right now, computed on the server (avoids client clock skew)
function livePosition(s) {
  return s.isPlaying ? s.currentTime + (Date.now() - s.timestamp) / 1000 : s.currentTime;
}

function setPosition(s, time, isPlaying) {
  s.currentTime = time;
  s.isPlaying = isPlaying;
  s.timestamp = Date.now();
}

function snapshot(room) {
  const s = room.musicState;
  return {
    videoId: s.videoId,
    title: s.title,
    isPlaying: s.isPlaying,
    version: s.version,
    position: livePosition(s)
  };
}

// Returns the room only if this socket is actually a member of it
function activeRoom(socket, roomCode) {
  if (typeof roomCode !== 'string' || !socket.rooms.has(roomCode)) return null;
  return rooms.get(roomCode) || null;
}

function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  socket.data.roomCode = null;
  socket.leave(code);

  const room = rooms.get(code);
  if (!room || !room.users.has(socket.id)) return;

  const username = room.users.get(socket.id);
  room.users.delete(socket.id);

  if (room.users.size === 0) {
    rooms.delete(code);
  } else {
    io.to(code).emit('user-left', { username, userCount: room.users.size });
  }
}

// Start the next queued track (or stop if the queue is empty)
function advanceQueue(roomCode, room) {
  const s = room.musicState;

  if (room.queue.length === 0) {
    s.version++;
    setPosition(s, 0, false);
    io.to(roomCode).emit('playback-stopped', { version: s.version });
    return;
  }

  const next = room.queue.shift();
  s.videoId = next.videoId;
  s.title = next.title;
  s.version++;
  setPosition(s, 0, true);

  io.to(roomCode).emit('video-change', snapshot(room));
  io.to(roomCode).emit('queue-updated', room.queue);
}

// ---------- YouTube search (server-side, so the API key stays secret) ----------
function decodeEntities(text) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" };
  return text.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, entity) => map[entity]);
}

const searchCache = new Map(); // query -> { at, results }
const SEARCH_TTL_MS = 10 * 60 * 1000;
const searchHits = new Map(); // ip -> { count, windowStart }
const SEARCH_LIMIT_PER_MIN = 20;

function allowSearch(ip) {
  const now = Date.now();
  const hit = searchHits.get(ip);
  if (!hit || now - hit.windowStart > 60 * 1000) {
    searchHits.set(ip, { count: 1, windowStart: now });
    return true;
  }
  hit.count++;
  return hit.count <= SEARCH_LIMIT_PER_MIN;
}

app.get('/api/search', async (req, res) => {
  const q = cleanText(req.query.q, 100);
  if (!q) return res.json({ results: [] });

  if (!YOUTUBE_API_KEY) {
    return res.status(503).json({ error: 'Search is not set up on this server (YOUTUBE_API_KEY is missing).' });
  }
  if (!allowSearch(req.ip)) {
    return res.status(429).json({ error: 'Too many searches. Please wait a minute.' });
  }

  const cacheKey = q.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) {
    return res.json({ results: cached.results });
  }

  try {
    const params = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      videoEmbeddable: 'true',
      maxResults: '8',
      q,
      key: YOUTUBE_API_KEY
    });
    const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
    if (!response.ok) {
      return res.status(502).json({ error: 'YouTube search failed. Check the API key and quota.' });
    }

    const data = await response.json();
    const results = (data.items || [])
      .filter((item) => isValidVideoId(item?.id?.videoId))
      .map((item) => ({
        videoId: item.id.videoId,
        title: decodeEntities(cleanText(item.snippet?.title || 'Untitled', MAX_TITLE)),
        channel: decodeEntities(cleanText(item.snippet?.channelTitle || '', 100)),
        thumbnail: thumbnailFor(item.id.videoId)
      }));

    searchCache.set(cacheKey, { at: Date.now(), results });
    res.json({ results });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(502).json({ error: 'Could not reach YouTube. Try again.' });
  }
});

// ---------- Static files ----------
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  socket.data.roomCode = null;

  // --- ROOM MANAGEMENT ---
  socket.on('create-room', () => {
    const code = generateRoomCode();
    rooms.set(code, {
      code,
      users: new Map(),
      queue: [],
      musicState: freshMusicState()
    });
    socket.emit('room-created', { code });
  });

  socket.on('join-room', (payload) => {
    const { code, username } = payload || {};
    const roomCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
    const room = rooms.get(roomCode);

    if (!room) {
      socket.emit('room-error', 'Room not found');
      return;
    }

    // Only announce the join if this socket is not already in the room (e.g. after a reconnect re-join)
    if (socket.data.roomCode !== roomCode) {
      leaveRoom(socket);
      const name = cleanText(username, MAX_USERNAME) || 'Anonymous';
      room.users.set(socket.id, name);
      socket.join(roomCode);
      socket.data.roomCode = roomCode;
      io.to(roomCode).emit('user-joined', { username: name, userCount: room.users.size });
    }

    socket.emit('room-joined', {
      code: roomCode,
      musicState: snapshot(room),
      queue: room.queue,
      userCount: room.users.size
    });
  });

  socket.on('disconnect', () => {
    leaveRoom(socket);
  });

  // --- PLAYBACK SYNC ---
  socket.on('play', (payload) => {
    const room = activeRoom(socket, payload?.roomCode);
    const time = toSeconds(payload?.currentTime);
    if (!room || time === null) return;

    setPosition(room.musicState, time, true);
    socket.to(payload.roomCode).emit('play', { currentTime: time });
  });

  socket.on('pause', (payload) => {
    const room = activeRoom(socket, payload?.roomCode);
    const time = toSeconds(payload?.currentTime);
    if (!room || time === null) return;

    setPosition(room.musicState, time, false);
    socket.to(payload.roomCode).emit('pause', { currentTime: time });
  });

  socket.on('seek', (payload) => {
    const room = activeRoom(socket, payload?.roomCode);
    const time = toSeconds(payload?.currentTime);
    if (!room || time === null) return;

    setPosition(room.musicState, time, room.musicState.isPlaying);
    socket.to(payload.roomCode).emit('seek', { currentTime: time });
  });

  // A client reports its track ended. Only the first report for the current version counts,
  // so two people in the room can't skip two songs.
  socket.on('video-ended', (payload) => {
    const room = activeRoom(socket, payload?.roomCode);
    if (!room || payload.version !== room.musicState.version) return;

    advanceQueue(payload.roomCode, room);
  });

  socket.on('video-change', (payload) => {
    const room = activeRoom(socket, payload?.roomCode);
    if (!room || !isValidVideoId(payload?.videoId)) return;

    const title = cleanText(payload.title, MAX_TITLE) || 'YouTube video';
    const s = room.musicState;
    s.videoId = payload.videoId;
    s.title = title;
    s.version++;
    setPosition(s, 0, true);

    io.to(payload.roomCode).emit('video-change', snapshot(room));
  });

  socket.on('request-sync', (roomCode) => {
    const room = activeRoom(socket, roomCode);
    if (room) socket.emit('sync-response', { musicState: snapshot(room) });
  });

  // --- QUEUE MANAGEMENT ---
  socket.on('add-to-queue', (payload) => {
    const room = activeRoom(socket, payload?.roomCode);
    const video = payload?.video;
    if (!room || !video || !isValidVideoId(video.videoId)) return;
    if (room.queue.length >= MAX_QUEUE) return;

    room.queue.push({
      videoId: video.videoId,
      title: cleanText(video.title, MAX_TITLE) || 'YouTube video',
      thumbnail: thumbnailFor(video.videoId),
      addedBy: room.users.get(socket.id) || 'Anonymous' // set by the server, not trusted from the client
    });
    io.to(payload.roomCode).emit('queue-updated', room.queue);
  });

  socket.on('remove-from-queue', (payload) => {
    const room = activeRoom(socket, payload?.roomCode);
    const index = payload?.index;
    if (!room || !Number.isInteger(index) || index < 0 || index >= room.queue.length) return;

    room.queue.splice(index, 1);
    io.to(payload.roomCode).emit('queue-updated', room.queue);
  });

  // --- CHAT ---
  socket.on('chat-message', (payload) => {
    const room = activeRoom(socket, payload?.roomCode);
    const message = cleanText(payload?.message, MAX_CHAT);
    if (!room || !message) return;

    io.to(payload.roomCode).emit('chat-message', {
      username: room.users.get(socket.id) || 'Anonymous',
      message,
      timestamp: new Date().toLocaleTimeString()
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎵 Sync Beats server running on http://localhost:${PORT}`);
  if (!YOUTUBE_API_KEY) console.log('⚠️  YOUTUBE_API_KEY not set: in-app search will be disabled.');
});
