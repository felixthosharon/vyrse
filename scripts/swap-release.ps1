# Waits for VYRSE to close, then puts the newly built app (desktop\release-next) in place of the running one
# (desktop\release), so a rebuild never has to overwrite files of an app that's open. The old build is kept as
# desktop\release-prev until the next swap.
$ErrorActionPreference = 'Stop'
$desktop = Join-Path $PSScriptRoot '..\desktop' | Resolve-Path
$next = Join-Path $desktop 'release-next\win-unpacked'
$live = Join-Path $desktop 'release\win-unpacked'
$prev = Join-Path $desktop 'release-prev'
if (-not (Test-Path (Join-Path $next 'VYRSE.exe'))) { throw "No new build in $next" }
while (Get-Process VYRSE -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 2 }
Start-Sleep -Seconds 2  # let its child processes finish exiting
if (Test-Path $prev) { Remove-Item -Recurse -Force $prev }
New-Item -ItemType Directory -Force $prev | Out-Null
Move-Item $live (Join-Path $prev 'win-unpacked')
Move-Item $next $live
Remove-Item -Recurse -Force (Join-Path $desktop 'release-next') -ErrorAction SilentlyContinue
"swapped $(Get-Date -Format s)" | Out-File -Encoding utf8 (Join-Path $desktop 'release\swapped.txt')
