# Usage and session status (Windows)

Settings -> Extra -> Community -> **Usage and session status**. Off by default; it applies live to open chats, no restart. A port of [UI+ for Claude](https://github.com/LukasvanUden/ui-plus-for-claude) (MIT, (c) Lukas van Uden) into the Windows build.

## What it shows

- **Usage row in the sidebar**: the session limit and the weekly limits as bars, with a thin time line above each bar showing how much of that window has passed. Next to **Usage** it says how far over or under pace you are for the week ("on pace" is within three points). Click **Usage** to fold the bars away.

  | Time line | Means |
  |---|---|
  | grey | usage and time agree |
  | green | time is ahead of usage: room to spare |
  | orange | usage is ahead of time: too fast |
  | red | too fast, and Claude already marks the limit as close |

- **State on each session** in the sidebar: a turning gear while Claude works, a still gear with **Waiting** (needs your answer), **Ready** (an unread response) or **Error**; idle sessions show nothing. Side sessions get the same.
- **Usage popover** (the ring below the message box): pace lines above every limit, and the session's context in Claude's own bar colored by what fills it, with **Compact session** once Claude offers it (from 50%), or **Show session rail** while the rail is hidden.
- **Session colors**: right-click a session (or its "..." button) and pick a color in Claude's menu; it shows as a stripe and tint on the row, saved per session.

English and German, light and dark follow Claude.

## How it works

`js/usage_status_main.js` (main process) injects `js/usage_status_page.js` and `js/usage_status.css` into claude.ai pages on `dom-ready` when the key `usageStatus` is true in `claude-desktop-extra.json` (the `.jsonc` wins and locks the switch). The page script reads your plan usage with the page's own sign-in from `/api/organizations/<id>/usage`; nothing is sent anywhere else. It polls once a minute and not while the window is hidden. With the switch off, it removes everything it added. Third-party (`app://localhost`) pages are left alone.

`patches/windows/add_usage_status.nim` appends the main module to `index.pre.js`; the settings row and its IPC channel (`cdb-usage-status:read` / `:set`) come from `scripts/windows/upstream-overlay.patch`. Startup logs `[usage-status] installed (main)` in `claude-patches.log`.

## Differences from UI+

No in-popover on/off rows and no "Uninstall..." (use the switch), no update check (the build has its own update notice), no browser-extension slot.

## If something does not show

The page script follows Claude's own DOM (sidebar classes, the usage popover's `/settings/usage` link, `data-rail-context-*`). After a Claude update a part can stop matching: it then stays out of the way rather than breaking the app. Switch the feature off and on again after an update, and report what is missing.
