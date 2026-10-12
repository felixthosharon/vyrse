# Runs the headless lifecycle smoke modes of the VYRSE desktop shell and checks that no
# Hermes/llama processes outlive it. Usage: powershell -File scripts\smoke-desktop.ps1 [-Modes start,crash]
param([string[]]$Modes = @('start', 'crash', 'crash-launcher', 'probe'))
$ErrorActionPreference = 'Stop'
$desktop = Join-Path $PSScriptRoot '..\desktop'
Push-Location $desktop
try {
  npx tsc -p tsconfig.json
  if ($LASTEXITCODE -ne 0) { throw 'desktop build failed' }
  $failed = @()
  foreach ($mode in $Modes) {
    Write-Host "=== $mode" -ForegroundColor Cyan
    $env:VYRSE_SMOKE = $mode
    npx electron . 2>&1 | Where-Object { $_ -match '\[smoke\]' } | ForEach-Object { Write-Host $_ }
    $code = $LASTEXITCODE
    Remove-Item Env:VYRSE_SMOKE
    Start-Sleep -Seconds 2
    $left = Get-CimInstance Win32_Process | Where-Object {
      $_.Name -match '^llama-server' -or ($_.Name -match '^python' -and $_.CommandLine -match 'hermes_cli\.main serve')
    }
    if ($code -ne 0) { $failed += "$mode (exit $code)" }
    if ($left) { $failed += "$mode (leftover: $(($left | ForEach-Object { "$($_.Name)#$($_.ProcessId)" }) -join ', '))" }
  }
  if ($failed) { Write-Host "FAILED: $($failed -join '; ')" -ForegroundColor Red; exit 1 }
  Write-Host 'All smoke modes passed; no leftover processes.' -ForegroundColor Green
} finally { Pop-Location }
