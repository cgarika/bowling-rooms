/* The scoring table (WORLD.md 3.5, 9.1): hand-written cards, R7's fresh-rack cases, short games, partial cards, the
   splits (21 textbook splits and the non-splits), the calls, the frame progression, and 5,000 random legal games
   against an independent scorer. node test/score.js (exit 0 on pass). */
"use strict";
const S = require("../score");
const { checker } = require("./helpers");
const { check, section, done } = checker();
const eq = (a, b, what) => check(JSON.stringify(a) === JSON.stringify(b), what, `${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const zeros = (n) => Array(n).fill(0);
const marksOf = (c, f) => c.frames[f].marks.join(" ");
const cums = (c) => c.frames.map((f) => f.cum);

section("hand-written cards (10 frames)");
const CARDS = [
  // [label, balls, frames, cums, total, {frame: marks}]
  ["all gutters", zeros(20), 10, zeros(10), 0, { 0: "- -", 9: "- -" }],
  ["perfect game", Array(12).fill(10), 10, [30, 60, 90, 120, 150, 180, 210, 240, 270, 300], 300, { 0: "X", 9: "X X X" }],
  ["all 9-spares, 9 fill", [].concat(...Array(10).fill([9, 1]), [9]), 10, [19, 38, 57, 76, 95, 114, 133, 152, 171, 190], 190, { 0: "9 /", 9: "9 / 9" }],
  ["all 5-spares, 5 fill", [].concat(...Array(10).fill([5, 5]), [5]), 10, [15, 30, 45, 60, 75, 90, 105, 120, 135, 150], 150, { 9: "5 / 5" }],
  ["nine and a miss", [].concat(...Array(10).fill([9, 0])), 10, [9, 18, 27, 36, 45, 54, 63, 72, 81, 90], 90, { 0: "9 -", 9: "9 -" }],
  ["the Dutch 200", [10, 5, 5, 10, 5, 5, 10, 5, 5, 10, 5, 5, 10, 5, 5, 10], 10, [20, 40, 60, 80, 100, 120, 140, 160, 180, 200], 200, { 0: "X", 1: "5 /", 9: "5 / X" }],
  ["the mixed card", [10, 7, 3, 9, 0, 10, 0, 8, 8, 2, 0, 6, 10, 10, 10, 8, 1], 10, [20, 39, 48, 66, 74, 84, 90, 120, 148, 167], 167, { 3: "X", 4: "- 8", 5: "8 /", 6: "- 6", 9: "X 8 1" }],
  ["eleven strikes and a 9", Array(11).fill(10).concat([9]), 10, [30, 60, 90, 120, 150, 180, 210, 240, 270, 299], 299, { 9: "X X 9" }],
  ["nine strikes then 9-", Array(9).fill(10).concat([9, 0]), 10, [30, 60, 90, 120, 150, 180, 210, 239, 258, 267], 267, { 9: "9 -" }],
  ["open 3-4 all game", [].concat(...Array(10).fill([3, 4])), 10, [7, 14, 21, 28, 35, 42, 49, 56, 63, 70], 70, { 0: "3 4" }],
  ["spare then a strike then nothing", [5, 5, 10].concat(zeros(16)), 10, [20, 30, 30, 30, 30, 30, 30, 30, 30, 30], 30, { 0: "5 /", 1: "X" }],
  ["strike, zero-ten, zero", [10, 0, 10].concat(zeros(16)), 10, [20, 30, 30, 30, 30, 30, 30, 30, 30, 30], 30, { 0: "X", 1: "- /" }],
  ["frame 1 zero-ten is a spare", [0, 10, 3, 4].concat(zeros(16)), 10, [13, 20, 20, 20, 20, 20, 20, 20, 20, 20], 20, { 0: "- /", 1: "3 4" }],
  ["a ten-count spare in frame 5", zeros(8).concat([0, 10, 10]).concat(zeros(8)), 10, [0, 0, 0, 0, 20, 30, 30, 30, 30, 30], 30, { 4: "- /", 5: "X" }],
  ["three in a row mid-game", zeros(6).concat([10, 10, 10, 1, 2]).concat(zeros(6)), 10, [0, 0, 0, 30, 51, 64, 67, 67, 67, 67], 67, { 3: "X", 6: "1 2" }],
  ["a 1-9 split converted", [1, 9, 1, 9, 1, 9, 1, 9, 1, 9, 1, 9, 1, 9, 1, 9, 1, 9, 1, 9, 1], 10, [11, 22, 33, 44, 55, 66, 77, 88, 99, 110], 110, { 0: "1 /", 9: "1 / 1" }],
  ["high open game", [].concat(...Array(10).fill([8, 1])), 10, [9, 18, 27, 36, 45, 54, 63, 72, 81, 90], 90, {}],
  ["strike after spare in the tenth", zeros(18).concat([6, 4, 10]), 10, [0, 0, 0, 0, 0, 0, 0, 0, 0, 20], 20, { 9: "6 / X" }],
  ["300 minus the last", Array(11).fill(10).concat([0]), 10, [30, 60, 90, 120, 150, 180, 210, 240, 270, 290], 290, { 9: "X X -" }],
  ["the first ball of the tenth a zero, no bonus", Array(9).fill(10).concat([0, 3]), 10, [30, 60, 90, 120, 150, 180, 210, 230, 243, 246], 246, { 9: "- 3" }],
];
for (const [label, balls, frames, want, total, marks] of CARDS) {
  const c = S.card(balls, frames);
  eq(cums(c), want, label + ": running totals");
  eq(c.total, total, label + ": total");
  for (const [f, m] of Object.entries(marks)) eq(marksOf(c, +f), m, `${label}: frame ${+f + 1} marks`);
}

section("R7: the last frame's marks follow the fresh rack");
const TENTHS = [
  [[0, 10, 5], "- / 5", 15], [[10, 0, 10], "X - /", 20], [[9, 1, 10], "9 / X", 20], [[10, 10, 10], "X X X", 30],
  [[10, 7, 3], "X 7 /", 20], [[10, 7, 2], "X 7 2", 19], [[8, 1], "8 1", 9], [[0, 0], "- -", 0], [[10, 10, 0], "X X -", 20],
  [[0, 10, 10], "- / X", 20], [[10, 0, 0], "X - -", 10], [[5, 5, 0], "5 / -", 10], [[10, 10, 9], "X X 9", 29], [[10, 0, 5], "X - 5", 15],
  [[0, 10, 0], "- / -", 10], [[1, 9, 10], "1 / X", 20], [[10, 1, 9], "X 1 /", 20], [[7, 0], "7 -", 7], [[0, 7], "- 7", 7],
];
for (const [t, want, total] of TENTHS) {
  const c = S.card(zeros(18).concat(t), 10);
  eq(marksOf(c, 9), want, "tenth " + t.join(","));
  eq(c.total, total, "tenth total " + t.join(","));
}

section("short games: the last frame is played like the tenth");
{
  const c3 = S.card([0, 0, 0, 0, 0, 10, 0], 3);
  eq(marksOf(c3, 2), "- / -", "3 frames, last 0-10-0"); eq(c3.total, 10, "3 frames total 10");
  eq(S.card(Array(5).fill(10), 3).total, 90, "3-frame perfect is 90");
  eq(S.card(Array(7).fill(10), 5).total, 150, "5-frame perfect is 150");
  eq(cums(S.card([10, 9, 1, 10, 10, 10], 3)), [20, 40, 70], "3 frames: X, 9/, XXX");
  eq(S.card([].concat(...Array(5).fill([9, 1]), [9]), 5).total, 95, "5 frames of 9-spares");
  eq(marksOf(S.card([3, 4, 5, 5, 10, 10, 3], 3), 2), "X X 3", "3 frames, last X X 3");
  eq(cums(S.card([3, 4, 5, 5, 10, 10, 3], 3)), [7, 27, 50], "3 frames with a spare into a strike");
  eq(S.card([10, 10, 10, 10, 10, 10, 9], 5).total, 149, "5 frames, one short of perfect");
}

section("partial cards: a total only when it is known");
eq(cums(S.card([10], 10)).slice(0, 2), [null, null], "a lone strike waits");
eq(cums(S.card([10, 10], 10)).slice(0, 3), [null, null, null], "a double waits");
eq(cums(S.card([10, 10, 10], 10)).slice(0, 3), [30, null, null], "a turkey scores the first");
eq(cums(S.card([7, 3], 10))[0], null, "a spare waits for its bonus");
{ const c = S.card([7, 3, 4], 10); eq(c.frames[0].cum, 14, "the bonus arrives"); eq(c.frames[1].marks, ["4"], "the frame in progress shows its ball"); eq(c.frames[1].cum, null, "and no total yet"); }
eq(S.card([7, 2], 10).total, 9, "an open frame scores at once");
eq(S.card([], 10).frames.every((f) => f.balls.length === 0 && f.cum === null), true, "an empty card");
eq(S.card(zeros(18).concat([10, 10]), 10).frames[9].cum, null, "the tenth's X X waits for its third ball");
eq(S.card(zeros(18).concat([4, 6]), 10).frames[9].cum, null, "the tenth's spare waits for its fill");
{ const c = S.card([10, 3, 7, 0], 10, [false, true, false, false]); eq(c.frames[1].split, [true, false], "the split flags ride on the card"); }

section("splits: the textbook splits (USBC: head pin down; a pin down between, or ahead of two standing)");
const SPLITS = ["7-10", "4-6", "7-9", "8-10", "4-10", "6-7", "4-6-7-10", "4-6-7-9-10", "4-6-7-8-10", "4-7-10", "6-7-10", "2-7", "3-10", "5-7", "5-10", "5-7-10", "4-9", "6-8", "3-7", "2-10", "5-6"];
for (const sp of SPLITS) check(S.isSplit(sp.split("-").map(Number)), sp + " is a split");
check(SPLITS.length === 21, "21 textbook splits");
const NOT = ["2-8", "3-9", "2-4-5-8", "3-5-6-9", "3-6-10", "6-10", "4-7", "2-4-7", "1-2-4-7", "1-3-6-10", "7", "10", "5-8-9", "1-5", "1-7-10", "2-4", "3-6", "5-9"];
for (const sp of NOT) check(!S.isSplit(sp.split("-").map(Number)), sp + " is not a split");
check(NOT.length >= 10, "at least 10 non-splits");
eq(S.leaveName([10, 7]), "7-10", "a leave's name sorts its pins"); eq(S.leaveName([]), null, "nothing standing has no name");

section("the call for a ball");
const call = (o) => S.callFor({ fresh: true, before: 10, down: 0, standing: [], gutter: false, streak: 0, splitBefore: false, perfect: false, firstStrike: false, ...o });
eq(call({ down: 10, streak: 1, firstStrike: true }), { call: "strike", streak: 1, replay: true }, "a bowler's first strike (replayed)");
eq(call({ down: 10, streak: 1 }), { call: "strike", streak: 1, replay: false }, "a later single strike");
eq(call({ down: 10, streak: 2 }).call, "double", "two in a row"); check(call({ down: 10, streak: 2 }).replay, "a double is replayed");
eq(call({ down: 10, streak: 3 }).call, "turkey", "three in a row");
eq(call({ down: 10, streak: 5 }), { call: "inarow", streak: 5, replay: true }, "five in a row");
eq(call({ down: 10, streak: 12, perfect: true }).call, "perfect", "the twelfth strike is a perfect game");
eq(call({ fresh: false, before: 10, down: 10, standing: [] }).call, "spare", "zero then ten is a spare (R7)");
eq(call({ fresh: false, before: 2, down: 2, splitBefore: true }), { call: "converted", streak: 0, replay: true }, "a split converted (replayed)");
eq(call({ fresh: false, before: 3, down: 3 }).call, "spare", "a spare");
eq(call({ down: 8, standing: [7, 10] }).call, "split", "a 7-10 split");
eq(call({ down: 8, standing: [2, 8] }).call, "count", "a sleeper is a count");
eq(call({ down: 0, standing: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], gutter: true }).call, "gutter", "a gutter ball");
eq(call({ fresh: false, before: 4, down: 0, standing: [1, 2, 4, 7], gutter: true }).call, "gutter", "a gutter on the second ball");
eq(call({ fresh: false, before: 4, down: 2, standing: [4, 7] }).call, "count", "a second-ball count");
eq(call({ fresh: false, before: 2, down: 1, standing: [10], splitBefore: true }).call, "count", "half a split is a count");
eq(call({ down: 10, rolloff: true, streak: 4 }), { call: "strike", streak: 0, replay: false }, "a roll-off strike has no streak and no replay");
eq(call({ down: 7, standing: [7, 10, 4], rolloff: true }).call, "split", "a roll-off split is called");

section("the frame goes on, or not");
eq(S.afterBall([10], true, false), { over: true, fresh: true }, "a strike ends frames 1 to F-1");
eq(S.afterBall([7], false, false), { over: false, fresh: false }, "a count gets a second ball, at the leave");
eq(S.afterBall([0], false, false), { over: false, fresh: false }, "a zero gets a second ball at ten pins, not a fresh rack");
eq(S.afterBall([7, 2], false, false), { over: true, fresh: true }, "two balls end a frame");
eq(S.afterBall([0, 10], true, false), { over: true, fresh: true }, "a spare ends a frame");
eq(S.afterBall([10], true, true), { over: false, fresh: true }, "tenth: a strike earns a fresh rack");
eq(S.afterBall([7], false, true), { over: false, fresh: false }, "tenth: a count, the second ball at the leave");
eq(S.afterBall([0], false, true), { over: false, fresh: false }, "tenth: a zero leaves ten pins, not a fresh rack");
eq(S.afterBall([0, 10], true, true), { over: false, fresh: true }, "tenth: zero then ten earns a fresh rack");
eq(S.afterBall([10, 10], true, true), { over: false, fresh: true }, "tenth: X X, a fresh rack");
eq(S.afterBall([10, 7], false, true), { over: false, fresh: false }, "tenth: X 7, the third ball at the leave");
eq(S.afterBall([10, 0], false, true), { over: false, fresh: false }, "tenth: X 0, the third ball at ten pins, not fresh");
eq(S.afterBall([7, 2], false, true), { over: true, fresh: true }, "tenth: open, over");
eq(S.afterBall([7, 3], true, true), { over: false, fresh: true }, "tenth: a spare earns a fresh rack");
eq(S.afterBall([10, 10, 10], true, true).over, true, "tenth: three balls at most");

section("the lobby's suggestion");
eq([2, 3, 4, 5, 6, 7, 8].map(S.suggestFrames), [5, 5, 5, 5, 3, 3, 3], "5 for 2-5, 3 for 6-8");

section("5,000 random legal games against an independent scorer");
function lcg(seed) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }
function refGame(rnd, F) {
  const r = (n) => Math.floor(rnd() * (n + 1));
  const balls = [];
  for (let f = 0; f < F - 1; f++) { const a = r(10); balls.push(a); if (a < 10) balls.push(r(10 - a)); }
  const a = r(10); balls.push(a);
  if (a === 10) { const b = r(10); balls.push(b); balls.push(b === 10 ? r(10) : r(10 - b)); }
  else { const b = r(10 - a); balls.push(b); if (a + b === 10) balls.push(r(10)); }
  return balls;
}
function refScore(balls, F) {
  let i = 0, total = 0; const cumsR = [];
  for (let f = 0; f < F; f++) {
    if (f === F - 1) { total += balls.slice(i).reduce((x, y) => x + y, 0); cumsR.push(total); break; }
    if (balls[i] === 10) { total += 10 + balls[i + 1] + balls[i + 2]; i += 1; }
    else if (balls[i] + balls[i + 1] === 10) { total += 10 + balls[i + 2]; i += 2; }
    else { total += balls[i] + balls[i + 1]; i += 2; }
    cumsR.push(total);
  }
  return { total, cums: cumsR };
}
function refTenthMarks(t) {
  const d = (v) => (v === 0 ? "-" : String(v)), m = [];
  const [a, b, c] = t;
  m.push(a === 10 ? "X" : d(a));
  if (b !== undefined) m.push(a === 10 ? (b === 10 ? "X" : d(b)) : a + b === 10 ? "/" : d(b));
  if (c !== undefined) m.push(a === 10 && b === 10 ? (c === 10 ? "X" : d(c)) : a === 10 ? (b + c === 10 ? "/" : d(c)) : c === 10 ? "X" : d(c));
  return m.join(" ");
}
{
  const rnd = lcg(20260926); let bad = 0, n = 0;
  for (const F of [10, 5, 3]) for (let g = 0; g < (F === 10 ? 3000 : 1000); g++) {
    const balls = refGame(rnd, F), c = S.card(balls, F), ref = refScore(balls, F);
    const lastStart = balls.length - c.frames[F - 1].balls.length;
    const ok = c.total === ref.total && JSON.stringify(cums(c)) === JSON.stringify(ref.cums) && marksOf(c, F - 1) === refTenthMarks(balls.slice(lastStart));
    n++; if (!ok && bad++ < 5) console.log("  mismatch", F, JSON.stringify(balls), c.total, ref.total, marksOf(c, F - 1), refTenthMarks(balls.slice(lastStart)));
  }
  check(bad === 0, `${n} random games agree with the independent scorer`, `${bad} disagree`);
}

process.exit(done("score") ? 1 : 0);
