/* The load test (WORLD.md 3.10, 9.1): R rooms of 8 bowlers on one process with the physics pool. Each room has a host
   socket (and optionally more human sockets) that bowls its own balls at readyAt and rematches when a game ends; the
   other seats are the server's bots. It reports, and judges against the design:
     - every delivery within 250 ms of the throw at p99 (the time from `at` to the phone's receipt, same clock)
     - the event loop's lag p99 under 20 ms (the physics never runs on the loop)
     - memory flat (the heap at the end within 25% of the heap after the first quarter)
     - bytes per delivery (the most under 48 KB)
   It starts its own server on --port (3283 by default; never 3111-3120) unless --url is given.

   node test/load.js --rooms 200 --minutes 5                        production clocks (a delivery every 6-9 s a room)
   node test/load.js --rooms 200 --minutes 2 --pace fast            every clock at zero: as fast as the pool allows
   node test/load.js --rooms 200 --minutes 30 --json soak.json      the 30-minute soak
   --humans H (1-8) seats H human sockets a room; --pool N sets POOL_SIZE (0: physics on the event loop, the "before") */
"use strict";
const fs = require("fs");
const H = require("./helpers");

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; };
const ROOMS = Number(arg("rooms", 200)), HUMANS = Math.max(1, Math.min(8, Number(arg("humans", 1)))), MINUTES = Number(arg("minutes", 5));
const PACE = arg("pace", "production"), PORT = Number(arg("port", 3283)), JSON_OUT = arg("json", null), POOL = arg("pool", null), URL0 = arg("url", null);
const SAMPLE_MS = 5000;
const pct = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(1); };

(async () => {
  const env = PACE === "fast" ? {} : { BOT_MS: "", TURN_MS: "", RESULT_MS: "", RESET_MS: "", HANDOFF_MS: "", COSMIC_MS: "", ROLLOFF_MS: "", ARRIVAL_MS: "", PLAY_MS_SCALE: "1" };
  if (POOL !== null) env.POOL_SIZE = POOL; else env.POOL_SIZE = "";
  const srv = URL0 ? { url: URL0, stop: async () => {}, health: async () => (await fetch(URL0 + "/health")).json() } : await H.startServer(env, PORT);
  const t0 = Date.now();
  const lat = [], bytes = [], errs = {}, health = [];
  let deliveries = 0, gamesOver = 0, disconnects = 0, throws = 0, connectFails = 0;
  const all = [];
  let running = true;

  function human(room, idx) {
    const s = H.client(srv.url, (idx ? "P" : "Host") + idx + "_" + room.n);
    s.on("err", (e) => { errs[e] = (errs[e] || 0) + 1; });
    s.on("disconnect", () => { if (running) disconnects++; });
    s.on("connect_error", () => { connectFails++; });
    let lastN = -1, timer = null;
    const tick = () => {
      if (!running || !s.st) return;
      const r = s.st;
      if (idx === 0 && r.status === "lobby" && r.players.length < 8 && room.humansIn >= HUMANS) { s.emit("addBot"); return; }
      if (idx === 0 && r.status === "lobby" && r.players.length === 8 && !room.started) { room.started = true; s.emit("start"); return; }
      if (idx === 0 && r.status === "over" && !room.rematching) { room.rematching = true; gamesOver++; setTimeout(() => { room.rematching = false; if (running) s.emit("rematch"); }, 1500); return; }
      if ((r.status === "playing" || r.status === "rolloff") && r.turn === s.seat && !r.pending && r.throwSeq + 1 !== lastN) {
        const n = r.throwSeq + 1;
        const wait = Math.max(0, (r.readyAt || 0) - r.now - 50);
        lastN = n;
        clearTimeout(timer);
        timer = setTimeout(() => { if (running && s.connected) { throws++; s.emit("throw", { n, x: 600 + Math.round((Math.random() - 0.5) * 400), angle: 2125 + Math.round((Math.random() - 0.5) * 600), speed: 7400 + Math.round((Math.random() - 0.5) * 800), spin: Math.random() < 0.7 ? 1000 : 0 }); } }, wait);
      }
    };
    s.on("state", tick);
    if (idx === 0) s.on("delivery", (d) => { deliveries++; lat.push(Date.now() - d.at); bytes.push(Buffer.byteLength(JSON.stringify(d))); });
    all.push(s);
    return s;
  }
  // ramp the rooms in
  const rooms = [];
  for (let n = 0; n < ROOMS; n++) {
    const room = { n, humansIn: 1, started: false, rematching: false };
    rooms.push(room);
    const host = human(room, 0);
    host.once("connect", () => host.emit("create", { name: "Host" + n, playerId: host.playerId }));
    host.once("joined", (j) => {
      for (let i = 1; i < HUMANS; i++) {
        const g = human(room, i);
        g.once("connect", () => g.emit("join", { code: j.code, name: "P" + i, playerId: g.playerId }));
        g.once("joined", () => { room.humansIn++; });
      }
    });
    await H.sleep(10);
  }
  const rampMs = Date.now() - t0;
  // sample the server
  const iv = setInterval(async () => { try { const h = await srv.health(); h.t = Date.now() - t0; health.push(h); } catch (_) {} }, SAMPLE_MS);
  await H.sleep(MINUTES * 60000);
  running = false; clearInterval(iv);
  const hEnd = await srv.health();
  all.forEach((s) => s.close());
  await H.sleep(1500);
  const hAfter = await srv.health();
  await srv.stop();

  const win = health.filter((h) => h.t > rampMs + 10000);               // after the ramp settles
  const lagP99 = win.map((h) => h.loopLagMs.p99), cpu = win.map((h) => h.cpuPct), heap = win.map((h) => h.heapMB), rss = win.map((h) => h.totalRssMB || h.rssMB);
  const poolRss = win.map((h) => (h.pool && h.pool.rssMB) || 0), mainRss = win.map((h) => h.rssMB), phys = win.map((h) => h.physicsCpuPct || 0);
  const q = Math.max(1, Math.floor(win.length / 4));
  const heapQ = heap.slice(0, q).reduce((a, b) => a + b, 0) / q, heapEnd = heap.slice(-q).reduce((a, b) => a + b, 0) / q;
  const secs = (Date.now() - t0 - rampMs) / 1000;
  const out = {
    rooms: ROOMS, humansPerRoom: HUMANS, seats: 8, pace: PACE, minutes: MINUTES, pool: hEnd.pool.size, rampMs,
    deliveries, deliveriesPerSec: +(deliveries / secs).toFixed(1), throws, gamesOver,
    deliveryMs: { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: lat.length ? Math.max(...lat) : null },
    loopLagP99Ms: { median: pct(lagP99, 50), worst: lagP99.length ? Math.max(...lagP99) : null },
    cpuPct: { avg: cpu.length ? +(cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(1) : null, peak: cpu.length ? Math.max(...cpu) : null,
      physicsAvg: phys.length ? +(phys.reduce((a, b) => a + b, 0) / phys.length).toFixed(1) : null, physicsPeak: phys.length ? Math.max(...phys) : null },
    heapMB: { firstQuarter: +heapQ.toFixed(1), lastQuarter: +heapEnd.toFixed(1), peak: heap.length ? Math.max(...heap) : null },
    rssMB: { start: rss[0], end: rss[rss.length - 1], peak: rss.length ? Math.max(...rss) : null, mainEnd: mainRss[mainRss.length - 1], physicsEnd: poolRss[poolRss.length - 1] },
    elu: win.length ? +(win.reduce((a, h) => a + (h.elu || 0), 0) / win.length).toFixed(3) : null,
    deliveryBytes: { p50: pct(bytes, 50), p95: pct(bytes, 95), max: bytes.length ? Math.max(...bytes) : null },
    poolEnd: hEnd.pool, fallbacks: hEnd.fallbacks, deadBalls: hEnd.deadBalls,
    errors: errs, disconnects, connectFails,
    after: { rooms: hAfter.rooms, sockets: hAfter.sockets, timers: hAfter.timers, statuses: hAfter.statuses },
    machineLoad: require("os").loadavg().map((x) => +x.toFixed(1)),
  };
  const verdict = {
    deliveryP99Under250ms: out.deliveryMs.p99 !== null && out.deliveryMs.p99 <= 250,
    loopLagP99Under20ms: out.loopLagP99Ms.worst !== null && out.loopLagP99Ms.median <= 20,
    memoryFlat: heapEnd <= heapQ * 1.25 + 5,
    deliveryUnder48KB: out.deliveryBytes.max !== null && out.deliveryBytes.max < 48 * 1024,
    noPhysicsFailures: out.fallbacks === 0 && out.deadBalls === 0,
  };
  out.verdict = verdict;
  console.log(JSON.stringify(out, null, 1));
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ ...out, health }, null, 1));
  const ok = Object.values(verdict).every(Boolean);
  console.log(ok ? "\nload: every target met" : "\nload: TARGET MISSED " + JSON.stringify(verdict));
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
