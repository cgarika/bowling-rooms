/* Gear (2026-11-10, gear step 4): the table's Bowling slots, the clamps, the release's cap (the ball's Power) and its wobble (the shoes' Steadiness) on the server and in the physics, the host's
   gear switch, the bands quick play matches within, the bots' gear, and that no gear is exactly the ball as sent. In process for the physics; its own server on TEST_PORT for the sockets.
   node test/gear.js   (TEST_PORT, 3281 by default; never 3111-3126) */
"use strict";
const G = require("../gear");
const L = require("../lane");
const SIM = require("../sim");
const H = require("./helpers");
const { check, section, done } = H.checker();
const { client, connected, waitFor, sleep, bowlWhenMine } = H;
const SAP = { bball: { item: "bball:sapphire", level: 10 }, shoes: { item: "shoes:sapphire", level: 6 }, wrist: { item: "wrist:sapphire", level: 8 } };

(async () => {
  await L.init();
  section("the table: Bowling's slots and items");
  {
    check(JSON.stringify(G.slotsOf("bowling")) === '["bball","shoes","wrist"]' && JSON.stringify(G.T.games.bowling.stats) === '["hook","power","steady","aim"]', "Bowling: ball, shoes, wrist guard; hook, power, steady, aim");
    for (const slot of G.slotsOf("bowling")) {
      const items = Object.keys(G.T.items).filter((k) => G.T.items[k].slot === slot);
      check(items.length === 4 && ["common", "rare", "epic", "legendary"].every((x, i) => G.rarityOf(items[i]) === x) && items[0] === G.starterOf(slot), `${slot}: the COMMON starter, RARE, EPIC, LEGENDARY`, items);
    }
    check(G.T.items["bball:classic"].name === "Classic ball" && G.T.items["shoes:dragon"].name === "Dragon shoes" && G.T.items["wrist:pearl"].name === "Pearl guard", "the names");
    const full = G.clean("bowling", SAP);
    check(full.score === 24 && full.stats.hook === 9 && full.stats.power === 9 && full.stats.steady === 5 && full.stats.aim === 7, "gear score is the sum of the levels; stats from the pieces", full);
    check(G.clean("bowling", { bball: { item: "bball:dragon", level: 1 } }).slots.bball.level === 5 && G.clean("bowling", { shoes: { item: "shoes:classic", level: 50 } }).slots.shoes.level === 6, "the clamps");
    check(G.clean("bowling", null) === null && G.clean("bowling", { putter: { item: "putter:dragon", level: 9 } }).score === 3, "no gear is null; Mini Golf's slots mean nothing here");
  }

  section("the effects: the cap, the hook, the wobble; no gear is the base");
  {
    const fx = G.bowlingEffects({ hook: 10, power: 10, steady: 10, aim: 10 });
    check(fx.speedMax === 12740 && Math.abs(fx.hook - 1.4) < 1e-9 && Math.abs(fx.steady - 0.6) < 1e-9 && Math.abs(fx.aim - 1.8) < 1e-9, "at 10 points: the cap 12,740 mm/s, 1.4x hook, 0.6x wobble, 1.8x aim", fx);
    check(G.bowlingEffects(null).speedMax === 9800 && G.bowlingEffects({}).steady === 1, "no stats: the base cap, no scaling");
    // the wire: the seat's own cap
    check(L.wireRelease({ x: 0, angle: 0, speed: 12000, spin: 0 }).speed === 9800, "a release over 9.8 m/s is held to it with no cap given (as every ball was)");
    check(L.wireRelease({ x: 0, angle: 0, speed: 12000, spin: 0 }, 12740).speed === 12000 && L.wireRelease({ x: 0, angle: 0, speed: 13000, spin: 0 }, 12740).speed === 12740, "with a geared seat's cap it is held to that cap");
    check(L.wireRelease({ x: 0, angle: 0, speed: 5000, spin: 0 }, 12740).speed === 5400, "the floor stays");
    check(L.toWire({ x: 0, angle: 0, speed: 11.0, spin: 0 }, 11270).speed === 11000, "toWire takes the cap too");
    // the wobble: deterministic, bounded, scaled, nothing at 0
    const w = { x: 600, angle: 2125, speed: 7400, spin: 1000 };
    const a = G.wobbleRelease(w, 1), b = G.wobbleRelease(w, 1), s6 = G.wobbleRelease(w, 0.6);
    check(JSON.stringify(a) === JSON.stringify(b) && a.x === w.x, "the same release wobbles the same way twice, and the stance never moves", a);
    check(Math.abs(a.angle - w.angle) <= 80 && Math.abs(a.speed - w.speed) <= 60 && Math.abs(a.spin - w.spin) <= 20 && a.spin <= 1000, "inside 0.08 degrees, 0.06 m/s and 0.02 of spin, and the wire's clamps", a);
    check(Math.abs(s6.angle - w.angle) <= 48 && Math.abs(s6.speed - w.speed) <= 36, "at steadiness 10 it is 60% of that", s6);
    check(JSON.stringify(G.wobbleRelease(w, 0)) === JSON.stringify(w), "a mul of 0 is the release as sent");
  }

  section("the physics: a capped release reaches the deck faster; the same bytes for the same release; the base is untouched");
  {
    const standing = L.spots();
    const job = (speed, speedMax) => ({ kind: "human", release: { x: 0, angle: 0, speed, spin: 0 }, standing, seed: 1234, bumpers: false, hand: 1, speedMax });
    const base = SIM.runJob(job(9800, 0)), capped = SIM.runJob(job(12000, 0)), geared = SIM.runJob(job(12000, 12740)), again = SIM.runJob(job(12000, 12740));
    check(JSON.stringify(base.payload) === JSON.stringify(capped.payload) && capped.release.speed === 9800, "with no cap a 12 m/s release is the 9.8 m/s ball (as it always was)");
    check(geared.release.speed === 12000 && geared.payload.deckAt < base.payload.deckAt, `with the seat's cap it is a 12 m/s ball, at the deck sooner (${geared.payload.deckAt} < ${base.payload.deckAt} ms)`);
    check(JSON.stringify(geared.payload) === JSON.stringify(again.payload), "the same geared release gives the same bytes");
    const noCap = SIM.runJob({ ...job(7400, 0), speedMax: 0 }), nullCap = SIM.runJob({ ...job(7400, 0), speedMax: undefined });
    check(JSON.stringify(noCap.payload) === JSON.stringify(nullCap.payload), "a job with no cap at all is the base");
    check(L.releaseSeed({ x: 0, angle: 0, speed: 12000, spin: 0 }, standing, 12740) !== L.releaseSeed({ x: 0, angle: 0, speed: 12000, spin: 0 }, standing), "the seed is the release's own, cap and all");
  }

  const srv = await H.startServer({ QUICK_FILL_MS: "900", QUICK_FILL_MAX_MS: "900" });
  const URL = srv.url;
  try {
    section("gear is accepted on create and join, clamped, and shown to the table; the switch; the bots");
    {
      const a = client(URL, "a"); await connected(a);
      a.emit("create", { name: "Ava", playerId: a.playerId, gear: { ...SAP, bball: { item: "bball:sapphire", level: 500 } } });
      await waitFor(a, (s) => s.st);
      const me = a.st.players[0];
      check(me.gear && me.gear.score === 24 && me.gear.levels.bball === 10 && me.gear.items.bball === "bball:sapphire", "Ava's gear is on her seat, clamped", me.gear);
      check(me.gear.stats.hook === 9 && me.gear.stats.steady === 5 && a.st.gearOn === true, "stats are in force, the gear switch is on", me.gear && me.gear.stats);
      const old = client(URL, "old"); await connected(old);
      old.emit("join", { code: a.st.code, name: "Old", playerId: old.playerId });
      await waitFor(a, (s) => s.st.players.length === 2);
      check(a.st.players[1].gear === null, "an old app that sends no gear has none");
      old.emit("gear", { bball: { item: "bball:pearl", level: 99 } });
      check(await waitFor(a, (s) => s.st.players[1].gear && s.st.players[1].gear.levels.bball === 8), "a gear change in the lobby reaches the table, clamped (Pearl, RARE, held at 8)");
      old.emit("settings", { gear: false }); await sleep(150);
      check(a.st.gearOn === true, "a guest cannot switch gear off");
      a.emit("settings", { gear: false });
      check(await waitFor(a, (s) => s.st.gearOn === false), "the host can");
      check(a.st.players[0].gear.stats.hook === 0 && a.st.players[0].gear.score === 24, "off: the stats are nothing, the score is still shown");
      a.emit("settings", { gear: true }); await waitFor(a, (s) => s.st.gearOn === true);
      a.emit("addBot"); await waitFor(a, (s) => s.st.players.length === 3);
      check(a.st.players[2].bot && a.st.players[2].gear && a.st.players[2].gear.score === Math.round((24 + 10) / 2) && a.st.players[2].gear.items.bball, "the bot's score is the humans' mean (24 and 10: 17) and it wears a ball", a.st.players[2].gear);
      for (const s of [a, old]) s.close();
    }

    section("a throw: the seat's cap and its wobble ride on the release the room plays; no gear, or gear off, is the ball as sent");
    {
      const game = async (gear, gearOn) => {
        const a = client(URL, "t"); await connected(a);
        a.emit("create", { name: "T", playerId: a.playerId, ...(gear ? { gear } : {}) });
        await waitFor(a, (s) => s.st);
        if (gearOn === false) { a.emit("settings", { gear: false }); await waitFor(a, (s) => s.st.gearOn === false); }
        a.emit("addBot"); await waitFor(a, (s) => s.st.players.length === 2);
        a.emit("start"); await waitFor(a, (s) => s.st.status === "playing");
        return a;
      };
      const sent = { x: 600, angle: 2125, speed: 12000, spin: 1000 };
      const none = await game(null);
      const d0 = await bowlWhenMine(none, sent);
      check(d0 && d0.release.speed === 9800 && d0.release.angle === 2125 && d0.release.spin === 1000, "no gear: the release as sent, held to 9.8 m/s, not a hair of wobble", d0 && d0.release);
      none.close();
      const geared = await game(SAP);
      const d1 = await bowlWhenMine(geared, sent);
      const fx = G.bowlingEffects(G.clean("bowling", SAP).stats);
      const want = G.wobbleRelease(L.wireRelease(sent, fx.speedMax), fx.steady, fx.speedMax);
      check(d1 && JSON.stringify(d1.release) === JSON.stringify(want), `gear: the release is capped at ${fx.speedMax} and wobbled by the shoes (${fx.steady}): exactly wobbleRelease(sent)`, d1 && [d1.release, want]);
      check(d1 && d1.release.speed > 9800 && d1.release.speed <= fx.speedMax, "a 12 m/s ball goes out at 12 m/s (the cap is 12,470 at power 9)");
      geared.close();
      const off = await game(SAP, false);
      const d2 = await bowlWhenMine(off, sent);
      check(d2 && d2.release.speed === 9800 && d2.release.angle === 2125 && d2.release.spin === 1000, "gear off: the ball as sent, held to 9.8 m/s", d2 && d2.release);
      off.close();
    }

    section("quick play matches within a gear-score band");
    {
      const lo = client(URL, "lo"), hi = client(URL, "hi"), mid = client(URL, "mid"), ng = client(URL, "ng");
      for (const c of [lo, hi, mid, ng]) await connected(c);
      lo.emit("quick", { name: "Lo", playerId: lo.playerId }); await waitFor(lo, (s) => s.st && s.st.quick);                                 // 3
      hi.emit("quick", { name: "Hi", playerId: hi.playerId, gear: SAP }); await waitFor(hi, (s) => s.st && s.st.quick);                     // 24
      check(hi.st.code !== lo.st.code, "a score of 24 does not join a score of 3", [hi.st.code, lo.st.code]);
      mid.emit("quick", { name: "Mid", playerId: mid.playerId, gear: { bball: { item: "bball:pearl", level: 4 }, shoes: { item: "shoes:classic", level: 3 } } });   // 8
      await waitFor(mid, (s) => s.st && s.st.quick);
      check(mid.st.code === lo.st.code, "a score of 8 does join a score of 3", [mid.st.code, lo.st.code]);
      ng.emit("quick", { name: "Ng", playerId: ng.playerId, gear: SAP }); await waitFor(ng, (s) => s.st && s.st.quick);
      check(ng.st.code === hi.st.code, "the same band meets", [ng.st.code, hi.st.code]);
      for (const c of [lo, hi, mid, ng]) c.close();
    }
  } finally { await srv.stop(); }
  const f = done("gear");
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
