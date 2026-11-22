#!/usr/bin/env node
// test-cache-warm-settings.mjs - the settings half of the "Cache warmer" community feature: the
// cacheWarm key ({enabled, hours, rewrites}), its IPC channels, the live config read the patch uses,
// the bridge methods and the page row. Run it on a prepared copy (scripts/windows/prepare-sources.sh):
// the settings code lives in upstream files the fork edits through its overlay.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import vm from "node:vm";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EXTRA_BIN = join(ROOT, "patches/core/add_feature_extra_settings") + (process.platform === "win32" ? ".exe" : "");
accessSync(EXTRA_BIN, constants.X_OK);
const require2 = createRequire(import.meta.url);
const Module = require2("module");

async function run(platform, body) {
  const dir = mkdtempSync(join(tmpdir(), "cdb-cw-extra-"));
  const mod = join(dir, "extra.cjs");
  writeFileSync(mod, '"use strict";\nfunction FHa(e=[]){let t=G().type==="3p"&&ou()==="1p"?[...e,j$t]:e;a.app.isPackaged?Mj(!0,t):fj(t)}\n' +
    'var Hrr,Urr;function Yrr(){return Urr??=(async()=>{let t,n,r,s;return Hrr={qemuPath:t,firmwarePath:n,virtiofsdPath:r,virtiofsdAptInstallable:!0,kvm:s},Hrr})(),Urr}function Xrr(){return Hrr}\n' +
    'function nav0(){let Uy=go(Hy,"Navigation",Xy,{events:[["navigate",[["path",I]]]]});return Uy}\n');
  execFileSync(EXTRA_BIN, [mod], { stdio: "ignore" });
  const userData = join(dir, "Claude"); mkdirSync(userData, { recursive: true });
  const handlers = {};
  const fakeElectron = {
    app: { getPath: () => userData, on: () => {}, once: () => {}, relaunch: () => {}, exit: () => {} },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, removeHandler: () => {} },
    shell: { openPath: () => Promise.resolve(""), showItemInFolder: () => {} },
  };
  const orig = Module._load;
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Module._load = function (req, ...rest) { return req === "electron" ? fakeElectron : orig.call(this, req, ...rest); };
  Object.defineProperty(process, "platform", { value: platform });
  globalThis.__cdbDiag = () => {};
  delete globalThis.__cdbCacheWarmConfig;
  try { require2(mod); } finally { Module._load = orig; Object.defineProperty(process, "platform", realPlatform); }
  const ev = { sender: { isDestroyed: () => false, getURL: () => "https://claude.ai/settings" }, senderFrame: { parent: null } };
  try {
    await body({ call: async (ch, ...a) => handlers[ch](ev, ...a), handlers, json: join(userData, "claude-desktop-extra.json"), jsonc: join(userData, "claude-desktop-extra.jsonc") });
  } finally { rmSync(dir, { recursive: true, force: true }); delete globalThis.__cdbCacheWarmConfig; delete process.env.CLAUDE_CODE_PROMPT_CACHE_TTL; }
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const good = { enabled: true, hours: 6, rewrites: 2.5 };

for (const platform of ["linux", "win32"]) {
  test(`${platform}: defaults, live set, validation, removal`, async () => {
    await run(platform, async ({ call, handlers, json }) => {
      assert.equal(typeof globalThis.__cdbCacheWarmConfig, "function");
      assert.equal(JSON.stringify(globalThis.__cdbCacheWarmConfig()), JSON.stringify({ enabled: false, hours: 3, rewrites: 1 }));
      assert.ok(handlers["cdb-cache-warm:read"] && handlers["cdb-cache-warm:set"]);
      let r = await call("cdb-cache-warm:read");
      assert.deepEqual([r.ok, r.enabled, r.hours, r.rewrites, r.lockedByJsonc], [true, false, 3, 1, null]);
      r = await call("cdb-cache-warm:set", good); assert.equal(r.ok, true);
      assert.equal(JSON.stringify(JSON.parse(readFileSync(json, "utf8")).cacheWarm), JSON.stringify(good));
      assert.equal(JSON.stringify(globalThis.__cdbCacheWarmConfig()), JSON.stringify(good), "read live, no restart");
      for (const bad of [{ ...good, enabled: "yes" }, { ...good, hours: 0 }, { ...good, hours: 25 }, { ...good, hours: 1.5 },
        { ...good, rewrites: -1 }, { ...good, rewrites: 11 }, { ...good, rewrites: NaN }, null, 7]) {
        r = await call("cdb-cache-warm:set", bad); assert.equal(r.ok, false, JSON.stringify(bad));
      }
      assert.equal(JSON.stringify(globalThis.__cdbCacheWarmConfig()), JSON.stringify(good), "a refused set changes nothing");
      r = await call("cdb-cache-warm:set", { enabled: false, hours: 3, rewrites: 1 }); assert.equal(r.ok, true);
      assert.equal("cacheWarm" in JSON.parse(readFileSync(json, "utf8")), false, "defaults remove the key");
    });
  });
}
test("jsonc wins and locks; an invalid jsonc value is ignored with a warning", async () => {
  await run("linux", async ({ call, json, jsonc }) => {
    writeFileSync(jsonc, '{\n  // hand-edited\n  "cacheWarm": { "enabled": true, "hours": 2, "rewrites": 0 },\n}\n');
    assert.equal(JSON.stringify(globalThis.__cdbCacheWarmConfig()), JSON.stringify({ enabled: true, hours: 2, rewrites: 0 }));
    let r = await call("cdb-cache-warm:read"); assert.equal(r.lockedByJsonc, true);
    r = await call("cdb-cache-warm:set", good); assert.equal(r.ok, false); assert.equal(r.lockedByJsonc, true);
    writeFileSync(jsonc, '{ "cacheWarm": { "enabled": true, "hours": 99, "rewrites": 1 } }');
    writeFileSync(json, JSON.stringify({ cacheWarm: good }));
    assert.equal(globalThis.__cdbCacheWarmConfig().hours, 6, "the invalid .jsonc value is ignored");
    r = await call("cdb-cache-warm:read"); assert.equal(r.lockedByJsonc, null); assert.match(r.warning, /cacheWarm/);
  });
});
test("the TTL env var is passed through only when valid", async () => {
  await run("linux", async () => {
    process.env.CLAUDE_CODE_PROMPT_CACHE_TTL = "5m"; assert.equal(globalThis.__cdbCacheWarmConfig().ttlEnv, "5m");
    process.env.CLAUDE_CODE_PROMPT_CACHE_TTL = "bogus"; assert.equal(globalThis.__cdbCacheWarmConfig().ttlEnv, undefined);
  });
});
test("bridge methods and the Community page row", () => {
  const calls = []; let api = null;
  vm.runInNewContext(readFileSync(join(ROOT, "js/extra_settings_bridge.js"), "utf8"), vm.createContext({
    require: () => ({ contextBridge: { exposeInMainWorld: (_n, a) => { api = a; } }, ipcRenderer: { invoke: (...a) => { calls.push(a); return Promise.resolve({ ok: true }); } } }),
  }));
  api.cacheWarmRead(); api.cacheWarmSet(good);
  assert.equal(JSON.stringify(calls), JSON.stringify([["cdb-cache-warm:read"], ["cdb-cache-warm:set", good]]));
  const page = readFileSync(join(ROOT, "js/extra_settings_page.js"), "utf8");
  const row = /function renderCacheWarmRow\(panel\) \{[\s\S]*?\n {2}\}\n/.exec(page);
  assert.ok(row); assert.match(row[0], /Cache warmer/); assert.match(row[0], /cacheWarmRead/); assert.match(row[0], /cacheWarmSet/);
  assert.ok(row[0].includes('rewrites.input.value.trim() === ""'), "an empty rewrites field must not mean no cost cap");
  assert.equal(row[0].includes(String.fromCharCode(0x2014)), false);
  assert.match(page, /var FEATURE_GROUPS = [\s\S]*?renderCacheWarmRow/);
  assert.match(page, /var WINDOWS_ROWS = \[[^\]]*renderCacheWarmRow/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("ok   " + name); }
  catch (error) { failed++; console.log("FAIL " + name + "\n     " + String(error.message).split("\n")[0]); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
