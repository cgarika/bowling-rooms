/* Bots.AveragesHold (WORLD.md 3.6, 5.1, 9.1): whole games per skill against the modelled human (until the owner's 50
   swipes replace it): the Rookie below the casual hand, the Regular within 10 pins of it, the Pro above the careful
   hand; the timeout ball averages under the first-game hand; no bot release outside the clamps; Lefty mirrors.

   node test/bots.js            80 games each (about a minute on 11 workers)
   FULL=1 node test/bots.js     200 games each, as the design measured */
"use strict";
const os = require("os");
const L = require("../lane");
const B = require("../bot");
const { Pool } = require("../pool");
const { checker } = require("./helpers");
const { check, section, done } = checker();

const G = Number(process.env.GAMES || (process.env.FULL === "1" ? 200 : 80));

(async () => {
  const t0 = Date.now();
  await L.init();
  const pool = new Pool({ size: Number(process.env.POOL_SIZE || Math.max(1, Math.min(6, os.availableParallelism() - 1))), table: B.table() });
  await pool.ready();
  const res = {};
  async function play(label, spec) {
    const rs = await Promise.all(Array.from({ length: G }, (_, i) => pool.run({ task: "game", seed: 90000 + i * 7, ...spec }, "task")));
    const avg = (k) => rs.reduce((a, r) => a + r[k], 0) / rs.length;
    const o = { avg: avg("total"), strikes: avg("strikes"), spares: avg("spares"), splits: avg("splits"), gutters: avg("gutters"), outside: rs.reduce((a, r) => a + r.outside, 0) };
    o.sd = Math.sqrt(rs.reduce((a, r) => a + (r.total - o.avg) ** 2, 0) / rs.length); o.se = o.sd / Math.sqrt(G);
    res[label] = o;
    console.log(`  ${label.padEnd(22)} average ${o.avg.toFixed(1)} (SD ${o.sd.toFixed(0)}), strikes ${o.strikes.toFixed(1)}, spares ${o.spares.toFixed(1)}, splits ${o.splits.toFixed(1)}, gutter balls ${o.gutters.toFixed(1)} a game`);
    return o;
  }
  section(`${G} ten-frame games each`);
  const careful = await play("human, careful thumb", { who: "human", prof: B.HUMANS.careful });
  const casual = await play("human, casual thumb", { who: "human", prof: B.HUMANS.casual });
  const first = await play("human, first game", { who: "human", prof: B.HUMANS.first });
  const rookie = await play("bot, Rookie", { who: "bot", skill: "rookie" });
  const regular = await play("bot, Regular", { who: "bot", skill: "regular" });
  const pro = await play("bot, Pro", { who: "bot", skill: "pro" });
  const lefty = await play("bot, Pro left-handed", { who: "bot", skill: "pro", hand: -1 });
  const idle = await play("every ball timed out", { who: "timeout" });
  // styles and form (2026-10-28): a bot's hook, pace and streakiness; its scores stay believable and vary game to game
  const sty = {};
  for (const [name, skill] of [["hooker", "regular"], ["speedster", "regular"], ["steady", "regular"], ["hooker", "pro"], ["speedster", "rookie"]]) {
    sty[name + "/" + skill] = await play(`bot, ${skill} ${name}, form`, { who: "bot", skill, style: name, form: true });
  }

  check(rookie.avg < casual.avg, "the Rookie is below the casual hand", [rookie.avg.toFixed(1), casual.avg.toFixed(1)]);
  check(Math.abs(regular.avg - casual.avg) <= 10, "the Regular is within 10 pins of the casual hand", [regular.avg.toFixed(1), casual.avg.toFixed(1)]);
  check(pro.avg > careful.avg, "the Pro is above the careful hand", [pro.avg.toFixed(1), careful.avg.toFixed(1)]);
  check(idle.avg < first.avg, "going idle never pays: the timeout ball averages under a first game", [idle.avg.toFixed(1), first.avg.toFixed(1)]);
  check(pro.strikes > regular.strikes && regular.strikes > rookie.strikes, "strikes rise with skill", [rookie.strikes, regular.strikes, pro.strikes].map((x) => x.toFixed(1)));
  check([rookie, regular, pro].every((o) => o.strikes > o.splits), "at every skill strikes outnumber splits");
  check(Math.abs(lefty.avg - pro.avg) <= 3 * Math.hypot(lefty.se, pro.se) + 5, "a left-handed Pro bowls like a right-handed one (the lane is mirrored)", [lefty.avg.toFixed(1), pro.avg.toFixed(1)]);
  for (const [k, o] of Object.entries(sty)) check(o.sd >= 15, `${k} with form varies game to game (SD ${o.sd.toFixed(0)})`);
  check(["hooker/regular", "speedster/regular", "steady/regular"].every((k) => Math.abs(sty[k].avg - regular.avg) <= 22), "a style changes how a Regular bowls, not how good it is", ["hooker/regular", "speedster/regular", "steady/regular"].map((k) => sty[k].avg.toFixed(0)));
  check(sty["hooker/pro"].avg < 235 && sty["hooker/pro"].avg > 150, "a Pro with form still bowls like a Pro, not a robot", sty["hooker/pro"].avg.toFixed(0));
  const sp = B.ideal(L.spots(), 1, B.STYLES.speedster), ho = B.ideal(L.spots(), 1, B.STYLES.hooker), ste = B.ideal(L.spots(), 1, B.STYLES.steady);
  check(sp.speed > ho.speed + 0.8 && ho.spin > ste.spin, "styles throw differently: the speedster is faster, the hooker hooks more than the steady", [sp.speed.toFixed(1), ho.speed.toFixed(1), ho.spin, ste.spin]);
  check(Object.values(res).every((o) => o.outside === 0), "no release outside the clamps");
  // the aim table and the house line (WORLD.md 3.4)
  const t = B.table();
  check(t.length / B.F === 14932, "the aim table has the design's 14,932 lines", t.length / B.F);
  const house = B.ideal(L.spots());
  const hb = L.boardAtHead(L.lanePhase(L.fromWire(L.toWire(house)), { noPins: true }).entry);
  check(Math.abs(hb - 17.5) < 0.5 && house.ea > 4.5, `the house line meets the head pin at board ${hb.toFixed(1)} at ${house.ea.toFixed(1)} degrees (the pocket, 17.5 at 5 to 6)`);
  const lh = B.ideal(L.spots(), -1);
  check(Math.abs(lh.x + house.x) < 1e-12 && Math.abs(lh.angle + house.angle) < 1e-12 && lh.spin === -house.spin, "a left-hander's house line is the mirror");
  check(JSON.stringify(B.timeoutBall()) === JSON.stringify({ x: 0, angle: 0, speed: 6.2, spin: 0 }), "the timeout ball is straight down the middle at 6.2 m/s");

  await pool.close();
  console.log(`\n(${((Date.now() - t0) / 1000).toFixed(0)} s on ${pool.size} workers)`);
  process.exit(done("bots") ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
