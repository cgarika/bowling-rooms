/* Bowling r1 (2026-11-02): the pace, Quick Play and the tap past the crash, over real sockets with the real clocks (what the phones feel).
   - Quick Play is one bot and three frames, however it filled (the room's frames and its suggestion say so).
   - Every delivery carries its crash time (a person's too, so the phone's crash and these clocks are the same), a bot's scaled to its replay.
   - The time between a person's turns with one bot is well under 12 s, and a bot's whole frame under 7 s of the room's clocks.
   - A "skip" past the first contact cuts the beats after it, once; from a seat that has no part in the ball, or for another ball, it does nothing. */
"use strict";
const H = require("./helpers");

(async () => {
  const { check, section, done } = H.checker();
  const real = { RESULT_MS: "", RESET_MS: "", HANDOFF_MS: "", COSMIC_MS: "", ROLLOFF_MS: "", BOT_MS: "", TURN_MS: "", ARRIVAL_MS: "300", PLAY_MS_SCALE: "1", QUICK_FILL_MS: "400" };
  const srv = await H.startServer(real, Number(process.env.TEST_PORT || 5459) + 1);
  try {
    section("Quick Play: one bot, three frames");
    const q = H.client(srv.url, "Quick");
    await H.connected(q);
    q.emit("quick", { name: "Quick", playerId: q.playerId });
    check(await H.waitFor(q, (x) => x.st && x.st.status === "playing", 8000), "a solo Quick Play player is in a game");
    check(q.st.players.length === 2 && q.st.players.filter((p) => p.bot).length === 1, "with one bot", q.st.players.map((p) => p.bot));
    check(q.st.frames === 3, "of three frames", q.st.frames);
    check(q.st.settings.suggested === 3, "and the room's suggestion says three");
    q.close();

    section("a created room is still the host's: five frames to begin with, the suggestion by the seats");
    const h = H.client(srv.url, "Host");
    await H.connected(h);
    h.emit("create", { name: "Host", playerId: h.playerId });
    await H.waitFor(h, (x) => x.st && x.st.code);
    h.emit("addBot"); await H.sleep(80);
    check(h.st.frames === 5, "a room made by hand keeps its five frames", h.st.frames);

    section("deliveries carry their crash time; the turns come round briskly");
    h.emit("settings", { frames: 3 }); await H.sleep(100);
    h.emit("start");
    await H.waitFor(h, (x) => x.st && x.st.status === "playing", 4000);
    const stop = H.autoBowl(h, () => H.release("house"));
    const t0 = Date.now();
    await H.waitFor(h, (x) => x.deliveries.length >= 5, 60000);
    stop();
    const mine = h.deliveries.filter((d) => d.seat === h.seat), bots = h.deliveries.filter((d) => d.seat !== h.seat);
    check(mine.length >= 1 && mine.every((d) => d.crashMs === 1000), "a person's delivery says its crash: 1000 ms", mine.map((d) => d.crashMs));
    check(bots.length >= 1 && bots.every((d) => d.speed > 1 && d.crashMs > 0 && d.crashMs < 2000), "a bot's says its speed and a shorter crash", bots.map((d) => [d.speed, d.crashMs]));
    check(Date.now() - t0 < 45000, "five balls (two of ours, a bot's frame and more) in well under 45 s", Date.now() - t0);

    section("a skip past the first contact cuts the beats after it, once");
    const room = () => h.st;
    await H.waitFor(h, (x) => x.st && x.st.status === "playing" && !x.st.pending && x.st.turn === x.seat && Date.now() >= (x.st.readyAt || 0) - 50, 40000);
    const n = room().throwSeq + 1;
    h.emit("throw", { n, ...H.release("house") });
    await H.waitFor(h, (x) => x.deliveries.length && x.deliveries[x.deliveries.length - 1].n === n && x.st.throwSeq >= n, 8000);
    const d = h.deliveries[h.deliveries.length - 1];
    const before = room().readyAt;
    const hit = (d.ev.find((e) => e[1] === 1) || [0])[0];
    // not for another ball
    h.emit("skip", { n: n + 7 }); await H.sleep(120);
    check(room().readyAt === before, "a skip for another ball does nothing");
    // from the bowler, past the contact (the ball's own clock has not yet reached it: the server clamps to contact + 650 ms + 250 ms)
    h.emit("skip", { n });
    await H.waitFor(h, (x) => x.st.readyAt < before, 2000);
    const after = room().readyAt;
    check(after < before, "the bowler's skip brings the next ball's time forward", [before - d.at, after - d.at]);
    check(after - d.at >= hit + 650, "never earlier than the contact, 650 ms of crash and the machine", [after - d.at, hit]);
    h.emit("skip", { n }); await H.sleep(150);
    check(room().readyAt === after, "a second skip does nothing");
    h.close();

    section("a seat that is neither the bowler nor next cannot skip");
    const a = H.client(srv.url, "A"), b = H.client(srv.url, "B"), c = H.client(srv.url, "C");
    await Promise.all([a, b, c].map(H.connected));
    a.emit("create", { name: "A", playerId: a.playerId });
    await H.waitFor(a, (x) => x.st && x.st.code);
    for (const s of [b, c]) { s.emit("join", { code: a.st.code, name: s.nm, playerId: s.playerId }); await H.waitFor(s, (x) => x.st && x.st.code === a.st.code, 3000); }
    a.emit("settings", { frames: 3 }); await H.sleep(100);
    a.emit("start");
    await H.waitFor(a, (x) => x.st && x.st.status === "playing" && !x.st.pending && Date.now() >= (x.st.readyAt || 0) - 50, 6000);
    const first = [a, b, c].find((s) => a.st.turn === s.seat);
    first.emit("throw", { n: a.st.throwSeq + 1, ...H.release("house") });
    await H.waitFor(a, (x) => x.deliveries.length >= 1 && x.st.throwSeq >= 1, 8000);
    const third = [a, b, c].find((s) => s.seat !== first.seat && s.seat !== a.st.turn);
    const ra = a.st.readyAt;
    third.emit("skip", { n: 1 }); await H.sleep(150);
    check(a.st.readyAt === ra, "the third seat's skip does nothing", [ra, a.st.readyAt]);
    [a, b, c].forEach((s) => s.close());
  } finally { await srv.stop(); }
  const failed = done("pace");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
