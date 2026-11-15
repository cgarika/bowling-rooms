/* Physics.StrikeMapIsBowling (WORLD.md 3.4, 9.1): calibration cells anchored at the head pin's row, at three seeds,
   with 95% intervals. The pocket at 4 to 7 degrees strikes 85% or more; carry at 6 degrees beats carry at 2 at boards
   16.5, 17.5 and 18.5; nothing collapses before 7 degrees; head-on hits strike 10% or less and split 35% or more;
   light hits leave the 10 or the 7 most often; pocket leaves are led by the 8 and the 10, not a lone 6.

   node test/strikemap.js          300 balls a cell at each of three seeds (about 2 minutes on 11 workers)
   FULL=1 node test/strikemap.js   1,000 balls a cell at each seed, as the design measured */
"use strict";
const os = require("os");
const L = require("../lane");
const B = require("../bot");
const { Pool } = require("../pool");
const { checker } = require("./helpers");
const { check, section, done } = checker();

const FULL = process.env.FULL === "1";
const PER_SEED = Number(process.env.PER_SEED || (FULL ? 1000 : 300));
const SEEDS = [11, 22, 33];
const CHUNK = 50;

(async () => {
  const t0 = Date.now();
  await L.init();
  const pool = new Pool({ size: Number(process.env.POOL_SIZE || Math.max(1, Math.min(6, os.availableParallelism() - 1))), table: B.table() });
  await pool.ready();
  async function cellAt(b, a, n = PER_SEED) {
    const tasks = [];
    for (const s of SEEDS) for (let k = 0; k < n; k += CHUNK) tasks.push({ task: "cell", b, a, N: Math.min(CHUNK, n - k), seed: s * 100003 + k, seedOf: s });
    const rs = await Promise.all(tasks.map((t) => pool.run(t, "task")));
    const agg = { strikes: 0, splits: 0, N: 0, leaves: {}, bySeed: {} };
    rs.forEach((r, i) => {
      agg.strikes += r.strikes; agg.splits += r.splits; agg.N += r.N;
      const s = tasks[i].seedOf; agg.bySeed[s] = agg.bySeed[s] || { st: 0, n: 0 }; agg.bySeed[s].st += r.strikes; agg.bySeed[s].n += r.N;
      for (const [k, v] of Object.entries(r.leaves)) agg.leaves[k] = (agg.leaves[k] || 0) + v;
    });
    agg.p = agg.strikes / agg.N; agg.ci = 1.96 * Math.sqrt(agg.p * (1 - agg.p) / agg.N);
    agg.split = agg.splits / agg.N;
    agg.top = Object.entries(agg.leaves).filter((e) => e[0] !== "X").sort((x, y) => y[1] - x[1]);
    return agg;
  }
  const pct = (x) => (100 * x).toFixed(1) + "%";
  const line = (label, c) => console.log(`  ${label.padEnd(26)} strikes ${pct(c.p)} (±${(100 * c.ci).toFixed(1)})  by seed ${SEEDS.map((s) => pct(c.bySeed[s].st / c.bySeed[s].n)).join(" / ")}  splits ${pct(c.split)}  leaves ${c.top.slice(0, 5).map(([k, v]) => `${k} ${pct(v / c.N)}`).join(", ")}`);

  section(`the cells, ${PER_SEED} balls at each of ${SEEDS.length} seeds`);
  const pocket6 = await cellAt(17.5, 6); line("pocket 17.5 / 6°", pocket6);
  const pocket4 = await cellAt(17.5, 4); line("pocket 17.5 / 4°", pocket4);
  const pocket2 = await cellAt(17.5, 2); line("pocket 17.5 / 2° (flat)", pocket2);
  const headon = await cellAt(20, 1); line("head-on 20 / 1°", headon);
  const light = await cellAt(15.5, 5); line("light 15.5 / 5°", light);
  const high = await cellAt(19, 5); line("high 19 / 5°", high);

  check(pocket4.p >= 0.85 && pocket6.p >= 0.85, "the pocket at 4 to 7 degrees strikes 85% or more", [pct(pocket4.p), pct(pocket6.p)]);
  check(headon.p <= 0.10, "head-on strikes 10% or less", pct(headon.p));
  check(headon.split >= 0.35, "head-on splits 35% or more", pct(headon.split));
  check(["10", "7"].includes(light.top[0][0]), "light hits leave the 10 or the 7 most often", light.top[0][0]);
  const lead = (c) => c.top.slice(0, 2).map((e) => e[0]);
  check(lead(pocket6).every((k) => ["8", "10"].includes(k)) && pocket6.top[0][0] !== "6", "pocket leaves are led by the 8 and the 10, not a lone 6", lead(pocket6));
  check(pocket4.top[0][0] !== "6", "and at 4 degrees the 6 does not lead either", lead(pocket4));
  for (const c of [pocket6, pocket4, pocket2, headon, light, high]) {
    const r = SEEDS.map((s) => c.bySeed[s].st / c.bySeed[s].n), spread = Math.max(...r) - Math.min(...r);
    check(spread <= 4 * Math.sqrt(c.p * (1 - c.p) / (c.N / 3)) + 0.01, "no seed is lucky: the three seeds agree within their noise", r.map(pct));
  }

  section("the shape across entry angles (7 degrees does not collapse; 6 beats 2)");
  const sweep = {};
  for (const b of [16.5, 17.5, 18.5]) {
    sweep[b] = {};
    for (const a of [2, 5, 6, 7]) sweep[b][a] = await cellAt(b, a, Math.max(100, Math.round(PER_SEED / (FULL ? 3 : 1.5))));
    console.log(`  board ${b}: ` + [2, 5, 6, 7].map((a) => `${a}° ${pct(sweep[b][a].p)}`).join(", "));
    const se = (c) => Math.sqrt(c.p * (1 - c.p) / c.N);
    check(sweep[b][6].p > sweep[b][2].p, `board ${b}: carry at 6 degrees beats carry at 2`, [pct(sweep[b][6].p), pct(sweep[b][2].p)]);
    // WORLD.md: 7 within 2 points of 6 at the pocket; at the edges, within 2 points plus the cells' own noise
    const slack = b === 17.5 ? 0.02 + 1.96 * Math.hypot(se(sweep[b][6]), se(sweep[b][7])) * (FULL ? 0 : 1) : 0.02 + 1.96 * Math.hypot(se(sweep[b][6]), se(sweep[b][7]));
    check(sweep[b][7].p >= sweep[b][6].p - slack, `board ${b}: nothing collapses before 7 degrees`, [pct(sweep[b][6].p), pct(sweep[b][7].p)]);
  }
  check(sweep[17.5][5].p >= 0.85 && sweep[17.5][7].p >= 0.85, "the pocket at 5 and 7 degrees strikes 85% or more too", [pct(sweep[17.5][5].p), pct(sweep[17.5][7].p)]);

  await pool.close();
  console.log(`\n(${((Date.now() - t0) / 1000).toFixed(0)} s on ${pool.size} workers)`);
  process.exit(done("strikemap") ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
