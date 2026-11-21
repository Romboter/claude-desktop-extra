# Windows troubleshooting

Common problems with the Windows build and how to fix them. See the [Windows guide](windows.md) for install, profiles and how the build works.

## Logs

`%APPDATA%\Claude\logs\` (a named profile: `%APPDATA%\Claude-<name>\logs\`).

- `claude-patches.log`: this project's lines (`[win-profiles]`, `[ExtraSettings]`, `[CustomThemes]`, `[custom-models]`, `[DiffViews]`, `[win-update]`).
- `custom-models.log`: each routed custom-model request.
- `main.log`: the app's own log.

## The app will not start

- **Smart App Control is on.** It blocks apps whose signature is missing or broken, and this build's `claude.exe` no longer verifies, so the app will not start. There is no per-app exception.
  - **Check:** open Windows Security → App & browser control → Smart App Control settings. It shows **On**, **Evaluation** or **Off**. Evaluation mode also blocks and may later switch itself on or off.
  - **Fix:** choose **Off**. This is a system-wide change that affects every app, not just this one. Smart App Control only exists on Windows 11, and mostly on PCs that were set up or reset on a recent version.
  - **Turning it back on:** Windows Security → App & browser control → Smart App Control settings → **On**. Microsoft's [FAQ](https://support.microsoft.com/en-us/topic/smart-app-control-frequently-asked-questions-285ea03d-fa88-4d56-882e-6698afdb7003) says only that "recent Windows updates" allow this without a clean install; it names no build. Older builds make turning it off permanent unless you reset or reinstall Windows. Run `winver` to see your build, and install the latest Windows updates if the choice is missing or greyed out.
  - **Which update added it (reported, not confirmed by Microsoft):**

    | Reported update | Builds | Source |
    |---|---|---|
    | KB5074105 (early 2026), Windows 11 24H2 and 25H2 | not given | Neowin, February 2026 |
    | KB5083769 (14 April 2026) | 26100.8246 and 26200.8246 (one source says 8116) | Topedia and others |
    | Insider preview | 26220.7070 | a Microsoft Q&A answer |

  - **Why it is off, from Microsoft's documentation:**
    - The PC is enterprise-managed, or developer mode is configured.
    - You or another user turned it off manually.
    - Windows is in S mode: turn S mode off, then reset the PC.
    - Optional diagnostic data is turned off in Windows: reset the PC or reinstall Windows, and choose **Send optional diagnostic data** during setup.

    Microsoft adds that recent Windows updates let you turn it on in Windows Security without a clean install. Which of the reasons above lets you do that is not spelled out, so if the choice stays greyed out, a reset is the fallback.
  - **If you would rather keep it on:** use the official Claude app instead; this build cannot run under Smart App Control.
- **The official Claude app is running.** The default profile shares `%APPDATA%\Claude` with it, and only one can run at a time. Quit the official app first.
- **Antivirus quarantined `claude.exe`.** The build changes only the asar hash stored inside it. Restore it and add an exclusion for `%LOCALAPPDATA%\Programs\Claude Desktop Extra`.

## "Windows protected your PC" when running Install.cmd

SmartScreen warns once about a downloaded zip. Click **More info → Run anyway**. The installer clears the mark, so starting Claude afterwards should not warn.

## Signing in

- **The sign-in link opens the wrong app or profile.** `claude://` callbacks can open either the official app or this one, and always start without a profile. A callback goes to the profile that opened the sign-in page most recently (within 5 minutes). Start one sign-in at a time, and quit the app you are not signing in to.
- **Signed in on the official app but not here.** The default profile shares its data folder, so it should be signed in. A named profile has its own sign-in.

## Custom models

If the user folder name has a space (`C:\Users\John Smith`), the model routing uses the profile folder's 8.3 short name. On a drive with short names turned off, sessions are not routed and `claude-patches.log` says so. Set `CLAUDE_USER_DATA_DIR` to a folder without spaces.

## Hand-edited settings are ignored

Save `claude-desktop-extra.jsonc` and theme files as UTF-8 **without** a byte-order mark: Notepad's default, or `Set-Content -Encoding utf8NoBOM` in PowerShell 7. Windows PowerShell 5.1's `>` and `Set-Content -Encoding UTF8` write encodings that some readers cannot parse.

## Update dialog

The app tells you once per version when a newer `windows-v` release exists. It never downloads anything. `CDB_UPDATE_NOTICE=0` in the environment turns it off.

## Known limits

- **Start at login** starts the default profile.
- All profiles share one taskbar group; tell them apart by the window title.
- A named profile ignores the 3P (`Claude-3p`) data folder switch.

## Reporting a bug

Attach `claude-patches.log`, and say which `windows-v` release and architecture (x64 or arm64) you installed.
