<#
.SYNOPSIS
  Installs Claude Desktop Extra (the patched portable Windows build) for the
  current user, and manages its profile shortcuts.

.DESCRIPTION
  Unpacks app.zip (or copies the app\ folder) next to this script to the
  install folder and adds Start Menu shortcuts. No administrator rights are
  needed and nothing outside the current user's profile is changed.

  Run it from the unzipped folder:
    .\Install.cmd                       install or update
    .\Install.cmd -Profile work         add a "Claude (work)" shortcut
    .\Install.cmd -RemoveProfile work   remove that shortcut (its data stays)
    .\Install.cmd -Desktop              also put the shortcut on the desktop
    .\Install.cmd -Uninstall            remove the app and its shortcuts

  Each profile is a separate Claude with its own sign-in, settings and Claude
  Code configuration (%APPDATA%\Claude-<name>, %USERPROFILE%\.claude-<name>).
  The default profile uses the same folders as the official Claude app.

.LINK
  https://github.com/patrickjaja/claude-desktop-extra/blob/master/docs/windows.md
#>
[CmdletBinding()]
param(
  # Not $Profile: that name is PowerShell's own automatic variable.
  [Alias('Profile')][string]$ProfileName,
  [string]$RemoveProfile,
  [switch]$Desktop,
  [switch]$Uninstall,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\Claude Desktop Extra')
)

$ErrorActionPreference = 'Stop'
$AppName = 'Claude Desktop Extra'
$StartMenuDir = Join-Path ([Environment]::GetFolderPath('Programs')) $AppName
$DesktopDir = [Environment]::GetFolderPath('Desktop')
$Exe = Join-Path $InstallDir 'app\claude.exe'
$NameRe = '^[A-Za-z0-9_-]{1,64}$'

function Test-ProfileName([string]$Name) {
  if ($Name -notmatch $NameRe -or $Name -eq 'default') {
    throw "Invalid profile name '$Name': use letters, digits, '-' and '_' ('default' is reserved)."
  }
}

function New-Shortcut([string]$Path, [string]$Arguments, [string]$Description) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($Path)
  $lnk.TargetPath = $Exe
  $lnk.Arguments = $Arguments
  $lnk.WorkingDirectory = Split-Path $Exe
  $lnk.IconLocation = "$Exe,0"
  $lnk.Description = $Description
  $lnk.Save()
}

function Get-ShortcutNames([string]$ProfileName) {
  if ($ProfileName) { "Claude ($ProfileName).lnk" } else { 'Claude (Extra).lnk' }
}

function Add-Shortcuts([string]$ProfileName) {
  New-Item -ItemType Directory -Force -Path $StartMenuDir | Out-Null
  $name = Get-ShortcutNames $ProfileName
  $arguments = if ($ProfileName) { "--profile=$ProfileName" } else { '' }
  $desc = if ($ProfileName) { "Claude, profile $ProfileName" } else { 'Claude (claude-desktop-extra build)' }
  New-Shortcut (Join-Path $StartMenuDir $name) $arguments $desc
  if ($Desktop) { New-Shortcut (Join-Path $DesktopDir $name) $arguments $desc }
  Write-Host "  Shortcut: Start Menu > $AppName > $($name -replace '\.lnk$','')"
}

# The data folder the default profile shares with the official app: the newer
# official builds use %LOCALAPPDATA%\Claude-Data\claude_*, older ones
# %APPDATA%\Claude. Mirrors the app's own lookup (windows_profiles_main.js).
function Get-DefaultDataDir {
  $root = Join-Path $env:LOCALAPPDATA 'Claude-Data'
  $modern = Get-ChildItem $root -Directory -Filter 'claude_*' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($modern) { return $modern.FullName }
  return (Join-Path $env:APPDATA 'Claude')
}

function Stop-IfRunning {
  $running = Get-Process -Name claude -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path -ieq $Exe }
  if ($running) {
    throw "Claude Desktop Extra is running from $InstallDir. Quit it (tray icon > Quit) and run this again."
  }
}

# The default profile shares its data folder with the official app, so only
# one can run. Claude Code's CLI is also claude.exe, so match only where the
# desktop app lives: an AnthropicClaude folder (classic) or WindowsApps\Claude_*
# / Anthropic.Claude* (MSIX).
function Stop-IfOfficialRunning {
  $running = Get-Process -Name claude -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path -ine $Exe -and
      ($_.Path -match '\\AnthropicClaude\\' -or $_.Path -match '\\WindowsApps\\(Claude_|Anthropic\.Claude)') }
  if ($running) {
    throw 'The official Claude app is running. Quit it (tray icon > Quit) and run this again.'
  }
}

# What the old data folder has and the new one lacks: session entries
# (local_*.json only, skipping any the user deleted; the archived index files stay per folder) and a
# few small settings files. Never overwrites. The Chromium stores (Local
# Storage, IndexedDB, Network, Preferences) are not merged: mixing them corrupts
# them. claude_desktop_config.json and config.json are left alone: merge by hand.
function Get-OldDataToCopy([string]$Old, [string]$New) {
  $sessions = Join-Path $Old 'claude-code-sessions'
  foreach ($acct in Get-ChildItem $sessions -Directory -ErrorAction SilentlyContinue) {
    foreach ($org in Get-ChildItem $acct.FullName -Directory) {
      $dst = Join-Path $New "claude-code-sessions\$($acct.Name)\$($org.Name)"
      foreach ($f in Get-ChildItem $org.FullName -File -Filter 'local_*.json') {
        # A deleted_<id> marker in either folder means the user removed that session.
        $id = $f.BaseName -replace '^local_', ''
        if ((Test-Path (Join-Path $org.FullName "deleted_$id")) -or (Test-Path (Join-Path $dst "deleted_$id"))) { continue }
        if (-not (Test-Path (Join-Path $dst $f.Name))) { [pscustomobject]@{ Src = $f.FullName; Dir = $dst } }
      }
    }
  }
  foreach ($name in 'claude-desktop-extra.json', 'claude-desktop-extra.jsonc', 'cache-warm-off.json', 'claude-desktop-extra-update.json') {
    $src = Join-Path $Old $name
    if ((Test-Path $src) -and -not (Test-Path (Join-Path $New $name))) { [pscustomobject]@{ Src = $src; Dir = $New } }
  }
}

# Both an older (%APPDATA%\Claude) and a newer (%LOCALAPPDATA%\Claude-Data\claude_*)
# data folder exist: offer to merge the old one into the new one, with a backup of
# both first (regenerable caches left out) that the user may delete afterwards.
function Offer-DataMerge([string]$Old, [string]$New) {
  # Ask only when there is something to copy, the user has not answered before
  # (the marker records a merge or an explicit no) and someone can answer.
  $asked = Join-Path $New 'claude-desktop-extra-merge-asked.txt'
  $todo = @(Get-OldDataToCopy $Old $New)
  if ($todo.Count -eq 0 -or (Test-Path $asked)) { return }
  $interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
  if (-not $interactive) { Write-Host "An older Claude data folder exists ($Old); run Install.cmd from a console to merge it."; return }
  Write-Host ''
  Write-Host 'Two Claude data folders were found:'
  Write-Host "  in use: $New"
  Write-Host "  older:  $Old"
  Write-Host "The app uses only the first. $($todo.Count) older session and settings files are not in it."
  $answer = (Read-Host 'Merge the older folder into the one in use? A backup is made first. [y = merge, n = never, Enter = ask next time]').Trim()
  if ($answer -match '^(n|no)$') {
    Set-Content $asked 'Declined merging the older Claude data folder; delete this file to be asked again.'
    Write-Host 'Left both folders as they are. You will not be asked again.'
    return
  }
  if ($answer -notmatch '^(y|yes)$') { Write-Host 'Left both folders as they are. You will be asked again next time.'; return }

  # Same rule as the install: the default profile's folder must not be in use.
  try { Stop-IfRunning; Stop-IfOfficialRunning }
  catch { Write-Host "Skipped the merge: $($_.Exception.Message)"; return }

  $backup = Join-Path $env:USERPROFILE ('claude-data-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  if (Test-Path $backup) { Write-Host "Skipped the merge: $backup already exists. Run again."; return }
  $cache = 'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache', 'GPUPersistentCache', 'Crashpad'
  Write-Host "Backing up both folders to $backup ..."
  foreach ($pair in @(@($Old, 'old'), @($New, 'new'))) {
    robocopy $pair[0] (Join-Path $backup $pair[1]) /E /R:0 /W:0 /NJH /NJS /NFL /NDL /NP /XD $cache | Out-Null
    if ($LASTEXITCODE -ge 8) { Write-Host "Backup failed (robocopy exit $LASTEXITCODE); nothing was merged."; return }
  }
  $copied = 0
  try {
    foreach ($item in $todo) {
      New-Item -ItemType Directory -Force -Path $item.Dir | Out-Null
      Copy-Item $item.Src $item.Dir
      $copied++
    }
  } catch {
    Write-Host "The merge stopped after $copied of $($todo.Count) files: $($_.Exception.Message)"
    Write-Host "Your data before the merge is in the backup: $backup"
    return
  }
  Set-Content $asked 'Merged the older Claude data folder; delete this file to be offered again.'
  Write-Host "Merged $copied files."
  Write-Host 'Now start Claude (Extra) from the Start Menu and check that your sessions are there.'
  $del = Read-Host "Delete the backup ($backup)? [y/N]"
  if ($del -match '^(y|yes)$') { Remove-Item -Recurse -Force $backup; Write-Host 'Backup deleted.' }
  else { Write-Host "Backup kept: $backup" }
}

if ($Uninstall) {
  Stop-IfRunning
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  if (Test-Path $StartMenuDir) { Remove-Item -Recurse -Force $StartMenuDir }
  Get-ChildItem -Path $DesktopDir -Filter 'Claude (*).lnk' -ErrorAction SilentlyContinue | ForEach-Object {
    $t = (New-Object -ComObject WScript.Shell).CreateShortcut($_.FullName).TargetPath
    if ($t -ieq $Exe) { Remove-Item -Force $_.FullName }
  }
  Write-Host "$AppName removed. Your data (%APPDATA%\Claude*, %USERPROFILE%\.claude*) was left in place."
  return
}

if ($RemoveProfile) {
  Test-ProfileName $RemoveProfile
  $name = Get-ShortcutNames $RemoveProfile
  foreach ($dir in @($StartMenuDir, $DesktopDir)) {
    $p = Join-Path $dir $name
    if (Test-Path $p) { Remove-Item -Force $p }
  }
  Write-Host "Removed the shortcut for profile '$RemoveProfile'."
  Write-Host "Its data is kept: $env:APPDATA\Claude-$RemoveProfile and $env:USERPROFILE\.claude-$RemoveProfile"
  return
}

if ($ProfileName) { Test-ProfileName $ProfileName }

# Install or update the app when this script sits next to app.zip (the
# release download) or an app\ folder (an unpacked one).
$SourceZip = Join-Path $PSScriptRoot 'app.zip'
$SourceDir = Join-Path $PSScriptRoot 'app'
$HasZip = Test-Path $SourceZip
if ($HasZip -or (Test-Path (Join-Path $SourceDir 'claude.exe'))) {
  Stop-IfRunning
  Stop-IfOfficialRunning
  Write-Host "Installing $AppName to $InstallDir"
  # A zip downloaded from the internet marks every file; clear the mark so
  # Windows does not ask about each DLL.
  Get-ChildItem -Recurse -File $PSScriptRoot | Unblock-File
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $dest = Join-Path $InstallDir 'app'
  $staging = Join-Path $InstallDir 'app.new'
  if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
  if ($HasZip) {
    # Unpacked here rather than by Explorer: the app's deepest paths fit
    # Windows' 260-character limit under this folder, not under any folder.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($SourceZip)
    $longest = 0
    try {
      foreach ($e in $zip.Entries) { if ($e.FullName.Length -gt $longest) { $longest = $e.FullName.Length } }
    } finally { $zip.Dispose() }
    if ($staging.Length + 1 + $longest -ge 260) {
      throw "The install folder path is too long for Windows' 260-character limit: $InstallDir. Use a shorter -InstallDir."
    }
    Write-Host '  Unpacking...'
    [System.IO.Compression.ZipFile]::ExtractToDirectory($SourceZip, $staging)
  } else {
    Copy-Item -Recurse -Force $SourceDir $staging
  }
  if (-not (Test-Path (Join-Path $staging 'claude.exe'))) { throw "claude.exe missing after unpacking to $staging" }
  # Empty $dest and move the files in, rather than deleting and renaming the
  # folder: something (Explorer, a terminal) can hold the folder open.
  if (Test-Path $dest) { Get-ChildItem -Force $dest | Remove-Item -Recurse -Force } else { New-Item -ItemType Directory -Path $dest | Out-Null }
  Get-ChildItem -Force $staging | Move-Item -Destination $dest
  Remove-Item -Force $staging
  foreach ($f in @('VERSION.txt', 'README-Windows.txt', 'Install-ClaudeExtra.ps1', 'Install.cmd')) {
    $p = Join-Path $PSScriptRoot $f
    if (Test-Path $p) { Copy-Item -Force $p $InstallDir }
  }
  Add-Shortcuts ''
} elseif (-not (Test-Path $Exe)) {
  throw "No app.zip next to this script and nothing installed in $InstallDir. Run this from the unzipped download."
}

if ($ProfileName) { Add-Shortcuts $ProfileName }

$data = Get-DefaultDataDir
Write-Host ''
Write-Host "Default profile data (shared with the official Claude app): $data"
$classic = Join-Path $env:APPDATA 'Claude'
if ($data -ne $classic -and (Test-Path $classic)) {
  Offer-DataMerge $classic $data
}
Write-Host 'Done. Start Claude from the Start Menu.'
Write-Host 'Custom models: Settings > Extra > Models. More: README-Windows.txt'
