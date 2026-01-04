// script.js - Main Frontend Logic

// ========================================
// 1. LOGIN CHECK & INITIALIZATION
// ========================================
// Check if user is logged in
const username = localStorage.getItem('username');
if (!username) {
  // Redirect to login if no username found
  window.location.href = '/';
}

// Display username
document.getElementById('usernameDisplay').textContent = `👤 ${username}`;

// ========================================
// 2. SOCKET.IO CONNECTION
// ========================================
const socket = io();

console.log('socket connected, id:', socket.id);

socket.on('room-created', ({ code }) => {
  console.log('Room created (frontend):', code);
});


let currentRoomCode = null;

const roomGate = document.getElementById('roomGate');
const app = document.getElementById('app');

const createRoomBtn = document.getElementById('createRoomBtn');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const roomCodeInput = document.getElementById('roomCodeInput');

createRoomBtn.addEventListener('click', () => {
  socket.emit('create-room');
});

joinRoomBtn.addEventListener('click', () => {
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!code) {
    alert('Enter a room code');
    return;
  }

  socket.emit('join-room', {
    code,
    username
  });
});


socket.on('room-created', ({ code }) => {
  currentRoomCode = code;
  console.log('Room created:', code);

  socket.emit('join-room', {
    code,
    username
  });
});

socket.on('room-joined', ({ code, musicState }) => {
  currentRoomCode = code;
  document.getElementById('roomCodeDisplay').textContent = `Room: ${code}`;

  roomGate.style.display = 'none';
  app.style.display = 'block';


  if (isPlayerReady && musicState.videoId) {
    isSyncing = true;
    player.loadVideoById(musicState.videoId, musicState.currentTime);

    if (musicState.isPlaying) {
      player.playVideo();
    } else {
      player.pauseVideo();
    }
  }
});




// 3.1 CUSTOM PLAYER UI ELEMENTS
// ========================================
const playPauseBtn = document.getElementById('playPauseBtn');
const seekBar = document.getElementById('seekBar');
const volumeBar = document.getElementById('volumeBar');




// Track if we're currently syncing (to prevent feedback loops)
let isSyncing = false;

// ========================================
// 3. YOUTUBE PLAYER SETUP
// ========================================

let player;
let isPlayerReady = false;

// This function is called automatically by YouTube IFrame API
function onYouTubeIframeAPIReady() {
  player = new YT.Player('player', {
    height: '100%',
    width: '100%',
    videoId: 'dQw4w9WgXcQ', // Default video
    playerVars: {
      'playsinline': 1,
      'controls': 1,
      'rel': 0
    },
    events: {
      'onReady': onPlayerReady,
      'onStateChange': onPlayerStateChange
    }
  });
}

function onPlayerReady(event) {
  isPlayerReady = true;
  console.log('YouTube player ready');
}
// Play / Pause button click
playPauseBtn.addEventListener('click', () => {
  if (!isPlayerReady) return;

  const state = player.getPlayerState();

  if (state === YT.PlayerState.PLAYING) {
    player.pauseVideo();
  } else {
    player.playVideo();
  }
});

// ========================================

// ========================================
// 4. MUSIC SYNC - EMIT EVENTS
// ========================================
function onPlayerStateChange(event) {
  // Don't emit events if we're syncing from another user
  if (isSyncing) {
    isSyncing = false;
    return;
  }

  const currentTime = player.getCurrentTime();

  // YT.PlayerState values:
  // -1: unstarted, 0: ended, 1: playing, 2: paused, 3: buffering, 5: video cued

  if (event.data === YT.PlayerState.PLAYING) {
    socket.emit('play', {
      roomCode: currentRoomCode,
      currentTime
    });

    updateAlbumArt(true);
    playPauseBtn.textContent = "⏸";
  }
  else if (event.data === YT.PlayerState.PAUSED) {
    socket.emit('pause', {
      roomCode: currentRoomCode,
      currentTime
    });

    updateAlbumArt(false);
    playPauseBtn.textContent = "▶";
  }

}

// Update album art animation based on play state
function updateAlbumArt(isPlaying) {
  const albumArt = document.getElementById('albumArt');
  if (isPlaying) {
    albumArt.classList.add('playing');
  } else {
    albumArt.classList.remove('playing');
  }
}

// ========================================
// 5. MUSIC SYNC - RECEIVE EVENTS
// ========================================

// Receive initial sync state when joining
// socket.on('sync-state', (state) => {
//   if (isPlayerReady && state.videoId) {
//     isSyncing = true;
//     player.loadVideoById(state.videoId, state.currentTime);

//     if (state.isPlaying) {
//       player.playVideo();
//     } else {
//       player.pauseVideo();
//     }
//   }
// });

// Receive play event from other users
socket.on('play', (data) => {
  if (isPlayerReady) {
    isSyncing = true;
    player.seekTo(data.currentTime, true);
    player.playVideo();
    updateAlbumArt(true); // Animate album art
  }
});

// Receive pause event from other users
socket.on('pause', (data) => {
  if (isPlayerReady) {
    isSyncing = true;
    player.seekTo(data.currentTime, true);
    player.pauseVideo();
    updateAlbumArt(false); // Stop animation
  }
});

// Receive seek event from other users
socket.on('seek', (data) => {
  if (isPlayerReady) {
    isSyncing = true;
    player.seekTo(data.currentTime, true);
  }
});

// Receive video change event
socket.on('video-change', (data) => {
  if (isPlayerReady) {
    isSyncing = true;
    player.loadVideoById(data.videoId, 0);

    const thumbnail = `https://img.youtube.com/vi/${data.videoId}/hqdefault.jpg`;
    const albumArt = document.getElementById('albumArt');
    albumArt.style.backgroundImage = `url(${thumbnail})`;
    albumArt.style.backgroundSize = 'cover';
    albumArt.textContent = '';
  }
});

// Update seek bar while playing
setInterval(() => {
  if (!isPlayerReady) return;

  const duration = player.getDuration();
  const currentTime = player.getCurrentTime();

  if (duration > 0) {
    seekBar.value = (currentTime / duration) * 100;
  }
}, 500);

volumeBar.addEventListener('input', () => {
  if (!isPlayerReady) return;
  player.setVolume(volumeBar.value);
});


seekBar.addEventListener('input', () => {
  if (!isPlayerReady) return;

  const duration = player.getDuration();
  const seekTo = (seekBar.value / 100) * duration;

  isSyncing = true;
  player.seekTo(seekTo, true);
  socket.emit('seek', {
    roomCode: currentRoomCode,
    currentTime: seekTo
  });

});


// ========================================
// 6. VIDEO URL LOADING
// ========================================
document.getElementById('loadVideoBtn').addEventListener('click', () => {
  const url = document.getElementById('videoUrl').value.trim();
  const videoId = extractVideoId(url);

  if (videoId) {
    socket.emit('video-change', {
      roomCode: currentRoomCode,
      videoId
    });

    document.getElementById('videoUrl').value = '';
  } else {
    alert('Invalid YouTube URL. Please enter a valid URL.');
  }
});

// Extract video ID from YouTube URL
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /^([a-zA-Z0-9_-]{11})$/
  ];

  for (let pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// ========================================
// 7. CHAT FUNCTIONALITY
// ========================================

// Send chat message
function sendMessage() {
  const input = document.getElementById('chatInput');
  const message = input.value.trim();

  if (message) {
    socket.emit('chat-message', {
      roomCode: currentRoomCode,
      message
    });

    input.value = '';
  }
}

// Send button click
document.getElementById('sendBtn').addEventListener('click', sendMessage);

// Enter key to send
document.getElementById('chatInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    sendMessage();
  }
});

// Receive chat messages
socket.on('chat-message', (data) => {
  const chatMessages = document.getElementById('chatMessages');

  const messageDiv = document.createElement('div');
  // Check if it's my message (simple check based on username)
  // In a real app we'd use socket ID, but for now this works Visually
  const isMe = data.username === username;

  messageDiv.className = isMe ? 'message-bubble' : 'message-bubble';
  // Ideally we would add 'me' class if we had different styles, 
  // but for now style.css defines message-bubble generic. 
  // Let's add a style for "own" messages if needed later.

  // Customize bubble style slightly for self if we want, or just keep uniform
  if (isMe) {
    messageDiv.style.background = 'rgba(29, 185, 84, 0.2)'; // Green tint for me
    messageDiv.style.alignSelf = 'flex-end';
    messageDiv.style.borderBottomLeftRadius = '18px';
    messageDiv.style.borderBottomRightRadius = '4px';
  } else {
    messageDiv.style.alignSelf = 'flex-start';
  }

  messageDiv.innerHTML = `
    <span class="message-meta">${data.username} <span style="font-weight:400; color:#888; margin-left:5px; font-size:0.7em;">${data.timestamp}</span></span>
    ${escapeHtml(data.message)}
  `;

  chatMessages.appendChild(messageDiv);

  // Auto-scroll to bottom
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ========================================
// 8. USER PRESENCE
// ========================================

// User joined notification
socket.on('user-joined', (data) => {
  updateUserCount(data.userCount);

  const chatMessages = document.getElementById('chatMessages');
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message-bubble system'; // Updated class
  messageDiv.textContent = `${data.username} joined the session`;
  chatMessages.appendChild(messageDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

// User left notification
socket.on('user-left', (data) => {
  updateUserCount(data.userCount);

  const chatMessages = document.getElementById('chatMessages');
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message-bubble system'; // Updated class
  messageDiv.textContent = `${data.username} left the session`;
  chatMessages.appendChild(messageDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});


function updateUserCount(count) {
  document.getElementById('userCount').textContent = `${count} user${count !== 1 ? 's' : ''} online`;
}

// ========================================
// 9. CONNECTION STATUS
// ========================================
socket.on('connect', () => {
  document.getElementById('syncStatus').innerHTML = '🟢 Connected';
});

socket.on('disconnect', () => {
  document.getElementById('syncStatus').innerHTML = '🔴 Disconnected';
});

// ========================================
// 10. LOGOUT FUNCTIONALITY
// ========================================
document.getElementById('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('username');
  window.location.href = '/';
});