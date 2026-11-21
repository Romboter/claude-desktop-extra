#!/usr/bin/env node
/*
 * test-windows-usage-status-main.mjs - js/usage_status_main.js with electron
 * shimmed and a temporary userData dir: win32-only, off by default, claude.ai /
 * claude.com pages only, .jsonc over .json, teardown when switched off, the
 * ON -> OFF insertCSS race, the refresh hook and the startup log line.
 * Run it on a prepared copy or in the repo: the module has no upstream gate.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import Module from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MODULE = readFileSync(join(ROOT, "js/usage_status_main.js"), "utf8");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const wait = () => new Promise((r) => setTimeout(r, 0));

function boot(dir, platform = "win32") {
  const created = [], handlers = {}, diags = [];
  const electron = {
    app: { getPath: () => { if (dir === null) throw new Error("no userData"); return dir; },
           on: (ev, fn) => { handlers[ev] = fn; }, whenReady: () => Promise.resolve() },
    webContents: { getAllWebContents: () => created }
  };
  const sandbox = {
    require: (m) => (m === "electron" ? electron : Module.createRequire(import.meta.url)(m)),
    process: { platform, env: {}, pid: process.pid }, console, setTimeout, clearTimeout,
    __cdbDiag: (l) => diags.push(String(l))
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(MODULE, vm.createContext(sandbox));
  return { created, handlers, diags, sandbox };
}

function page(url, deferCss) {
  const rec = { css: [], js: [], removed: [], pending: [] };
  let n = 0, domReady;
  rec.wc = {
    getURL: () => url, isDestroyed: () => false, on: (e, f) => { if (e === "dom-ready") domReady = f; },
    insertCSS: (c) => { rec.css.push(c); const k = "k" + ++n;
      return deferCss ? new Promise((r) => rec.pending.push(() => r(k))) : Promise.resolve(k); },
    removeInsertedCSS: (k) => { rec.removed.push(k); return Promise.resolve(); },
    executeJavaScript: (s) => { rec.js.push(s); return Promise.resolve(); }
  };
  rec.domReady = () => domReady();
  return rec;
}
const open = (t, url, deferCss) => { const p = page(url, deferCss); t.created.push(p.wc); t.handlers["web-contents-created"]({}, p.wc); p.domReady(); return p; };
const cfg = (dir, name, obj) => writeFileSync(join(dir, name), JSON.stringify(obj));
const dir = () => mkdtempSync(join(tmpdir(), "cdb-us-"));

console.log("\nA. Platform gate");
for (const platform of ["linux", "darwin"]) {
  const t = boot(dir(), platform);
  ok(!t.sandbox.__cdbUsageStatusMain && !t.handlers["web-contents-created"], "inert on " + platform);
}
ok(!!boot(dir()).sandbox.__cdbUsageStatusMain, "marker set on win32");

console.log("\nB. Off by default; only claude.ai / claude.com pages");
{
  const d = dir(), t = boot(d);
  let p = open(t, "https://claude.ai/chat"); await wait();
  ok(p.css.length === 0 && p.js.length === 0, "no config: nothing injected");
  ok(t.diags.includes("[usage-status] installed (main); usageStatus=false"), "startup line logged");
  cfg(d, "claude-desktop-extra.json", { usageStatus: true });
  p = open(t, "https://claude.ai/chat"); await wait();
  ok(p.css.length === 1 && p.js.length === 1 && p.js[0].startsWith('var __CDB_USAGE_STATUS_OPTS={"enabled":true};\n'), "on: CSS inserted and page script run with enabled:true");
  ok(open(t, "https://claude.com/x").js.length === 1, "claude.com page is injected too");
  ok(open(t, "https://example.com/").js.length === 0, "other host skipped");
  ok(open(t, "app://localhost/chat").js.length === 0, "3P app://localhost page skipped");
  ok(open(t, "http://claude.ai/chat").js.length === 0, "plain http skipped");
}

console.log("\nC. .jsonc wins; switching off tears down");
{
  const d = dir(), t = boot(d);
  cfg(d, "claude-desktop-extra.json", { usageStatus: true });
  cfg(d, "claude-desktop-extra.jsonc", { usageStatus: false });
  ok(open(t, "https://claude.ai/").js.length === 0, ".jsonc false beats .json true");
  rmSync(join(d, "claude-desktop-extra.jsonc"));
  const p = open(t, "https://claude.ai/"); await wait();
  ok(p.js.length === 1, "back on without the .jsonc");
  cfg(d, "claude-desktop-extra.json", {});
  t.sandbox.__cdbUsageStatusRefresh(); await wait();
  ok(p.js.length === 2 && p.js[1].startsWith('var __CDB_USAGE_STATUS_OPTS={"enabled":false};'), "refresh with the key off runs the teardown");
  ok(p.removed.length >= 1, "its CSS was removed");
  const q = open(t, "https://claude.ai/"); await wait();
  ok(q.js.length === 0, "a page that never carried the script gets no teardown run");
}

console.log("\nD. ON -> OFF while insertCSS is pending");
{
  const d = dir(), t = boot(d);
  cfg(d, "claude-desktop-extra.json", { usageStatus: true });
  const p = open(t, "https://claude.ai/", true);
  cfg(d, "claude-desktop-extra.json", {});
  t.sandbox.__cdbUsageStatusRefresh();
  p.pending.splice(0).forEach((f) => f()); await wait();
  ok(p.removed.length === 1, "the stale CSS key is removed when it resolves");
}

console.log("\nE. userData unavailable stays off");
{
  const t = boot(null);
  ok(open(t, "https://claude.ai/").js.length === 0, "getPath throwing means off");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
