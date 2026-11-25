#!/usr/bin/env node
/*
 * test-windows-usage-status-page.mjs - the page half of "Usage and session
 * status" (js/usage_status_page.js + js/usage_status.css), driven in headless
 * Chromium against a fixture of Claude's sidebar. Also unit-checks buildView
 * in plain Node.
 *
 * Chromium: $CDB_CHROMIUM, else the first of chromium / google-chrome on PATH,
 * else Chrome's Windows install folder. None found -> exit 3 (SKIP).
 * Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { findChromium, dumpDom, readProbe } from "../lib/theme-engine-harness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PAGE = readFileSync(join(ROOT, "js/usage_status_page.js"), "utf8");
const CSS = readFileSync(join(ROOT, "js/usage_status.css"), "utf8");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };

// -- buildView, in Node -------------------------------------------------------
{
  const { buildView } = createRequire(import.meta.url)(join(ROOT, "js/usage_status_page.js"));
  const now = Date.parse("2026-11-21T12:00:00Z");
  const reset = (ms) => new Date(now + ms).toISOString();
  const v = buildView({ limits: [
    { kind: "session", percent: 30, resets_at: reset(2.5 * 3600e3) },
    { kind: "weekly_all", percent: 60, resets_at: reset(3.5 * 86400e3) }
  ] }, now, "en", "en");
  ok(v.rows.length === 2 && v.rows[0].label === "Session limit", "buildView: session and weekly rows");
  ok(v.pace === "10% over pace", "buildView: 60% used at 50% of the week is 10% over pace (" + v.pace + ")");
  ok(buildView({ limits: [{ kind: "session", percent: 10, resets_at: null }] }, now, "en", "en").pace === null,
     "buildView: no weekly window, no pace, no throw");
  ok(buildView(null, now, "en", "en") === null, "buildView: no usage, no view");
}

const chromium = process.env.CDB_CHROMIUM || findChromium() ||
  ["C:/Program Files/Google/Chrome/Application/chrome.exe",
   "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find(existsSync);
if (!chromium) {
  console.log("SKIP: no headless Chromium (set CDB_CHROMIUM)");
  console.log(`${pass} passed, ${fail} failed (DOM suite skipped)`);
  process.exit(fail ? 1 : 3);
}

// -- DOM fixtures ---------------------------------------------------------------
const FETCHES = {
  ok: `(p) => p === "/api/organizations" ? Promise.resolve(J([{uuid:"o1"}]))
        : Promise.resolve(J({limits:[{kind:"session",percent:30,resets_at:R(2.5*3600e3)},{kind:"weekly_all",percent:60,resets_at:R(3.5*86400e3)}]}))`,
  fail: `() => Promise.reject(new Error("offline"))`,
  sessionOnly: `(p) => p === "/api/organizations" ? Promise.resolve(J([{uuid:"o1"}]))
        : Promise.resolve(J({limits:[{kind:"session",percent:30,resets_at:R(2.5*3600e3)}]}))`
};

function fixture(runs, fetchKind, probe, extra = "") {
  const scripts = runs.map((enabled) =>
    `<script>var __CDB_USAGE_STATUS_OPTS={enabled:${enabled}};${PAGE.replace(/<\/script/g, "<\\/script")}</script>`).join("\n");
  return `<!doctype html><html lang="en"><head><style>${CSS}</style></head><body>
<div class="dframe-nav-scroll" style="width:260px">
  <div><button type="button"><span>More</span></button></div>
  <div class="dframe-recents-by-mode"><div class="df-label-inset"><span>Recents</span></div>
    <div data-row data-row-key="a"><button data-row-main-button><span class="df-leading-slot"></span><span data-row-label>Same title</span></button></div>
    <div data-row data-row-key="b"><button data-row-main-button><span class="df-leading-slot"></span><span data-row-label>Same title</span></button></div>
  </div>
</div>
${extra}
<pre id="probe"></pre>
<script>
var J = (o) => ({ ok: true, json: () => Promise.resolve(o) });
var R = (ms) => new Date(Date.now() + ms).toISOString();
window.fetch = ${FETCHES[fetchKind]};
</script>
${scripts}
<script>
setTimeout(function () {
  var out = [];
  var ok = (c, n) => out.push((c ? "PASS " : "FAIL ") + n);
  try { ${probe} } catch (e) { out.push("FAIL probe threw " + e); }
  document.getElementById("probe").textContent = out.join("\\n");
}, 800);
</script></body></html>`;
}
const dir = mkdtempSync(join(tmpdir(), "cdb-usage-"));
function run(name, runs, kind, probe, extra) {
  const file = join(dir, name + ".html");
  writeFileSync(file, fixture(runs, kind, probe, extra));
  const lines = readProbe(dumpDom(chromium, file, ["--window-size=900,700"]), "probe");
  if (!lines) { ok(false, name + ": page produced no probe output"); return; }
  for (const l of lines) ok(l.startsWith("PASS"), name + ": " + l.replace(/^(PASS|FAIL) /, ""));
}
const q = (s) => `document.querySelectorAll(${JSON.stringify(s)}).length`;

run("enabled", [true], "ok",
  `ok(${q("#usage-pace .up-row")} === 2, "sidebar usage row shows two limits");
   ok(document.querySelector("#usage-pace .up-pace").textContent === "10% over pace", "pace text beside Usage");
   ok(${q("[data-up-session]")} === 2, "both session rows are marked");`);
run("twice", [true, true], "ok",
  `ok(${q("#usage-pace")} === 1, "two runs leave one usage widget (" + ${q("#usage-pace")} + ")");
   ok(${q("#usage-pace .up-row")} === 2, "and two limit rows");`);
run("off-after-on", [true, false], "ok",
  `ok(${q("#usage-pace, .up-time, .up-context, .up-swatches")} === 0, "teardown removes the widget and lines");
   ok(${q("[data-up-session], [data-up-badge], [data-up-color]")} === 0, "teardown removes session marks");
   ok(window.__cdbUsageStatusTeardown === null || window.__cdbUsageStatusTeardown === undefined, "teardown hook cleared");`);
run("offline", [true], "fail",
  `ok(${q("#usage-pace")} === 0, "no usage: no widget drawn");
   ok(${q("[data-up-session]")} === 2, "session marks still work without usage");`);
run("session-only", [true], "sessionOnly",
  `ok(${q("#usage-pace .up-row")} === 1, "payload without a weekly window renders the session bar only");
   ok(document.querySelector("#usage-pace .up-pace").textContent === "", "and no pace");`);
run("duplicate-titles", [true], "ok",
  `var a = document.querySelector('[data-row-key=a]'), b = document.querySelector('[data-row-key=b]');
   ok(a.querySelector("[data-up-session]") !== null && b.querySelector("[data-up-session]") !== null, "rows with one title are both marked");`);

// Claude's usage popover with the rail's Context card mounted.
const POPOVER = `<div id="portal-root"><div data-cds="Popover"><div class="hdr"><a href="/settings/usage">Usage</a></div>
  <div class="list"><div class="limits"><div data-cds="Meter"><span id="t1">Session limit</span><div role="meter" aria-labelledby="t1"></div></div></div></div></div></div>
<section><div data-rail-context-summary data-rail-context-pct="42">42% of context</div><div data-cds="StackedMeter"></div><button type="button">Compact session</button></section>`;
run("popover", [true], "ok",
  `ok(${q(".up-context")} === 1, "popover: the session's context block is drawn");
   ok(document.querySelector(".up-context-action").textContent === "Compact session", "popover: Compact session button mirrors the rail's");
   ok(document.querySelector(".up-popover-pace").textContent === "10% over pace", "popover: pace beside the header");
   ok(${q(".up-time.up-in-popover")} === 1, "popover: time line above the session meter");`, POPOVER);
run("sidebar-context", [true], "ok",
  `ok(${q("#usage-pace .up-ctx-row")} === 1, "sidebar: context row under the limits");
   ok(document.querySelector("#usage-pace .up-ctx-row .up-label").textContent === "Context 42%", "sidebar: context shows the rail's percent after the label");
   ok(document.querySelector("#usage-pace .up-ctx-row .up-meta").textContent === "", "sidebar: no token counts without the bridge");
   ok(document.querySelector("#usage-pace .up-ctx-row .up-fill").style.width === "42%", "sidebar: context bar width follows it");`, POPOVER);
run("sidebar-context-none", [true], "ok",
  `ok(${q("#usage-pace .up-ctx-row")} === 0, "sidebar: no rail card, no context row");`);
// No rail card: the open local session's context comes from Claude's bridge.
const BRIDGE = `<script>
  document.querySelector("[data-row-key=a] [data-row-main-button]").setAttribute("aria-current", "page");
  document.querySelector("[data-row-key=a]").setAttribute("data-row-key", "code:local_x");
  window.__ctxCalls = 0;
  window["claude.web"] = { LocalSessions: { getContextUsageSummary: (id) => (window.__ctxCalls++, Promise.resolve(id === "local_x" ? { percentage: 61, totalTokens: 610000, rawMaxTokens: 1000000 } : null)) } };
</script>`;
run("sidebar-context-bridge", [true], "ok",
  `ok(${q("#usage-pace .up-ctx-row")} === 1, "bridge: context row drawn without the rail");
   ok(document.querySelector("#usage-pace .up-ctx-row .up-label").textContent === "Context 61%", "bridge: percent follows the label");
   ok(document.querySelector("#usage-pace .up-ctx-row .up-meta").textContent === "610K / 1M", "bridge: used / total tokens on the right (" + document.querySelector("#usage-pace .up-ctx-row .up-meta").textContent + ")");
   ok(window.__ctxCalls === 1, "bridge: one call at load, none from the repeated renders (" + window.__ctxCalls + ")");`, BRIDGE);
// The turn ends (running -> idle): one more ask, no timer involved.
run("sidebar-context-turn-end", [true], "ok",
  `ok(window.__ctxCalls === 2, "turn end: one ask at load and one when the turn ended (" + window.__ctxCalls + ")");`,
  BRIDGE.replace("</script>", `
  window.requestAnimationFrame = function (f) { return setTimeout(f, 0); };
  var dot = document.createElement("span"); dot.className = "status-dot"; dot.setAttribute("data-kind", "running");
  document.querySelector("[data-row-key='code:local_x'] [data-row-main-button]").append(dot);
  setTimeout(function () { dot.setAttribute("data-kind", "idle-x"); dot.remove(); }, 250);
</script>`));
// An empty summary falls back to getContextUsage.
run("sidebar-context-fallback", [true], "ok",
  `ok(document.querySelector("#usage-pace .up-ctx-row .up-label")?.textContent === "Context 44%", "fallback: getContextUsage fills in when the summary is empty");`,
  `<script>
  document.querySelector("[data-row-key=a] [data-row-main-button]").setAttribute("aria-current", "page");
  document.querySelector("[data-row-key=a]").setAttribute("data-row-key", "code:local_x");
  window["claude.web"] = { LocalSessions: {
    getContextUsageSummary: () => Promise.resolve(null),
    getContextUsage: () => Promise.resolve({ percentage: 44 })
  } };
</script>`);
// Cache warm row: state pushed by the main process, a toggle that reports back.
run("cache-warm-row", [true], "ok",
  `var row = () => document.querySelector("#usage-pace .up-cw-row");
   ok(row() !== null && row().querySelector(".up-meta").textContent === "off in Settings", "cache row: off in Settings while the master switch is off");
   var said = []; var log = console.log; console.log = function (m) { said.push(m); };
   window.__cdbCwPush({ master: true, off: [], sessions: { local_x: { expiresAt: Date.now() + 125000, ttl: "1h", pokes: 1, armed: true } } });
   ok(/^[12]:[0-9][0-9] . 1 poke$/.test(row().querySelector(".up-meta").textContent), "cache row: countdown and pokes (" + row().querySelector(".up-meta").textContent + ")");
   ok(row().querySelector(".up-cw-toggle").classList.contains("up-cw-on"), "cache row: switch on");
   row().querySelector(".up-cw-toggle").click();
   ok(said.join() === "__cdb-cw:local_x:0", "cache row: click reports off (" + said.join() + ")");
   ok(/not warming/.test(row().querySelector(".up-meta").textContent) && !row().querySelector(".up-cw-toggle").classList.contains("up-cw-on"), "cache row: shows not warming");
   window.__cdbCwPush({ master: true, off: [], sessions: { local_x: { expiresAt: Date.now() - 1000, ttl: "1h", pokes: 0, note: "time-cap" } } });
   ok(row().querySelector(".up-meta").textContent === "stopped: time limit", "cache row: expired with the stop reason");
   window.__cdbCwPush({ master: true, off: [], sessions: {} });
   ok(row().querySelector(".up-meta").textContent === "no cache seen", "cache row: no cache seen");
   console.log = log;`,
  `<script>
  document.querySelector("[data-row-key=a] [data-row-main-button]").setAttribute("aria-current", "page");
  document.querySelector("[data-row-key=a]").setAttribute("data-row-key", "code:local_x");
</script>`);
run("popover-off", [true, false], "ok",
  `ok(${q(".up-context, .up-popover-pace, .up-time")} === 0, "popover: teardown removes context, pace and time lines");`, POPOVER);

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
