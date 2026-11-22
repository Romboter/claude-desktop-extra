#!/usr/bin/env node
// test-cache-warm-patch.mjs - the compiled patch patches/community/add_feature_cache_warm: two anchors
// (the session-manager register function, the cycle-close helper), idempotency, and that the glue
// arms a poke on a healthy turn end and stays inert while the switch is off.
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync, rmSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const binary = join(ROOT, "patches/community/add_feature_cache_warm");
accessSync(binary + (process.platform === "win32" ? ".exe" : ""), constants.X_OK);

const HEADER = "function Ti(e,{health:n,unhealthyReason:r,errorMessage:i,errorCategory:a,apiErrorKind:o,httpStatus:s,noResponseCategory:c,rewindTargetMissReason:u,resultSubtype:d,cliStderrTail:f,appQuitTrigger:p,atQuit:m,usage:h,cliTimings:g,remoteTurnContinues:_=!1,turnCompleted:v=!1,automated:y=!1,noTurnRan:b=!1}){";
const REGISTER = 'var hb,s5t=[],j={error(){}};const o5t={_registerClaudeCodeSessionManager:()=>c5t};' +
  'function c5t(e){hb=e;for(let t of s5t.splice(0))try{t(e)}catch(e){j.error("[accessor] threw",{error:e})}}';
const fixture = REGISTER + HEADER + 'let x=e.pendingCycle;return "orig:"+(x?x.userMessageUuid:"none")}';

const dir = mkdtempSync(join(tmpdir(), "cache-warm-patch-"));
const run = text => {
  const target = join(dir, "bundle.js"); writeFileSync(target, text);
  const result = spawnSync(binary, [target], { encoding: "utf8" });
  return { ...result, text: readFileSync(target, "utf8") };
};
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function load(text, extra = {}) {
  const timers = [], diag = [], sent = [], logs = [];
  const sandbox = {
    setTimeout: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; },
    clearTimeout: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    require: id => { assert.equal(id, "node:crypto"); return { randomUUID: () => "uuid-1" }; },
    Date, Promise, globalThis: undefined, ...extra,
  };
  sandbox.globalThis = sandbox; sandbox.__cdbDiag = line => diag.push(line);
  vm.runInNewContext(text, sandbox);
  const manager = {
    async getSession() { return manager.view; }, view: { isArchived: false, isRunning: false, turnRunning: false },
    async sendMessage(...args) { sent.push(args); return { delivered: true }; },
  };
  return { sandbox, timers, diag, sent, manager, logs };
}
const usage = { input_tokens: 2, cache_read_input_tokens: 100000, cache_creation_input_tokens: 500,
  cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 } };
const healthy = { health: "healthy", turnCompleted: true, usage };

test("applies, is idempotent, and reports already present", () => {
  const first = run(fixture); assert.equal(first.status, 0, first.stderr);
  assert.match(first.text, /function c5t\(e\)\{hb=e;try\{/); assert.match(first.text, /__cdbCacheWarm/);
  const catches = [...first.text.matchAll(/catch\((__cdbCw\w+)\)/g)].map(m => m[1]);
  assert.equal(catches.length, 2); assert.equal(new Set(catches).size, 2, "the build's check rejects one injected name used in two chunk parts");
  const second = run(first.text); assert.equal(second.status, 0, second.stderr);
  assert.equal(second.text, first.text); assert.match(second.stdout, /already present/);
});
test("a missing anchor exits 1 and leaves no half patch", () => {
  assert.notEqual(run(fixture.replace(HEADER, "function Ti(e,t){")).status, 0);
  assert.notEqual(run(fixture.replace("_registerClaudeCodeSessionManager", "_other")).status, 0);
});
test("a duplicated anchor exits 1", () => {
  assert.notEqual(run(fixture + HEADER + "return 1}").status, 0);
});
test("switch off (no config): the original behaviour, no timer, nothing sent", async () => {
  const w = load(run(fixture).text);
  w.sandbox.c5t(w.manager);
  assert.ok(w.diag.includes("[cache-warm] installed"), "the startup line the Windows smoke test waits for");
  const out = w.sandbox.Ti({ sessionId: "s", pendingCycle: { userMessageUuid: "u1" } }, healthy);
  assert.equal(out, "orig:u1"); assert.equal(w.timers.length, 0); assert.equal(w.sent.length, 0);
});
test("switch on: a healthy turn arms a timer; firing it sends the poke with the cache-warm initiator", async () => {
  const w = load(run(fixture).text);
  w.sandbox.__cdbCacheWarmConfig = () => ({ enabled: true, hours: 3, rewrites: 1 });
  w.sandbox.c5t(w.manager);
  assert.equal(w.sandbox.Ti({ sessionId: "s", pendingCycle: { userMessageUuid: "u1" } }, healthy), "orig:u1");
  assert.equal(w.timers.length, 1); assert.equal(w.timers[0].ms, 3_600_000 - 300_000);
  w.timers[0].fn(); await new Promise(r => setImmediate(r));
  assert.equal(w.sent.length, 1);
  const [id, text, images, options] = w.sent[0];
  assert.equal(id, "s"); assert.match(text, /cache keep-alive/); assert.equal(images, undefined);
  assert.equal(JSON.stringify(options), JSON.stringify({ origin: { kind: "auto-continuation" }, initiator: "cache-warm", messageUuid: "uuid-1" })); // JSON: the sandbox objects come from another realm
});
test("an unhealthy or non-final turn arms nothing", () => {
  const w = load(run(fixture).text);
  w.sandbox.__cdbCacheWarmConfig = () => ({ enabled: true, hours: 3, rewrites: 1 });
  w.sandbox.c5t(w.manager);
  w.sandbox.Ti({ sessionId: "s", pendingCycle: {} }, { ...healthy, health: "unhealthy" });
  w.sandbox.Ti({ sessionId: "s", pendingCycle: {} }, { ...healthy, turnCompleted: false });
  assert.equal(w.timers.length, 0);
});
test("a busy or archived session is not poked", async () => {
  for (const view of [{ isRunning: true }, { turnRunning: true }, { isArchived: true }, undefined]) {
    const w = load(run(fixture).text);
    w.sandbox.__cdbCacheWarmConfig = () => ({ enabled: true, hours: 3, rewrites: 1 });
    w.sandbox.c5t(w.manager); w.manager.view = view;
    w.sandbox.Ti({ sessionId: "s", pendingCycle: {} }, healthy);
    w.timers[0].fn(); await new Promise(r => setImmediate(r));
    assert.equal(w.sent.length, 0);
    assert.ok(w.diag.some(l => /skip\((busy|gone)\)/.test(l)), JSON.stringify(w.diag));
  }
});
test("a throwing config cannot break the turn end", () => {
  const w = load(run(fixture).text);
  w.sandbox.__cdbCacheWarmConfig = () => { throw new Error("boom"); };
  w.sandbox.c5t(w.manager);
  assert.equal(w.sandbox.Ti({ sessionId: "s", pendingCycle: { userMessageUuid: "u1" } }, healthy), "orig:u1");
  assert.ok(w.diag.some(l => /^\[cache-warm\] .*boom/.test(l)), JSON.stringify(w.diag));
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("ok   " + name); }
  catch (error) { failed++; console.log("FAIL " + name + "\n     " + String(error.message).split("\n")[0]); }
}
rmSync(dir, { recursive: true, force: true });
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
