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
  $wslRepo = (wsl wslpath -a ($repo -replace '\','/')).Trim()
  $flag = if ($SkipTests) { '--skip-tests' } else { '' }
  wsl bash -lc "cd '$wslRepo' && scripts/windows/local-build.sh $flag"
  if ($LASTEXITCODE) { throw "build failed (exit $LASTEXITCODE)" }
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
