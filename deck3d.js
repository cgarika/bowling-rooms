/* The deck phase: the pin deck in true 3D on deterministic Rapier
   (@dimforge/rapier3d-deterministic-compat 0.21.0, Apache-2.0, pinned exactly in package.json).

   lane.js hands the ball over at the deck line (0.30 m before the head pin) with its full state: position,
   velocity, spin and its integrated pose. From there Rapier owns the ball, the pins, the deck, the gutters, the
   kickbacks, the pit and its cushion. Grown from the round-2 prototype (WORLD.md 3.4); the one parameter set is
   calib_best.json (its SHA-256 is checked by test/physics.js).

   Same inputs, same bits: the seed only jitters the spots of a fresh rack (±SPOT_MM) and gives its pins their yaws.
   Units: metres, seconds, kilograms. x across the lane (+ is the bowler's right), y down the lane from the foul line,
   z up. */
"use strict";
const RAPIER = require("@dimforge/rapier3d-deterministic-compat");

const IN = 0.0254, FT = 0.3048, G = 9.81;
const HALF = 41.5 * IN / 2, GUTTER = 9.25 * IN, KICK = HALF + GUTTER, BOARD = 41.5 * IN / 39;
const HEAD_Y = 60 * FT, PIT_Y = HEAD_Y + 34.1875 * IN, ROW = 12 * IN * Math.sin(Math.PI / 3), SPACING = 12 * IN;
const DECK_Y = HEAD_Y - 0.30;
const BALL_R = 8.5 * IN / 2, BALL_M = 6.8, BALL_K = 2.55 * IN;
const PIN_M = 1.55, PIN_H = 15 * IN, PIN_COM = 5.81 * IN;         // USBC: 3 lb 6 oz to 3 lb 10 oz; CG 5 5/8 to 5 15/16 in
const GUT_DEPTH = 1.875 * IN;
/* Bumpers (a per-player option): a rail in each gutter whose face is 3 cm outside the lane's edge. The ball's centre
   can never get further out than BUMP_X, so a bumper ball never reaches the gutter. The lane phase reflects the
   ball's sideways speed at BUMP_X with restitution BUMP_E; the deck phase has a collider for the ball only. */
const BUMP_FACE = HALF + 0.03, BUMP_X = BUMP_FACE - BALL_R, BUMP_E = 0.3;
// The USBC pin profile (radius, height) in inches: base 2.031 in, belly 4.766 in at 4.5 in, neck 1.797 in at 10 in, head 2.547 in.
const PROFILE = [[1.016, 0.0], [1.414, 0.75], [1.953, 2.25], [2.255, 3.375], [2.383, 4.5], [2.28, 5.875], [1.85, 7.25], [1.236, 8.625],
  [0.98, 9.375], [0.899, 10.0], [0.935, 10.875], [1.047, 11.75], [1.203, 12.625], [1.273, 13.5], [1.04, 14.375], [0.55, 14.85], [0.0, 15.0]];
/* Colliders: an exact cylinder for the base (a polygon base rocks on Rapier's contact manifold and a lone pin falls
   over by itself in about 2 s; a cylinder stands, wobbles and rights itself), then three convex lathe hulls, so the
   neck stays waisted. */
const BASE_H = 0.75, BASE_R = 1.016;
const PIECES = [PROFILE.slice(1, 5), PROFILE.slice(4, 10), PROFILE.slice(9)];

let ready = false;
async function init() { if (!ready) { await RAPIER.init(); ready = true; } }
function isReady() { return ready; }

function lathe(prof, seg) {
  const pts = [];
  for (const [r, h] of prof) {
    if (r < 1e-3) { pts.push(0, 0, h * IN); continue; }
    for (let i = 0; i < seg; i++) { const a = 2 * Math.PI * (i + 0.5) / seg; pts.push(r * IN * Math.cos(a), r * IN * Math.sin(a), h * IN); }
  }
  return new Float32Array(pts);
}
// The pin's inertia from its real shape (discs of the profile), scaled to its mass, about the USBC centre of gravity.
function pinInertia() {
  let m = 0, izz = 0, ixx0 = 0; const dz = 0.01 * IN;
  for (let h = 0; h < 15; h += 0.01) {
    let r = 0;
    for (let k = 1; k < PROFILE.length; k++) { const [r0, h0] = PROFILE[k - 1], [r1, h1] = PROFILE[k]; if (h >= h0 && h <= h1) { r = (r0 + (r1 - r0) * (h - h0) / (h1 - h0)) * IN; break; } }
    const dm = Math.PI * r * r * dz, z = h * IN; m += dm; izz += dm * r * r / 2; ixx0 += dm * (r * r / 4 + z * z);
  }
  const k = PIN_M / m; return { ia: izz * k, it: ixx0 * k - PIN_M * PIN_COM * PIN_COM };
}
const PI_ = pinInertia();

/* The ten spots, numbered as bowlers number them: 1 the head pin, 7 to 10 the back row from left to right. */
function rackSpots() { const P = []; let n = 1; for (let r = 0; r < 4; r++) for (let k = 0; k <= r; k++) P.push({ n: n++, x: (k - r / 2) * SPACING, y: HEAD_Y + r * ROW }); return P; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const QX = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };        // turns a cylinder's y axis onto z
function quatZ(yaw) { return { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) }; }
function upZ(q) { return 1 - 2 * (q.x * q.x + q.y * q.y); }         // the pin's axis against world up

/* Where the pins really start: a fresh pin gets the seed's jitter on its spot and the seed's yaw; a pin still standing
   from the previous ball keeps its position and yaw exactly. The seed is consumed in the same order either way (two
   draws per pin, a third for a pin without a yaw), so the delivery's `before` is these poses. */
function placeRack(standing, seed, P) {
  const rnd = mulberry(seed || 1), out = [];
  for (const s of standing) {
    const jx = (rnd() - 0.5) * 2 * P.SPOT_MM / 1000, jy = (rnd() - 0.5) * 2 * P.SPOT_MM / 1000;
    const yaw = s.yaw !== undefined && s.yaw !== null ? s.yaw : rnd() * 2 * Math.PI;
    out.push({ n: s.n, x: s.x + (s.fresh ? jx : 0), y: s.y + (s.fresh ? jy : 0), yaw, x0: s.x, y0: s.y });
  }
  return out;
}

/* ball: {x, y, vx, vy, wx, wy, wz, q} at the deck line (z is the ball's radius); standing: [{n, x, y, yaw?, fresh?}];
   P: the parameter set; opts: {seed, record (the 6-DoF track), t0 (ms of the hand-over from release), bumpers, audit}.
   Returns who is down and standing, the events, and (record) the samples: [t ms, x, y, z, qx, qy, qz, qw, key]. */
function run(ball, standing, P, opts = {}) {
  if (!ready) throw new Error("deck3d: call init() first");
  const world = new RAPIER.World({ x: 0, y: 0, z: -G });
  world.timestep = 1 / P.HZ;
  world.integrationParameters.numSolverIterations = P.ITER;
  const eq = new RAPIER.EventQueue(true);
  const owner = new Map();                                            // collider handle -> what it is
  const R = RAPIER.CoefficientCombineRule;
  // Collision groups: the ball and the pins each meet their own deck, so every pair's coefficients are set exactly.
  const BALL = 1, PIN = 2, DECK_B = 4, DECK_P = 8, KICKG = 16, PITG = 32, GUTG = 64, BUMPG = 128;
  const grp = (memb, filt) => ((memb & 0xffff) << 16) | (filt & 0xffff);
  const fixed = (hx, hy, hz, x, y, z, kind, groups, fr, frRule, re, reRule) => {
    const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
    const c = world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(fr).setFrictionCombineRule(frRule)
      .setRestitution(re).setRestitutionCombineRule(reRule).setCollisionGroups(groups), b);
    owner.set(c.handle, { kind });
    return c;
  };
  const y0 = DECK_Y - 0.6, y1 = PIT_Y;
  // the lane's end and the pin deck: one surface for the ball (its grip drives the hook through the pins), one for the pins
  fixed(HALF, (y1 - y0) / 2, 0.05, 0, (y0 + y1) / 2, -0.05, "deck", grp(DECK_B, BALL), P.FR_BD, R.Max, 0.1, R.Average);
  fixed(HALF, (y1 - y0) / 2, 0.05, 0, (y0 + y1) / 2, -0.05, "deck", grp(DECK_P, PIN), P.FR_PD, P.FR_PD >= P.FR_PIN ? R.Max : R.Min, P.RE_PD, R.Min);
  for (const s of [-1, 1]) {
    fixed(GUTTER / 2, (y1 - y0 + 0.2) / 2, 0.05, s * (HALF + GUTTER / 2), (y0 + y1 + 0.2) / 2, -0.05 - GUT_DEPTH, "gutter", grp(GUTG, BALL | PIN), 0.35, R.Average, 0.15, R.Min);
    fixed(0.03, (PIT_Y + 0.9 - (HEAD_Y - 0.75)) / 2, 0.40, s * (KICK + 0.03), (PIT_Y + 0.9 + HEAD_Y - 0.75) / 2, 0.32, "kick", grp(KICKG, BALL | PIN), P.FR_KICK, R.Average, P.RE_PK, R.Min);
    if (opts.bumpers) {
      const c = fixed(0.02, (y1 - y0) / 2, 0.10, s * (BUMP_FACE + 0.02), (y0 + y1) / 2, 0.06, "bumper", grp(BUMPG, BALL), 0.2, R.Min, BUMP_E, R.Min);
      c.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    }
  }
  fixed(KICK + 0.1, 0.5, 0.05, 0, PIT_Y + 0.5, -0.30 - 0.05, "pit", grp(PITG, PIN), 0.8, R.Max, 0.02, R.Min);               // the pit floor
  fixed(KICK + 0.1, 0.02, 0.45, 0, PIT_Y + 0.62, 0.20, "curtain", grp(PITG, PIN), 0.8, R.Max, 0.02, R.Min);                  // the pit cushion
  // pins
  const placed = placeRack(standing, opts.seed, P);
  const pins = [];
  for (const s of placed) {
    const b = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(s.x, s.y, 0.0002).setRotation(quatZ(s.yaw))
      .setAdditionalMassProperties(PIN_M, { x: 0, y: 0, z: PIN_COM }, { x: PI_.it, y: PI_.it, z: PI_.ia }, { x: 0, y: 0, z: 0, w: 1 })
      .setAngularDamping(P.PIN_ANG_DAMP || 0).setCcdEnabled(!!P.PIN_CCD).setCanSleep(true));
    const descs = [RAPIER.ColliderDesc.cylinder(BASE_H / 2 * IN, BASE_R * IN).setRotation(QX).setTranslation(0, 0, BASE_H / 2 * IN)]
      .concat(PIECES.map((pc) => RAPIER.ColliderDesc.convexHull(lathe(pc, P.SEG))));
    descs.forEach((d, i) => {
      const c = world.createCollider(d.setDensity(0).setFriction(P.FR_PIN).setRestitution(P.RE_PIN)
        .setCollisionGroups(grp(PIN, BALL | PIN | DECK_P | KICKG | PITG | GUTG)).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), b);
      owner.set(c.handle, { kind: "pin", n: s.n, piece: i });
    });
    pins.push({ n: s.n, b, x0: s.x, y0: s.y, maxTilt: 0, toppled: false, landed: false, gutter: false, pit: false, kicked: 0, moved: false });
  }
  // the ball (removed when it drops into the pit: the cushion stops it, and the phone animates the drop)
  const bm = P.BALL_KG || BALL_M, bi = bm * BALL_K * BALL_K;
  const bd = RAPIER.RigidBodyDesc.dynamic().setTranslation(ball.x, ball.y, BALL_R + 0.0002)
    .setLinvel(ball.vx, ball.vy, 0).setAngvel({ x: ball.wx, y: ball.wy, z: ball.wz || 0 })
    .setAdditionalMassProperties(bm, { x: 0, y: 0, z: 0 }, { x: bi, y: bi, z: bi }, { x: 0, y: 0, z: 0, w: 1 })
    .setCcdEnabled(true).setCanSleep(true);
  if (ball.q) bd.setRotation(ball.q);
  const bb = world.createRigidBody(bd);
  const bc = world.createCollider(RAPIER.ColliderDesc.ball(BALL_R).setDensity(0).setFriction(P.FR_BP).setFrictionCombineRule(R.Min)
    .setRestitution(P.RE_BP).setRestitutionCombineRule(R.Max).setCollisionGroups(grp(BALL, PIN | DECK_B | KICKG | GUTG | BUMPG))
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), bb);
  owner.set(bc.handle, { kind: "ball" });
  const byN = new Map(pins.map((p) => [p.n, p]));

  const dt = 1 / P.HZ, recEvery = Math.round(P.HZ / 30), t0 = opts.t0 || 0;
  const events = [], trackBall = [], trackPins = {};
  let t = 0, step = 0, quiet = 0, ballPitAt = null, firstContact = null, ballGone = false, capped = true;
  // audit (tests only): the deck's mechanical energy never rises above where it started
  let e0 = null, eGain = 0, ballMaxAbsX = 0, ballMinZ = Infinity;
  const energy = () => {
    let e = 0;
    const bodies = pins.filter((p) => !p.pit).map((p) => ({ b: p.b, m: PIN_M, it: PI_.it, ia: PI_.ia, com: PIN_COM }));
    if (!ballGone) bodies.push({ b: bb, m: bm, it: bi, ia: bi, com: 0 });
    for (const { b, m, it, ia, com } of bodies) {
      const v = b.linvel(), w = b.angvel(), q = b.rotation(), p = b.translation();
      // the angular velocity in the body frame (q* w q), so the principal inertia applies
      const wb = rotInv(q, w);
      const zc = p.z + com * upZ(q);                                  // the centre of mass is `com` up the pin's axis
      e += 0.5 * m * (v.x * v.x + v.y * v.y + v.z * v.z) + 0.5 * (it * (wb.x * wb.x + wb.y * wb.y) + ia * wb.z * wb.z) + m * G * zc;
    }
    return e;
  };
  if (opts.audit) e0 = energy();
  const relSpeed = (a, b) => { const va = a.linvel(), vb = b ? b.linvel() : { x: 0, y: 0, z: 0 }; return Math.hypot(va.x - vb.x, va.y - vb.y, va.z - vb.z); };
  const sample = (list, body, tt, key) => { const p = body.translation(), q = body.rotation(); list.push([Math.round(tt * 1000) + t0, p.x, p.y, p.z, q.x, q.y, q.z, q.w, key ? 1 : 0]); };
  while (t < P.MAX_S) {
    world.step(eq);
    t += dt; step++;
    const keys = new Set();
    eq.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const A = owner.get(h1), B = owner.get(h2); if (!A || !B) return;
      const rank = (k) => (k === "ball" ? 0 : k === "pin" ? 1 : 2);
      const [a, b] = rank(A.kind) <= rank(B.kind) ? [A, B] : [B, A];
      const ms = Math.round(t * 1000) + t0;
      if (a.kind === "ball" && b.kind === "pin") {
        const p = byN.get(b.n); const s = Math.min(1, relSpeed(bb, p.b) / 8);
        if (firstContact === null) firstContact = t;
        events.push({ t: ms, k: "ball", n: b.n, s: +s.toFixed(2) }); keys.add("b"); keys.add(b.n);
      } else if (a.kind === "pin" && b.kind === "pin") {
        if (a.n === b.n) return;
        const pa = byN.get(a.n), pb = byN.get(b.n); const s = Math.min(1, relSpeed(pa.b, pb.b) / 4);
        if (s < 0.03) return;
        const [m1, m2] = a.n < b.n ? [a.n, b.n] : [b.n, a.n];
        const last = events.length && events[events.length - 1];
        if (!(last && last.k === "pin" && last.n === m1 && last.m === m2 && ms - last.t < 40)) { events.push({ t: ms, k: "pin", n: m1, m: m2, s: +s.toFixed(2) }); keys.add(a.n); keys.add(b.n); }
      } else if (a.kind === "pin" && b.kind === "deck" && a.piece === 3) {
        const p = byN.get(a.n); if (!p.landed) { p.landed = true; events.push({ t: ms, k: "land", n: a.n, s: +Math.min(1, relSpeed(p.b) / 3 + 0.3).toFixed(2) }); keys.add(a.n); }
      } else if (a.kind === "pin" && b.kind === "kick") {
        const p = byN.get(a.n); if (p.kicked < 3) { p.kicked++; events.push({ t: ms, k: "kick", n: a.n, s: +Math.min(1, relSpeed(p.b) / 3).toFixed(2) }); keys.add(a.n); }
      } else if (a.kind === "ball" && b.kind === "kick") {
        events.push({ t: ms, k: "bkick", s: +Math.min(1, relSpeed(bb) / 8).toFixed(2) }); keys.add("b");
      } else if (a.kind === "ball" && b.kind === "bumper") {
        events.push({ t: ms, k: "bumper", s: +Math.min(1, Math.abs(bb.linvel().x) / 2).toFixed(2) }); keys.add("b");
      }
    });
    // pins: topple, gutter, pit; still?
    let moving = false;
    for (const p of pins) {
      if (p.pit) continue;
      const q = p.b.rotation(), tr = p.b.translation();
      const tilt = Math.acos(Math.max(-1, Math.min(1, upZ(q))));
      if (tilt > p.maxTilt) p.maxTilt = tilt;
      if (!p.moved && (Math.hypot(tr.x - p.x0, tr.y - p.y0) > 0.004 || tilt > 0.01)) p.moved = true;
      if (!p.toppled && tilt > 0.55) { p.toppled = true; events.push({ t: Math.round(t * 1000) + t0, k: "topple", n: p.n }); }
      if (!p.gutter && Math.abs(tr.x) > HALF + 0.02 && tr.y < PIT_Y) { p.gutter = true; events.push({ t: Math.round(t * 1000) + t0, k: "pgutter", n: p.n }); }
      if (tr.y > PIT_Y + 0.05 && tr.z < -0.05) {
        p.pit = true; events.push({ t: Math.round(t * 1000) + t0, k: "pitpin", n: p.n });
        if (opts.record) sample(trackPins[p.n] = trackPins[p.n] || [], p.b, t, true);
        world.removeRigidBody(p.b); continue;
      }
      const lv = p.b.linvel(), av = p.b.angvel(), v = Math.hypot(lv.x, lv.y, lv.z);
      const offDeck = Math.abs(tr.x) > HALF + 0.03 || tr.y > PIT_Y;
      if (offDeck ? v > 0.6 : (v > P.STILL_V || Math.hypot(av.x, av.y, av.z) > P.STILL_W)) moving = true;
    }
    if (!ballGone) {
      const bp = bb.translation();
      if (opts.audit && bp.y < PIT_Y) { ballMaxAbsX = Math.max(ballMaxAbsX, Math.abs(bp.x)); ballMinZ = Math.min(ballMinZ, bp.z); }   // over the lane and deck (past PIT_Y it is in the pit)
      if (bp.y > PIT_Y + BALL_R || bp.z < -0.02) {
        ballPitAt = t; events.push({ t: Math.round(t * 1000) + t0, k: "pit" });
        if (opts.record) sample(trackBall, bb, t, true);
        world.removeRigidBody(bb); ballGone = true;
      } else if (t > 3.0) {                                           // a ball that stops on the deck is lifted off it
        const v = bb.linvel(); if (Math.hypot(v.x, v.y) < 0.05) { ballPitAt = t; world.removeRigidBody(bb); ballGone = true; }
      }
    }
    if (opts.audit) { const e = energy(); if (e - e0 > eGain) eGain = e - e0; }
    if (opts.record) {
      const grid = step % recEvery === 0;
      if (!ballGone && (grid || keys.has("b"))) sample(trackBall, bb, t, !grid);
      for (const p of pins) if (!p.pit && p.moved && (grid || keys.has(p.n))) sample(trackPins[p.n] = trackPins[p.n] || [], p.b, t, !grid);
    }
    if (ballGone && !moving) { quiet += dt; if (quiet >= P.QUIET_S) { capped = false; break; } } else quiet = 0;
    if (ballGone && P.SWEEP_S && t >= ballPitAt + P.SWEEP_S) { capped = false; break; }     // the machine sweeps, as a real one does
  }
  // who is standing: upright (tilt under 8 degrees), on the deck, not in the gutter or the pit
  const standingOut = [], down = [];
  for (const p of pins) {
    if (p.pit) { down.push(p.n); continue; }
    const q = p.b.rotation(), tr = p.b.translation();
    const tilt = Math.acos(Math.max(-1, Math.min(1, upZ(q))));
    const up = tilt < P.STAND_RAD && Math.abs(tr.x) < HALF && tr.y < PIT_Y && tr.z > -0.01;
    if (up) {
      const yaw = 2 * Math.atan2(q.z, q.w);
      standingOut.push({ n: p.n, x: +tr.x.toFixed(4), y: +tr.y.toFixed(4), yaw: +yaw.toFixed(3), moved: p.moved, drift: Math.hypot(tr.x - p.x0, tr.y - p.y0) });
      if (p.maxTilt > 0.035) events.push({ t: Math.round(t * 1000) + t0, k: "stood", n: p.n, s: +Math.min(1, p.maxTilt / 0.5).toFixed(2) });
    } else down.push(p.n);
  }
  const eEnd = opts.audit ? energy() : null;
  world.free(); eq.free();
  const out = {
    down: down.sort((a, b) => a - b), standing: standingOut.sort((a, b) => a.n - b.n), events: events.sort((a, b) => a.t - b.t),
    trackBall, trackPins, endT: t, capped, firstContact, ballPitAt, placed,
    maxTilt: Object.fromEntries(pins.map((p) => [p.n, +p.maxTilt.toFixed(3)])),
  };
  if (opts.audit) out.audit = { e0, eGain, eEnd, ballMaxAbsX, ballMinZ };
  return out;
}
function qmul(a, b) {
  return { w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z, x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x, z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w };
}
function rotInv(q, v) {                                               // q* v q: a world vector in the body frame
  return qmul(qmul({ w: q.w, x: -q.x, y: -q.y, z: -q.z }, { w: 0, x: v.x, y: v.y, z: v.z }), q);
}

module.exports = {
  init, isReady, run, placeRack, rackSpots, mulberry, qmul, PROFILE, PIECES, lathe, PI_,
  HALF, GUTTER, KICK, BOARD, HEAD_Y, PIT_Y, DECK_Y, ROW, SPACING, BALL_R, BALL_M, BALL_K, PIN_M, PIN_H, PIN_COM, GUT_DEPTH, IN, FT, G,
  BUMP_FACE, BUMP_X, BUMP_E,
};
