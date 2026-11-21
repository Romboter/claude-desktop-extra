#!/usr/bin/env node
/*
 * test-windows-usage-status-settings.mjs - the Extra settings side of "Usage
 * and session status": the cdb-usage-status:read / :set handlers that
 * scripts/windows/upstream-overlay.patch adds to js/extra_settings_main.js.
 * Run it on a prepared copy (scripts/windows/prepare-sources.sh DEST, then
 * node DEST/scripts/tests/windows/...): in the repo itself the handlers do not
 * exist yet and this test fails.
 *
 * Real files in a temp dir; electron and the growthbook store are shimmed.
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const require2 = createRequire(import.meta.url);
let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (extra !== undefined ? "  -> " + extra : "")); } };

const userData = join(mkdtempSync(join(tmpdir(), "cdb-usset-")), "Claude");
mkdirSync(userData, { recursive: true });
const jsonPath = join(userData, "claude-desktop-extra.json");
const jsoncPath = join(userData, "claude-desktop-extra.jsonc");

globalThis.__cdbDiag = () => {};
globalThis.__cdbGbFlags = { version: 1, catalog: () => [], server: () => ({}), effective: () => ({}), builtins: () => ({}),
  overrides: () => ({}), configPath: () => ({ json: jsonPath, jsonc: jsoncPath }) };
let refreshes = 0;
globalThis.__cdbUsageStatusRefresh = () => { refreshes++; };

const handlers = {};
const fakeElectron = {
  app: { getPath: () => userData, on: () => {}, once: () => {}, relaunch: () => {}, exit: () => {} },
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, removeHandler: () => {} },
  shell: { openPath: () => Promise.resolve(""), showItemInFolder: () => {} },
  nativeImage: {}
};
const Module = require2("module");
const orig = Module._load;
Module._load = function (req, ...rest) { return req === "electron" ? fakeElectron : orig.call(this, req, ...rest); };
const mod = join(mkdtempSync(join(tmpdir(), "cdb-usset-mod-")), "extra.cjs");
writeFileSync(mod, readFileSync(join(ROOT, "js", "sender_guard.js"), "utf8") + readFileSync(join(ROOT, "js", "extra_settings_main.js"), "utf8"));
try { require2(mod); } finally { Module._load = orig; }

const ev = { sender: { isDestroyed: () => false, getURL: () => "https://claude.ai/settings" }, senderFrame: { parent: null } };
const call = async (ch, ...a) => handlers[ch] ? await handlers[ch](ev, ...a) : { ok: false, error: "no handler for " + ch, missing: true };
const readJson = () => JSON.parse(readFileSync(jsonPath, "utf8"));

ok(typeof handlers["cdb-usage-status:read"] === "function" && typeof handlers["cdb-usage-status:set"] === "function",
   "both channels are registered (run on a prepared copy)");

let r = await call("cdb-usage-status:read");
ok(r.ok && r.enabled === false && r.lockedByJsonc === null, "read: off by default, not locked");

writeFileSync(jsonPath, '{"other": 1}');
r = await call("cdb-usage-status:set", true);
ok(r.ok && r.enabled === true && readJson().usageStatus === true && readJson().other === 1, "set(true) writes usageStatus and keeps other keys");
ok(refreshes === 1, "set(true) refreshes the open pages");
r = await call("cdb-usage-status:read");
ok(r.enabled === true, "read reports it on");

r = await call("cdb-usage-status:set", false);
ok(r.ok && !("usageStatus" in readJson()) && readJson().other === 1 && refreshes === 2, "set(false) deletes the key and refreshes");

r = await call("cdb-usage-status:set", "yes");
ok(!r.ok, "a non-boolean is refused");

const foreign = { sender: { isDestroyed: () => false, getURL: () => "https://evil.example/" }, senderFrame: { parent: null } };
const before = readFileSync(jsonPath, "utf8");
r = await handlers["cdb-usage-status:set"](foreign, true);
ok(!(r && r.ok) && readFileSync(jsonPath, "utf8") === before, "a foreign sender cannot change it");

writeFileSync(jsoncPath, '{ "usageStatus": false }');
r = await call("cdb-usage-status:set", true);
ok(!r.ok && r.lockedByJsonc === true && !("usageStatus" in readJson()), ".jsonc locks the switch");
r = await call("cdb-usage-status:read");
ok(r.enabled === false && r.lockedByJsonc === true, "read shows the .jsonc value and the lock");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
