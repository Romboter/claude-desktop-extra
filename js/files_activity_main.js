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
 * The same module also marks files of nested git repos (see the git status
 * section): the app's own marks cover only the session folder's repo.
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
  var _cp = require("child_process");
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

  // ---- git status for nested repos --------------------------------------------
  // Shaped after VS Code's git extension: git status runs when something changed,
  // not on a timer. Each repo found under the session folder gets an fs.watch;
  // an event marks it dirty, and a status run happens once it has been quiet for
  // QUIET_MS, at least COOLDOWN_MS after its last run, only while the window is
  // focused and the repo's folder row is on screen, at most MAX_RUNNING at once.
  // A slow fallback marks a repo dirty every FALLBACK_MS to catch missed events.
  // A repo whose status output is over MAX_OUT is "huge": skipped until the
  // session folder changes. The page is asked once a second what is on screen
  // (wanted) and given the results (setGit); nothing is exposed to it, so the
  // remote page cannot call into main. Paths from the page are re-checked here
  // (absolute, strictly under the session folder, at most MAX_REPOS repos) and
  // git runs with core.fsmonitor off so a repo config cannot start a program.
  var MAX_REPOS = 16;
  var MAX_RUNNING = 3;
  var TICK_MS = 1000;
  var QUIET_MS = 1000;
  var COOLDOWN_MS = 5000;
  var FALLBACK_MS = 60000;
  var MAX_OUT = 1024 * 1024;
  var polls = new WeakMap(); // webContents -> {timer, busy, cwd, repos, last}

  function inside(root, p) {
    var r = _path.resolve(root).toLowerCase(), q = _path.resolve(p).toLowerCase();
    return q !== r && q.indexOf(r + _path.sep) === 0;
  }

  // -z porcelain v1 -> {files: {rel: M|A|U|R|!}, ut: [untracked dir/]}.
  // Deleted paths have no row and are skipped; a rename carries the old name as
  // the next token.
  function parseStatus(out) {
    var t = String(out).split("\0"), files = {}, ut = [];
    for (var i = 0; i < t.length; i++) {
      var s = t[i];
      if (s.length < 4) continue;
      var x = s[0], y = s[1], p = s.slice(3);
      if (x === "R" || x === "C") i++;
      if (x === "?" && y === "?") {
        if (p.slice(-1) === "/") ut.push(p); else files[p] = "U";
      } else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
        files[p] = "!";
      } else if (x === "D" || y === "D") {
        continue;
      } else if (x === "A" || y === "A") {
        files[p] = "A";
      } else if (x === "R" || x === "C") {
        files[p] = "R";
      } else {
        files[p] = "M";
      }
    }
    return { files: files, ut: ut };
  }

  // cb(result) on success, cb(null, huge) on failure.
  function gitStatus(repo, cb) {
    try {
      _cp.execFile("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", repo,
        "status", "--porcelain=v1", "-z", "--untracked-files=normal"],
        { timeout: 20000, maxBuffer: MAX_OUT, windowsHide: true,
          env: Object.assign({}, process.env, { GIT_OPTIONAL_LOCKS: "0" }) },
        function (err, out) {
          if (!err) { cb(parseStatus(out)); return; }
          cb(null, err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
        });
    } catch (e) { cb(null, false); }
  }

  // Only changes that can alter git status: everything outside .git, plus
  // .git/index and .git/HEAD. node_modules churn is ignored.
  function relevant(name) {
    if (!name) return true;
    var f = String(name).split(String.fromCharCode(92)).join("/");
    if (f === ".git" || f.indexOf(".git/") === 0) return f === ".git/index" || f === ".git/HEAD";
    return f.indexOf("node_modules/") !== 0 && f.indexOf("/node_modules/") < 0;
  }

  function watchRepo(r, root) {
    try {
      r.watcher = _fs.watch(root, { recursive: true, persistent: false }, function (_ev, name) {
        if (!relevant(name)) return;
        r.dirty = true;
        r.event = Date.now();
      });
      r.watcher.on("error", function () { try { r.watcher.close(); } catch (e) {} r.watcher = null; });
    } catch (e) { r.watcher = null; }
  }
  function closeRepos(st) {
    for (var k in st.repos) { try { if (st.repos[k].watcher) st.repos[k].watcher.close(); } catch (e) {} }
    st.repos = {};
  }

  function pushResults(wc, st) {
    var out = [];
    for (var k in st.repos) if (st.repos[k].res) out.push({ root: k, files: st.repos[k].res.files, ut: st.repos[k].res.ut });
    var json = JSON.stringify(out);
    if (json === st.last || wc.isDestroyed()) return;
    st.last = json;
    var q = wc.executeJavaScript("window.__cdbFilesActivity&&window.__cdbFilesActivity.setGit&&window.__cdbFilesActivity.setGit(JSON.parse(" + JSON.stringify(json) + "))");
    if (q && q.catch) q.catch(function () {});
  }

  function tick(wc, st) {
    if (st.busy || wc.isDestroyed()) return;
    st.busy = true;
    var done = function () { st.busy = false; };
    var q = wc.executeJavaScript(
      "(window.__cdbFilesActivity&&window.__cdbFilesActivity.wanted&&window.__cdbFilesActivity.wanted())||null");
    if (!q || !q.then) { done(); return; }
    q.then(function (w) {
      done();
      if (!w || typeof w.cwd !== "string" || !_path.isAbsolute(w.cwd) || !Array.isArray(w.dirs)) return;
      if (st.cwd !== w.cwd) { closeRepos(st); st.cwd = w.cwd; st.last = ""; }
      var n = Object.keys(st.repos).length, now = Date.now(), seen = {}, i;
      for (i = 0; i < w.dirs.length && i < 5000; i++) {
        var d = w.dirs[i];
        if (typeof d !== "string" || !_path.isAbsolute(d) || !inside(st.cwd, d)) continue;
        seen[d] = true;
        if (st.repos[d] || n >= MAX_REPOS) continue;
        try {
          if (_fs.existsSync(_path.join(d, ".git"))) {
            st.repos[d] = { dirty: true, event: 0, end: 0, running: false, huge: false, res: null, watcher: null };
            watchRepo(st.repos[d], d);
            n++;
          }
        } catch (e) {}
      }
      if (w.focused === false) return;
      var running = 0, k;
      for (k in st.repos) if (st.repos[k].running) running++;
      Object.keys(st.repos).forEach(function (root) {
        var r = st.repos[root];
        if (!seen[root] || r.running || r.huge || running >= MAX_RUNNING) return;
        if (now - r.end >= FALLBACK_MS) r.dirty = true;
        if (!r.dirty || now - r.event < QUIET_MS || now - r.end < COOLDOWN_MS) return;
        r.running = true;
        r.dirty = false;
        running++;
        gitStatus(root, function (res, huge) {
          r.running = false;
          r.end = Date.now();
          if (huge) { r.huge = true; try { if (r.watcher) r.watcher.close(); } catch (e) {} r.watcher = null; }
          r.res = res || null; // null: huge, not a repo any more, or git failed
          pushResults(wc, st);
        });
      });
    }, done);
  }

  function stopPoll(wc) {
    var st = polls.get(wc);
    if (st) { clearInterval(st.timer); closeRepos(st); polls.delete(wc); }
  }
  function startPoll(wc) {
    stopPoll(wc);
    var st = { timer: null, busy: false, cwd: "", repos: {}, last: "" };
    st.timer = setInterval(function () { tick(wc, st); }, TICK_MS);
    polls.set(wc, st);
  }

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
        stopPoll(wc);
        return;
      }
      var on = enabled();
      dropCss(wc);
      if (!on) {
        stopPoll(wc);
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
      startPoll(wc);
    } catch (e) {}
  }

  _electron.app.on("web-contents-created", function (_ev, wc) {
    wc.on("dom-ready", function () { inject(wc); });
    wc.once("destroyed", function () { stopPoll(wc); });
  });

  globalThis.__cdbFilesActivityRefresh = function () {
    log("refresh: filesActivity=" + enabled());
    try { _electron.webContents.getAllWebContents().forEach(inject); } catch (e) {}
  };

  setTimeout(function () { log("installed (main); filesActivity=" + enabled()); }, 0);
})();
