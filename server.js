/* Bowling Rooms: self-hosted multiplayer ten-pin bowling for GameNest (WORLD.md).

   The same shape as the other GameNest servers (rooms behind a 6-letter code, the server owns the rules, bots fill
   seats, a turn that times out is played for you, chat, voice and push copied from minigolf-rooms and ludo-rooms).
   What is different: the server owns the pins. A phone sends a release (four integers); the server runs the lane
   phase and a deterministic 3D deck phase (Rapier) in a worker pool, and sends every phone the `delivery` event once,
   with the deck's 6-DoF track. The state never carries a track, so a sticker costs a small state, not a replay.

   Protocol, clocks and edge cases: README.md and WORLD.md sections 2 and 3. */
"use strict";
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const { monitorEventLoopDelay } = require("perf_hooks");
const L = require("./lane");
const S = require("./score");
const B = require("./bot");
const T = require("./track");
const SIM = require("./sim");
const { Pool, defaultSize } = require("./pool");
const Reactions = require("./reactions");   // the cartoon stickers (2026-10-15)
const Quick = require("./quickmatch");   // quick play and ranked (2026-10-24)
const Plus = require("./plus");   // GameNest Plus: the room's flag and each player's look (2026-10-16)
const Gear = require("./gear");   // the gear table and what it does (gear.js; gear step 4, 2026-11-10)
const Moderation = require("./moderation");   // what players type, kept friendly (2026-10-18)

const num = (name, def, min = 0) => { const v = Number(process.env[name]); return Math.max(min, Number.isFinite(v) && process.env[name] !== "" && process.env[name] !== undefined ? v : def); };
const has = (name) => process.env[name] !== undefined && process.env[name] !== "";

const app = express();
const BASE = (process.env.BASE_PATH || "").replace(/\/$/, "");
const server = http.createServer(app);
/* 256 KB: a voice signal is capped at 20 KB, a release is 60 bytes; nothing a phone sends is bigger. The parser writes
   the stock parser's bytes, cheaper (parser.js); STOCK_PARSER=1 uses the stock one (a diagnostic for load comparisons). */
/* The heartbeat: socket.io's 25 s + 20 s unless PING_INTERVAL_MS / PING_TIMEOUT_MS say otherwise (QA T9 asks for
   5000 + 5000 on every server, so a half-open link is noticed in about 10 s instead of 45; set it after a phone check). */
const io = new Server(server, {
  path: BASE + "/socket.io", cors: { origin: true }, maxHttpBufferSize: 256 * 1024, perMessageDeflate: false,
  pingInterval: num("PING_INTERVAL_MS", 25000, 1000), pingTimeout: num("PING_TIMEOUT_MS", 20000, 1000),
  ...(process.env.STOCK_PARSER === "1" ? {} : { parser: require("./parser") }),
});

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
/* The clocks of WORLD.md 2.4 and 3.7 (environment variables for tests; TURN_MS sets both turn clocks). */
const TURN_MS_FIRST = num("TURN_MS_FIRST", num("TURN_MS", 30000, 500), 500);
const TURN_MS_NEXT = num("TURN_MS_NEXT", num("TURN_MS", 20000, 500), 500);
const AFK_MS = num("AFK_MS", 6000, 200);
const TIMEOUTS_TO_BOT = 3;
const BOT_MS = num("BOT_MS", 400, 1);
/* Bot pace (2026-10-28): a bot's ball plays on the phones BOT_ROLL_SPEED times faster, its crash is held a shorter while, and the
   beats around it are short; it thinks 0.4-1.1 s by style and skill (BOT_MS set: the old fixed think, for the tests). */
const BOT_ROLL_SPEED = num("BOT_ROLL_SPEED", 3.6, 1);
const BOT_CRASH_MS = num("BOT_CRASH_MS", 420, 100);          // wall time the crash is shown (the delivery's own 2000 ms at BOT_ROLL_SPEED)
const BOT_RESULT_MS = { count: num("BOT_RESULT_COUNT_MS", 150), loud: num("BOT_RESULT_LOUD_MS", 260), replay: num("BOT_RESULT_REPLAY_MS", 360), taunt: num("BOT_RESULT_TAUNT_MS", 520) };
const BOT_RESET_MS = num("BOT_RESET_MS", 150);
const SKILL_THINK_PAD = { rookie: 120, regular: 0, pro: -60 };
const BOT_JITTER_MS = Math.max(1, Math.round(num("BOT_JITTER_MS", BOT_MS * 2 / 3, 0)));
/* Bowling Crew's pace (the owner, 2026-10-07: "i still hate the animation and flow"; their pick of a reference): back
   to aiming about 2 s after the crash. The phone shows the crash for CRASH_MS after the ball's first hit (or until the
   pins settle, if sooner) and starts the machine; the clocks below run from that same moment. */
/* Bowling r1 (2026-11-02, pacing): the same Crew pace trimmed so the time between your turns is under 8 s (it was 10.5 s p50 with one
   bot, 3 frames: the crash 2 s, the beats 0.4-1.4 s, the reset 1 s and the hand-over 0.5 s all added up). The crash is shown 1 s from
   the ball's first hit (the delivery says so: crashMs, for a person's ball too, so the phone and the clocks agree), the call beats are
   shorter, the machine takes 0.35 s and the hand-over 0.15 s. A tap past the first contact cuts the rest (the "skip" event). */
const RESULT_MS = num("RESULT_MS", 300);
const RESULT_COUNT_MS = num("RESULT_COUNT_MS", has("RESULT_MS") ? RESULT_MS : 160);
const RESULT_REPLAY_MS = num("RESULT_REPLAY_MS", has("RESULT_MS") ? RESULT_MS : 380);
const RESET_MS = num("RESET_MS", 350);
const HANDOFF_MS = num("HANDOFF_MS", 150);
const CRASH_MS = num("CRASH_MS", 1000);
/* Plato's show (bowling-plato, 2026-11-04; the owner: "the same way as Plato"): a person's ball is shown the way Plato shows it, the camera on the ball down the lane, the fall of the
   pins, the result strip held and the view coming home about 6 s after the release. The next ball, or the next bowler, goes after that and not under it: the strip holds, then the next
   bowler's name shows in the band, then their ball. The beats after a person's ball (and a timed-out one) start HUMAN_SHOW_MS after its release at the earliest; a bot's ball keeps its
   quick pace; HUMAN_SHOW_MS=0 gives the pace of 2026-11-02 back; a "skip" tap still cuts it (the phone then shows the rest 3x faster). */
const HUMAN_SHOW_MS = num("HUMAN_SHOW_MS", 6000, 0);
/* The pins left standing taunt the bowler after a gutter, a split, a miss or a weak first ball (the owner, 2026-10-07):
   the phone holds the result this long for it, the same rule as AGameNestBowlingStage::IsTaunt. */
const RESULT_TAUNT_MS = num("RESULT_TAUNT_MS", has("RESULT_MS") ? RESULT_MS : 700);
const isTaunt = (call, down, fresh) => call === "gutter" || call === "split" || down === 0 || (fresh && down <= 4);
const COSMIC_MS = num("COSMIC_MS", 1200);
const ROLLOFF_MS = num("ROLLOFF_MS", 2000);
const ARRIVAL_MS = num("ARRIVAL_MS", 2400);
const PLAY_MS_SCALE = num("PLAY_MS_SCALE", 1);          // tests only: 0 lets the next ball go without waiting for the playback
const EARLY_MS = 150;                                    // a throw up to this much before readyAt is taken (clock skew)
const MAX_ROLLOFFS = 3;
const ROOM_IDLE_MS = num("ROOM_IDLE_MS", 2 * 3600e3, 1000);
/* A room nobody human is connected to (every phone dropped without a leave: killed apps, lobbies abandoned) goes after
   10 minutes, not 2 hours; the sweep runs every minute. */
const EMPTY_ROOM_MS = num("EMPTY_ROOM_MS", 10 * 60e3, 500);
const SWEEP_MS = num("SWEEP_MS", 60000, 100);
const POOL_SIZE = has("POOL_SIZE") ? Math.floor(num("POOL_SIZE", 0)) : defaultSize();
const REQUIRE_SEAT_KEY = process.env.REQUIRE_SEAT_KEY === "1";

const COLORS = ["#ff5757", "#33d17a", "#ffc233", "#5b8cff", "#a78bfa", "#ff8c42", "#2ec4b6", "#ff6fb5"];
const AVATARS = ["\u{1F60E}", "\u{1F913}", "\u{1F451}", "\u{1F42F}", "\u{1F43C}", "\u{1F98A}", "\u{1F47D}", "\u{1F984}"];
const PATTERNS = ["solid", "swirl", "pearl", "marble", "twotone", "galaxy", "stripe", "flame"];   // seat 0..7's house balls
const CODE_ALPHABET = "ABCDEFGHJKMNPRTWXYZ";   // six letters, never a digit (2026-11-13)
const FRAME_CHOICES = [3, 5, 10];
/* Quick Play (bowling r1, 2026-11-02): one bot and three frames, whatever the seats suggest; a tap past the crash (the "skip" event)
   leaves this much of the crash and the machine's half second. */
const QUICK_FRAMES = num("QUICK_FRAMES", 3);
const SKIP_AFTER_HIT_MS = num("SKIP_AFTER_HIT_MS", 650);
const SKIP_RESET_MS = num("SKIP_RESET_MS", 250);
const LOUD = new Set(["perfect", "strike", "double", "turkey", "inarow", "spare", "converted", "split", "gutter"]);

const rooms = new Map();
app.get("/internal/roster/:code", Plus.rosterHandler((code) => rooms.get(code)));   // who is at a table, for the wallet's Treat the room (404 without GN_INTERNAL_SECRET)
const roomSockets = new Map();
const turnTimers = new Map();
const botTimers = new Map();
let deliveryIds = 0;
const stats = { deliveries: 0, fallbacks: 0, deadBalls: 0, maxBytes: 0, bytes: new (require("./pool").Ring)(4096) };

const newId = () => crypto.randomBytes(8).toString("hex");
function genCode() { let s = ""; for (let i = 0; i < 6; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]; return s; }
/* One bad frame or one bug must never take every room down with the process: every socket handler and timer runs
   through guard(), which logs and carries on. The watchdog below re-arms a room that was left without a clock. */
let guardErrors = 0;
function guard(what, fn) {
  return (...args) => { try { return fn(...args); } catch (e) { guardErrors++; console.error(`[bowling] ${what}:`, (e && e.stack) || e); } };
}
function clearT(map, code) { const t = map.get(code); if (t) { clearTimeout(t); map.delete(code); } }
function clearTimers(code) { clearT(turnTimers, code); clearT(botTimers, code); }

/* Names and chat: markup and control characters out, then cut to n UTF-16 units at a whole character (GN-30: one cap
   of 18 for names, never splitting an emoji). */
const SEG = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
function cut(s, n) {
  s = String(s == null ? "" : s).slice(0, 4 * n).replace(/[<>&"'`\u0000-\u001f\u007f\u2028\u2029]/g, "").trim();
  if (s.length <= n) return s;
  if (!SEG) return s.slice(0, n);
  let out = "";
  for (const { segment } of SEG.segment(s)) { if (out.length + segment.length > n) break; out += segment; }
  return out.trim();
}
const cleanName = (s) => { const c = cut(s, 18); return c ? Moderation.name(c) : c; };   // a bad name is "Player"
const cleanChat = (s) => cut(s, 140);
const cleanAvatar = (a) => cut(a, 8);
const cleanId = (id) => (typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null);

/* ---------- chat, voice and push (copied from minigolf-rooms, which copied them from ludo-rooms) ---------- */

const CHAT_KEEP = 60;
const CHAT_COOLDOWN_MS = 800;
const STICKERS = ["lol", "cry", "fire", "dice", "snail", "devil", "pray", "skull", "party", "angry", "pinch", "run"];
const PUSH_URL = process.env.PUSH_URL || "";
const PUSH_TITLE = "Bowling";

function pushTo(p, body, data, collapse) {
  if (!PUSH_URL || !p || !p.pushToken || p.bot || p.left) return;
  if (!(p.away || !p.connected)) return;                  // only someone who cannot see the screen
  const now = Date.now();
  if (p._lastPush && now - p._lastPush < 4000) return;
  p._lastPush = now;
  fetch(PUSH_URL + "/notify", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: p.pushToken, title: PUSH_TITLE, body, data: data || {}, collapse: collapse || undefined }),
  }).catch(() => {});
}
/* On a change of situation only: a delivery playing for four seconds must not send four notifications. */
function pushTurn(room) {
  const key = room.status + "|" + room.turn + "|" + room.frame;
  if (room._pushKey === key) return;
  room._pushKey = key;
  if (room.status !== "playing" && room.status !== "rolloff") return;
  const p = room.players[room.turn];
  if (p) pushTo(p, "Your ball in " + PUSH_TITLE + ", room " + room.code, { code: room.code, game: PUSH_TITLE }, room.code + "-turn");
}

/* ---------- the room ---------- */

function newRoom(code, host) {
  return {
    v: 1, code, host, status: "lobby",
    players: [],
    frames: 5, framesTouched: false, rolloffOn: true,
    frame: 1, turn: 0, ballNo: 1, rack: L.spots(), fresh: true, frameBalls: [], splitLeave: false,
    throwSeq: 0, pending: null, readyAt: null, turnEndsAt: null,
    lastThrow: null, delivery: null, rolloff: null, winners: [],
    gearOn: true,                      // the host's "gear" switch (private rooms); quick and ranked rooms always play with gear
    log: "Share the code with your friends.", chat: [], voice: null, touched: Date.now(),
  };
}
function newPlayer(id, name, avatar) {
  return { id, name, avatar, bot: false, skill: null, lefty: false, bumpers: false, ball: null, left: false, connected: true, botControlled: false, timeouts: 0, balls: [], splits: [], streak: 0, strikes: 0, seatKey: crypto.randomBytes(12).toString("hex"), gear: null };
}

/* ---------- gear (gear.js, gear step 4) ---------- */
/* What a seat's gear does on this lane: its stats when the room's gear switch is on, nothing (the base values) when it is off or the player sent none. A bot, and a person a bot bowls
   for, bowls the base ball (its release is chosen on it): its gear is the ball it wears and the score it shows, never an advantage. The server owns the release's cap (the ball's Power
   raises it) and its wobble (the shoes' Steadiness lessens it); the phone's flick and guide carry the Hook and the Aim line. */
const NO_GEAR = Gear.bowlingEffects(null);
const gearStats = (room, p) => (room.gearOn !== false && p && p.gear ? p.gear.stats : null);
const gearFx = (room, p) => (p && !p.bot && !p.botControlled && !p.left ? Gear.bowlingEffects(gearStats(room, p)) : NO_GEAR);
const gearHeld = (room, p) => room.gearOn !== false && !!(p && p.gear && !p.bot);   // the wobble is for a release the room holds gear for (an old app's is exact, as it always was; its phone rolls the same ball)
const gearView = (room, p) => (p && p.gear ? { score: p.gear.score, items: Object.fromEntries(Object.entries(p.gear.slots).map(([k, v]) => [k, v.item])), levels: Object.fromEntries(Object.entries(p.gear.slots).map(([k, v]) => [k, v.level])), stats: room.gearOn !== false ? p.gear.stats : { hook: 0, power: 0, steady: 0, aim: 0 } } : null);
/* The bots' gear fits the humans' band: the mean of the humans' gear scores (a human with none counts as the starter set), and none at all when no human sent any (old apps: everyone at the base). */
function botGearFor(room) {
  const hs = room.players.filter((p) => !p.bot && !p.left);
  if (!hs.some((p) => p.gear)) return null;
  return Gear.botGear("bowling", Math.round(hs.reduce((n, p) => n + Gear.scoreFor(p.gear, "bowling"), 0) / hs.length));
}
function gearBots(room) { for (const p of room.players) if (p.bot) p.gear = botGearFor(room); }
const active = (room) => room.players.map((p, i) => i).filter((i) => !room.players[i].left);
const humansLeft = (room) => room.players.some((p) => !p.bot && !p.left);
const colorOf = (s) => COLORS[s % COLORS.length];
const patternOf = (p, s) => p.ball || PATTERNS[s % PATTERNS.length];
const handOf = (p) => (p.lefty ? -1 : 1);
const pinWire = (p) => [p.n, Math.round(p.x * 1000), Math.round(p.y * 1000), Math.round((p.yaw || 0) * 1000)];

function sheetOf(room, p) {
  const c = S.card(p.balls, room.frames, p.splits);
  return { balls: p.balls, frames: c.frames.map((f) => ({ marks: f.marks, cum: f.cum, split: f.split })), total: c.total };
}
function publicRoom(room) {
  const sheets = room.players.map((p) => sheetOf(room, p));
  const R = room.rolloff;
  return {
    code: room.code, status: room.status, v: room.v, now: Date.now(), log: room.log,
    players: room.players.map((p, s) => ({
      name: p.name, avatar: p.avatar, color: colorOf(s), bot: !!p.bot, skill: p.bot ? p.skill : null, style: p.bot ? p.style : null, botControlled: !!p.botControlled,
      left: !!p.left, connected: !!p.connected, bumpers: !!p.bumpers, lefty: !!p.lefty, ball: patternOf(p, s), timeouts: p.timeouts || 0,
      ...Plus.seat(p), gear: gearView(room, p),
    })),
    hostSeat: room.players.findIndex((p) => p.id === room.host),
    gearOn: room.gearOn !== false,
    minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS,
    frames: room.frames,
    settings: { frames: room.frames, rolloff: room.rolloffOn, suggested: room.quick ? QUICK_FRAMES : S.suggestFrames(room.players.length), touched: room.framesTouched },
    frame: room.frame, ball: room.ballNo, turn: room.turn, fresh: room.fresh, rack: room.rack.map(pinWire),
    throwSeq: room.throwSeq, pending: !!room.pending, readyAt: room.readyAt, turnEndsAt: room.turnEndsAt, serverNow: Date.now(),
    sheets, totals: sheets.map((s) => s.total),
    lastThrow: room.lastThrow,
    rolloff: R ? { round: R.round, seats: R.seats, balls: Object.entries(R.balls).map(([s, n]) => [Number(s), n]), history: R.history } : null,
    winners: room.winners, winner: room.winners.length ? room.winners[0] : -1,
    chat: room.chat, voice: room.voice ? Array.from(room.voice) : [],
    ...Reactions.view(room),   // 2026-10-15: reactionsOn and the last reactions
    ...Quick.view(room),   // quick play and ranked (2026-10-24)
  };
}
function sendState(code) {
  const room = rooms.get(code), sockets = roomSockets.get(code);
  if (!room || !sockets) return;
  const pub = publicRoom(room);
  try { pushTurn(room); } catch (_) {}
  for (const s of sockets) s.emit("state", { room: pub, mySeat: room.players.findIndex((p) => p.id === s.data.playerId) });
}
function bump(room) { room.v++; room.touched = Date.now(); sendState(room.code); }
function deleteRoom(code) {
  clearTimers(code);
  rooms.delete(code);
  const set = roomSockets.get(code);
  if (set) for (const s of set) { s.leave(code); if (s.data.roomCode === code) s.data.roomCode = null; }
  roomSockets.delete(code);
}
/* GN-10's lesson: the clock is armed before the state that shows it goes out. */
function commit(room) { armTimer(room); bump(room); }

/* The frames the lobby suggests follow the seat count until the host touches the Frames segment. */
function resuggest(room) { if (room.status === "lobby" && !room.framesTouched) room.frames = room.quick ? QUICK_FRAMES : S.suggestFrames(Math.max(MIN_PLAYERS, room.players.length)); }

/* Ludo's host handover: the first connected human, else the first human still seated. */
function ensureHost(room) {
  const cur = room.players.find((p) => p.id === room.host);
  if (cur && !cur.bot && !cur.left && cur.connected) return false;
  const next = room.players.find((p) => !p.bot && !p.left && p.connected) || room.players.find((p) => !p.bot && !p.left);
  if (!next || next.id === room.host) return false;
  room.host = next.id;
  room.log = `${next.name} is now the host.`;
  return true;
}

/* ---------- play ---------- */

function freshRack(room) { room.rack = L.spots(); room.fresh = true; room.splitLeave = false; }
function beginTurn(room, seat, readyAt) {
  room.turn = seat; room.ballNo = 1; room.frameBalls = [];
  freshRack(room);
  room.readyAt = readyAt;
}
function startGame(room) {
  if (room.quick && !room.framesTouched) room.frames = QUICK_FRAMES;   // Quick Play is three frames, however the room filled
  room.status = "playing";
  room.frame = 1; room.winners = []; room.rolloff = null; room.lastThrow = null; room.delivery = null; room.pending = null;
  for (const p of room.players) { p.balls = []; p.splits = []; p.streak = 0; p.strikes = 0; p.timeouts = 0; p.botControlled = false; }
  gearBots(room);
  beginTurn(room, active(room)[0], Date.now() + ARRIVAL_MS);
  room.log = `Frame 1. ${room.players[room.turn].name} bowls first.`;
}

/* The turn clock and the bots' timers (WORLD.md 2.4): a clock never starts before the last delivery's beats end. */
function armTimer(room) {
  const code = room.code;
  clearTimers(code);
  if (room.status !== "playing" && room.status !== "rolloff") { room.turnEndsAt = null; return; }
  if (room.pending) { room.turnEndsAt = null; return; }
  const cur = room.players[room.turn];
  if (!cur || cur.left) { room.turnEndsAt = null; setImmediate(guard("skip", () => skipLeft(code))); return; }
  const now = Date.now(), from = Math.max(now, room.readyAt || now);
  const botty = cur.bot || cur.botControlled;
  const turnMs = !botty && !cur.connected ? AFK_MS : room.status === "rolloff" || room.ballNo === 1 ? TURN_MS_FIRST : TURN_MS_NEXT;
  room.turnEndsAt = from + turnMs;
  turnTimers.set(code, setTimeout(guard("turn clock", () => onTimeout(code)), room.turnEndsAt - now));
  if (botty) {
    const at = from + botThinkMs(cur);
    botTimers.set(code, setTimeout(guard("bot", () => onBot(code)), at - now));
  }
}
/* A seat that is left when its turn comes round (it left while its ball was in flight) is passed at once. */
function skipLeft(code) {
  const room = rooms.get(code);
  if (!room || room.pending || (room.status !== "playing" && room.status !== "rolloff")) return;
  const cur = room.players[room.turn];
  if (!cur || !cur.left) return;
  const at = Math.max(Date.now(), room.readyAt || 0);
  if (room.status === "rolloff") nextRolloffBowler(room, at); else endTurn(room, at);
  commit(room);
}
function botThinkMs(p) {
  if (has("BOT_MS")) return BOT_MS + crypto.randomInt(BOT_JITTER_MS);
  const st = B.STYLES[p.style] || B.STYLES.steady, [lo, hi] = st.think;
  return Math.max(120, lo + crypto.randomInt(Math.max(1, hi - lo)) + (SKILL_THINK_PAD[p.skill] || 0));
}
function onBot(code) {
  const room = rooms.get(code);
  if (!room || room.pending || (room.status !== "playing" && room.status !== "rolloff")) return;
  const p = room.players[room.turn];
  if (!p || !(p.bot || p.botControlled) || p.left) return;
  bowl(room, room.turn, { kind: "bot", skill: p.bot ? p.skill : "rookie" }, "");
}
/* A ball not bowled in time is the timeout ball (straight down the middle at 6.2 m/s); three in a row and a bot (the
   Rookie) bowls for them until they act (the shared AFK policy). */
function onTimeout(code) {
  const room = rooms.get(code);
  if (!room || room.pending || (room.status !== "playing" && room.status !== "rolloff")) return;
  const p = room.players[room.turn];
  if (!p || p.left) return skipLeft(code);
  if (p.bot || p.botControlled) return onBot(code);       // a bot that somehow missed its own timer
  p.timeouts = (p.timeouts || 0) + 1;
  let note;
  if (p.timeouts >= TIMEOUTS_TO_BOT) { p.botControlled = true; note = `${p.name} ran out of time ${TIMEOUTS_TO_BOT} times; a bot is bowling for them.`; }
  else note = p.connected ? `${p.name} ran out of time; the ball was bowled straight.` : `${p.name} lost the connection; the ball was bowled straight.`;
  bowl(room, room.turn, { kind: "timeout" }, note);
}

/* The one place a ball is bowled. The release goes to the pool; the room waits (pending) until the delivery is back. */
function bowl(room, seat, spec, note) {
  const p = room.players[seat];
  const n = ++room.throwSeq;
  const at = Date.now();
  room.pending = { n, seat, at, kind: spec.kind, note };
  clearTimers(room.code);
  room.turnEndsAt = null;
  if (spec.kind === "bot") {
    const st = B.STYLES[p.style] || B.STYLES.steady;
    p.form = B.formStep(p.form || 0, st.vol, Math.random);
    spec.formMul = B.formMul(p.form, room.frame === room.frames);
  }
  const job = {
    kind: spec.kind, release: spec.release, speedMax: spec.speedMax || 0, skill: spec.skill, botSeed: crypto.randomInt(0, 2 ** 32),
    style: spec.kind === "bot" ? p.style : null, formMul: spec.formMul || 1,
    standing: room.rack.map((q) => ({ n: q.n, x: q.x, y: q.y, yaw: q.yaw, fresh: !!q.fresh })),
    /* A person's ball: its physics seed is the release's own (the same swipe, the same result); a bot's and the timeout ball keep a random one. */
    seed: spec.kind === "human" ? L.releaseSeed(spec.release, room.rack, spec.speedMax || 0) : crypto.randomInt(0, 2 ** 32), bumpers: !!p.bumpers, hand: handOf(p),
  };
  simulate(job).then(guard("delivery", (res) => {
    if (rooms.get(room.code) !== room || !room.pending || room.pending.n !== n) return;   // the room moved on or closed
    applyDelivery(room, res);
  })).catch((e) => console.error("[bowling] delivery failed", e));
}

let pool = null;
/* A ball's physics: in the pool (a human's ball, or a timed-out human's, goes ahead of the bots' when it is busy: the
   bowler's phone is already rolling it and hides only about 2 s of wait, WORLD.md 5.1). A job whose worker failed is
   tried again (three tries, a short pause between, so a second worker dying at the same moment is seen first); if all
   fail the ball is a dead ball (it touches nothing) and the table goes on. The physics never runs on the event loop,
   except with POOL_SIZE=0 (a diagnostic). */
async function simulate(job) {
  if (pool) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return await pool.run(job, "ball", job.kind !== "bot"); } catch (e) {
        stats.fallbacks++;
        console.error(`[bowling] physics attempt ${attempt} failed:`, String((e && e.message) || e).split("\n")[0]);
        await new Promise((r) => setTimeout(r, 150 * attempt));
      }
    }
  } else {
    try { return SIM.runJob(job); } catch (e) { console.error("[bowling] physics failed:", String((e && e.message) || e).split("\n")[0]); }
  }
  stats.deadBalls++;
  return SIM.deadBall(job);
}

/* The delivery is back: send it once, score it, move the table on. */
function applyDelivery(room, res) {
  const pend = room.pending; room.pending = null;
  const seat = pend.seat, p = room.players[seat];
  const rolloff = room.status === "rolloff";
  const fresh = room.fresh, before = room.rack.length;
  const down = res.summary.down.length, standingNums = res.summary.standing.map((q) => q.n);
  const cleared = standingNums.length === 0;
  const strike = fresh && cleared;
  const leftSplit = fresh && S.isSplit(standingNums);
  let firstStrike = false, perfect = false;
  if (!rolloff) {
    p.balls.push(down); p.splits.push(leftSplit); room.frameBalls.push(down);
    p.streak = strike ? p.streak + 1 : 0;
    if (strike) { firstStrike = p.strikes === 0; p.strikes++; }
    perfect = strike && room.frame === room.frames && p.balls.length === room.frames + 2 && p.balls.every((b) => b === 10);
  }
  const c = S.callFor({ fresh, before, down, standing: standingNums, gutter: res.summary.gutter, streak: p.streak, splitBefore: room.splitLeave, perfect, firstStrike, rolloff });
  const leave = S.leaveName(standingNums);
  const id = ++deliveryIds;
  const quick = pend.kind === "bot" && !has("BOT_MS");          // a bot's ball is replayed faster and its beats are short
  const rate = quick ? BOT_ROLL_SPEED : 1;
  if (pend.kind === "bot" && p.bot) p.form = B.formAfter(p.form || 0, c.call, down);
  const ev = {
    id, n: pend.n, seat, at: pend.at, frame: rolloff ? null : room.frame, nth: room.ballNo, rolloff, fresh,
    kind: pend.kind, bumpers: !!p.bumpers, lefty: !!p.lefty, release: res.release,
    ...res.payload,
    count: down, call: c.call, streak: c.streak, leave, split: leftSplit, replay: c.replay,
    mph: res.summary.mph, entryBoard: res.summary.entryBoard, entryAngle: res.summary.entryAngle,
    crashMs: quick ? Math.round(BOT_CRASH_MS * rate) : CRASH_MS,   // a person's too: the phone's crash and these clocks agree
    ...(quick ? { speed: rate } : {}),
  };
  room.delivery = { ev, endsAt: pend.at + ev.playMs };
  stats.deliveries++; stats.maxBytes = Math.max(stats.maxBytes, res.bytes); stats.bytes.push(res.bytes);
  io.to(room.code).emit("delivery", ev);
  room.lastThrow = {
    id, n: pend.n, seat, frame: ev.frame, ball: room.ballNo, at: pend.at, playMs: ev.playMs, kind: pend.kind, rolloff, fresh,
    release: res.release, down: ev.down, standing: ev.standing, count: down, call: c.call, streak: c.streak, leave, split: leftSplit,
    replay: c.replay, gutter: ev.gutter, bumpers: ev.bumpers, mph: ev.mph, entryBoard: ev.entryBoard, entryAngle: ev.entryAngle,
  };
  const resultMs = quick ? (isTaunt(c.call, down, fresh) ? BOT_RESULT_MS.taunt : c.replay ? BOT_RESULT_MS.replay : LOUD.has(c.call) ? BOT_RESULT_MS.loud : BOT_RESULT_MS.count) : isTaunt(c.call, down, fresh) ? RESULT_TAUNT_MS : c.replay ? RESULT_REPLAY_MS : LOUD.has(c.call) ? RESULT_MS : RESULT_COUNT_MS;
  // The crash as the phones show it: CRASH_MS from the ball's first hit, or until the pins settle if that is sooner.
  const hit = (ev.ev || []).find((e) => e[1] === T.KIND.ball);
  const shownMs = hit ? Math.min(ev.playMs, hit[0] + (quick ? BOT_CRASH_MS * rate : CRASH_MS)) : ev.playMs;
  const show = quick ? 0 : Math.round(HUMAN_SHOW_MS * PLAY_MS_SCALE);   // a person's ball is shown to Plato's 6 s: nothing goes under it
  const beats = Math.max(pend.at + Math.round(shownMs / rate * PLAY_MS_SCALE) + resultMs, pend.at + show);
  room.log = (pend.note ? pend.note + " " : "") + describe(p.name, c, down, leave);
  room.lastBeats = { n: pend.n, seat, at: pend.at, hitMs: hit ? hit[0] : 0, rate, skipped: false };
  if (rolloff) { room.rolloff.balls[seat] = down; nextRolloffBowler(room, beats); }
  else {
    const ab = S.afterBall(room.frameBalls, cleared, room.frame === room.frames);
    if (!ab.over && !p.left) {
      room.ballNo++;
      if (ab.fresh) freshRack(room);
      else { room.rack = res.summary.standing.map((q) => ({ ...q, fresh: false })); room.fresh = false; room.splitLeave = leftSplit; }
      room.readyAt = beats + (quick ? BOT_RESET_MS : RESET_MS);
    } else endTurn(room, beats);
  }
  commit(room);
}
function describe(name, c, down, leave) {
  switch (c.call) {
    case "perfect": return `${name} bowls a perfect game!`;
    case "strike": return `${name}: strike!`;
    case "double": return `${name}: double!`;
    case "turkey": return `${name}: turkey!`;
    case "inarow": return `${name}: ${c.streak} strikes in a row!`;
    case "converted": return `${name} converts the split!`;
    case "spare": return `${name}: spare!`;
    case "split": return `${name} leaves the ${leave} split.`;
    case "gutter": return `${name}: gutter ball.`;
    default: return `${name}: ${down} pin${down === 1 ? "" : "s"}.`;
  }
}

/* The bowler's frame is over: the next seat in this frame, or the next frame, or the end of the frames. */
function endTurn(room, at) {
  const act = active(room);
  const after = act.filter((s) => s > room.turn);
  const hand = room.pending === null && room.players[room.turn] && room.players[room.turn].bot && !has("BOT_MS") ? Math.min(HANDOFF_MS, 150) : HANDOFF_MS;   // a bot's frame hands over briskly
  if (after.length) return beginTurn(room, after[0], at + hand);
  room.frame++;
  if (room.frame > room.frames) { room.frame = room.frames; return finishFrames(room, at); }
  beginTurn(room, act[0], at + hand + (room.frame === room.frames ? COSMIC_MS : 0));
}
function finishFrames(room, at) {
  const act = active(room);
  const totals = room.players.map((p) => S.card(p.balls, room.frames).total);
  const best = Math.max(...act.map((s) => totals[s]));
  const tied = act.filter((s) => totals[s] === best);
  if (tied.length > 1 && room.rolloffOn) return startRolloff(room, tied, at);
  gameOver(room, tied);
}
function startRolloff(room, seats, at) {
  room.status = "rolloff";
  room.rolloff = { round: 1, seats, balls: {}, history: [] };
  beginTurn(room, seats[0], at + ROLLOFF_MS);
  room.log = `Roll-off! ${seats.map((s) => room.players[s].name).join(" v ")}: one ball each, most pins wins.`;
}
function nextRolloffBowler(room, at) {
  const R = room.rolloff;
  R.seats = R.seats.filter((s) => !room.players[s].left);
  const waiting = R.seats.filter((s) => R.balls[s] === undefined);
  if (R.seats.length === 1) return gameOver(room, R.seats);
  if (waiting.length) return beginTurn(room, waiting[0], at + RESET_MS);
  const best = Math.max(...R.seats.map((s) => R.balls[s]));
  const leaders = R.seats.filter((s) => R.balls[s] === best);
  R.history.push({ round: R.round, balls: R.seats.map((s) => [s, R.balls[s]]) });
  if (leaders.length === 1 || R.round >= MAX_ROLLOFFS) return gameOver(room, leaders);
  R.round++; R.seats = leaders; R.balls = {};
  beginTurn(room, leaders[0], at + ROLLOFF_MS);
  room.log = `Tied again! Roll-off ${R.round}: ${leaders.map((s) => room.players[s].name).join(" v ")}.`;
}
function gameOver(room, winners) {
  /* The bots' reactions (2026-10-15) to the win alone: the taunting toons already answer every strike and gutter. */
  if (winners.length) Reactions.event(room, winners[0], "win", bump, 2500);
  room.status = "over";
  room.winners = winners.slice();
  room.turnEndsAt = null;
  clearTimers(room.code);
  const names = winners.map((s) => room.players[s].name);
  room.log = names.length === 1 ? `${names[0]} wins the game!` : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} share the win!`;
}

/* The human acts (throws, reconnects, or taps Take my seat back): the bot steps aside and the streak resets. */
function humanIsBack(room, p, reason) {
  const wasBot = !!p.botControlled;
  p.timeouts = 0;
  if (!wasBot) return false;
  p.botControlled = false;
  room.log = `${p.name} is back${reason ? " (" + reason + ")" : ""}.`;
  return true;
}

const BOT_STYLE = { Kingpin: "hooker", Lucky: "speedster", "Spare Parts": "steady", "Alley Cat": "hooker", "Ten Pin": "steady", "Gutter Gus": "speedster", Lefty: "hooker", "Big Mo": "speedster" };
function addBotTo(room) {
  if (room.players.length >= MAX_PLAYERS) return null;
  const used = new Set(room.players.map((q) => q.name));
  const name = B.NAMES.find((n) => !used.has(n)) || "Bot " + (room.players.length + 1);
  const bots = room.players.filter((q) => q.bot).length;
  const p = newPlayer("bot_" + newId(), name, "\u{1F916}");
  p.bot = true; p.skill = B.SKILL_CYCLE[bots % B.SKILL_CYCLE.length]; p.lefty = name === "Lefty"; p.seatKey = null;
  p.style = BOT_STYLE[name] || B.STYLE_NAMES[bots % B.STYLE_NAMES.length]; p.form = 0;
  p.gear = botGearFor(room);
  room.players.push(p);
  return p;
}

/* A player leaves for good. In the lobby the seat goes; in a game the seat stays, marked left: its frames stop and its
   total is final and cannot win. */
function leaveRoom(room, p) {
  if (room.status === "lobby") {
    room.players = room.players.filter((q) => q !== p);
    if (room.voice) room.voice.clear();
    if (!humansLeft(room)) return deleteRoom(room.code);
    if (room.host === p.id) ensureHost(room);
    room.log = `${p.name} left.`;
    resuggest(room);
    return bump(room);
  }
  const seat = room.players.indexOf(p);
  p.left = true; p.connected = false;
  if (room.voice) room.voice.delete(seat);
  room.log = `${p.name} left.`;
  ensureHost(room);
  if (!humansLeft(room)) return deleteRoom(room.code);
  if (room.status === "playing" || room.status === "rolloff") {
    const act = active(room);
    if (act.length === 1) {
      if (room.pending) room.pending = null;
      gameOver(room, act);
      room.log = `${room.players[act[0]].name} wins. Everyone else left.`;
    } else if (room.turn === seat && !room.pending) {
      const at = Math.max(Date.now(), room.readyAt || 0);
      if (room.status === "rolloff") nextRolloffBowler(room, at); else endTurn(room, at);
    }
  }
  commit(room);
}

/* ---------- sockets ---------- */

function attach(socket, code) {
  if (socket.data.roomCode && socket.data.roomCode !== code) socketGone(socket);   // GN-20: one room per socket
  socket.data.roomCode = code;
  socket.join(code);
  if (!roomSockets.has(code)) roomSockets.set(code, new Set());
  roomSockets.get(code).add(socket);
}
function detach(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  socket.leave(code);
  const set = roomSockets.get(code);
  if (set) { set.delete(socket); if (!set.size) roomSockets.delete(code); }
  socket.data.roomCode = null;
}
/* A socket went away without a leave (an app killed, a phone off the network, or the socket moved to another room). */
function socketGone(socket) {
  const code = socket.data.roomCode, room = code && rooms.get(code);
  const pid = socket.data.playerId;
  detach(socket);
  if (!room) return;
  const p = room.players.find((q) => q.id === pid);
  if (!p || p.left) return;
  const stillHere = [...(roomSockets.get(code) || [])].some((s) => s.data.playerId === pid);
  if (stillHere) return;                                  // the same player on a newer socket
  p.connected = false;
  if (room.voice) room.voice.delete(room.players.indexOf(p));
  ensureHost(room);
  if ((room.status === "playing" || room.status === "rolloff") && room.players[room.turn] === p && !room.pending) commit(room);   // the 6 s clock
  else bump(room);
}
function refuse(socket, code, msg, to) { socket.emit("err", msg); socket.emit("refused", { code, msg, to }); }
/* A small budget per socket for the actions that re-send the state (lobby toggles, bots): 20 a second. */
function allow(socket, key, perSec) {
  const now = Date.now(), b = (socket.data.budget = socket.data.budget || {});
  const w = b[key] && now - b[key].t < 1000 ? b[key] : (b[key] = { t: now, n: 0 });
  return ++w.n <= perSec;
}

Quick.init({ game: 'bowling', model: 'glicko', seats: 2, codeKey: 'roomCode', app, io, rooms, base: BASE, broadcast: sendState,
  /* Quick and ranked play match within gear-score bands (gear.js BAND): an open room takes a player whose gear score is within it of the host's. Nothing on screen says so. */
  accept: (room, payload) => { const host = room.players.find((p) => p.id === room.host); return Gear.bandOk(Gear.scoreFor(host && host.gear, "bowling"), Gear.scoreFor(Gear.clean("bowling", payload.gear), "bowling")); } });
io.on("connection", (socket) => {
  Plus.guardSocket(socket);   // the wallet's signed entitlement: every event's `plus` is the checked answer (the Nest Wallet repo, contrib/ROLLOUT.md)
  Quick.hook(socket); Quick.connection(socket);   // before the server's own events
  const on = (ev, fn) => socket.on(ev, guard(ev, fn));   // every handler guarded
  const currentRoom = () => rooms.get(socket.data.roomCode);
  const me = () => { const r = currentRoom(); return r ? r.players.find((p) => p.id === socket.data.playerId) : null; };
  const obj = (x) => (x && typeof x === "object" ? x : {});
  Reactions.wire({ on: (ev, fn) => on(ev, (payload) => fn(obj(payload))), room: currentRoom, me: () => socket.data.playerId,
    isHost: (r) => r.host === socket.data.playerId, bump });

  on("create", (a) => {
    const { name, playerId, avatar, plus, crew } = obj(a);
    const nm = cleanName(name);
    if (!nm) return refuse(socket, "name", "Pick a name first.", "create");
    let code = genCode(), guard = 0;
    while (rooms.has(code) && guard++ < 20) code = genCode();
    code = Plus.crewCode({ plus, crew }, rooms, () => code);   // GameNest Plus's crew code (2026-10-17)
    const id = cleanId(playerId) || newId();
    const room = newRoom(code, id);
    const p = Plus.stamp(newPlayer(id, nm, cleanAvatar(avatar) || AVATARS[0]), a);
    p.gear = Gear.clean("bowling", a.gear);
    room.players.push(p);
    rooms.set(code, room);
    socket.data.playerId = id;
    attach(socket, code);
    socket.emit("joined", { code, playerId: id, seatKey: p.seatKey });
    bump(room);
  });

  on("join", (a) => {
    const { code: c0, name, playerId, avatar, seatKey } = obj(a);
    const code = String(c0 || "").trim().toUpperCase().slice(0, 12);
    const room = rooms.get(code);
    if (!room) return refuse(socket, "not_found", "No room with that code.", "join");
    const pid = cleanId(playerId);
    let p = pid ? room.players.find((q) => q.id === pid && !q.bot) : null;
    if (p) {
      if (REQUIRE_SEAT_KEY && p.seatKey && seatKey !== p.seatKey) return refuse(socket, "seat_key", "That seat belongs to someone else.", "join");
      if (p.left) return refuse(socket, "left", "You left that game.", "join");
      p.connected = true;
      const nm = cleanName(name); if (nm) p.name = nm;
      const av = cleanAvatar(avatar); if (av) p.avatar = av;
      Plus.stamp(p, a);
      if (a.gear !== undefined && room.status === "lobby") p.gear = Gear.clean("bowling", a.gear);   // gear changes between games, never in one
      humanIsBack(room, p, "reconnected");
      socket.data.playerId = p.id;
      attach(socket, code);
      socket.emit("joined", { code, playerId: p.id, seatKey: p.seatKey });
      ensureHost(room);
      if ((room.status === "playing" || room.status === "rolloff") && room.players[room.turn] === p && !room.pending) commit(room);
      else bump(room);
      // R5b: a socket that arrives while a ball is playing gets that delivery once, and joins it at serverNow - at
      if (room.delivery && Date.now() < room.delivery.endsAt) socket.emit("delivery", room.delivery.ev);
      return;
    }
    if (room.status !== "lobby") return refuse(socket, "started", "That game already started.", "join");
    if (room.players.length >= MAX_PLAYERS) return refuse(socket, "full", `Room is full (${MAX_PLAYERS}).`, "join");
    const nm = cleanName(name);
    if (!nm) return refuse(socket, "name", "Pick a name first.", "join");
    const id = pid && !room.players.some((q) => q.id === pid) ? pid : newId();
    p = Plus.stamp(newPlayer(id, nm, cleanAvatar(avatar) || AVATARS[room.players.length % AVATARS.length]), a);
    p.gear = Gear.clean("bowling", a.gear);
    room.players.push(p);
    room.log = `${nm} joined.`;
    resuggest(room);
    socket.data.playerId = id;
    attach(socket, code);
    socket.emit("joined", { code, playerId: id, seatKey: p.seatKey });
    bump(room);
  });

  on("settings", (a) => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId || !allow(socket, "lobby", 20)) return;
    const { frames, rolloff, gear } = obj(a);
    let changed = false;
    if (FRAME_CHOICES.includes(frames)) { room.frames = frames; room.framesTouched = true; changed = true; }
    if (typeof rolloff === "boolean") { room.rolloffOn = rolloff; changed = true; }
    if (typeof gear === "boolean" && !room.quick && gear !== (room.gearOn !== false)) { room.gearOn = gear; room.log = gear ? "Gear is on." : "Gear is off: everyone bowls at the base."; bump(room); return; }
    if (!changed) return;
    room.log = `${room.frames} frames${room.rolloffOn ? ", roll-off on ties" : ""}.`;
    bump(room);
  });

  /* A player's gear changed while they sat in the lobby (they upgraded or bought something on the gear page): { bball: { item, level }, shoes, wrist }. Clamped as on join. */
  on("gear", (a) => {
    const room = currentRoom(), p = me();
    if (!room || !p || room.status !== "lobby" || !allow(socket, "lobby", 20)) return;
    p.gear = Gear.clean("bowling", obj(a));
    room.log = `${p.name} changed their gear.`;
    bump(room);
  });

  /* Each bowler's own options: bumpers, left-handed, a house ball pattern. In the lobby, or at the result screen for
     the rematch. */
  on("options", (a) => {
    const room = currentRoom(), p = me();
    if (!room || !p || (room.status !== "lobby" && room.status !== "over") || !allow(socket, "lobby", 20)) return;
    const { bumpers, lefty, ball } = obj(a);
    let changed = false;
    if (typeof bumpers === "boolean" && bumpers !== p.bumpers) { p.bumpers = bumpers; changed = true; }
    if (typeof lefty === "boolean" && lefty !== p.lefty) { p.lefty = lefty; changed = true; }
    if (typeof ball === "string" && PATTERNS.includes(ball) && ball !== p.ball) { p.ball = ball; changed = true; }
    if (changed) bump(room);
  });

  on("addBot", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId || !allow(socket, "lobby", 20)) return;
    const b = addBotTo(room);
    if (!b) return refuse(socket, "full", `Room is full (${MAX_PLAYERS}).`, "addBot");
    room.log = `${b.name} (bot) joined.`;
    resuggest(room);
    bump(room);
  });

  on("removeBot", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId || !allow(socket, "lobby", 20)) return;
    for (let i = room.players.length - 1; i >= 0; i--) {
      if (room.players[i].bot) { room.log = `${room.players[i].name} left.`; room.players.splice(i, 1); resuggest(room); return bump(room); }
    }
  });

  on("start", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    if (active(room).length < MIN_PLAYERS) return refuse(socket, "seats", "Add a bot or invite a friend.", "start");
    startGame(room);
    commit(room);
  });

  /* A ball: the release as four integers (x 0.1 mm, angle 0.001 degree, speed mm/s, spin 0.001) and n = throwSeq + 1.
     Out of turn, too early, a repeat, or while a ball is in flight: ignored. Not finite: "Bad throw.". */
  on("throw", (a) => {
    const room = currentRoom(), p = me();
    if (!room || !p || (room.status !== "playing" && room.status !== "rolloff") || room.pending) return;
    const seat = room.players.indexOf(p);
    if (seat !== room.turn || p.left) return;
    if (Date.now() < (room.readyAt || 0) - EARLY_MS) return;
    const t = obj(a);
    if (!Number.isInteger(t.n) || t.n !== room.throwSeq + 1) return;
    /* Gear (step 4): the seat's cap on the release's speed (the ball's Power), and its wobble (the shoes' Steadiness) when the room holds gear for it; a seat with none, or a room with gear off, throws exactly as sent. */
    const fx = gearFx(room, p), held = gearHeld(room, p) && !p.botControlled;
    const release = L.wireRelease(t, held ? fx.speedMax : 0);
    if (!release) return refuse(socket, "bad_throw", "Bad throw.", "throw");
    humanIsBack(room, p, "took the ball");
    bowl(room, seat, { kind: "human", release: held ? Gear.wobbleRelease(release, fx.steady, fx.speedMax) : release, speedMax: held ? fx.speedMax : 0 }, "");
  });

  /* The clock (R5f): the phone keeps the minimum-RTT sample of 4 at join and one every 10 s. At most 4 a second. */
  on("ping", (a) => {
    const c = obj(a).c;
    if (typeof c !== "number" || !Number.isFinite(c) || !allow(socket, "ping", 4)) return;
    socket.emit("pong", { c, s: Date.now() });
  });

  /* A tap past the crash (bowling r1, 2026-11-02): the ball has hit and been seen, so whoever bowled it, or is next, cuts the beats
     after it. Never before the first contact plus a short crash and the machine's quarter second; once a ball; up to 4 a second. */
  on("skip", (a) => {
    const room = currentRoom(), p = me();
    if (!room || !p || (room.status !== "playing" && room.status !== "rolloff") || room.pending || !room.lastBeats || !allow(socket, "skip", 4)) return;
    const B = room.lastBeats, seat = room.players.indexOf(p);
    if (!Number.isInteger(obj(a).n) || obj(a).n !== B.n || B.skipped || (seat !== B.seat && seat !== room.turn)) return;
    const now = Date.now();
    const to = Math.max(now + 100, B.at + Math.round(B.hitMs / B.rate) + SKIP_AFTER_HIT_MS + SKIP_RESET_MS);
    if (to >= (room.readyAt || 0)) return;
    B.skipped = true;
    room.readyAt = to;
    commit(room);
  });

  on("rematch", () => {
    const room = currentRoom();
    if (!room || room.status !== "over" || room.host !== socket.data.playerId) return;
    const stay = room.players.filter((p) => !p.left);
    if (stay.length < MIN_PLAYERS) return refuse(socket, "seats", "Add a bot or invite a friend.", "rematch");
    room.players = stay;
    if (room.voice) room.voice.clear();
    startGame(room);
    room.log = `Rematch! ${room.log}`;
    commit(room);
  });

  on("takeSeat", () => {
    const room = currentRoom(), p = me();
    if (!room || !p || !humanIsBack(room, p, "took the seat back")) return;
    if ((room.status === "playing" || room.status === "rolloff") && room.players[room.turn] === p && !room.pending) commit(room);
    else bump(room);
  });

  on("leave", () => {
    const room = currentRoom(), p = me();
    detach(socket);
    if (room && p && !p.left) leaveRoom(room, p);
  });

  on("pushToken", (a) => {
    const p = me(), { token } = obj(a);
    if (p && typeof token === "string" && /^[0-9a-f]{32,200}$/i.test(token)) p.pushToken = token;
  });

  on("presence", (a) => { const p = me(); if (p) p.away = !!obj(a).away; });

  on("chat", (a) => {
    const room = currentRoom(), p = me();
    if (!room || !p) return;
    const now = Date.now();
    if (now - (socket.data.lastChat || 0) < CHAT_COOLDOWN_MS) return;
    const { text, sticker } = obj(a);
    let msg;
    if (sticker) { if (!STICKERS.includes(sticker)) return; msg = { k: "s", s: sticker }; }
    else { const x = cleanChat(text); if (!x) return; msg = { k: "t", x }; }
    socket.data.lastChat = now;
    const finish = () => {
      const room = rooms.get(code), p = room && room.players.find((q) => q.id === pid);   // gone while it was read
      if (!p) return;
      msg.n = p.name; msg.c = colorOf(room.players.indexOf(p)); msg.a = p.avatar; msg.t = now;
      room.chat.push(msg);
      if (room.chat.length > CHAT_KEEP) room.chat.shift();
      if (msg.k === "t") for (const q of room.players) if (q !== p) pushTo(q, p.name + ": " + msg.x, { code: room.code, game: PUSH_TITLE }, room.code + "-chat");
      bump(room);
    };
    const code = room.code, pid = p.id;
    if (msg.k === "t") Moderation.chat(msg.x).then((shown) => { msg.x = shown; finish(); }); else finish();
  });

  /* Voice is peer to peer; the server only carries the handshake, never audio. The 20k ceiling stops a signal being
     used as a data channel. */
  on("voice", (a) => {
    const room = currentRoom();
    if (!room) return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    if (seat < 0) return;
    const { kind, to, data } = obj(a);
    if (kind === "join" || kind === "leave") {
      if (!room.voice) room.voice = new Set();
      if (kind === "join") room.voice.add(seat); else room.voice.delete(seat);
      return bump(room);
    }
    if (kind === "signal" && Number.isInteger(to) && data) {
      let size = 0;
      try { size = JSON.stringify(data).length; } catch (e) { return; }
      if (size > 20000) return;
      for (const s of roomSockets.get(room.code) || []) {
        if (room.players.findIndex((p) => p.id === s.data.playerId) === to) s.emit("voice", { kind: "signal", from: seat, data });
      }
    }
  });

  on("disconnect", () => socketGone(socket));
});

/* ---------- http ---------- */

/* The event loop's lag and utilisation and the process's CPU (the workers included), over 5 s windows. */
const { performance } = require("perf_hooks");
const loopLag = monitorEventLoopDelay({ resolution: 10 });
loopLag.enable();
let lagWindow = { p50: 0, p99: 0, max: 0 }, cpuWindow = { pct: 0, physicsPct: 0, elu: 0 };
let lastCpu = process.cpuUsage(), lastT = performance.now(), lastElu = performance.eventLoopUtilization(), lastPhysics = 0;
setInterval(guard("metrics", () => {
  lagWindow = { p50: +(loopLag.percentile(50) / 1e6).toFixed(1), p99: +(loopLag.percentile(99) / 1e6).toFixed(1), max: +(loopLag.max / 1e6).toFixed(1) };
  loopLag.reset();
  const now = performance.now(), c = process.cpuUsage(lastCpu), e = performance.eventLoopUtilization(lastElu);
  const phys = pool ? pool.physicsCpuMs() : 0;
  cpuWindow = { pct: +(((c.user + c.system) / 1000) / (now - lastT) * 100).toFixed(1), physicsPct: +((phys - lastPhysics) / (now - lastT) * 100).toFixed(1), elu: +e.utilization.toFixed(3) };
  lastCpu = process.cpuUsage(); lastT = now; lastElu = performance.eventLoopUtilization(); lastPhysics = phys;
}), 5000).unref();
/* Health and load numbers (counts only; nothing about players). */
app.get((BASE || "") + "/health", (req, res) => {
  const m = process.memoryUsage();
  let sockets = 0; for (const set of roomSockets.values()) sockets += set.size;
  res.json({
    ok: true, uptimeS: Math.round(process.uptime()), rooms: rooms.size, sockets, connections: io.engine.clientsCount,
    playing: [...rooms.values()].filter((r) => r.status === "playing" || r.status === "rolloff").length,
    deliveries: stats.deliveries, fallbacks: stats.fallbacks, deadBalls: stats.deadBalls, guardErrors, watchdogRearms, emptyRoomsClosed,
    deliveryBytes: { ...stats.bytes.pct([50, 95, 99]), max: stats.maxBytes },
    pool: pool ? pool.stats() : { size: 0 },
    loopLagMs: lagWindow, cpuPct: cpuWindow.pct, physicsCpuPct: cpuWindow.physicsPct, elu: cpuWindow.elu, rssMB: +(m.rss / 1048576).toFixed(1), heapMB: +(m.heapUsed / 1048576).toFixed(1),
    totalRssMB: +(m.rss / 1048576 + (pool ? pool.rssMB() : 0)).toFixed(1),
    timers: { turn: turnTimers.size, bot: botTimers.size, orphans: [...turnTimers.keys(), ...botTimers.keys()].filter((c) => !rooms.has(c)).length },
    statuses: [...rooms.values()].reduce((o, r) => { o[r.status] = (o[r.status] || 0) + 1; return o; }, {}),
  });
});
if (BASE) app.use((req, res, next) => { if (req.path === BASE) return res.redirect(301, BASE + "/"); next(); });
app.use(BASE || "/", express.static(path.join(__dirname, "public")));

let emptyRoomsClosed = 0;
setInterval(guard("sweep", () => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.pending) continue;
    if (now - room.touched > ROOM_IDLE_MS) { deleteRoom(code); continue; }
    const someoneHere = room.players.some((p) => !p.bot && !p.left && p.connected);
    if (someoneHere) { room.emptySince = null; continue; }
    if (!room.emptySince) room.emptySince = now;
    else if (now - room.emptySince >= EMPTY_ROOM_MS) { deleteRoom(code); emptyRoomsClosed++; }
  }
}), SWEEP_MS).unref();
/* The watchdog: a room in play always has a ball in flight or a clock running. If a bug ever left one with neither (or
   a ball in flight for 30 s, past the pool's own 15 s limit and the main-thread retry), it is set going again. */
let watchdogRearms = 0;
setInterval(guard("watchdog", () => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.status !== "playing" && room.status !== "rolloff") continue;
    if (room.pending && now - room.pending.at > 30000) { room.pending = null; watchdogRearms++; commit(room); continue; }
    if (!room.pending && !turnTimers.has(room.code)) { watchdogRearms++; commit(room); }
  }
}), 5000).unref();

/* Boot: the aim table once (about 1.5 s, shared with the workers), Rapier in this thread for the fallback, the pool. */
async function boot() {
  const t0 = Date.now();
  const table = B.table();
  if (POOL_SIZE > 0) {
    pool = new Pool({ size: POOL_SIZE, table }); await pool.ready();
    /* Warm (bowling r1, "physics preloaded"): one ball through every physics process before the first game, so a first throw never pays for
       a cold JIT (the phone's splash and VS screen hide this at boot, not in a game). */
    await Promise.all(Array.from({ length: POOL_SIZE }, (_, i) => pool.run({ kind: "human", release: { x: 0.05, angle: 0.5, speed: 7.4, spin: 0.4 }, standing: L.spots().map((q) => ({ n: q.n, x: q.x, y: q.y, yaw: q.yaw, fresh: true })), seed: 1000 + i, bumpers: false, hand: 1 }, "ball").catch(() => {})));
  }
  else await L.init();                                   // POOL_SIZE=0: the physics on the event loop (a diagnostic)
  server.listen(PORT, () => console.log(`Bowling Rooms running on port ${PORT}${BASE ? " under " + BASE : ""} (pool ${POOL_SIZE}${pool ? " " + pool.mode + "es" : ""}, ready in ${Date.now() - t0} ms)`));
}
if (require.main === module) boot().catch((e) => { console.error(e); process.exit(1); });
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { if (pool) pool.close(); process.exit(0); });

module.exports = { app, server, io, boot, rooms, publicRoom, _tools: { newRoom, newPlayer, addBotTo, startGame, gearView, gearFx, gearHeld, botGearFor } };
