# Claude Desktop for Windows (Extra)

[![Windows build](https://img.shields.io/github/v/release/Romboter/claude-desktop-extra?filter=windows-v%2A&label=Windows%20build)](https://github.com/Romboter/claude-desktop-extra/releases)
[![Upstream Sync](https://github.com/Romboter/claude-desktop-extra/actions/workflows/upstream-sync.yml/badge.svg)](https://github.com/Romboter/claude-desktop-extra/actions/workflows/upstream-sync.yml)

**Anthropic's official Claude Desktop for Windows, with extras on top:** separate profiles, themes, Code tab add-ons and custom models. It is experimental and unofficial.

Everything else (Chat, Cowork, Claude Code, sign-in) is Anthropic's own app, unchanged. This project downloads Anthropic's Windows package, patches it, and republishes it as a portable zip for x64 and arm64. A new Anthropic version is picked up and rebuilt automatically.

> This is an unofficial build. It is not made or supported by Anthropic. "Claude" is Anthropic's.

## What you get

- **Profiles:** several separate Claude instances side by side. Each has its own sign-in, settings and Claude Code configuration.
- **Settings → Extra**, with four panels:
  - **Themes:** the [theme engine](https://github.com/Romboter/claude-desktop-extra/blob/master/docs/themes.md), bundled palettes, and a picker on <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd>.
  - **Community:** opt-in features. These are diff view modes, panel tabs and files quick open (<kbd>Ctrl</kbd>+<kbd>P</kbd>) in the [Code tab](https://github.com/Romboter/claude-desktop-extra/blob/master/docs/code-tab.md); loading large sessions in full; non-Anthropic models; a theme picker; developer tools; the [Jira issue tracker](https://github.com/Romboter/claude-desktop-extra/blob/master/docs/jira-tracker.md) (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd>); and an [auto-archive delay](https://github.com/Romboter/claude-desktop-extra/blob/master/docs/auto-archive-grace.md) after a PR merges or closes.
  - **Models:** [custom models](https://github.com/Romboter/claude-desktop-extra/blob/master/docs/custom-models.md) from other providers in the Code tab's picker.
  - **Anthropic:** [feature flag overrides](https://github.com/Romboter/claude-desktop-extra/blob/master/docs/feature-flags.md).

Left out because Windows has its own, or because they are Linux plumbing: the Linux fixes, the Computer Use bridges, Linux window controls, the Quick Entry socket, and the Deployment panel (Windows reads managed settings from the registry).

## Install

1. Download `claude-desktop-extra-<version>-windows-x64.zip` (or `-arm64`) from a [`windows-v<version>` release](https://github.com/Romboter/claude-desktop-extra/releases). Every release tagged `windows-v…` is a Windows build.
2. Unzip it and double-click **Install.cmd**. It unpacks the app to `%LOCALAPPDATA%\Programs\Claude Desktop Extra` and adds **Claude (Extra)** to the Start Menu. No administrator rights are needed.
3. Windows may show "Windows protected your PC". Click **More info → Run anyway**. See [Signing](#signing) for why.

To update, install the next zip the same way. Your data and sign-in are kept. The app does not update itself, but it tells you when a newer build exists: it checks this repository's releases about a minute after start, then every 12 hours, and shows one dialog per new version. Set `CDB_UPDATE_NOTICE=0` to turn that off. `Install.cmd -Uninstall` removes the app and keeps your data.

If the official Claude app is installed too, both use the same data folder and you stay signed in, but only one can run at a time. Quit the official app first.

## Profiles

```bat
Install.cmd -Profile work            :: adds "Claude (work)" to the Start Menu
Install.cmd -Profile work -Desktop   :: and to the desktop
Install.cmd -RemoveProfile work      :: removes the shortcut, keeps the data
```

A profile keeps its own data in `%APPDATA%\Claude-work` and its Claude Code configuration in `%USERPROFILE%\.claude-work`. Details and limits are in the [Windows guide](https://github.com/Romboter/claude-desktop-extra/blob/master/docs/windows.md#profiles).

## Signing

Anthropic signs `claude.exe`. The build has to change that file, so its signature no longer verifies, and nobody else signs it. In practice:

- **SmartScreen** may warn once when you run `Install.cmd`.
- **Smart App Control**, if turned on, blocks apps with a broken signature, so this build will not start. It has no per-app exception.
- **Antivirus** may look harder at the exe. The build changes only the asar hash stored inside it.

More in the [Windows guide](https://github.com/Romboter/claude-desktop-extra/blob/master/docs/windows.md#code-signing).

## How it stays current

The **Upstream Sync** workflow runs every 2 hours:

1. It syncs this fork with its upstream.
2. It reads Anthropic's Windows release feed and compares it with the newest published `windows-v` release.
3. It builds and publishes only when upstream changed or Anthropic's version is **higher**. A build is smoke-tested on real Windows runners (x64 and arm64) before anything is published.

If a build fails, the workflow opens an "Automatic update failed" issue and **pauses itself**: nothing is built or merged until the problem is fixed, so a broken build is not retried every 2 hours. While paused, each run reports how far behind Anthropic and upstream the fork is. After a fix, run the workflow by hand with **force_build** ticked. A green run closes the issue and resumes the schedule. Closing the issue also resumes it.

The full build steps, the upstream overlay and the sync rules are in the [Windows guide](https://github.com/Romboter/claude-desktop-extra/blob/master/docs/windows.md).

## Linux

This repository is a fork of [patrickjaja/claude-desktop-extra](https://github.com/patrickjaja/claude-desktop-extra), which packages Claude Desktop for Linux. This fork does not publish Linux packages. For Linux, use the upstream project; its README is still in this repository as [README.md](https://github.com/Romboter/claude-desktop-extra/blob/master/README.md).

## Credits and license

- Linux project, patch framework and extras: [Patrick Jaja](https://github.com/patrickjaja).
- Windows build layer (profiles, packaging, Windows patch set): [stratosjl](https://github.com/stratosjl/claude-desktop-extra).
- Claude Desktop is Anthropic's.

Released under the [MIT License](https://github.com/Romboter/claude-desktop-extra/blob/master/LICENSE).
