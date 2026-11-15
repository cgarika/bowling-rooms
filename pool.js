/* The physics pool (WORLD.md 3.1): a delivery (about 25 ms of CPU at the median, 55 at p95) never runs on the event
   loop, and one room's physics never delays another room's clock.

   Two modes (POOL_MODE):
   - "process" (the default): child processes. Rapier is WebAssembly, and on this Mac (Node 26.5, Apple silicon) V8
     crashed one physics worker thread with SIGILL inside JIT-compiled wasm, taking the whole server with it: 1 boot in
     25 of 8 threads starting at once (the notes have the numbers). A crash in a child process costs that process and one
     retried ball; the server and every room go on. (In 880 process boots it never happened.)
   - "thread": worker_threads (lighter, shared memory; the tools and some tests use it).

   run(job) resolves to the job's result. A worker that throws, dies or overruns jobTimeoutMs is replaced and its job
   rejected, so the caller can retry. Urgent jobs (a human's ball) go ahead of the rest. */
"use strict";
const { Worker } = require("worker_threads");
const { fork } = require("child_process");
const path = require("path");
const os = require("os");

const cores = () => (typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length);
/* cores - 1 physics processes, at most 4 (WORLD.md 3.1). 200 rooms of 8 at party pace need about 0.7 of a core, but
   balls arrive in bursts: with 4, a burst of 200 balls at once drains in about 0.6 s (the bowler's phone hides about
   2 s); with 2 it took 4 s. A physics process settles at about 300 MB (V8's wasm compiler keeps the memory it peaked
   at; flat after that), so a small host sets POOL_SIZE=2 (about 800 MB in all). 0 means no pool (a diagnostic). */
function defaultSize() { return Math.max(1, Math.min(cores() - 1, 4)); }
/* Extra V8 flags for a physics process (POOL_NODE_FLAGS), none by default. Measured and not taken: eager TurboFan
   (--no-liftoff --no-wasm-lazy-compilation: +75 MB a process, and minutes of compiling in threads) and Liftoff only
   (half the speed). The notes have the numbers. */
const WASM_FLAGS = (process.env.POOL_NODE_FLAGS || "").split(/\s+/).filter(Boolean);

class Pool {
  constructor({ size = defaultSize(), table = null, mode = process.env.POOL_MODE || "process", jobTimeoutMs = 15000 } = {}) {
    this.size = size; this.table = table; this.mode = mode === "thread" ? "thread" : "process"; this.jobTimeoutMs = jobTimeoutMs;
    this.workers = []; this.idle = []; this.queue = []; this.urgent = []; this.seq = 0;
    this.done = 0; this.failed = 0; this.restarts = 0; this.crashes = 0; this.closed = false; this.retiredCpuMs = 0;
    this.simMs = new Ring(2048); this.waitMs = new Ring(2048); this.cpuMs = new Ring(2048);
    this.readyP = Promise.all(Array.from({ length: size }, () => this._spawn()));
  }
  ready() { return this.readyP; }
  _spawn() {
    return new Promise((resolve) => {
      let t;
      if (this.mode === "thread") {
        const w = new Worker(path.join(__dirname, "pool_worker.js"), { workerData: { tableBuffer: this.table ? this.table.buffer : null } });
        t = { send: (m) => w.postMessage(m), on: (f) => w.on("message", f), onExit: (f) => { w.on("error", (e) => f(e)); w.on("exit", (c) => f(new Error("worker exited " + c))); }, kill: () => w.terminate() };
      } else {
        const cp = fork(path.join(__dirname, "pool_worker.js"), [], { serialization: "advanced", execArgv: WASM_FLAGS, stdio: ["ignore", "inherit", "inherit", "ipc"] });
        cp.send({ table: this.table });
        t = {
          send: (m) => cp.send(m), on: (f) => cp.on("message", f), kill: () => cp.kill("SIGKILL"), pid: cp.pid,
          onExit: (f) => { cp.on("error", (e) => f(e)); cp.on("exit", (c, sig) => { if (sig && sig !== "SIGTERM" && sig !== "SIGKILL") this.crashes++; f(new Error(`physics process exited (${sig || c})`)); }); },
        };
      }
      const slot = { t, job: null, timer: null, alive: true, rss: 0, cpu: 0 };
      t.on((m) => {
        if (m && m.rss) slot.rss = m.rss;
        if (m && m.cpu) slot.cpu = m.cpu;
        if (m && m.ready) { this.workers.push(slot); this.idle.push(slot); resolve(); this._pump(); return; }
        const j = slot.job; if (!j || !m || m.id !== j.id) return;
        clearTimeout(slot.timer); slot.job = null;
        const now = performance.now();
        if (m.error) { this.failed++; j.reject(new Error(m.error)); }
        else { this.done++; this.simMs.push(now - j.startedAt); if (m.out && m.out.cpuMs != null) this.cpuMs.push(m.out.cpuMs); j.resolve(m.out); }
        this.idle.push(slot); this._pump();
      });
      t.onExit((err) => {
        if (!slot.alive) return; slot.alive = false;
        clearTimeout(slot.timer); this.retiredCpuMs += slot.cpu;
        this.workers = this.workers.filter((s) => s !== slot); this.idle = this.idle.filter((s) => s !== slot);
        if (slot.job) { this.failed++; slot.job.reject(err || new Error("worker exited")); slot.job = null; }
        if (!this.closed) { this.restarts++; this._spawn(); }
        resolve();
      });
    });
  }
  _pump() {
    while (this.idle.length && (this.urgent.length || this.queue.length)) {
      const slot = this.idle.pop(), j = this.urgent.length ? this.urgent.shift() : this.queue.shift();
      slot.job = j; j.startedAt = performance.now(); this.waitMs.push(j.startedAt - j.queuedAt);
      slot.timer = setTimeout(() => { if (slot.job !== j) return; slot.job = null; this.failed++; j.reject(new Error("physics timed out")); slot.t.kill(); }, this.jobTimeoutMs);
      slot.timer.unref();
      try { slot.t.send({ id: j.id, kind: j.kind, job: j.job }); } catch (e) {        // a job that cannot be sent fails now
        clearTimeout(slot.timer); slot.job = null; this.failed++; j.reject(e); this.idle.push(slot);
      }
    }
  }
  /* kind "ball" is a delivery (sim.runJob); "task" runs a named test task (tools/tasks.js). An urgent job goes ahead of
     the rest (a human's ball ahead of the bots'). */
  run(job, kind = "ball", urgent = false) {
    if (this.closed) return Promise.reject(new Error("pool closed"));
    return new Promise((resolve, reject) => { (urgent ? this.urgent : this.queue).push({ id: ++this.seq, kind, job, resolve, reject, queuedAt: performance.now() }); this._pump(); });
  }
  /* The physics processes' CPU so far, in ms (a child's CPU is not in the server's own). */
  physicsCpuMs() { return this.mode === "process" ? this.retiredCpuMs + this.workers.reduce((a, s) => a + (s.cpu || 0), 0) : 0; }
  /* The physics processes' memory (a child's RSS is not in the server's own). */
  rssMB() { return this.mode === "process" ? +(this.workers.reduce((a, s) => a + (s.rss || 0), 0) / 1048576).toFixed(1) : 0; }
  stats() {
    return { mode: this.mode, size: this.size, live: this.workers.length, busy: this.workers.length - this.idle.length, queued: this.queue.length + this.urgent.length,
      done: this.done, failed: this.failed, restarts: this.restarts, crashes: this.crashes, rssMB: this.rssMB(),
      simMs: this.simMs.pct([50, 95, 99]), waitMs: this.waitMs.pct([50, 95, 99]), cpuMs: this.cpuMs.pct([50, 95, 99]) };
  }
  async close() { this.closed = true; await Promise.all(this.workers.map((s) => s.t.kill())); }
}

/* A fixed ring of recent samples and their percentiles. */
class Ring {
  constructor(n) { this.a = new Float64Array(n); this.n = 0; this.i = 0; }
  push(v) { this.a[this.i] = v; this.i = (this.i + 1) % this.a.length; if (this.n < this.a.length) this.n++; }
  pct(ps) {
    if (!this.n) return Object.fromEntries(ps.map((p) => ["p" + p, null]));
    const s = Array.from(this.a.subarray(0, this.n)).sort((x, y) => x - y);
    return Object.fromEntries(ps.map((p) => ["p" + p, +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(1)]));
  }
}

module.exports = { Pool, Ring, defaultSize, cores, WASM_FLAGS };
