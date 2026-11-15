/* Plato's show (bowling-plato, 2026-11-04; the owner: "the same way as Plato"): over real sockets with the real clocks, the beats after a person's ball start HUMAN_SHOW_MS (6 s) after its
   release at the earliest, so the phone's result strip holds to the end of its show, then the next bowler's name shows in the band, then their ball:
   - a first ball that leaves pins holds the second ball's time 6 s + the machine's 0.35 s after the release (the phone's aim is ready 6.4 s after it);
   - a strike hands the lane over no sooner than 6 s + the hand-over's 0.15 s after the release, and the bot's ball that follows goes after that and not under the strip;
   - a bot's own ball keeps its quick pace (the next time well under 3.5 s after it);
   - HUMAN_SHOW_MS=0 gives the pace of 2026-11-02 back (the next time about 4 s after a strike: the first hit, 1 s of crash, the call and the hand-over). */
"use strict";
const H = require("./helpers");

(async () => {
  const { check, section, done } = H.checker();
  const real = { RESULT_MS: "", RESET_MS: "", HANDOFF_MS: "", COSMIC_MS: "", ROLLOFF_MS: "", BOT_MS: "", TURN_MS: "", ARRIVAL_MS: "300", PLAY_MS_SCALE: "1", QUICK_FILL_MS: "400", HUMAN_SHOW_MS: "" };
  const base = Number(process.env.TEST_PORT || 5459);
  // The same two releases on a full rack, through the server's own physics, which is the same every time for the same release: 7 down (6, 7 and 10 left), and a strike.
  const LEAVES = { x: 0, angle: 0, speed: 7400, spin: 0 }, STRIKE = { x: 0, angle: 0, speed: 8400, spin: 200 };
  const SHOW = 6000, RESET = 350, HAND = 150;
  const srvA = await H.startServer(real, base + 3);
  const srvB = await H.startServer({ ...real, HUMAN_SHOW_MS: "0" }, base + 4);
  const clients = [];
  /* A host with one bot in a room of three frames, started: the host bowls first. */
  async function newGame(srv, name) {
    const h = H.client(srv.url, name);
    clients.push(h);
    await H.connected(h);
    h.emit("create", { name, playerId: h.playerId });
    await H.waitFor(h, (x) => x.st && x.st.code);
    h.emit("addBot"); await H.sleep(80);
    h.emit("settings", { frames: 3 }); await H.sleep(100);
    h.emit("start");
    await H.waitFor(h, (x) => x.st && x.st.status === "playing", 4000);
    return h;
  }
  try {
    section("a person's ball is shown to Plato's 6 s before anything goes under it (HUMAN_SHOW_MS 6000)");
    const a = await newGame(srvA, "Leaves"), b = await newGame(srvA, "Striker");   // two rooms at once, so the waits overlap
    const [da, db] = await Promise.all([H.bowlWhenMine(a, LEAVES), H.bowlWhenMine(b, STRIKE)]);
    check(da && da.count === 7 && db && db.count === 10 && db.call === "strike", "the two balls are the ones the checks below are about: seven down, and a strike", [da && da.count, db && db.count]);
    if (da && db) {
      check(a.st.turn === a.seat && a.st.ball === 2, "the first ball left pins: the second is the same bowler's", [a.st.turn, a.st.ball]);
      check(a.st.readyAt - da.at >= SHOW + RESET && a.st.readyAt - da.at <= SHOW + RESET + 150, "its time comes 6 s + 0.35 s after the release, not at the 3.9 s of the quick pace", a.st.readyAt - da.at);
      check(b.st.turn !== b.seat, "a strike ends the bowler's frame: the bot is up", [b.st.turn, b.seat]);
      check(b.st.readyAt - db.at >= SHOW + HAND && b.st.readyAt - db.at <= SHOW + HAND + 150, "the hand-over comes 6 s + 0.15 s after the release", b.st.readyAt - db.at);
      check(await H.waitFor(b, (x) => x.deliveries.length >= 2, 14000), "the bot bowls");
      const bd = b.deliveries[1];
      if (bd) {
        check(bd.seat !== b.seat && bd.at - db.at >= SHOW, "its ball goes after the show, not under the strip", bd.at - db.at);
        check(await H.waitFor(b, (x) => x.st.throwSeq >= 2, 4000), "and is scored");
        check(b.st.readyAt - bd.at > 0 && b.st.readyAt - bd.at < 3500, "a bot's own ball keeps its quick pace: the next time under 3.5 s after it", b.st.readyAt - bd.at);
      }
    }

    section("HUMAN_SHOW_MS=0 gives the pace of 2026-11-02 back");
    const c = await newGame(srvB, "Quick");
    const dc = await H.bowlWhenMine(c, STRIKE);
    check(dc && dc.count === 10, "a strike");
    if (dc) check(c.st.readyAt - dc.at >= 2500 && c.st.readyAt - dc.at < 5000, "the hand-over comes about 4 s after the release", c.st.readyAt - dc.at);
  } finally {
    for (const s of clients) { try { s.close(); } catch (_) {} }
    await srvA.stop(); await srvB.stop();
  }
  process.exit(done("show") ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
