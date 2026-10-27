// script.js - Frontend logic

// ========================================
// 1. LOGIN CHECK & STATE
// ========================================
const username = localStorage.getItem('username');
if (!username) {
  window.location.href = '/';
}

const $ = (id) => document.getElementById(id);

const socket = io();

let currentRoomCode = null;
let player = null;
let isPlayerReady = false;
let pendingState = null;   // state received before the YouTube player finished loading
let loadedVideoId = null;  // video currently loaded in the player
let currentVersion = -1;   // track version we are on (sent back with "video-ended")
let suppressUntil = 0;     // ignore YouTube events for a moment after a remote change
let userCount = 1;

const roomGate = $('roomGate');
const app = $('app');
const playPauseBtn = $('playPauseBtn');
const seekBar = $('seekBar');
const volumeBar = $('volumeBar');

$('usernameDisplay').textContent = `👤 ${username}`;

// Small helpers. User text is always set with textContent, never innerHTML.
function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function suppressEvents(ms = 1000) {
  suppressUntil = Date.now() + ms;
}

function setStatus(text) {
  $('syncStatus').textContent = text;
}

function updateUserCount(count) {
  userCount = count;
  $('userCount').textContent = `👥 ${count} user${count !== 1 ? 's' : ''} online`;
}

function updateAlbumArt(isPlaying) {
  $('albumArt').classList.toggle('playing', isPlaying);
  playPauseBtn.textContent = isPlaying ? '⏸' : '▶';
}

function showTrack(videoId, title) {
  const albumArt = $('albumArt');
  if (videoId) {
    albumArt.style.backgroundImage = `url(https://img.youtube.com/vi/${videoId}/hqdefault.jpg)`;
    albumArt.style.backgroundSize = 'cover';
    albumArt.textContent = '';
    $('trackTitle').textContent = title || 'YouTube video';
  } else {
    albumArt.style.backgroundImage = '';
    albumArt.textContent = '🎵';
    $('trackTitle').textContent = 'Nothing playing yet';
  }
}

// ========================================
// 2. ROOM GATE (create / join)
// ========================================
function showRoomGate() {
  currentRoomCode = null;
  app.style.display = 'none';
  roomGate.style.display = '';
}

function joinRoom(rawCode) {
  const code = rawCode.trim().toUpperCase();
  if (!code) {
    alert('Enter a room code');
    return;
  }
  socket.emit('join-room', { code, username });
}

$('createRoomBtn').addEventListener('click', () => socket.emit('create-room'));
$('joinRoomBtn').addEventListener('click', () => joinRoom($('roomCodeInput').value));
$('roomCodeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom(e.target.value);
});

socket.on('room-created', ({ code }) => joinRoom(code));

socket.on('room-joined', ({ code, musicState, queue, userCount: count }) => {
  currentRoomCode = code;
  $('roomCodeDisplay').textContent = `ROOM: ${code}`;
  roomGate.style.display = 'none';
  app.style.display = 'flex';

  updateUserCount(count);
  renderQueue(queue);
  applyState(musicState);
});

socket.on('room-error', (message) => {
  if (currentRoomCode) showRoomGate(); // e.g. the room closed while we were reconnecting
  alert(message);
});

// ========================================
// 3. CONNECTION HANDLING
// ========================================
socket.on('connect', () => {
  setStatus('🟢 Connected & Synced');
  // After a reconnect the server doesn't know us yet, so rejoin the room
  if (currentRoomCode) {
    socket.emit('join-room', { code: currentRoomCode, username });
  }
});

socket.on('disconnect', () => {
  setStatus('🔴 Disconnected. Reconnecting…');
});

// ========================================
// 4. YOUTUBE PLAYER
// ========================================
function onYouTubeIframeAPIReady() {
  player = new YT.Player('player', {
    height: '100%',
    width: '100%',
    playerVars: { playsinline: 1, controls: 1, rel: 0 },
    events: {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange
    }
  });
}

function onPlayerReady() {
  isPlayerReady = true;
  if (pendingState) {
    const state = pendingState;
    pendingState = null;
    applyState(state);
  }
}

// Apply the server's playback state to the local player
function applyState(state) {
  if (!state) return;
  if (!isPlayerReady) {
    pendingState = state;
    return;
  }

  showTrack(state.videoId, state.title);

  if (!state.videoId) {
    loadedVideoId = null;
    currentVersion = state.version;
    updateAlbumArt(false);
    return;
  }

  suppressEvents();
  if (state.videoId !== loadedVideoId || state.version !== currentVersion) {
    // New track: load it at the right position (autoplay only if the room is playing)
    loadedVideoId = state.videoId;
    currentVersion = state.version;
    if (state.isPlaying) {
      player.loadVideoById(state.videoId, state.position);
    } else {
      player.cueVideoById(state.videoId, state.position);
    }
  } else {
    // Same track: jump to the room's position (this is also "Force Sync")
    player.seekTo(state.position, true);
    if (state.isPlaying) {
      player.playVideo();
    } else {
      player.pauseVideo();
    }
  }
  updateAlbumArt(state.isPlaying);
}

// Local player events → tell the server (unless we are applying a remote change)
function onPlayerStateChange(event) {
  if (Date.now() < suppressUntil) return;

  const time = player.getCurrentTime();

  switch (event.data) {
    case YT.PlayerState.PLAYING:
      socket.emit('play', { roomCode: currentRoomCode, currentTime: time });
      updateAlbumArt(true);
      break;
    case YT.PlayerState.PAUSED:
      socket.emit('pause', { roomCode: currentRoomCode, currentTime: time });
      updateAlbumArt(false);
      break;
    case YT.PlayerState.ENDED:
      updateAlbumArt(false);
      socket.emit('video-ended', { roomCode: currentRoomCode, version: currentVersion });
      break;
  }
}

playPauseBtn.addEventListener('click', () => {
  if (!isPlayerReady || !loadedVideoId) return;
  if (player.getPlayerState() === YT.PlayerState.PLAYING) {
    player.pauseVideo();
  } else {
    player.playVideo();
  }
});

// Remote playback events
socket.on('play', ({ currentTime }) => {
  if (!isPlayerReady) return;
  suppressEvents();
  if (Math.abs(player.getCurrentTime() - currentTime) > 0.75) {
    player.seekTo(currentTime, true);
  }
  player.playVideo();
  updateAlbumArt(true);
});

socket.on('pause', ({ currentTime }) => {
  if (!isPlayerReady) return;
  suppressEvents();
  if (Math.abs(player.getCurrentTime() - currentTime) > 0.75) {
    player.seekTo(currentTime, true);
  }
  player.pauseVideo();
  updateAlbumArt(false);
});

socket.on('seek', ({ currentTime }) => {
  if (!isPlayerReady) return;
  suppressEvents();
  player.seekTo(currentTime, true);
});

socket.on('video-change', (state) => applyState(state));

socket.on('playback-stopped', ({ version }) => {
  currentVersion = version;
  loadedVideoId = null;
  if (isPlayerReady) player.stopVideo();
  showTrack(null);
  updateAlbumArt(false);
});

socket.on('sync-response', ({ musicState }) => applyState(musicState));

$('syncNowBtn').addEventListener('click', () => {
  socket.emit('request-sync', currentRoomCode);
});

// ========================================
// 5. PLAYER CONTROLS (seek & volume)
// ========================================
volumeBar.addEventListener('input', () => {
  if (isPlayerReady) player.setVolume(volumeBar.value);
});

// Update the seek bar while playing, but not while the user is dragging it
setInterval(() => {
  if (!isPlayerReady || !loadedVideoId || document.activeElement === seekBar) return;
  const duration = player.getDuration();
  if (duration > 0) {
    seekBar.value = (player.getCurrentTime() / duration) * 100;
  }
}, 500);

seekBar.addEventListener('change', () => {
  if (!isPlayerReady || !loadedVideoId) return;
  const target = (seekBar.value / 100) * player.getDuration();
  suppressEvents(800);
  player.seekTo(target, true);
  socket.emit('seek', { roomCode: currentRoomCode, currentTime: target });
});

// ========================================
// 6. ADDING MUSIC (search, paste a link, queue)
// ========================================
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// Get a video's title from YouTube's oEmbed service, with a fallback
async function fetchTitle(videoId) {
  try {
    const res = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`);
    const data = await res.json();
    return data.title || `YouTube video ${videoId}`;
  } catch {
    return `YouTube video ${videoId}`;
  }
}

function requireRoom() {
  if (!currentRoomCode) {
    alert('Join a room first');
    return false;
  }
  return true;
}

// Paste-a-link: play now
$('loadVideoBtn').addEventListener('click', async () => {
  if (!requireRoom()) return;
  const videoId = extractVideoId($('videoUrl').value.trim());
  if (!videoId) {
    alert('Invalid YouTube URL. Please enter a valid link.');
    return;
  }
  const title = await fetchTitle(videoId);
  socket.emit('video-change', { roomCode: currentRoomCode, videoId, title });
  $('videoUrl').value = '';
});

// Paste-a-link: add to queue
$('addToQueueBtn').addEventListener('click', async () => {
  if (!requireRoom()) return;
  const videoId = extractVideoId($('videoUrl').value.trim());
  if (!videoId) {
    alert('Invalid YouTube URL');
    return;
  }
  const title = await fetchTitle(videoId);
  socket.emit('add-to-queue', { roomCode: currentRoomCode, video: { videoId, title } });
  $('videoUrl').value = '';
});

// --- In-app YouTube search ---
const searchInput = $('searchInput');
const searchResults = $('searchResults');

function setSearchMessage(text) {
  searchResults.replaceChildren(makeEl('div', 'search-message', text));
}

async function runSearch() {
  const q = searchInput.value.trim();
  if (!q) return;
  setSearchMessage('Searching…');

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Search failed');
    renderSearchResults(data.results);
  } catch (err) {
    setSearchMessage(err.message);
  }
}

function renderSearchResults(results) {
  searchResults.replaceChildren();
  if (results.length === 0) {
    setSearchMessage('No results found.');
    return;
  }

  results.forEach((item) => {
    const row = makeEl('div', 'search-result');

    const img = document.createElement('img');
    img.src = item.thumbnail;
    img.alt = '';

    const info = makeEl('div', 'search-result-info');
    info.append(
      makeEl('div', 'search-result-title', item.title),
      makeEl('div', 'search-result-channel', item.channel)
    );

    const actions = makeEl('div', 'search-result-actions');
    const playBtn = makeEl('button', 'btn-primary', '▶ Play');
    const queueBtn = makeEl('button', 'btn-secondary', '+ Queue');

    playBtn.addEventListener('click', () => {
      if (!requireRoom()) return;
      socket.emit('video-change', { roomCode: currentRoomCode, videoId: item.videoId, title: item.title });
    });

    queueBtn.addEventListener('click', () => {
      if (!requireRoom()) return;
      socket.emit('add-to-queue', {
        roomCode: currentRoomCode,
        video: { videoId: item.videoId, title: item.title }
      });
      queueBtn.textContent = '✓ Added';
      queueBtn.disabled = true;
    });

    actions.append(playBtn, queueBtn);
    row.append(img, info, actions);
    searchResults.appendChild(row);
  });
}

$('searchBtn').addEventListener('click', runSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runSearch();
});

// ========================================
// 7. QUEUE
// ========================================
socket.on('queue-updated', (queue) => renderQueue(queue));

function renderQueue(queue) {
  const queueList = $('queueList');
  $('queueCount').textContent = `(${queue.length})`;
  queueList.replaceChildren();

  if (queue.length === 0) {
    queueList.appendChild(makeEl('div', 'queue-placeholder', 'Queue is empty'));
    return;
  }

  queue.forEach((item, index) => {
    const row = makeEl('div', 'queue-row');

    const img = document.createElement('img');
    img.src = item.thumbnail;
    img.alt = '';

    const info = makeEl('div', 'queue-row-info');
    info.append(
      makeEl('div', 'queue-row-title', item.title),
      makeEl('div', 'queue-row-meta', `Added by ${item.addedBy}`)
    );

    const removeBtn = makeEl('button', 'queue-remove', '✖');
    removeBtn.title = 'Remove from queue';
    removeBtn.addEventListener('click', () => {
      socket.emit('remove-from-queue', { roomCode: currentRoomCode, index });
    });

    row.append(img, info, removeBtn);
    queueList.appendChild(row);
  });
}

// ========================================
// 8. CHAT
// ========================================
function sendMessage() {
  const input = $('chatInput');
  const message = input.value.trim();
  if (!message || !currentRoomCode) return;
  socket.emit('chat-message', { roomCode: currentRoomCode, message });
  input.value = '';
}

$('sendBtn').addEventListener('click', sendMessage);
$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

function appendChatBubble(node) {
  const chatMessages = $('chatMessages');
  chatMessages.appendChild(node);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

socket.on('chat-message', (data) => {
  const bubble = makeEl('div', 'message-bubble');
  if (data.username === username) {
    bubble.classList.add('own');
  }

  const meta = makeEl('span', 'message-meta');
  meta.append(`${data.username} `);
  meta.appendChild(makeEl('span', 'message-time', data.timestamp));

  bubble.append(meta, document.createTextNode(data.message));
  appendChatBubble(bubble);
});

socket.on('user-joined', (data) => {
  updateUserCount(data.userCount);
  appendChatBubble(makeEl('div', 'message-bubble system', `${data.username} joined the session`));
});

socket.on('user-left', (data) => {
  updateUserCount(data.userCount);
  appendChatBubble(makeEl('div', 'message-bubble system', `${data.username} left the session`));
});

// ========================================
// 9. LOGOUT
// ========================================
$('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('username');
  window.location.href = '/';
});
