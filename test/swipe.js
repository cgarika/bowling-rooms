/* The same swipe, the same result (bowling-plato, 2026-11-04; Plato's own bowling gives a recorded swipe replayed the same fall every time).
   A person's ball is seeded by its release (lane.releaseSeed): the same four integers at the same pins give the same jitter of a fresh rack, the same
   physics and the same bytes, in any room, at any time. Over real sockets with short clocks:
     - two rooms, the same release at a fresh rack: the delivery's whole physics half (the rack as it stood, the ball's and every pin's track, the events,
       the pins down and standing) is byte for byte the same, and the seed is the release's own;
     - the second ball of the frame, the same release again at what the first left: the same again;
     - a different swipe is a different ball (another seed, another rack jitter), so the seed is not a constant;
     - the offline physics (lane.simulate with no seed) agrees with the room's.
   node test/swipe.js   (starts its own server on TEST_PORT, 3281 by default; or URL=... to use a running one) */
"use strict";
const L = require("../lane");
const H = require("./helpers");
const { check, section, done } = H.checker();
const { client, connected, waitFor, bowlWhenMine } = H;

/* What the physics made of a ball, without the room's own numbers (ids, clocks, seats). */
const PHYS = ["fmt", "seed", "before", "deckAt", "playMs", "ev", "down", "standing", "gutter", "ball", "pins", "thin", "release", "count", "mph", "entryBoard", "entryAngle"];
const physics = (d) => JSON.stringify(PHYS.map((k) => d[k]));

async function room(URL, name) {
  const a = client(URL, name);
  await connected(a);
  a.emit("create", { name, playerId: a.playerId });
  await waitFor(a, (x) => x.st && x.joined);
  a.emit("addBot");
  await waitFor(a, (x) => x.st && x.st.players.length >= 2);
  a.emit("start");
  await waitFor(a, (x) => x.st && x.st.status === "playing");
  return a;
}

(async () => {
  const srv = await H.startServer();
  try {
    const swipe = { x: 600, angle: 2125, speed: 7400, spin: 1000 };       // a pocket ball with a hook
    const other = { x: 700, angle: 2125, speed: 7400, spin: 1000 };       // one tenth of a board over
    section("the same swipe at a fresh rack, in two rooms");
    const a = await room(srv.url, "Ana"), b = await room(srv.url, "Ben");
    const da = await bowlWhenMine(a, swipe), db = await bowlWhenMine(b, swipe);
    check(da && db, "both deliveries came back");
    if (da && db) {
      check(da.before.length === 10 && db.before.length === 10, "both from a fresh rack of ten");
      check(physics(da) === physics(db), "the physics payload is byte for byte the same in both rooms", { a: da.down, b: db.down });
      const fresh = Array.from({ length: 10 }, (_, i) => ({ n: i + 1 }));
      check(da.seed === L.releaseSeed(swipe, fresh), "the seed is the release's own", { seed: da.seed, want: L.releaseSeed(swipe, fresh) });
      check(JSON.stringify(da.down) === JSON.stringify(db.down) && da.count === db.count, "the same pins fall", { a: da.count, b: db.count });
    }

    section("the second ball, the same swipe at what the first left");
    const ea = await bowlWhenMine(a, swipe), eb = await bowlWhenMine(b, swipe);
    if (ea && eb && ea.nth === 2 && eb.nth === 2) {
      check(physics(ea) === physics(eb), "the second ball's physics is the same in both rooms too");
    } else {
      check(!!(ea && eb), "a second ball was bowled in both rooms (a strike moves the frame on: then both are at a fresh rack)", { a: ea && ea.nth, b: eb && eb.nth });
      if (ea && eb) check(physics(ea) === physics(eb), "whatever the next ball was, it is the same in both rooms");
    }

    section("the same swipe, again, in a third room, later");
    const c = await room(srv.url, "Cy");
    const dc = await bowlWhenMine(c, swipe);
    check(dc && da && physics(dc) === physics(da), "a third room bowling it later makes the same ball");

    section("a different swipe is a different ball");
    const d = await room(srv.url, "Di");
    const dd = await bowlWhenMine(d, other);
    check(dd && da && dd.seed !== da.seed, "the seed follows the release", { a: da && da.seed, d: dd && dd.seed });
    check(dd && da && JSON.stringify(dd.before) !== JSON.stringify(da.before), "and so does the fresh rack's jitter");

    section("the offline physics agrees with the room's");
    await L.init();
    const rack = L.spots().map((q) => ({ n: q.n, x: q.x, y: q.y, yaw: q.yaw, fresh: true }));
    const s1 = L.simulate(L.fromWire(L.wireRelease(swipe)), rack, { record: true });
    check(da && s1.seed === da.seed, "lane.simulate's own seed is the one the room used", { sim: s1.seed, room: da && da.seed });
    check(da && JSON.stringify(s1.down) === JSON.stringify(da.down), "and it knocks down the same pins", { sim: s1.down, room: da && da.down });
    for (const s of [a, b, c, d]) s.close();
  } finally {
    await srv.stop();
  }
  const fails = done("swipe");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
