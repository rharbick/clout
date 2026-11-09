# clout

A Jackbox-style party game for phones. Every round:

1. **Pick.** Each player gets two random GIFs and picks one.
2. **Caption.** Every player gets *someone else's* pick and writes its caption **as that person**. The post goes up under their name, so you're putting words in their mouth.
3. **Showcase.** The posts play under the names they were posted as, one at a time like a story reel, in sync on every phone, so the whole room reads each one together.
4. **Like.** All the posts show up in a feed, each one looking like the photo picker posted it, and everyone likes their favorite (you can't like your own). Tap the heart or double-tap the photo.
5. **Reveal.** The real caption writers are revealed, and they get the points. Each like is +100 followers, and the most-liked post goes 🔥 viral for a +200 bonus.

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

## GIFs

With a Giphy API key, every player picks between two random GIFs from [Giphy](https://giphy.com). Without one, the game falls back to photos.

**Getting a key:** sign in at the [Giphy developer dashboard](https://developers.giphy.com/dashboard), choose **Create an API Key**, and pick **API** (not SDK). It's free.

**Using it locally:** copy `.env.example` to `.env` and paste the key after `GIPHY_API_KEY=`. The server reads `.env` on startup, and git ignores the file.

**Using it on Render:** the blueprint asks for `GIPHY_API_KEY` when you create the service. On an existing service, add it under **Environment** and Render redeploys.

How it works, and the limits that come with it:

- Giphy requires search and trending requests to come from the browser, so each phone fetches its own GIFs and tells the server which one it picked. The key is sent to players' browsers for this. That's how Giphy web keys are designed to be used, but it means anyone in a game can see it.
- A new key is a "beta" key limited to **100 Giphy calls an hour**, shared by everyone using it. Each phone makes 2 calls to fill up on about 100 GIFs, which usually lasts a whole game, so a 10-player game costs about 20 calls. If you hit the limit, the game quietly switches to photos until the hour resets. For more, apply for a production key from the dashboard.
- GIFs are filtered to **PG-13** by default. Set `GIPHY_RATING` to `g`, `pg`, `pg-13`, or `r` to change that.
- GIFs play as muted looping MP4s, which are a fraction of the size of the `.gif` files. Phones that block autoplaying video, like iPhones in Low Power Mode, get the animated WebP instead.
- Giphy's terms require showing "Powered by GIPHY" where its API is used, so the pick screen shows it.

### Photos (the fallback)

Without a key, or when Giphy can't be reached, the game deals random stock photos from [picsum.photos](https://picsum.photos). To use your own instead, drop `.jpg` / `.png` / `.webp` / `.gif` files into `public/photos/` and restart. Those are dealt first, and stock photos fill in if you run out.

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
.env.example       template for your local .env (Giphy key)
```
