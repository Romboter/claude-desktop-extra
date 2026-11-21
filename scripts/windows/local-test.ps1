# Local build + test: build in WSL, boot the result in Windows Sandbox.
#   .\scripts\windows\local-test.ps1 [-SkipTests] [-SkipBuild]
# Needs WSL (Ubuntu) and the Windows Sandbox feature (Windows 11 Pro; enable
# once from an elevated prompt: Enable-WindowsOptionalFeature -Online
# -FeatureName Containers-DisposableClientVM, then reboot). x64 only.
param([switch]$SkipTests, [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$dist = Join-Path $repo 'dist-local'

if (-not $SkipBuild) {
  # A snapshot of the working tree as a plain repo: WSL git cannot read a
  # Windows git worktree's .git file, and the build needs git ls-files.
  $snap = Join-Path $env:TEMP 'cde-snapshot'
  Remove-Item $snap -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory $snap | Out-Null
  # git archive gives LF content (the Windows checkout may be CRLF, which breaks bash shebangs).
  # It exports HEAD: commit your changes first.
  $tar = Join-Path $env:TEMP 'cde-snapshot.tar'
  git -C $repo -c core.autocrlf=false archive --format=tar -o $tar HEAD
  if ($LASTEXITCODE) { throw 'git archive failed' }
  tar -xf $tar -C $snap
  git -C $snap init -q
  git -C $snap remote add origin (git -C $repo remote get-url origin)
  git -C $snap add -A
  git -C $snap -c user.name=snap -c user.email=snap@localhost commit -qm snapshot
  $wslSnap = (wsl wslpath -a $snap.Replace([string][char]92, '/')).Trim()
  $flag = if ($SkipTests) { '--skip-tests' } else { '' }
  wsl bash -lc "cd '$wslSnap' && scripts/windows/local-build.sh $flag"
  if ($LASTEXITCODE) { throw "build failed (exit $LASTEXITCODE)" }
  Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item "$snap\dist-local" $dist -Recurse
}
if (-not (Get-ChildItem "$dist\*.zip" -ErrorAction SilentlyContinue)) { throw "no zip in $dist" }
if (-not (Get-Command WindowsSandbox.exe -ErrorAction SilentlyContinue)) { throw 'Windows Sandbox is not enabled (see the header of this script)' }

$in = Join-Path $env:TEMP 'cde-sandbox-in'; $out = Join-Path $env:TEMP 'cde-sandbox-out'
Remove-Item $in, $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $in, $out | Out-Null
Copy-Item "$dist\*" $in; Copy-Item "$PSScriptRoot\smoke-test.ps1" $in
$wsb = Join-Path $env:TEMP 'cde-smoke.wsb'
@"
<Configuration>
  <MappedFolders>
    <MappedFolder><HostFolder>$in</HostFolder><SandboxFolder>C:\in</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$out</HostFolder><SandboxFolder>C:\out</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>powershell -ExecutionPolicy Bypass -File C:\in\smoke-test.ps1</Command></LogonCommand>
</Configuration>
"@ | Set-Content $wsb -Encoding UTF8
Start-Process $wsb
Write-Host 'Sandbox started; waiting for the result (up to 10 min)...'
$deadline = (Get-Date).AddMinutes(10)
while (-not (Test-Path "$out\result.txt") -and (Get-Date) -lt $deadline) { Start-Sleep 5 }
Get-Process WindowsSandbox* -ErrorAction SilentlyContinue | Stop-Process -Force
if (Test-Path "$out\claude-patches.log") { Write-Host '--- claude-patches.log'; Get-Content "$out\claude-patches.log" }
$r = if (Test-Path "$out\result.txt") { (Get-Content "$out\result.txt" -Raw).Trim() } else { 'FAIL: timed out' }
Write-Host $r
if ($r -ne 'PASS') { Write-Host "Details: $out\smoke.log"; exit 1 }
