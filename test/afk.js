/* The AFK policy (WORLD.md 2.1, 2.3; copied in spirit from ludo-rooms' test/afk.js): a ball not bowled in time is the
   timeout ball (straight down the middle at 6.2 m/s); three in a row and a bot (the Rookie) bowls for them; a throw,
   Take my seat back or a reconnect hands the seat back; a disconnected bowler's clock is AFK_MS.

   node test/afk.js   (its own server with TURN_MS 1200 and AFK_MS 500) */
"use strict";
const H = require("./helpers");
const { check, section, done } = H.checker();
const { client, connected, waitFor, sleep } = H;

(async () => {
  const srv = await H.startServer({ TURN_MS: "1200", AFK_MS: "500" });
  try {
    const a = client(srv.url, "Ana"), b = client(srv.url, "Ben");
    await Promise.all([connected(a), connected(b)]);
    a.emit("create", { name: "Ana", playerId: a.playerId }); await waitFor(a, (x) => x.st);
    b.emit("join", { code: a.st.code, name: "Ben", playerId: b.playerId }); await waitFor(a, (x) => x.st.players.length === 2);
    const seen = H.logs(a);
    const stopB = H.autoBowl(b);                              // Ben bowls his own balls until he drops
    a.emit("settings", { frames: 10 }); a.emit("start");
    await waitFor(a, (x) => x.st.status === "playing");

    section("a ball not bowled in time is the timeout ball");
    const t0 = Date.now();
    await waitFor(a, (x) => x.deliveries.length >= 1, 5000);
    const d = a.deliveries[0];
    check(d.seat === 0 && d.kind === "timeout", "Ana's first ball was bowled for her", d.kind);
    check(Date.now() - t0 >= 1000, "after her turn clock ran out (1.2 s here)", Date.now() - t0);
    check(JSON.stringify(d.release) === JSON.stringify({ x: 0, angle: 0, speed: 6200, spin: 0 }), "straight down the middle at 6.2 m/s", d.release);
    await waitFor(a, (x) => x.st.lastThrow && x.st.lastThrow.id === d.id);
    check(/ran out of time; the ball was bowled straight/.test(a.st.log) && a.st.players[0].timeouts === 1, "the table is told", a.st.log);

    section("three in a row and a bot bowls for them");
    await waitFor(a, (x) => x.st.players[0].botControlled, 15000);
    check(a.st.players[0].botControlled === true, "after three timeouts Ana's seat is bot-controlled");
    const ta = a.deliveries.filter((x) => x.seat === 0);
    check(ta.slice(0, 3).every((x) => x.kind === "timeout"), "three timeout balls", ta.map((x) => x.kind));
    await sleep(100);
    check(seen.some((l) => /ran out of time 3 times; a bot is bowling for them/.test(l)), "the table is told a bot is bowling", seen.slice(-6));
    const nBefore = a.deliveries.filter((x) => x.seat === 0).length;
    await waitFor(a, (x) => x.deliveries.filter((y) => y.seat === 0).length > nBefore, 10000);
    const botBall = a.deliveries.filter((x) => x.seat === 0).pop();
    check(botBall.kind === "bot", "the next ball is the bot's (bowled as the Rookie), not a timeout", botBall.kind);

    section("Take my seat back");
    a.emit("takeSeat");
    await waitFor(a, (x) => !x.st.players[0].botControlled);
    check(a.st.players[0].botControlled === false && a.st.players[0].timeouts === 0, "the seat is Ana's again");
    await waitFor(a, (x) => x.st.turn === 0 && !x.st.pending, 15000);
    const n = a.st.throwSeq + 1;
    a.emit("throw", { n, x: 600, angle: 2125, speed: 7400, spin: 1000 });
    await waitFor(a, (x) => x.deliveries.some((y) => y.n === n));
    check(a.deliveries.find((y) => y.n === n).kind === "human", "and her throw is hers");

    section("a disconnected bowler has AFK_MS, then the timeout ball");
    await waitFor(a, (x) => x.st.turn === 1 && !x.st.pending, 15000);
    stopB();
    b.close();
    await waitFor(a, (x) => x.st.players[1].connected === false);
    const st = a.st;
    check(st.turnEndsAt - Math.max(st.now, st.readyAt) <= 520, "the clock becomes 0.5 s (AFK_MS)", st.turnEndsAt - Math.max(st.now, st.readyAt));
    await waitFor(a, (x) => x.deliveries.some((y) => y.seat === 1 && y.kind === "timeout"), 5000);
    check(a.deliveries.some((y) => y.seat === 1 && y.kind === "timeout"), "then the timeout ball");
    await sleep(100);
    check(seen.some((l) => /Ben lost the connection; the ball was bowled straight/.test(l)), "\"Ben lost the connection; the ball was bowled straight.\"", seen.slice(-4));

    section("a reconnect hands the seat back");
    await waitFor(a, (x) => x.st.players[1].botControlled, 20000);
    check(a.st.players[1].botControlled, "Ben's seat went to the bot while he was away");
    const b2 = client(srv.url, "Ben", { playerId: b.playerId }); await connected(b2);
    b2.emit("join", { code: a.st.code, name: "Ben", playerId: b.playerId });
    await waitFor(a, (x) => x.st.players[1].connected && !x.st.players[1].botControlled);
    await sleep(100);
    check(!a.st.players[1].botControlled && seen.some((l) => /Ben is back/.test(l)), "Ben is back", seen.slice(-3));

    section("the game still finishes, and nothing is left running");
    a.emit("leave"); b2.emit("leave");
    await sleep(300);
    const h = await srv.health();
    check(h.rooms === 0 && h.timers.turn === 0 && h.timers.bot === 0, "no rooms and no timers left", h);
    a.close(); b2.close();
  } finally {
    await srv.stop();
  }
  process.exit(done("afk") ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
