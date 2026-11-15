/* A physics worker: a child process (the default) or a worker thread. Rapier initialises once here, then every job the
   pool sends runs here. A child process exits when the server does (its IPC channel closes). */
"use strict";
const { isMainThread, parentPort, workerData } = require("worker_threads");
const L = require("./lane");
const B = require("./bot");
const SIM = require("./sim");

const viaThread = !isMainThread;
const send = viaThread ? (m) => parentPort.postMessage(m) : (m) => { if (process.connected) process.send(m); };
const onMessage = viaThread ? (f) => parentPort.on("message", f) : (f) => process.on("message", f);
const rss = () => (viaThread ? 0 : process.memoryUsage.rss());
const cpu = () => { if (viaThread) return 0; const c = process.cpuUsage(); return (c.user + c.system) / 1000; };   // this process's CPU ms
let tasks = null;

function start(table) {
  if (table) B.adoptTable(table);
  const keep = setInterval(() => {}, 1000);     // V8's background wasm compile does not hold the event loop open by itself
  L.init().then(() => {
    clearInterval(keep);
    onMessage((m) => {
      if (!m || m.id === undefined) return;
      let out;
      try {
        if (m.kind === "task") { tasks = tasks || require("./tools/tasks"); out = tasks.run(m.job); }
        else out = SIM.runJob(m.job);
      } catch (e) { send({ id: m.id, error: String((e && e.stack) || e), rss: rss(), cpu: cpu() }); return; }
      send({ id: m.id, out, rss: rss(), cpu: cpu() });
    });
    send({ ready: true, rss: rss() });
  });
}
if (viaThread) start(workerData && workerData.tableBuffer);
else {
  process.once("message", (m) => start(m && m.table));
  process.on("disconnect", () => process.exit(0));
}
