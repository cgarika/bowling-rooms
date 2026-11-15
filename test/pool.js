/* The physics pool: processes by default, each job the same bytes as in this thread; a physics process that crashes
   (SIGILL, as V8 did once on this Mac inside Rapier's wasm) or hangs costs one retried job, never the server; a human's
   ball goes ahead of the bots'; and a live server keeps playing through a crashed physics process.

   node test/pool.js   (the server part on TEST_PORT, 3281 by default) */
"use strict";
const { execSync } = require("child_process");
const L = require("../lane");
const B = require("../bot");
const SIM = require("../sim");
const tasks = require("../tools/tasks");
const { Pool } = require("../pool");
const H = require("./helpers");
const { check, section, done } = H.checker();

(async () => {
  await L.init();
  section("processes by default, the same bytes as this thread");
  const pool = new Pool({ size: 2, table: B.table() });
  await pool.ready();
  check(pool.mode === "process" && pool.stats().live === 2, "two physics processes are ready", pool.stats());
  const who = await pool.run({ task: "whoami" }, "task");
  check(who.pid !== process.pid, "a job runs in another process", who);
  let same = 0;
  for (let i = 0; i < 20; i++) {
    const j = tasks.detJob(i); delete j.rnd;
    const [a, b] = [SIM.runJob(j), await pool.run(j)];
    if (JSON.stringify([a.release, a.payload, a.summary]) === JSON.stringify([b.release, b.payload, b.summary])) same++;
  }
  check(same === 20, "20 deliveries identical in a physics process and in this thread", same);
  check(pool.rssMB() > 20, `the pool reports its processes' memory (${pool.rssMB()} MB)`);

  section("a crashed physics process costs one job");
  const victim = await pool.run({ task: "whoami" }, "task");
  const inFlight = pool.run({ task: "spin", ms: 1000 }, "task").then(() => "done", (e) => "rejected: " + e.message);
  await H.sleep(150);
  const busy = pool.workers.find((s) => s.job);
  process.kill(busy.t.pid, "SIGILL");
  const r = await inFlight;
  check(/rejected: physics process exited \(SIGILL\)/.test(r), "the job in the crashed process is rejected, not lost", r);
  await H.waitFor({}, () => pool.stats().live === 2, 20000);
  const st = pool.stats();
  check(st.crashes === 1 && st.restarts === 1 && st.live === 2, "the crash is counted and the process replaced", st);
  const j3 = tasks.detJob(3); delete j3.rnd;
  const after = await pool.run(j3);
  check(after && after.payload && after.payload.fmt === 1, "and the pool goes on");
  const unsendable = await pool.run({ task: "whoami", f: () => 1 }, "task").then(() => "sent", (e) => e.name || e.message);
  check(unsendable !== "sent", "a job that cannot cross to a process fails at once, not after the timeout", unsendable);
  void victim;

  section("a hung job times out and its process is replaced");
  {
    const short = new Pool({ size: 1, table: B.table(), jobTimeoutMs: 1500 });
    await short.ready();
    const hung = await short.run({ task: "spin", ms: 6000 }, "task").then(() => "done", (e) => e.message);
    check(hung === "physics timed out", "a job past jobTimeoutMs is rejected", hung);
    const next = await short.run({ task: "whoami" }, "task");
    check(short.stats().restarts === 1 && next.pid > 0, "and a fresh process takes its place", short.stats());
    await short.close();
  }

  section("a human's ball goes ahead of the bots'");
  {
    const one = new Pool({ size: 1, table: B.table() });
    await one.ready();
    const order = [];
    const blocker = one.run({ task: "spin", ms: 300 }, "task");
    const bots = [1, 2, 3].map((i) => one.run({ task: "whoami" }, "task").then(() => order.push("bot" + i)));
    const human = one.run({ task: "whoami" }, "task", true).then(() => order.push("human"));
    await Promise.all([blocker, human, ...bots]);
    check(order[0] === "human", "queued behind three bots, the human's ball is served first", order);
    await one.close();
  }
  await pool.close();

  section("threads, the other mode");
  {
    const tp = new Pool({ size: 2, table: B.table(), mode: "thread" });
    await tp.ready();
    const w = await tp.run({ task: "whoami" }, "task");
    check(tp.mode === "thread" && w.pid === process.pid && w.thread > 0, "POOL_MODE=thread runs in worker threads of this process", w);
    const j = tasks.detJob(5); delete j.rnd;
    check(JSON.stringify((await tp.run(j)).payload) === JSON.stringify(SIM.runJob(j).payload), "with the same bytes");
    await tp.close();
  }

  section("a live server plays on through a crashed physics process");
  const srv = await H.startServer({ POOL_SIZE: "2" });
  try {
    const kids = () => execSync(`pgrep -P ${srv.child.pid} || true`).toString().trim().split(/\s+/).filter(Boolean).map(Number);
    check(kids().length === 2, "the server runs two physics processes", kids());
    const a = H.client(srv.url, "Ana"); await H.connected(a);
    a.emit("create", { name: "Ana", playerId: a.playerId }); await H.waitFor(a, (x) => x.st);
    a.emit("addBot"); a.emit("addBot"); await H.waitFor(a, (x) => x.st.players.length === 3);
    a.emit("settings", { frames: 5 }); a.emit("start");
    const stop = H.autoBowl(a);
    await H.waitFor(a, (x) => x.deliveries.length >= 3, 20000);
    for (const pid of kids()) { try { process.kill(pid, "SIGILL"); } catch (_) {} }
    await H.waitFor(a, (x) => x.st && x.st.status === "over", 60000);
    stop();
    await H.sleep(5500);                                   // at least one 5 s metrics window has run
    const h = await srv.health();
    check(h.physicsCpuPct !== undefined && h.pool.rssMB > 0 && h.totalRssMB > h.rssMB, "/health reports the physics processes' CPU and memory", [h.physicsCpuPct, h.pool.rssMB, h.totalRssMB]);
    check(a.st.status === "over", "the game finished", a.st.status);
    check(h.pool.crashes >= 1 && h.pool.live === 2, "the crashed processes were replaced", h.pool);
    check(h.deadBalls === 0, "every ball still had its physics (retried in a fresh process)", [h.fallbacks, h.deadBalls]);
    check(new Set(a.deliveries.map((d) => d.id)).size === a.deliveries.length, "no ball was sent twice");
    a.close();
    await H.sleep(200);
    const pids = kids();
    await srv.stop();
    await H.sleep(500);
    const alive = pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } });
    check(alive.length === 0, "the physics processes exit with the server", alive);
  } finally { await srv.stop(); }
  process.exit(done("pool") ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
