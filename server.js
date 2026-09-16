'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

// ---- Tunables ---------------------------------------------------------------

const PORT = Number(process.env.PORT) || 3000;
const MIN_PLAYERS = Number(process.env.MIN_PLAYERS) || 3;
const MAX_PLAYERS = 10;
const PHASE_SECONDS = { pick: 25, caption: 80, vote: 40 };
const SHOWCASE_SECONDS_PER_POST = 7;  // how long each post is on screen before voting
const GRACE_MS = 1500;                // lets last-second submissions land
const LIKE_POINTS = 100;              // followers earned per like
const VIRAL_BONUS = 200;              // extra for the round's most-liked post
const RECONNECT_GRACE_MS = 15_000;    // don't skip ahead on someone whose phone just locked
const HOST_HANDOFF_MS = 20_000;       // host offline this long → someone else gets the controls
const DROP_AFTER_MS = 120_000;        // offline this long → sits out future rounds
const EMPTY_ROOM_TTL_MS = 10 * 60_000;
const MAX_NAME = 16;
const MAX_CAPTION = 150;
const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels, so codes never spell words

// Used when someone runs out the clock without typing anything.
const FALLBACK_CAPTIONS = [
  'no thoughts just vibes ✨',
  'photo dump pt. 7',
  'felt cute, might delete later',
  'blessed 🙏 #nofilter',
  'caption this lol',
  'living laughing loving',
  '📍 somewhere',
  'ok but why is nobody talking about this',
  "didn't have time to caption this. like it anyway",
  'core memory unlocked',
];

// ---- Photos -----------------------------------------------------------------
// Drop your own images into public/photos and they're used first.
// Stock photos from picsum.photos fill in when those run out.

const PHOTO_DIR = path.join(__dirname, 'public', 'photos');
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;
let stockIds = [];

function customPhotos() {
  try {
    return fs.readdirSync(PHOTO_DIR)
      .filter((f) => IMAGE_EXT.test(f))
      .map((f) => `/photos/${encodeURIComponent(f)}`);
  } catch {
    return [];
  }
}

function stockPhotos() {
  if (stockIds.length) return stockIds.map((id) => `https://picsum.photos/id/${id}/900/900`);
  return Array.from({ length: 300 }, (_, i) => `https://picsum.photos/seed/clout-${i}/900/900`);
}

async function loadStockIds() {
  try {
    const pages = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      fetch(`https://picsum.photos/v2/list?page=${i + 1}&limit=100`).then((r) => (r.ok ? r.json() : []))));
    stockIds = pages.flat().map((p) => p.id);
  } catch (err) {
    console.warn(`  Couldn't fetch the picsum.photos list (${err.message}); using seeded URLs instead.`);
  }
}

function buildDeck() {
  return [...shuffle(customPhotos()), ...shuffle(stockPhotos())];
}

function drawPhoto(room) {
  if (!room.deck.length) room.deck = buildDeck();
  return room.deck.shift();
}

// ---- Helpers ----------------------------------------------------------------

const randomId = (bytes = 8) => crypto.randomBytes(bytes).toString('base64url');
const pickRandom = (arr) => arr[crypto.randomInt(arr.length)];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cleanName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

function cleanCaption(text) {
  return String(text ?? '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_CAPTION);
}

// ---- Rooms ------------------------------------------------------------------

const rooms = new Map();

function createRoom() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => pickRandom(CODE_LETTERS)).join('');
  } while (rooms.has(code));

  const room = {
    code,
    phase: 'lobby',          // lobby → pick → caption → vote → results → (pick …) → final
    hostId: null,
    players: new Map(),
    rounds: 3,
    round: 0,
    phaseStartedAt: 0,
    deadline: null,
    duration: 0,
    deck: [],
    roundData: null,
    bestPost: null,
    timer: null,
    hostTimer: null,
    emptyTimer: null,
  };
  rooms.set(code, room);
  return room;
}

function destroyRoom(room) {
  clearTimeout(room.timer);
  clearTimeout(room.hostTimer);
  clearTimeout(room.emptyTimer);
  for (const p of room.players.values()) clearTimeout(p.dropTimer);
  rooms.delete(room.code);
}

function addPlayer(room, name) {
  const player = {
    id: randomId(),
    token: randomId(16),
    name,
    score: 0,
    connected: false,
    socketId: null,
    disconnectedAt: 0,
    active: true,            // false = sitting out future rounds
    dropTimer: null,
  };
  room.players.set(player.id, player);
  if (!room.hostId) room.hostId = player.id;
  return player;
}

function removePlayer(room, player) {
  clearTimeout(player.dropTimer);
  if (room.phase === 'lobby') {
    room.players.delete(player.id);
  } else {
    // Mid-game we keep them on the scoreboard; they just stop getting dealt in.
    player.active = false;
    player.connected = false;
    player.socketId = null;
  }
  if (room.hostId === player.id) passHost(room);
  if (![...room.players.values()].some((p) => p.connected)) return destroyRoom(room);
  if (!maybeAdvance(room)) broadcast(room);
}

function dropPlayer(room, player) {
  if (rooms.get(room.code) !== room || player.connected) return;
  if (room.phase === 'lobby') return removePlayer(room, player);
  player.active = false;
  broadcast(room);
}

function passHost(room) {
  const next = [...room.players.values()].find((p) => p.connected && p.id !== room.hostId);
  if (next) room.hostId = next.id;
}

function connectedCount(room) {
  return [...room.players.values()].filter((p) => p.connected).length;
}

// ---- Game flow --------------------------------------------------------------

function setPhase(room, phase, seconds = 0) {
  clearTimeout(room.timer);
  room.phase = phase;
  room.phaseStartedAt = Date.now();
  room.duration = seconds * 1000;
  room.deadline = seconds ? Date.now() + room.duration : null;
  if (seconds) room.timer = setTimeout(() => onTimeout(room), room.duration + GRACE_MS);
  broadcast(room);
}

function onTimeout(room) {
  if (room.phase === 'pick') beginCaption(room);
  else if (room.phase === 'caption') beginShowcase(room);
  else if (room.phase === 'showcase') setPhase(room, 'vote', PHASE_SECONDS.vote);
  else if (room.phase === 'vote') showResults(room);
}

function startGame(room) {
  for (const p of room.players.values()) {
    p.score = 0;
    p.active = p.connected;
  }
  room.round = 0;
  room.bestPost = null;
  room.deck = buildDeck();
  startRound(room);
}

function startRound(room) {
  const participants = [...room.players.values()].filter((p) => p.active).map((p) => p.id);
  if (participants.length < 2) return endGame(room);

  room.round++;
  room.roundData = {
    participants,
    options: new Map(participants.map((id) => [id, [drawPhoto(room), drawPhoto(room)]])),
    picks: new Map(),        // playerId → index of the photo they chose
    assignments: new Map(),  // captionerId → id of the player whose photo they caption
    drafts: new Map(),
    captions: new Map(),
    posts: [],
    votes: new Map(),        // voterId → postId
    results: null,
  };
  setPhase(room, 'pick', PHASE_SECONDS.pick);
}

function pickedPhoto(rd, playerId) {
  return rd.options.get(playerId)[rd.picks.get(playerId)];
}

function beginCaption(room) {
  const rd = room.roundData;
  for (const id of rd.participants) {
    if (!rd.picks.has(id)) rd.picks.set(id, crypto.randomInt(2));
  }
  // Rotate a shuffled circle so nobody ever gets their own photo.
  const order = shuffle(rd.participants);
  order.forEach((id, i) => rd.assignments.set(id, order[(i + 1) % order.length]));
  setPhase(room, 'caption', PHASE_SECONDS.caption);
}

// Every post plays for everyone at once, one at a time, before voting opens.
// Clients work out which post is up from phaseStartedAt, so the server doesn't tick.
function beginShowcase(room) {
  const rd = room.roundData;
  const fallbacks = shuffle(FALLBACK_CAPTIONS);
  rd.posts = shuffle(rd.participants.map((authorId, i) => {
    const photographerId = rd.assignments.get(authorId);
    let caption = rd.captions.get(authorId) || cleanCaption(rd.drafts.get(authorId));
    const auto = !caption;
    if (auto) caption = fallbacks[i % fallbacks.length];
    return { id: randomId(6), authorId, photographerId, photo: pickedPhoto(rd, photographerId), caption, auto };
  }));
  setPhase(room, 'showcase', rd.posts.length * SHOWCASE_SECONDS_PER_POST);
}

function showResults(room) {
  const rd = room.roundData;
  const likes = new Map(rd.posts.map((p) => [p.id, []]));
  for (const [voterId, postId] of rd.votes) likes.get(postId)?.push(voterId);
  const counts = [...likes.values()].map((l) => l.length);
  const most = Math.max(...counts);
  const allTied = counts.every((n) => n === most);

  rd.results = rd.posts
    .map((post) => {
      const likedBy = likes.get(post.id);
      const viral = most > 0 && !allTied && likedBy.length === most;
      const points = likedBy.length * LIKE_POINTS + (viral ? VIRAL_BONUS : 0);
      room.players.get(post.authorId).score += points;
      return { ...post, likedBy, viral, points };
    })
    .sort((a, b) => b.likedBy.length - a.likedBy.length);

  const top = rd.results[0];
  if (top.likedBy.length > 0 && top.likedBy.length > (room.bestPost?.likedBy.length ?? 0)) room.bestPost = top;
  setPhase(room, 'results');
}

function endGame(room) {
  setPhase(room, 'final');
}

function backToLobby(room) {
  for (const p of [...room.players.values()]) {
    if (!p.connected) room.players.delete(p.id);
  }
  room.round = 0;
  room.roundData = null;
  setPhase(room, 'lobby');
}

function hasActed(room, playerId) {
  const rd = room.roundData;
  if (!rd) return false;
  if (room.phase === 'pick') return rd.picks.has(playerId);
  if (room.phase === 'caption') return rd.captions.has(playerId);
  if (room.phase === 'vote') return rd.votes.has(playerId);
  return false;
}

// Skip the rest of the timer once everyone we're still waiting on has acted.
// Someone who dropped in the last few seconds still counts, so a locked phone doesn't lose its turn.
function maybeAdvance(room) {
  if (!['pick', 'caption', 'vote'].includes(room.phase)) return false;
  const waitingOn = room.roundData.participants.filter((id) => {
    const p = room.players.get(id);
    return p.connected || Date.now() - p.disconnectedAt < RECONNECT_GRACE_MS;
  });
  if (!waitingOn.length || !waitingOn.every((id) => hasActed(room, id))) return false;
  onTimeout(room);
  return true;
}

// ---- What each player gets to see ------------------------------------------

// Posts stay anonymous until the reveal; you only learn which one is yours.
function anonymousPosts(rd, me) {
  return rd.posts.map((p) => ({ id: p.id, photo: p.photo, caption: p.caption, mine: p.authorId === me.id }));
}

function viewFor(room, me) {
  const rd = room.roundData;
  const inRound = (id) => !!rd && rd.participants.includes(id);
  const nameOf = (id) => room.players.get(id)?.name ?? '???';
  const publicPost = (r) => ({
    id: r.id,
    photo: r.photo,
    caption: r.caption,
    auto: r.auto,
    author: nameOf(r.authorId),
    authorId: r.authorId,
    photographer: nameOf(r.photographerId),
    likedBy: r.likedBy.map(nameOf),
    likes: r.likedBy.length,
    viral: r.viral,
    points: r.points,
  });

  const view = {
    code: room.code,
    phase: room.phase,
    round: room.round,
    rounds: room.rounds,
    deadline: room.deadline,
    duration: room.duration,
    serverNow: Date.now(),
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    me: { id: me.id, name: me.name, isHost: room.hostId === me.id, playing: inRound(me.id) },
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.connected,
      active: p.active,
      isHost: room.hostId === p.id,
      playing: inRound(p.id),
      done: hasActed(room, p.id),
    })),
  };

  const playing = inRound(me.id);
  if (room.phase === 'pick' && playing) {
    view.pick = { options: rd.options.get(me.id), chosen: rd.picks.get(me.id) ?? -1 };
  } else if (room.phase === 'caption' && playing) {
    view.caption = {
      photo: pickedPhoto(rd, rd.assignments.get(me.id)),
      submitted: rd.captions.get(me.id) ?? null,
      draft: rd.drafts.get(me.id) ?? '',
    };
  } else if (room.phase === 'showcase') {
    view.showcase = {
      posts: anonymousPosts(rd, me),
      startedAt: room.phaseStartedAt,
      perPost: SHOWCASE_SECONDS_PER_POST * 1000,
    };
  } else if (room.phase === 'vote') {
    view.vote = {
      canVote: playing,
      myVote: rd.votes.get(me.id) ?? null,
      posts: anonymousPosts(rd, me),
    };
  } else if (room.phase === 'results') {
    view.results = rd.results.map(publicPost);
  } else if (room.phase === 'final') {
    view.best = room.bestPost ? publicPost(room.bestPost) : null;
  }
  return view;
}

function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.socketId) io.to(p.socketId).emit('state', viewFor(room, p));
  }
}

// ---- Server -----------------------------------------------------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));

function bind(socket, room, player) {
  socket.data.code = room.code;
  socket.data.playerId = player.id;
  const oldSocketId = player.socketId;
  player.socketId = socket.id;
  player.connected = true;
  player.active = true;
  clearTimeout(player.dropTimer);
  clearTimeout(room.emptyTimer);
  if (room.hostId === player.id) clearTimeout(room.hostTimer);
  if (oldSocketId && oldSocketId !== socket.id) io.sockets.sockets.get(oldSocketId)?.disconnect(true);
}

const sessionOf = (room, player) => ({ code: room.code, playerId: player.id, token: player.token });

io.on('connection', (socket) => {
  const current = () => {
    const room = rooms.get(socket.data.code);
    const player = room?.players.get(socket.data.playerId);
    return player ? { room, player } : null;
  };

  const on = (event, handler) => socket.on(event, (payload, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    try {
      handler(payload && typeof payload === 'object' ? payload : {}, reply);
    } catch (err) {
      console.error(`[${event}]`, err);
      reply({ ok: false, error: 'Something went wrong.' });
    }
  });

  // Actions that need you to already be in a room.
  const act = (event, handler) => on(event, (payload, reply) => {
    const c = current();
    if (!c) return reply({ ok: false, error: "You're not in a game." });
    handler(c.room, c.player, payload, reply);
  });

  const leaveCurrent = () => {
    const c = current();
    if (c) removePlayer(c.room, c.player);
    socket.data = {};
  };

  on('create', ({ name }, reply) => {
    const clean = cleanName(name);
    if (!clean) return reply({ ok: false, error: 'Enter a name first.' });
    leaveCurrent();
    const room = createRoom();
    const player = addPlayer(room, clean);
    bind(socket, room, player);
    reply({ ok: true, session: sessionOf(room, player) });
    broadcast(room);
  });

  on('join', ({ code, name }, reply) => {
    const room = rooms.get(String(code ?? '').trim().toUpperCase());
    if (!room) return reply({ ok: false, error: "Couldn't find that room code." });
    const clean = cleanName(name);
    if (!clean) return reply({ ok: false, error: 'Enter a name first.' });
    if (room.players.size >= MAX_PLAYERS) return reply({ ok: false, error: 'That room is full.' });
    if ([...room.players.values()].some((p) => p.name.toLowerCase() === clean.toLowerCase())) {
      return reply({ ok: false, error: 'Someone in that room already has that name.' });
    }
    leaveCurrent();
    const player = addPlayer(room, clean);
    bind(socket, room, player);
    reply({ ok: true, session: sessionOf(room, player) });
    broadcast(room);
  });

  on('rejoin', ({ code, playerId, token }, reply) => {
    const room = rooms.get(code);
    const player = room?.players.get(playerId);
    if (!player || player.token !== token) return reply({ ok: false, error: 'That game has ended.' });
    bind(socket, room, player);
    reply({ ok: true });
    broadcast(room);
  });

  act('leave', (room, player, _payload, reply) => {
    socket.data = {};
    removePlayer(room, player);
    reply({ ok: true });
  });

  act('settings', (room, player, { rounds }, reply) => {
    if (room.hostId !== player.id || room.phase !== 'lobby') return reply({ ok: false });
    const n = Number(rounds);
    if (!Number.isInteger(n) || n < 1 || n > 10) return reply({ ok: false });
    room.rounds = n;
    reply({ ok: true });
    broadcast(room);
  });

  act('start', (room, player, _payload, reply) => {
    if (room.hostId !== player.id || room.phase !== 'lobby') return reply({ ok: false });
    if (connectedCount(room) < MIN_PLAYERS) {
      return reply({ ok: false, error: `You need at least ${MIN_PLAYERS} players.` });
    }
    reply({ ok: true });
    startGame(room);
  });

  act('pick', (room, player, { index }, reply) => {
    const rd = room.roundData;
    if (room.phase !== 'pick' || !rd.participants.includes(player.id) || rd.picks.has(player.id)) {
      return reply({ ok: false });
    }
    if (index !== 0 && index !== 1) return reply({ ok: false });
    rd.picks.set(player.id, index);
    reply({ ok: true });
    if (!maybeAdvance(room)) broadcast(room);
  });

  act('draft', (room, player, { text }) => {
    const rd = room.roundData;
    if (room.phase !== 'caption' || !rd.participants.includes(player.id) || rd.captions.has(player.id)) return;
    rd.drafts.set(player.id, String(text ?? '').slice(0, MAX_CAPTION));
  });

  act('caption', (room, player, { text }, reply) => {
    const rd = room.roundData;
    if (room.phase !== 'caption' || !rd.participants.includes(player.id) || rd.captions.has(player.id)) {
      return reply({ ok: false, error: 'Too late!' });
    }
    const caption = cleanCaption(text);
    if (!caption) return reply({ ok: false, error: 'Write something first!' });
    rd.captions.set(player.id, caption);
    reply({ ok: true });
    if (!maybeAdvance(room)) broadcast(room);
  });

  act('vote', (room, player, { postId }, reply) => {
    const rd = room.roundData;
    if (room.phase !== 'vote' || !rd.participants.includes(player.id)) return reply({ ok: false });
    const post = rd.posts.find((p) => p.id === postId);
    if (!post) return reply({ ok: false });
    if (post.authorId === player.id) return reply({ ok: false, error: "You can't like your own post." });
    rd.votes.set(player.id, post.id);
    reply({ ok: true });
    if (!maybeAdvance(room)) broadcast(room);
  });

  act('next', (room, player, _payload, reply) => {
    if (room.hostId !== player.id || room.phase !== 'results') return reply({ ok: false });
    reply({ ok: true });
    if (room.round >= room.rounds) endGame(room);
    else startRound(room);
  });

  act('restart', (room, player, _payload, reply) => {
    if (room.hostId !== player.id || room.phase !== 'final') return reply({ ok: false });
    reply({ ok: true });
    backToLobby(room);
  });

  socket.on('disconnect', () => {
    const c = current();
    if (!c || c.player.socketId !== socket.id) return;
    const { room, player } = c;
    player.connected = false;
    player.socketId = null;
    player.disconnectedAt = Date.now();
    player.dropTimer = setTimeout(() => dropPlayer(room, player), DROP_AFTER_MS);
    setTimeout(() => {
      if (rooms.get(room.code) === room && !player.connected) maybeAdvance(room);
    }, RECONNECT_GRACE_MS + 100);

    if (room.hostId === player.id) {
      clearTimeout(room.hostTimer);
      room.hostTimer = setTimeout(() => {
        if (!player.connected && room.hostId === player.id) {
          passHost(room);
          broadcast(room);
        }
      }, HOST_HANDOFF_MS);
    }
    if (connectedCount(room) === 0) {
      room.emptyTimer = setTimeout(() => destroyRoom(room), EMPTY_ROOM_TTL_MS);
    }
    if (!maybeAdvance(room)) broadcast(room);
  });
});

server.listen(PORT, async () => {
  await loadStockIds();
  const custom = customPhotos().length;
  console.log(`\n  clout is running!\n  On this computer:     http://localhost:${PORT}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  Phones on your Wi-Fi: http://${a.address}:${PORT}`);
    }
  }
  console.log(custom
    ? `  Photos: ${custom} of yours from public/photos, then stock photos\n`
    : `  Photos: stock photos from picsum.photos (drop your own into public/photos)\n`);
});
