/*
 * files_activity_main.js - main-process half of "Files tab activity"
 * (Windows build only), appended to index.pre.js by
 * patches/windows/add_files_activity.nim.
 *
 * Runs js/files_activity_page.js (embedded below) in every claude.ai /
 * claude.com page and in the 3P Code tab (app://localhost, except the 3P setup
 * wizard) on dom-ready, after inserting js/files_activity.css with insertCSS
 * (re-inserted per document, the previous key dropped). The page script finds
 * the Code tab's own stores and does nothing on a page that has none.
 *
 * The switch is the key filesActivity in claude-desktop-extra.json / .jsonc, read
 * on every page load, so a change applies to the next page and needs no
 * restart; the .jsonc wins over the .json. It is off by default.
 *
 * globalThis.__cdbFilesActivityRefresh() (called by the Extra settings handlers
 * after the switch changes) re-runs the page script in every open page,
 * including the teardown run when the switch is off.
 */
;/*__CDB_FILES_ACTIVITY__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "win32") return;
  if (globalThis.__cdbFilesActivityMain) return;
  globalThis.__cdbFilesActivityMain = true;

  var _electron = require("electron");
  var _fs = require("fs");
  var _path = require("path");
  var _URL = require("url").URL;
  // Both placeholders are replaced by the patch with escaped source strings.
  var PAGE_SRC = "__CDB_FILES_ACTIVITY_PAGE_SRC__";
  var PAGE_CSS = "__CDB_FILES_ACTIVITY_CSS__";

  // __cdbDiag (claude-patches.log) is defined inside upstream's app "ready"
  // handler, which runs after this IIFE, so lines logged before the sink
  // exists are queued and flushed one tick after "ready".
  var logQueue = [];
  function emitLog(line) {
    try { (globalThis.__cdbDiag || console.log)(line); } catch (e) {}
  }
  function flushLog() {
    var q = logQueue;
    logQueue = null;
    for (var i = 0; q && i < q.length; i++) emitLog(q[i]);
  }
  function log(m) {
    var line = "[files-activity] " + m;
    if (logQueue && typeof globalThis.__cdbDiag !== "function") { logQueue.push(line); return; }
    flushLog();
    emitLog(line);
  }
  try { _electron.app.whenReady().then(function () { setTimeout(flushLog, 0); }, function () {}); }
  catch (e) { setTimeout(flushLog, 0); }

  // JSONC comment + trailing-comma stripping. Byte-identical in behavior to
  // __cdbEx_strip() in js/extra_settings_main.js and stripJsonComments() in
  // js/growthbook_overrides.js: the three must agree about what a key is set to.
  function stripJsonc(s) {
    var out = "", inStr = false, i = 0;
    while (i < s.length) {
      var c = s[i];
      if (inStr) {
        out += c;
        if (c === "\\" && i + 1 < s.length) { out += s[i + 1]; i++; }
        else if (c === '"') inStr = false;
        i++;
        continue;
      }
      if (c === '"') { inStr = true; out += c; i++; continue; }
      if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
      if (c === "/" && s[i + 1] === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++; i += 2; continue; }
      if (c === ",") {
        var j = i + 1;
        while (j < s.length) {
          if (s[j] === " " || s[j] === "\t" || s[j] === "\r" || s[j] === "\n") { j++; continue; }
          if (s[j] === "/" && s[j + 1] === "/") { while (j < s.length && s[j] !== "\n") j++; continue; }
          if (s[j] === "/" && s[j + 1] === "*") { j += 2; while (j < s.length && !(s[j] === "*" && s[j + 1] === "/")) j++; j += 2; continue; }
          break;
        }
        if (s[j] === "}" || s[j] === "]") { i++; continue; }
      }
      out += c;
      i++;
    }
    return out;
  }

  function readKey(file, key) {
    var raw;
    try { raw = _fs.readFileSync(file, "utf8"); } catch (e) { return undefined; }
    try {
      var cfg = JSON.parse(stripJsonc(raw) || "{}");
      if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) return cfg[key];
    } catch (e2) {}
    return undefined;
  }

  function enabled() {
    try { (globalThis.__cdbCfgMigrate || function () {})(); } catch (e) {}
    var ud;
    try { ud = _electron.app.getPath("userData"); } catch (e) { return false; }
    var jc = readKey(_path.join(ud, "claude-desktop-extra.jsonc"), "filesActivity");
    var js = readKey(_path.join(ud, "claude-desktop-extra.json"), "filesActivity");
    return (jc === undefined ? js : jc) === true;
  }

  // claude.ai / claude.com pages (1P Code tab) and app://localhost (3P Code tab;
  // not its setup wizard, which has no Files panel).
  function injectHost(rawUrl) {
    var u;
    try { u = new _URL(String(rawUrl)); } catch (e) { return false; }
    if (u.protocol === "app:" && u.host === "localhost") {
      return !/^app:\/\/localhost\/setup-desktop-3p(?:[\/?#]|$)/i.test(String(rawUrl));
    }
    if (u.protocol !== "https:") return false;
    var host = u.hostname;
    return host === "claude.ai" || host.endsWith(".claude.ai") ||
      host === "claude.com" || host.endsWith(".claude.com");
  }

  var cssKeys = new WeakMap(); // webContents -> the insertCSS key of the live document
  var cssGen = new WeakMap(); // webContents -> generation counter to drop stale insertCSS resolves
  var injected = new WeakSet(); // webContents that already carry the page script

  function runPage(wc, on) {
    var src = "var __CDB_FILES_ACTIVITY_OPTS=" + JSON.stringify({ enabled: on }) + ";\n" + PAGE_SRC;
    var p = wc.executeJavaScript(src);
    if (p && p.catch) p.catch(function () {});
    if (on) injected.add(wc);
  }

  function dropCss(wc) {
    var g = (cssGen.get(wc) || 0) + 1;
    cssGen.set(wc, g);
    var old = cssKeys.get(wc);
    cssKeys.delete(wc);
    if (old) { var r = wc.removeInsertedCSS(old); if (r && r.catch) r.catch(function () {}); }
  }

  function inject(wc) {
    try {
      if (!wc || wc.isDestroyed()) return;
      if (!injectHost(wc.getURL() || "")) {
        if (cssGen.has(wc)) dropCss(wc);
        injected.delete(wc);
        return;
      }
      var on = enabled();
      dropCss(wc);
      if (!on) {
        // Only a page that already carries the script needs the teardown run.
        if (injected.has(wc)) { injected.delete(wc); runPage(wc, false); }
        return;
      }
      var myGen = cssGen.get(wc);
      var q = wc.insertCSS(PAGE_CSS);
      if (q && q.then) {
        q.then(function (k) {
          if (wc.isDestroyed()) return;
          if (cssGen.get(wc) !== myGen) {
            var r = wc.removeInsertedCSS(k);
            if (r && r.catch) r.catch(function () {});
            return;
          }
          cssKeys.set(wc, k);
        }, function () {});
      }
      runPage(wc, true);
    } catch (e) {}
  }

  _electron.app.on("web-contents-created", function (_ev, wc) {
    wc.on("dom-ready", function () { inject(wc); });
  });

  globalThis.__cdbFilesActivityRefresh = function () {
    log("refresh: filesActivity=" + enabled());
    try { _electron.webContents.getAllWebContents().forEach(inject); } catch (e) {}
  };

  setTimeout(function () { log("installed (main); filesActivity=" + enabled()); }, 0);
})();
