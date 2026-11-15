/* Every suite in turn. npm test (quick sizes, about 6 minutes) or npm run test:full (WORLD.md 9.1's sizes: 20,000
   physics deliveries, 1,000 balls a strike-map cell at three seeds, 200 games per bot, 50,000 fuzz events).
   The socket suites start their own servers on TEST_PORT (3281) and TEST_PORT + 1; nothing touches 3111-3120. */
"use strict";
const { spawnSync } = require("child_process");
const path = require("path");

const FULL = process.env.FULL === "1";
const SUITES = ["score", "physics", "gear", "pool", "strikemap", "bots", "rules", "swipe", "protocol", "pace", "show", "reconnect", "afk", "fuzz"];
const only = process.argv.slice(2);
const results = [];
for (const s of SUITES.filter((x) => !only.length || only.includes(x))) {
  const t0 = Date.now();
  const env = { ...process.env };
  if (FULL && s === "fuzz") env.EVENTS = env.EVENTS || "50000";
  const r = spawnSync(process.execPath, [path.join(__dirname, s + ".js")], { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || "") + (r.stderr || "");
  if (process.env.SAVE_DIR) require("fs").writeFileSync(path.join(process.env.SAVE_DIR, s + ".txt"), out);
  const m = out.match(/(\d+) checks passed, (\d+) failed/);
  const line = { suite: s, ok: r.status === 0, passed: m ? +m[1] : 0, failed: m ? +m[2] : null, seconds: Math.round((Date.now() - t0) / 1000) };
  results.push(line);
  console.log(`${line.ok ? "ok  " : "FAIL"} ${s.padEnd(10)} ${String(line.passed).padStart(4)} checks, ${line.failed === null ? "crashed" : line.failed + " failed"}  (${line.seconds} s)`);
  if (!line.ok) console.log(out.split("\n").filter((l) => /FAIL|Error|error/.test(l)).slice(0, 20).map((l) => "     " + l).join("\n"));
}
const passed = results.reduce((a, r) => a + r.passed, 0), failed = results.reduce((a, r) => a + (r.failed || 0), 0);
console.log(`\n${results.every((r) => r.ok) ? "all green" : "RED"}: ${passed} checks passed, ${failed} failed, ${results.length} suites${FULL ? " (full sizes)" : ""}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
