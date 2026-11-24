#!/usr/bin/env node
/*
 * test-windows-files-activity-page.mjs - js/files_activity_page.js against fake
 * stores and rows: history never follows, a new live Read/Edit follows once,
 * paths outside the session folder are skipped, newly opened folders (and only
 * those) are dimmed, a session switch reseeds, and switching the feature off
 * stops everything.
 */
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SRC = readFileSync(join(ROOT, "js/files_activity_page.js"), "utf8");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function store(initial) {
  const state = { ...initial }, subs = new Set();
  return { state, getState: () => state, subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
    set(p) { Object.assign(state, p); subs.forEach((f) => f(state)); } };
}
function row(abs, isDirectory) {
  const attrs = {};
  const el = { attrs, setAttribute: (k, v) => { attrs[k] = String(v); }, removeAttribute: (k) => { delete attrs[k]; } };
  const btn = { attrs: {}, marked: false, setAttribute: (k, v) => { btn.attrs[k] = String(v); }, removeAttribute: (k) => { delete btn.attrs[k]; },
    querySelectorAll: () => [{ textContent: btn.marked ? "M" : "", querySelector: () => null }] };
  el.btn = btn;
  el.querySelector = () => btn;
  el["__reactFiber$t"] = { memoizedProps: { entry: { absPath: abs, isDirectory } }, return: null };
  return el;
}

const calls = [], logs = [];
const files = store({ currentSessionId: "s1", fileBrowserExpandedBySession: { s1: [] },
  followInFilesTree(p) {
    calls.push(p);
    // The panel opens the missing folders shortly after the call.
    setTimeout(() => { files.state.fileBrowserExpandedBySession = { s1: ["C:\\claude\\repos", "C:\\claude\\repos\\app"] }; }, 30);
  } });
const turns = store({ transcriptTurns: { entries: [], responding: false } });
const rows = [row("C:\\claude\\repos", true), row("C:\\claude\\repos\\app", true), row("C:\\claude\\repos\\app\\a.md", false),
  row("C:\\claude\\docs", true), row("C:\\claude\\repos\\app\\b.md", false)];
const rootEl = { "__reactContainer$t": { memoizedProps: { s: files }, memoizedState: { memoizedState: turns, next: null },
  child: null, sibling: null, dependencies: null } };
const document = {
  querySelectorAll(sel) {
    if (sel === "body *") return [rootEl];
    if (sel.indexOf("treeitem") >= 0) return rows;
    if (sel.indexOf("data-fa-git") >= 0) return rows.map((r) => r.btn).filter((b) => b && b.attrs["data-fa-git"]);
    return rows.filter((r) => r.attrs["data-fa-tone"] || r.attrs["data-fa-dim"]);
  }
};
const window = { "claude.web": { LocalSessions: { getSessionList: async () => ({ sessions: [{ sessionId: "s1", cwd: "C:\\claude" }, { sessionId: "s2", cwd: "C:\\claude" }] }) } } };
const sandbox = { window, document, console: { warn: (m) => logs.push(m) }, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Object, String, Promise, WeakSet, JSON };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
const run = (enabled) => vm.runInContext("var __CDB_FILES_ACTIVITY_OPTS=" + JSON.stringify({ enabled }) + ";\n" + SRC, ctx);

const tool = (id, name, input) => ({ id, name, input });
const put = (tools, responding) => turns.set({ transcriptTurns: { entries: [{ id: "m", author: "assistant", items: [{ kind: "tools", id: "i", tools }] }], responding } });

// History present before the feature starts must never follow.
put([tool("old1", "Read", { file_path: "C:\\claude\\README.md" })], false);
run(true);
await wait(50);
ok(calls.length === 0, "history is seeded, not followed");

const hist = [tool("old1", "Read", { file_path: "C:\\claude\\README.md" })];
const live1 = tool("t1", "Read", { file_path: "C:\\claude\\repos\\app\\a.md" });
put([...hist, live1], true);
await wait(60);
ok(calls.length === 1 && calls[0] === "C:\\claude\\repos\\app\\a.md", "a new live Read follows once");
await wait(250);
ok(rows[2].attrs["data-fa-tone"] === "purple", "the read file's row gets the purple tone");
ok(rows[0].attrs["data-fa-dim"] === "purple" && rows[1].attrs["data-fa-dim"] === "purple", "newly opened parent folders are dimmed");
ok(!rows[3].attrs["data-fa-dim"] && !rows[4].attrs["data-fa-tone"], "other rows are left alone");

put([...hist, live1], true);
await wait(40);
ok(calls.length === 1, "a repeat notification for the same tool does nothing");

put([...hist, live1, tool("t2", "Edit", { file_path: "C:\\Users\\Jason\\.claude\\CLAUDE.md" })], true);
await wait(60);
ok(calls.length === 1, "a path outside the session folder is skipped");
ok(logs.some((l) => l.indexOf("outside") >= 0), "the skip is logged once");

put([...hist, live1, tool("t3", "NotebookEdit", { notebook_path: "C:\\claude\\repos\\app\\b.md" })], true);
await wait(60);
ok(calls.length === 2 && calls[1] === "C:\\claude\\repos\\app\\b.md", "NotebookEdit follows through notebook_path");
await wait(150);
ok(rows[4].attrs["data-fa-tone"] === "orange", "an edit gets the orange tone");
ok(!rows[0].attrs["data-fa-dim"], "already open folders are not dimmed");

// Git marks for nested repos: wanted() names the folders on screen, setGit()
// marks rows the app left unmarked and nothing else.
{
  const api = window.__cdbFilesActivity;
  const w = await api.wanted();
  ok(w && w.cwd === "C:\\claude" && w.dirs.includes("C:\\claude\\repos\\app"), "wanted() reports the session folder and the folders on screen");
  rows[4].btn.marked = true; // the app drew its own mark here (the other rows carry its empty span)
  api.setGit([{ root: "C:\\claude\\repos\\app", files: { "a.md": "M", "src/x.js": "A" }, ut: ["new/"] }]);
  ok(rows[2].btn.attrs["data-fa-git"] === "M", "a changed file in a nested repo gets its letter");
  ok(rows[1].btn.attrs["data-fa-git"] === "dir", "the repo folder gets the folder dot");
  ok(!rows[3].btn.attrs["data-fa-git"], "a folder outside the repo is left alone");
  ok(!rows[4].btn.attrs["data-fa-git"], "a row the app already marked keeps the app's mark");
  api.setGit([]);
  ok(!rows[2].btn.attrs["data-fa-git"] && !rows[1].btn.attrs["data-fa-git"], "an empty result clears the marks");
  api.setGit([{ root: "C:\\claude\\repos\\app", files: { "a.md": "M" }, ut: [] }]);
}

// A session switch reseeds: tools already in the new session are history.
files.set({ currentSessionId: "s2" });
put([tool("s2a", "Read", { file_path: "C:\\claude\\repos\\app\\a.md" })], true);
await wait(60);
ok(calls.length === 2, "tools in a session just switched to are not followed");

// Off: no more follows, rows cleared.
run(false);
put([tool("s2a", "Read", { file_path: "C:\\claude\\repos\\app\\a.md" }), tool("s2b", "Read", { file_path: "C:\\claude\\docs\\x.md" })], true);
await wait(60);
ok(calls.length === 2, "with the feature off nothing follows");
ok(rows.every((r) => !r.attrs["data-fa-tone"] && !r.attrs["data-fa-dim"]), "with the feature off no row is marked");
ok(rows.every((r) => !r.btn.attrs["data-fa-git"]), "with the feature off no git mark is left");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
