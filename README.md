# Sabotap

A real-time, two-phone number search game. Each round one player is the **Searcher** — racing to tap a target number on a 7×8 grid before the fuse burns out — and the other is the **Caller**, who picks the target, then solves rapid odd-one-out puzzles to bank sabotage charges and disrupt the Searcher's grid live. Roles swap every round; first to 3 round wins takes the match.

Built from the *Number Hunt Design System* (Claude Design) and its validated single-device prototype.

## Run

```bash
npm install
npm start          # http://localhost:3000
```

Open the URL on two phones (same network, or deploy anywhere that supports WebSockets). It's an installable PWA — "Add to Home Screen" gives a fullscreen standalone app.

## Play

1. One player taps **Create Room**, shares the room code (or the invite link / a friend invite).
2. The other joins; the host picks match length (first to 2/3/5) and difficulty — Casual (24s fuse), Tense (16s), or Frantic (10s). Higher difficulty also speeds up the Caller's puzzles and makes the odd digit a visual lookalike from the start.
3. Each round: the Caller secretly picks the target, then loses the grid and earns sabotage charges by solving puzzles (cap 3). Each sabotage has its own cooldown, and none ever touches or highlights the target tile. Sabotages: **Blur**, **Decoys** (fake "found it" flashes), **Swap** (two tiles trade places), **Zoom** (forces panning), **Invert**.
4. Correct tap → Searcher takes the round. Fuse fills → Caller takes it.

## Tournament mode

Flip the lobby to **Tournament** (3–8 players, same room code / invites). It runs a circle-method **round-robin**: everyone plays everyone once, matches within a stage run simultaneously, and each match is exactly 2 rounds (both players search once) worth 1 point per round won. Between matches you see live standings and a worst-case countdown until the next pairing; pairings announce your opponent with their rank and points. Odd player counts get one bye each. Dropouts forfeit their current match (opponent takes the remaining rounds) and future opponents get walkovers. The final leaderboard crowns the winner; ties share a rank.

## Friends

Every device gets a persistent friend tag (e.g. `BRI#4821`) — no accounts. Add friends by tag or from the results screen after a match; online friends can be invited to a room with one tap (they get an instant join prompt).

## Architecture

- `server.js` + `lib/` — Node + Express + `ws`. Fully server-authoritative: grid, target, fuse, puzzles, charges, and sabotage resolution live on the server; clients send intents and render.
- `lib/config.js` — every playtesting variable (grid size, fuse, puzzle time, sabotage tuning) in one block; numeric values overridable via env vars.
- `public/` — vanilla JS single-page client + PWA manifest/service worker. Design tokens are oklch CSS custom properties from the design system.
- `data/store.json` — profiles and friendships (atomic JSON writes). Rooms are in-memory.
- Reconnect grace: a dropped player has 30s to rejoin their seat; the round pauses meanwhile.

## Test

```bash
npm test           # scripted two-client e2e: full match, sabotages, rematch, reconnect, friends
```
