/* global io */
'use strict';

const socket = io();
const app = document.getElementById('app');
const $timer = document.getElementById('timer');
const $timebar = document.getElementById('timebar');
const $roomBadge = document.getElementById('roomBadge');
const $conn = document.getElementById('connBanner');
const $toast = document.getElementById('toast');

let state = null;        // latest view from the server (null = not in a room)
let clockOffset = 0;     // serverNow - Date.now(), so timers agree across devices
let mountedKey = null;   // which screen is currently in the DOM
let updaters = [];       // functions that refresh the mounted screen in place
let frameTick = null;    // per-tick animation for the mounted screen (the showcase uses it)

// ---- Tiny DOM helpers -------------------------------------------------------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const handle = (name) => '@' + String(name).toLowerCase().replace(/\s+/g, '_');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fmt = (n) => n.toLocaleString();

function hue(str) {
  let x = 7;
  for (const ch of String(str)) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  return x % 360;
}

function avatar(name, seed, extra = '') {
  return h('div', { class: `avatar ${extra}`, style: `--h:${hue(seed || name)}` }, [...String(name)][0]?.toUpperCase() || '?');
}

// Captions render as text; #hashtags and @mentions get highlighted like the real apps.
function richText(text) {
  const frag = document.createDocumentFragment();
  for (const part of String(text).split(/([#@][\p{L}\p{N}_]+)/u)) {
    if (!part) continue;
    frag.append(/^[#@][\p{L}\p{N}_]+$/u.test(part) ? h('span', { class: 'tag' }, part) : part);
  }
  return frag;
}

function heartIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.innerHTML = '<path d="M12 20.5l-1.3-1.2C5.6 14.7 2.5 11.9 2.5 8.4 2.5 5.6 4.7 3.5 7.4 3.5c1.6 0 3.1.7 4.6 2.3 1.5-1.6 3-2.3 4.6-2.3 2.7 0 4.9 2.1 4.9 4.9 0 3.5-3.1 6.3-8.2 10.9L12 20.5z"/>';
  return svg;
}

let toastTimer;
function toast(msg) {
  if (!msg) return;
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.hidden = true; }, 2600);
}

function send(event, payload = {}) {
  return new Promise((resolve) => {
    socket.timeout(8000).emit(event, payload, (err, res) => {
      resolve(err ? { ok: false, error: 'Connection hiccup, try again.' } : res || { ok: true });
    });
  });
}

async function copyInvite() {
  const link = `${location.origin}/?room=${state.code}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied');
  } catch {
    toast(link);
  }
}

// ---- Session (survives refreshes and phone screen-locks) -----------------

const SESSION_KEY = 'clout.session';
const session = {
  get() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; } },
  set(s) { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* private mode */ } },
  clear() { try { sessionStorage.removeItem(SESSION_KEY); } catch { /* private mode */ } },
};
const savedName = {
  get() { try { return localStorage.getItem('clout.name') || ''; } catch { return ''; } },
  set(n) { try { localStorage.setItem('clout.name', n); } catch { /* private mode */ } },
};

async function leave() {
  await send('leave');
  session.clear();
  state = null;
  render();
}

// ---- Socket wiring ----------------------------------------------------------

socket.on('connect', async () => {
  $conn.hidden = true;
  const s = session.get();
  if (!s) return render();
  const res = await send('rejoin', s);
  if (!res.ok) {
    session.clear();
    state = null;
    render();
    toast(res.error);
  }
});

socket.on('disconnect', () => { $conn.hidden = false; });

socket.on('state', (s) => {
  state = s;
  clockOffset = s.serverNow - Date.now();
  render();
});

// ---- Rendering --------------------------------------------------------------

function screenKey() {
  if (!state) return 'home';
  const { phase, round } = state;
  if (phase === 'pick') return `pick:${round}:${state.pick ? state.pick.chosen >= 0 : 'watch'}`;
  if (phase === 'caption') return `caption:${round}:${state.caption ? !!state.caption.submitted : 'watch'}`;
  return `${phase}:${round}`;
}

function render() {
  const key = screenKey();
  if (key !== mountedKey) {
    const prevPhase = mountedKey?.split(':')[0];
    const phase = key.split(':')[0];
    updaters = [];
    frameTick = null;
    app.replaceChildren(SCREENS[phase]());
    if (prevPhase !== phase) {
      window.scrollTo(0, 0);
      if (prevPhase && prevPhase !== 'home') try { navigator.vibrate?.(40); } catch { /* unsupported */ }
    }
    mountedKey = key;
  }
  $roomBadge.hidden = !state;
  if (state) $roomBadge.textContent = state.code;
  for (const fn of updaters) fn();
  tickTimer();
}

const serverNow = () => Date.now() + clockOffset;

function tickTimer() {
  frameTick?.();
  // The showcase has its own story-style progress bars, so the header timer steps aside.
  if (!state?.deadline || state.phase === 'showcase') {
    $timer.hidden = true;
    $timebar.style.transform = 'scaleX(0)';
    return;
  }
  const left = Math.max(0, state.deadline - serverNow());
  $timer.hidden = false;
  $timer.textContent = Math.ceil(left / 1000);
  $timer.classList.toggle('urgent', left <= 5000);
  $timebar.style.transform = `scaleX(${state.duration ? left / state.duration : 0})`;
}
setInterval(tickTimer, 100);
$roomBadge.addEventListener('click', copyInvite);

// ---- Shared pieces ----------------------------------------------------------

const me = () => state.me;
const host = () => state.players.find((p) => p.isHost);
const roundLabel = () => h('div', { class: 'eyebrow' }, `Round ${state.round} of ${state.rounds}`);

// Live "who's done" chips for everyone dealt into this round.
function statusChips() {
  const wrap = h('div', { class: 'chips' });
  updaters.push(() => wrap.replaceChildren(...state.players.filter((p) => p.playing).map((p) =>
    h('div', { class: `chip${p.done ? ' done' : ''}${p.connected ? '' : ' offline'}` },
      avatar(p.name, p.id, 'xs'), p.name, h('span', { class: 'chip-status' }, p.done ? '✓' : '…')))));
  return wrap;
}

function waitingScreen(emoji, title, sub) {
  return h('section', { class: 'screen center' },
    state.round ? roundLabel() : null,
    h('div', { class: 'big-emoji' }, emoji),
    h('h2', { class: 'title' }, title),
    sub ? h('p', { class: 'muted' }, sub) : null,
    statusChips());
}

// A host-only button that turns into a "waiting" line for everyone else.
function hostAction(label, event, waitingText) {
  const box = h('div', { class: 'stack' });
  const btn = h('button', { class: 'btn primary', onclick: async () => {
    btn.disabled = true;
    const res = await send(event);
    if (!res.ok) { btn.disabled = false; toast(res.error); }
  } }, label);
  updaters.push(() => box.replaceChildren(me().isHost
    ? btn
    : h('p', { class: 'muted center' }, waitingText(host()?.name ?? 'the host'))));
  return box;
}

function scoreboard(roundPoints = new Map()) {
  const ranked = [...state.players].sort((a, b) => b.score - a.score);
  return h('ol', { class: 'scoreboard card' }, ranked.map((p, i) =>
    h('li', { class: p.id === me().id ? 'me' : '' },
      h('span', { class: 'rank' }, i + 1),
      avatar(p.name, p.id, 'sm'),
      h('span', { class: 'name' }, p.name, p.connected ? null : h('span', { class: 'muted small' }, ' (offline)')),
      roundPoints.get(p.id) ? h('span', { class: 'delta' }, `+${fmt(roundPoints.get(p.id))}`) : null,
      h('span', { class: 'score' }, fmt(p.score), h('small', {}, ' followers')))));
}

function resultCard(r) {
  return h('article', { class: `post${r.viral ? ' viral' : ''}` },
    h('header', { class: 'post-head' },
      avatar(r.photographer, r.photographerId),
      h('div', { class: 'who' }, h('b', {}, handle(r.photographer))),
      r.viral ? h('span', { class: 'badge' }, '🔥 viral') : null),
    h('img', { class: 'post-img', src: r.photo, alt: '' }),
    h('div', { class: 'post-actions' },
      h('span', { class: `heart static${r.likes ? ' on' : ''}` }, heartIcon()),
      h('b', {}, plural(r.likes, 'like')),
      h('span', { class: 'points' }, `+${fmt(r.points)}`)),
    r.likes ? h('p', { class: 'liked-by small' }, 'Liked by ', h('b', {}, r.likedBy.join(', '))) : null,
    h('p', { class: 'caption-text' }, h('b', {}, handle(r.photographer)), ' ', richText(r.caption)),
    h('p', { class: 'reveal small' }, '✍️ Actually written by ', h('b', {}, r.author),
      r.auto ? ' (who ran out of time)' : null));
}

// Before the reveal, a post looks like the photo picker posted it. Who wrote it stays hidden.
function postedAsHead(post) {
  return h('header', { class: 'post-head' },
    avatar(post.poster, post.posterId),
    h('div', { class: 'who' }, h('b', {}, handle(post.poster))));
}

// ---- Screens ----------------------------------------------------------------

const SCREENS = {
  home() {
    const params = new URLSearchParams(location.search);
    const name = h('input', {
      class: 'input', placeholder: 'Your name', maxlength: 16, autocomplete: 'nickname', enterkeyhint: 'go',
    });
    name.value = savedName.get();
    const code = h('input', {
      class: 'input code-input', placeholder: 'ABCD', maxlength: 4, autocomplete: 'off',
      autocapitalize: 'characters', spellcheck: 'false', enterkeyhint: 'go',
    });
    code.value = (params.get('room') || '').toUpperCase().slice(0, 4);
    code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z]/g, ''); });

    async function go(kind) {
      const n = name.value.trim();
      if (!n) { name.focus(); return toast('Pick a name first'); }
      if (kind === 'join' && code.value.length !== 4) { code.focus(); return toast('Room codes are 4 letters'); }
      savedName.set(n);
      const res = await send(kind, { name: n, code: code.value });
      if (!res.ok) return toast(res.error);
      session.set(res.session);
      if (location.search) history.replaceState(null, '', location.pathname);
    }
    for (const input of [name, code]) {
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && code.value.length === 4) go('join'); });
    }
    if (code.value && !name.value) setTimeout(() => name.focus(), 0);

    return h('section', { class: 'screen home' },
      h('div', { class: 'hero' },
        h('h1', { class: 'logo' }, 'clout'),
        h('p', { class: 'tagline' }, "Pick a pic. Caption someone else's. Farm the likes.")),
      h('div', { class: 'card stack' },
        h('label', { class: 'field' }, h('span', {}, 'Your name'), name),
        h('label', { class: 'field' }, h('span', {}, 'Room code'), code),
        h('button', { class: 'btn primary', onclick: () => go('join') }, 'Join game'),
        h('div', { class: 'or' }, 'or'),
        h('button', { class: 'btn ghost', onclick: () => go('create') }, 'Start a new room')),
      h('div', { class: 'card how' },
        h('h3', {}, 'How to play'),
        h('ol', {},
          h('li', {}, h('b', {}, '📸 Pick'), ' one of two photos.'),
          h('li', {}, h('b', {}, '✍️ Caption'), " someone else's pick, posting as them. Put words in their mouth."),
          h('li', {}, h('b', {}, '❤️ Like'), ' your favorite post. Every like is +100 followers.'),
          h('li', {}, h('b', {}, '👑 Most followers'), ' at the end wins.'))));
  },

  lobby() {
    const list = h('ul', { class: 'players' });
    const controls = h('div', { class: 'stack' });

    updaters.push(() => {
      list.replaceChildren(...state.players.map((p) => h('li', { class: p.connected ? '' : 'offline' },
        avatar(p.name, p.id),
        h('span', { class: 'name' }, p.name),
        p.id === me().id ? h('span', { class: 'tag-pill' }, 'you') : null,
        p.isHost ? h('span', { class: 'tag-pill gold' }, '👑 host') : null,
        p.connected ? null : h('span', { class: 'muted small' }, 'offline'))));

      const online = state.players.filter((p) => p.connected).length;
      const need = Math.max(0, state.minPlayers - online);
      if (me().isHost) {
        controls.replaceChildren(
          h('div', { class: 'card' },
            h('div', { class: 'row between' },
              h('b', {}, 'Rounds'),
              h('div', { class: 'segmented' }, [2, 3, 5].map((n) => h('button', {
                class: n === state.rounds ? 'on' : '',
                onclick: () => send('settings', { rounds: n }),
              }, n))))),
          h('button', {
            class: 'btn primary', disabled: need > 0,
            onclick: async () => { const res = await send('start'); if (!res.ok) toast(res.error); },
          }, need ? `Waiting for ${plural(need, 'more player')}…` : 'Everybody’s in, start!'));
      } else {
        controls.replaceChildren(h('p', { class: 'muted center' },
          need ? `Waiting for ${plural(need, 'more player')}…` : `Waiting for ${host()?.name ?? 'the host'} to start…`));
      }
    });

    return h('section', { class: 'screen' },
      h('div', { class: 'card center' },
        h('div', { class: 'eyebrow' }, 'Room code'),
        h('div', { class: 'big-code' }, state.code),
        h('p', { class: 'muted' }, 'Friends join at ', h('b', {}, location.host), ' with this code'),
        h('button', { class: 'btn small ghost', onclick: copyInvite }, '🔗 Copy invite link')),
      h('div', { class: 'card' }, h('h3', {}, 'Players'), list),
      controls,
      h('button', { class: 'btn text', onclick: leave }, 'Leave room'));
  },

  pick() {
    if (!state.pick) return waitingScreen('🍿', "You're in!", "You'll get dealt in next round.");
    if (state.pick.chosen >= 0) return waitingScreen('📸', 'Nice pick.', 'Waiting on everyone else…');

    const tiles = state.pick.options.map((src, i) => h('button', {
      class: 'pick-tile',
      onclick: async () => {
        tiles.forEach((t, j) => t.classList.add(j === i ? 'chosen' : 'faded'));
        const res = await send('pick', { index: i });
        if (!res.ok) { tiles.forEach((t) => t.classList.remove('chosen', 'faded')); toast(res.error); }
      },
    }, h('img', { src, alt: `Photo option ${i + 1}` })));

    return h('section', { class: 'screen' },
      roundLabel(),
      h('h2', { class: 'title' }, 'Pick a photo'),
      h('p', { class: 'muted' }, 'Someone else will post it as you, with a caption they wrote. Choose wisely.'),
      h('div', { class: 'pick-grid' }, tiles));
  },

  caption() {
    if (!state.caption) return waitingScreen('🍿', "You're in!", "You'll get dealt in next round.");
    if (state.caption.submitted) return waitingScreen('✍️', 'Posted!', 'Waiting on everyone else to finish their captions…');
    const as = state.caption.as;

    const preview = h('p', { class: 'caption-text' });
    const count = h('span', { class: 'muted small' });
    const box = h('textarea', {
      class: 'input caption-input', maxlength: 150, rows: 3, enterkeyhint: 'send',
      placeholder: `Write ${as.name}'s caption… #blessed`,
    });
    box.value = state.caption.draft;
    const postBtn = h('button', { class: 'btn primary', onclick: post }, 'Post');

    function sync() {
      preview.replaceChildren(h('b', {}, handle(as.name)), ' ',
        box.value.trim() ? richText(box.value) : h('span', { class: 'muted' }, 'your caption shows up here'));
      count.textContent = `${box.value.length}/150`;
    }
    let draftTimer;
    box.addEventListener('input', () => {
      sync();
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => socket.emit('draft', { text: box.value }), 300);
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); post(); }
    });
    async function post() {
      if (!box.value.trim()) return toast('Write something first!');
      postBtn.disabled = true;
      const res = await send('caption', { text: box.value });
      if (!res.ok) { postBtn.disabled = false; toast(res.error); }
    }
    sync();

    return h('section', { class: 'screen' },
      roundLabel(),
      h('h2', { class: 'title' }, `Post as ${as.name}`),
      h('p', { class: 'muted' }, `${as.name} picked this photo. Write the caption they're "posting" it with.`),
      h('article', { class: 'post' },
        h('header', { class: 'post-head' },
          avatar(as.name, as.id),
          h('div', { class: 'who' }, h('b', {}, handle(as.name)), h('span', { class: 'muted small' }, `you're posting as ${as.name}`))),
        h('img', { class: 'post-img', src: state.caption.photo, alt: 'The photo you are captioning' }),
        h('div', { class: 'post-actions' }, h('span', { class: 'heart static' }, heartIcon())),
        preview),
      h('div', { class: 'composer card' }, box, h('div', { class: 'row between' }, count, postBtn)));
  },

  // Posts play one at a time, in sync on every phone, like a story reel.
  showcase() {
    const { posts, perPost } = state.showcase;
    for (const p of posts) new Image().src = p.photo;   // preload so each swap is instant

    const fills = posts.map(() => h('div', { class: 'story-fill' }));
    const counter = h('span', { class: 'muted small' });
    const stage = h('div', { class: 'story-stage' });
    let shown = -1;

    frameTick = () => {
      const elapsed = serverNow() - state.showcase.startedAt;
      const idx = Math.min(posts.length - 1, Math.max(0, Math.floor(elapsed / perPost)));
      fills.forEach((f, i) => {
        f.style.transform = `scaleX(${Math.min(1, Math.max(0, (elapsed - i * perPost) / perPost))})`;
      });
      if (idx === shown) return;
      shown = idx;
      const post = posts[idx];
      counter.textContent = `${idx + 1} of ${posts.length}`;
      stage.replaceChildren(h('article', { class: `post story${post.mine ? ' mine' : ''}` },
        postedAsHead(post),
        h('img', { class: 'post-img', src: post.photo, alt: '' }),
        h('p', { class: 'caption-text big' }, h('b', {}, handle(post.poster)), ' ', richText(post.caption))));
    };

    return h('section', { class: 'screen' },
      h('div', { class: 'row between' }, roundLabel(), counter),
      h('div', { class: 'story-bars' }, fills.map((f) => h('div', { class: 'story-seg' }, f))),
      stage,
      h('p', { class: 'muted small center' }, 'Everyone’s seeing these right now. Voting opens after the last post.'));
  },

  vote() {
    const like = async (post) => {
      if (post.mine) return toast("You wrote that one 🙄");
      if (!state.vote.canVote) return toast("You'll get to vote next round");
      state.vote.myVote = post.id;   // feels instant; server confirms with the next state
      render();
      const res = await send('vote', { postId: post.id });
      if (!res.ok) toast(res.error);
    };

    const cards = state.vote.posts.map((post) => {
      const heart = h('button', { class: 'heart', 'aria-label': 'Like', onclick: () => like(post) }, heartIcon());
      const burst = h('div', { class: 'burst' }, heartIcon());
      const photo = h('div', { class: 'post-img-wrap', ondblclick: () => {
        burst.classList.remove('go');
        void burst.offsetWidth;   // restart the animation
        burst.classList.add('go');
        like(post);
      } }, h('img', { class: 'post-img', src: post.photo, alt: '' }), burst);
      const card = h('article', { class: `post${post.mine ? ' mine' : ''}` },
        postedAsHead(post),
        photo,
        h('div', { class: 'post-actions' }, heart,
          post.mine ? h('span', { class: 'muted small' }, "you wrote this one, so you can't like it") : null),
        h('p', { class: 'caption-text' }, h('b', {}, handle(post.poster)), ' ', richText(post.caption)));
      if (post.mine || !state.vote.canVote) heart.disabled = true;
      updaters.push(() => {
        const on = state.vote.myVote === post.id;
        heart.classList.toggle('on', on);
        card.classList.toggle('liked', on);
      });
      return card;
    });

    return h('section', { class: 'screen' },
      roundLabel(),
      h('h2', { class: 'title' }, 'Like your favorite'),
      h('p', { class: 'muted' }, 'Tap ❤️ or double-tap a photo to like your favorite.'),
      h('div', { class: 'feed' }, cards),
      statusChips());
  },

  results() {
    const roundPoints = new Map(state.results.map((r) => [r.authorId, r.points]));
    const last = state.round >= state.rounds;
    return h('section', { class: 'screen' },
      roundLabel(),
      h('h2', { class: 'title' }, 'The results are in'),
      h('div', { class: 'feed' }, state.results.map(resultCard)),
      h('h3', { class: 'section-title' }, 'Follower count'),
      scoreboard(roundPoints),
      hostAction(last ? 'See who won 👑' : 'Next round →', 'next', (n) => `Waiting for ${n} to continue…`));
  },

  final() {
    const ranked = [...state.players].sort((a, b) => b.score - a.score);
    const winners = ranked.filter((p) => p.score === ranked[0].score);
    const names = winners.map((p) => p.name).join(' & ');
    return h('section', { class: 'screen' },
      h('div', { class: 'hero center' },
        h('div', { class: 'big-emoji' }, '👑'),
        h('h1', { class: 'title big' }, winners.length > 1 ? `${names} tie for the most clout` : `${names} has the most clout`),
        h('p', { class: 'muted' }, `${fmt(ranked[0].score)} followers`)),
      scoreboard(),
      state.best ? [h('h3', { class: 'section-title' }, '🏆 Post of the game'), resultCard(state.best)] : null,
      hostAction('Play again', 'restart', (n) => `Waiting for ${n} to start a new game…`),
      h('button', { class: 'btn text', onclick: leave }, 'Leave'));
  },
};

// First paint: home right away, or a placeholder while we reconnect to a game.
if (session.get()) app.replaceChildren(h('p', { class: 'muted center pad' }, 'Reconnecting to your game…'));
else render();
