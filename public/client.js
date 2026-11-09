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

// GIFs play as muted, looping MP4s, which are a fraction of the size of the .gif file.
// If a phone won't autoplay video (iPhones in Low Power Mode won't), swap in the animated WebP.
function media(m, { cls = 'post-img', sized = true } = {}) {
  if (m.kind !== 'gif') return h('img', { class: cls, src: m.url, alt: '' });
  const attrs = { class: `${cls} gif`, style: sized ? `aspect-ratio:${m.width}/${m.height}` : null };
  const video = h('video', {
    ...attrs, src: m.mp4, poster: m.still || null, 'aria-label': m.title,
    autoplay: true, loop: true, muted: true, playsinline: true, preload: 'auto',
  });
  video.muted = true;   // the attribute alone doesn't satisfy every browser's autoplay check
  const fallback = () => video.replaceWith(h('img', { ...attrs, src: m.webp, alt: m.title }));
  video.addEventListener('error', fallback, { once: true });
  video.addEventListener('canplay', () => {
    video.play().catch((err) => { if (err.name === 'NotAllowedError') fallback(); });
  }, { once: true });
  return video;
}

// Each phone keeps its own stack of GIFs. Giphy requires search and trending calls to come
// from the browser, so a refill is one trending call plus one search on a random topic.
// A refill usually lasts a whole game, which keeps a group well inside a free key's
// 100 calls an hour.
const GIF_TOPICS = [
  'cat', 'dog', 'dancing', 'awkward', 'fail', 'confused', 'celebrate', 'shocked', 'cooking',
  'sleepy', 'office', 'party', 'grandma', 'baby', 'wedding', 'gym', 'cringe', 'vibing', 'chaos',
  'reality tv', 'animals', 'driving', 'sports', 'eating', 'side eye', 'nervous', 'proud',
  'unimpressed', 'dramatic', 'goat', 'bird', 'horse', 'monday', 'shopping', 'beach', 'kids',
];
const rand = (n) => Math.floor(Math.random() * n);

function gifFromGiphy(g) {
  const o = g.images?.original;
  if (!o?.mp4 || !o?.webp) return null;
  return {
    kind: 'gif', id: g.id, mp4: o.mp4, webp: o.webp,
    still: g.images['480w_still']?.url || g.images.original_still?.url || '',
    width: Number(o.width), height: Number(o.height), title: g.title || '',
  };
}

const gifs = {
  stack: [],
  seen: new Set(),
  refilling: null,
  pausedUntil: 0,   // after Giphy fails, give it a rest instead of burning the hourly limit

  async take(n, config) {
    if (this.stack.length < n && Date.now() < this.pausedUntil) throw new Error('Giphy paused after an error');
    if (this.stack.length < n) {
      this.refilling ??= this.refill(config).finally(() => { this.refilling = null; });
      await this.refilling;
    }
    if (this.stack.length < n) throw new Error('Giphy sent back too few GIFs');
    return this.stack.splice(0, n);
  },

  async refill({ key, rating }) {
    const call = (endpoint, params) =>
      fetch(`https://api.giphy.com/v1/gifs/${endpoint}?${new URLSearchParams({ api_key: key, rating, limit: 50, ...params })}`)
        .then((r) => { if (!r.ok) throw new Error(`Giphy ${endpoint} returned ${r.status}`); return r.json(); });
    const results = await Promise.allSettled([
      call('trending', { offset: rand(450) }),
      call('search', { q: GIF_TOPICS[rand(GIF_TOPICS.length)], offset: rand(200), lang: 'en' }),
    ]);
    const fresh = results
      .flatMap((r) => (r.status === 'fulfilled' ? r.value.data ?? [] : []))
      .map(gifFromGiphy)
      .filter((g) => g && !this.seen.has(g.id) && this.seen.add(g.id));
    for (let i = fresh.length - 1; i > 0; i--) {
      const j = rand(i + 1);
      [fresh[i], fresh[j]] = [fresh[j], fresh[i]];
    }
    this.stack.push(...fresh);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) console.warn(failed.reason);
    if (!fresh.length) this.pausedUntil = Date.now() + 5 * 60_000;
  },
};

function giphyCredit() {
  return h('a', { class: 'giphy-credit', href: 'https://giphy.com', target: '_blank', rel: 'noopener' }, 'Powered by GIPHY');
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
  if (phase === 'pick') return `pick:${round}:${state.pick ? state.pick.picked : 'watch'}`;
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
    media(r.photo),
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
          h('li', {}, h('b', {}, '📸 Pick'), ' one of two pictures.'),
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
    if (state.pick.picked) return waitingScreen('📸', 'Nice pick.', 'Waiting on everyone else…');

    const grid = h('div', { class: 'pick-grid' });
    const title = h('h2', { class: 'title' }, state.giphy ? 'Pick a GIF' : 'Pick a photo');
    const credit = state.giphy ? giphyCredit() : null;
    const show = (choices, payload) => {
      const tiles = choices.map((m, i) => h('button', {
        class: 'pick-tile',
        onclick: async () => {
          tiles.forEach((t, j) => t.classList.add(j === i ? 'chosen' : 'faded'));
          const res = await send('pick', payload(m, i));
          if (!res.ok) { tiles.forEach((t) => t.classList.remove('chosen', 'faded')); toast(res.error); }
        },
      }, media(m, { cls: 'tile-media', sized: false })));
      grid.replaceChildren(...tiles);
    };
    const showGifs = (two) => show(two, (gif) => ({ gif }));
    const showPhotos = () => {
      title.textContent = 'Pick a photo';
      if (credit) credit.hidden = true;
      show(state.pick.options, (_, index) => ({ index }));
    };

    if (state.pick.offered) {
      showGifs(state.pick.offered);
    } else if (state.giphy) {
      grid.replaceChildren(h('div', { class: 'pick-tile loading' }), h('div', { class: 'pick-tile loading' }));
      gifs.take(2, state.giphy)
        .then((two) => {
          if (!grid.isConnected) return gifs.stack.unshift(...two);   // round moved on; keep them
          socket.emit('offer', { gifs: two });
          showGifs(two);
        })
        .catch((err) => {
          console.warn(err);
          if (grid.isConnected) showPhotos();
        });
    } else {
      showPhotos();
    }

    return h('section', { class: 'screen' },
      roundLabel(),
      title,
      h('p', { class: 'muted' }, 'Someone else will post it as you, with a caption they wrote. Choose wisely.'),
      grid,
      credit);
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
      h('p', { class: 'muted' }, `${as.name} picked this. Write the caption they're "posting" it with.`),
      h('article', { class: 'post' },
        h('header', { class: 'post-head' },
          avatar(as.name, as.id),
          h('div', { class: 'who' }, h('b', {}, handle(as.name)), h('span', { class: 'muted small' }, `you're posting as ${as.name}`))),
        media(state.caption.photo),
        h('div', { class: 'post-actions' }, h('span', { class: 'heart static' }, heartIcon())),
        preview),
      h('div', { class: 'composer card' }, box, h('div', { class: 'row between' }, count, postBtn)));
  },

  // Posts play one at a time, in sync on every phone, like a story reel.
  showcase() {
    const { posts, perPost } = state.showcase;
    const fills = posts.map(() => h('div', { class: 'story-fill' }));
    const counter = h('span', { class: 'muted small' });
    // Every card is built up front (hidden) so its picture is already loaded when its turn comes.
    const cards = posts.map((post) => h('article', { class: `post story${post.mine ? ' mine' : ''}`, hidden: true },
      postedAsHead(post),
      media(post.photo),
      h('p', { class: 'caption-text big' }, h('b', {}, handle(post.poster)), ' ', richText(post.caption))));
    const stage = h('div', { class: 'story-stage' }, cards);
    let shown = -1;

    frameTick = () => {
      const elapsed = serverNow() - state.showcase.startedAt;
      const idx = Math.min(posts.length - 1, Math.max(0, Math.floor(elapsed / perPost)));
      fills.forEach((f, i) => {
        f.style.transform = `scaleX(${Math.min(1, Math.max(0, (elapsed - i * perPost) / perPost))})`;
      });
      if (idx === shown) return;
      shown = idx;
      counter.textContent = `${idx + 1} of ${posts.length}`;
      cards.forEach((card, i) => { card.hidden = i !== idx; });
      const video = cards[idx].querySelector('video');
      if (video) {
        video.currentTime = 0;   // start the GIF from its first frame
        video.play().catch(() => {});
      }
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
      } }, media(post.photo), burst);
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
      h('p', { class: 'muted' }, 'Tap ❤️ or double-tap a post to like your favorite.'),
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
