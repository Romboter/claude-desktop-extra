#!/usr/bin/env node
// test-cache-warm.mjs - the "Cache warmer" community feature: the policy helper
// js/cache_warm.js (tier and TTL, timers, skip reasons, the two caps).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import vm from "node:vm";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const factory = vm.runInNewContext(readFileSync(join(ROOT, "js/cache_warm.js"), "utf8"), {});
const MIN = 60_000, HOUR = 3_600_000;
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(config = {}, send) {
  let clock = 1_000_000, nextHandle = 1, uuidCount = 0;
  const timers = new Map(), logs = [], sent = [];
  const cfg = { enabled: true, hours: 3, rewrites: 1, ttlEnv: undefined, ...config };
  const warm = factory({
    now: () => clock,
    setTimer: (fn, ms) => { const h = nextHandle++; timers.set(h, { fn, at: clock + ms }); return h; },
    clearTimer: h => { timers.delete(h); },
    config: () => cfg,
    sendPoke: send || (async (id, uuid) => { sent.push({ id, uuid }); return { delivered: true }; }),
    newUuid: () => "poke-" + ++uuidCount,
    log: line => logs.push(line),
  });
  async function advance(ms) {
    const end = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); clock = Math.max(clock, due[1].at); due[1].fn(); await flush();
    }
    clock = end;
  }
  return { warm, cfg, timers, logs, sent, advance, now: () => clock };
}
const usage = (o = {}) => ({ input_tokens: 2, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 500,
  cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 }, ...o });
const only5m = () => usage({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 500 } });
const readOnly = () => usage({ cache_creation_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } });
const dueIn = h => Math.min(...[...h.timers.values()].map(t => t.at - h.now()));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("tier from usage: 1h write arms at ttl minus 5 min", () => {
  const h = harness(); h.warm.turnEnded("s", usage());
  assert.equal(h.timers.size, 1); assert.equal(dueIn(h), HOUR - 5 * MIN);
});
test("tier from usage: 5m write arms at ttl minus 1 min", () => {
  const h = harness(); h.warm.turnEnded("s", only5m());
  assert.equal(dueIn(h), 5 * MIN - MIN);
});
test("a read-only turn keeps the previous tier", () => {
  const h = harness(); h.warm.turnEnded("s", usage()); h.warm.turnEnded("s", readOnly());
  assert.equal(dueIn(h), HOUR - 5 * MIN);
});
test("no tier seen and no env var: no timer", () => {
  const h = harness(); h.warm.turnEnded("s", readOnly());
  assert.equal(h.timers.size, 0);
});
test("ttl precedence: the observed tier beats the env var; env is used before any tier was seen", () => {
  let h = harness({ ttlEnv: "1h" }); h.warm.turnEnded("s", only5m());
  assert.equal(dueIn(h), 4 * MIN, "the server downgraded to 5m: trust what the usage says");
  h = harness({ ttlEnv: "5m" }); h.warm.turnEnded("s", readOnly());
  assert.equal(dueIn(h), 4 * MIN, "no tier seen yet: the env var");
});
test("poke fires once, then the poke turn arms the next one", async () => {
  const h = harness(); h.warm.turnEnded("s", usage());
  await h.advance(HOUR - 5 * MIN);
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].id, "s");
  assert.match(h.logs.at(-1), /^\[cache-warm\] s poke read=100000 write=500 tier=1h$/);
  assert.equal(h.timers.size, 0);
  h.warm.turnEnded("s", readOnly(), h.sent[0].uuid);
  assert.equal(h.timers.size, 1);
});
test("a refused poke logs its reason (busy, gone) and arms nothing", async () => {
  for (const reason of ["busy", "gone"]) {
    const h = harness({}, async () => ({ delivered: false, reason })); h.warm.turnEnded("s", usage());
    await h.advance(HOUR - 5 * MIN);
    assert.ok(h.logs.at(-1).includes(`skip(${reason})`), h.logs.at(-1)); assert.equal(h.timers.size, 0);
  }
});
test("skip(cold) when the timer fires after the cache expired (resume from sleep)", async () => {
  const h = harness(); h.warm.turnEnded("s", usage());
  const t = [...h.timers.values()][0]; t.at = h.now() + HOUR + 1; // fires late
  await h.advance(HOUR + 2);
  assert.equal(h.sent.length, 0); assert.match(h.logs.at(-1), /skip\(cold\)/);
});
test("skip(cold) when the last turn neither read nor wrote cache", async () => {
  const h = harness({ ttlEnv: "1h" });
  h.warm.turnEnded("s", usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: {} }));
  await h.advance(HOUR);
  assert.equal(h.sent.length, 0); assert.match(h.logs.at(-1), /skip\(cold\)/);
});
test("disabled: no timer at all", () => {
  const h = harness({ enabled: false }); h.warm.turnEnded("s", usage());
  assert.equal(h.timers.size, 0);
});
test("time cap: a poke due after hours since the last real turn logs skip(time-cap)", async () => {
  const h = harness({ hours: 3 }); h.warm.turnEnded("s", usage());
  let uuidSeen = 0;
  for (let i = 0; i < 4; i++) {
    await h.advance(HOUR - 5 * MIN);
    if (h.sent.length > uuidSeen) { h.warm.turnEnded("s", readOnly(), h.sent[uuidSeen++].uuid); }
  }
  assert.equal(h.sent.length, 3); assert.match(h.logs.at(-1), /skip\(time-cap\)/);
  assert.equal(h.timers.size, 0);
});
test("cost cap: context 100k, 1h, rewrites 1 allows 20 pokes then skip(cost-cap)", async () => {
  const h = harness({ hours: 24, rewrites: 1 });
  const u = () => usage({ input_tokens: 0, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } });
  h.warm.turnEnded("s", usage({ input_tokens: 0, cache_read_input_tokens: 99_500, cache_creation_input_tokens: 500 }));
  for (let i = 0; i < 21; i++) {
    await h.advance(HOUR - 5 * MIN);
    if (h.sent.length > i) h.warm.turnEnded("s", u(), h.sent[i].uuid);
  }
  assert.equal(h.sent.length, 20); assert.match(h.logs.at(-1), /skip\(cost-cap\)/);
});
test("rewrites 0 never logs cost-cap", async () => {
  const h = harness({ hours: 24, rewrites: 0 });
  h.warm.turnEnded("s", usage());
  for (let i = 0; i < 22; i++) {
    await h.advance(HOUR - 5 * MIN);
    if (h.sent.length > i) h.warm.turnEnded("s", readOnly(), h.sent[i].uuid);
  }
  assert.equal(h.sent.length, 22); assert.ok(!h.logs.some(l => /cost-cap/.test(l)));
});
test("a real turn resets the caps; a poke turn does not", async () => {
  const h = harness({ hours: 3 }); h.warm.turnEnded("s", usage());
  await h.advance(HOUR - 5 * MIN); h.warm.turnEnded("s", readOnly(), h.sent[0].uuid);
  await h.advance(HOUR - 5 * MIN); h.warm.turnEnded("s", readOnly(), h.sent[1].uuid);
  h.warm.turnEnded("s", readOnly()); // a real turn: caps restart
  for (let i = 0; i < 3; i++) {
    await h.advance(HOUR - 5 * MIN);
    if (h.sent.length > 2 + i) h.warm.turnEnded("s", readOnly(), h.sent[2 + i].uuid);
  }
  assert.equal(h.sent.length, 5); // 2 before + 3 after the reset
});
test("sessionGone clears the timer and nothing is sent", async () => {
  const h = harness(); h.warm.turnEnded("s", usage()); h.warm.sessionGone("s");
  assert.equal(h.timers.size, 0); await h.advance(2 * HOUR); assert.equal(h.sent.length, 0);
});
test("switch flipped off while armed: nothing sent, timers cleared", async () => {
  const h = harness(); h.warm.turnEnded("s", usage()); h.warm.turnEnded("t", usage());
  h.cfg.enabled = false; await h.advance(HOUR);
  assert.equal(h.sent.length, 0); assert.equal(h.timers.size, 0);
});
test("delivered:false logs skip(not-delivered); a rejected send logs skip(error); neither arms a timer", async () => {
  for (const [send, reason] of [[async () => ({ delivered: false }), "not-delivered"], [async () => { throw new Error("boom"); }, "error"]]) {
    const h = harness({}, send); h.warm.turnEnded("s", usage());
    await h.advance(HOUR - 5 * MIN);
    assert.ok(h.logs.at(-1).includes(`skip(${reason})`), h.logs.at(-1)); assert.equal(h.timers.size, 0);
  }
});
test("a poke that missed the cache stops the chain; its real cost is charged, a failed send is not", async () => {
  const h = harness({ hours: 24, rewrites: 1 }); h.warm.turnEnded("s", usage({ input_tokens: 0, cache_read_input_tokens: 99_500, cache_creation_input_tokens: 500 }));
  await h.advance(HOUR - 5 * MIN);
  h.warm.turnEnded("s", usage({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 100_000,
    cache_creation: { ephemeral_1h_input_tokens: 100_000, ephemeral_5m_input_tokens: 0 } }), h.sent[0].uuid);
  assert.equal(h.timers.size, 0); assert.ok(h.logs.at(-1).includes("skip(cold)"), h.logs.at(-1));
  const g = harness({}, async () => ({ delivered: false, reason: "busy" })); g.warm.turnEnded("s", usage());
  await g.advance(HOUR - 5 * MIN);
  g.warm.turnEnded("s", usage());
  await g.advance(HOUR - 5 * MIN); assert.equal(g.logs.filter(l => l.includes("skip(busy)")).length, 2, "refused sends use up no budget");
});
test("skip(late): a timer that fires less than 30 s before expiry does not poke", async () => {
  const h = harness(); h.warm.turnEnded("s", usage());
  [...h.timers.values()][0].at = h.now() + HOUR - 10_000;
  await h.advance(HOUR - 5_000);
  assert.equal(h.sent.length, 0); assert.ok(h.logs.at(-1).includes("skip(late)"), h.logs.at(-1));
});
test("a throw inside the timer callback is contained and logged", async () => {
  let throwing = false;
  const h = harness(); h.warm.turnEnded("s", usage());
  const real = h.cfg; Object.defineProperty(h.cfg, "enabled", { get() { if (throwing) throw new Error("cfg boom"); return true; } });
  throwing = true;
  await h.advance(HOUR - 5 * MIN);
  assert.ok(h.logs.some(l => l.includes("cfg boom")), JSON.stringify(h.logs)); assert.equal(h.sent.length, 0);
});
test("a result with no usage at all (a local command) leaves the armed timer and the caps alone", () => {
  const h = harness(); h.warm.turnEnded("s", usage());
  const handle = [...h.timers.keys()][0];
  h.warm.turnEnded("s", { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  assert.deepEqual([...h.timers.keys()], [handle]);
});
test("two turnEnded calls leave exactly one live timer per session", () => {
  const h = harness(); h.warm.turnEnded("s", usage()); h.warm.turnEnded("s", usage());
  assert.equal(h.timers.size, 1);
});
test("stopAll clears every timer", () => {
  const h = harness(); h.warm.turnEnded("s", usage()); h.warm.turnEnded("t", usage()); h.warm.stopAll();
  assert.equal(h.timers.size, 0);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("ok   " + name); }
  catch (error) { failed++; console.log("FAIL " + name + "\n     " + String(error.message).split("\n")[0]); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
