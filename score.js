/* Scoring (WORLD.md 3.5): splits, the ten-frame card with the fresh-rack flag (R7), the call for a ball, and what
   happens after a ball in a frame. Pure functions; no state. */
"use strict";

/* Neighbours 12 in apart, plus the sleepers straight behind (1-5, 2-8, 3-9), which never make a split. */
const ADJ = { 1: [2, 3, 5], 2: [1, 3, 4, 5, 8], 3: [1, 2, 5, 6, 9], 4: [2, 5, 7, 8], 5: [1, 2, 3, 4, 6, 8, 9], 6: [3, 5, 9, 10], 7: [4, 8], 8: [2, 4, 5, 7, 9], 9: [3, 5, 6, 8, 10], 10: [6, 9] };
/* Same-row neighbours, and the pin in front of the gap between them. */
const AHEAD = { "2-3": 1, "4-5": 2, "5-6": 3, "7-8": 4, "8-9": 5, "9-10": 6 };

/* USBC: a split is a leave after the first ball, with the head pin down, where a pin is down between standing pins,
   or immediately ahead of two standing pins (5-6 with the 3 down). standing: pin numbers. */
function isSplit(standing) {
  const s = new Set(standing);
  if (s.has(1) || s.size < 2) return false;
  const seen = new Set(); let groups = 0;
  for (const p of s) {
    if (seen.has(p)) continue; groups++;
    const stack = [p]; seen.add(p);
    while (stack.length) {
      const q = stack.pop();
      for (const r of ADJ[q] || []) {
        if (!s.has(r) || seen.has(r)) continue;
        const key = Math.min(q, r) + "-" + Math.max(q, r);
        if (AHEAD[key] && !s.has(AHEAD[key])) continue;     // side by side, but the pin ahead of them is down
        seen.add(r); stack.push(r);
      }
    }
  }
  return groups > 1;
}
/* The leave's name, as a bowler says it: "7-10", "3-6-10"; null when nothing stands. */
function leaveName(standing) { const s = [...standing].sort((a, b) => a - b); return s.length ? s.join("-") : null; }

/* balls: pins down per ball, in order; frames: how many frames the game has (the last is played like the tenth);
   splits (optional): per ball, whether it left a split. Returns per frame the balls, the marks (X, /, -, digits), the
   splits and the running total where it is known, and the game's total so far (known frames only). */
function card(balls, frames = 10, splits) {
  const out = []; let i = 0, total = 0;
  for (let f = 0; f < frames; f++) {
    const last = f === frames - 1, fr = { balls: [], marks: [], split: [], cum: null };
    if (i >= balls.length) { out.push(fr); continue; }
    const a = balls[i];
    if (!last) {
      if (a === 10) { fr.balls = [10]; fr.marks = ["X"]; if (balls.length > i + 2) { total += 10 + balls[i + 1] + balls[i + 2]; fr.cum = total; } i += 1; }
      else {
        fr.balls = [a]; fr.marks = [a === 0 ? "-" : String(a)];
        if (balls.length > i + 1) {
          const b = balls[i + 1]; fr.balls.push(b); fr.marks.push(a + b === 10 ? "/" : b === 0 ? "-" : String(b));
          if (a + b === 10) { if (balls.length > i + 2) { total += 10 + balls[i + 2]; fr.cum = total; } }
          else { total += a + b; fr.cum = total; }
        }
        i += fr.balls.length;
      }
    } else {
      /* R7: a strike needs a FRESH rack, not just ten pins standing. After a zero the rack still has ten pins, but a
         ball that clears them is a spare ("- /", "X - /"), never a strike. */
      const bs = balls.slice(i, i + 3); fr.balls = bs;
      let fresh = true, left = 10;
      for (const v of bs) {
        if (fresh && v === 10) { fr.marks.push("X"); left = 10; fresh = true; }
        else if (!fresh && v === left) { fr.marks.push("/"); left = 10; fresh = true; }
        else { fr.marks.push(v === 0 ? "-" : String(v)); if (fresh) { left = 10 - v; fresh = false; } else { left = 10; fresh = true; } }
      }
      const need = (bs[0] === 10 || bs[0] + (bs[1] || 0) === 10) ? 3 : 2;
      if (bs.length >= need) { total += bs.slice(0, need).reduce((x, y) => x + y, 0); fr.cum = total; }
      i += bs.length;
    }
    if (splits) fr.split = fr.balls.map((_, k) => !!splits[i - fr.balls.length + k]);
    else delete fr.split;
    out.push(fr);
  }
  return { frames: out, total };
}

/* After a ball: does the frame go on, and is the next ball at a fresh rack?
   frameBalls: the pins of each ball so far in this frame, this one included; cleared: this ball left nothing standing;
   last: this is the last frame. */
function afterBall(frameBalls, cleared, last) {
  const n = frameBalls.length;
  if (!last) { const over = cleared || n >= 2; return { over, fresh: over }; }     // a second ball is at the leave
  if (n >= 3) return { over: true, fresh: true };
  if (n === 1) return { over: false, fresh: cleared };
  // n === 2: a bonus ball only after a strike or a spare
  if (frameBalls[0] === 10) return { over: false, fresh: cleared };
  return cleared ? { over: false, fresh: true } : { over: true, fresh: true };
}

/* The call for one ball (WORLD.md 3.5). fresh: bowled at a fresh rack of ten; before: pins standing before it;
   down: pins it knocked down; standing: pin numbers left; gutter: it went in the gutter; streak: this bowler's strikes
   in a row counting this one; splitBefore: the leave it faced was a split; perfect: this strike completes a perfect
   game; firstStrike: the bowler's first strike of the game; rolloff: a roll-off ball (no streaks, no replay).
   Returns {call, streak, replay}: call is perfect | strike | double | turkey | inarow | converted | spare | split |
   gutter | count. */
function callFor(b) {
  const cleared = b.down === b.before;
  let call;
  if (b.fresh && cleared) {
    if (b.rolloff) call = "strike";
    else call = b.perfect ? "perfect" : b.streak >= 4 ? "inarow" : b.streak === 3 ? "turkey" : b.streak === 2 ? "double" : "strike";
  } else if (!b.fresh && cleared) call = b.splitBefore ? "converted" : "spare";
  else if (b.fresh && isSplit(b.standing || [])) call = "split";
  else if (b.gutter) call = "gutter";
  else call = "count";
  const replay = !b.rolloff && (["double", "turkey", "inarow", "perfect", "converted"].includes(call) || (call === "strike" && !!b.firstStrike));
  return { call, streak: b.fresh && cleared && !b.rolloff ? b.streak : 0, replay };
}

/* The lobby's suggestion (WORLD.md 2.5): every table from 2 to 8 plays in about 6 to 9 minutes. */
/* Five frames, as Plato's game (the owner, 2026-10-10: "5 frames per game"); three at a big table. The host can still
   choose 3, 5 or 10 in the lobby. */
function suggestFrames(seats) { return seats <= 5 ? 5 : 3; }

module.exports = { isSplit, leaveName, card, afterBall, callFor, suggestFrames, ADJ, AHEAD };
