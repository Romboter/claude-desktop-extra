#!/usr/bin/env node
/*
 * test-windows-usage-status-patch.mjs - patches/windows/add_files_activity.nim:
 * runs the compiled patch on a stub index.pre.js and checks that the module is
 * appended once, the page script and CSS arrive byte-for-byte after escaping,
 * a rerun changes nothing, a stale or duplicated injection fails, and the
 * result parses. Exit 3 (SKIP) when the patch is not compiled.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import Module from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BIN = ["", ".exe"].map((e) => join(ROOT, "patches", "windows", "add_files_activity" + e)).find(existsSync);
if (!BIN) {
  console.log("SKIP: patches/windows/add_files_activity is not compiled (make -C patches windows/add_files_activity)");
  process.exit(3);
}
const MARKER = "/*__CDB_FILES_ACTIVITY__*/";
const lf = (s) => s.replace(/\r/g, "");
const PAGE = lf(readFileSync(join(ROOT, "js/files_activity_page.js"), "utf8"));
const CSS = lf(readFileSync(join(ROOT, "js/files_activity.css"), "utf8"));
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };

const dir = mkdtempSync(join(tmpdir(), "cdb-fap-"));
const file = join(dir, "index.pre.js");
const STUB = '"use strict";\nconsole.log("upstream first code");\n';
writeFileSync(file, STUB);
const run = () => spawnSync(BIN, [file], { encoding: "utf8" });

let r = run();
const once = readFileSync(file, "utf8");
ok(r.status === 0, "first run exits 0");
ok(once.startsWith(STUB), "upstream code stays first (appended, not prefixed)");
ok(once.split(MARKER).length === 2, "marker present exactly once");
ok(!once.includes("__CDB_FILES_ACTIVITY_PAGE_SRC__") && !once.includes("__CDB_FILES_ACTIVITY_CSS__"), "both placeholders replaced");
const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
ok(syntax.status === 0, "patched file passes node --check" + (syntax.status ? ": " + syntax.stderr : ""));

// Run the patched file on win32 with the switch on; the embedded strings must
// arrive exactly as the source files hold them.
{
  const ud = mkdtempSync(join(tmpdir(), "cdb-fap-ud-"));
  writeFileSync(join(ud, "claude-desktop-extra.json"), '{"filesActivity":true}');
  const handlers = {}, created = [];
  const injected = { css: [], js: [] };
  // A real nested repo under a session folder, for the git status poll.
  const sess = mkdtempSync(join(tmpdir(), "cdb-fap-sess-"));
  const gitOk = spawnSync("git", ["--version"]).status === 0;
  if (gitOk) {
    const repo = join(sess, "app");
    const g = (...a) => spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
    mkdirSync(repo);
    g("init", "-q");
    writeFileSync(join(repo, "a.md"), "one");
    g("add", ".");
    g("commit", "-qm", "init");
    writeFileSync(join(repo, "a.md"), "two");
    writeFileSync(join(repo, "new.md"), "x");
  }
  const pushed = [];
  const wc = { once: () => {}, getURL: () => "https://claude.ai/chat", isDestroyed: () => false, on: (e, f) => { handlers.dom = f; },
    insertCSS: (c) => { injected.css.push(c); return Promise.resolve("k"); }, removeInsertedCSS: () => Promise.resolve(),
    executeJavaScript: (s) => {
      if (s.includes(".wanted&&")) return Promise.resolve({ cwd: sess, dirs: [sess, join(sess, "app"), tmpdir()] });
      if (s.includes(".setGit&&")) { pushed.push(s); return Promise.resolve(); }
      injected.js.push(s); return Promise.resolve();
    } };
  const electron = { app: { getPath: () => ud, on: (e, f) => { handlers[e] = f; }, whenReady: () => Promise.resolve() },
    webContents: { getAllWebContents: () => created } };
  const sandbox = { require: (m) => (m === "electron" ? electron : Module.createRequire(import.meta.url)(m)),
    process: { platform: "win32", env: process.env, pid: 1 }, console: { log() {} }, setTimeout, clearTimeout, setInterval, clearInterval, JSON, Object };
  sandbox.globalThis = sandbox;
  vm.runInContext(once, vm.createContext(sandbox));
  handlers["web-contents-created"]({}, wc);
  handlers.dom();
  ok(injected.css[0] === CSS, "embedded stylesheet equals js/files_activity.css");
  ok(injected.js[0] && injected.js[0].endsWith(PAGE), "embedded page script equals js/files_activity_page.js");
  if (gitOk) {
    await new Promise((r) => setTimeout(r, 2500));
    const msg = pushed.length ? JSON.parse(JSON.parse(pushed[0].slice(pushed[0].indexOf("JSON.parse(") + 11, -2))) : null;
    ok(msg && msg.length === 1 && msg[0].root === join(sess, "app"), "git status runs for the nested repo only");
    ok(msg && msg[0].files["a.md"] === "M" && msg[0].files["new.md"] === "U", "modified and untracked files are reported");
    // A change is picked up by the watcher: debounce 1 s, cooldown 5 s after the first run.
    writeFileSync(join(sess, "app", "late.md"), "y");
    await new Promise((r) => setTimeout(r, 7500));
    const last = pushed.length > 1 ? JSON.parse(JSON.parse(pushed[pushed.length - 1].slice(pushed[pushed.length - 1].indexOf("JSON.parse(") + 11, -2))) : null;
    ok(last && last[0].files["late.md"] === "U", "a file change re-runs git status (watcher, debounce, cooldown)");
  } else console.log("  skip git status poll (git not found)");
  wc.isDestroyed = () => true; // stops the poll timer from touching the fake
  rmSync(sess, { recursive: true, force: true });
  rmSync(ud, { recursive: true, force: true });
}

r = run();
ok(r.status === 0 && readFileSync(file, "utf8") === once, "second run changes nothing (idempotent)");
writeFileSync(file, once + "\n" + once.slice(STUB.length));
r = run();
ok(r.status !== 0, "a duplicated injection fails loudly");
writeFileSync(file, once.replace("filesActivity=", "filesActivityX="));
r = run();
ok(r.status !== 0, "a stale injection fails loudly (marker present, code different)");
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
