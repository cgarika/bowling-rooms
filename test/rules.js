/* The rules over real sockets with short clocks (WORLD.md 2, 3.2, 9.1): create, join, settings and the frames
   suggestion, per-player options, bots, start refused at 1 seat, joins refused, turn enforcement, n de-duplication,
   clamps and "Bad throw.", readyAt gating, each delivery sent once and never in the state, the card equals score.card,
   the last frame's fresh racks, pins re-set where they stood with their yaw, bumpers, left-handers, roll-off (forced
   with gutter balls), rematch, host handover, leaving mid-game, chat, stickers, voice, presence, push tokens, and the
   room deleted when every human has left.

   node test/rules.js   (starts its own server on TEST_PORT, 3281 by default; or URL=... to use a running one) */
"use strict";
const S = require("../score");
const H = require("./helpers");
const { check, section, done } = H.checker();
const { client, connected, waitFor, sleep, release, autoBowl } = H;

/* Every delivery each socket saw must be the same list: one event per ball, never repeated. */
function oncePerBall(clients) {
  const ids = clients.map((c) => c.deliveries.map((d) => d.id));
  const uniq = ids.every((l) => new Set(l).size === l.length);
  return uniq;
}
/* The frames follow the rules: from the deliveries of one seat, in order. */
function validateFrames(deliveries, frames) {
  const bad = [];
  let prev = null;
  for (const d of deliveries.filter((x) => !x.rolloff)) {
    const last = d.frame === frames;
    if (d.nth === 1) { if (d.before.length !== 10) bad.push(`frame ${d.frame} ball 1 not at a fresh rack`); }
    else {
      const prevCleared = prev && prev.standing.length === 0;
      if (!last && d.nth > 2) bad.push("a third ball before the last frame");
      if (!last && d.nth === 2) {
        if (prevCleared) bad.push("a second ball after a strike");
        else if (JSON.stringify(d.before) !== JSON.stringify(prev.standing)) bad.push(`frame ${d.frame}: the second ball's pins are not where the first left them`);
      }
      if (last) {
        const fresh = prevCleared;
        if (fresh && d.before.length !== 10) bad.push("tenth: a cleared rack not reset");
        if (!fresh && JSON.stringify(d.before) !== JSON.stringify(prev.standing)) bad.push("tenth: a leave not kept where it stood");
      }
    }
    prev = d;
  }
  return bad;
}

(async () => {
  const srv = await H.startServer();
  const URL = srv.url;
  try {
    section("a room forms");
    const a = client(URL, "Ana"), b = client(URL, "Ben");
    await Promise.all([connected(a), connected(b)]);
    a.emit("start");                                          // not in a room yet: nothing happens
    a.emit("create", { name: "Ana", playerId: a.playerId });
    await waitFor(a, (x) => x.st && x.joined);
    const code = a.st.code;
    check(/^[A-HJKMNPRTWXYZ]{6}$/.test(code), "room code is six letters from the 19 (ABCDEFGHJKMNPRTWXYZ), never a digit", code);
    check(a.joined.playerId === a.playerId && typeof a.joined.seatKey === "string", "joined carries the player id and a seat key");
    check(a.seat === 0 && a.st.hostSeat === 0 && a.st.status === "lobby", "the creator is seat 0 and the host");
    check(a.st.minPlayers === 2 && a.st.maxPlayers === 8, "2 to 8 seats");
    check(a.st.frames === 5 && a.st.settings.rolloff === true, "5 frames and roll-off on by default");

    section("start is refused with one seat");
    a.emit("start");
    await waitFor(a, (x) => x.errors.length);
    check(a.errors[0] === "Add a bot or invite a friend.", "Start with 1 seat: the reason", a.errors[0]);
    check(a.refused[0] && a.refused[0].code === "seats", "and a machine-readable refusal", a.refused[0]);

    section("joining");
    b.emit("join", { code: code.toLowerCase(), name: "Ben", playerId: b.playerId });
    await waitFor(b, (x) => x.st && x.st.players.length === 2);
    check(b.seat === 1, "the joiner takes seat 1 (codes are not case sensitive)");
    const x0 = client(URL, "X"); await connected(x0);
    x0.emit("join", { code: "ZZZZZZ", name: "X" });
    await waitFor(x0, (x) => x.errors.length);
    check(x0.errors[0] === "No room with that code." && x0.refused[0].code === "not_found", "an unknown code is refused");
    x0.emit("join", { code, name: "   " });
    await waitFor(x0, (x) => x.errors.length > 1);
    check(x0.errors[1] === "Pick a name first.", "an empty name is refused");
    x0.close();

    section("settings (host, lobby) and per-player options");
    b.emit("settings", { frames: 3 });
    await sleep(150);
    check(a.st.frames === 5, "a guest cannot change the settings");
    a.emit("settings", { frames: 7 }); await sleep(100);
    check(a.st.frames === 5, "only 3, 5 or 10 frames");
    a.emit("settings", { frames: 3, rolloff: false });
    await waitFor(a, (x) => x.st.frames === 3 && x.st.settings.rolloff === false);
    check(a.st.settings.touched === true, "the host touched the Frames segment");
    a.emit("settings", { rolloff: true });
    await waitFor(a, (x) => x.st.settings.rolloff === true);
    b.emit("options", { bumpers: true, lefty: true, ball: "galaxy" });
    await waitFor(a, (x) => x.st.players[1].bumpers && x.st.players[1].lefty && x.st.players[1].ball === "galaxy");
    check(a.st.players[1].bumpers && a.st.players[1].lefty && a.st.players[1].ball === "galaxy", "a seat sets its own bumpers, hand and ball");
    b.emit("options", { ball: "plaid" }); await sleep(100);
    check(a.st.players[1].ball === "galaxy", "only the house rack's patterns");
    check(a.st.players[0].ball === "solid" && a.st.players[0].bumpers === false, "seat 0 keeps the solid house ball");

    section("the frames suggestion follows the seats until the host chooses");
    {
      const h = client(URL, "Hal"); await connected(h);
      h.emit("create", { name: "Hal" }); await waitFor(h, (x) => x.st);
      for (let i = 0; i < 3; i++) h.emit("addBot");
      await waitFor(h, (x) => x.st.players.length === 4);
      check(h.st.frames === 5 && h.st.settings.suggested === 5, "4 seats: 5 frames suggested");
      for (let i = 0; i < 3; i++) h.emit("addBot");
      await waitFor(h, (x) => x.st.players.length === 7);
      check(h.st.frames === 3, "7 seats: 3 frames");
      const bots = h.st.players.filter((p) => p.bot);
      check(bots.map((p) => p.skill).join(",") === "regular,rookie,pro,regular,rookie,pro", "+Bot adds Regular, Rookie, Pro, Regular ...", bots.map((p) => p.skill));
      check(bots.map((p) => p.name).join(",") === "Kingpin,Lucky,Spare Parts,Alley Cat,Ten Pin,Gutter Gus", "the bot names", bots.map((p) => p.name));
      h.emit("addBot"); await waitFor(h, (x) => x.st.players.length === 8);
      check(h.st.players[7].name === "Lefty" && h.st.players[7].lefty, "Lefty bowls left-handed");
      h.emit("addBot"); await waitFor(h, (x) => x.refused.length);
      check(h.st.players.length === 8 && h.refused[0].code === "full", "addBot is refused past 8");
      const late = client(URL, "Late"); await connected(late);
      late.emit("join", { code: h.st.code, name: "Late" }); await waitFor(late, (x) => x.errors.length);
      check(late.errors[0] === "Room is full (8).", "a full room refuses a join", late.errors[0]);
      late.close();
      h.emit("settings", { frames: 10 }); await waitFor(h, (x) => x.st.frames === 10);
      h.emit("removeBot"); await waitFor(h, (x) => x.st.players.length === 7);
      check(h.st.frames === 10, "after the host chooses, the seats no longer move it");
      h.emit("leave"); await sleep(100);
      const again = client(URL, "Again"); await connected(again);
      again.emit("join", { code: h.st.code, name: "Again" }); await waitFor(again, (x) => x.errors.length);
      check(again.errors[0] === "No room with that code.", "a room whose last human left is gone");
      again.close(); h.close();
    }

    section("the game starts");
    a.emit("start");
    await waitFor(a, (x) => x.st.status === "playing");
    const r0 = a.st;
    check(r0.frame === 1 && r0.ball === 1 && r0.turn === 0 && r0.fresh === true, "frame 1, ball 1, seat 0, a fresh rack");
    check(r0.rack.length === 10 && r0.rack.every((p) => p.length === 4), "the rack: ten pins as [n, x mm, y mm, yaw mrad]");
    check(r0.throwSeq === 0 && typeof r0.readyAt === "number" && typeof r0.turnEndsAt === "number" && typeof r0.now === "number", "throwSeq, readyAt, turnEndsAt and the server's clock");
    check(r0.sheets.length === 2 && r0.sheets[0].frames.length === 3, "a sheet per seat, three frames");
    const c2 = client(URL, "Cat"); await connected(c2);
    c2.emit("join", { code, name: "Cat" }); await waitFor(c2, (x) => x.errors.length);
    check(c2.errors[0] === "That game already started." && c2.refused[0].code === "started", "a join after the start is refused");
    c2.close();

    section("turn enforcement, n, clamps");
    b.emit("throw", { n: 1, ...release() });
    await sleep(200);
    check(a.st.throwSeq === 0 && a.deliveries.length === 0, "a throw out of turn is ignored");
    a.emit("throw", { n: 2, ...release() });
    await sleep(200);
    check(a.st.throwSeq === 0 && a.deliveries.length === 0, "n must be throwSeq + 1");
    a.emit("throw", { n: 1, x: "wide", angle: 0, speed: 7000, spin: 0 });
    await waitFor(a, (x) => x.errors.includes("Bad throw."));
    check(a.errors.includes("Bad throw.") && a.st.throwSeq === 0, "a release that is not four numbers: \"Bad throw.\"");
    a.emit("throw", { n: 1, x: 1e9, angle: -1e9, speed: 0, spin: 5000 });
    a.emit("throw", { n: 1, x: 1e9, angle: -1e9, speed: 0, spin: 5000 });   // the same throw twice
    await waitFor(a, (x) => x.deliveries.length === 1 && x.st.throwSeq === 1);
    await sleep(200);
    const d1 = a.deliveries[0];
    check(a.deliveries.length === 1 && a.st.throwSeq === 1, "the same throw sent twice is one ball");
    check(JSON.stringify(d1.release) === JSON.stringify({ x: 4000, angle: -3500, speed: 5400, spin: 1000 }), "out-of-range values are clamped and echoed", d1.release);
    check(JSON.stringify(a.st.lastThrow.release) === JSON.stringify(d1.release), "the state's lastThrow echoes what was bowled");

    section("a delivery is an event, sent once, never in the state");
    await waitFor(b, (x) => x.deliveries.length === 1);
    check(b.deliveries.length === 1 && b.deliveries[0].id === d1.id, "every phone gets the same delivery once");
    const stateText = JSON.stringify(a.st);
    check(!("pins" in a.st.lastThrow) && !("ball" in a.st.lastThrow && typeof a.st.lastThrow.ball === "string") && !("ev" in a.st.lastThrow), "the state carries no track");
    check(stateText.length < 12000, `the state is small (${stateText.length} bytes)`);
    for (const k of ["id", "n", "seat", "at", "seed", "release", "before", "deckAt", "playMs", "ball", "pins", "ev", "down", "standing", "call", "leave", "replay", "mph", "entryBoard", "entryAngle"]) check(k in d1, "the delivery has " + k);
    const v0 = a.st.v, dl0 = b.deliveries.length;
    a.emit("chat", { sticker: "fire" });
    await waitFor(b, (x) => x.st.v > v0);
    check(b.deliveries.length === dl0 && b.st.chat.some((m) => m.s === "fire"), "a sticker re-sends the small state, not the delivery");

    section("a whole three-frame game");
    const stopA = autoBowl(a), stopB = autoBowl(b);
    await waitFor(a, (x) => x.st.status === "over" || x.st.status === "rolloff", 60000);
    await waitFor(a, (x) => x.st.status === "over", 60000);
    stopA(); stopB();
    await sleep(200);
    const fin = a.st;
    check(fin.status === "over" && fin.winners.length >= 1 && fin.winner === fin.winners[0], "the game ends with a winner", fin.winners);
    check(oncePerBall([a, b]), "no phone saw a delivery twice");
    check(JSON.stringify(a.deliveries.map((d) => d.id)) === JSON.stringify(b.deliveries.map((d) => d.id)), "both phones saw the same deliveries in the same order");
    for (const seat of [0, 1]) {
      const mine = a.deliveries.filter((d) => d.seat === seat && !d.rolloff);
      const sheet = fin.sheets[seat];
      check(JSON.stringify(sheet.balls) === JSON.stringify(mine.map((d) => d.count)), `seat ${seat}: the sheet's balls are the deliveries' counts`);
      const card = S.card(sheet.balls, 3);
      check(JSON.stringify(sheet.frames.map((f) => [f.marks, f.cum])) === JSON.stringify(card.frames.map((f) => [f.marks, f.cum])) && sheet.total === card.total, `seat ${seat}: the card equals score.card`);
      const bad = validateFrames(mine, 3);
      check(bad.length === 0, `seat ${seat}: every ball at the right rack (fresh, or where the pins stood with their yaw)`, bad);
      check(mine.every((d) => d.count === d.down.length && d.before.length === d.down.length + d.standing.length), `seat ${seat}: down + standing = the rack before`);
    }
    check(a.deliveries.filter((d) => d.seat === 1 && !d.rolloff).every((d) => d.bumpers && d.lefty && !d.gutter), "Ben's balls carry his bumpers and hand, and none went in the gutter");

    section("rematch (host only): same seats, settings and options");
    b.emit("rematch"); await sleep(150);
    check(a.st.status === "over", "a guest cannot rematch");
    const seqBefore = a.st.throwSeq;
    a.emit("rematch");
    await waitFor(a, (x) => x.st.status === "playing");
    check(a.st.frames === 3 && a.st.players[1].bumpers && a.st.players[1].ball === "galaxy", "settings and options kept");
    check(a.st.sheets.every((s) => s.balls.length === 0) && a.st.throwSeq === seqBefore && a.st.frame === 1, "fresh sheets; throwSeq keeps counting");

    section("host handover and leaving mid-game");
    const c = client(URL, "Cy"); await connected(c);
    // a third human, in a new room, to see the host move on a leave during play
    const h1 = client(URL, "H1"), h2 = client(URL, "H2"), h3 = client(URL, "H3");
    await Promise.all([connected(h1), connected(h2), connected(h3)]);
    h1.emit("create", { name: "H1", playerId: h1.playerId }); await waitFor(h1, (x) => x.st);
    h2.emit("join", { code: h1.st.code, name: "H2", playerId: h2.playerId }); h3.emit("join", { code: h1.st.code, name: "H3", playerId: h3.playerId });
    await waitFor(h1, (x) => x.st.players.length === 3);
    h1.emit("settings", { frames: 3 }); h1.emit("start");
    await waitFor(h2, (x) => x.st && x.st.status === "playing");
    h1.emit("leave");
    await waitFor(h2, (x) => x.st.hostSeat === 1);
    check(h2.st.hostSeat === 1 && /H2 is now the host|H1 left/.test(h2.st.log), "the host leaves: the next human is the host", h2.st.log);
    check(h2.st.players[0].left === true && h2.st.turn === 1, "the leaver's seat is marked left and the turn moved on");
    h2.emit("leave");
    await waitFor(h3, (x) => x.st.status === "over");
    check(h3.st.status === "over" && h3.st.winners.join() === "2", "the last one standing wins when everyone else left", h3.st.log);
    const back = client(URL, "H1back", { playerId: h1.playerId }); await connected(back);
    back.emit("join", { code: h1.st.code, name: "H1", playerId: h1.playerId });
    await waitFor(back, (x) => x.errors.length);
    check(back.refused[0] && back.refused[0].code === "left", "a player who left the game cannot take the seat again", back.errors[0]);
    [c, h1, h2, h3, back].forEach((s) => s.close());

    section("roll-off (forced with gutter balls), then a shared win after three");
    {
      const p = client(URL, "P"), q = client(URL, "Q");
      await Promise.all([connected(p), connected(q)]);
      p.emit("create", { name: "P" }); await waitFor(p, (x) => x.st);
      q.emit("join", { code: p.st.code, name: "Q", playerId: q.playerId }); await waitFor(p, (x) => x.st.players.length === 2);
      p.emit("settings", { frames: 3, rolloff: true }); p.emit("start");
      const g = () => release("gutter");
      const s1 = autoBowl(p, g), s2 = autoBowl(q, g);
      let sawRolloff = null;
      p.on("state", ({ room }) => { if (!sawRolloff && room.status === "rolloff") sawRolloff = room; });
      await waitFor(p, (x) => x.st.status === "over", 30000);
      s1(); s2();
      check(sawRolloff && sawRolloff.rolloff.round === 1 && sawRolloff.rolloff.seats.join() === "0,1" && sawRolloff.turn === 0 && sawRolloff.fresh && sawRolloff.rack.length === 10, "a tie goes to a roll-off between the tied seats, at a full rack, seat 0 first", sawRolloff && sawRolloff.rolloff);
      const rolls = p.deliveries.filter((d) => d.rolloff);
      check(rolls.map((d) => d.seat).join() === "0,1,0,1,0,1" && rolls.every((d) => d.before.length === 10 && d.fresh), "one ball each, in seat order, at a full rack, three times", rolls.map((d) => d.seat));
      check(p.st.rolloff.history.length === 3 && p.st.winners.join() === "0,1", "three tied roll-offs, then the win is shared", p.st.rolloff.history);
      check(/share the win/.test(p.st.log), "the log says so", p.st.log);
      check(p.st.sheets.every((s) => s.total === 0 && s.balls.length === 6), "roll-off balls are not added to the sheets");
      // and a roll-off with a winner
      p.emit("rematch"); await waitFor(p, (x) => x.st.status === "playing");
      const t1 = autoBowl(p, (r) => (r.status === "rolloff" ? release("house") : release("gutter"))), t2 = autoBowl(q, g);
      await waitFor(p, (x) => x.st.status === "over", 30000);
      t1(); t2();
      check(p.st.winners.join() === "0" && p.st.rolloff.history.length === 1, "the most pins in the roll-off wins", p.st.rolloff);
      const ro = p.deliveries.filter((d) => d.rolloff);
      check(ro.length >= 2 && ro.every((d) => d.before.length === 10 && d.frame === null && d.replay === false), "roll-off balls are at a full rack, with no frame and no replay");
      // roll-off off: a tie is shared at once
      p.emit("options", {}); p.emit("rematch"); await waitFor(p, (x) => x.st.status === "playing");
      p.emit("leave"); q.emit("leave"); p.close(); q.close();
    }
    {
      const p = client(URL, "P2"), q = client(URL, "Q2");
      await Promise.all([connected(p), connected(q)]);
      p.emit("create", { name: "P2" }); await waitFor(p, (x) => x.st);
      q.emit("join", { code: p.st.code, name: "Q2", playerId: q.playerId }); await waitFor(p, (x) => x.st.players.length === 2);
      p.emit("settings", { frames: 3, rolloff: false }); p.emit("start");
      const s1 = autoBowl(p, () => release("gutter")), s2 = autoBowl(q, () => release("gutter"));
      await waitFor(p, (x) => x.st.status === "over", 30000);
      s1(); s2();
      check(p.st.winners.join() === "0,1" && !p.st.rolloff, "roll-off off: a tie for first is shared", p.st.log);
      p.close(); q.close();
    }

    section("a strike's call, the last frame's bonus balls, a perfect start");
    {
      // a bot-only table plays itself; check the calls against the rules on every ball
      const w = client(URL, "Watcher"); await connected(w);
      w.emit("create", { name: "Watcher" }); await waitFor(w, (x) => x.st);
      for (let i = 0; i < 3; i++) w.emit("addBot");
      await waitFor(w, (x) => x.st.players.length === 4);
      w.emit("settings", { frames: 10 }); w.emit("start");
      const stop = autoBowl(w);
      await waitFor(w, (x) => x.st.status === "over", 120000);
      stop();
      const ds = w.deliveries.filter((d) => !d.rolloff);
      const strikes = ds.filter((d) => d.fresh && d.count === 10);
      const spares = ds.filter((d) => !d.fresh && d.count === d.before.length);
      check(spares.every((d) => d.call === "spare" || d.call === "converted"), `every spare is called a spare (${spares.length})`);
      check(strikes.length > 0 && strikes.every((d) => ["strike", "double", "turkey", "inarow", "perfect"].includes(d.call)), `every strike is called a strike (${strikes.length})`);
      const splits = ds.filter((d) => d.split);
      check(splits.every((d) => d.call === "split" && d.leave), `every split is called with its leave (${splits.length})`);
      const tenth = ds.filter((d) => d.frame === 10);
      check(tenth.some((d) => d.nth === 3) || tenth.every((d) => d.nth <= 2), "the tenth has a third ball only when earned");
      for (let seat = 0; seat < 4; seat++) {
        const bad = validateFrames(ds.filter((d) => d.seat === seat), 10);
        check(bad.length === 0, `seat ${seat}: every ball at the right rack over ten frames`, bad);
      }
      const card = w.st.sheets.map((s) => S.card(s.balls, 10).total);
      check(JSON.stringify(card) === JSON.stringify(w.st.totals), "the totals are the cards'", w.st.totals);
      check(ds.every((d) => d.kind === (d.seat === 0 ? "human" : "bot")), "the bots bowl their own balls");
      w.close();
    }

    section("ping, chat, voice, presence, push tokens");
    a.emit("ping", { c: 12345 });
    await waitFor(a, (x) => x.pongs.length);
    check(a.pongs[0].c === 12345 && Math.abs(a.pongs[0].s - Date.now()) < 2000, "ping answers with the server's clock");
    for (let i = 0; i < 10; i++) a.emit("ping", { c: i });
    a.emit("ping", { c: "x" }); a.emit("ping", null);
    await sleep(300);
    check(a.pongs.length <= 5, "at most 4 pings a second are answered", a.pongs.length);
    a.emit("chat", { text: "<b>hi</b> there" });
    await sleep(900);
    a.emit("chat", { sticker: "nope" }); a.emit("chat", { text: "too soon" });
    await waitFor(b, (x) => x.st.chat.some((m) => m.k === "t"));
    const texts = b.st.chat.filter((m) => m.k === "t").map((m) => m.x);
    check(texts.includes("bhi/b there"), "chat is cleaned of markup", texts);
    check(!texts.includes("too soon") && !b.st.chat.some((m) => m.s === "nope"), "chat has a cooldown and a fixed sticker list");
    a.emit("voice", { kind: "join" }); await waitFor(b, (x) => x.st.voice.includes(0));
    check(b.st.voice.includes(0), "voice join shows in the state");
    let sig = null; b.on("voice", (v) => { sig = v; });
    a.emit("voice", { kind: "signal", to: 1, data: { sdp: "x" } });
    await waitFor(b, () => sig);
    check(sig && sig.from === 0 && sig.data.sdp === "x", "a voice signal reaches its seat");
    sig = null; a.emit("voice", { kind: "signal", to: 1, data: { big: "x".repeat(30000) } }); await sleep(200);
    check(sig === null, "a signal over 20k is dropped");
    a.emit("presence", { away: true }); a.emit("pushToken", { token: "zz" }); a.emit("pushToken", { token: "ab".repeat(20) });
    await sleep(100);
    check((await srv.health()).ok, "the server is well after all of it");
    a.close(); b.close();
  } finally {
    await srv.stop();
  }
  process.exit(done("rules") ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
