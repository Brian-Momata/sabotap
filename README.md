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

## Voice chat

Every room has built-in voice chat — tap the 🎙 pill (bottom-right) to join; everyone in the room who joins can talk, across the lobby, matches, and tournament waits. Audio is peer-to-peer WebRTC (the game server only relays call setup), with mute and leave controls. Whoever is talking lights up: their lobby mic badge glows and the voice pill shows their name, so a room full of people always knows who has the floor. If two players are on very restrictive networks the call may not connect — set `TURN_URL`/`TURN_USERNAME`/`TURN_CREDENTIAL` env vars to add a TURN relay for those cases.

## Tournament mode

Flip the lobby to **Tournament** (3–8 players, same room code / invites). It runs a circle-method **round-robin**: everyone plays everyone once, matches within a stage run simultaneously, and each match is exactly 2 rounds (both players search once) worth 1 point per round won. Between matches you see live standings and a worst-case countdown until the next pairing; pairings announce your opponent with their rank and points. Odd player counts get one bye each. Dropouts forfeit their current match (opponent takes the remaining rounds) and future opponents get walkovers. The final leaderboard crowns the winner; ties share a rank.

## Friends

Every device gets a persistent friend tag (e.g. `BRI#4821`) — no accounts. Add friends by tag or from the results screen after a match. The friend list shows live presence (offline / online / in lobby / in game) and toasts when a friend comes online; online friends can be invited to a room with one tap (they get an instant join prompt that expires after a bit, and declining tells the inviter).

## Account transfer & recovery

No accounts, but the profile still moves: the home screen's **Account** card issues a short-lived **link code** (type it on a new phone to make it this player) and a permanent **recovery code** (save it anywhere; it restores the profile — tag, friends and all — if the phone is lost). Claiming mid-match re-seats the new device into the running game.

## Architecture

- `server.js` + `lib/` — Node + Express + `ws`. Fully server-authoritative: grid, target, fuse, puzzles, charges, and sabotage resolution live on the server; clients send intents and render.
- `lib/config.js` — every playtesting variable (grid size, fuse, puzzle time, sabotage tuning) in one block; numeric values overridable via env vars.
- `lib/identity.js` — device link codes (short-lived) and recovery codes (persistent) for the account-less identity model. `lib/client-config.js` — the config block shipped in hello payloads (incl. STUN/TURN).
- `lib/game/` — the game domain, one responsibility per module:
  - `match.js` — the 2-player round engine (pick → live → roundEnd), transport-agnostic via injected send ports.
  - `sabotages.js` — one effect function per sabotage kind; adding a kind means a config entry + one function here, `Match` stays untouched.
  - `boards.js` — board themes ("maps"): per-board grid/puzzle strategies (Hall of Mirrors twins, Glyphs symbols) and the Rotation cycle; Blackout and Drift are client-visual only.
  - `puzzle.js`, `grid.js`, `round-robin.js`, `room-code.js`, `rng.js` — pure helpers.
  - `tournament.js` — round-robin schedule, stages, standings, walkovers/forfeits.
  - `voice-channel.js` — voice roster + WebRTC signaling relay, scoped by a room-supplied group function.
  - `room.js` — roster, lobby settings, mode dispatch (versus vs tournament).
  - `reconnect.js` — disconnect grace, seat re-attachment, and resume snapshots for a room.
  - `serialize.js` + `persistence.js` — room/match/tournament state to `data/rooms.json` and back: rooms survive server restarts, revived paused until players reconnect.
  - `index.js` — the package's public surface (`Room`, `Match`, …).
- `public/js/` — vanilla ES-module client: `state` (identity + state bag), `net` (socket + reconnect), `audio`, `ui` (screens/toast), `home`, `identity-ui` (account card: link/recovery/claim), `lobby`, `game-view` (grid/fuse/caller panel), `sabotage-fx` (searcher-side sabotage visuals), `board-themes` (board picker motifs, announce splash, Blackout torch, Drift motion), `tournament-view`, `results`, `voice` (WebRTC mesh), `voice-meter` (WebAudio speaking detection + highlights), `install` (PWA prompt), `handlers` (server-message dispatch), `main` (wiring + boot). Design tokens are oklch CSS custom properties from the design system.
- Engineering standard: [docs/ENGINEERING.md](docs/ENGINEERING.md) — hard rules, style, and definition of done for every change.
- `data/store.json` — profiles and friendships; `data/rooms.json` — live room/match state (both atomic JSON writes). A server restart revives every room paused, mid-round state included.
- Reconnect grace: a dropped player has 30s to rejoin their seat; the round pauses meanwhile (and resumes only when both players are back).

## Test

```bash
npm test           # scripted two-client e2e: full match, sabotages, rematch, reconnect, friends
```
