# Runs INSIDE Windows Sandbox (local-test.ps1 starts it): the CI smoke-test
# step for x64. Keep the $want list in step with .github/workflows/build-windows.yml.
$ErrorActionPreference = 'Stop'
$out = 'C:\out'; $result = Join-Path $out 'result.txt'
Start-Transcript -Path (Join-Path $out 'smoke.log') | Out-Null
try {
  $sig = Get-AuthenticodeSignature 'C:\in\original-claude-x64.exe'
  Write-Host "Anthropic signature: $($sig.Status); $($sig.SignerCertificate.Subject)"
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch '^CN="?Anthropic, PBC"?,') { throw 'original claude.exe signature is not Anthropic, PBC / Valid' }

  $zip = Get-ChildItem 'C:\in\*.zip' | Select-Object -First 1
  Expand-Archive $zip.FullName -DestinationPath C:\unzipped
  $dir = Get-ChildItem C:\unzipped -Directory | Select-Object -First 1
  & (Join-Path $dir.FullName 'Install-ClaudeExtra.ps1') -ProfileName ci
  $exe = Join-Path $env:LOCALAPPDATA 'Programs\Claude Desktop Extra\app\claude.exe'
  if (-not (Test-Path $exe)) { throw "not installed: $exe" }

  $ud = Join-Path $env:APPDATA 'Claude-ci'
  New-Item -ItemType Directory -Force -Path $ud | Out-Null
  [IO.File]::WriteAllText((Join-Path $ud 'claude-desktop-extra.json'), '{"activeTheme":"nord"}', (New-Object Text.UTF8Encoding $false))
  $p = Start-Process -FilePath $exe -ArgumentList '--profile=ci' -PassThru
  $log = Join-Path $ud 'logs\claude-patches.log'
  $want = @("profile 'ci' (requested)", '[ExtraSettings] Extra settings area armed', '[custom-models] installed (main)',
    '[cdb-models] installed', '[CustomThemes] Active theme: nord', '[ThemePicker] Ctrl+Shift+T armed', '[cdb-devtools] installed',
    '[DiffViews] installed (main)', '[files-quick-open] installed (main)', '[panel-tabs] installed (main)',
    '[transcript-limits] installed (main)', '[cdb-jira] installed; switch', '[archive-grace] installed (main)', '[win-update] armed', '[cache-warm] installed')
  $deadline = (Get-Date).AddSeconds(120)
  do {
    Start-Sleep -Seconds 5
    $text = if (Test-Path $log) { Get-Content -Raw $log } else { '' }
    $missing = $want | Where-Object { -not $text.Contains($_) }
  } while ($missing -and -not $p.HasExited -and (Get-Date) -lt $deadline)
  if (Test-Path $log) { Copy-Item $log (Join-Path $out 'claude-patches.log') }
  if ($p.HasExited) { throw "claude.exe exited with code $($p.ExitCode)" }
  if ($missing) { throw "startup lines missing: $($missing -join '; ')" }
  'PASS' | Set-Content $result
} catch {
  "FAIL: $_" | Set-Content $result
} finally { Stop-Transcript | Out-Null }
