/* Batches of physics work for the test suites and tools, run inside pool workers (pool.run(job, "task")) or in any
   thread after `await lane.init()`. Each returns plain data. Deterministic: the same job gives the same answer. */
"use strict";
const crypto = require("crypto");
const L = require("../lane");
const S = require("../score");
const B = require("../bot");
const T = require("../track");
const D = require("../deck3d");
const SIM = require("../sim");

function lcg(seed) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }
const bx = (b) => (20 - b) * L.BOARD;

/* The critique's own distribution of deliveries: anywhere on the approach, any angle, speed and spin in the clamps. A
   quarter are bowled at a leave (a random subset of the rack, where it stands), a tenth with bumpers. */
function randomJob(rnd, i, seed0) {
  let standing = L.spots();
  if (rnd() < 0.25) { const keep = standing.filter(() => rnd() < 0.45); standing = (keep.length ? keep : [standing[9]]).map((p) => ({ ...p, fresh: false, yaw: rnd() * 6.283 })); }
  return {
    release: { x: (rnd() - 0.5) * 0.8, angle: (rnd() - 0.5) * 7, speed: 5.4 + rnd() * 4.4, spin: (rnd() - 0.5) * 2 },
    standing, seed: (seed0 * 7919 + i * 104729) >>> 0, bumpers: rnd() < 0.1,
  };
}

/* test/physics.js: n random deliveries, audited. */
function random({ seed, n }) {
  const rnd = lcg(seed * 2654435761 + 1);
  const out = { n: 0, gutters: 0, gutterTouched: 0, leftLane: 0, capped: 0, keGainMax: 0, eGainMaxRel: 0, eWorst: null, maxEndS: 0, deckAtMax: 0,
    kicks: 0, hitAfter: 0, toppleAfter: 0, untouched: 0, untouchedFar: 0, driftMaxMm: 0, bumperGutter: 0, bumperBalls: 0, noiseFree: 0, noisy: 0, strikes: 0, failures: [] };
  for (let i = 0; i < n; i++) {
    const job = randomJob(rnd, i, seed);
    const r = L.fromWire(L.toWire(job.release));
    const s = L.simulate(r, job.standing, { seed: job.seed, audit: true, bumpers: job.bumpers });
    out.n++;
    if (!s.standing.length) out.strikes++;
    out.maxEndS = Math.max(out.maxEndS, s.endT);
    if (s.capped) { out.capped++; out.failures.push({ what: "capped", job }); }
    // the lane: the ball is on the lane, in a gutter or in the pit; it never gains energy
    if (s.keGain > out.keGainMax) out.keGainMax = s.keGain;
    if (s.gutterAt === null && s.maxAbsX > L.HALF + 1e-9) { out.leftLane++; out.failures.push({ what: "left the lane", job }); }
    if (job.bumpers) { out.bumperBalls++; if (s.gutterAt !== null) { out.bumperGutter++; out.failures.push({ what: "bumper ball in the gutter", job }); } }
    if (s.gutterAt !== null) {
      out.gutters++;
      if (s.down.length || s.events.some((e) => e.k === "ball" || e.k === "pin" || e.k === "topple")) { out.gutterTouched++; out.failures.push({ what: "gutter ball touched a pin", job }); }
    }
    if (s.audit) {
      const rel = s.audit.eGain / s.audit.e0;
      if (rel > out.eGainMaxRel) { out.eGainMaxRel = rel; out.eWorst = { job, rel }; }
      const lim = (job.bumpers ? D.BUMP_FACE : L.KICK) - L.BALL_R + 0.01;
      if (s.audit.ballMaxAbsX > lim) { out.leftLane++; out.failures.push({ what: "ball through a wall", x: s.audit.ballMaxAbsX, job }); }
    }
    // kickback messengers: a pin off a kickback that then hits another pin (and knocks it down)
    const kicked = {}; let k = false, h = false, tp = false;
    for (const e of s.events) {
      if (e.k === "kick") { if (kicked[e.n] === undefined) kicked[e.n] = e.t; k = true; }
      if (e.k === "pin") for (const [a, b] of [[e.n, e.m], [e.m, e.n]]) if (kicked[a] !== undefined && kicked[a] < e.t) { h = true; if (s.events.some((x) => x.k === "topple" && x.n === b && x.t >= e.t - 5)) tp = true; }
    }
    if (k) out.kicks++; if (h) out.hitAfter++; if (tp) out.toppleAfter++;
    // untouched standing pins stay on their spot
    const touched = new Set();
    for (const e of s.events) { if (e.n) touched.add(e.n); if (e.m) touched.add(e.m); }
    for (const p of s.standing) {
      if (touched.has(p.n)) continue;
      out.untouched++;
      const mm = p.drift * 1000;
      if (mm > out.driftMaxMm) out.driftMaxMm = mm;
      if (mm > 1.5) { out.untouchedFar++; if (out.failures.length < 20) out.failures.push({ what: "untouched pin moved", mm, pin: p.n, job }); }
    }
    // the lane phase is noise-free: another seed gives the same hand-over, bit for bit
    if (i % 25 === 0 && s.hand) {
      const s2 = L.lanePhase(r, { bumpers: job.bumpers });
      if (s2.hand && JSON.stringify(s2.hand) === JSON.stringify(s.hand) && s2.deckAt === s.deckAt) out.noiseFree++; else out.noisy++;
    }
  }
  out.failures = out.failures.slice(0, 20);
  return out;
}

/* test/physics.js (determinism): the SHA-256 of each delivery's whole physics payload (the bytes the phones get). */
function hashes({ from, n }) {
  const out = [];
  for (let i = from; i < from + n; i++) out.push(hashOne(i));
  return out;
}
function detJob(i) {
  const rnd = lcg(777 + i * 31);
  const standing = i % 4 === 3 ? L.spots().filter((p) => [4, 7, 10].includes(p.n)).map((p) => ({ ...p, fresh: false, yaw: 0.1 * p.n })) : L.spots();
  const skill = ["rookie", "regular", "pro"][i % 3];
  return { kind: "bot", skill, botSeed: 5000 + i, standing, seed: (5000 + i) >>> 0, bumpers: i % 10 === 9, hand: i % 7 === 6 ? -1 : 1, rnd };
}
function hashOne(i) {
  const job = detJob(i); delete job.rnd;
  const res = SIM.runJob(job);
  return crypto.createHash("sha256").update(JSON.stringify({ release: res.release, payload: res.payload, summary: res.summary })).digest("hex");
}

/* test/strikemap.js: a calibration cell (WORLD.md 3.4's protocol): N balls whose straight line crosses the head pin's row
   at board b (±0.5) with entry angle a (±0.5), 7.5 m/s (±0.3), rolling along the entry line, started 0.35 m before the
   deck line. */
function cell({ b, a, N, seed, speed = 7.5 }) {
  const rnd = lcg(seed); let strikes = 0, splits = 0, pins = 0; const leaves = {};
  for (let i = 0; i < N; i++) {
    const bb = b + (rnd() - 0.5), aa = a + (rnd() - 0.5), sp = speed + (rnd() - 0.5) * 0.6;
    const ang = -aa;                                                  // a right-hander's ball moves left into the 1-3
    const y0 = L.DECK_Y - 0.35;
    const x = bx(bb) - Math.tan(ang * Math.PI / 180) * (L.HEAD_Y - y0);
    const s = L.simulate({ x, angle: ang, speed: sp, spin: 0 }, L.spots(), { y0, rollAlong: true, noClamp: true, seed: (seed * 7919 + i) >>> 0 });
    const left = s.standing.map((p) => p.n);
    if (!left.length) strikes++; if (S.isSplit(left)) splits++; pins += 10 - left.length;
    const k = left.join("-") || "X"; leaves[k] = (leaves[k] || 0) + 1;
  }
  return { strikes, splits, pins, N, leaves };
}

/* test/bots.js: one whole game by one player: who = "bot" (skill), "human" (prof) or "timeout" (every ball timed out). */
function game({ who, skill, prof, seed, frames = 10, hand = 1, style = null, form = false }) {
  const rnd = lcg(seed); const st = style ? B.STYLES[style] : null; let formNow = 0; const balls = []; let strikes = 0, spares = 0, splits = 0, gutters = 0, outside = 0;
  for (let f = 0; f < frames; f++) {
    let standing = L.spots(); const last = f === frames - 1; let fresh = true; const fb = [];
    for (;;) {
      let mul = 1; if (who === "bot" && form) { formNow = B.formStep(formNow, st ? st.vol : 1, rnd); mul = B.formMul(formNow, last); }
      const rel = who === "bot" ? B.choose(standing, skill, rnd, hand, st, mul) : who === "human" ? B.human(standing, prof, rnd, hand) : B.timeoutBall();
      const w = L.toWire(rel);
      if (Math.abs(rel.x) > 0.40 + 1e-9 || Math.abs(rel.angle) > 3.5 + 1e-9 || rel.speed < 5.4 - 1e-9 || rel.speed > 9.8 + 1e-9 || Math.abs(rel.spin) > 1 + 1e-9) outside++;
      const s = L.simulate(L.fromWire(w), standing, { seed: (seed * 131 + balls.length) >>> 0 });
      const down = standing.length - s.standing.length; balls.push(down); fb.push(down);
      const cleared = !s.standing.length;
      if (who === "bot" && form) formNow = B.formAfter(formNow, cleared ? (fresh ? "strike" : "spare") : s.gutterAt !== null ? "gutter" : "", down);
      if (fresh && cleared) strikes++; else if (!fresh && cleared) spares++;
      if (fresh && S.isSplit(s.standing.map((p) => p.n))) splits++;
      if (s.gutterAt !== null) gutters++;
      const ab = S.afterBall(fb, cleared, last);
      if (ab.over) break;
      if (ab.fresh) { standing = L.spots(); fresh = true; } else { standing = s.standing.map((p) => ({ ...p, fresh: false })); fresh = false; }
    }
  }
  return { total: S.card(balls, frames).total, strikes, spares, splits, gutters, balls: balls.length, outside };
}

/* tools and test/load.js: n deliveries' sizes and CPU, as the server makes them. */
function sizes({ from, n }) {
  const out = [];
  for (let i = from; i < from + n; i++) { const job = detJob(i); delete job.rnd; const r = SIM.runJob(job); out.push({ bytes: r.bytes, cpuMs: r.cpuMs, playMs: r.payload.playMs }); }
  return out;
}

/* test/pool.js: hold the worker for ms (a hung physics job), and report which process ran a job. */
function spin({ ms }) { const t = Date.now(); while (Date.now() - t < ms) { /* busy */ } return { pid: process.pid }; }
function whoami() { return { pid: process.pid, thread: require("worker_threads").threadId }; }

function mem() { const m = process.memoryUsage(); const v = require("v8").getHeapStatistics(); return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers, mallocedMemory: v.malloced_memory, peakMalloced: v.peak_malloced_memory, codeSpace: (require("v8").getHeapSpaceStatistics().find((x) => x.space_name === "code_space") || {}).space_size }; }

const TASKS = { random, hashes, cell, game, sizes, spin, whoami, mem };
function run(job) { const f = TASKS[job.task]; if (!f) throw new Error("no task " + job.task); return f(job); }
module.exports = { run, random, hashes, hashOne, detJob, cell, game, sizes, randomJob, lcg, spin, whoami };
