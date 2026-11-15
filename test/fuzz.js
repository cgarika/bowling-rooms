/* Fuzz (WORLD.md 9.1): random events and payloads from many sockets in live rooms (wrong types, huge numbers, missing
   fields, out-of-turn throws, stale and future n, finite but absurd releases, malformed pings, oversized names and
   voice) never crash the server and never change a card illegally: every ball is 0 to 10, frames never exceed ten
   pins, and every sheet equals score.card of its balls.

   node test/fuzz.js          20,000 events        EVENTS=50000 node test/fuzz.js   as the design asks */
"use strict";
const S = require("../score");
const H = require("./helpers");
const { check, section, done } = H.checker();
const { client, connected, waitFor, sleep } = H;

const EVENTS = Number(process.env.EVENTS || 20000);
function lcg(seed) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }
const rnd = lcg(424242);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const NAMES = ["create", "join", "leave", "addBot", "removeBot", "start", "rematch", "takeSeat", "settings", "options", "throw", "ping", "chat", "voice", "presence", "pushToken", "nonsense", "__proto__", "constructor"];
function junk(depth = 0) {
  const k = Math.floor(rnd() * 14);
  switch (k) {
    case 0: return null;
    case 1: return undefined;
    case 2: return pick([0, -1, 1, 2 ** 31, -(2 ** 53), 1e308, -1e308, 5e-324, 0.5, 3.7, Number.MAX_SAFE_INTEGER]);
    case 3: return pick(["", "x", "A".repeat(5000), "\u{1F600}".repeat(40), "\u0000\u0007<script>", "-1", "1e9", "NaN", "Infinity", "ZZZZZZ"]);
    case 4: return rnd() < 0.5;
    case 5: return depth < 3 ? Array.from({ length: Math.floor(rnd() * 4) }, () => junk(depth + 1)) : [];
    case 6: return depth < 3 ? { x: junk(depth + 1), n: junk(depth + 1), c: junk(depth + 1) } : {};
    case 7: return { __proto__: { polluted: 1 }, constructor: { prototype: { bad: 1 } } };
    default: return depth < 3 ? Object.fromEntries(["n", "x", "angle", "speed", "spin", "frames", "rolloff", "bumpers", "lefty", "ball", "code", "name", "playerId", "text", "sticker", "kind", "to", "data", "c", "away", "token", "seatKey"].filter(() => rnd() < 0.3).map((f) => [f, junk(depth + 1)])) : {};
  }
}

(async () => {
  const srv = await H.startServer({});
  const URL = srv.url;
  try {
    section(`${EVENTS} random events from 12 sockets in 4 rooms, with honest bowlers among them`);
    const rooms = [];
    for (let r = 0; r < 4; r++) {
      const host = client(URL, "Host" + r); await connected(host);
      host.emit("create", { name: "Host" + r, playerId: host.playerId }); await waitFor(host, (x) => x.st);
      const guests = [];
      for (let g = 0; g < 2; g++) { const s = client(URL, "G" + r + g); await connected(s); s.emit("join", { code: host.st.code, name: "G" + r + g, playerId: s.playerId }); guests.push(s); }
      await waitFor(host, (x) => x.st.players.length === 3);
      host.emit("addBot"); host.emit("settings", { frames: 3 }); host.emit("start");
      rooms.push({ host, guests, code: host.st.code, stop: [H.autoBowl(host), H.autoBowl(guests[0])] });
    }
    const sockets = rooms.flatMap((r) => [r.host, ...r.guests]);
    await sleep(200);
    let sent = 0;
    for (let i = 0; i < EVENTS; i++) {
      const s = pick(sockets), name = pick(NAMES);
      let payload = junk();
      if (name === "throw" && rnd() < 0.5 && s.st) payload = { n: s.st.throwSeq + pick([-1, 0, 1, 1, 1, 2, 1000]), x: pick([0, 1e9, -1e9, 1e308, 3.3, "7"]), angle: pick([0, 1e9, -5000, NaN]), speed: pick([0, 7400, 1e12, -1]), spin: pick([0, 1e6, -1e6, null]) };
      if (name === "join" && rnd() < 0.3) payload = { code: pick(rooms).code, name: "J" + i, playerId: pick([s.playerId, "x" + i, "A".repeat(100)]) };
      if (name === "leave" || name === "create" || name === "join") { if (rnd() < 0.8) continue; }        // keep the rooms mostly intact
      if (name === "voice" && rnd() < 0.1) payload = { kind: "signal", to: 1, data: { big: "x".repeat(25000) } };
      s.emit(name, payload); sent++;
      if (i % 400 === 0) await sleep(20);
    }
    await sleep(1500);
    console.log(`  ${sent} events sent`);
    const h = await srv.health();
    check(h.ok, "the server is alive", h);
    check(h.deadBalls === 0 && h.fallbacks === 0, "no physics failed", [h.deadBalls, h.fallbacks]);

    section("the cards are legal");
    let sheets = 0, bad = [];
    for (const r of rooms) {
      const st = r.host.st || (r.guests.find((g) => g.st) || {}).st;
      if (!st) continue;
      st.sheets.forEach((sh, seat) => {
        sheets++;
        if (!sh.balls.every((b) => Number.isInteger(b) && b >= 0 && b <= 10)) bad.push(`${st.code} seat ${seat}: a ball outside 0-10`);
        const c = S.card(sh.balls, st.frames);
        if (JSON.stringify(c.frames.map((f) => [f.marks, f.cum])) !== JSON.stringify(sh.frames.map((f) => [f.marks, f.cum])) || c.total !== sh.total) bad.push(`${st.code} seat ${seat}: the card differs from score.card`);
        c.frames.slice(0, st.frames - 1).forEach((f, k) => { if (f.balls.length === 2 && f.balls[0] + f.balls[1] > 10) bad.push(`${st.code} seat ${seat} frame ${k + 1}: more than ten pins`); });
      });
    }
    check(sheets > 0 && bad.length === 0, `${sheets} sheets legal`, bad.slice(0, 5));

    section("the server still plays a clean game afterwards");
    rooms.forEach((r) => r.stop.forEach((f) => f()));
    sockets.forEach((s) => s.close());
    const a = client(URL, "After"); await connected(a);
    a.emit("create", { name: "After", playerId: a.playerId }); await waitFor(a, (x) => x.st);
    a.emit("addBot"); a.emit("settings", { frames: 3 }); a.emit("start");
    const stop = H.autoBowl(a);
    await waitFor(a, (x) => x.st && x.st.status === "over", 30000);
    stop();
    check(a.st.status === "over", "a fresh room plays to the end");
    a.close();
    await sleep(300);
    const h2 = await srv.health();
    check(h2.timers.orphans === 0 && h2.timers.turn <= h2.rooms && h2.timers.bot <= h2.rooms, "no timer outlives its room, and none outnumber the rooms", h2);
  } finally {
    await srv.stop();
  }
  process.exit(done("fuzz") ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
