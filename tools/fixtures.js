/* Fixtures for the client lanes (WORLD.md 9.2):
   - test/fixtures/lane_handover.json: 1,300 quantised releases (a tenth with bumpers; the last 300 as bots bowl) and the lane phase's answer for
     each, for BowlingCore's Core.LaneMatchesTheServer (within 1 mm and 0.05 degree): the hand-over state at the deck
     line (position, velocity, spin, pose), its time, the entry, or the gutter and the pit, and the lane events. The
     first 40 also carry the 30 Hz path [t ms, x mm, y mm].
   - test/fixtures/cards.json: 60 cards with their marks, running totals and calls, for Core.ScoreMatchesTheServer.
   - test/fixtures/frames/*.json: real frames captured from a server (joined, state in every phase, delivery, pong,
     refused), for ParsesTheServersFrames and DeliveryDecodesOffTheGameThread.

   node tools/fixtures.js [--port 3282]     (starts its own server on that port for the frames; never 3111-3120) */
"use strict";
const fs = require("fs");
const path = require("path");
const L = require("../lane");
const S = require("../score");
const H = require("../test/helpers");

const OUT = path.join(__dirname, "..", "test", "fixtures");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; };
function lcg(seed) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }
const r6 = (v) => +v.toFixed(9);

function laneFixtures() {
  const rnd = lcg(20260926), rows = [];
  const B = require("../bot");
  for (let i = 0; i < 1300; i++) {
    // 1,000 anywhere in the clamps (half of them end in a gutter), then 300 as bowlers bowl (bots of every skill, both hands, first balls and spares)
    const wire = i < 1000 ? L.wireRelease({ x: Math.round((rnd() - 0.5) * 8000), angle: Math.round((rnd() - 0.5) * 7000), speed: 5400 + Math.round(rnd() * 4400), spin: Math.round((rnd() - 0.5) * 2000) })
      : L.toWire(B.choose(i % 2 ? L.spots() : L.spots().filter((p) => [3, 6, 10, 7, 4][i % 5] === p.n || p.n === 10), ["rookie", "regular", "pro"][i % 3], rnd, i % 4 === 0 ? -1 : 1));
    const bumpers = i % 10 === 9;
    const s = L.lanePhase(L.fromWire(wire), { bumpers });
    const row = { release: wire, bumpers, deckAt: s.deckAt === null ? null : r6(s.deckAt), gutterAt: s.gutterAt === null ? null : r6(s.gutterAt),
      hand: s.hand ? { x: r6(s.hand.x), y: r6(s.hand.y), vx: r6(s.hand.vx), vy: r6(s.hand.vy), wx: r6(s.hand.wx), wy: r6(s.hand.wy), q: [r6(s.hand.q.x), r6(s.hand.q.y), r6(s.hand.q.z), r6(s.hand.q.w)] } : null,
      entry: s.entry ? { x: r6(s.entry.x), angle: r6(s.entry.angle), speed: r6(s.entry.speed), board: r6(L.boardAtHead(s.entry)) } : null,
      endT: s.hand ? null : r6(s.endT), events: s.events.map((e) => [e.t, e.k, e.s || 0]) };
    if (i < 40) row.path = s.trackB;
    rows.push(row);
  }
  return { about: "lane.js lanePhase() from each wire release (fromWire divides: x/1e4 m, angle/1e3 deg, speed/1e3 m/s, spin/1e3). hand is the ball at the deck line after the step that crossed it; q is [x,y,z,w].", constants: { DT: L.DT, HALF: L.HALF, DECK_Y: L.DECK_Y, HEAD_Y: L.HEAD_Y, PIT_Y: L.PIT_Y, BALL_R: L.BALL_R, BUMP_X: L.BUMP_X, BUMP_E: L.BUMP_E, WYMAX: L.WYMAX }, rows };
}

function cardFixtures() {
  const rnd = lcg(60);
  const r = (n) => Math.floor(rnd() * (n + 1));
  const cards = [];
  const fixed = [Array(12).fill(10), Array(20).fill(0), [].concat(...Array(10).fill([9, 1]), [9]), Array(18).fill(0).concat([0, 10, 5]), Array(18).fill(0).concat([10, 0, 10]), [10, 7, 3, 9, 0, 10, 0, 8, 8, 2, 0, 6, 10, 10, 10, 8, 1]];
  for (const b of fixed) cards.push({ frames: 10, balls: b });
  cards.push({ frames: 3, balls: [0, 0, 0, 0, 0, 10, 0] }, { frames: 5, balls: Array(7).fill(10) }, { frames: 3, balls: [10, 9, 1, 10, 10, 10] });
  while (cards.length < 60) {
    const F = [10, 10, 5, 3][cards.length % 4], balls = [];
    for (let f = 0; f < F - 1; f++) { const a = r(10); balls.push(a); if (a < 10) balls.push(r(10 - a)); }
    const a = r(10); balls.push(a);
    if (a === 10) { const b = r(10); balls.push(b); balls.push(b === 10 ? r(10) : r(10 - b)); } else { const b = r(10 - a); balls.push(b); if (a + b === 10) balls.push(r(10)); }
    const cut = cards.length % 5 === 0 ? Math.max(1, balls.length - 1 - r(4)) : balls.length;     // some cards mid-game
    cards.push({ frames: F, balls: balls.slice(0, cut) });
  }
  return { about: "score.js card(balls, frames): per frame the marks and the running total where it is known (null otherwise), and the total so far.", cards: cards.map((c) => ({ ...c, card: S.card(c.balls, c.frames) })) };
}

async function frameFixtures(port) {
  const srv = await H.startServer({ ARRIVAL_MS: "300" }, port);
  const frames = {};
  const keep = (name, event, payload) => { if (!frames[name]) frames[name] = { event, payload }; };
  try {
    const a = H.client(srv.url, "Ava"), b = H.client(srv.url, "Mo");
    await Promise.all([H.connected(a), H.connected(b)]);
    a.on("joined", (j) => keep("joined", "joined", j));
    a.on("state", (e) => {
      const r = e.room;
      if (r.status === "lobby" && r.players.length === 1) keep("state-lobby-alone", "state", e);
      if (r.status === "lobby" && r.players.length === 4) keep("state-lobby-4", "state", e);
      if (r.status === "playing" && r.throwSeq === 0) keep("state-first-ball", "state", e);
      if (r.status === "playing" && r.ball === 2 && !r.fresh) keep("state-second-ball-at-the-leave", "state", e);
      if (r.status === "playing" && r.frame === r.frames) keep("state-last-frame", "state", e);
      if (r.status === "playing" && r.frame === r.frames && r.ball === 3) keep("state-last-frame-bonus-ball", "state", e);
      if (r.status === "playing" && r.players.some((p) => p.botControlled)) keep("state-bot-controlled", "state", e);
      if (r.status === "playing" && r.players.some((p) => p.left)) keep("state-a-seat-left", "state", e);
      if (r.status === "rolloff") keep("state-rolloff", "state", e);
      if (r.status === "over") keep("state-over", "state", e);
    });
    a.on("delivery", (d) => {
      if (d.call === "strike" || d.call === "double" || d.call === "turkey") keep("delivery-strike", "delivery", d);
      if (d.call === "spare") keep("delivery-spare", "delivery", d);
      if (d.call === "split") keep("delivery-split", "delivery", d);
      if (d.call === "gutter") keep("delivery-gutter", "delivery", d);
      if (d.call === "count" && d.fresh) keep("delivery-count", "delivery", d);
      if (d.bumpers && d.ev.some((e) => e[1] === 12)) keep("delivery-bumper", "delivery", d);
      if (d.lefty) keep("delivery-lefty", "delivery", d);
      if (d.rolloff) keep("delivery-rolloff", "delivery", d);
      if (d.kind === "timeout") keep("delivery-timeout", "delivery", d);
      if (d.frame && d.nth === 3) keep("delivery-last-frame-third-ball", "delivery", d);
    });
    a.on("pong", (p) => keep("pong", "pong", p));
    a.on("refused", (p) => keep("refused-" + p.code, "refused", p));
    a.emit("create", { name: "Ava", playerId: a.playerId, avatar: "a03" });
    await H.waitFor(a, (x) => x.st);
    a.emit("start");                                           // refused: one seat
    a.emit("ping", { c: 1790000000000 });
    b.emit("join", { code: a.st.code, name: "Mo", playerId: b.playerId });
    await H.waitFor(a, (x) => x.st.players.length === 2);
    b.emit("options", { bumpers: true, lefty: true, ball: "flame" });
    a.emit("addBot"); a.emit("addBot");
    await H.waitFor(a, (x) => x.st.players.length === 4);
    a.emit("settings", { frames: 10, rolloff: true });
    await H.sleep(200);
    a.emit("start");
    const sa = H.autoBowl(a), sb = H.autoBowl(b, () => ({ x: 3800, angle: 3400, speed: 7000, spin: 0 }));      // Mo aims at the gutter: his bumpers catch it
    await H.waitFor(a, (x) => x.st.status === "over", 120000);
    sa(); sb();
    // a roll-off: two humans who bowl only gutters tie
    const c = H.client(srv.url, "Cy"), d = H.client(srv.url, "Di");
    await Promise.all([H.connected(c), H.connected(d)]);
    c.on("state", (e) => { if (e.room.status === "rolloff") keep("state-rolloff", "state", e); if (e.room.status === "over" && e.room.winners.length > 1) keep("state-over-shared", "state", e); });
    c.on("delivery", (x) => { if (x.rolloff) keep("delivery-rolloff", "delivery", x); if (x.call === "gutter") keep("delivery-gutter", "delivery", x); });
    c.emit("create", { name: "Cy", playerId: c.playerId }); await H.waitFor(c, (x) => x.st);
    d.emit("join", { code: c.st.code, name: "Di", playerId: d.playerId }); await H.waitFor(c, (x) => x.st.players.length === 2);
    c.emit("settings", { frames: 3 }); c.emit("start");
    const g = () => ({ x: 4000, angle: 3500, speed: 7000, spin: 0 });
    const s1 = H.autoBowl(c, g), s2 = H.autoBowl(d, g);
    await H.waitFor(c, (x) => x.st.status === "over", 60000);
    s1(); s2();
    // a timeout, a bot-controlled seat and a seat that left
    const e1 = H.client(srv.url, "Eve"), f1 = H.client(srv.url, "Fox");
    await Promise.all([H.connected(e1), H.connected(f1)]);
    e1.on("state", (e) => { const r = e.room; if (r.players.some((p) => p.botControlled)) keep("state-bot-controlled", "state", e); if (r.status === "playing" && r.players.some((p) => p.left)) keep("state-a-seat-left", "state", e); });
    e1.on("delivery", (x) => { if (x.kind === "timeout") keep("delivery-timeout", "delivery", x); });
    e1.emit("create", { name: "Eve", playerId: e1.playerId }); await H.waitFor(e1, (x) => x.st);
    f1.emit("join", { code: e1.st.code, name: "Fox", playerId: f1.playerId }); await H.waitFor(e1, (x) => x.st.players.length === 2);
    e1.emit("addBot"); await H.waitFor(e1, (x) => x.st.players.length === 3);
    e1.emit("settings", { frames: 10 });
    e1.emit("start");
    const s3 = H.autoBowl(e1);
    await H.sleep(500);
    f1.close();                                                // Fox drops: 6 s AFK clocks, three timeout balls, then the bot
    await H.waitFor(e1, () => frames["state-bot-controlled"], 90000);
    const f2 = H.client(srv.url, "Fox", { playerId: f1.playerId }); await H.connected(f2);
    f2.emit("join", { code: e1.st.code, name: "Fox", playerId: f1.playerId });
    await H.waitFor(f2, (x) => x.st);
    f2.emit("leave");                                          // and then leaves for good: his seat is marked left
    await H.waitFor(e1, () => frames["state-a-seat-left"], 10000);
    s3();
    e1.emit("leave");
    await H.sleep(300);
    [a, b, c, d, e1, f2].forEach((s) => s.close());
  } finally {
    await srv.stop();
  }
  return frames;
}

(async () => {
  fs.mkdirSync(path.join(OUT, "frames"), { recursive: true });
  const lane = laneFixtures();
  fs.writeFileSync(path.join(OUT, "lane_handover.json"), JSON.stringify(lane));
  console.log(`lane_handover.json: ${lane.rows.length} releases, ${lane.rows.filter((r) => r.hand).length} reach the deck, ${lane.rows.filter((r) => r.gutterAt !== null).length} gutter balls`);
  const cards = cardFixtures();
  fs.writeFileSync(path.join(OUT, "cards.json"), JSON.stringify(cards, null, 0));
  console.log(`cards.json: ${cards.cards.length} cards`);
  await L.init();
  const frames = await frameFixtures(Number(arg("port", 3282)));
  for (const [name, f] of Object.entries(frames)) fs.writeFileSync(path.join(OUT, "frames", name + ".json"), JSON.stringify(f, null, 1));
  console.log(`frames/: ${Object.keys(frames).length} frames: ${Object.keys(frames).sort().join(", ")}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
