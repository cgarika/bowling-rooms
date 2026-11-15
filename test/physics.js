/* The physics (WORLD.md 3.4, 9.1): the pinned build and parameter set; random deliveries that never leave the lane,
   never gain energy, always end by the sweep, never let a gutter ball touch a pin, keep untouched pins on their spots,
   and make kickback messengers; a noise-free lane phase; bumpers; the wire format and its 48 KB cap; and determinism:
   the same release and seed give the same delivery byte for byte, twice in one thread, in a pool worker, and against
   the fixtures recorded in an earlier process (test/fixtures/determinism.json).

   node test/physics.js            2,000 random deliveries (about a minute)
   FULL=1 node test/physics.js     20,000, as WORLD.md 9.1 asks
   UPDATE_FIXTURES=1 ...           re-record the determinism fixtures (only after a deliberate physics change) */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const L = require("../lane");
const B = require("../bot");
const T = require("../track");
const D = require("../deck3d");
const tasks = require("../tools/tasks");
const { Pool } = require("../pool");
const { checker } = require("./helpers");
const { check, section, done } = checker();

const FULL = process.env.FULL === "1";
const N = Number(process.env.N || (FULL ? 20000 : 2000));
const FIX = path.join(__dirname, "fixtures", "determinism.json");
const PARAMS_SHA = "f6e710d0659b4a8975112e8cdc9d21240cecba619c8e601f029e899c2af84f6d";

(async () => {
  const t0 = Date.now();
  await L.init();
  const pool = new Pool({ size: Number(process.env.POOL_SIZE || Math.max(1, Math.min(6, os.availableParallelism() - 1))), table: B.table() });
  await pool.ready();

  section("the pinned build and the one parameter set");
  const pkg = require("../package.json");
  check(pkg.dependencies["@dimforge/rapier3d-deterministic-compat"] === "0.21.0", "Rapier's deterministic build is pinned exactly to 0.21.0");
  const lock = require("../package-lock.json");
  check(lock.packages["node_modules/@dimforge/rapier3d-deterministic-compat"].version === "0.21.0", "and installed at 0.21.0");
  const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "..", "calib_best.json"))).digest("hex");
  check(sha === PARAMS_SHA, "calib_best.json is the design's parameter set (SHA-256 f6e710d0...af84f6d)", sha);
  check(L.PARAMS.HZ === 240 && L.PARAMS.ITER === 4 && L.PARAMS.SWEEP_S === 2.4 && L.PARAMS.MAX_S === 6, "240 Hz, 4 solver iterations, the sweep at 2.4 s, the 6 s cap");

  section(`${N} random deliveries (the critique's distribution; a quarter at leaves, a tenth with bumpers)`);
  const CH = 100, jobs = [];
  for (let s = 0; s < N; s += CH) jobs.push(pool.run({ task: "random", seed: 1 + s / CH, n: Math.min(CH, N - s) }, "task"));
  const rs = await Promise.all(jobs);
  const sum = (k) => rs.reduce((a, r) => a + r[k], 0), max = (k) => rs.reduce((a, r) => Math.max(a, r[k]), 0);
  const agg = { n: sum("n"), gutters: sum("gutters"), gutterTouched: sum("gutterTouched"), leftLane: sum("leftLane"), capped: sum("capped"), keGainMax: max("keGainMax"), eGainMaxRel: max("eGainMaxRel"),
    maxEndS: max("maxEndS"), kicks: sum("kicks"), hitAfter: sum("hitAfter"), toppleAfter: sum("toppleAfter"), untouched: sum("untouched"), untouchedFar: sum("untouchedFar"), driftMaxMm: max("driftMaxMm"),
    bumperBalls: sum("bumperBalls"), bumperGutter: sum("bumperGutter"), noiseFree: sum("noiseFree"), noisy: sum("noisy"), strikes: sum("strikes") };
  const failures = rs.flatMap((r) => r.failures).slice(0, 5);
  console.log("  " + JSON.stringify(agg));
  if (failures.length) console.log("  first failures: " + JSON.stringify(failures).slice(0, 1500));
  check(agg.n === N, `all ${N} ran`);
  check(agg.leftLane === 0, "the ball never leaves the lane except into a gutter or the pit, and never passes a wall", agg.leftLane);
  check(agg.keGainMax <= 1e-9, "the lane phase never gains energy", agg.keGainMax);
  check(agg.eGainMaxRel <= 0.01, "the deck never gains energy (mechanical energy stays at or under its start, 1% solver allowance)", agg.eGainMaxRel);
  check(agg.capped === 0, "every delivery ends by the sweep or when the deck is still: the 6 s cap is never reached", agg.capped);
  check(agg.gutters > 0 && agg.gutterTouched === 0, `a gutter ball touches no pin (${agg.gutters} gutter balls)`);
  check(agg.bumperBalls > 0 && agg.bumperGutter === 0, `a bumper ball never reaches the gutter (${agg.bumperBalls} bumper balls)`);
  check(agg.untouched > 1000 && agg.untouchedFar === 0, `untouched standing pins stay within 1.5 mm of their spot (${agg.untouched} pins, worst ${agg.driftMaxMm.toFixed(3)} mm)`);
  check(agg.noisy === 0 && agg.noiseFree > 0, `the lane phase is noise-free: another seed gives the same hand-over bit for bit (${agg.noiseFree} checked)`);
  const hitPct = 100 * agg.hitAfter / agg.kicks, topPct = 100 * agg.toppleAfter / agg.kicks;
  console.log(`  kickbacks: ${agg.kicks} deliveries with a pin off a kickback; it then hits another pin in ${hitPct.toFixed(1)}%, knocks one down in ${topPct.toFixed(1)}% (design: 57% and 12%)`);
  check(hitPct >= 35, "kickback rebounds matter: the bounced pin hits another pin in at least 35%", hitPct.toFixed(1));
  check(topPct >= 6, "and knocks one down in at least 6%", topPct.toFixed(1));

  section("bumpers");
  {
    const r = L.fromWire({ x: 3000, angle: 3500, speed: 7000, spin: 0 });
    const plain = L.simulate(r, L.spots(), { seed: 5 }), bump = L.simulate(r, L.spots(), { seed: 5, bumpers: true });
    check(plain.gutterAt !== null, "a ball angled at the right gutter goes in without bumpers");
    check(bump.gutterAt === null && bump.hand && bump.events.some((e) => e.k === "bumper"), "with bumpers it bounces off the rail and reaches the deck");
    check(bump.down.length > 0 || bump.standing.length === 10, "and plays the pins");
    const straight = L.simulate(L.fromWire({ x: 600, angle: 2125, speed: 7400, spin: 1000 }), L.spots(), { seed: 5 });
    const straightB = L.simulate(L.fromWire({ x: 600, angle: 2125, speed: 7400, spin: 1000 }), L.spots(), { seed: 5, bumpers: true });
    check(JSON.stringify(straight.hand) === JSON.stringify(straightB.hand), "a ball that never reaches the rail is the same with or without bumpers (lane phase)");
  }

  section("the hand-over pose");
  {
    const s = L.lanePhase(L.fromWire({ x: 600, angle: 2125, speed: 7400, spin: 1000 }), {});
    const q = s.hand.q, n = Math.hypot(q.x, q.y, q.z, q.w);
    check(Math.abs(n - 1) < 1e-12, "the ball's integrated pose is a unit quaternion at the deck line");
    const q0 = L.poseStart(0);
    check(q0.w === 1 && q0.z === 0, "a straight release starts with the holes up and the grip down the lane");
    let qq = L.poseStart(0); for (let i = 0; i < 480; i++) qq = L.poseStep(qq, -10, 0, 1 / 480);   // 10 rad/s about -x for 1 s
    check(Math.abs(2 * Math.acos(Math.min(1, qq.w)) - 10) < 0.01 || Math.abs(2 * Math.acos(Math.min(1, Math.abs(qq.w))) - (4 * Math.PI - 10)) < 0.01, "the pose turns by the spin (10 rad in a second)");
  }

  section("the wire format");
  {
    const s = L.simulate(L.fromWire({ x: 600, angle: 2125, speed: 7400, spin: 1000 }), L.spots(), { seed: 77, record: true });
    const p = T.physicsPayload(s);
    const back = T.unpack(p.ball), orig = s.track3d.ball;
    let worstMm = 0, worstQ = 0;
    orig.forEach((o, i) => { const b = back[i]; worstMm = Math.max(worstMm, Math.abs(o[1] - b[1]) * 1000, Math.abs(o[2] - b[2]) * 1000, Math.abs(o[3] - b[3]) * 1000); const sg = o[7] < 0 ? -1 : 1; worstQ = Math.max(worstQ, Math.abs(o[4] * sg - b[4]), Math.abs(o[5] * sg - b[5]), Math.abs(o[6] * sg - b[6]), Math.abs(Math.abs(o[7]) - b[7])); });
    check(back.length === orig.length && worstMm <= 0.5, "samples round-trip within half a millimetre", worstMm);
    check(worstQ < 1e-3, "and their turns within 0.001", worstQ);
    check(back.every((b, i) => b[8] === (orig[i][8] ? 1 : 0)), "key flags survive");
    check(p.bytes < T.MAX_BYTES && p.thin === 0, `a pocket strike is ${p.bytes} bytes at 30 Hz`);
    check(p.before.length === 10 && p.before.every((r) => r.length === 4), "before: the rack as it stood, [n, x mm, y mm, yaw mrad]");
    const keys = Object.values(s.track3d.pins).flat().filter((x) => x[8]).length;
    check(keys > 0, `key samples at contacts (${keys} on the pins)`);
    // a track far too big for one frame is thinned, never sent over the cap
    const huge = { ...s, track3d: { ball: s.track3d.ball, pins: Object.fromEntries(Object.entries(s.track3d.pins).map(([k, v]) => [k, Array.from({ length: 900 }, (_, i) => { const x = v[i % v.length].slice(); x[0] = 2600 + i * 4; x[8] = i % 40 === 0 ? 1 : 0; return x; })])) } };
    const hp = T.physicsPayload(huge);
    check(hp.thin !== 0 && hp.bytes + T.META_ALLOWANCE <= T.MAX_BYTES, `a synthetic 30 Hz track of ${Object.keys(huge.track3d.pins).length * 900} pin samples is thinned (thin=${hp.thin}) to ${hp.bytes} bytes`);
    const kept = T.unpack(Object.values(hp.pins)[0] || "");
    check(hp.thin === -1 || kept.filter((x) => x[8]).length === Math.ceil(900 / 40), "thinning keeps every key sample");
  }

  section("determinism: the same release and seed give the same delivery, byte for byte");
  {
    const M = 200;
    const a = tasks.hashes({ from: 0, n: M }), b = tasks.hashes({ from: 0, n: M });
    const w = [].concat(...(await Promise.all(Array.from({ length: 8 }, (_, k) => pool.run({ task: "hashes", from: k * 25, n: 25 }, "task")))));
    const same = a.filter((x, i) => x === b[i]).length, sameW = a.filter((x, i) => x === w[i]).length;
    console.log(`  ${M} deliveries: identical twice in one thread ${same}/${M}; identical in a pool worker ${sameW}/${M}`);
    check(same === M, "identical twice in one thread");
    check(sameW === M, "identical in a pool worker");
    if (process.env.UPDATE_FIXTURES === "1" || !fs.existsSync(FIX)) {
      fs.mkdirSync(path.dirname(FIX), { recursive: true });
      fs.writeFileSync(FIX, JSON.stringify({ recorded: new Date().toISOString(), node: process.version, rapier: "0.21.0", params: PARAMS_SHA, hashes: a }, null, 1) + "\n");
      console.log("  recorded the fixtures in " + path.relative(process.cwd(), FIX));
    }
    const fix = JSON.parse(fs.readFileSync(FIX, "utf8"));
    const sameF = a.filter((x, i) => x === fix.hashes[i]).length;
    console.log(`  against the fixtures recorded ${fix.recorded} on Node ${fix.node}: ${sameF}/${M}`);
    check(sameF === M, "identical to the fixtures recorded in an earlier process (across runs)");
    // and a different seed changes the deck, never the lane
    const j = tasks.detJob(0); delete j.rnd;
    const r1 = require("../sim").runJob(j), r2 = require("../sim").runJob({ ...j, seed: j.seed + 1 });
    check(JSON.stringify(r1.release) === JSON.stringify(r2.release) && r1.payload.deckAt === r2.payload.deckAt, "a new seed keeps the release and the hand-over");
    check(JSON.stringify(r1.payload.before) !== JSON.stringify(r2.payload.before), "and moves the fresh rack's spots and yaws");
  }

  await pool.close();
  console.log(`\n(${((Date.now() - t0) / 1000).toFixed(0)} s on ${pool.size} workers)`);
  process.exit(done("physics") ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
