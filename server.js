// server.js - Main Backend Server
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

// Store rooms (The only state we need now!)
const rooms = new Map();

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // --- ROOM MANAGEMENT ---
  socket.on('create-room', () => {
    console.log('CREATE ROOM EVENT RECEIVED from', socket.id);
    const code = generateRoomCode();
    rooms.set(code, {
      code,
      users: new Map(),
      queue: [],
      musicState: {
        videoId: 'dQw4w9WgXcQ',
        isPlaying: false,
        currentTime: 0,
        timestamp: Date.now()
      }
    });
    socket.join(code);
    socket.emit('room-created', { code });
    console.log('ROOM CREATED AND EMITTED:', code);
  });

  socket.on('join-room', ({ code, username }) => {
    const room = rooms.get(code);
    if (!room) {
      socket.emit('room-error', 'Room not found');
      return;
    }

    room.users.set(socket.id, username);
    socket.join(code);

    socket.emit('room-joined', {
      code,
      musicState: room.musicState,
      queue: room.queue
    });

    io.to(code).emit('user-joined', {
      username,
      userCount: room.users.size
    });
  });

  // --- ROOM-BASED SYNC LOGIC ---
  socket.on('play', ({ roomCode, currentTime }) => {
    const room = rooms.get(roomCode);
    if (room) {
      room.musicState.isPlaying = true;
      room.musicState.currentTime = currentTime;
      room.musicState.timestamp = Date.now();
      socket.to(roomCode).emit('play', { currentTime });
    }
  });

  socket.on('pause', ({ roomCode, currentTime }) => {
    const room = rooms.get(roomCode);
    if (room) {
      room.musicState.isPlaying = false;
      room.musicState.currentTime = currentTime;
      room.musicState.timestamp = Date.now();
      socket.to(roomCode).emit('pause', { currentTime });
    }
  });

  socket.on('seek', ({ roomCode, currentTime }) => {
    const room = rooms.get(roomCode);
    if (room) {
      room.musicState.currentTime = currentTime;
      room.musicState.timestamp = Date.now();
      socket.to(roomCode).emit('seek', { currentTime });
    }
  });

  socket.on('video-change', ({ roomCode, videoId }) => {
    const room = rooms.get(roomCode);
    if (room) {
      room.musicState.videoId = videoId;
      room.musicState.isPlaying = false;
      room.musicState.currentTime = 0;
      room.musicState.timestamp = Date.now(); // Update timestamp on video change
      io.to(roomCode).emit('video-change', { videoId });
    }
  });

  // --- QUEUE MANAGEMENT ---
  socket.on('add-to-queue', ({ roomCode, video }) => {
    const room = rooms.get(roomCode);
    if (room) {
      room.queue.push(video);
      io.to(roomCode).emit('queue-updated', room.queue);
    }
  });

  socket.on('play-next', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (room && room.queue.length > 0) {
      const nextVideo = room.queue.shift(); // Remove first item
      room.musicState.videoId = nextVideo.videoId;
      room.musicState.isPlaying = true;
      room.musicState.currentTime = 0;
      room.musicState.timestamp = Date.now();

      io.to(roomCode).emit('video-change', { videoId: nextVideo.videoId });
      io.to(roomCode).emit('queue-updated', room.queue);
    }
  });

  socket.on('remove-from-queue', ({ roomCode, index }) => {
    const room = rooms.get(roomCode);
    if (room && room.queue[index]) {
      room.queue.splice(index, 1);
      io.to(roomCode).emit('queue-updated', room.queue);
    }
  });

  socket.on('request-sync', (roomCode) => {
    const room = rooms.get(roomCode);
    if (room) {
      socket.emit('sync-response', {
        musicState: room.musicState
      });
    }
  });

  // --- CHAT ---
  socket.on('chat-message', ({ roomCode, message }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const username = room.users.get(socket.id) || 'Anonymous';
    io.to(roomCode).emit('chat-message', {
      username,
      message,
      timestamp: new Date().toLocaleTimeString()
    });
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    rooms.forEach((room, roomCode) => {
      if (room.users.has(socket.id)) {
        const username = room.users.get(socket.id);
        room.users.delete(socket.id);

        io.to(roomCode).emit('user-left', {
          username: username,
          userCount: room.users.size
        });

        if (room.users.size === 0) {
          rooms.delete(roomCode);
        }
      }
    });
    console.log('User disconnected:', socket.id);
  });
}); // This is the end of io.on('connection')

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`🎵 Sync Beats server running on http://localhost:${PORT}`);
});