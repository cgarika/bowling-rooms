/* Bowling pacing probe (2026-10-28): real clocks, one human who bowls the house line as soon as it may, the rest bots.
   Prints the seconds between the human's turns (the room's readyAt when the turn leaves the human to the readyAt when it
   comes back), the bots' think (their delivery's start after their turn became ready) and the bots' frame totals.
   usage: node tools/pace_probe.js <server root> <players 2|4> [frames]   (private port PROBE_PORT, default 5271) */
"use strict";
const path = require("path");
const root = path.resolve(process.argv[2] || ".");
const seats = Number(process.argv[3] || 2), frames = Number(process.argv[4] || 4);
const port = Number(process.env.PROBE_PORT || 5271);
const H = require(path.join(__dirname, "..", "test", "helpers"));
(async () => {
  const child = require("child_process").spawn(process.execPath, ["server.js"], { cwd: root, env: { ...process.env, PORT: String(port), TURN_MS: "600000", POOL_SIZE: "2" }, stdio: "ignore" });
  const url = "http://127.0.0.1:" + port;
  for (let i = 0; i < 150; i++) { try { if ((await fetch(url + "/health")).ok) break; } catch (_) {} await H.sleep(100); }
  try {
    const a = H.client(url, "Probe"); await H.connected(a);
    a.emit("create", { name: "Probe", playerId: a.playerId }); await H.waitFor(a, (s) => s.st);
    for (let i = 1; i < seats; i++) { a.emit("addBot"); await H.waitFor(a, (s) => s.st.players.length > i); }
    a.emit("settings", { frames }); await H.sleep(200);
    a.emit("start"); await H.waitFor(a, (s) => s.st.status === "playing");
    const gaps = []; let leftAt = null, lastTurn = a.seat; const thinks = []; let readyOfBot = null, speeds = new Set(), styles = new Set();
    const beats = []; let lastD = null;
    a.on("delivery", (d) => { if (d.seat !== a.seat) { speeds.add(d.speed || 1); if (readyOfBot) thinks.push((d.at - readyOfBot) / 1000); lastD = d; } });
    a.on("state", ({ room }) => { if (lastD && room.lastThrow && room.lastThrow.id === lastD.id) { beats.push({ call: lastD.call, count: lastD.count, playMs: lastD.playMs, hit: (lastD.ev.find((e) => e[1] === 1) || [0])[0], afterBall_s: +((room.readyAt - lastD.at) / 1000).toFixed(2) }); lastD = null; } });
    a.on("state", ({ room }) => {
      if (room.status !== "playing") return;
      if (room.turn !== a.seat) { if (leftAt === null && lastTurn === a.seat) leftAt = room.readyAt; readyOfBot = room.readyAt; }
      else if (leftAt !== null && !room.pending) { gaps.push((room.readyAt - leftAt) / 1000); leftAt = null; }
      lastTurn = room.turn;
    });
    let lastN = -1; const t0 = Date.now();
    while (a.st.status !== "over" && Date.now() - t0 < 300000) {
      const r = a.st;
      if (r.status === "playing" && r.turn === a.seat && !r.pending && r.throwSeq + 1 !== lastN && Date.now() >= (r.readyAt || 0) - 50) { lastN = r.throwSeq + 1; a.emit("throw", { n: lastN, x: 600, angle: 2125, speed: 7400, spin: 1000 }); }
      await H.sleep(40);
    }
    const q = (v, p) => { const b = [...v].sort((x, y) => x - y); return b.length ? +b[Math.min(b.length - 1, Math.floor(p * b.length))].toFixed(2) : null; };
    const totals = a.st.players.map((p, i) => ({ name: p.name, bot: p.bot, skill: p.skill, style: p.style, total: (a.st.cards && a.st.cards[i] && a.st.cards[i].total) }));
    console.log(JSON.stringify({ root: path.basename(root), seats, frames, humanGaps: gaps.length, between_p50: q(gaps, .5), between_p95: q(gaps, .95), between_max: q(gaps, 1), botThink_p50: q(thinks, .5), botThink_p95: q(thinks, .95), botSpeeds: [...speeds], status: a.st.status, botBalls: beats.slice(0, 8), players: totals }));
    a.close();
  } finally { child.kill("SIGTERM"); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
