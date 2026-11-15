/* Reconnection (WORLD.md 3.8, 2.3): a socket that rejoins while a ball is playing gets that delivery once, after its
   state; after the ball, no delivery and the pins from the rack; a newer socket for the same player keeps the seat when
   the old one closes; the host moves to a connected human and keeps it when the old host is back; a socket that moves
   to another room leaves the first (GN-20); a lobby seat survives a dropped socket; a seat key, when required, guards
   the seat (GN-26); a room that is gone says so.

   node test/reconnect.js   (its own servers on TEST_PORT and TEST_PORT + 1) */
"use strict";
const H = require("./helpers");
const { check, section, done } = H.checker();
const { client, connected, waitFor, sleep } = H;

(async () => {
  const port = Number(process.env.TEST_PORT || 3281);
  const srv = await H.startServer({}, port);
  const URL = srv.url;
  try {
    section("a room of two humans");
    const a = client(URL, "Ana"), b = client(URL, "Ben");
    await Promise.all([connected(a), connected(b)]);
    a.emit("create", { name: "Ana", playerId: a.playerId }); await waitFor(a, (x) => x.st);
    const code = a.st.code;
    b.emit("join", { code, name: "Ben", playerId: b.playerId }); await waitFor(a, (x) => x.st.players.length === 2);

    section("the lobby keeps a dropped seat");
    b.close();
    await waitFor(a, (x) => x.st.players[1] && x.st.players[1].connected === false);
    check(a.st.players.length === 2 && a.st.players[1].connected === false, "a dropped socket in the lobby keeps its seat, marked disconnected");
    let b2 = client(URL, "Ben", { playerId: b.playerId }); await connected(b2);
    b2.emit("join", { code, name: "Ben", playerId: b.playerId });
    await waitFor(a, (x) => x.st.players[1].connected === true);
    check(b2.seat === 1 && a.st.players.length === 2, "the same player id comes back to the same seat");

    section("a rejoin during a delivery gets it once, after the state");
    a.emit("settings", { frames: 3 }); a.emit("start");
    await waitFor(a, (x) => x.st.status === "playing");
    await sleep(50);
    a.emit("throw", { n: 1, x: 600, angle: 2125, speed: 7400, spin: 1000 });
    await waitFor(a, (x) => x.deliveries.length === 1);
    const d = a.deliveries[0];
    b2.close();
    await waitFor(a, (x) => x.st.players[1].connected === false);
    const order = [];
    const b3 = client(URL, "Ben", { playerId: b.playerId });
    b3.on("state", () => order.push("state")); b3.on("delivery", () => order.push("delivery")); b3.on("joined", () => order.push("joined"));
    await connected(b3);
    b3.emit("join", { code, name: "Ben", playerId: b.playerId });
    await waitFor(b3, (x) => x.deliveries.length === 1 && x.st);
    await sleep(200);
    check(b3.deliveries.length === 1 && b3.deliveries[0].id === d.id, "the rejoining phone gets the ball in flight", b3.deliveries.map((x) => x.id));
    check(order.indexOf("joined") === 0 && order.indexOf("state") < order.indexOf("delivery"), "joined, then the state, then the delivery", order);
    check(Date.now() - d.at < d.playMs, "(it was still playing)");
    check(JSON.stringify(b3.deliveries[0].before) === JSON.stringify(d.before), "its before builds the pins as they stood before the ball");
    const a0 = a.deliveries.length;
    b3.emit("chat", { sticker: "party" });
    await sleep(300);
    check(a.deliveries.length === a0 && b3.deliveries.length === 1, "a sticker does not re-send it");

    section("a rejoin after the delivery: no replay, the rack from the state");
    await sleep(Math.max(0, d.at + d.playMs - Date.now() + 100));
    b3.close();
    await waitFor(a, (x) => x.st.players[1].connected === false);
    const b4 = client(URL, "Ben", { playerId: b.playerId }); await connected(b4);
    b4.emit("join", { code, name: "Ben", playerId: b.playerId });
    await waitFor(b4, (x) => x.st);
    await sleep(250);
    check(b4.deliveries.length === 0, "no delivery after it has played");
    const expect = a.st.fresh ? 10 : d.standing.length;
    check(b4.st.rack.length === expect && (b4.st.fresh || JSON.stringify(b4.st.rack) === JSON.stringify(d.standing)), "the rack is where the pins stand (position and yaw)");

    section("two sockets for one player");
    const b5 = client(URL, "Ben", { playerId: b.playerId }); await connected(b5);
    b5.emit("join", { code, name: "Ben", playerId: b.playerId });
    await waitFor(b5, (x) => x.st);
    b4.close();
    await sleep(300);
    check(a.st.players[1].connected === true, "closing the older socket does not disconnect the player on the newer one");

    section("the host moves to a connected human, and keeps it");
    a.close();
    await waitFor(b5, (x) => x.st.hostSeat === 1);
    check(b5.st.hostSeat === 1 && /Ben is now the host/.test(b5.st.log), "the host dropped: Ben is the host", b5.st.log);
    const a2 = client(URL, "Ana", { playerId: a.playerId }); await connected(a2);
    a2.emit("join", { code, name: "Ana", playerId: a.playerId });
    await waitFor(a2, (x) => x.st && x.st.players[0].connected);
    check(a2.st.hostSeat === 1, "Ana is back; Ben stays the host");

    section("one room per socket (GN-20)");
    const v1 = a2.st.v;
    a2.emit("create", { name: "Ana", playerId: a.playerId });
    await waitFor(a2, (x) => x.st && x.st.code !== code);
    const other = a2.st.code;
    await sleep(300);
    check(b5.st.players[0].connected === false, "moving to another room leaves the first");
    const seenOld = [];
    a2.on("state", ({ room }) => { if (room.code === code) seenOld.push(room.v); });
    b5.emit("chat", { text: "still there?" });
    await sleep(400);
    check(seenOld.length === 0 && a2.st.code === other, "and its states stop", seenOld);
    void v1;

    section("a player who left cannot come back; a room whose humans all left is gone");
    b5.emit("leave");
    await sleep(200);
    const z = client(URL, "Z", { playerId: b.playerId }); await connected(z);
    z.emit("join", { code, name: "Ben", playerId: b.playerId });
    await waitFor(z, (x) => x.errors.length);
    check(z.refused[0] && z.refused[0].code === "left", "Ben left the game: his id does not take the seat again", z.errors[0]);
    const y = client(URL, "Ana", { playerId: a.playerId }); await connected(y);
    y.emit("join", { code, name: "Ana", playerId: a.playerId }); await waitFor(y, (x) => x.st && x.st.code === code);
    y.emit("leave"); await sleep(200);
    z.emit("join", { code, name: "Ben", playerId: b.playerId });
    await waitFor(z, (x) => x.errors.length > 1);
    check(z.errors[1] === "No room with that code.", "when the last human leaves, the room is gone and a rejoin is told so", z.errors[1]);
    [z, y, a2, b5].forEach((s) => s.close());
  } finally {
    await srv.stop();
  }

  section("a room nobody human is connected to is closed (EMPTY_ROOM_MS; 10 minutes by default)");
  const srv3 = await H.startServer({ EMPTY_ROOM_MS: "1500", SWEEP_MS: "200" }, port + 1);
  try {
    const a = client(srv3.url, "Ana"), b = client(srv3.url, "Ben");
    await Promise.all([connected(a), connected(b)]);
    a.emit("create", { name: "Ana", playerId: a.playerId }); await waitFor(a, (x) => x.st);
    b.emit("create", { name: "Ben", playerId: b.playerId }); await waitFor(b, (x) => x.st);
    a.emit("addBot"); await waitFor(a, (x) => x.st.players.length === 2);
    a.emit("start"); await waitFor(a, (x) => x.st.status === "playing");
    const codeA = a.st.code;
    a.close();                                             // Ana's phone dies mid-game; Ben stays in his lobby
    await sleep(3000);
    const h = await srv3.health();
    check(h.rooms === 1 && h.emptyRoomsClosed === 1, "the room with no one connected is gone; the one with Ben stays", h);
    const z = client(srv3.url, "Ana", { playerId: a.playerId }); await connected(z);
    z.emit("join", { code: codeA, name: "Ana", playerId: a.playerId }); await waitFor(z, (x) => x.errors.length);
    check(z.errors[0] === "No room with that code.", "a late rejoin is told so");
    [b, z].forEach((s) => s.close());
  } finally { await srv3.stop(); }

  section("a seat key, when the server requires it (REQUIRE_SEAT_KEY=1)");
  const srv2 = await H.startServer({ REQUIRE_SEAT_KEY: "1", PING_INTERVAL_MS: "5000", PING_TIMEOUT_MS: "5000" }, port + 1);
  try {
    const a = client(srv2.url, "Ana"), b = client(srv2.url, "Ben");
    await Promise.all([connected(a), connected(b)]);
    const hs = JSON.parse((await (await fetch(srv2.url + "/socket.io/?EIO=4&transport=polling")).text()).slice(1));
    check(hs.pingInterval === 5000 && hs.pingTimeout === 5000, "the heartbeat follows PING_INTERVAL_MS and PING_TIMEOUT_MS (QA T9)", [hs.pingInterval, hs.pingTimeout]);
    a.emit("create", { name: "Ana", playerId: a.playerId }); await waitFor(a, (x) => x.st && x.joined);
    b.emit("join", { code: a.st.code, name: "Ben", playerId: b.playerId }); await waitFor(b, (x) => x.joined);
    const key = b.joined.seatKey;
    b.close(); await waitFor(a, (x) => x.st.players[1].connected === false);
    const thief = client(srv2.url, "Thief"); await connected(thief);
    thief.emit("join", { code: a.st.code, name: "Thief", playerId: b.playerId, seatKey: "0".repeat(24) });
    await waitFor(thief, (x) => x.refused.length);
    check(thief.refused[0].code === "seat_key" && a.st.players[1].connected === false, "a leaked player id without its key does not take the seat");
    const back = client(srv2.url, "Ben"); await connected(back);
    back.emit("join", { code: a.st.code, name: "Ben", playerId: b.playerId, seatKey: key });
    await waitFor(back, (x) => x.st && x.seat === 1);
    check(back.seat === 1, "with the key it does");
    [a, thief, back].forEach((s) => s.close());
  } finally {
    await srv2.stop();
  }
  process.exit(done("reconnect") ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
