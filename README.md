# clout

A Jackbox-style party game for phones. Every round:

1. **Pick.** Each player gets two photos and picks one.
2. **Caption.** Every player gets *someone else's* pick and captions it like it's their own social media post.
3. **Showcase.** The posts play one at a time like a story reel, in sync on every phone, so the whole room reads each one together.
4. **Like.** All the posts show up in an anonymous feed, and everyone likes their favorite (you can't like your own). Tap the heart or double-tap the photo.
5. **Reveal.** Posters are revealed. Each like is +100 followers, and the most-liked post goes 🔥 viral for a +200 bonus.

Most followers after the last round wins. It takes 3–10 players.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000, start a room, and have friends join with the 4-letter code.
The server prints a `http://192.168.x.x:3000` address that phones on the same Wi-Fi can use.
The first time you run it, Windows may ask whether to let Node through the firewall. Allow it on private networks.

### Testing without friends

```bash
npm run bots -- ABCD 3     # 3 bots join room ABCD and play along with you
npm run bots -- auto 5     # 5 bots create a room and play a whole game by themselves
```

For testing with fewer humans you can also lower the minimum: `MIN_PLAYERS=2 npm start`.

## Photos

By default the game uses random stock photos from [picsum.photos](https://picsum.photos). They're pretty tame (lots of landscapes and coffee cups), and the game gets much funnier with weirder pictures.

**To use your own**, drop `.jpg` / `.png` / `.webp` / `.gif` files into `public/photos/` and restart. Those are dealt first, and stock photos only fill in if you run out. Each round uses 2 photos per player, so a 3-round game with 8 players goes through 48.

## Tuning

The constants at the top of `server.js` control the timers (`PHASE_SECONDS`), how long each post stays up in the showcase (`SHOWCASE_SECONDS_PER_POST`), scoring (`LIKE_POINTS`, `VIRAL_BONUS`), player limits, and the captions used when someone runs out the clock.

## Deploying it

The game is a Node server that holds open WebSocket connections and keeps every room in memory, so it needs a host that runs a normal always-on server. Vercel can't do that: its functions cut WebSocket connections off at 5 minutes on the Hobby plan, and it doesn't promise that two connections reach the same instance.

This repo ships a `render.yaml` blueprint for [Render](https://render.com), whose free tier runs it fine:

1. Push this repo to GitHub.
2. On Render, pick **New → Blueprint** and choose the repo. It reads `render.yaml` and needs nothing else. (Doing it by hand works too: New → Web Service, runtime Node, build `npm install`, start `npm start`.)
3. Render gives you a URL like `https://clout.onrender.com`. That's the game — share it with friends.

Free instances sleep after 15 minutes with no traffic, and the next person to open the link waits about a minute for it to wake up. Start the room a minute before everyone piles in, or move to a paid instance (Render Starter, or Fly.io at around $2/month) to make that go away. Open WebSocket traffic counts as activity, so a game in progress never falls asleep.

Any other Node host works the same way — the server reads the `PORT` environment variable and needs no other configuration.

To link it from a site hosted elsewhere, use a plain link or button to the game URL, or point a subdomain like `play.yoursite.com` at the host. An iframe works too:

```html
<iframe src="https://your-game-host/" style="width:100%;height:100vh;border:0" allow="clipboard-write"></iframe>
```

Rooms live in memory, so restarting or redeploying the server ends any games in progress. That's fine for a party game. If you ever run more than one instance you'd need a shared store instead.

## Files

```
server.js          game server: rooms, rounds, timers, scoring (Express + Socket.IO)
public/index.html  page shell
public/client.js   phone UI: one screen per game phase
public/style.css   styles
public/photos/     your own photos (optional)
scripts/bots.js    bot players for testing
render.yaml        one-click deploy config for Render
```
