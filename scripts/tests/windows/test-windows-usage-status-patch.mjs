#!/usr/bin/env node
/*
 * test-windows-usage-status-patch.mjs - patches/windows/add_usage_status.nim:
 * runs the compiled patch on a stub index.pre.js and checks that the module is
 * appended once, the page script and CSS arrive byte-for-byte after escaping,
 * a rerun changes nothing, a stale or duplicated injection fails, and the
 * result parses. Exit 3 (SKIP) when the patch is not compiled.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import Module from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BIN = ["", ".exe"].map((e) => join(ROOT, "patches", "windows", "add_usage_status" + e)).find(existsSync);
if (!BIN) {
  console.log("SKIP: patches/windows/add_usage_status is not compiled (make -C patches windows/add_usage_status)");
  process.exit(3);
}
const MARKER = "/*__CDB_USAGE_STATUS__*/";
const lf = (s) => s.replace(/\r/g, "");
const PAGE = lf(readFileSync(join(ROOT, "js/usage_status_page.js"), "utf8"));
const CSS = lf(readFileSync(join(ROOT, "js/usage_status.css"), "utf8"));
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };

const dir = mkdtempSync(join(tmpdir(), "cdb-usp-"));
const file = join(dir, "index.pre.js");
const STUB = '"use strict";\nconsole.log("upstream first code");\n';
writeFileSync(file, STUB);
const run = () => spawnSync(BIN, [file], { encoding: "utf8" });

let r = run();
const once = readFileSync(file, "utf8");
ok(r.status === 0, "first run exits 0");
ok(once.startsWith(STUB), "upstream code stays first (appended, not prefixed)");
ok(once.split(MARKER).length === 2, "marker present exactly once");
ok(!once.includes("__CDB_USAGE_STATUS_PAGE_SRC__") && !once.includes("__CDB_USAGE_STATUS_CSS__"), "both placeholders replaced");
const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
ok(syntax.status === 0, "patched file passes node --check" + (syntax.status ? ": " + syntax.stderr : ""));

// Run the patched file on win32 with the switch on; the embedded strings must
// arrive exactly as the source files hold them.
{
  const ud = mkdtempSync(join(tmpdir(), "cdb-usp-ud-"));
  writeFileSync(join(ud, "claude-desktop-extra.json"), '{"usageStatus":true}');
  const handlers = {}, created = [];
  const injected = { css: [], js: [] };
  const wc = { getURL: () => "https://claude.ai/chat", isDestroyed: () => false, on: (e, f) => { handlers.dom = f; },
    insertCSS: (c) => { injected.css.push(c); return Promise.resolve("k"); }, removeInsertedCSS: () => Promise.resolve(),
    executeJavaScript: (s) => { injected.js.push(s); return Promise.resolve(); } };
  const electron = { app: { getPath: () => ud, on: (e, f) => { handlers[e] = f; }, whenReady: () => Promise.resolve() },
    webContents: { getAllWebContents: () => created } };
  const sandbox = { require: (m) => (m === "electron" ? electron : Module.createRequire(import.meta.url)(m)),
    process: { platform: "win32", env: {}, pid: 1 }, console: { log() {} }, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  vm.runInContext(once, vm.createContext(sandbox));
  handlers["web-contents-created"]({}, wc);
  handlers.dom();
  ok(injected.css[0] === CSS, "embedded stylesheet equals js/usage_status.css");
  ok(injected.js[0] && injected.js[0].endsWith(PAGE), "embedded page script equals js/usage_status_page.js");
  rmSync(ud, { recursive: true, force: true });
}

r = run();
ok(r.status === 0 && readFileSync(file, "utf8") === once, "second run changes nothing (idempotent)");
writeFileSync(file, once + "\n" + once.slice(STUB.length));
r = run();
ok(r.status !== 0, "a duplicated injection fails loudly");
writeFileSync(file, once.replace("usageStatus=", "usageStatusX="));
r = run();
ok(r.status !== 0, "a stale injection fails loudly (marker present, code different)");
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
