/* Bots (WORLD.md 3.6): the aim table, a bot's choice of release, the human model of 5.1 (for test/bots.js), and the
   timeout ball. Grown from the round-2 prototype.

   - The aim table: ball-only lane phases on a grid (x every 2 cm, angle every 0.125 degree, five speeds, the three
     spin plateaus), each recording where its line crosses the head pin's row, its entry angle and how close it goes
     to a gutter. Built once (about 1 to 2 s) into a SharedArrayBuffer, so the main thread builds it and every pool
     worker reads the same memory.
   - A choice: the first ball aims at board 17.5 with a 6 degree entry, keeping five boards from the gutter; a spare
     aims a straight ball at 0.6 x the front pin + 0.4 x the leave's centre, cross-lane. Then the skill's spread.
   - No practice swings: a bot simulates only the ball it bowls.
   - Left-handers mirror x, angle and spin. */
"use strict";
const L = require("./lane");

const TO_HEAD = L.HEAD_Y - L.DECK_Y;
const F = 9;                                   // fields per entry: x, angle, speed, spin, ex, ea, t, bp, arrows
let TABLE = null;                              // Float64Array over a SharedArrayBuffer

function buildTable() {
  const rows = [];
  for (let x = -0.40; x <= 0.4001; x += 0.02) for (let a = -3.5; a <= 3.501; a += 0.125) for (const sp of [6.2, 6.8, 7.4, 8.0, 8.6]) for (const spin of [0, 0.55, 1.0]) {
    const s = L.lanePhase(L.quantise({ x, angle: a, speed: sp, spin }), { noPins: true, noPose: true });
    if (!s.entry) continue;
    const exHead = s.entry.x + Math.tan(s.entry.angle * Math.PI / 180) * TO_HEAD;
    if (Math.abs(exHead) > L.HALF) continue;
    let bp = 0, arrows = NaN;
    for (const [, bx, by] of s.trackB) { if (Math.abs(bx / 1000) > Math.abs(bp)) bp = bx / 1000; if (Number.isNaN(arrows) && by >= 4572) arrows = bx / 1000; }
    rows.push(+x.toFixed(3), +a.toFixed(3), sp, spin, exHead, -s.entry.angle, s.deckAt, bp, arrows);
  }
  const sab = new SharedArrayBuffer(rows.length * 8);
  const t = new Float64Array(sab); t.set(rows);
  return t;
}
/* The table: built here on first use, or adopted from the one the server built (the pool passes it: a shared buffer to
   a thread, a copy to a process). */
function table() { if (!TABLE) TABLE = buildTable(); return TABLE; }
function adoptTable(x) { TABLE = x instanceof Float64Array ? x : new Float64Array(x); }
function tableBuffer() { return table().buffer; }

function gauss(rnd) { let u = 0; while (!u) u = rnd(); const v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
/* Spreads (standard deviations) of the release: lane angle (deg), speed (m/s), stance x (m), spin. */
const SKILL = {
  rookie: { a: 0.45, s: 0.90, x: 0.030, sp: 0.45 },
  regular: { a: 0.22, s: 0.55, x: 0.015, sp: 0.25 },
  pro: { a: 0.085, s: 0.22, x: 0.006, sp: 0.09 },
};
/* Bowler styles (2026-10-28): the speed a bowler likes, the hook plateau (0.55 a gentle arc, 1.0 the big one), how tight
   their spread is and how streaky they are (vol: how far their form swings). The release is still chosen from the table,
   so a style changes the ball they throw, never how well it is aimed. */
const STYLES = {
  hooker:    { speed: 7.0, spin: 1.0,  tight: 1.0,  vol: 1.0, think: [260, 480] },     // slow, big hook
  speedster: { speed: 8.5, spin: 0.55, tight: 1.15, vol: 1.5, think: [180, 360] },      // fast, flat, streaky
  steady:    { speed: 7.3, spin: 0.55, tight: 0.8,  vol: 0.6, think: [220, 420] },     // gentle arc, hardly ever off
};
const STYLE_NAMES = Object.keys(STYLES);
/* The ideal release for the rack, from the table. hand: +1 right-handed, -1 left-handed. standing: [{n, x, y}]. */
function ideal(standing, hand = 1, style = null) {
  const speedT = style && style.speed ? style.speed : 7.4;
  const T = table(), n = T.length / F;
  let target, wantAngle, hook;
  if (standing.length === 10) { target = 0.068 * hand; wantAngle = 6.0; hook = true; }
  else {
    const front = standing.reduce((m, p) => (p.y < m.y ? p : m), standing[0]);
    const cx = standing.reduce((s, p) => s + p.x, 0) / standing.length;
    target = 0.6 * front.x + 0.4 * cx; wantAngle = null; hook = false;
  }
  let best = -1, bestCost = Infinity;
  for (let i = 0; i < n; i++) {
    const o = i * F, spin = T[o + 3];
    if (hook ? spin === 0 : spin !== 0) continue;
    const x = T[o] * hand, speed = T[o + 2], ex = T[o + 4] * hand, ea = T[o + 5] * hand;
    const bpBoard = 20 - Math.abs(T[o + 7]) / L.BOARD;               // how close the path goes to a gutter (board 1 = the edge)
    let cost = Math.abs(ex - target) * 100 + (wantAngle !== null ? Math.abs(ea * hand - wantAngle) * 1.2 : 0) + Math.abs(speed - speedT) * (style ? 1.1 : 0.6)
      + (bpBoard < 6 ? (6 - bpBoard) * 3 : 0);                        // keep five boards of margin from the gutter
    if (hook && style && style.spin) cost += Math.abs(spin - style.spin) * 14;
    if (!hook) cost += Math.abs(x - Math.max(-0.40, Math.min(0.40, -target * 1.1))) * 8;       // spares: prefer the cross-lane line
    if (cost < bestCost) { bestCost = cost; best = o; }
  }
  const o = best;
  return { x: T[o] * hand, angle: T[o + 1] * hand, speed: T[o + 2], spin: T[o + 3] * hand, ex: T[o + 4] * hand, ea: T[o + 5] * hand };
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function clampRelease(r) { return { x: clamp(r.x, -0.40, 0.40), angle: clamp(r.angle, -3.5, 3.5), speed: clamp(r.speed, 5.4, 9.8), spin: clamp(r.spin, -1, 1) }; }
/* A bot's release (doubles), inside the clamps. */
function choose(standing, skill, rnd, hand = 1, style = null, mul = 1) {
  const b = ideal(standing, hand, style), k = SKILL[skill] || SKILL.regular, m = mul * (style && style.tight ? style.tight : 1);
  return clampRelease({ x: b.x + gauss(rnd) * k.x * m, angle: b.angle + gauss(rnd) * k.a * m, speed: b.speed + gauss(rnd) * k.s * m, spin: b.spin + gauss(rnd) * k.sp * m });
}
/* WORLD.md 5.1's control scheme as a model of a human hand (until the owner's 50 swipes replace it):
   stance dragged to half boards (SD stanceBd boards); the aim target set off the right line by SD judgeBd boards plus
   the drag's own 0.25 board; the swipe's screen direction error (SD dirDeg) nudging the line by ASSIST x 0.433
   lane-degrees per screen degree; speed SD speedSd m/s; spin SD spinSd inside its plateau. */
const ASSIST = 0.15, SCREEN_TO_LANE = 0.433;
const ARROWS_Y = 15 * 0.3048;
function human(standing, prof, rnd, hand = 1) {
  const b = ideal(standing, hand);
  const tgtX = b.x + Math.tan(b.angle * Math.PI / 180) * ARROWS_Y;
  const stance = b.x + gauss(rnd) * prof.stanceBd * L.BOARD;
  const target = tgtX + gauss(rnd) * Math.hypot(prof.judgeBd, 0.25) * L.BOARD;
  const angle = Math.atan2(target - stance, ARROWS_Y) * 180 / Math.PI + gauss(rnd) * prof.dirDeg * ASSIST * SCREEN_TO_LANE;
  return clampRelease({ x: stance, angle, speed: b.speed + gauss(rnd) * prof.speedSd, spin: b.spin + gauss(rnd) * prof.spinSd });
}
const HUMANS = {
  careful: { stanceBd: 0.3, judgeBd: 0.75, dirDeg: 1.2, speedSd: 0.25, spinSd: 0.06 },
  casual: { stanceBd: 0.6, judgeBd: 1.5, dirDeg: 2.5, speedSd: 0.40, spinSd: 0.12 },
  first: { stanceBd: 1.0, judgeBd: 2.5, dirDeg: 3.5, speedSd: 0.55, spinSd: 0.18 },
};
/* The timeout ball (R2.4): straight down the middle at 6.2 m/s (14 mph), every ball, no aim at all. Never better than
   playing: a player who times out every ball averages about 73. */
function timeoutBall() { return { x: 0, angle: 0, speed: 6.2, spin: 0 }; }

const NAMES = ["Kingpin", "Lucky", "Spare Parts", "Alley Cat", "Ten Pin", "Gutter Gus", "Lefty", "Big Mo"];
const SKILL_CYCLE = ["regular", "rookie", "pro"];                    // +Bot adds Regular, Rookie, Pro, Regular ...

/* A bot's form, ball by ball (a random walk with a pull to its average, lifted by a strike or a spare, dented by a gutter or
   a miss): the spread's multiplier is 1 when form is 0, about 0.6 when hot and 2 or so when cold. The last frame adds nerves. */
function formStep(form, vol, rnd) { return clamp(0.6 * form + gauss(rnd) * 0.55 * vol, -2, 2); }
function formMul(form, lastFrame) { return clamp(Math.exp(-0.32 * form), 0.6, 2.2) * (lastFrame ? 1.15 : 1); }
function formAfter(form, call, down) {
  if (call === "strike" || call === "double" || call === "turkey" || call === "inarow" || call === "perfect") return clamp(form + 0.55, -2, 2);
  if (call === "spare" || call === "converted") return clamp(form + 0.3, -2, 2);
  if (call === "gutter" || down === 0) return clamp(form - 0.9, -2, 2);
  if (down <= 4) return clamp(form - 0.3, -2, 2);
  return form;
}
module.exports = { STYLES, STYLE_NAMES, formStep, formMul, formAfter, table, adoptTable, tableBuffer, buildTable, ideal, choose, human, HUMANS, timeoutBall, clampRelease, gauss, SKILL, SKILL_CYCLE, NAMES, ASSIST, SCREEN_TO_LANE, F };
