# Bowling Rooms (self-hosted)

Multiplayer ten-pin bowling for the GameNest app ("Orbit Lanes"). Share a 6-letter room code, bowl 3, 5 or 10
frames with 2 to 8 players; bots fill seats. Played in the GameNest app only: the lane is 3D, so there is no
browser version (`public/index.html` says so).

The design is `~/Library/GameNest/Work/design/bowling/WORLD.md` (round 2, sections 2, 3 and 9).

## The server owns the pins

A phone sends a **release**: four integers (where it stands, the angle, the speed, the spin). The server runs the
ball down the lane (an analytic model with no noise, so the phone can play the same path from the same release
without waiting) and then the pin deck **in true 3D on deterministic Rapier** (`@dimforge/rapier3d-deterministic-compat`
0.21.0, pinned exactly): ten pins with the USBC profile, mass, centre of gravity and inertia, the kickbacks, the pit.
It sends every phone one `delivery` event with the deck's 6-DoF track (the ball and every pin that moved, 16-byte
samples at 30 Hz plus a key sample at each contact). The phone plays it back. Nothing about which pins fall is the
phone's to decide.

The physics runs in a **pool of child processes** (`pool.js`), never on the event loop, so one room's pins never delay
another room's clock, and a crash inside the physics (V8 did crash once in Rapier's wasm on this Mac, in a worker
thread) costs one retried ball, never the server.

| File | What |
|---|---|
| `lane.js` | The lane phase (release to the deck line: oil, hook, roll, gutters, bumpers, the ball's pose) and `simulate()` for a whole delivery. The wire release (integers) and its clamps |
| `deck3d.js` | The deck phase on Rapier: pins, ball, deck, gutters, kickbacks, pit; the collision events; the 6-DoF track |
| `calib_best.json` | The one parameter set (SHA-256 `f6e710d0…af84f6d`, checked by `test/physics.js`) |
| `score.js` | The card with the fresh-rack flag, USBC splits, the call for a ball, what happens after a ball, the frames suggestion |
| `bot.js` | The aim table (built once, handed to the physics processes), bots' releases, the modelled human hand, the timeout ball |
| `track.js` | The `delivery` event's physics payload: samples, events, the 48 KB cap |
| `sim.js` | One ball as a job (in a physics process; in the main thread only with `POOL_SIZE=0`) |
| `pool.js`, `pool_worker.js` | The physics pool: child processes (or threads), Rapier initialised once each, a human's ball ahead of the bots', crashed or hung workers replaced |
| `parser.js` | socket.io's own wire format, byte for byte, minus two costs (see the file) |
| `server.js` | Rooms, seats, turns, clocks, bots, AFK, host handover, roll-off, rematch, options, chat, voice, push, `/health` |
| `tools/tasks.js` | Batches of physics for the test suites, run in the pool |
| `test/*.js` | Below |

## Run it

```bash
npm ci
node server.js                                     # http://localhost:3000
BASE_PATH=/bowling PORT=3120 node server.js        # the owner's Mac (Tools/dev_servers.sh) / behind the reverse proxy
curl localhost:3000/health                         # rooms, sockets, the pool, loop lag, memory
```

Boot takes about 1.5 to 3 s (the aim table, then Rapier in each physics process).

| Environment | Default | What |
|---|---|---|
| `PORT`, `BASE_PATH` | 3000, none | as every GameNest server |
| `POOL_SIZE` | cores - 1, at most 4 | physics processes (about 300 MB each once warm); 2 on a small host; 0 runs the physics on the event loop (a diagnostic; do not deploy it) |
| `POOL_MODE` | `process` | `thread` runs the physics in worker threads instead (lighter, but a V8 crash in wasm then takes the server down) |
| `POOL_NODE_FLAGS` | none | extra V8 flags for the physics processes |
| `TURN_MS_FIRST`, `TURN_MS_NEXT` (`TURN_MS` sets both) | 30000, 20000 | the turn clock from `readyAt` |
| `AFK_MS` | 6000 | the clock while the bowler is disconnected |
| `BOT_MS` (+ up to 2/3 of it) | 400 | a bot bowls at `readyAt` + 400..667 ms |
| `RESULT_MS`, `RESULT_COUNT_MS`, `RESULT_REPLAY_MS` | 600, 400, 900 | the call's beat (a count; a strike replay), from the crash as shown (`CRASH_MS`, 2000, after the first hit) |
| `RESET_MS`, `HANDOFF_MS`, `COSMIC_MS`, `ROLLOFF_MS`, `ARRIVAL_MS` | 1000, 500, 1600, 2000, 2400 | WORLD.md 2.4 |
| `HUMAN_SHOW_MS` | 6000 | Plato's show: the beats after a person's ball (the next ball's time, the next bowler's) start this long after its release at the earliest, so the phone's result strip holds to the end of its show, then the next bowler's name shows in the band, then their ball; a bot's ball keeps its quick pace; 0 gives the pace of 2026-11-02 back |
| `PLAY_MS_SCALE` | 1 | tests only: 0 lets the next ball go without waiting for the playback |
| `REQUIRE_SEAT_KEY` | off | `1`: a rejoin must carry the seat key from `joined` (GN-26; turn on once the app sends it) |
| `EMPTY_ROOM_MS` | 600000 | a room with no human connected closes after this (the 2-hour idle rule still applies too) |
| `PING_INTERVAL_MS`, `PING_TIMEOUT_MS` | 25000, 20000 | socket.io's heartbeat; QA T9 asks for 5000 + 5000 |
| `PUSH_URL` | none | as every GameNest server |
| `STOCK_PARSER` | off | `1`: socket.io's stock parser (a diagnostic for load comparisons) |

## Tests

```bash
npm test               # every suite, quick sizes (about 4 to 6 minutes on this Mac)
npm run test:full      # WORLD.md 9.1's sizes: 20,000 deliveries, 1,000 balls a cell x 3 seeds, 200 games a bot, 50,000 fuzz events
node test/run.js rules # one suite
```

The socket suites start their own server on `TEST_PORT` (3281) and `TEST_PORT + 1`; nothing touches 3111-3120.

| Suite | What it proves |
|---|---|
| `score.js` | Hand-written cards, R7's last-frame marks ("0, 10, 5" is "- / 5"), short games, partial cards, the 21 textbook splits and non-splits, every call, the frame progression, 5,000 random games against an independent scorer |
| `pool.js` | The pool: the same bytes in a process as in a thread; a process killed with SIGILL mid-job costs one retried job; a hung job is timed out; a live server plays on through crashed physics processes |
| `physics.js` | The pinned build and parameter set; random deliveries: the ball never leaves the lane or passes a wall, no energy gained, every delivery ends by the sweep, a gutter ball touches no pin, bumpers, untouched pins stay within 1.5 mm, kickback messengers; the lane phase is noise-free; the wire format and the 48 KB cap; **determinism: 200 deliveries byte for byte twice in one thread, in a pool worker, and against fixtures recorded in an earlier process** |
| `strikemap.js` | WORLD.md 3.4's calibration cells at three seeds: the pocket strikes 85%+ at 4-7 degrees, head-on splits, light hits leave the 10, 6 degrees beats 2, 7 degrees does not collapse |
| `bots.js` | Whole games: Rookie below the casual hand, Regular within 10 pins of it, Pro above the careful hand, the timeout ball under a first game, no release outside the clamps, Lefty mirrors |
| `rules.js` | Real sockets: every room rule, turn enforcement, `n`, clamps, each delivery once and never in the state, the card equals `score.card`, racks re-set where they stood, roll-off, rematch, host handover, leaving, chat, voice |
| `protocol.js` | Every message's shape; readyAt gating and the clock formulas on production clocks; the bot's timing; the samples decode; the parser writes the stock parser's bytes |
| `reconnect.js` | A rejoin during a delivery gets it once, after its state; after it, the rack; two sockets for one player; host handover; one room per socket; seat keys |
| `afk.js` | The timeout ball, three in a row and a bot bowls, Take my seat back, the AFK clock, a reconnect hands the seat back |
| `fuzz.js` | Random events and payloads never crash the server or make an illegal card |
| `load.js` | Not in `npm test`: `node test/load.js --rooms 200 --minutes 5` (see the file) |

## Protocol

Shared with every GameNest server: `create`, `join`, `leave`, `addBot`, `removeBot`, `start`, `rematch`, `takeSeat`,
`chat`, `voice`, `presence`, `pushToken`; to the phone `joined`, `state`, `err` (a sentence). Also to the phone:
`refused` `{code, msg, to}` beside every `err` (codes: `not_found`, `started`, `full`, `name`, `left`, `seat_key`,
`seats`, `bad_throw`).

Bowling's own: `settings {frames: 3|5|10, rolloff: bool}` (host, lobby), `options {bumpers, lefty, ball}` (any seat,
for itself), `throw {n, x, angle, speed, spin}` (integers: 0.1 mm, 0.001 degree, mm/s, 0.001; `n` = `throwSeq + 1`),
`ping {c}` / `pong {c, s}`, and the `delivery` event. The full shapes are in the notes the client lanes read
(`~/Library/GameNest/Work/servers/bowling.md`) and in `test/protocol.js`.

## Rules

Standard ten-pin: frames 1 to F-1 have up to two balls, the last frame up to three with a fresh rack after a strike
or spare, and **a strike is only ever a ball at a fresh rack** (after a zero, clearing the ten is a spare). A turn is a
bowler's whole frame. Roll-off on ties (one ball each at a full rack, up to three times, then shared). A ball not
bowled in time is the timeout ball (straight down the middle at 6.2 m/s, about 73 a game); three in a row and the
Rookie bot bowls for you until you act. Per-player bumpers, left-handed, and a house ball pattern.

## Notes

- Rooms live in memory; a restart loses open rooms (as every GameNest server). A room nobody human is connected to
  closes after 10 minutes; any room after 2 idle hours.
- Memory: the server itself about 150 MB; each physics process about 95 MB at boot, settling near 300 MB after its first
  hundred balls (V8's wasm compiler keeps the memory it peaked at) and flat after that. With 4 processes (the default
  on this Mac) plan on about 1.4 GB under load; `POOL_SIZE=2` carries 200 rooms of 8 at party pace in about 800 MB,
  with slower recovery from bursts of balls.
- The determinism fixtures were recorded on Node 26 with Rapier 0.21.0; the Dockerfile pins `node:26-alpine`. A new
  Rapier or Node major is a server change: re-run `test/physics.js`, and re-record only on purpose.

## Docker

```bash
docker build -t bowling-rooms . && docker run -d -p 8098:3000 --restart unless-stopped bowling-rooms
```
