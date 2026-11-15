/* The lane phase (the release to the deck line) and one whole delivery.

   The lane phase is the analytic ball of WORLD.md 3.4 on the oil pattern: it has NO noise at all, so any phone can
   compute where a release reaches the deck, exactly as this does, from the same quantised release (BowlingCore, the
   C++ port). The deck phase (the deck line to the pit) is deck3d.js on deterministic Rapier.

   The release on the wire is integers (WORLD.md 3.2): x in 0.1 mm, angle in 0.001 degree, speed in mm/s, spin in
   0.001. fromWire() turns them into doubles by DIVISION (x / 1e4, not x * 1e-4: the two differ in the last bit),
   and the phone must do the same so both start from the same doubles.

   The one parameter set is calib_best.json (WORLD.md 3.4 quotes it; test/physics.js checks its SHA-256).
   x across the lane (+ is the bowler's right), y down the lane from the foul line, z up. Deterministic. */
"use strict";
const path = require("path");
const D = require("./deck3d");
const IN = 0.0254, FT = 0.3048, G = 9.81;
const { HALF, GUTTER, KICK, BOARD, HEAD_Y, PIT_Y, DECK_Y, BALL_R, BUMP_X, BUMP_E } = D;
const ROW = 12 * IN * Math.sin(Math.PI / 3), SPACING = 12 * IN;
const BALL_M = 6.8, BALL_I = 6.8 * Math.pow(2.55 * IN, 2);
const PIN_R = 4.766 * IN / 2;
const OIL_Y = 40 * FT, OIL_TAPER = 1.0, MU_OIL = 0.02, MU_OIL_OUT = 0.035, MU_DRY = 0.20;
const PARAMS = Object.freeze(require(path.join(__dirname, "calib_best.json")));   // the one parameter set
const WYMAX = 26, ROLL0 = 0.25;
const DT = 1 / 480, REC = 16;                                        // the lane phase at 480 Hz, recorded at 30 Hz
/* The clamps (WORLD.md 3.2), in wire units and in doubles. */
const CLAMP = Object.freeze({ x: 4000, angle: 3500, speedMin: 5400, speedMax: 9800, spin: 1000 });

function spots() { return D.rackSpots().map((p) => ({ ...p, fresh: true })); }
function mu(x, y) {
  if (y >= DECK_Y) return PARAMS.MU_BALL_DECK;
  const inner = Math.abs(x) < 0.27 ? MU_OIL : MU_OIL_OUT;
  if (y <= OIL_Y) return inner;
  if (y >= OIL_Y + OIL_TAPER) return MU_DRY;
  const t = (y - OIL_Y) / OIL_TAPER; return inner + (MU_DRY - inner) * t;
}
function clampI(v, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(v))); }
/* A release from the wire: every field a finite number, rounded to an integer and clamped. Returns null when any
   field is missing or not finite (the server answers "Bad throw."). speedMax: the seat's own cap in mm/s (gear step 4: the base 9,800 raised by its ball's Power, gear.js bowlingEffects), the base when 0. */
function wireRelease(t, speedMax) {
  if (!t || typeof t !== "object") return null;
  const f = ["x", "angle", "speed", "spin"].map((k) => (typeof t[k] === "number" ? t[k] : NaN));
  if (!f.every(Number.isFinite)) return null;
  const cap = speedMax > 0 ? Math.max(CLAMP.speedMin, speedMax) : CLAMP.speedMax;
  return { x: clampI(f[0], -CLAMP.x, CLAMP.x), angle: clampI(f[1], -CLAMP.angle, CLAMP.angle), speed: clampI(f[2], CLAMP.speedMin, cap), spin: clampI(f[3], -CLAMP.spin, CLAMP.spin) };
}
/* Doubles (m, degrees, m/s, -1..1) to the wire's integers, clamped: how a bot's or the timeout ball's release is sent. */
function toWire(r, speedMax) { return wireRelease({ x: r.x * 1e4, angle: r.angle * 1e3, speed: r.speed * 1e3, spin: r.spin * 1e3 }, speedMax); }
function fromWire(w) { return { x: w.x / 1e4, angle: w.angle / 1e3, speed: w.speed / 1e3, spin: w.spin / 1e3 }; }
/* The old prototype's float quantisation, for the aim table and the calibration cells (same grid as the wire). */
function quantise(r) { return { x: Math.round(r.x * 1e4) / 1e4, angle: Math.round(r.angle * 1e3) / 1e3, speed: Math.round(r.speed * 1e3) / 1e3, spin: Math.round(r.spin * 1e3) / 1e3 }; }
function hash32(...v) { let h = 2166136261 >>> 0; for (const x of v) { const s = String(x); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } } return h; }
/* The physics seed of a person's ball (bowling-plato, 2026-11-04: "the same way as Plato", whose recorded swipe replayed gives the same fall every
   time): a function of the release as the wire carries it and of which pins stand, so the same swipe at the same rack jitters the fresh rack the same
   way and knocks down the same pins. It is the seed simulate() falls back to when it is given none, so a release played offline and one played by a
   room agree. */
function releaseSeed(wire, standing, speedMax) { const r = fromWire(toWire(fromWire(wire), speedMax)); return hash32(r.x, r.angle, r.speed, r.spin, standing.map((p) => p.n).join(".")); }

/* The ball's pose on the lane, for the phone to roll it and for Rapier to take it over without a jump (WORLD.md 4.7):
   it starts with its holes up (+z) and its grip along the release line (a turn of -angle about z), and each lane step
   turns it by the world-frame spin w = (wx, wy, 0): q += dt/2 * (0, w) q, then q is normalised. */
function poseStart(angleDeg) { const a = -angleDeg * Math.PI / 180; return { x: 0, y: 0, z: Math.sin(a / 2), w: Math.cos(a / 2) }; }
function poseStep(q, wx, wy, dt) {
  const h = dt / 2;
  // (0, w) * q with w = (wx, wy, 0):
  const dw = -wx * q.x - wy * q.y, dx = wx * q.w + wy * q.z, dy = wy * q.w - wx * q.z, dz = wx * q.y - wy * q.x;
  let x = q.x + h * dx, y = q.y + h * dy, z = q.z + h * dz, w = q.w + h * dw;
  const n = Math.sqrt(x * x + y * y + z * z + w * w); x /= n; y /= n; z /= n; w /= n;
  return { x, y, z, w };
}

/* The lane phase alone: from the release (doubles) to the deck line, or into the gutter and on to the pit (or, with no
   pins, on to the pit). opts: {bumpers, noPins, noPose (the aim table: no pose needed), y0, roll0, rollAlong, axis, audit}. */
function lanePhase(r, opts = {}) {
  const a = r.angle * Math.PI / 180;
  const b = { x: r.x, y: opts.y0 || 0, vx: Math.sin(a) * r.speed, vy: Math.cos(a) * r.speed, wx: 0, wy: -r.spin * WYMAX, state: "lane" };
  b.wx = -(opts.roll0 !== undefined ? opts.roll0 : ROLL0) * b.vy / BALL_R;
  if (opts.rollAlong) { b.wx = -b.vy / BALL_R; b.wy = b.vx / BALL_R + (opts.axis || 0); }   // calibration cells: rolling along the entry line
  let q = poseStart(r.angle);
  const trackB = [], events = []; let t = 0, step = 0, deckAt = null, gutterAt = null, entry = null, hand = null, maxAbsX = 0;
  const ke = () => 0.5 * BALL_M * (b.vx * b.vx + b.vy * b.vy) + 0.5 * BALL_I * (b.wx * b.wx + b.wy * b.wy);
  let keLast = opts.audit ? ke() : 0, keGain = 0;
  while (t < 9) {
    if (b.state === "lane" || (b.state === "deck" && opts.noPins)) {
      const ux = b.vx - BALL_R * b.wy, uy = b.vy + BALL_R * b.wx, u = Math.hypot(ux, uy);
      const m = mu(b.x, b.y);
      if (u > 1e-4) {
        const f = Math.min(m * G, u / (DT * (1 / BALL_M + BALL_R * BALL_R / BALL_I) * BALL_M));
        const fx = -f * ux / u * BALL_M, fy = -f * uy / u * BALL_M;
        b.vx += fx / BALL_M * DT; b.vy += fy / BALL_M * DT;
        b.wx += (BALL_R * fy) / BALL_I * DT; b.wy += (-BALL_R * fx) / BALL_I * DT;
      }
      b.x += b.vx * DT; b.y += b.vy * DT;
      if (b.state === "lane" && !opts.noPose) q = poseStep(q, b.wx, b.wy, DT);
      if (b.state === "lane" && opts.bumpers && Math.abs(b.x) > BUMP_X) {
        const s = Math.sign(b.x);
        if (Math.sign(b.vx) === s) { events.push({ t: Math.round(t * 1000), k: "bumper", s: +Math.min(1, Math.abs(b.vx) / 2).toFixed(2) }); b.vx = -BUMP_E * b.vx; }
        b.x = s * BUMP_X;
      }
      if (Math.abs(b.x) > maxAbsX && b.state === "lane") maxAbsX = Math.abs(b.x);
      if (b.state === "lane" && Math.abs(b.x) > HALF) { b.state = "gutter"; gutterAt = t; events.push({ t: Math.round(t * 1000), k: "gutter" }); }
      if (b.state === "lane" && b.y >= DECK_Y) {
        b.state = "deck"; deckAt = t; entry = { x: b.x, angle: Math.atan2(b.vx, b.vy) * 180 / Math.PI, speed: Math.hypot(b.vx, b.vy) };
        hand = { x: b.x, y: b.y, vx: b.vx, vy: b.vy, wx: b.wx, wy: b.wy, wz: 0, t, q };
        if (!opts.noPins) { trackB.push([Math.round(t * 1000), Math.round(b.x * 1000), Math.round(b.y * 1000)]); break; }
      }
      if (opts.audit && b.state === "lane") { const k = ke(); if (k - keLast > keGain) keGain = k - keLast; keLast = k; }
    } else if (b.state === "gutter") {
      b.x = Math.sign(b.x) * (HALF + GUTTER / 2); b.vx = 0; b.y += b.vy * DT; b.vy = Math.max(1.0, b.vy - 0.05 * G * DT);
    }
    if (b.state !== "pit" && b.y > PIT_Y) { b.state = "pit"; events.push({ t: Math.round(t * 1000), k: "pit" }); }
    if (step % REC === 0) trackB.push([Math.round(t * 1000), Math.round(b.x * 1000), Math.round(b.y * 1000)]);
    if (b.state === "pit" && t > (deckAt || gutterAt || 0) + 0.3) break;
    t += DT; step++;
  }
  const out = { b, trackB, events, deckAt, gutterAt, entry, hand, endT: t, maxAbsX };
  if (opts.audit) out.keGain = keGain;
  return out;
}

/* The board a line crosses at the head pin's row (boards counted from the right edge; board 20 is the middle). */
function boardAtHead(entry) { return 20 - (entry.x + Math.tan(entry.angle * Math.PI / 180) * (HEAD_Y - DECK_Y)) / BOARD; }

/* One delivery. release: doubles {x (m), angle (deg, + right), speed (m/s), spin (-1..1, + hooks left)}, already on
   the wire's grid; standing: [{n, x, y, yaw?, fresh?}].
   opts: {seed, record, bumpers, audit, speedMax (the seat's cap, gear step 4)} and, for calibration cells only, {y0, roll0, rollAlong, axis, noClamp}.
   The deck phase runs in this thread: call `await init()` once first (a pool worker does). */
function simulate(release, standing, opts = {}) {
  const r = opts.noClamp ? quantise(release) : fromWire(toWire(release, opts.speedMax));
  if (opts.noClamp) r.x = +release.x;
  const L = lanePhase(r, { ...opts, noPins: !standing.length });
  const out = { release: r, deckAt: L.deckAt, gutterAt: L.gutterAt, entry: L.entry, hand: L.hand, trackB: L.trackB, events: L.events.slice(), firstContact: null, endT: L.endT, maxAbsX: L.maxAbsX, keGain: L.keGain };
  const seed = opts.seed !== undefined ? opts.seed >>> 0 : hash32(r.x, r.angle, r.speed, r.spin, standing.map((p) => p.n).join("."));
  out.seed = seed;
  if (!standing.length || !L.hand) {                                  // no pins, or a gutter ball: nothing on the deck moves
    out.placed = D.placeRack(standing, seed, PARAMS);
    out.down = []; out.standing = out.placed.map((p) => ({ n: p.n, x: +p.x.toFixed(4), y: +p.y.toFixed(4), yaw: +p.yaw.toFixed(3), moved: false, drift: 0 }));
    out.track3d = opts.record ? { ball: [], pins: {} } : null; out.capped = false;
    return out;
  }
  const d = D.run(L.hand, standing.map((p) => ({ n: p.n, x: p.x, y: p.y, yaw: p.yaw, fresh: !!p.fresh })), PARAMS,
    { seed, record: !!opts.record, t0: Math.round(L.hand.t * 1000), bumpers: !!opts.bumpers, audit: !!opts.audit });
  out.placed = d.placed;
  out.down = d.down; out.standing = d.standing; out.events = out.events.concat(d.events);
  out.firstContact = d.firstContact === null ? null : L.hand.t + d.firstContact;
  out.endT = L.hand.t + d.endT; out.ballPitAt = d.ballPitAt === null ? null : L.hand.t + d.ballPitAt; out.maxTilt = d.maxTilt; out.capped = d.capped;
  if (d.audit) out.audit = d.audit;
  if (opts.record) out.track3d = { ball: d.trackBall, pins: d.trackPins };
  return out;
}
async function init() { await D.init(); }
module.exports = {
  PARAMS, CLAMP, simulate, lanePhase, quantise, wireRelease, toWire, fromWire, boardAtHead, poseStart, poseStep, spots, init, hash32, releaseSeed,
  HALF, GUTTER, KICK, BOARD, HEAD_Y, PIT_Y, DECK_Y, BALL_R, PIN_R, ROW, SPACING, WYMAX, BUMP_X, BUMP_E, DT,
};
