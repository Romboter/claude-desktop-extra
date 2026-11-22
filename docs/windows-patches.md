# Fork-only patches

The patches this fork adds on top of [upstream's catalog](patches.md). Upstream's file is not edited here (see "Rule: never edit upstream files in place" in the repo's `CLAUDE.md`), so a feature that exists only in this fork is listed on this page instead. Each row links the patch source; the mechanism is documented in the source's header.

| Patch | What it does & why it exists |
|---|---|
| [`add_feature_cache_warm.nim`](../patches/community/add_feature_cache_warm.nim) | **Cache warmer** (opt-in, off by default). Sends one short turn to an idle Code session shortly before its prompt cache would lapse, so your next message still reads the cache instead of paying for a rewrite. Settings -> Extra -> Community Features -> *Cache warmer*: a switch, *stop after N hours without a message* (1-24, default 3) and *stop after N cache rewrites' worth of spend* (0-10, default 1, 0 = no limit); the key is `cacheWarm` = `{enabled, hours, rewrites}` in `claude-desktop-extra.json`, and a valid object in the `.jsonc` wins and locks the row. It reads the cache tier (1h or 5m) from each turn's usage, pokes about 5 minutes (1h) or 1 minute (5m) before expiry, charges each poke its real usage, and stops at a poke that missed the cache. Pokes are ordinary turns: they show in the chat and use a little quota. Log lines: `[cache-warm] <session> poke\|skip(<reason>) ...` in `claude-patches.log`. Policy in [`js/cache_warm.js`](../js/cache_warm.js); tests `scripts/tests/community/test-cache-warm*.mjs` |
| [`add_windows_profiles.nim`](../patches/windows/add_windows_profiles.nim) | `--profile=NAME` and sign-in callback routing for the Windows build |
| [`add_usage_status.nim`](../patches/windows/add_usage_status.nim) | Usage and session status, a port of UI+ for Claude: a usage and pace readout in claude.ai chat pages, behind the `usageStatus` switch (see [usage-session-status.md](usage-session-status.md)) |
| [`add_windows_update_notice.nim`](../patches/windows/add_windows_update_notice.nim) | Once-per-version dialog when a newer `windows-v` release is out (the Windows build has no updater) |

The settings half of the cache warmer (the key, its channels, the page row) lives in upstream files, so it is applied at build time by `scripts/windows/overlay/20-extra-settings.patch`; the patch and test counts it needs are in `10-build-plumbing.patch`.
