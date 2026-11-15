/* The `delivery` event's physics payload and its wire format (WORLD.md 3.2, R5).

   A sample is 16 bytes, little-endian: t (uint16, ms from release), x, y, z (int16, mm), qx, qy, qz (int16 x 32767;
   w >= 0 is implied, since q and -q are the same turn), flags (int16: 1 = a key sample at a contact, off the 30 Hz
   grid). Each body's samples are one base64 string. The lane phase is not sent: every phone computes it from the
   release. The deck phase ball samples start at the hand-over; a pin's samples start when it first moves and end when
   the machine sweeps or it drops into the pit (its last sample then carries the key flag).

   Events: [t ms, kind, pin, pin2, strength %]. */
"use strict";
const KIND = { ball: 1, pin: 2, land: 3, kick: 4, bkick: 5, topple: 6, stood: 7, pgutter: 8, pitpin: 9, pit: 10, gutter: 11, bumper: 12 };
const FMT = 1;                                  // the sample layout's version, for the phone's decoder
const MAX_BYTES = 48 * 1024;                    // never send a delivery bigger than this (the phone's frame is 64 KB)
const META_ALLOWANCE = 1024;                    // what the server adds round the physics (ids, the call, the release)

function packSamples(samples) {
  const buf = Buffer.alloc(samples.length * 16);
  samples.forEach((s, i) => {
    let [t, x, y, z, qx, qy, qz, qw] = s; if (qw < 0) { qx = -qx; qy = -qy; qz = -qz; }
    const o = i * 16;
    buf.writeUInt16LE(Math.max(0, Math.min(65535, t)), o);
    buf.writeInt16LE(i16(x * 1000), o + 2); buf.writeInt16LE(i16(y * 1000), o + 4); buf.writeInt16LE(i16(z * 1000), o + 6);
    buf.writeInt16LE(i16(qx * 32767), o + 8); buf.writeInt16LE(i16(qy * 32767), o + 10); buf.writeInt16LE(i16(qz * 32767), o + 12);
    buf.writeInt16LE(s[8] ? 1 : 0, o + 14);
  });
  return buf.toString("base64");
}
function i16(v) { return Math.max(-32768, Math.min(32767, Math.round(v))); }
/* The phone's decoder, in JS: [t, x, y, z (m), qx, qy, qz, qw, key]. */
function unpack(b64) {
  const buf = Buffer.from(b64, "base64"); const out = [];
  for (let o = 0; o + 16 <= buf.length; o += 16) {
    const qx = buf.readInt16LE(o + 8) / 32767, qy = buf.readInt16LE(o + 10) / 32767, qz = buf.readInt16LE(o + 12) / 32767;
    out.push([buf.readUInt16LE(o), buf.readInt16LE(o + 2) / 1000, buf.readInt16LE(o + 4) / 1000, buf.readInt16LE(o + 6) / 1000, qx, qy, qz, Math.sqrt(Math.max(0, 1 - qx * qx - qy * qy - qz * qz)), buf.readInt16LE(o + 14) & 1]);
  }
  return out;
}
/* Keep every key sample and each body's first and last, and grid samples at least `gapMs` apart. */
function thin(samples, gapMs) {
  const out = []; let lastGrid = -Infinity;
  samples.forEach((s, i) => {
    const edge = i === 0 || i === samples.length - 1;
    if (s[8] || edge || s[0] - lastGrid >= gapMs - 1) { out.push(s); if (!s[8]) lastGrid = s[0]; }
  });
  return out;
}
const pinRow = (p) => [p.n, Math.round(p.x * 1000), Math.round(p.y * 1000), Math.round((p.yaw || 0) * 1000)];

/* The physics half of a delivery, from lane.simulate(..., {record: true}). The server adds the rest (ids, the clock,
   the call). Thins the 30 Hz grid to 20 Hz, then 10 Hz, if the event would ever pass MAX_BYTES. */
function physicsPayload(s) {
  const base = {
    fmt: FMT, seed: s.seed,
    before: s.placed.map(pinRow),
    deckAt: s.deckAt === null ? null : Math.round(s.deckAt * 1000), playMs: Math.round(s.endT * 1000),
    ev: s.events.map((e) => [e.t, KIND[e.k] || 0, e.n || 0, e.m || 0, Math.round((e.s || 0) * 100)]),
    down: s.down, standing: s.standing.map(pinRow),
    gutter: s.gutterAt !== null,
  };
  const tr = s.track3d || { ball: [], pins: {} };
  let out = null;
  for (const gap of [0, 50, 100]) {
    const ball = gap ? thin(tr.ball, gap) : tr.ball;
    const pins = {};
    for (const [n, v] of Object.entries(tr.pins)) pins[n] = packSamples(gap ? thin(v, gap) : v);
    out = { ...base, ball: packSamples(ball), pins, thin: gap ? Math.round(1000 / gap) : 0 };
    out.bytes = Buffer.byteLength(JSON.stringify(out));
    if (out.bytes + META_ALLOWANCE <= MAX_BYTES) return out;
  }
  // past 10 Hz and still too big (never seen): send the result without the pins' flight rather than a frame the phone drops
  out = { ...base, ball: packSamples(thin(tr.ball, 100)), pins: {}, thin: -1 };
  out.bytes = Buffer.byteLength(JSON.stringify(out));
  return out;
}

module.exports = { KIND, FMT, MAX_BYTES, META_ALLOWANCE, packSamples, unpack, thin, physicsPayload, pinRow };
