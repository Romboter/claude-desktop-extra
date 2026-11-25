// Embedded as an expression by patches/community/add_feature_cache_warm.nim: the policy of the
// cache warmer. One timer per session, armed when a turn ends, sends one tiny turn shortly before
// the prompt cache would lapse. Everything it touches comes in through `deps`.
// Cost units (ponytail: fixed ratios of the base input price, so poke and rewrite compare in the
// same unit with no price table; revisit if the rates change): poke = context x 0.1, rewrite =
// context x 1.25 (5m) or x 2 (1h), context = input + cache read + cache write of the last usage.
(function __cdbCreateCacheWarm(deps) {
  const MIN = 60000, HOUR = 3600000;
  const TTL = { "5m": 5 * MIN, "1h": HOUR }, MARGIN = { "5m": MIN, "1h": 5 * MIN };
  const REWRITE = { "5m": 1.25, "1h": 2 }, POKE = 0.1, MIN_LEAD = 30000;
  const sessions = new Map();

  const notify = () => { try { deps.changed?.(); } catch (ignored) {} };
  const off = id => { try { return deps.isOff?.(id) === true; } catch (ignored) { return false; } };
  const say = (id, what, st) => {
    st.note = what.startsWith("skip(") ? what.slice(5, -1) : undefined; // shown by the sidebar
    deps.log(`[cache-warm] ${id} ${what} read=${st.read} write=${st.write} tier=${st.ttl}`);
    notify();
  };
  const arm = (id, st, now) => {
    st.handle = deps.setTimer(() => fire(id), Math.max(0, st.expiresAt - MARGIN[st.ttl] - now));
  };
  const drop = id => {
    const st = sessions.get(id);
    if (st && st.handle !== undefined) deps.clearTimer(st.handle);
    sessions.delete(id);
    notify();
  };
  const fail = (id, st, reason) => {
    st.pending = undefined; say(id, `skip(${reason})`, st);
    if (reason === "gone") sessions.delete(id); // archived or deleted: nothing left to warm
  };

  function fire(id) {
    try { check(id); } catch (error) { try { deps.log("[cache-warm] " + id + " error " + String(error)); } catch (ignored) {} }
  }
  function check(id) {
    const st = sessions.get(id);
    if (!st) return;
    st.handle = undefined;
    const cfg = deps.config(), now = deps.now();
    if (!cfg.enabled) { api.stopAll(); return; }
    if (off(id)) return; // switched off for this session: its record stays for the display
    const pokeCost = st.context * POKE, limit = cfg.rewrites * st.context * REWRITE[st.ttl];
    if (now > st.expiresAt) return say(id, "skip(cold)", st);
    if (st.expiresAt - now < MIN_LEAD) return say(id, "skip(late)", st);
    if (now - st.lastRealAt > cfg.hours * HOUR) return say(id, "skip(time-cap)", st);
    if (cfg.rewrites > 0 && st.spent + pokeCost > limit) return say(id, "skip(cost-cap)", st);
    const uuid = deps.newUuid();
    st.pending = uuid;
    st.pokes = (st.pokes || 0) + 1;
    say(id, "poke", st);
    Promise.resolve().then(() => deps.sendPoke(id, uuid)).then(
      result => { if (!result || !result.delivered) fail(id, st, (result && result.reason) || "not-delivered"); },
      () => fail(id, st, "error"));
  }

  const api = {
    turnEnded(id, usage, uuid) { try { ended(id, usage, uuid); } finally { notify(); } },
    // Per-session switch: off stops the timer, on re-arms it while the cache still lives.
    setOff(id, isOff) {
      const st = sessions.get(id);
      if (st) {
        if (st.handle !== undefined) { deps.clearTimer(st.handle); st.handle = undefined; }
        if (!isOff && deps.config().enabled && st.expiresAt > deps.now()) arm(id, st, deps.now());
      }
      notify();
    },
    // What the sidebar shows, by session id. `armed`: a poke is scheduled.
    snapshot() {
      const out = {};
      for (const [id, st] of sessions) {
        out[id] = { expiresAt: st.expiresAt, ttl: st.ttl, pokes: st.pokes || 0, note: st.note, armed: st.handle !== undefined };
      }
      return out;
    },
    sessionGone: drop,
    size: () => sessions.size,
    stopAll() { for (const id of [...sessions.keys()]) drop(id); },
  };
  function ended(id, usage, uuid) {
      const cfg = deps.config();
      if (!cfg.enabled) { drop(id); return; }
      const total = ((usage && usage.input_tokens) || 0) + ((usage && usage.cache_read_input_tokens) || 0) +
        ((usage && usage.cache_creation_input_tokens) || 0);
      if (total === 0) return; // a result with no API call behind it (a local command): nothing changed
      let st = sessions.get(id);
      if (!st) sessions.set(id, st = { spent: 0 });
      if (st.handle !== undefined) { deps.clearTimer(st.handle); st.handle = undefined; }
      const isPoke = uuid !== undefined && uuid === st.pending;
      if (isPoke) st.pending = undefined;
      const split = (usage && usage.cache_creation) || {};
      st.read = (usage && usage.cache_read_input_tokens) || 0;
      st.write = (usage && usage.cache_creation_input_tokens) || 0;
      st.context = ((usage && usage.input_tokens) || 0) + st.read + st.write;
      if (split.ephemeral_1h_input_tokens > 0) st.tier = "1h";
      else if (split.ephemeral_5m_input_tokens > 0) st.tier = "5m";
      const now = deps.now();
      if (!isPoke || st.lastRealAt === undefined) { st.lastRealAt = now; st.spent = 0; st.pokes = 0; }
      // The observed tier wins over the env var: the server can downgrade a session to 5m.
      st.ttl = st.tier || (TTL[cfg.ttlEnv] ? cfg.ttlEnv : undefined);
      if (!st.ttl) { st.ttl = "?"; say(id, "skip(no-tier)", st); return; }
      if (isPoke) {
        st.spent += st.read * POKE + st.write * REWRITE[st.ttl]; // what the poke really cost
        if (st.read === 0) { say(id, "skip(cold)", st); return; } // it missed the cache: stop the chain
      }
      if (st.read === 0 && st.write === 0) { say(id, "skip(cold)", st); return; }
      st.expiresAt = now + TTL[st.ttl];
      st.note = undefined;
      if (!off(id)) arm(id, st, now);
  }
  return api;
})
