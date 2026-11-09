// Fills a room with bot players so you can test without rounding up friends.
//
//   npm run bots -- ABCD        → 3 bots join room ABCD
//   npm run bots -- ABCD 5      → 5 bots join room ABCD
//   npm run bots -- auto 4      → 4 bots create a room and play a whole game by themselves
//
// Set URL=http://host:port to point at a server other than localhost:3000.
'use strict';

const { io } = require('socket.io-client');

const URL = process.env.URL || 'http://localhost:3000';
const [roomArg = 'auto', countArg = '3'] = process.argv.slice(2);
const auto = roomArg.toLowerCase() === 'auto';
const count = Math.max(1, Number(countArg) || 3);

const NAMES = ['Botany', 'Chad GPT', 'Robo Rita', 'Beep', 'Captain Byte', 'Glitch', 'Toaster', 'Unit 7', 'Sir Bleep'];
const CAPTIONS = [
  'me after one (1) vegetable',
  'this is what peak performance looks like #grindset',
  'when the group chat goes quiet 😶',
  'my therapist said go outside so here we are',
  "didn't ask to be this iconic but here we are ✨",
  'POV: you said "one more episode" 6 hours ago',
  "manifesting this energy for monday #blessed",
  'not me pretending I know what I\'m doing',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const delay = () => sleep(400 + Math.random() * 1600);

function emit(socket, event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, (res) => resolve(res || {})));
}

function runBot(name, { create = false, code, isDriver = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ['websocket'] });
    const handled = new Set();

    socket.on('connect', async () => {
      const res = await emit(socket, create ? 'create' : 'join', { name, code });
      if (!res.ok) return reject(new Error(`${name}: ${res.error}`));
      resolve({ socket, code: res.session.code });
    });

    socket.on('state', async (s) => {
      if (s.phase === 'lobby') handled.clear();   // fresh game after "Play again"
      const key = `${s.phase}:${s.round}`;
      if (handled.has(key)) return;

      if (s.phase === 'pick' && s.pick && !s.pick.picked) {
        handled.add(key);
        await delay();
        emit(socket, 'pick', { index: Math.round(Math.random()) });
      } else if (s.phase === 'caption' && s.caption && !s.caption.submitted) {
        handled.add(key);
        await delay();
        emit(socket, 'caption', { text: rand(CAPTIONS) });
      } else if (s.phase === 'vote' && s.vote.canVote && !s.vote.myVote) {
        handled.add(key);
        await delay();
        const options = s.vote.posts.filter((p) => !p.mine);
        if (options.length) emit(socket, 'vote', { postId: rand(options).id });
      } else if (isDriver && s.me.isHost && s.phase === 'lobby' && s.players.length >= count) {
        handled.add(key);
        await sleep(500);
        emit(socket, 'start');
      } else if (isDriver && s.me.isHost && s.phase === 'results') {
        handled.add(key);
        const top = s.results[0];
        console.log(`  round ${s.round}: top post by ${top.author} (${top.likes} likes): "${top.caption}"`);
        await sleep(800);
        emit(socket, 'next');
      } else if (isDriver && s.phase === 'final') {
        handled.add(key);
        const ranked = [...s.players].sort((a, b) => b.score - a.score);
        console.log('\n  Final standings:');
        for (const p of ranked) console.log(`    ${p.name.padEnd(14)} ${p.score} followers`);
        process.exit(0);
      }
    });
  });
}

(async () => {
  const names = [...NAMES].sort(() => Math.random() - 0.5).slice(0, count);
  let code = roomArg.toUpperCase();
  if (auto) {
    const first = await runBot(names.shift(), { create: true, isDriver: true });
    code = first.code;
    console.log(`  Bots created room ${code} and are playing a full game…`);
  }
  for (const name of names) {
    await runBot(name, { code });
    console.log(`  ${name} joined ${code}`);
  }
  if (!auto) console.log('  Bots are in. Ctrl+C to remove them.');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
