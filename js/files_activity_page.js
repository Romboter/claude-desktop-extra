/*
 * files_activity_page.js - page half of "Files tab activity" (Windows build
 * only): follow what Claude touches in the Files tab, with a shimmer on the file
 * name. Embedded by patches/windows/add_files_activity.nim into
 * js/files_activity_main.js, which runs it in the Code tab with
 * __CDB_FILES_ACTIVITY_OPTS = {enabled}. A second run only changes the switch.
 *
 * Three upstream anchors, all measured live on 6.28899.6 (project notes:
 * projects/files-tab-addon/notes.md in the owner's workspace):
 *   1. the transcript store: a zustand-style store (getState/subscribe) whose
 *      state has transcriptTurns = {entries, responding}; entries[].items[] of
 *      kind "tools" hold tools[] ({id, name, ...file_path somewhere inside}).
 *   2. the Files store: same shape, state has followInFilesTree(path),
 *      currentSessionId and fileBrowserExpandedBySession.
 *   3. tree rows: [role="treeitem"] in [data-pane-root][data-perf-screen="file"];
 *      the row's React fiber has memoizedProps.entry = {absPath, isDirectory}
 *      (about 21 hops up) and the file name is in the row's child <button>.
 * An anchor that is missing is logged once ([files-activity] ...) and the
 * feature stays idle; nothing throws into the page.
 *
 * The page script only touches data-* attributes on rows and calls the app's
 * own followInFilesTree. Git marks for nested repos: see the section below. The look (shimmer) lives in js/files_activity.css.
 */
(function () {
  "use strict";
  var KEY = "__cdbFilesActivity";
  var opts = (typeof __CDB_FILES_ACTIVITY_OPTS !== "undefined" && __CDB_FILES_ACTIVITY_OPTS) || {};
  var on = opts.enabled === true;
  if (window[KEY]) { window[KEY].setEnabled(on); return; }

  var ROW_SEL = '[data-pane-root][data-perf-screen="file"] [role="treeitem"]';
  var TOOLS = /^(Read|Edit|MultiEdit|Write|NotebookEdit)$/;
  var FLASH_MS = 2700;
  var PASS_MS = 100;
  var FIND_MS = 3000;
  var GIT_MS = 500;
  var MAX_FIBERS = 300000;
  var MAX_HOPS = 60;

  var warned = {};
  function warn(key, msg) {
    if (warned[key]) return;
    warned[key] = true;
    try { console.warn("[files-activity] " + key + ": " + msg); } catch (e) {}
  }

  var stores = { files: null, turns: null };
  var seen = {};
  var lastSid = null;
  var unsubs = [];
  var findTimer = null;
  var flash = { path: null, tone: "orange", dim: [], until: 0, timer: null };
  var cwdCache = { sid: null, cwd: null };

  function norm(p) { return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); }
  function under(root, p) {
    var r = norm(root), q = norm(p);
    return !!r && (q === r || q.indexOf(r + "/") === 0);
  }

  // ---- stores ---------------------------------------------------------------
  function isStore(v) {
    return !!v && typeof v === "object" && typeof v.getState === "function" && typeof v.subscribe === "function";
  }
  function pick(v) {
    if (isStore(v)) return v;
    if (v && typeof v === "object" && isStore(v.store)) return v.store;
    return null;
  }
  function stateOf(s) { try { return s.getState() || {}; } catch (e) { return {}; } }
  function classify(s) {
    var st = stateOf(s);
    if (typeof st.followInFilesTree === "function") return "files";
    if (st.transcriptTurns && typeof st.transcriptTurns === "object" && "entries" in st.transcriptTurns) return "turns";
    return null;
  }
  function findStores() {
    var root = null, rk = null, all = document.querySelectorAll("body *"), i;
    for (i = 0; i < all.length && !root; i++) {
      var ks = Object.keys(all[i]);
      for (var j = 0; j < ks.length; j++) {
        if (ks[j].indexOf("__reactContainer$") === 0) { root = all[i]; rk = ks[j]; break; }
      }
    }
    if (!root) return;
    var seenFibers = [], stack = [root[rk]], n = 0;
    var mark = typeof WeakSet === "function" ? new WeakSet() : null;
    while (stack.length && n < MAX_FIBERS && (!stores.files || !stores.turns)) {
      var f = stack.pop();
      if (!f || (mark && mark.has(f))) continue;
      if (mark) mark.add(f); else seenFibers.push(f);
      n++;
      var cands = [], p = f.memoizedProps || {}, k;
      for (k in p) cands.push(p[k]);
      for (var c = f.dependencies && f.dependencies.firstContext; c; c = c.next) cands.push(c.memoizedValue);
      for (var s = f.memoizedState; s; s = s.next) cands.push(s.memoizedState);
      for (var m = 0; m < cands.length; m++) {
        var st = pick(cands[m]);
        if (!st) continue;
        var kind = classify(st);
        if (kind && !stores[kind]) stores[kind] = st;
      }
      stack.push(f.sibling, f.child);
    }
  }
  function alive(s) {
    if (!s) return false;
    try { s.getState(); return true; } catch (e) { return false; }
  }

  // ---- tools ----------------------------------------------------------------
  function allTools() {
    var ts = stateOf(stores.turns).transcriptTurns, out = [];
    var es = (ts && ts.entries) || [];
    for (var i = 0; i < es.length; i++) {
      var items = (es[i] && es[i].items) || [];
      for (var j = 0; j < items.length; j++) {
        if (items[j] && items[j].kind === "tools" && items[j].tools) out = out.concat(items[j].tools);
      }
    }
    return out;
  }
  function pathOf(t, depth) {
    if (!t || typeof t !== "object" || (depth || 0) > 3) return null;
    if (typeof t.file_path === "string") return t.file_path;
    if (typeof t.notebook_path === "string") return t.notebook_path;
    for (var k in t) {
      var v = t[k];
      if (v && typeof v === "object") {
        var r = pathOf(v, (depth || 0) + 1);
        if (r) return r;
      }
    }
    return null;
  }
  function reseed() {
    seen = {};
    var ts = allTools();
    for (var i = 0; i < ts.length; i++) if (ts[i] && ts[i].id) seen[ts[i].id] = true;
  }

  // ---- session folder -------------------------------------------------------
  function sessionCwd(sid) {
    if (cwdCache.sid === sid && cwdCache.cwd) return Promise.resolve(cwdCache.cwd);
    var api = window["claude.web"] && window["claude.web"].LocalSessions;
    if (!api || typeof api.getSessionList !== "function") return Promise.resolve(null);
    return api.getSessionList().then(function (list) {
      var arr = (list && list.sessions) || [];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].sessionId === sid && typeof arr[i].cwd === "string") {
          cwdCache = { sid: sid, cwd: arr[i].cwd };
          return arr[i].cwd;
        }
      }
      return null;
    }, function () { return null; });
  }
  function expandedOf(sid) {
    var m = stateOf(stores.files).fileBrowserExpandedBySession;
    var l = (m && m[sid]) || [];
    var out = [];
    for (var i = 0; i < l.length; i++) out.push(norm(l[i]));
    return out;
  }

  // ---- shimmer --------------------------------------------------------------
  function entryOf(row) {
    var f = null, ks = Object.keys(row), i;
    for (i = 0; i < ks.length; i++) if (ks[i].indexOf("__reactFiber$") === 0) { f = row[ks[i]]; break; }
    for (i = 0; f && i < MAX_HOPS; i++, f = f.return) {
      var e = f.memoizedProps && f.memoizedProps.entry;
      if (e && typeof e.absPath === "string") return e;
    }
    return null;
  }
  function clearRows() {
    var rows = document.querySelectorAll("[data-fa-tone],[data-fa-dim]");
    for (var i = 0; i < rows.length; i++) {
      rows[i].removeAttribute("data-fa-tone");
      rows[i].removeAttribute("data-fa-dim");
    }
  }
  function pass() {
    var hot = on && Date.now() < flash.until, rows = document.querySelectorAll(ROW_SEL);
    for (var i = 0; i < rows.length; i++) {
      var e = hot ? entryOf(rows[i]) : null;
      var id = e ? norm(e.absPath) : "";
      if (hot && id === flash.path) {
        rows[i].setAttribute("data-fa-tone", flash.tone);
        rows[i].removeAttribute("data-fa-dim");
      } else if (hot && e && e.isDirectory && flash.dim.indexOf(id) >= 0) {
        rows[i].setAttribute("data-fa-dim", flash.tone);
        rows[i].removeAttribute("data-fa-tone");
      } else {
        rows[i].removeAttribute("data-fa-tone");
        rows[i].removeAttribute("data-fa-dim");
      }
    }
    if (!hot && flash.timer) { clearInterval(flash.timer); flash.timer = null; clearRows(); }
  }
  function light(path, tone, dim) {
    flash.path = norm(path);
    flash.tone = tone;
    flash.dim = dim;
    flash.until = Date.now() + FLASH_MS;
    if (flash.timer) clearInterval(flash.timer);
    pass();
    flash.timer = setInterval(pass, PASS_MS);
  }

  // ---- follow ---------------------------------------------------------------
  function newFolders(sid, before, path, done) {
    var tries = 0, q = norm(path);
    (function look() {
      var now = expandedOf(sid), fresh = [];
      for (var i = 0; i < now.length; i++) {
        if (before.indexOf(now[i]) < 0 && q.indexOf(now[i] + "/") === 0) fresh.push(now[i]);
      }
      // The panel opens the missing folders a moment after the call, so a
      // second look settles it; an empty result after the last look is final.
      if (fresh.length || ++tries >= 6) { done(fresh); return; }
      setTimeout(look, 100);
    })();
  }
  function follow(t) {
    var path = pathOf(t);
    if (!path || !TOOLS.test(String(t.name || ""))) return;
    var sid = stateOf(stores.files).currentSessionId;
    if (!sid || typeof stateOf(stores.files).followInFilesTree !== "function") return;
    var tone = t.name === "Read" ? "purple" : "orange";
    sessionCwd(sid).then(function (cwd) {
      if (!on || !cwd || !under(cwd, path)) {
        if (on && cwd) warn("outside", "skipped, not under the session folder: " + path);
        return;
      }
      var before = expandedOf(sid);
      try { stateOf(stores.files).followInFilesTree(path); } catch (e) { warn("follow", String(e && e.message || e)); return; }
      // The file shimmers at once (its row is marked as soon as the panel
      // renders it); the dim on newly opened folders follows when they show.
      light(path, tone, []);
      var q = norm(path);
      newFolders(sid, before, path, function (fresh) { if (flash.path === q) flash.dim = fresh; });
    });
  }
  function onTurns() {
    if (!on) return;
    var st = stateOf(stores.turns).transcriptTurns || {};
    var sid = stateOf(stores.files).currentSessionId;
    if (sid !== lastSid) { lastSid = sid; reseed(); return; }
    var ts = allTools(), live = st.responding === true;
    for (var i = 0; i < ts.length; i++) {
      var t = ts[i];
      if (!t || !t.id || seen[t.id]) continue;
      seen[t.id] = true;
      if (live) follow(t);
    }
  }

  // ---- git marks in nested repos ---------------------------------------------
  // The app marks files only for the session folder's own repo. The main half
  // polls wanted() for the folders on screen, runs git status in every nested
  // repo it finds there and hands the result to setGit(). Rows the app left
  // unmarked get data-fa-git on their name button (the look is CSS only).
  var git = { repos: [], timer: null };
  function wanted() {
    if (!on || !stores.files) return null;
    var sid = stateOf(stores.files).currentSessionId, rows = document.querySelectorAll(ROW_SEL);
    if (!sid || !rows.length) return null;
    return sessionCwd(sid).then(function (cwd) {
      if (!cwd) return null;
      var dirs = [];
      for (var i = 0; i < rows.length; i++) {
        var e = entryOf(rows[i]);
        if (e && e.isDirectory) dirs.push(e.absPath);
      }
      return { cwd: cwd, dirs: dirs, focused: typeof document.hasFocus === "function" ? document.hasFocus() : true };
    });
  }
  function setGit(list) {
    var out = [];
    for (var i = 0; i < (list || []).length; i++) {
      var r = list[i], root = norm(r.root), files = {}, dirs = {}, k, p;
      if (!root) continue;
      for (k in r.files || {}) {
        files[root + "/" + k.toLowerCase()] = r.files[k];
        for (p = k.toLowerCase(); p.lastIndexOf("/") > 0;) { p = p.slice(0, p.lastIndexOf("/")); dirs[root + "/" + p] = true; }
      }
      var ut = [];
      for (k = 0; k < (r.ut || []).length; k++) {
        var u = root + "/" + String(r.ut[k]).replace(/\/+$/, "").toLowerCase();
        ut.push(u);
        for (p = u; p.length > root.length + 1 && p.lastIndexOf("/") > root.length; ) { p = p.slice(0, p.lastIndexOf("/")); dirs[p] = true; }
      }
      // The repo folder gets the dot only when something in it changed.
      if (ut.length || Object.keys(files).length) dirs[root] = true;
      out.push({ root: root, files: files, dirs: dirs, ut: ut });
    }
    git.repos = out;
    applyGit();
  }
  function markOf(path, isDir) {
    var best = null, i;
    for (i = 0; i < git.repos.length; i++) {
      var r = git.repos[i];
      if (under(r.root, path) && (!best || r.root.length > best.root.length)) best = r;
    }
    if (!best) return null;
    if (isDir) {
      if (best.dirs[path]) return "dir";
      for (i = 0; i < best.ut.length; i++) if (under(best.ut[i], path)) return "dir";
      return null;
    }
    if (best.files[path]) return best.files[path];
    for (i = 0; i < best.ut.length; i++) if (under(best.ut[i], path)) return "U";
    return null;
  }
  function nameButton(row) {
    return row.querySelector ? row.querySelector(":scope > button") : null;
  }
  // The app renders an empty mark span on every row (measured live: all 45 rows
  // matched); only a changed file or folder has text or the folder dot in it.
  function appMarked(b) {
    var sp = b.querySelectorAll ? b.querySelectorAll('span[aria-hidden="true"].ms-auto') : [];
    for (var i = 0; i < sp.length; i++) {
      if (String(sp[i].textContent || "").trim() || (sp[i].querySelector && sp[i].querySelector(".rounded-full"))) return true;
    }
    return false;
  }
  function clearGit() {
    var bs = document.querySelectorAll("[data-fa-git]");
    for (var i = 0; i < bs.length; i++) bs[i].removeAttribute("data-fa-git");
  }
  function applyGit() {
    if (!on) return;
    var rows = document.querySelectorAll(ROW_SEL);
    for (var i = 0; i < rows.length; i++) {
      var b = nameButton(rows[i]);
      if (!b) continue;
      var m = null;
      // A row the app already marked (its own repo) keeps the app's mark.
      if (git.repos.length && !appMarked(b)) {
        var e = entryOf(rows[i]);
        if (e) m = markOf(norm(e.absPath), e.isDirectory === true);
      }
      if (m) b.setAttribute("data-fa-git", m); else b.removeAttribute("data-fa-git");
    }
  }

  // ---- lifecycle ------------------------------------------------------------
  function unsubscribe() {
    while (unsubs.length) { try { unsubs.pop()(); } catch (e) {} }
  }
  function attach() {
    unsubscribe();
    lastSid = stateOf(stores.files).currentSessionId;
    reseed();
    try { unsubs.push(stores.turns.subscribe(onTurns)); } catch (e) { warn("subscribe", String(e && e.message || e)); }
  }
  function tick() {
    if (!on) return;
    var had = alive(stores.files) && alive(stores.turns);
    if (had) return;
    if (!alive(stores.files)) stores.files = null;
    if (!alive(stores.turns)) stores.turns = null;
    findStores();
    if (stores.files && stores.turns) attach();
    else warn("stores", "Files or transcript store not found yet (files=" + !!stores.files + ", turns=" + !!stores.turns + ")");
  }
  function start() {
    if (findTimer) return;
    tick();
    findTimer = setInterval(tick, FIND_MS);
    if (!git.timer) git.timer = setInterval(applyGit, GIT_MS);
  }
  function stop() {
    if (findTimer) { clearInterval(findTimer); findTimer = null; }
    unsubscribe();
    if (flash.timer) { clearInterval(flash.timer); flash.timer = null; }
    flash.until = 0;
    clearRows();
    if (git.timer) { clearInterval(git.timer); git.timer = null; }
    git.repos = [];
    clearGit();
  }

  window[KEY] = {
    setEnabled: function (v) { on = v === true; if (on) start(); else stop(); },
    wanted: wanted,
    setGit: setGit,
    version: 2
  };
  if (on) start();
})();
