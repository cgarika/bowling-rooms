/* Shared by the socket suites: start a copy of the server on a test port with short clocks, and small clients. */
"use strict";
const { spawn } = require("child_process");
const path = require("path");
const net = require("net");

const ROOT = path.join(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portFree(port) {
  return new Promise((res) => { const s = net.createServer(); s.once("error", () => res(false)); s.once("listening", () => s.close(() => res(true))); s.listen(port, "127.0.0.1"); });
}
/* The live servers (3111-3118) are never touched: a test port must be free, or the suite stops. */
async function startServer(env = {}, port = Number(process.env.TEST_PORT || 3281)) {
  if (port >= 3111 && port <= 3120) throw new Error("refusing a live port " + port);
  if (process.env.URL) return { url: process.env.URL, stop: async () => {} };
  if (!(await portFree(port))) throw new Error(`port ${port} is busy; set TEST_PORT to a free one`);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), BOT_MS: "5", TURN_MS: "600000", RESULT_MS: "0", RESET_MS: "0", HANDOFF_MS: "0", COSMIC_MS: "0", ROLLOFF_MS: "0", ARRIVAL_MS: "0", PLAY_MS_SCALE: "0", POOL_SIZE: "2", ...env },
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error("server exited:\n" + log);
    try { const r = await fetch(url + "/health"); if (r.ok) break; } catch (_) {}
    if (Date.now() - t0 > 30000) { child.kill(); throw new Error("server did not start:\n" + log); }
    await sleep(100);
  }
  return {
    url, port, child, log: () => log,
    health: async () => (await fetch(url + "/health")).json(),
    stop: () => new Promise((res) => { if (child.exitCode !== null) return res(); child.once("exit", res); child.kill("SIGTERM"); }),
  };
}

function checker() {
  let failures = 0, passes = 0;
  const check = (ok, what, extra) => { if (ok) passes++; else { failures++; console.log("  FAIL: " + what + (extra !== undefined ? "  " + (typeof extra === "string" ? extra : JSON.stringify(extra)) : "")); } return !!ok; };
  const section = (n) => console.log("\n" + n);
  const done = (name) => { console.log(`\n${name}: ${passes} checks passed, ${failures} failed`); return failures; };
  return { check, section, done, get failures() { return failures; } };
}

/* A client that keeps the latest state, every delivery and every refusal. */
function client(url, name, extra = {}) {
  const { io } = require("socket.io-client");
  const s = io(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  s.nm = name; s.st = null; s.seat = -1; s.errors = []; s.refused = []; s.deliveries = []; s.states = 0; s.joined = null; s.pongs = [];
  s.playerId = extra.playerId || ("p" + Math.random().toString(16).slice(2, 14));
  s.on("state", ({ room, mySeat }) => { s.st = room; s.seat = mySeat; s.states++; });
  s.on("joined", (j) => { s.joined = j; });
  s.on("err", (e) => s.errors.push(e));
  s.on("refused", (e) => s.refused.push(e));
  s.on("delivery", (d) => s.deliveries.push(d));
  s.on("pong", (p) => s.pongs.push(p));
  return s;
}
const connected = (s) => new Promise((res) => (s.connected ? res() : s.once("connect", res)));
async function waitFor(s, pred, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (pred(s)) return true; } catch (_) {} await sleep(10); }
  return false;
}
/* A release a human might send, in wire integers: the house line, straight, or at the middle of the leave. */
function release(kind = "house") {
  if (kind === "house") return { x: 600, angle: 2125, speed: 7400, spin: 1000 };
  if (kind === "gutter") return { x: 4000, angle: 3500, speed: 7000, spin: 0 };
  return { x: 0, angle: 0, speed: 7400, spin: 0 };
}
/* Bowl for this socket when it is its turn (n = throwSeq + 1), and wait for that ball's delivery. */
async function bowlWhenMine(s, rel = release(), ms = 20000) {
  const ok = await waitFor(s, (x) => x.st && (x.st.status === "playing" || x.st.status === "rolloff") && x.st.turn === x.seat && !x.st.pending && Date.now() >= (x.st.readyAt || 0) - 100, ms);
  if (!ok) return null;
  const n = s.st.throwSeq + 1, before = s.deliveries.length;
  s.emit("throw", { n, ...rel });
  /* That ball's own delivery, wherever it is in the list by now (2026-11-13). This used to ask whether the NEWEST delivery was ball n, looking every 10 ms. After a
     strike the frame is the bot's, and under the tests' clocks (BOT_MS 5) the bot's ball can be back before the next look: then the newest delivery was never
     n again, and this waited its 20 s out and said null (swipe failed 2 runs in 20 that way on a busy Mac, at "a second ball was bowled in both rooms"). */
  const mine = (x) => x.deliveries.slice(before).find((d) => d.n === n);
  const got = await waitFor(s, (x) => mine(x) && x.st.throwSeq >= n, ms);
  return got ? mine(s) : null;
}

/* Bowl for a socket whenever it is its turn, with rel(state) as the release, until the returned stop() is called. */
function autoBowl(s, rel = () => release("house")) {
  let lastN = -1, on = true;
  const tick = () => {
    if (!on || !s.st || !s.connected) return;
    const r = s.st;
    if ((r.status === "playing" || r.status === "rolloff") && r.turn === s.seat && !r.pending && r.throwSeq + 1 !== lastN && Date.now() >= (r.readyAt || 0) - 100) {
      lastN = r.throwSeq + 1; s.emit("throw", { n: lastN, ...rel(r) });
    }
  };
  s.on("state", tick);
  const iv = setInterval(tick, 50);
  return () => { on = false; clearInterval(iv); };
}
/* Every log line a socket's states carried. */
function logs(s) { const out = []; s.on("state", ({ room }) => { if (out[out.length - 1] !== room.log) out.push(room.log); }); return out; }

module.exports = { autoBowl, logs, startServer, checker, client, connected, waitFor, sleep, release, bowlWhenMine, portFree, ROOT };
