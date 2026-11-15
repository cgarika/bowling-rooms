/* One ball, as a job: the release (a human's from the wire, a bot's chosen here, or the timeout ball), the lane
   phase, the 3D deck phase and the delivery's physics payload. Runs in a pool worker (pool_worker.js) or, if the pool
   ever fails, in the main thread. Pure: the same job gives the same bytes. */
"use strict";
const L = require("./lane");
const B = require("./bot");
const T = require("./track");
const D = require("./deck3d");

const MPH = 2.2369362920544;
/* This thread's CPU (a worker's own, not the whole process's), where Node has it; the wall clock otherwise. */
const threadCpu = typeof process.threadCpuUsage === "function" ? () => { const c = process.threadCpuUsage(); return (c.user + c.system) / 1000; } : () => performance.now();

/* job: {kind: "human" | "bot" | "timeout", release (wire integers, humans), skill + botSeed (bots),
   standing: [{n, x, y, yaw?, fresh?}], seed (uint32), bumpers, hand (+1 right, -1 left)}.
   Returns {release (wire), payload (the delivery's physics half), bytes, summary, cpuMs}. */
function runJob(job) {
  const c0 = threadCpu();
  let wire;
  if (job.kind === "bot") wire = L.toWire(B.choose(job.standing, job.skill, D.mulberry(job.botSeed >>> 0), job.hand || 1, B.STYLES[job.style] || null, job.formMul || 1));
  else if (job.kind === "timeout") wire = L.toWire(B.timeoutBall());
  else wire = L.wireRelease(job.release, job.speedMax || 0);
  if (!wire) throw new Error("bad release");
  const s = L.simulate(L.fromWire(wire), job.standing, { seed: job.seed >>> 0, record: true, bumpers: !!job.bumpers, speedMax: job.speedMax || 0 });
  const { bytes, ...payload } = T.physicsPayload(s);
  const hand = job.hand === -1 ? -1 : 1;
  const summary = {
    down: s.down, gutter: s.gutterAt !== null, capped: !!s.capped,
    standing: s.standing.map((p) => ({ n: p.n, x: p.x, y: p.y, yaw: p.yaw })),
    mph: +(s.release.speed * MPH).toFixed(1),
    entryBoard: s.entry ? +L.boardAtHead(s.entry).toFixed(1) : null,
    entryAngle: s.entry ? +(-s.entry.angle * hand).toFixed(1) : null,
  };
  return { release: wire, payload, bytes, summary, cpuMs: +(threadCpu() - c0).toFixed(2) };
}

/* The last resort when the physics itself failed twice: the ball rolls through and touches nothing. The table goes
   on (a stuck room is worse than one dead ball); the server logs it. */
function deadBall(job) {
  const wire = job.release ? (L.wireRelease(job.release, job.speedMax || 0) || L.toWire(B.timeoutBall())) : L.toWire(B.timeoutBall());
  const placed = D.placeRack(job.standing, job.seed >>> 0, L.PARAMS);
  const standing = placed.map((p) => ({ n: p.n, x: +p.x.toFixed(4), y: +p.y.toFixed(4), yaw: +p.yaw.toFixed(3) }));
  const payload = {
    fmt: T.FMT, seed: job.seed >>> 0, before: placed.map(T.pinRow), deckAt: null, playMs: 3000, ev: [], down: [],
    standing: standing.map(T.pinRow), gutter: false, ball: "", pins: {}, thin: 0, dead: true,
  };
  return { release: wire, payload, bytes: Buffer.byteLength(JSON.stringify(payload)), summary: { down: [], gutter: false, capped: false, standing, mph: +(wire.speed / 1000 * MPH).toFixed(1), entryBoard: null, entryAngle: null, dead: true }, cpuMs: 0 };
}

module.exports = { runJob, deadBall, MPH };
