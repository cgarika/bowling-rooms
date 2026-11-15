/* The protocol (WORLD.md 3.2, 2.4), message by message, on the production clocks: the shapes of joined, state,
   delivery, pong and refused; readyAt gating and the timing formula (readyAt = at + playMs + the call's beat + the
   re-set or the hand-over; turnEndsAt = readyAt + 30 s for a frame's first ball, 20 s after); a bot bowls 120 to
   600 ms after readyAt; the delivery's samples decode into a sane 6-DoF track; the refusal texts the app maps.

   node test/protocol.js   (its own server on TEST_PORT, 3281 by default) */
"use strict";
const T = require("../track");
const H = require("./helpers");
const { check, section, done } = H.checker();
const { client, connected, waitFor, sleep } = H;

const type = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
function shape(obj, spec, where) {
  for (const [k, t] of Object.entries(spec)) {
    const ok = t.split("|").includes(type(obj[k]));
    check(ok, `${where}.${k} is ${t}`, ok ? undefined : `${type(obj[k])}: ${JSON.stringify(obj[k])}`.slice(0, 200));
  }
}

(async () => {
  const srv = await H.startServer({ ARRIVAL_MS: "1500", PLAY_MS_SCALE: "1", RESULT_MS: "", RESET_MS: "", HANDOFF_MS: "", COSMIC_MS: "", ROLLOFF_MS: "", BOT_MS: "", TURN_MS: "", TURN_MS_FIRST: "30000", TURN_MS_NEXT: "20000" });
  const URL = srv.url;
  try {
    section("joined and the lobby state");
    const a = client(URL, "Ana"); await connected(a);
    a.emit("create", { name: "Ana", playerId: a.playerId, avatar: "a07" });
    await waitFor(a, (x) => x.st && x.joined);
    shape(a.joined, { code: "string", playerId: "string", seatKey: "string" }, "joined");
    shape(a.st, { code: "string", status: "string", v: "number", now: "number", log: "string", players: "array", hostSeat: "number", minPlayers: "number", maxPlayers: "number",
      frames: "number", settings: "object", frame: "number", ball: "number", turn: "number", fresh: "boolean", rack: "array", throwSeq: "number", pending: "boolean",
      readyAt: "null|number", turnEndsAt: "null|number", sheets: "array", totals: "array", lastThrow: "null|object", rolloff: "null|object", winners: "array", winner: "number", chat: "array", voice: "array" }, "state");
    shape(a.st.players[0], { name: "string", avatar: "string", color: "string", bot: "boolean", skill: "null|string", botControlled: "boolean", left: "boolean", connected: "boolean", bumpers: "boolean", lefty: "boolean", ball: "string", timeouts: "number" }, "players[0]");
    shape(a.st.settings, { frames: "number", rolloff: "boolean", suggested: "number", touched: "boolean" }, "settings");
    check(a.st.players[0].avatar === "a07", "the app's avatar id is kept");
    check(Math.abs(a.st.now - Date.now()) < 1000, "the state carries the server's clock (GN-48)");

    section("refusals the app can read (the shell's ReasonFor texts, and a code)");
    const r = client(URL, "R"); await connected(r);
    r.emit("join", { code: "QQQQQQ", name: "R" }); await waitFor(r, (x) => x.refused.length);
    shape(r.refused[0], { code: "string", msg: "string", to: "string" }, "refused");
    check(r.errors[0] === "No room with that code." && r.refused[0].code === "not_found" && r.refused[0].to === "join", "not_found");
    r.close();

    section("the start and readyAt gating");
    a.emit("addBot"); await waitFor(a, (x) => x.st.players.length === 2);
    a.emit("settings", { frames: 3 });
    const t0 = Date.now();
    a.emit("start");
    await waitFor(a, (x) => x.st.status === "playing");
    const st0 = a.st;
    check(st0.readyAt - t0 >= 1300 && st0.readyAt - t0 <= 1800, "readyAt = start + ARRIVAL_MS (1.5 s here, 2.4 s in production)", st0.readyAt - t0);
    check(st0.turnEndsAt - st0.readyAt === 30000, "a frame's first ball has 30 s from readyAt", st0.turnEndsAt - st0.readyAt);
    a.emit("throw", { n: 1, x: 600, angle: 2125, speed: 7400, spin: 1000 });
    await sleep(250);
    check(a.st.throwSeq === 0 && a.deliveries.length === 0, "a throw before readyAt - 150 ms is ignored");
    await sleep(Math.max(0, st0.readyAt - Date.now() - 100));
    const sent = Date.now();
    a.emit("throw", { n: 1, x: 600, angle: 2125, speed: 7400, spin: 1000 });
    await waitFor(a, (x) => x.deliveries.length === 1 && x.st.throwSeq === 1, 10000);
    const d = a.deliveries[0], st1 = a.st;
    check(d && d.at >= sent - 50, "a throw 100 ms early is taken (clock skew allowance)");
    console.log(`  the delivery came ${Date.now() - sent} ms after the throw (the pool's simulation plus the socket)`);

    section("the delivery event");
    shape(d, { id: "number", n: "number", seat: "number", at: "number", frame: "number", nth: "number", rolloff: "boolean", fresh: "boolean", kind: "string", bumpers: "boolean", lefty: "boolean",
      release: "object", fmt: "number", seed: "number", before: "array", deckAt: "number|null", playMs: "number", ev: "array", down: "array", standing: "array", gutter: "boolean",
      ball: "string", pins: "object", thin: "number", count: "number", call: "string", streak: "number", leave: "null|string", split: "boolean", replay: "boolean",
      mph: "number", entryBoard: "number|null", entryAngle: "number|null" }, "delivery");
    check(d.fmt === T.FMT && d.n === 1 && d.seat === 0 && d.frame === 1 && d.nth === 1 && d.fresh && d.kind === "human", "ids, the frame and the ball");
    check(JSON.stringify(d.release) === JSON.stringify({ x: 600, angle: 2125, speed: 7400, spin: 1000 }), "the release echoed in wire integers");
    check(Number.isInteger(d.seed) && d.seed >= 0 && d.seed < 2 ** 32, "a 32-bit seed, published");
    check(d.before.length === 10 && d.before.every((p) => p.length === 4 && p.every(Number.isInteger)), "before: [n, x mm, y mm, yaw mrad] for the rack as it stood");
    const nums = (l) => l.map((p) => (Array.isArray(p) ? p[0] : p)).sort((x, y) => x - y).join();
    check(nums(d.down.concat(d.standing)) === nums(d.before), "down and standing are the rack's pins");
    check(d.count === d.down.length, "count is the pins down");
    const ball = T.unpack(d.ball);
    check(ball.length > 5 && ball.every((s, i) => i === 0 || s[0] >= ball[i - 1][0]), `the ball's ${ball.length} samples run forward in time`);
    check(d.deckAt !== null && ball[0][0] >= d.deckAt && Math.abs(ball[0][2] - 18.0) < 0.3, "the ball's deck samples start at the hand-over, at the deck line", [ball[0][0], d.deckAt, ball[0][2]]);
    check(ball.every((s) => Math.abs(s[4] ** 2 + s[5] ** 2 + s[6] ** 2 + s[7] ** 2 - 1) < 1e-3), "every sample's turn is a unit quaternion");
    const pinKeys = Object.keys(d.pins);
    check(pinKeys.every((k) => /^(10|[1-9])$/.test(k)), "pins are keyed by their numbers", pinKeys);
    check(d.down.every((n) => pinKeys.includes(String(n))), "every pin that went down has a track");
    for (const k of pinKeys) { const tr = T.unpack(d.pins[k]); if (!(tr.length && tr.every((s, i) => i === 0 || s[0] >= tr[i - 1][0]) && tr[0][0] >= d.deckAt)) { check(false, "pin " + k + " track runs forward from the deck"); } }
    check(d.ev.length > 0 && d.ev.every((e) => e.length === 5 && e.every(Number.isInteger) && e[1] >= 1 && e[1] <= 12), "events are [t, kind 1-12, pin, pin2, strength]");
    check(d.ev.every((e, i) => i === 0 || e[0] >= d.ev[i - 1][0]), "events are in time order");
    check(d.ev.some((e) => e[1] === 1), "the ball's hits on pins are events (kind 1)");
    check(d.playMs > d.deckAt && d.playMs < 10000, "playMs: the machine sweeps after the deck phase", d.playMs);
    const bytes = Buffer.byteLength(JSON.stringify(d));
    check(bytes < T.MAX_BYTES, `the delivery is ${bytes} bytes, under the 48 KB cap`);
    check(d.mph > 12 && d.mph < 22 && Math.abs(d.mph - 7.4 * 2.23694) < 0.1, "mph is the release speed", d.mph);
    check(d.entryBoard > 5 && d.entryBoard < 35 && typeof d.entryAngle === "number", "entry board and angle at the head pin", [d.entryBoard, d.entryAngle]);

    section("the clocks after a ball (WORLD.md 2.4)");
    const lt = st1.lastThrow;
    check(lt && lt.id === d.id && lt.call === d.call && lt.at === d.at && !("pins" in lt), "lastThrow summarises the delivery");
    const taunt = d.call === "gutter" || d.call === "split" || d.count === 0 || (d.fresh && d.count <= 4);
    // Bowling r1 (2026-11-02): the pace trimmed so the time between your turns is under 8 s: beats 160/300/380/700, hand-over 150, re-set 350.
    const beat = taunt ? 700 : d.replay ? 380 : ["perfect", "strike", "double", "turkey", "inarow", "spare", "converted", "split", "gutter"].includes(d.call) ? 300 : 160;
    const next = d.count === 10 ? 150 : 350;        // a strike hands over (frames 1-2), otherwise the re-set for ball 2
    // The crash as shown: the delivery's own crashMs (1 s for a person) from the ball's first hit, or until the pins settle if sooner.
    check(d.crashMs === 1000, "a person's delivery carries its crash time, 1000 ms", d.crashMs);
    const hit = d.ev.find((e) => e[1] === T.KIND.ball);
    const shown = hit ? Math.min(d.playMs, hit[0] + d.crashMs) : d.playMs;
    // Plato's show (bowling-plato, 2026-11-04): a person's ball holds the beats after it to HUMAN_SHOW_MS (6 s) after its release at the earliest (test/show.js checks that over real sockets).
    const showMs = process.env.HUMAN_SHOW_MS ? Number(process.env.HUMAN_SHOW_MS) : 6000;
    check(st1.readyAt === d.at + Math.max(shown + beat, showMs) + next, `readyAt = at + the later of (shown crash + ${beat} (${d.call})) and the show's ${showMs}, + ${next}`, st1.readyAt - d.at - shown);
    const firstBall = st1.ball === 1;
    check(st1.turnEndsAt === st1.readyAt + (firstBall ? 30000 : 20000), "turnEndsAt = readyAt + 30 s (a frame's first ball) or 20 s", st1.turnEndsAt - st1.readyAt);
    if (!firstBall) {
      check(st1.fresh === false && JSON.stringify(st1.rack) === JSON.stringify(d.standing), "the second ball's rack is the pins where they stood, with their yaws");
      await sleep(Math.max(0, st1.readyAt - Date.now() - 100));
      a.emit("throw", { n: 2, x: 0, angle: 0, speed: 7400, spin: 0 });
      await waitFor(a, (x) => x.deliveries.length === 2, 10000);
      check(JSON.stringify(a.deliveries[1].before) === JSON.stringify(d.standing), "and the next delivery starts from them");
    }

    section("the bot bowls 120 to 600 ms after readyAt");
    await waitFor(a, (x) => x.st.turn === 1 && !x.st.pending, 20000);
    const botReady = a.st.readyAt, before = a.deliveries.length;
    await waitFor(a, (x) => x.deliveries.length > before, 20000);
    const bd = a.deliveries[a.deliveries.length - 1];
    check(bd.seat === 1 && bd.kind === "bot", "the bot's ball");
    check(bd.at - botReady >= 100 && bd.at - botReady <= 650, "at readyAt + 120..600 ms (a style's think time and the skill's pad)", bd.at - botReady);

    section("the wire parser writes exactly what the stock socket.io parser writes");
    {
      const stock = new (require("socket.io-parser").Encoder)(), ours = new (require("../parser").Encoder)();
      const frames = [
        { type: 2, nsp: "/", data: ["state", { room: a.st, mySeat: 0 }] }, { type: 2, nsp: "/", data: ["state", { room: a.st, mySeat: -1 }] },
        { type: 2, nsp: "/", data: ["delivery", d] }, { type: 2, nsp: "/", data: ["pong", { c: 1.5, s: 2 }] }, { type: 2, nsp: "/", data: ["err", "Bad throw."] },
        { type: 2, nsp: "/", data: ["joined", a.joined] }, { type: 2, nsp: "/", data: ["voice", { kind: "signal", from: 1, data: { sdp: "v=0\r\n\u2028" } }] },
        { type: 2, nsp: "/", data: ["refused", { code: "full", msg: "Room is full (8).", to: "join" }] }, { type: 0, nsp: "/", data: { sid: "abc" } },
        { type: 2, nsp: "/games", id: 7, data: ["state", { room: a.st, mySeat: 2 }] }, { type: 2, nsp: "/", data: ["state", { mySeat: 1, room: a.st }] },
        { type: 1, nsp: "/" }, { type: 3, nsp: "/", id: 3, data: [] },
      ];
      const same = frames.filter((f) => JSON.stringify(stock.encode(f)) === JSON.stringify(ours.encode(f))).length;
      check(same === frames.length, `${same}/${frames.length} frames identical (states, a delivery, pong, err, joined, voice, refused, connect, acks, other namespaces)`);
      const t1 = process.hrtime.bigint(); for (let i = 0; i < 400; i++) stock.encode(frames[0]); const t2 = process.hrtime.bigint(); for (let i = 0; i < 400; i++) ours.encode({ ...frames[0], data: ["state", { room: a.st, mySeat: i % 8 }] }); const t3 = process.hrtime.bigint();
      console.log(`  a state to 8 sockets: stock ${(Number(t2 - t1) / 1e6 / 50).toFixed(3)} ms, ours ${(Number(t3 - t2) / 1e6 / 50).toFixed(3)} ms`);
    }

    section("ping and pong");
    const c0 = Date.now();
    a.emit("ping", { c: c0 });
    await waitFor(a, (x) => x.pongs.length);
    shape(a.pongs[0], { c: "number", s: "number" }, "pong");
    const rtt = Date.now() - c0, off = a.pongs[0].s - (c0 + rtt / 2);
    check(a.pongs[0].c === c0 && Math.abs(off) < 50, `offset = s - (c + rtt/2) is ${off.toFixed(1)} ms on one machine (rtt ${rtt} ms)`);
    a.close();
  } finally {
    await srv.stop();
  }
  process.exit(done("protocol") ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
